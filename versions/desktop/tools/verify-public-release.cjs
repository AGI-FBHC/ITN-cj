/**
 * Public download integrity check using parallel HTTP ranges.
 * Usage: node tools/verify-public-release.cjs <url> <output> <bytes> <sha256> [parts]
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [url, output, bytesText, expectedHash, partsText = '24'] = process.argv.slice(2);
const size = Number(bytesText);
const parts = Number(partsText);

if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('A public HTTP URL is required');
if (!output) throw new Error('An output path is required');
if (!Number.isSafeInteger(size) || size < 1) throw new Error('A valid byte count is required');
if (!/^[a-f0-9]{64}$/i.test(String(expectedHash || ''))) throw new Error('A SHA256 is required');
if (!Number.isInteger(parts) || parts < 1 || parts > 64) throw new Error('Parts must be between 1 and 64');

const destination = path.resolve(output);
if (fs.existsSync(destination)) throw new Error('Output already exists: ' + destination);
fs.mkdirSync(path.dirname(destination), {recursive: true});

(async () => {
  const chunk = Math.ceil(size / parts);
  const ranges = [];
  for (let i = 0; i < parts; i += 1) {
    const start = i * chunk;
    const end = Math.min(size - 1, (i + 1) * chunk - 1);
    if (start <= end) ranges.push({i, start, end});
  }

  const started = Date.now();
  const buffers = await Promise.all(ranges.map(async range => {
    const response = await fetch(url, {headers: {Range: `bytes=${range.start}-${range.end}`}});
    if (response.status !== 206) throw new Error(`Range ${range.i}: HTTP ${response.status}`);
    const expected = range.end - range.start + 1;
    if (Number(response.headers.get('content-length')) !== expected) {
      throw new Error(`Range ${range.i}: unexpected Content-Length`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length !== expected) throw new Error(`Range ${range.i}: ${body.length}/${expected} bytes`);
    return body;
  }));

  const merged = Buffer.concat(buffers);
  if (merged.length !== size) throw new Error(`Merged length ${merged.length}/${size}`);
  const actualHash = crypto.createHash('sha256').update(merged).digest('hex');
  if (actualHash.toLowerCase() !== String(expectedHash).toLowerCase()) {
    throw new Error(`SHA256 mismatch: ${actualHash}`);
  }
  fs.writeFileSync(destination, merged);
  console.log(`PUBLIC_DOWNLOAD_OK bytes=${size} parts=${parts} seconds=${((Date.now() - started) / 1000).toFixed(1)} sha256=${actualHash.toUpperCase()}`);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
