const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
let count = 0;
const check = (value, message) => { assert.ok(value, message); console.log('PASS ' + message); count++; };
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-release-http-'));
  const payload = Buffer.from(Array.from({length: 4096}, (_, i) => i % 256));
  fs.writeFileSync(path.join(root, 'Lumin-Setup-0.8.28.exe'), payload);
  fs.writeFileSync(path.join(root, 'Lumin-0.8.28.zip'), payload);
  fs.writeFileSync(path.join(root, 'Lumin-Setup-0.8.27-x64.exe'), payload);
  fs.writeFileSync(path.join(root, 'secret.exe'), 'not a release');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const process = spawn(global.process.execPath, [path.join(__dirname, 'serve-release.cjs'), root, String(port)], {stdio: ['ignore', 'pipe', 'pipe']});
  let errors = ''; process.stderr.on('data', b => { errors += b; });
  const base = 'http://127.0.0.1:' + port;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    let r = await fetch(base + '/Lumin-Setup-0.8.28.exe', {method: 'HEAD'});
    check(r.status === 200 && Number(r.headers.get('content-length')) === payload.length, 'installer HEAD reports actual bytes');
    check(r.headers.get('content-type') === 'application/octet-stream', 'installer has binary content type');
    check(r.headers.get('content-disposition').includes('Lumin-Setup-0.8.28.exe'), 'installer download filename');
    r = await fetch(base + '/Lumin-Setup-0.8.28.exe');
    check(Buffer.from(await r.arrayBuffer()).equals(payload), 'full installer bytes match source');
    for (const [range, start, end] of [['bytes=100-199', 100, 199], ['bytes=4000-', 4000, 4095], ['bytes=-16', 4080, 4095]]) {
      r = await fetch(base + '/Lumin-Setup-0.8.28.exe', {headers: {Range: range}});
      check(r.status === 206 && r.headers.get('content-range') === `bytes ${start}-${end}/4096`, 'range metadata ' + range);
      check(Buffer.from(await r.arrayBuffer()).equals(payload.subarray(start, end + 1)), 'range bytes ' + range);
    }
    for (const range of ['bytes=5000-', 'bytes=-', 'bytes=-0', 'bytes=8-3']) {
      check((await fetch(base + '/Lumin-Setup-0.8.28.exe', {headers: {Range: range}})).status === 416, 'invalid range rejected ' + range);
    }
    check((await fetch(base + '/secret.exe')).status === 404, 'unrelated executable is not published');
    check((await fetch(base + '/Lumin-0.8.28.zip', {method: 'HEAD'})).status === 200, 'existing portable URL works');
    let html = await (await fetch(base)).text();
    check(html.includes('href="/Lumin-Setup-0.8.28.exe"'), 'same-version installer is primary');
    check(html.includes('class="portable-download"') && html.includes('href="/Lumin-0.8.28.zip"'), 'matching portable alternative shown');
    check((await fetch(base + '/Lumin-Setup-0.8.27-x64.exe', {method: 'HEAD'})).status === 200, 'legacy x64 installer URL remains valid');
    check(!html.includes('{{'), 'no unresolved template tokens');
    fs.writeFileSync(path.join(root, 'Lumin-0.8.29.zip'), payload);
    html = await (await fetch(base)).text();
    check(html.includes('v0.8.29') && html.includes('href="/Lumin-0.8.29.zip"'), 'newer zip-only version remains latest');
    check(!html.includes('class="portable-download"'), 'no fabricated alternate when only zip exists');
    check(!errors, 'server stderr is empty');
    console.log(`RESULT ${count}/${count} PASS`);
  } finally { process.kill(); }
})().catch(error => { console.error(error); global.process.exitCode = 1; });
