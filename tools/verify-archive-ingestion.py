"""Real-model, full-archive acceptance check. Never changes saved model settings.

The archive is uploaded unchanged using a streaming HTTP request. Results are
kept for inspection; --bundle-id resumes monitoring after an intentional restart.
"""
import argparse
import hashlib
import http.client
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import pymysql

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('--bundle-id')
    parser.add_argument('--timeout-seconds', type=int, default=3600)
    args = parser.parse_args()
    base = os.environ.get('ZHIXUN_TEST_API', 'http://127.0.0.1:8312/api').rstrip('/')
    password = os.environ.get('ZHIXUN_ADMIN_PASSWORD')
    if not password:
        raise RuntimeError('Set ZHIXUN_ADMIN_PASSWORD in this process')

    def call(route, token=None, body=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(base + route, None if body is None else json.dumps(body).encode(), headers)
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.load(response)

    token = call('/admin/login', body={'account': 'admin', 'password': password})['token']
    bid = args.bundle_id
    if not bid:
        endpoint = urllib.parse.urlsplit(base)
        connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=180)
        connection.putrequest('POST', endpoint.path + '/admin/kb/bundles')
        connection.putheader('Authorization', 'Bearer ' + token)
        connection.putheader('Content-Type', 'application/zip')
        connection.putheader('Content-Length', str(args.archive.stat().st_size))
        connection.putheader('X-Bundle-Name', urllib.parse.quote(args.archive.name))
        connection.endheaders()
        with args.archive.open('rb') as archive:
            while block := archive.read(256 * 1024):
                connection.send(block)
        response = connection.getresponse()
        result = json.loads(response.read())
        if response.status >= 400:
            raise RuntimeError('Upload failed: ' + str(response.status) + ' ' + str(result.get('message', '')))
        bid = result['id']
        connection.close()
        print('Uploaded unchanged archive:', args.archive.name, args.archive.stat().st_size, 'bytes; bundle:', bid, flush=True)
    (ROOT / 'data/full-archive-run.json').write_text(json.dumps({'id': bid, 'archive': str(args.archive.resolve())}), encoding='utf-8')
    progress_file = ROOT / 'data' / ('ingest-progress-' + bid + '.jsonl')
    last = None
    deadline = time.monotonic() + args.timeout_seconds
    while time.monotonic() < deadline:
        try:
            bundle = call('/admin/kb/bundles/' + bid + '/status', token)['bundle']
        except (OSError, urllib.error.URLError):
            time.sleep(3)  # Allows an intentional backend restart during this check.
            continue
        snapshot = {'status': bundle['status'], 'pipeline': bundle.get('pipeline'), 'logoStatus': bundle.get('logo', {}).get('status')}
        if snapshot != last:
            line = json.dumps(snapshot, ensure_ascii=False)
            print(line, flush=True)
            with progress_file.open('a', encoding='utf-8') as log:
                log.write(json.dumps({'time': time.time(), **snapshot}, ensure_ascii=False) + '\n')
            last = snapshot
        if bundle['status'] == 'failed':
            raise RuntimeError('Organizing failed: ' + bundle.get('errorMessage', ''))
        pipeline = bundle.get('pipeline', {})
        if pipeline.get('status') in ('failed', 'partial'):
            raise RuntimeError('Derived artifacts need retry: ' + pipeline.get('errorMessage', ''))
        if bundle['status'] == 'ready' and pipeline.get('status') == 'ready':
            if bundle.get('logo', {}).get('status') == 'failed':
                raise RuntimeError('Logo needs retry: ' + bundle['logo'].get('errorMessage', ''))
            if bundle.get('logo', {}).get('status') == 'ready':
                break
        time.sleep(4)
    else:
        raise RuntimeError('Timed out; bundle and completed results are retained: ' + bid)

    values = {}
    for line in (ROOT / '.env.local').read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    assert values['ZHIXUN_DB_NAME'] == 'itn_learning_v2_dev'
    connection = pymysql.connect(host=values['ZHIXUN_DB_HOST'], port=int(values['ZHIXUN_DB_PORT']),
                                 user=values['ZHIXUN_DB_USER'], password=values['ZHIXUN_DB_PASSWORD'],
                                 database=values['ZHIXUN_DB_NAME'], charset='utf8mb4')
    with zipfile.ZipFile(args.archive) as archive, connection.cursor() as cursor:
        sources = {}
        for member in archive.infolist():
            if member.is_dir() or Path(member.filename).suffix.lower() not in ('.md', '.markdown', '.mdx', '.txt', '.rst'):
                continue
            raw = archive.read(member)
            sources[member.filename] = raw.decode('utf-16' if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8')
        cursor.execute('SELECT id,source_path,original_content,document_id FROM kb_bundle_docs WHERE bundle_id=%s', (bid,))
        originals = cursor.fetchall()
        seen = set()
        for _, path, content, doc_id in originals:
            assert path in sources and sources[path] == content, 'Original source differs: ' + path
            assert doc_id and path not in seen, 'Duplicate or unmapped source'
            seen.add(path)
        missing = set(sources) - seen
        assert all(not sources[path].strip() for path in missing), 'A non-empty source document is missing'
        cursor.execute('SELECT id,content,active_build_id FROM kb_documents WHERE bundle_id=%s', (bid,))
        documents = {row[0]: (row[1].encode('utf-8'), row[2]) for row in cursor.fetchall()}
        cursor.execute("SELECT c.document_id,c.source_start,c.source_end,c.text,c.summary,c.keywords_json,e.dim,e.space_key "
                       "FROM kb_chunks c JOIN kb_documents d ON d.id=c.document_id AND c.build_id=d.active_build_id "
                       "LEFT JOIN kb_embeddings e ON e.chunk_id=c.id WHERE d.bundle_id=%s ORDER BY c.document_id,c.chunk_index", (bid,))
        covered = {}
        dimensions, spaces = set(), set()
        chunk_count = 0
        for doc_id, start, end, text, summary, keywords, dim, space in cursor.fetchall():
            source = documents[doc_id][0]
            assert 0 <= start <= covered.get(doc_id, 0) < end <= len(source), 'Chunk coverage gap or duplicate range'
            assert source[start:end].decode('utf-8') == text, 'Chunk differs from its source range'
            assert summary and json.loads(keywords), 'Summary or keywords missing'
            assert dim and space, 'Vector missing'
            covered[doc_id] = end
            dimensions.add(dim)
            spaces.add(space)
            chunk_count += 1
        assert all(covered.get(doc_id, 0) == len(content) for doc_id, (content, _) in documents.items()), 'Source end not covered'
        assert len(dimensions) == len(spaces) == 1, 'Mixed vector spaces in one archive build'
        cursor.execute('SELECT id,source_path FROM kb_bundle_assets WHERE bundle_id=%s', (bid,))
        assets = cursor.fetchall()
        asset_root = Path(values.get('ZHIXUN_ASSET_ROOT', ROOT / 'data/kb_assets'))
        if not asset_root.is_absolute():
            asset_root = ROOT / asset_root
        for asset_id, source_path in assets:
            assert hashlib.sha256((asset_root / bid / asset_id).read_bytes()).digest() == hashlib.sha256(archive.read(source_path)).digest(), 'Image bytes changed'
        variants = bundle['logo']['variants']
        assert len(variants) == 3 and len({item['svg'] for item in variants}) == 3
    connection.close()
    report = {'bundleId': bid, 'url': 'http://localhost:3006/admin/knowledge/bundles/' + bid,
              'archiveBytes': args.archive.stat().st_size, 'sourceDocuments': len(originals), 'emptySources': len(missing),
              'chunks': chunk_count, 'summaries': chunk_count, 'vectors': chunk_count, 'vectorDimensions': list(dimensions),
              'localImages': len(assets), 'logoStyles': [item['style'] for item in variants], 'sourceCoverageVerified': True}
    (ROOT / 'data/full-archive-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('VERIFIED', json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
