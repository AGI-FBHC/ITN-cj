const path = require('node:path');
const fs = require('node:fs');
const {chromium} = require(require.resolve('playwright', {paths: [
  path.resolve(path.dirname(process.execPath), '..'),
  'D:/Desktop/ITN/ITN/src/frontend/agent-demo',
]}));

const root = path.resolve(__dirname, '..');
const ui = path.resolve(process.env.TEAM_UI || path.join(root, 'shell/renderer'));

async function checkReplyEntrypoints(browser, events, check) {
  const page = await browser.newPage({viewport: {width: 1280, height: 820}});
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = [{type: 'turn/start', turnId: 'reply', payload: {kind: 'ask'}},
    {type: 'user/message', turnId: 'reply', payload: {text: '测试协作流程'}},
    {type: 'tool/call', turnId: 'reply', payload: {callId: 'team-tool', tool: 'research_topic_team', args: {}}}];
  const forRun = (runId, turnId = 'reply') => events.map(e => ({...e, turnId, payload: {...e.payload, runId}}));
  const history = [...base, ...forRun('history-run'), ...forRun('history-second'),
    {type: 'tool/result', turnId: 'reply', payload: {callId: 'team-tool', tool: 'research_topic_team', ok: true, summary: '已完成'}},
    {type: 'assistant/message', turnId: 'reply', payload: {text: '历史任务最终回复'}},
    {type: 'turn/end', turnId: 'reply', payload: {ok: true}}];
  const sessions = {live: base, history, empty: []};
  let mockAsks = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'team-panel.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      const body = route.request().postDataJSON() || {};
      let data = {};
      if (url.pathname === '/api/settings') data = {models: [{id: 'fixture', name: 'Fixture', model: 'fixture'}], chatModelId: 'fixture', knowledgeBases: []};
      if (url.pathname === '/api/sessions/list') data = {sessions: Object.keys(sessions).map(sessionId => ({sessionId, title: sessionId, projectId: ''}))};
      if (url.pathname === '/api/sessions/events') data = {events: sessions[body.sessionId] || [], lastId: (sessions[body.sessionId] || []).length};
      if (url.pathname === '/api/agent/ask-pi') {
        mockAsks++;
        sessions[body.sessionId] = [...base, ...forRun('fast-run'),
          {type: 'assistant/message', turnId: 'reply', payload: {text: '轮询前即完成的测试回复'}},
          {type: 'turn/end', turnId: 'reply', payload: {ok: true}}];
        data = {ok: true};
      }
      return route.fulfill({json: {code: 0, data}});
    }
    const file = path.join(ui, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
    if (!fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    const body = fs.readFileSync(file);
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')});
    return route.fulfill({body, contentType: file.endsWith('.css') ? 'text/css' : 'application/octet-stream'});
  });
  await page.goto('http://team-panel.test/');
  await page.addScriptTag({path: path.join(ui, 'app.js')});
  await page.addScriptTag({path: path.join(ui, 'team-panel.js')});
  await page.evaluate(async () => {
    document.getElementById('boot')?.remove();
    current = 'chat'; currentSection = ''; state.chatSessionId = 'live';
    await PAGES.chat.render();
  });
  await page.evaluate(() => {
    window.LuminTeamPanel.ingest(state.chatEvents, 'live', {autoOpen: true});
    state.chatPaint();
  });
  check('tool call exposes an entry before any team planning events arrive', await page.locator('.team-open-btn').count() === 1);
  await page.locator('.team-open-btn').click();
  await page.locator('#team-panel-close').click();
  await page.locator('#team-panel').waitFor({state: 'hidden'});
  await page.locator('.team-open-btn').click();
  check('planning can be reopened before run_started and nodes arrive', await page.locator('#team-panel').isVisible() && (await page.locator('#team-detail').innerText()).includes('规划'));
  await page.evaluate(events => {
    state.chatEvents = state.chatEvents.concat(events);
    state.chatTurns = turnsFromEvents(state.chatEvents);
    window.LuminTeamPanel.ingest(events, 'live', {autoOpen: true});
    state.chatPaint();
  }, forRun('live-run').slice(0, 6));
  check('team-only live events invalidate the real reply cache and expose a reopen button', await page.locator('.team-open-btn[data-run-id="live-run"]').count() === 1);
  await page.locator('#team-panel-close').click();
  await page.locator('#team-panel').waitFor({state: 'hidden'});
  await page.locator('.work-head').click();
  await page.locator('.team-open-btn[data-run-id="live-run"]').click();
  await page.waitForSelector('#team-panel.open');
  await page.locator('[data-node-id="n3"] .team-node-title').click();
  check('the live reply button reopens the running tree after toggling tool process', await page.evaluate(() => window.LuminTeamPanel.isOpen()) && await page.locator('.team-detail-title').innerText() === '定义与术语');
  await page.locator('#team-panel-close').click();
  await page.locator('#team-panel').waitFor({state: 'hidden'});
  await page.locator('#panel-body .panel-item[data-id="history"]').click();
  await page.waitForFunction(() => document.getElementById('chat-thread')?.dataset.session === 'history' && state.chatTurns.some(t => t.ok === true));
  check('history loading stays closed and restores all runs on the corresponding reply', await page.locator('#team-panel').isHidden() && await page.locator('.team-open-btn').count() === 2 && (await page.locator('.turn-block').innerText()).includes('历史任务最终回复'));
  await page.locator('.team-open-btn[data-run-id="history-run"]').click();
  await page.waitForSelector('#team-panel.open');
  await page.locator('[data-node-id="n3"] .team-node-title').click();
  check('a history reply button restores completed child process and answer', await page.evaluate(() => window.LuminTeamPanel.isOpen()) && (await page.locator('#team-detail').innerText()).includes('MCP 负责模型与工具连接'));
  await page.locator('#team-panel-close').click();
  await page.locator('#team-panel').waitFor({state: 'hidden'});
  await page.locator('.team-open-btn[data-run-id="history-second"]').click();
  await page.waitForSelector('#team-panel.open');
  check('multiple team tools in one reply each reopen their own run', await page.locator('.team-node').count() === 3);
  await page.locator('#team-panel-close').click();
  await page.locator('#team-panel').waitFor({state: 'hidden'});
  await page.locator('#panel-body .panel-item[data-id="empty"]').click();
  await page.waitForFunction(() => document.getElementById('chat-thread')?.dataset.session === 'empty' && state.chatTurns.length === 0);
  check('switching to a session without teams clears old reply entries', await page.locator('.team-open-btn').count() === 0 && await page.locator('#team-panel').isHidden());
  await page.locator('#chat-input').fill('只走内存夹具，不调用模型');
  await page.locator('#chat-input').press('Enter');
  await page.waitForFunction(() => !state.busyTurn && state.chatEvents.some(e => e.type === 'team/run_completed'));
  await page.locator('.team-open-btn[data-run-id="fast-run"]').click();
  await page.waitForSelector('#team-panel.open');
  await page.locator('[data-node-id="n3"] .team-node-title').click();
  check('final event fetch restores a run completed before the first poll', mockAsks === 1 && (await page.locator('#team-detail').innerText()).includes('MCP 负责模型与工具连接'));
  for (const width of [1024, 900]) {
    await page.setViewportSize({width, height:600});
    check('dock close and chat remain within the narrow desktop: ' + width, await page.evaluate(() => {
      const main = document.querySelector('.app > .main').getBoundingClientRect();
      const pane = document.getElementById('team-panel').getBoundingClientRect();
      const close = document.getElementById('team-panel-close').getBoundingClientRect();
      return pane.right <= innerWidth && close.right <= innerWidth && main.right <= pane.left + 1 && main.width >= 270;
    }));
  }
  check('real app integration produces no uncaught browser errors', errors.length === 0, errors.join('; '));
  await page.close();
}

async function main() {
  const browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
  let passed = 0;
  const check = (name, ok, details = '') => {
    if (!ok) throw new Error(name + (details ? ' ' + details : ''));
    passed += 1;
    console.log('PASS ' + name);
  };
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 820}});
    const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
    const start = html.indexOf('<aside id="team-panel-scrim"');
    const modal = html.slice(start, html.indexOf('</aside>', start) + 8);
    console.log('TEAM_UI ' + ui);
    await page.setContent('<!doctype html><html><body><header class="titlebar">LUMIN</header><div class="app"><main class="main"><textarea id="peer-chat"></textarea></main>' + modal + '</div></body></html>');
    await page.addStyleTag({path: path.join(ui, 'style.css')});
    await page.addStyleTag({path: path.join(ui, 'team-panel.css')});
    await page.addScriptTag({path: path.join(ui, 'team-panel.js')});

    const runId = 'team-ui-check';
    const events = [
      {type: 'team/run_started', payload: {runId, tool: 'research_topic_team', goal: '比较 MCP 与 A2A'}},
      {type: 'team/node_created', payload: {runId, nodeId: 'n1', parentId: '', depth: 0, role: '协作调度员', title: '研究任务', objective: '汇总最终结论'}},
      {type: 'team/node_created', payload: {runId, nodeId: 'n2', parentId: 'n1', depth: 1, role: '概念研究员', title: '核心概念', objective: '梳理定义和边界'}},
      {type: 'team/node_created', payload: {runId, nodeId: 'n3', parentId: 'n2', depth: 2, role: '定义研究员', title: '定义与术语', objective: '解释两个协议'}},
      {type: 'team/node_started', payload: {runId, nodeId: 'n3', parentId: 'n2', depth: 2, role: '定义研究员', title: '定义与术语', objective: '解释两个协议', status: 'running'}},
      {type: 'team/node_stage', payload: {runId, nodeId: 'n3', parentId: 'n2', depth: 2, role: '定义研究员', title: '定义与术语', objective: '解释两个协议', status: 'running', label: '检索与任务相关的资料'}},
      {type: 'team/node_completed', payload: {runId, nodeId: 'n3', parentId: 'n2', depth: 2, role: '定义研究员', title: '定义与术语', objective: '解释两个协议', status: 'completed', answer: '## 结论\n\nMCP 负责模型与工具连接。[1]', process: ['读取学习上下文', '检索与任务相关的资料', '分析资料并形成节点结论', '节点完成'], elapsedMs: 1200}},
      {type: 'team/node_completed', payload: {runId, nodeId: 'n2', parentId: 'n1', depth: 1, role: '概念研究员', title: '核心概念', objective: '梳理定义和边界', status: 'completed', answer: '概念节点汇总完成。', process: ['收集子节点结果', '汇总并形成阶段性结论', '汇总完成'], elapsedMs: 900}},
      {type: 'team/node_completed', payload: {runId, nodeId: 'n1', parentId: '', depth: 0, role: '协作调度员', title: '研究任务', objective: '汇总最终结论', status: 'completed', answer: '# 最终回答\n\nMCP 与 A2A 的定位不同。', process: ['收集子节点结果', '汇总并形成阶段性结论', '汇总完成'], elapsedMs: 1500}},
      {type: 'team/run_completed', payload: {runId, status: 'completed', answer: '# 最终回答\n\nMCP 与 A2A 的定位不同。', elapsedMs: 1800}},
    ];
    await page.evaluate(({events, runId}) => window.LuminTeamPanel.ingest(events, 's1', {autoOpen: true}), {events, runId});
    await page.waitForSelector('#team-panel.open');
    check('team panel opens from live events', await page.locator('#team-panel').isVisible());
    const stacked = await page.evaluate(() => {
      const graph = document.querySelector('.team-tree-wrap').getBoundingClientRect();
      const info = document.querySelector('#team-detail').getBoundingClientRect();
      return graph.width > 500 && info.top >= graph.bottom - 1 && Math.abs(info.left - graph.left) < 2;
    });
    check('graph uses the full upper pane with node details underneath', stacked);
    check('tree renders all hierarchy nodes', await page.locator('.team-node').count() === 3);
    const thirdLevel = await page.locator('.team-node[data-node-id="n3"]').evaluate(node => {
      const n2 = document.querySelector('.team-node[data-node-id="n2"]');
      return Number(node.style.top.replace('px', '')) > Number(n2.style.top.replace('px', ''));
    });
    check('tree exposes a third level', thirdLevel && await page.locator('#team-tree-lines path').count() === 2);
    check('header shows the learning team name', (await page.locator('#team-panel-title').innerText()) === '主题研究小组');

    await page.locator('.team-node[data-node-id="n3"]').click();
    await page.waitForTimeout(340);
    check('node click keeps the popup open after the close animation window', await page.locator('#team-panel').isVisible() && await page.evaluate(() => window.LuminTeamPanel.isOpen()));
    check('node click selects the node', await page.locator('.team-node[data-node-id="n3"]').getAttribute('class').then(v => v.includes('selected')));
    const detail = await page.locator('#team-detail').innerText();
    check('detail shows simplified process', detail.includes('检索与任务相关的资料') && detail.includes('分析资料并形成节点结论'));
    check('detail shows the final node answer', detail.includes('MCP 负责模型与工具连接'));

    for (const selector of [
      '[data-node-id="n2"]', '[data-node-id="n3"] .team-node-title',
      '[data-node-id="n2"] .team-node-role', '[data-node-id="n3"] .team-node-caption',
      '[data-node-id="n1"] .team-node-title', '[data-node-id="n3"]',
    ]) {
      await page.locator('.team-node' + selector).click();
      check('real click stays open: ' + selector, await page.locator('#team-panel').isVisible() && await page.evaluate(() => window.LuminTeamPanel.isOpen()));
    }
    const nodeHandle = await page.locator('[data-node-id="n3"]').elementHandle();
    const answerHandle = await page.locator('.team-answer').elementHandle();
    await page.evaluate(({runId}) => {
      window.LuminTeamPanel.ingest([{type: 'team/node_stage', payload: {runId, nodeId: 'n2', label: '新的运行事件'}}], 's1', {autoOpen: true});
    }, {runId});
    check('live events preserve the selected child, its DOM and keyboard focus', await nodeHandle.evaluate(n => n.isConnected && n.classList.contains('selected') && document.activeElement === n));
    check('other-node events preserve the answer being read', await answerHandle.evaluate(n => n.isConnected && n.textContent.includes('MCP 负责模型与工具连接')));
    await page.evaluate(({runId, events}) => window.LuminTeamPanel.syncSession('s1', events), {runId, events});
    check('same-session refresh keeps the popup and selected child open', await page.evaluate(() => window.LuminTeamPanel.isOpen()) && await nodeHandle.evaluate(n => n.isConnected && n.classList.contains('selected')));
    await page.evaluate(() => window.LuminTeamPanel.ingest([{type: 'team/run_started', payload: {runId: 'other-run', tool: 'plan_study_team', goal: '另一个任务'}}], 's1', {autoOpen: true}));
    check('a new run does not replace the tree being inspected', await page.locator('#team-panel-title').innerText() === '主题研究小组' && await nodeHandle.evaluate(n => n.isConnected && n.classList.contains('selected')));

    const popup = await page.locator('#team-panel').boundingBox();
    const peer = await page.locator('.app > .main').boundingBox();
    const topbar = await page.locator('.titlebar').boundingBox();
    check('team and chat share layout space without covering each other or the titlebar', peer.x + peer.width <= popup.x + 1 && popup.y >= topbar.y + topbar.height);
    await page.locator('#peer-chat').fill('面板打开时对话仍然可操作');
    check('chat remains interactive with the team pane open', await page.locator('#peer-chat').inputValue() === '面板打开时对话仍然可操作');
    const fit = await page.evaluate(() => {
      const box = document.querySelector('.team-tree-canvas').getBoundingClientRect();
      return [...document.querySelectorAll('.team-node')].every(node => {
        const r = node.getBoundingClientRect();
        return r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;
      });
    });
    check('initial fit shows every node without cropping', fit);
    await page.locator('#team-zoom-in').click();
    await page.locator('#team-zoom-fit').click();
    const beforeResize = popup.width;
    const handle = await page.locator('#team-resize').boundingBox();
    await page.mouse.move(handle.x + 4, handle.y + 50);
    await page.mouse.down();
    await page.mouse.move(handle.x - 70, handle.y + 50);
    await page.mouse.up();
    check('dragging the left edge resizes instead of dismissing the pane', await page.evaluate(() => window.LuminTeamPanel.isOpen()) && (await page.locator('#team-panel').boundingBox()).width > beforeResize + 50);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check('popup does not create page horizontal overflow', overflow <= 1);
    const closeState = await page.locator('#team-panel-close').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return {visible: !!node.offsetParent, width: rect.width, height: rect.height, top: rect.top, left: rect.left};
    });
    check('close button stays visible in the popup header', closeState.visible && closeState.width > 20 && closeState.height > 20, JSON.stringify(closeState));
    await page.locator('#team-panel-close').click();
    await page.waitForTimeout(340);
    check('close button hides the panel', await page.locator('#team-panel').isHidden());
    await page.evaluate(({runId}) => window.LuminTeamPanel.ingest([{type: 'team/node_stage', payload: {runId, nodeId: 'n2', label: '关闭后继续执行'}}], 's1', {autoOpen: true}), {runId});
    check('events keep running without reopening a dismissed popup', await page.locator('#team-panel').isHidden());
    await page.evaluate(runId => window.LuminTeamPanel.open(runId), runId);
    await page.waitForSelector('#team-panel.open');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(340);
    check('Escape dismisses the popup', await page.locator('#team-panel').isHidden());
    await page.evaluate(runId => window.LuminTeamPanel.open(runId), runId);
    await page.waitForSelector('#team-panel.open');
    await page.locator('#team-panel-scrim').click({position: {x: 4, y: 4}});
    await page.waitForTimeout(340);
    check('left edge clicks never dismiss the dock', await page.locator('#team-panel').isVisible());
    const wide = [{type:'team/run_started',payload:{runId:'wide',tool:'research_topic_team',goal:'同层节点保持一排'}},
      {type:'team/node_created',payload:{runId:'wide',nodeId:'root',depth:0,title:'调度员'}}];
    for(let i=0;i<6;i++)wide.push({type:'team/node_created',payload:{runId:'wide',nodeId:'leaf'+i,parentId:'root',depth:1,title:'研究员 '+i}});
    await page.evaluate(events=>{window.LuminTeamPanel.ingest(events,'s1');window.LuminTeamPanel.open('wide');},wide);
    const row = await page.locator('.team-node:not(.root)').evaluateAll(nodes=>nodes.map(n=>n.style.top));
    check('six siblings occupy one depth row without wrapping',row.length===6&&new Set(row).size===1);
    await page.locator('#team-zoom-fit').click();
    check('fit control reveals a wide tree without hiding nodes',await page.evaluate(()=>{
      const box=document.querySelector('.team-tree-canvas').getBoundingClientRect();
      return [...document.querySelectorAll('.team-node')].every(n=>{const r=n.getBoundingClientRect();return r.left>=box.left&&r.right<=box.right&&r.top>=box.top&&r.bottom<=box.bottom;});
    }));
    // Closing in the same frame as opening must cancel the queued show callback.
    await page.evaluate(runId => { window.LuminTeamPanel.open(runId); window.LuminTeamPanel.close(); }, runId);
    await page.waitForTimeout(340);
    check('immediate close cancels a queued open frame', await page.locator('#team-panel').isHidden() && !await page.evaluate(() => window.LuminTeamPanel.isOpen()));

    await checkReplyEntrypoints(browser, events, check);
    console.log('RESULT ' + passed + ' passed');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
