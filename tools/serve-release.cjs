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
      const version = entry.name.match(/^Lumin-(\d+(?:\.\d+){2})\.zip$/i)?.[1] || '';
      return {name: entry.name, file, size: stat.size, modified: stat.mtime, version};
    })
    .sort((left, right) => {
      if (left.version && right.version) {
        return right.version.localeCompare(left.version, undefined, {numeric: true});
      }
      if (left.version) return -1;
      if (right.version) return 1;
      return right.modified - left.modified;
    });
}

function indexPage() {
  const releases = releaseFiles();
  const latest = releases.find(item => item.version) || releases[0];
  const archived = releases.filter(item => item !== latest);
  const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const size = item => (item.size / 1024 / 1024).toFixed(1) + ' MB';
  const downloadHref = item => '/' + encodeURIComponent(item.name);
  const archiveRows = archived.map(item =>
    '<li><a href="' + esc(downloadHref(item)) + '">' +
    '<span class="archive-name">' + esc(item.name) + '</span>' +
    '<span>' + esc(size(item)) + '</span>' +
    '<span>' + esc(dateFormat.format(item.modified)) + '</span></a></li>'
  ).join('');
  const latestPanel = latest ? [
    '<section class="download-card" aria-labelledby="download-title">',
    '<div class="version-line"><span class="version">v' + esc(latest.version || 'latest') + '</span>',
    '<span class="channel">稳定版</span></div>',
    '<h2 id="download-title">Lumin 桌面版</h2>',
    '<p class="platform">Windows 10 / 11 · 64 位</p>',
    '<a class="download-button" href="' + esc(downloadHref(latest)) + '" download>',
    '<span>下载 Windows 版</span><span aria-hidden="true">↓</span></a>',
    '<dl class="release-meta">',
    '<div><dt>文件</dt><dd>' + esc(latest.name) + '</dd></div>',
    '<div><dt>大小</dt><dd>' + esc(size(latest)) + '</dd></div>',
    '<div><dt>发布日期</dt><dd>' + esc(dateFormat.format(latest.modified)) + '</dd></div>',
    '</dl>',
    '<p class="package-note">包含应用与仓颉业务内核，目标设备无需安装仓颉 SDK。</p>',
    '</section>',
  ].join('') : '<section class="download-card"><h2>暂无可下载版本</h2></section>';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light">' +
    '<title>Lumin 桌面版下载</title>' +
    '<style>' +
    ':root{--ink:#17211d;--muted:#66736d;--line:#dfe7e2;--paper:#fff;' +
    '--wash:#f3f7f4;--brand:#1a684b;--brand-deep:#0f4734;--sun:#e6b94c}' +
    '*{box-sizing:border-box}html{background:var(--wash)}body{margin:0;color:var(--ink);' +
    'font:15px/1.65 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;' +
    'background:radial-gradient(circle at 8% 0%,rgba(230,185,76,.15),transparent 26rem),' +
    'radial-gradient(circle at 94% 16%,rgba(26,104,75,.12),transparent 30rem),var(--wash)}' +
    'a{color:inherit}.shell{width:min(1080px,calc(100% - 48px));margin:0 auto;padding:34px 0 28px}' +
    '.site-head{display:flex;align-items:center;justify-content:space-between;gap:24px;' +
    'padding-bottom:30px;border-bottom:1px solid rgba(23,33,29,.12)}' +
    '.brand{display:flex;align-items:center;gap:12px;font-weight:700;letter-spacing:.08em}' +
    '.brand-mark{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;' +
    'background:var(--brand);color:#fff;font:italic 700 22px/1 Georgia,serif;letter-spacing:0}' +
    '.head-label{color:var(--muted);font-size:13px}.hero{display:grid;' +
    'grid-template-columns:minmax(0,1.15fr) minmax(340px,.85fr);gap:70px;align-items:center;' +
    'padding:72px 0 64px}.eyebrow{margin:0 0 18px;color:var(--brand);font-size:13px;' +
    'font-weight:700;letter-spacing:.14em}.hero h1{margin:0;font-size:clamp(52px,8vw,92px);' +
    'line-height:.92;letter-spacing:-.075em;font-weight:750}.intro{max-width:560px;' +
    'margin:28px 0 0;color:#43514b;font-size:18px;line-height:1.8}' +
    '.download-card{background:var(--paper);border:1px solid var(--line);border-radius:24px;' +
    'padding:30px;box-shadow:0 24px 70px rgba(34,55,45,.12)}.version-line{display:flex;' +
    'align-items:center;gap:9px;margin-bottom:26px}.version{padding:4px 9px;border-radius:6px;' +
    'background:var(--brand);color:#fff;font-size:13px;font-weight:700}.channel{padding:4px 9px;' +
    'border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:13px}' +
    '.download-card h2{margin:0;font-size:30px;letter-spacing:-.035em}.platform{margin:6px 0 25px;' +
    'color:var(--muted)}.download-button{min-height:56px;display:flex;align-items:center;' +
    'justify-content:space-between;padding:0 20px;border-radius:12px;background:var(--brand);' +
    'color:#fff;text-decoration:none;font-size:16px;font-weight:700;' +
    'transition:background .18s ease,transform .18s ease}.download-button:hover{' +
    'background:var(--brand-deep);transform:translateY(-1px)}' +
    '.download-button:focus-visible{outline:3px solid rgba(26,104,75,.24);outline-offset:3px}' +
    '.release-meta{display:grid;gap:12px;margin:25px 0 0;padding:22px 0 0;' +
    'border-top:1px solid var(--line)}.release-meta div{display:flex;justify-content:space-between;' +
    'gap:20px}.release-meta dt{color:var(--muted)}.release-meta dd{margin:0;text-align:right;' +
    'font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.package-note{margin:19px 0 0;' +
    'color:var(--muted);font-size:13px;line-height:1.7}.details-grid{display:grid;' +
    'grid-template-columns:1fr 1.1fr;gap:56px;padding:42px 0;border-top:1px solid rgba(23,33,29,.12)}' +
    '.details-grid h3{margin:0 0 12px;font-size:17px}.details-grid p{margin:0;color:var(--muted)}' +
    '.steps{margin:0;padding:0;list-style:none;display:grid;gap:10px;counter-reset:step}' +
    '.steps li{display:flex;gap:12px;align-items:baseline}.steps li::before{counter-increment:step;' +
    'content:counter(step);flex:none;width:22px;height:22px;border-radius:50%;display:grid;' +
    'place-items:center;background:#e4eee8;color:var(--brand-deep);font-size:12px;font-weight:700}' +
    '.archive{padding:8px 0 46px}.archive summary{cursor:pointer;color:var(--muted);' +
    'font-weight:600;list-style-position:inside}.archive ul{list-style:none;margin:16px 0 0;' +
    'padding:0;border-top:1px solid var(--line)}.archive li{border-bottom:1px solid var(--line)}' +
    '.archive a{display:grid;grid-template-columns:1fr auto auto;gap:20px;padding:13px 2px;' +
    'text-decoration:none;color:var(--muted);font-size:13px}.archive a:hover{color:var(--brand)}' +
    '.archive-name{color:var(--ink)}.site-foot{display:flex;justify-content:space-between;gap:24px;' +
    'padding-top:22px;border-top:1px solid rgba(23,33,29,.12);color:var(--muted);font-size:12px}' +
    '@media(max-width:800px){.shell{width:min(100% - 32px,640px);padding-top:22px}' +
    '.hero{grid-template-columns:1fr;gap:32px;padding:48px 0 42px}.hero h1{font-size:58px}' +
    '.intro{font-size:16px}.download-card{padding:24px}.details-grid{grid-template-columns:1fr;' +
    'gap:28px}.head-label{display:none}.archive a{grid-template-columns:1fr auto}' +
    '.archive a span:last-child{display:none}}@media(max-width:460px){.shell{width:calc(100% - 24px)}' +
    '.hero h1{font-size:47px}.download-card{border-radius:18px}.release-meta dd{max-width:62%}' +
    '.site-foot{display:grid;gap:4px}}' +
    '@media(prefers-reduced-motion:reduce){.download-button{transition:none}}</style></head><body>' +
    '<main class="shell"><header class="site-head"><div class="brand">' +
    '<span class="brand-mark" aria-hidden="true">L</span><span>LUMIN</span></div>' +
    '<span class="head-label">桌面学习工作台 · 官方下载</span></header>' +
    '<section class="hero"><div><p class="eyebrow">LEARN WITH YOUR OWN MATERIALS</p>' +
    '<h1>让资料成为<br>学习现场。</h1><p class="intro">个人知识库、知识网络、课件生成与随课导学，' +
    '在一个桌面工作台中完成。</p></div>' + latestPanel + '</section>' +
    '<section class="details-grid"><div><h3>运行要求</h3><p>Windows 10 / 11 64 位。解压后直接运行，' +
    '本地数据保存在当前用户目录。</p></div><div><h3>安装步骤</h3><ol class="steps">' +
    '<li>下载 ZIP 压缩包</li><li>解压到固定目录</li><li>运行 Lumin.exe</li></ol></div></section>' +
    (archiveRows ? '<details class="archive"><summary>历史版本</summary><ul>' +
      archiveRows + '</ul></details>' : '') +
    '<footer class="site-foot"><span>Lumin · 智训云枢</span><span>© 2026 ITN</span></footer>' +
    '</main></body></html>';
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

