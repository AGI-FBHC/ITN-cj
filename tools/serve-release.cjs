/**
 * Release download server with a small static product site.
 * Usage: node tools/serve-release.cjs <release-directory> <port>
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const releaseRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
const port = Number(process.argv[3] || 6025);
const siteRoot = path.join(__dirname, 'release-site');
const assetRoot = path.join(siteRoot, 'assets');
const templatePath = path.join(siteRoot, 'index.html');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Provide a valid TCP port');
}
if (!fs.existsSync(releaseRoot) || !fs.statSync(releaseRoot).isDirectory()) {
  throw new Error('Release directory does not exist: ' + releaseRoot);
}
if (!fs.existsSync(templatePath)) {
  throw new Error('Download page template does not exist: ' + templatePath);
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'Asia/Shanghai',
});

const assetTypes = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

function esc(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function releaseFiles() {
  return fs.readdirSync(releaseRoot, {withFileTypes: true})
    .filter(entry => entry.isFile() && releaseIdentity(entry.name))
    .map(entry => {
      const file = path.join(releaseRoot, entry.name);
      const stat = fs.statSync(file);
      return {name: entry.name, file, size: stat.size, modified: stat.mtime, ...releaseIdentity(entry.name)};
    })
    .sort((left, right) => {
      if (left.version && right.version) {
        return right.version.localeCompare(left.version, undefined, {numeric: true}) ||
          Number(right.kind === 'installer') - Number(left.kind === 'installer');
      }
      if (left.version) return -1;
      if (right.version) return 1;
      return right.modified - left.modified;
    });
}

function releaseIdentity(name) {
  // Current Windows builds omit the architecture suffix in the product name.
  // Keep accepting -x64 so already published direct links remain valid.
  const installer = name.match(/^Lumin-Setup-(\d+\.\d+\.\d+)(?:-x64)?\.exe$/i);
  if (installer) return {version: installer[1], kind: 'installer'};
  const portable = name.match(/^Lumin-(\d+\.\d+\.\d+)\.zip$/i);
  return portable ? {version: portable[1], kind: 'portable'} : null;
}

function fileSize(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
}

function downloadHref(fileName) {
  return '/' + encodeURIComponent(fileName);
}

function archiveSection(archived) {
  if (!archived.length) return '';
  const rows = archived.map(item =>
    '<li><a href="' + esc(downloadHref(item.name)) + '">' + esc(item.name) + '</a>' +
    '<span>' + esc(fileSize(item.size)) + ' · ' + esc(dateFormat.format(item.modified)) + '</span></li>'
  ).join('');
  return '<details class="archive"><summary>历史版本</summary><ul>' + rows + '</ul></details>';
}

function renderIndex() {
  const releases = releaseFiles();
  const latest = releases.find(item => item.version) || releases[0];
  const archived = releases.filter(item => item.version !== latest?.version);
  const portable = releases.find(item => item.version === latest?.version && item.kind === 'portable');
  const installer = latest?.kind === 'installer';
  const version = latest?.version || '—';
  const file = latest?.name || '暂无可下载版本';
  const size = latest ? fileSize(latest.size) : '—';
  const releaseDate = latest ? dateFormat.format(latest.modified) : '—';
  const url = latest ? downloadHref(latest.name) : '#';
  const replacements = {
    VERSION: esc(version),
    DOWNLOAD_URL: esc(url),
    FILE_NAME: esc(file),
    FILE_SIZE: esc(size),
    DOWNLOAD_LABEL: installer ? '下载 Windows 安装版' : '下载 Windows 便携版',
    FILE_FORMAT: installer ? 'EXE 安装程序' : 'ZIP 便携包',
    INSTALL_INSTRUCTIONS: installer ? '运行安装程序，按提示完成安装。首次启动请在“模型与接口”中配置自己的模型服务。' : '解压后运行 Lumin.exe。首次启动请在“模型与接口”中配置自己的模型服务。',
    PORTABLE_LINK: installer && portable ? '<a class="portable-download" href="' + esc(downloadHref(portable.name)) + '" download>ZIP 便携版 · ' + esc(fileSize(portable.size)) + '</a>' : '',
    PORTABLE_HELP: installer && portable ? '<p class="portable-help">安装或启动失败时，可尝试 <a href="' + esc(downloadHref(portable.name)) + '">ZIP 便携版</a>。解压到独立文件夹后运行 Lumin.exe。</p>' : '',
    RELEASE_DATE: esc(releaseDate),
    ARCHIVE_SECTION: archiveSection(archived),
  };
  return Object.entries(replacements).reduce(
    (html, [token, value]) => html.split('{{' + token + '}}').join(value),
    fs.readFileSync(templatePath, 'utf8')
  );
}

function safeNamedFile(root, name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const file = path.resolve(root, name);
  if (path.dirname(file) !== root || !fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return stat.isFile() ? {file, stat} : null;
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

function sendAsset(request, response, target) {
  const extension = path.extname(target.file).toLowerCase();
  const contentType = assetTypes.get(extension) || 'application/octet-stream';
  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': contentType,
    'Content-Length': target.stat.size,
    'Cache-Control': 'public, max-age=604800, immutable',
    'Last-Modified': target.stat.mtime.toUTCString(),
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(target.file).pipe(response);
}

const server = http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    sendText(response, 405, 'Method Not Allowed');
    return;
  }

  const requestUrl = new URL(request.url, 'http://localhost');
  const pathname = requestUrl.pathname;

  if (pathname === '/health') {
    sendText(response, 200, JSON.stringify({
      ok: true,
      directory: releaseRoot,
      files: releaseFiles().map(item => ({name: item.name, size: item.size})),
    }), 'application/json; charset=utf-8');
    return;
  }

  if (pathname === '/') {
    const html = renderIndex();
    response.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(html);
    return;
  }

  if (pathname.startsWith('/assets/')) {
    let name;
    try {
      name = decodeURIComponent(pathname.slice('/assets/'.length));
    } catch {
      sendText(response, 400, 'Bad Request');
      return;
    }
    const asset = safeNamedFile(assetRoot, name);
    if (!asset || !assetTypes.has(path.extname(asset.file).toLowerCase())) {
      sendText(response, 404, 'Not Found');
      return;
    }
    sendAsset(request, response, asset);
    return;
  }

  let name;
  try {
    name = decodeURIComponent(pathname.slice(1));
  } catch {
    sendText(response, 400, 'Bad Request');
    return;
  }
  const target = safeNamedFile(releaseRoot, name);
  const identity = releaseIdentity(name);
  if (!target || !identity) {
    sendText(response, 404, 'Not Found');
    return;
  }

  const headers = {
    ...securityHeaders(),
    'Content-Type': identity.kind === 'installer' ? 'application/octet-stream' : 'application/zip',
    'Content-Disposition': 'attachment; filename="' + target.file.split(path.sep).pop() + '"',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Last-Modified': target.stat.mtime.toUTCString(),
  };
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.writeHead(416, {...securityHeaders(), 'Content-Range': 'bytes */' + target.stat.size});
      response.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, target.stat.size - Number(match[2]));
    const end = match[2] ? Number(match[2]) : target.stat.size - 1;
    const rangeEnd = match[1] ? end : target.stat.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(rangeEnd) ||
        (!match[1] && Number(match[2]) <= 0) || start > rangeEnd || start >= target.stat.size) {
      response.writeHead(416, {...securityHeaders(), 'Content-Range': 'bytes */' + target.stat.size});
      response.end();
      return;
    }
    const boundedEnd = Math.min(rangeEnd, target.stat.size - 1);
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
  console.log('Serving ' + releaseRoot + ' and ' + siteRoot + ' on http://0.0.0.0:' + port);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
