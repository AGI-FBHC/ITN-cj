/**
 * Minimal release download server for verified local artifacts.
 * Usage: node tools/serve-release.cjs <directory> <port>
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
const port = Number(process.argv[3] || 6025);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Provide a valid TCP port');
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  throw new Error('Release directory does not exist: ' + root);
}

const esc = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[character]));

function releaseFiles() {
  return fs.readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
    .map(entry => {
      const file = path.join(root, entry.name);
      const stat = fs.statSync(file);
      return {name: entry.name, file, size: stat.size, modified: stat.mtime};
    })
    .sort((left, right) => right.modified - left.modified);
}

function indexPage() {
  const rows = releaseFiles().map(item => {
    const href = '/' + encodeURIComponent(item.name);
    return '<li><a href="' + esc(href) + '">' + esc(item.name) + '</a>' +
      '<span>' + esc((item.size / 1024 / 1024).toFixed(1)) + ' MB</span></li>';
  }).join('');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Lumin 发布包</title>' +
    '<style>body{font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif;max-width:760px;' +
    'margin:48px auto;padding:0 24px;color:#1f2d27}h1{font-size:28px}ul{list-style:none;' +
    'padding:0}li{display:flex;justify-content:space-between;gap:24px;padding:16px 0;' +
    'border-bottom:1px solid #dfe8e3}a{color:#176b4d;font-weight:600}span{color:#66736d;' +
    'white-space:nowrap}</style><h1>Lumin 发布包</h1><ul>' + rows + '</ul></html>';
}

function safeFile(urlPath) {
  let name;
  try {
    name = decodeURIComponent(urlPath.slice(1));
  } catch {
    return null;
  }
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const file = path.resolve(root, name);
  if (path.dirname(file) !== root || !fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return stat.isFile() ? {file, stat} : null;
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

const server = http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    sendText(response, 405, 'Method Not Allowed');
    return;
  }

  const requestUrl = new URL(request.url, 'http://localhost');
  if (requestUrl.pathname === '/health') {
    sendText(response, 200, JSON.stringify({
      ok: true,
      directory: root,
      files: releaseFiles().map(item => ({name: item.name, size: item.size})),
    }), 'application/json; charset=utf-8');
    return;
  }
  if (requestUrl.pathname === '/') {
    const html = indexPage();
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(html);
    return;
  }

  const target = safeFile(requestUrl.pathname);
  if (!target || !target.file.toLowerCase().endsWith('.zip')) {
    sendText(response, 404, 'Not Found');
    return;
  }

  const headers = {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="' + target.file.split(path.sep).pop() + '"',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Last-Modified': target.stat.mtime.toUTCString(),
  };
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, {'Content-Range': 'bytes */' + target.stat.size});
      response.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : target.stat.size - 1;
    if (start > end || start >= target.stat.size) {
      response.writeHead(416, {'Content-Range': 'bytes */' + target.stat.size});
      response.end();
      return;
    }
    const boundedEnd = Math.min(end, target.stat.size - 1);
    headers['Content-Range'] = 'bytes ' + start + '-' + boundedEnd + '/' + target.stat.size;
    headers['Content-Length'] = boundedEnd - start + 1;
    response.writeHead(206, headers);
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(target.file, {start, end: boundedEnd}).pipe(response);
    return;
  }

  headers['Content-Length'] = target.stat.size;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(target.file).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  console.log('Serving ' + root + ' on http://0.0.0.0:' + port);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

