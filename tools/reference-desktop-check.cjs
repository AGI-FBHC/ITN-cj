/* Real preload -> ipcMain -> Electron shell bridge checks, with OS launches intercepted. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {_electron} = require(require.resolve('playwright', {
  paths: [path.resolve(__dirname, '..'), 'D:/Desktop/ITN/ITN/src/frontend/agent-demo'],
}));

const root = path.resolve(__dirname, '..');
const shellDir = path.resolve(process.env.ITN_SHELL_DIR || path.join(root, 'shell'));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-reference-desktop-'));
const fixtures = path.join(runDir, 'fixtures');
fs.mkdirSync(fixtures);
const folder = path.join(fixtures, '\u4e2d\u6587 folder');
fs.mkdirSync(folder);
const file = path.join(folder, '\u8bfe\u7a0b notes.txt');
const percentFile = path.join(folder, 'literal%20name%23.txt');
const hashFile = path.join(folder, 'literal#L12.txt');
const anchorNameFile = path.join(folder, 'literal.txt#L12');
for (const p of [file, percentFile, hashFile, anchorNameFile]) fs.writeFileSync(p, 'Reference bridge fixture only.\n');
const report = {
  startedAt: new Date().toISOString(), runDir, shellDir,
  scope: 'Real Electron renderer/preload/IPC and real filesystem stat; shell.openPath/openExternal intercepted. No OS association quality claim.',
  results: [], logs: [], errors: [],
};
let app, page;
const record = async (name, fn) => {
  try {
    const detail = await fn();
    report.results.push({name, ok: true, detail});
    console.log('PASS ' + name);
  } catch (error) {
    report.results.push({name, ok: false, error: error.stack || String(error)});
    console.log('FAIL ' + name + ': ' + error.message);
  }
};
const invoke = (method, value) => page.evaluate(async ({method, value}) => {
  if (typeof window.itnWindow?.[method] !== 'function') throw new Error('Missing preload API: ' + method);
  return await window.itnWindow[method](value);
}, {method, value});
const calls = () => app.evaluate(() => global.__referenceCalls);
const expectPath = async (input, expectedPath, kind = 'file', position = {}) => {
  const result = await invoke('resolveReferencePath', input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.path, fs.realpathSync(expectedPath));
  assert.equal(result.kind, kind);
  for (const [key, value] of Object.entries(position)) assert.equal(result[key], value, JSON.stringify(result));
  return result;
};
const expectOpen = async (input, expectedPath, kind = 'file') => {
  const before = (await calls()).length;
  const result = await invoke('openPath', input);
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = await calls();
  assert.equal(after.length, before + 1);
  assert.deepEqual(after.at(-1), {method: 'openPath', value: fs.realpathSync(expectedPath)});
  if (result.kind) assert.equal(result.kind, kind);
  return result;
};

(async () => {
  try {
    const bootstrap = path.join(runDir, 'bootstrap.cjs');
    fs.writeFileSync(bootstrap, [
      "const {app,shell}=require('electron');",
      'app.setPath("userData",' + JSON.stringify(path.join(runDir, 'electron-profile')) + ');',
      'global.__referenceProtocolAttempts=0;',
      'app.setAsDefaultProtocolClient=()=>{global.__referenceProtocolAttempts++;return false;};',
      'global.__referenceCalls=[];global.__referenceFailure=null;',
      'shell.openPath=async value=>{global.__referenceCalls.push({method:"openPath",value});if(global.__referenceFailure?.method==="openPath"){if(global.__referenceFailure.throws)throw Error(global.__referenceFailure.message);return global.__referenceFailure.message;}return "";};',
      'shell.openExternal=async value=>{global.__referenceCalls.push({method:"openExternal",value});if(global.__referenceFailure?.method==="openExternal")throw Error(global.__referenceFailure.message);};',
      'require(' + JSON.stringify(path.join(shellDir, 'main.js')) + ');',
    ].join('\n'));
    const env = {...process.env, APPDATA: path.join(runDir, 'roaming'), LOCALAPPDATA: path.join(runDir, 'local'), TEMP: runDir, TMP: runDir, LUMIN_TRAY_TEST: '1'};
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: process.env.ITN_ELECTRON_EXE || path.join(root, 'shell/node_modules/electron/dist/electron.exe'),
      args: [bootstrap, '--ui-check'], env, timeout: 45000,
    });
    app.process().stdout?.on('data', d => report.logs.push({stream: 'stdout', text: String(d)}));
    app.process().stderr?.on('data', d => report.logs.push({stream: 'stderr', text: String(d)}));
    page = await app.firstWindow();
    page.on('pageerror', e => report.errors.push(e.stack || e.message));
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, {timeout: 45000});
    await page.waitForSelector('#view', {timeout: 20000});
    await page.waitForFunction(() => !document.getElementById('boot'), null, {timeout: 20000});
    await record('isolated Electron profile and kernel data', async () => {
      const data = await app.evaluate(({app}) => ({userData: app.getPath('userData'), local: process.env.LOCALAPPDATA, protocolAttempts: global.__referenceProtocolAttempts}));
      assert.equal(data.userData, path.join(runDir, 'electron-profile'));
      assert.equal(data.local, path.join(runDir, 'local'));
      assert(fs.existsSync(path.join(runDir, 'local/Lumin/itn.db')));
      return data;
    });
    await record('existing string file bridge', () => expectOpen(file, file));
    await record('existing string directory bridge', () => expectOpen(folder, folder, 'directory'));
    await record('file URI decodes Chinese and spaces through IPC', () => expectOpen(pathToFileURL(file).href, file));
    await record('relative file with explicit base directory', () => expectOpen({path: path.basename(file), baseDir: folder}, file));
    await record('source line and column suffix opens original file', () => expectOpen(file + ':12:3', file));
    await record('mailto uses external bridge', async () => {
      const result = await invoke('openUrl', 'mailto:reference-test@example.invalid?subject=Bridge');
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual((await calls()).at(-1), {method: 'openExternal', value: 'mailto:reference-test@example.invalid?subject=Bridge'});
    });
    await record('read-only resolver does not invoke OS shell', async () => {
      const before = (await calls()).length;
      const result = await expectPath({path: file}, file);
      assert.equal((await calls()).length, before);
      return result;
    });
    await record('resolver returns directory kind', () => expectPath({path: folder}, folder, 'directory'));
    await record('forward slashes and dot segments normalize', () => expectPath({path: folder.replaceAll('\\', '/') + '/../' + path.basename(folder) + '/' + path.basename(file)}, file));
    await record('relative file URI base directory', () => expectPath({path: path.basename(file), baseDir: pathToFileURL(folder).href}, file));
    await record('relative parent traversal follows explicit base', () => expectPath({path: '../' + path.basename(folder) + '/' + path.basename(file), baseDir: folder}, file));
    await record('plain percent filename is not URI decoded', () => expectOpen(percentFile, percentFile));
    await record('file URI percent decoding occurs once', () => expectOpen(pathToFileURL(percentFile).href, percentFile));
    await record('plain hash filename remains literal', () => expectPath({path: hashFile}, hashFile));
    await record('existing anchor-like filename wins over suffix parsing', () => expectPath({path: anchorNameFile}, anchorNameFile));
    await record('encoded hash filename remains literal', () => expectPath({path: pathToFileURL(hashFile).href}, hashFile));
    await record('colon line/column resolver metadata', () => expectPath({path: file + ':12:3'}, file, 'file', {line: 12, column: 3}));
    await record('hash line/column resolver metadata', () => expectPath({path: file + '#L9C2'}, file, 'file', {line: 9, column: 2}));
    await record('file URI line anchor metadata', () => expectPath({path: pathToFileURL(file).href + '#L8'}, file, 'file', {line: 8}));
    await record('resolver follows real directory junction', async () => {
      const link = path.join(fixtures, 'junction');
      fs.symlinkSync(folder, link, 'junction');
      return await expectPath({path: path.join(link, path.basename(file))}, file);
    });
    await record('UNC file URI converts to native UNC before stat', async () => {
      // URL treats localhost as the local machine, not as a UNC server name.
      const unc = '\\\\' + os.hostname().toLowerCase() + '\\' + file[0] + '$' + file.slice(2);
      const result = await invoke('resolveReferencePath', {path: pathToFileURL(unc).href});
      if (result.ok) {
        assert.equal(result.path, fs.realpathSync(unc));
        assert.equal(result.kind, 'file');
        return {stat: 'success', result};
      }
      assert.equal(typeof result.path, 'string', JSON.stringify(result));
      assert.equal(result.path.toLowerCase(), path.normalize(unc).toLowerCase(), JSON.stringify(result));
      assert(['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR'].includes(result.code), JSON.stringify(result));
      return {stat: 'unavailable-local-administrative-share', result, limitation: 'No share was created or network settings changed.'};
    });
    await record('missing file errors without shell invocation', async () => {
      const before = (await calls()).length;
      const result = await invoke('openPath', path.join(folder, 'missing.txt:7:2'));
      assert.equal(result.ok, false);
      assert.equal((await calls()).length, before);
      assert(result.error, JSON.stringify(result));
      return result;
    });
    for (const [name, input, code] of [
      ['relative path requires base', {path: 'notes.txt'}, 'BASE_DIR_REQUIRED'],
      ['relative base cannot silently use process cwd', {path: 'notes.txt', baseDir: '.'}, 'INVALID_BASE_DIR'],
      ['base must be an actual directory', {path: 'notes.txt', baseDir: file}, 'INVALID_BASE_DIR'],
      ['missing base reports failure', {path: 'notes.txt', baseDir: path.join(fixtures, 'missing')}, 'INVALID_BASE_DIR'],
      ['empty path rejected', {path: ''}, 'INVALID_PATH'],
      ['non-string path rejected', {path: {}}, 'INVALID_PATH'],
      ['NUL path rejected', {path: file + '\0'}, 'INVALID_PATH'],
      ['HTTP cannot masquerade as a local path', {path: 'https://example.com/a.txt'}, 'UNSUPPORTED_PROTOCOL'],
      ['encoded file URI path separator rejected', {path: pathToFileURL(folder).href + '/a%2Fb.txt'}, 'INVALID_PATH'],
    ]) await record(name, async () => {
      const before = (await calls()).length;
      const result = await invoke('resolveReferencePath', input);
      assert.equal(result.ok, false);
      assert.equal(result.code, code, JSON.stringify(result));
      assert.equal((await calls()).length, before);
      return result;
    });
    for (const url of ['https://example.com/reference?q=hello%20world', 'http://example.com/path']) {
      await record('external URL bridge ' + new URL(url).protocol, async () => {
        const before = (await calls()).length;
        const result = await invoke('openUrl', url);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal((await calls()).length, before + 1);
        assert.deepEqual((await calls()).at(-1), {method: 'openExternal', value: url});
      });
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,test', pathToFileURL(file).href, 'cmd://test', 'lumin://thread/reference-session', 'https://', 'https://example.com/\nunsafe']) {
      await record('deny external scheme/input ' + url.split(':')[0] + ' ' + JSON.stringify(url), async () => {
        const before = (await calls()).length;
        const result = await invoke('openUrl', url);
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal((await calls()).length, before);
        return result;
      });
    }
    await record('Electron openPath failure string reaches renderer', async () => {
      await app.evaluate(() => {global.__referenceFailure = {method: 'openPath', message: 'fixture: no associated application'};});
      try {
        const result = await invoke('openPath', file);
        assert.equal(result.ok, false);
        assert.equal(result.error, 'fixture: no associated application');
        return result;
      } finally {await app.evaluate(() => {global.__referenceFailure = null;});}
    });
    await record('Electron openPath rejection reaches renderer', async () => {
      await app.evaluate(() => {global.__referenceFailure = {method: 'openPath', message: 'fixture: native open failed', throws: true};});
      try {
        const result = await invoke('openPath', file);
        assert.equal(result.ok, false);
        assert.equal(result.error, 'fixture: native open failed');
      } finally {await app.evaluate(() => {global.__referenceFailure = null;});}
    });
    await record('Electron openExternal rejection reaches renderer', async () => {
      await app.evaluate(() => {global.__referenceFailure = {method: 'openExternal', message: 'fixture: external open failed'};});
      try {
        const result = await invoke('openUrl', 'https://example.com/reference');
        assert.equal(result.ok, false);
        assert.equal(result.error, 'fixture: external open failed');
      } finally {await app.evaluate(() => {global.__referenceFailure = null;});}
    });
    await record('window.open routes Lumin thread to renderer without OS', async () => {
      const before = (await calls()).length;
      await page.evaluate(() => {
        window.__referenceDeepLinks = [];
        window.__referenceUnsubscribe = window.itnWindow.onDeepLink(id => window.__referenceDeepLinks.push(id));
        window.open('lumin://thread/reference-desktop-session');
      });
      await page.waitForFunction(() => window.__referenceDeepLinks.includes('reference-desktop-session'), null, {timeout: 2500});
      await page.evaluate(() => window.__referenceUnsubscribe());
      assert.equal((await calls()).length, before);
      assert.equal(app.windows().length, 1);
    });
    await record('window.open mailto forwards to external bridge', async () => {
      const before = (await calls()).length;
      await page.evaluate(() => window.open('mailto:reference-test@example.invalid'));
      await assertEventually(async () => (await calls()).length === before + 1);
      assert.deepEqual((await calls()).at(-1), {method: 'openExternal', value: 'mailto:reference-test@example.invalid'});
      assert.equal(app.windows().length, 1);
    });
    await record('regular anchor navigation opens external URL without leaving app', async () => {
      const originalUrl = page.url();
      const before = (await calls()).length;
      await page.evaluate(() => {
        const link = document.createElement('a');
        link.id = 'reference-desktop-nav';
        link.href = 'https://example.com/plain-anchor';
        link.textContent = 'Reference navigation fixture';
        link.style = 'position:fixed;inset:80px auto auto 250px;z-index:99999';
        document.body.appendChild(link);
      });
      await page.locator('#reference-desktop-nav').click({noWaitAfter: true, force: true});
      await assertEventually(async () => (await calls()).length === before + 1);
      assert.equal(page.url(), originalUrl);
      assert.deepEqual((await calls()).at(-1), {method: 'openExternal', value: 'https://example.com/plain-anchor'});
      await page.evaluate(() => document.getElementById('reference-desktop-nav')?.remove());
    });
    report.calls = await calls();
    report.screenshot = path.join(runDir, 'electron-reference-check.png');
    // Hidden --ui-check windows may never paint a screenshot. Show only our own test window.
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].showInactive());
    try {await page.screenshot({path: report.screenshot, timeout: 10000});}
    finally {await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].hide());}
    await record('renderer has no uncaught errors', async () => assert.deepEqual(report.errors, []));
  } catch (error) {
    report.fatal = error.stack || String(error);
    console.error(report.fatal);
  } finally {
    if (app) await app.close().catch(error => {report.closeError = String(error);});
    report.finishedAt = new Date().toISOString();
    report.passed = report.results.filter(r => r.ok).length;
    report.failed = report.results.filter(r => !r.ok).length + (report.fatal ? 1 : 0);
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log('RESULT ' + report.passed + ' passed, ' + report.failed + ' failed; ' + path.join(runDir, 'report.json'));
    if (report.failed) process.exitCode = 1;
  }
})();

async function assertEventually(predicate) {
  const until = Date.now() + 2500;
  do {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < until);
  assert.fail('Expected shell bridge call did not arrive');
}
