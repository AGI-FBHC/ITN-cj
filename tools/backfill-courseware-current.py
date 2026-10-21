"""Keep one current resource per chapter/type; archive older rows without deletion."""
from pathlib import Path
import pymysql

root = Path(__file__).resolve().parent.parent
values = {}
for line in (root / '.env.local').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip()
if values['ZHIXUN_DB_NAME'] != 'itn_learning_v2_dev':
    raise RuntimeError('Refusing changes outside the isolated development database')
db = pymysql.connect(host=values['ZHIXUN_DB_HOST'], port=int(values['ZHIXUN_DB_PORT']),
    user=values['ZHIXUN_DB_USER'], password=values['ZHIXUN_DB_PASSWORD'],
    database=values['ZHIXUN_DB_NAME'], charset='utf8mb4')
try:
    with db.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM kb_courseware WHERE status IN ('queued','generating')")
        if cursor.fetchone()[0]:
            raise RuntimeError('Wait for active generation tasks before archiving older resources')
        cursor.execute("SELECT id,doc_id,kind FROM kb_courseware WHERE is_current=1 "
            "ORDER BY published DESC,CASE status WHEN 'ready' THEN 0 ELSE 1 END,updated_at DESC,created_at DESC,id DESC FOR UPDATE")
        seen, archived = set(), 0
        for resource_id, doc_id, kind in cursor.fetchall():
            pair = (doc_id, kind)
            if pair in seen:
                cursor.execute('UPDATE kb_courseware SET is_current=NULL WHERE id=%s', (resource_id,))
                archived += 1
            else:
                seen.add(pair)
        db.commit()
        print('Current resources:', len(seen), 'Archived older rows:', archived)
except Exception:
    db.rollback()
    raise
finally:
    db.close()
