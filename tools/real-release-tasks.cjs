/** Six real-model learning tasks through the visible chat UI, at most five turns per task.
 * Only the model credentials are read from a private DB copy. All tasks, files and data
 * live in a fresh TEMP directory; credentials are scrubbed in finally. No mock model.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const {chromium} = require(require.resolve('playwright', {paths: ['D:/Desktop/ITN/ITN/src/frontend/agent-demo', path.resolve(__dirname, '..')]}));
const root = path.resolve(__dirname, '..'), pause = ms => new Promise(r => setTimeout(r, ms));
const out = path.join(root, 'tmp', 'real-release-tasks-' + new Date().toISOString().replace(/[:.]/g, '-'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-release-real-'));
const cred = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-release-cred-'));
const result = {startedAt: new Date().toISOString(), tasks: [], errors: [], thinkingVisible: false};
let browser, core, db, model, page, base, activeTask;
fs.mkdirSync(out, {recursive: true});
const clean = value => String(value || '').replaceAll(model?.api_key || '__no_key__', '[redacted]').slice(0, 1500);
const cleanEvents = events => JSON.stringify(events, (key, value) => {
  if (/api.?key|authorization|bearer/i.test(key)) return '[redacted]';
  return typeof value === 'string' ? value.replaceAll(model?.api_key || '__no_key__', '[redacted]') : value;
}, 2);
async function until(fn, message, timeout = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await fn()) return; await pause(170); }
  throw Error('Timeout: ' + message);
}
async function post(route, body = {}) {
  const response = await fetch(base + '/api/' + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(190000)});
  const payload = await response.json();
  if (payload.code !== 0) throw Error(route + ': ' + clean(payload.message));
  return payload.data;
}
const events = async sid => (await post('sessions/events', {sessionId: sid})).events || [];
function check(name, ok) { assert(ok, name); activeTask.checks.push(name); console.log('PASS ' + name); }
async function open(sid) {
  await page.evaluate(id => openChatSession(id), sid);
  await page.waitForSelector('#chat-input');
}
async function ask(sid, question) {
  assert(activeTask.turns.length < 5, 'five-turn task cap');
  await open(sid);
  const before = await events(sid), started = Date.now();
  const turn = {question, elapsedMs: 0, ok: false}; activeTask.turns.push(turn);
  console.log('RUN ' + activeTask.name + ' / turn ' + activeTask.turns.length);
  await page.locator('#chat-input').fill(question);
  await page.locator('.composer-send').click();
  let latest = [];
  try {
    await until(async () => {
      latest = (await events(sid)).slice(before.length);
      if (latest.some(e => e.type === 'assistant/thinking_delta')) {
        const visible = await page.locator('.think-row[open] .think-text').evaluateAll(nodes => nodes.some(n => n.checkVisibility() && n.textContent.length > 0));
        if (visible && !latest.some(e => e.type === 'turn/end')) result.thinkingVisible = true;
      }
      const approvals = await post('agent/approvals');
      for (const approval of approvals.requests || approvals.approvals || []) {
        if (approval.sessionId === sid) await post('agent/approvals/answer', {id: approval.id, decision: 'once'});
      }
      return latest.some(e => e.type === 'turn/end');
    }, 'real chat turn');
    await until(() => page.evaluate(id => !state.chatRequests?.has(id), sid), 'UI unlock after turn/end', 12000);
  } catch (error) {
    await post('agent/cancel', {sessionId: sid}).catch(() => {});
    throw error;
  }
  turn.elapsedMs = Date.now() - started;
  turn.ok = latest.findLast(e => e.type === 'turn/end')?.payload?.ok === true;
  turn.answer = latest.filter(e => e.type === 'assistant/message').map(e => e.payload?.text || '').join('\n');
  turn.tools = latest.filter(e => e.type === 'tool/result').map(e => ({tool: e.payload?.tool, ok: e.payload?.ok, summary: clean(e.payload?.summary)}));
  turn.tokens = latest.findLast(e => e.type === 'turn/usage')?.payload || {};
  turn.eventCounts = Object.fromEntries([...new Set(latest.map(e => e.type))].map(type => [type, latest.filter(e => e.type === type).length]));
  fs.writeFileSync(path.join(out, activeTask.name + '-turn-' + activeTask.turns.length + '.json'), cleanEvents(latest));
  const failure = latest.findLast(e => e.type === 'turn/end')?.payload?.message;
  if (!turn.ok) throw Error('turn failed: ' + clean(failure));
  const failedTools = turn.tools.filter(t => t.ok === false);
  if (failedTools.length) throw Error('tool failure: ' + JSON.stringify(failedTools));
  assert(turn.answer.trim().length > 0, 'real final answer is nonempty');
  console.log('DONE ' + activeTask.name + ' / ' + turn.elapsedMs + 'ms / tools=' + turn.tools.map(t => t.tool).join(','));
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  return {turn, events: latest};
}
async function task(name, run, projectId = '') {
  if (process.env.REAL_TASK_ONLY && !name.startsWith(process.env.REAL_TASK_ONLY)) return;
  activeTask = {name, status: 'running', checks: [], turns: []}; result.tasks.push(activeTask);
  const sid = (await post('sessions/new', {projectId})).sessionId;
  activeTask.sessionId = sid;
  await post('sessions/reasoning', {sessionId: sid, mode: 'low'});
  try {
    await run(sid);
    activeTask.status = 'passed';
  } catch (error) {
    activeTask.status = 'failed'; activeTask.error = clean(error.message); console.error('FAIL ' + name + ': ' + activeTask.error);
  }
  await page.screenshot({path: path.join(out, name.replace(/[^\w-]/g, '_') + '.png')}).catch(() => {});
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
}

(async () => {
  try {
    const source = path.join(process.env.LOCALAPPDATA, 'Lumin', 'itn.db');
    for (const suffix of ['', '-wal']) if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, path.join(cred, 'itn.db') + suffix);
    db = new DatabaseSync(path.join(cred, 'itn.db'), {readOnly: true});
    model = db.prepare('SELECT base_url,api_key,model FROM models WHERE id=?').get(process.env.REAL_SMOKE_MODEL_ID || 'deepseek');
    db.close(); db = null; assert(model?.api_key, 'configured real model'); result.model = model.model;
    const pf = path.join(dir, 'port');
    core = spawn(process.env.REAL_TASK_CORE || path.join(root, 'dist/core/itn-desktop-core.exe'), ['--data-dir=' + dir, '--port-file=' + pf, '--ui-dir=' + (process.env.ITN_UI_DIR || path.join(root, 'shell/renderer')), '--skills-dir=' + path.join(root, 'shell/skills')], {windowsHide: true, stdio: 'ignore', env: {...process.env, cjHeapSize: '2GB'}});
    await until(() => fs.existsSync(pf), 'native kernel startup', 20000);
    base = 'http://127.0.0.1:' + fs.readFileSync(pf, 'utf8').trim();
    await post('models/save', {id: 'real-tasks', name: '真实任务验收', baseUrl: model.base_url, apiKey: model.api_key, model: model.model, reasoningProfile: process.env.REAL_REASONING_PROFILE || 'deepseek'});
    await post('models/roles', {chatModelId: 'real-tasks'});
    const kb = path.join(dir, 'kb'); fs.mkdirSync(kb);
    fs.writeFileSync(path.join(kb, 'contracts.md'), '# 输入输出约定\n\n验证代码 LC-091。输入整数2和3，求和规则输出5。测试要记录输入、参数、预期、实际结果、耗时。异常输入必须明确拒绝，不能默认为0。正常、边界、异常分别检查。幂等性是同样请求重复执行不额外产生副作用；创建请求可带幂等键，服务端复用已保存结果。');
    fs.writeFileSync(path.join(kb, 'retrieval.md'), '# 检索与工具验证\n\nRAG先检索外部资料再结合来源生成回答。MCP侧重模型与工具的连接及权限边界；A2A侧重智能体之间的任务协作。引用应对应真实检索到的片段，数据缺失需明说，不能猜测。返回值是函数输出，副作用是外部状态变化。');
    await post('kb/save', {id: 'release-real', name: '真实任务资料', rootDir: kb});
    await post('kb/build', {id: 'release-real'});
    browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
    page = await browser.newPage({viewport: {width: 1440, height: 960}});
    page.on('pageerror', e => result.errors.push(clean(e.message)));
    await page.goto(base); await page.waitForSelector('#chat-input'); await page.waitForFunction(() => !document.getElementById('boot'));
    await page.evaluate(() => {state.kb = 'release-real';});

    await task('01-retrieval-calculation', async sid => {
      const first = await ask(sid, '查一下知识库里的输入输出约定，给出验证代码和异常输入的处理要求，引用出处。再用calc分别计算17*19与(12+8)*3/4，以工具结果为准。150字以内。');
      check('search and native calculator both execute successfully', first.turn.tools.some(t => t.tool === 'kb_search') && first.turn.tools.filter(t => t.tool === 'calc').length >= 2);
      check('answer contains grounded code and computed values', /LC-091/.test(first.turn.answer) && /323/.test(first.turn.answer) && /15/.test(first.turn.answer));
      const follow = await ask(sid, '基于刚才的资料，异常输入能默认按0计算吗？解释理由并举一个最短反例。100字以内。');
      check('multi-turn context survives tools', /不能|不应|不可以|不允许/.test(follow.turn.answer));
    });
    await task('02-memory-notes', async sid => {
      const a = await ask(sid, '请记住我的长期学习偏好：我喜欢先看具体输入输出的例子，再解释概念。调用记忆工具保存原话。再调用save_note记录一条笔记，标题为「091验收笔记」，内容为「边界输入和异常输入应分别验证」。');
      check('preference and note are actually saved', a.turn.tools.some(t => t.tool === 'remember_learning_fact') && a.turn.tools.some(t => t.tool === 'save_note'));
      const b = await ask(sid, '调用get_learning_context确认我的学习偏好，然后用search_personal_resources找到刚才那条091验收笔记并读取内容，别重新写。100字以内回答。');
      check('saved personal data can be read through agent tools', b.turn.tools.some(t => t.tool === 'get_learning_context') && b.turn.tools.some(t => t.tool === 'search_personal_resources') && /异常/.test(b.turn.answer));
    });
    await task('03-knowledge-network', async sid => {
      const a = await ask(sid, '我在学幂等性。结合资料说明什么是幂等性、为什么它适合处理重复点击，并把这个主知识点和来源记录下来。150字以内。');
      check('discussion records a real knowledge node', a.turn.tools.some(t => t.tool === 'record_knowledge_point'));
      await ask(sid, '另外解释一下函数副作用与返回值的区别，只以函数副作用为主知识点记录到知识网络，100字以内。');
      const before = await post('knowledge/graph');
      const b = await ask(sid, '请用search_personal_resources查出刚才的幂等性知识点，再用read_knowledge_point读取来源；然后调用suggest_knowledge_links给现有知识网络生成连线建议。只提出建议，先不要替我建边。');
      check('knowledge sources and link suggestions are accessible to the agent', b.turn.tools.some(t => t.tool === 'read_knowledge_point') && b.turn.tools.some(t => t.tool === 'suggest_knowledge_links'));
      const after = await post('knowledge/graph'); check('suggestions do not silently create edges', after.links.length === before.links.length);
    });
    await task('04-learning-resource', async sid => {
      const a = await ask(sid, '请直接调用generate_learning_resource做一份3题的分阶测试，主题为输入输出约定与边界验收，面向零基础，中文简洁，用于自测。kind=quiz,count=3,detail=concise。已有要求全在这里，不要再确认。仅生成候选给我预览，先不要收录。');
      check('resource generator completes through the real model', a.turn.tools.some(t => t.tool === 'generate_learning_resource'));
      const resources = (await post('learning/resources', {})).resources;
      const quiz = resources.findLast(r => r.kind === 'quiz'); check('generated quiz is persisted with a real resource id', !!quiz?.id);
      const b = await ask(sid, '请调用read_learning_resource读取刚才生成的测试'+quiz.id+'，告诉我第一题考什么、它的答案解释是什么，100字以内，不要重新生成。');
      check('resource is readable in follow-up without regenerating', b.turn.tools.some(t => t.tool === 'read_learning_resource') && !b.turn.tools.some(t => t.tool === 'generate_learning_resource'));
    });
    await task('05-learning-team', async sid => {
      const a = await ask(sid, '请调用research_topic_team，研究知识库中MCP与A2A的用途区别以及怎样组合，max_depth=2,max_nodes=4,max_concurrency=2，web=false。每个节点回答150字以内即可，最后给我一个学习建议。');
      check('real multi-agent tree completes', a.events.some(e => e.type === 'team/run_completed') && a.events.filter(e => e.type === 'team/node_completed').length >= 2);
      check('cooperation process can reopen after completion', await page.locator('.team-open-btn').count() > 0);
      await page.locator('.team-open-btn').last().click(); await page.waitForSelector('#team-panel.open');
      await page.locator('.team-node').last().click(); check('clicking a real team node keeps its process visible', await page.evaluate(() => window.LuminTeamPanel.isOpen()));
      await page.locator('#team-panel-close').click();
      await ask(sid, '根据刚才的协作结论，只用三句话概括MCP和A2A各解决什么问题，以及如何一起用。不要再发起协作。');
    });
    // Workspace must be outside app storage: the real permission layer protects it.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-release-work-'));
    const project = await post('projects/save', {name: '真实分支工作区', root: workspace});
    await task('06-files-and-branch', async sid => {
      const a = await ask(sid, '请在当前工作区创建check.md，内容为「BRANCH_BASE_091：输入2和3，输出5。」请真实调用write完成，然后简短确认。');
      check('workspace write reaches a real sandboxed file', fs.existsSync(path.join(workspace, 'check.md')) && fs.readFileSync(path.join(workspace, 'check.md'), 'utf8').includes('BRANCH_BASE_091'));
      const firstTurn = a.events.find(e => e.type === 'turn/start').turnId;
      await ask(sid, '记住这轮只属于原会话的标记 PARENT_ONLY_091。不要改文件，只原样回复这个标记。');
      const parentBefore = await events(sid);
      await open(sid);
      await page.locator('.turn-block').filter({has: page.locator('[aria-label="从这里开分支"]')}).first().locator('[aria-label="从这里开分支"]').click();
      await until(() => page.evaluate(parent => !!state.chatSessionId && state.chatSessionId !== parent, sid), 'UI branch opens', 15000);
      const branchId = await page.evaluate(() => state.chatSessionId);
      activeTask.branchId = branchId;
      const inherited = await events(branchId);
      check('earlier branch includes selected turn but excludes later parent turn', inherited.some(e => e.type === 'turn/start' && e.turnId === firstTurn) && !JSON.stringify(inherited).includes('PARENT_ONLY_091'));
      const b = await ask(branchId, '当前是新分支。请读取工作区check.md并用calc算2+3，给出文件里的标记和计算结果，别修改文件。');
      check('branched tool context supports a real model follow-up', b.turn.tools.some(t => t.tool === 'read') && b.turn.tools.some(t => t.tool === 'calc') && /BRANCH_BASE_091/.test(b.turn.answer));
      check('branch continuation does not mutate original conversation', JSON.stringify(await events(sid)) === JSON.stringify(parentBefore));
    }, project.id);

    result.completedAt = new Date().toISOString();
    result.ok = result.tasks.length === (process.env.REAL_TASK_ONLY ? 1 : 6) && result.tasks.every(t => t.status === 'passed') && !result.errors.length;
    result.tokens = result.tasks.flatMap(t => t.turns).reduce((sum,t) => ({in: sum.in + Number(t.tokens?.in || 0), out: sum.out + Number(t.tokens?.out || 0)}), {in: 0, out: 0});
    console.log('REAL_TASKS=' + (result.ok ? 'PASS' : 'FAILED') + ' tasks=' + result.tasks.filter(t => t.status === 'passed').length + '/6 thinkingVisible=' + result.thinkingVisible + ' report=' + out);
    if (!result.ok) process.exitCode = 1;
  } finally {
    if (db) db.close();
    if (browser) await browser.close();
    if (core) { core.kill(); await pause(400); }
    for (const folder of [dir, cred]) for (const suffix of ['', '-wal', '-shm']) {
      const file = path.join(folder, 'itn.db') + suffix;
      if (fs.existsSync(file)) fs.writeFileSync(file, '');
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  }
})().catch(error => {console.error('REAL_TASK_ERROR ' + clean(error.message)); process.exitCode = 1;});
