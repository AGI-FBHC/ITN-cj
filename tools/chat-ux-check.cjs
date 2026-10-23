// Browser integration checks for Markdown links, the in-progress jump button,
// the personal-resource layout, and the knowledge-network intro camera spin.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-chat-ux-'));
  const coreExe = process.env.ITN_UX_CORE || path.join(root, 'dist/core/itn-desktop-core.exe');
  const uiDir = process.env.ITN_UX_UI || path.join(root, 'shell/renderer');
  const kb = path.join(dir, 'kb');
  fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, 'doc.md'), '# Agent\n\nMCP 连接工具，A2A 连接智能体。');
  const sample = path.join(dir, 'sample.md');
  fs.writeFileSync(sample, '# 示例资源\n\n这是个性资源正文。');

  const mockPort = await freePort();
  const mock = spawn('python', [path.join(root, 'tools/mock-openai/server.py'), String(mockPort)], {
    windowsHide: true,
    stdio: 'ignore',
    env: {...process.env, ITN_MOCK_CHUNK_DELAY_MS: '0', ITN_MOCK_SLOW_MS: '8000'},
  });
  const portFile = path.join(dir, 'port');
  const core = spawn(coreExe, [
    '--data-dir=' + dir,
    '--port-file=' + portFile,
    '--ui-dir=' + uiDir,
    '--skills-dir=' + path.join(root, 'shell/skills'),
  ], {windowsHide: true, stdio: 'ignore'});

  let passed = 0;
  const check = (name, ok, details = '') => {
    if (!ok) throw new Error(name + (details ? ' ' + details : ''));
    passed += 1;
    console.log('PASS ' + name);
  };

  try {
    for (let i = 0; i < 120 && !fs.existsSync(portFile); i += 1) await pause(100);
    if (!fs.existsSync(portFile)) throw new Error('kernel did not start');
    const base = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').trim();
    const post = async (url, body) => {
      const response = await fetch(base + url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (data.code !== 0) throw new Error(url + ': ' + data.message);
      return data.data;
    };
    await post('/api/models/save', {id: 'mock', name: 'ux mock', baseUrl: 'http://127.0.0.1:' + mockPort + '/v1', apiKey: 'test', model: 'mock'});
    await post('/api/models/roles', {chatModelId: 'mock'});
    await post('/api/kb/save', {id: 'kb', name: 'UX 资料', rootDir: kb});
    await post('/api/kb/build', {id: 'kb'});
    await post('/api/personal/save', {
      path: sample,
      title: '这是一段非常长的资源标题，用来确认个性资源卡片不会把整段正文挤进列表，影响阅读和选择，这是第二行内容。',
      text: '这是一段非常长的资源标题，用来确认个性资源卡片不会把整段正文挤进列表，影响阅读和选择，这是第二行内容。',
      confirmed: true,
    });

    const browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
    try {
      const page = await browser.newPage({viewport: {width: 1280, height: 820}});
      await page.goto(base + '/', {waitUntil: 'networkidle'});
      await page.evaluate(() => go('chat'));
      await page.waitForSelector('#chat-input', {timeout: 15000});
      await page.evaluate(() => newChat('', 'chat'));
      await page.waitForSelector('#chat-input', {timeout: 15000});
      await page.evaluate(() => {
        window.itnWindow = window.itnWindow || {};
        window.itnWindow.openUrl = async url => { window.__externalUrl = url; return {ok: true}; };
        window.itnWindow.readResourceFile = async file => ({
          ok: true,
          kind: 'markdown',
          path: String(file || ''),
          name: 'sample.md',
          text: '# 示例资源\n\n这是个性资源正文。',
          title: '示例资源',
        });
      });

      await page.fill('#chat-input', '表格渲染测试');
      await page.locator('.composer-send').click();
      await page.waitForSelector('a.md-external-link', {timeout: 20000});
      const link = page.locator('a.md-external-link').first();
      await link.hover();
      await page.waitForSelector('#md-link-tip.show');
      check('Markdown link has a hover tooltip', (await page.locator('#md-link-tip').innerText()).includes('Ctrl + 点击打开'));
      await link.click();
      check('Markdown link opens through the desktop browser bridge', (await page.evaluate(() => window.__externalUrl || '')).startsWith('https://'));

      await page.waitForFunction(() => state.busyTurn === false, null, {timeout: 20000});
      await page.fill('#chat-input', '慢速任务测试');
      await page.locator('.composer-send').click();
      await page.waitForFunction(() => state.busyTurn === true, null, {timeout: 10000});
      await page.evaluate(() => {
        const thread = document.querySelector('#chat-thread');
        /* 生成期间线程每 220ms 重画一次，直接塞进去的夹具会被冲掉，
           按钮跟着消失，悬停断言就变成和重画赛跑。用观察者把夹具补回来，
           这样断言测的是悬停本身，不是重画时机。 */
        const keepFixture = () => {
          if (document.getElementById('jump-fixture')) return;
          const filler = document.createElement('div');
          filler.id = 'jump-fixture';
          filler.style.height = '1800px';
          thread.appendChild(filler);
          thread.dispatchEvent(new Event('scroll'));
        };
        window.__jumpFixtureObserver = new MutationObserver(keepFixture);
        window.__jumpFixtureObserver.observe(thread, {childList: true});
        keepFixture();
        thread.scrollTop = 0;
        thread.dispatchEvent(new Event('scroll'));
      });
      await page.waitForSelector('.chat-jump-latest.show');
      check('jump button has three animated dots', await page.locator('.chat-jump-latest .jump-dots i').count() === 3);
      await page.locator('.chat-jump-latest').hover();
      const hoverStyle = await page.locator('.chat-jump-latest').evaluate(node => ({
        dots: getComputedStyle(node.querySelector('.jump-dots')).display,
        arrow: getComputedStyle(node.querySelector('.jump-arrow')).display,
      }));
      check('jump button swaps to an arrow on hover', hoverStyle.dots === 'none' && hoverStyle.arrow === 'block', JSON.stringify(hoverStyle));
      // 夹具留着（点一下本来就该滚到内容底部），但别让观察者再把线程撑高
      await page.evaluate(() => { window.__jumpFixtureObserver?.disconnect(); });
      await page.locator('.chat-jump-latest').click();
      // 平滑滚动本身要几百毫秒，而且生成中重画会改内容高度：等它真的到底，别和 350ms 赛跑
      await page.waitForFunction(() => {
        const node = document.querySelector('#chat-thread');
        return node.scrollHeight - node.scrollTop - node.clientHeight < 90;
      }, null, {timeout: 4000}).catch(() => {});
      const atBottom = await page.locator('#chat-thread').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 90);
      check('jump button returns to the live bottom', atBottom);
      await page.evaluate(() => { if (state.busyTurn) document.querySelector('.composer-send')?.click(); });

      await page.evaluate(() => go('resources'));
      await page.waitForSelector('.outcome-page .personal-entry', {timeout: 15000});
      const resourceUi = await page.locator('.outcome-page').evaluate(node => {
        const card = node.querySelector('.personal-entry');
        const list = node.querySelector('.outcome-list-panel');
        return {
          title: card.querySelector('strong').textContent,
          clamp: getComputedStyle(card.querySelector('strong')).webkitLineClamp,
          listWidth: Math.round(list.getBoundingClientRect().width),
          hasPlaceholder: !!node.querySelector('.outcome-placeholder'),
        };
      });
      check('long resource titles are shortened in the list', resourceUi.title.length <= 60, JSON.stringify(resourceUi));
      check('resource cards use a two-line clamp', resourceUi.clamp === '2');
      check('resource list has a practical master width', resourceUi.listWidth >= 330, JSON.stringify(resourceUi));
      check('resource reader has a purposeful empty state', resourceUi.hasPlaceholder);
      await page.screenshot({path: path.join(root, 'tmp', 'outcome-redesign-check.png'), fullPage: true});
      await page.locator('.personal-entry').first().click();
      await page.waitForSelector('#resource-dock:not([hidden])', {timeout: 15000});
      check('resource selection still opens the embedded reader', await page.locator('#outcome-reader.has-selection').count() === 1);

      await page.locator('#rail [data-page="home"]').click();
      await page.waitForSelector('#knowledge-workspace canvas', {timeout: 15000});
      const graphMode = await page.evaluate(() => ({view:knowledgeNet.view,legacyOrbit:'yaw' in knowledgeNet||'pitch' in knowledgeNet,camera:!!knowledgeNet.camera}));
      check('learning network opens as a force graph without camera orbit', graphMode.view==='graph'&&!graphMode.legacyOrbit&&graphMode.camera, JSON.stringify(graphMode));

      await page.locator('#rail [data-page="kb"]').click();
      await page.waitForSelector('.kb-workspace-tabs', {timeout: 15000});
      check('knowledge base exposes three right-top function tabs', await page.locator('.kb-workspace-tabs .workspace-tab').count() === 3);
      await page.locator('.kb-workspace-tabs [data-kb-tab="harvest"]').click();
      await page.waitForSelector('.harvest-entry:not([hidden])', {timeout: 15000});
      check('harvest has its own knowledge-base view', await page.locator('.harvest-entry').isVisible());
      await page.locator('.kb-workspace-tabs [data-kb-tab="manage"]').click();
      await page.waitForSelector('#kb-management:not([hidden])', {timeout: 15000});
      check('knowledge-base management has its own view', await page.locator('#kb-management').isVisible());
      await page.locator('.kb-workspace-tabs [data-kb-tab="view"]').click();
      await page.waitForSelector('.document-browser:not([hidden])', {timeout: 15000});
      check('view knowledge base remains the default workspace', await page.locator('.document-browser').isVisible());

      await post('/api/knowledge/save', {title:'MCP', definition:'模型与外部工具连接协议。'});
      await post('/api/knowledge/save', {title:'A2A', definition:'智能体之间的协作协议。'});
      const suggested = await post('/api/knowledge/suggest-links', {});
      check('knowledge link suggestions come from the model', suggested.suggestions.length >= 1 && suggested.suggestions[0].exists === false);
      await post('/api/knowledge/link', {from:suggested.suggestions[0].from, to:suggested.suggestions[0].to, label:suggested.suggestions[0].label});
      const repeated = await post('/api/knowledge/suggest-links', {});
      check('existing knowledge links are marked instead of duplicated', repeated.suggestions.some(item => item.exists === true));
      await page.locator('#rail [data-page="home"]').click();
      await page.waitForSelector('.knowledge-toolbar', {timeout: 15000});
      await page.getByRole('button', {name:'连线建议'}).click();
      await page.waitForSelector('.knowledge-dialog .knowledge-link-suggestion', {timeout: 15000});
      check('knowledge network exposes a multi-select suggestion dialog', await page.locator('.knowledge-link-suggestion input').count() >= 1);
    } finally {
      await browser.close();
    }
    console.log('RESULT ' + passed + ' passed');
  } finally {
    core.kill();
    mock.kill();
  }
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
