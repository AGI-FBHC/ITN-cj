/**
 * Link/reference navigation audit with real renderer, real isolated Cangjie kernel,
 * and a small injected Electron bridge. It verifies the renderer hands URLs and
 * paths to the correct bridge method; the bridge contract itself is tested in
 * shell:open-path/open-url by the desktop runtime.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {chromium} = require(require.resolve('playwright', {paths: ['D:/Desktop/ITN/ITN/src/frontend/agent-demo', path.resolve(__dirname, '..')]}));

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-reference-'));
const kbDir = path.join(dataDir, 'kb-source');
const portFile = path.join(dataDir, 'port');
fs.mkdirSync(kbDir, {recursive: true});
fs.writeFileSync(path.join(kbDir, 'notes.md'), '# 资料甲\n\n## 第一节\n\n资料甲正文：边界输入必须单独验证。\n', 'utf8');
const folderPath = path.join(dataDir, 'folder');
fs.mkdirSync(folderPath, {recursive: true});
let core, browser;
let passed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) throw new Error(name + (detail ? ' :: ' + detail : ''));
  passed++;
  console.log('PASS ' + name);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  try {
    core = spawn(path.join(root, 'dist/core/itn-desktop-core.exe'), [
      '--data-dir=' + dataDir,
      '--port-file=' + portFile,
      '--ui-dir=' + path.join(root, 'shell/renderer'),
    ], {windowsHide: true, stdio: 'ignore', env: {...process.env, cjHeapSize: '2GB'}});
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await sleep(100);
    assert(fs.existsSync(portFile), 'kernel did not start');
    const base = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').trim();
    const post = async (route, body = {}) => {
      const response = await fetch(base + '/api/' + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      const payload = await response.json();
      if (payload.code !== 0) throw new Error(route + ': ' + payload.message);
      return payload.data;
    };
    await post('kb/save', {id: 'reference-kb', name: '引用测试资料', rootDir: kbDir});
    await post('kb/build', {id: 'reference-kb'});

    browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
    const page = await browser.newPage({viewport: {width: 1440, height: 960}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__referenceCalls = [];
      window.itnWindow = {
        openPath: async value => { window.__referenceCalls.push({type: 'path', value}); return {ok: true}; },
        openUrl: async value => { window.__referenceCalls.push({type: 'url', value}); return {ok: true}; },
        onDeepLink: () => () => {},
        onStateChange: () => () => {},
        minimize: () => {},
        toggleMaximize: () => {},
        close: () => {},
      };
    });
    await page.goto(base);
    await page.waitForFunction(() => !document.getElementById('boot'), null, {timeout: 20000});
    await page.evaluate(async ({__folderPath, __filePath}) => {
      state.kb = 'reference-kb';
      current = 'chat';
      state.chatSessionId = 'reference-session';
      const citations = [
        {index: 1, label: '1', docTitle: '资料甲', docPath: 'notes.md', headingPath: '第一节', kbId: 'reference-kb', text: '资料甲正文：边界输入必须单独验证。'},
        {index: 2, label: 'W2', kind: 'web', docTitle: '网页资料', docPath: 'https://example.com/reference', headingPath: '网络资料', fetchedAt: '2026-10-24', text: '网页引用内容。'},
      ];
      const turn = {
        id: 'reference-turn', user: '请核对资料', items: [{
          t: 'a',
          text: [
            '资料甲 [1]，网页资料 [W2]。',
            '文件夹：`' + __folderPath + '`，系统文件：`' + __filePath + '`。',
            '网页：https://example.com/reference，相对资料：`notes.md`。',
          ].join('\n'),
        }],
        citations, report: null, ok: true, message: '', answerAt: new Date().toISOString(),
      };
      state.chatTurns = [turn];
      const host = document.getElementById('view');
      host.innerHTML = '';
      host.appendChild(renderTurnBlock(turn, false));
    }, {__folderPath: folderPath, __filePath: path.join(kbDir, 'notes.md')});

    const links = await page.evaluate(() => ({
      external: document.querySelectorAll('#view a.md-external-link').length,
      resources: document.querySelectorAll('#view a.md-resource-link').length,
      citations: document.querySelectorAll('#view .citation-link').length,
      citationRows: document.querySelectorAll('#view .cite-source').length,
    }));
    check('web URLs and local path references are rendered as links', links.external >= 1 && links.resources >= 3, JSON.stringify(links));
    check('inline citations and source rows are actionable', links.citations >= 2 && links.citationRows === 2, JSON.stringify(links));

    await page.locator('#view a.md-resource-link[data-reference-kind="path"]').first().click();
    const pathCall = await page.evaluate(() => window.__referenceCalls.filter(x => x.type === 'path').at(-1));
    check('directory/file path clicks use the desktop openPath bridge', pathCall?.value === folderPath, JSON.stringify(pathCall));

    const citationButton = page.locator('#view .citation-link').first();
    const citationBox = await citationButton.boundingBox();
    await page.mouse.click(citationBox.x + citationBox.width / 2, citationBox.y + citationBox.height / 2);
    await page.waitForSelector('#resource-dock:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#resource-dock .reference-content')?.textContent.includes('资料甲正文'));
    check('knowledge citation opens the right reference dock with its source text', await page.locator('#resource-dock .reference-title').innerText() === '资料甲');
    const panelBox = await page.locator('#resource-dock').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return {x: rect.x, right: rect.right, width: rect.width, viewport: innerWidth};
    });
    check('reference dock shares the page plane without leaving the viewport', panelBox.x >= 0 && panelBox.right <= panelBox.viewport && panelBox.width >= 260, JSON.stringify(panelBox));
    const shots = path.join(root, 'tmp/reference-link-check');
    fs.mkdirSync(shots, {recursive: true});
    await page.screenshot({path: path.join(shots, 'knowledge-reference.png')});
    check('reference dock offers opening the original file', await page.getByRole('button', {name: '打开原文件'}).count() === 1);
    await page.getByRole('button', {name: '打开原文件'}).click();
    const originalCall = await page.evaluate(() => window.__referenceCalls.filter(x => x.type === 'path').at(-1));
    check('reference dock forwards the original document to the desktop bridge', originalCall?.value.endsWith('notes.md'), JSON.stringify(originalCall));
    await page.locator('#resource-dock .resource-dock-head button').click();
    await page.waitForSelector('#resource-dock', {state: 'hidden'});

    await page.locator('#view .cite-source').filter({hasText: '资料甲'}).click();
    await page.waitForSelector('#resource-dock:not([hidden])');
    check('source list rows open the same reference dock', await page.locator('#resource-dock .reference-title').innerText() === '资料甲');
    await page.locator('#resource-dock .resource-dock-head button').click();

    await page.locator('#view .cite-source').filter({hasText: '网页资料'}).click();
    await page.waitForSelector('#resource-dock:not([hidden])');
    await page.getByRole('button', {name: '用浏览器打开'}).click();
    const urlCall = await page.evaluate(() => window.__referenceCalls.filter(x => x.type === 'url').at(-1));
    check('web citation opens the configured http(s) URL in the desktop browser bridge', urlCall?.value === 'https://example.com/reference', JSON.stringify(urlCall));
    await page.locator('#resource-dock .resource-dock-head button').click();

    await page.locator('#view a.md-resource-link[data-reference-kind="kb"]').first().click();
    await page.waitForSelector('#resource-dock:not([hidden])');
    check('knowledge path links open the resource dock instead of navigating away', await page.locator('#resource-dock .reference-title').innerText() === '资料甲');
    await page.locator('#resource-dock .resource-dock-head button').click();
    check('references do not throw renderer errors', errors.length === 0, errors.join(' | '));
    console.log('RESULT=OK ' + passed + ' checks; data=' + dataDir);
  } finally {
    if (browser) await browser.close();
    if (core) core.kill();
  }
})().catch(error => { console.error('RESULT=FAILED ' + error.stack); process.exitCode = 1; });
