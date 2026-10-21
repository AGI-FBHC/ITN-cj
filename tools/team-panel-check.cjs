const path = require('node:path');
const {chromium} = require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');

const root = path.resolve(__dirname, '..');

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
  await page.setContent(`<!doctype html><html><body>
      <div id="team-panel-scrim" class="team-modal" hidden><section id="team-panel" class="team-panel task-modal-card" hidden>
        <header class="team-panel-head"><div class="team-panel-title"><span class="team-panel-kicker">AGENT TREE</span><strong id="team-panel-title"></strong><span id="team-panel-meta"></span></div><button id="team-panel-close" class="team-panel-close"></button></header>
        <div class="team-panel-body"><section class="team-tree-wrap"><div class="team-tree-head"><strong>协作树</strong><span></span></div><div class="team-tree-canvas"><svg id="team-tree-lines" class="team-tree-lines"></svg><div id="team-tree" class="team-tree"></div></div></section><section id="team-detail" class="team-detail"></section></div>
      </section></div></body></html>`);
    await page.addStyleTag({path: path.join(root, 'shell/renderer/team-panel.css')});
    await page.addScriptTag({path: path.join(root, 'shell/renderer/team-panel.js')});

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
    check('tree renders all hierarchy nodes', await page.locator('.team-node').count() === 3);
    const thirdLevel = await page.locator('.team-node[data-node-id="n3"]').evaluate(node => {
      const n2 = document.querySelector('.team-node[data-node-id="n2"]');
      return Number(node.style.left.replace('px', '')) > Number(n2.style.left.replace('px', ''));
    });
    check('tree exposes a third level', thirdLevel && await page.locator('#team-tree-lines path').count() === 2);
    check('header shows the learning team name', (await page.locator('#team-panel-title').innerText()) === '主题研究小组');

    await page.locator('.team-node[data-node-id="n3"]').click();
    check('node click selects the node', await page.locator('.team-node[data-node-id="n3"]').getAttribute('class').then(v => v.includes('selected')));
    const detail = await page.locator('#team-detail').innerText();
    check('detail shows simplified process', detail.includes('检索与任务相关的资料') && detail.includes('分析资料并形成节点结论'));
    check('detail shows the final node answer', detail.includes('MCP 负责模型与工具连接'));

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check('popup does not create page horizontal overflow', overflow <= 1);
    const closeState = await page.locator('#team-panel-close').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return {visible: !!node.offsetParent, width: rect.width, height: rect.height, top: rect.top, left: rect.left};
    });
    check('close button stays visible in the popup header', closeState.visible && closeState.width > 20 && closeState.height > 20, JSON.stringify(closeState));
    await page.evaluate(() => document.querySelector('#team-panel-close').click());
    await page.waitForTimeout(340);
    check('close button hides the panel', await page.locator('#team-panel').isHidden());
    console.log('RESULT ' + passed + ' passed');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
