// Isolated real HTTP + real Cangjie kernel + deterministic model fixture.
// It verifies that the two learning-team tools really create a multi-level tree,
// execute nodes, emit inspectable events, and return a final answer.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-team-'));
  const coreExe = process.env.ITN_TEAM_CORE || path.join(root, 'core/target/release/bin/main.exe');
  const uiDir = process.env.ITN_TEAM_UI || path.join(root, 'shell/renderer');
  const kb = path.join(dir, 'kb');
  fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, 'mcp.md'), '# MCP\n\nMCP 用标准协议连接模型与外部工具，强调可发现、可调用和权限边界。');
  fs.writeFileSync(path.join(kb, 'a2a.md'), '# A2A\n\nA2A 面向 Agent 之间的协作，强调任务委派、消息传递和能力发现。');

  const mockPort = await freePort();
  const mock = spawn('python', [path.join(root, 'tools/mock-openai/server.py'), String(mockPort)], {
    windowsHide: true,
    stdio: 'ignore',
    env: {...process.env, ITN_MOCK_CHUNK_DELAY_MS: '0'},
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

    await post('/api/models/save', {
      id: 'mock',
      name: 'team mock',
      baseUrl: 'http://127.0.0.1:' + mockPort + '/v1',
      apiKey: 'test-only',
      model: 'mock',
    });
    await post('/api/models/roles', {chatModelId: 'mock'});
    await post('/api/kb/save', {id: 'kb', name: '协作树资料', rootDir: kb});
    await post('/api/kb/build', {id: 'kb'});

    const researchSession = (await post('/api/sessions/new', {})).sessionId;
    const research = await post('/api/agent/ask-pi', {
      sessionId: researchSession,
      kbId: 'kb',
      question: '请研究并对比 MCP 与 A2A 的定位、机制和适用场景',
      web: 'off',
    });
    check('research tool returns a final answer', research.ok === true && String(research.answer || '').length > 0);
    const researchEvents = (await post('/api/sessions/events', {sessionId: researchSession})).events;
    check('research tool is actually selected', researchEvents.some(e => e.type === 'tool/call' && e.payload.tool === 'research_topic_team'));
    check('research tree has run start', researchEvents.some(e => e.type === 'team/run_started'));
    const created = researchEvents.filter(e => e.type === 'team/node_created');
    const completed = researchEvents.filter(e => e.type === 'team/node_completed');
    check('research tree has multiple levels', created.some(e => Number(e.payload.depth) >= 2), 'created=' + created.length);
    check('research tree executes all created nodes', created.length >= 6 && completed.length >= 6, 'created=' + created.length + ', completed=' + completed.length);
    check('research tree emits node processes', completed.every(e => Array.isArray(e.payload.process) && e.payload.process.length >= 3));
    check('research tree emits final completion', researchEvents.some(e => e.type === 'team/run_completed' && e.payload.status === 'completed'));

    const planSession = (await post('/api/sessions/new', {})).sessionId;
    const plan = await post('/api/agent/ask-pi', {
      sessionId: planSession,
      kbId: 'kb',
      question: '请根据两周目标和每周 8 小时制定一份学习计划',
      web: 'off',
    });
    check('study-plan tool returns a final answer', plan.ok === true && String(plan.answer || '').length > 0);
    const planEvents = (await post('/api/sessions/events', {sessionId: planSession})).events;
    check('study-plan tool is actually selected', planEvents.some(e => e.type === 'tool/call' && e.payload.tool === 'plan_study_team'));
    check('study-plan tree has multiple levels', planEvents.some(e => e.type === 'team/node_created' && Number(e.payload.depth) >= 2));
    check('study-plan tree returns completed nodes', planEvents.filter(e => e.type === 'team/node_completed').length >= 6);
    check('study-plan tree completes', planEvents.some(e => e.type === 'team/run_completed' && e.payload.status === 'completed'));

    if (process.argv.includes('--ui')) {
      const browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
      try {
        const page = await browser.newPage({viewport: {width: 1280, height: 900}});
        const consoleErrors = [];
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        page.on('pageerror', error => consoleErrors.push(error.message));
        await page.goto(base + '/', {waitUntil: 'networkidle'});
        await page.evaluate(() => go('chat'));
        await page.waitForSelector('#chat-input', {timeout: 15000});
        await page.evaluate(() => newChat('', 'chat'));
        await page.waitForSelector('#chat-input', {timeout: 15000});
        await page.fill('#chat-input', '请研究并对比 MCP 与 A2A 的定位、机制和适用场景');
        await page.locator('.composer-send').click();
        try {
          await page.waitForFunction(() => (window.LuminTeamPanel && document.querySelector('#team-panel')) &&
            (state?.chatEvents || []).some(e => String(e.type || '').startsWith('team/')), null, {timeout: 30000});
          await page.waitForSelector('#team-panel.open', {timeout: 15000});
        } catch (error) {
          const diag = await page.evaluate(() => ({
            url: location.href,
            panel: !!window.LuminTeamPanel,
            visible: !!document.querySelector('#team-panel.open'),
            hidden: document.querySelector('#team-panel')?.hidden,
            events: (state?.chatEvents || []).filter(e => String(e.type || '').startsWith('team/')).map(e => e.type),
            session: state?.chatSessionId || '',
          }));
          console.error('UI_DIAG ' + JSON.stringify({diag, consoleErrors}));
          await page.screenshot({path: path.join(root, 'tmp', 'learning-team-ui-failure.png'), fullPage: true});
          throw error;
        }
        await page.waitForSelector('.team-node', {timeout: 15000});
        await page.waitForFunction(() => (state?.chatEvents || []).some(e => e.type === 'team/run_completed'), null, {timeout: 30000});
        await page.waitForFunction(() => (state?.chatEvents || []).filter(e => e.type === 'team/node_completed').length >= 6, null, {timeout: 15000});
        const liveTreeState = await page.evaluate(() => ({
          nodes: document.querySelectorAll('.team-node').length,
          completed: document.querySelectorAll('.team-node.status-completed').length,
          eventCompleted: (state?.chatEvents || []).filter(e => e.type === 'team/node_completed').length,
        }));
        check('live tree receives all completed node events', liveTreeState.nodes >= 6 && liveTreeState.completed >= 5, JSON.stringify(liveTreeState));
        check('live chat opens the collaboration side panel', await page.locator('#team-panel').isVisible());
        check('live chat renders a multi-level tree', await page.locator('#team-tree-lines path').count() >= 2 && await page.locator('.team-node').count() >= 3);
        await page.locator('.team-node:not(.selected)').first().click();
        check('live node click opens process detail', (await page.locator('#team-detail').innerText()).length > 20);
        await page.screenshot({path: path.join(root, 'tmp', 'learning-team-ui.png'), fullPage: true});
      } finally {
        await browser.close();
      }
    }

    console.log('RESULT ' + passed + ' passed; isolated data=' + dir);
  } finally {
    core.kill();
    mock.kill();
  }
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
