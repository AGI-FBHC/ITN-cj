// Real renderer + real kernel, with a deliberately stalled local model/tool. No user data or credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-stop-check-'));
const out = path.join(root, 'tmp/stop-bug');
fs.mkdirSync(out, { recursive: true });
let core, browser, base, slowRequests = 0, disconnected = 0, modelCalls = 0, passed = 0;
let releaseResponse;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, condition) => { assert(condition, name); passed++; console.log('PASS ' + name); };
async function until(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(40); }
  throw new Error('condition did not become true');
}
function sse(res, delta, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
}
const service = http.createServer(async (req, res) => {
  if (req.url === '/slow') {
    slowRequests++;
    const timer = setTimeout(() => res.end('slow page'), 8000);
    res.on('close', () => { clearTimeout(timer); if (!res.writableEnded) disconnected++; });
    return;
  }
  let raw = ''; for await (const piece of req) raw += piece;
  const body = JSON.parse(raw);
  /* 会话命名器是另一次很小的请求（第一轮收尾之后内核会发一次，给会话起名）。
     它不该算进"这一轮有没有再发请求"里，所以单独回答、不计数。 */
  const allText = (body.messages || []).map((m) => String(m.content || '')).join('\n');
  if (allText.includes('只输出名字本身')) { sse(res, { content: '慢查询测试' }); return; }
  modelCalls++;
  const last = body.messages.at(-1);
  if (last.role === 'user' && String(last.content).includes('slow-web')) {
    sse(res, { tool_calls: [{ index: 0, id: 'slow-call-' + modelCalls, type: 'function',
      function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'http://127.0.0.1:' + service.address().port + '/slow' }) } }] }, 'tool_calls');
  } else sse(res, { content: '本轮已经完成。' });
});
async function api(route, body = {}) {
  const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (j.code) throw new Error(j.message); return j.data;
}
async function events(sid) { return (await api('/api/sessions/events', { sessionId: sid })).events; }
(async () => {
  await new Promise((r) => service.listen(0, '127.0.0.1', r));
  const portFile = path.join(dir, 'port');
  core = spawn(path.join(root, 'dist/core/itn-desktop-core.exe'), ['--data-dir=' + dir, '--port-file=' + portFile,
    '--ui-dir=' + path.join(root, 'shell/renderer')], { windowsHide: true, stdio: 'ignore', env: { ...process.env, cjHeapSize: '2GB' } });
  await until(() => fs.existsSync(portFile), 20000);
  base = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').trim();
  await api('/api/models/save', { id: 'local', name: 'local test', model: 'local', apiKey: 'fake-test-key', baseUrl: 'http://127.0.0.1:' + service.address().port + '/v1' });
  await api('/api/models/roles', { chatModelId: 'local', embedModelId: '', chunkModelId: '' });
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/#/chat'); await page.locator('#chat-input').waitFor();
  await page.waitForTimeout(300);
  await page.locator('#chat-input').fill('slow-web: read this page');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await until(() => slowRequests === 1);
  await page.getByText(/正在执行：读取网页/).waitFor();
  check('UI shows the actual active tool instead of generic thinking', (await page.locator('#chat-thread').innerText()).includes('正在执行：读取网页'));
  const activeSid = await page.evaluate(() => state.chatRequest.sessionId);
  const started = Date.now();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor({ timeout: 3000 });
  check('clicking Stop releases stalled tool and restores Send within 3s', Date.now() - started < 3000);
  await until(() => disconnected >= 1);
  const stopped = await events(activeSid);
  check('kernel persists cancelled terminal event', stopped.at(-1).type === 'turn/end' && stopped.at(-1).payload.ok === false);
  check('stopped turn starts no further model request', modelCalls === 1);
  for (let i = 0; i < 40 && await page.locator('#chat-thread .spinner').count() > 0; i++) await page.waitForTimeout(100);
  check('cancelled turn no longer displays a spinner', await page.locator('#chat-thread .spinner').count() === 0);
  check('cancelled empty turn has no fabricated answer or generate actions',
    !(await page.locator('#chat-thread').innerText()).includes('没有拿到可用的回答') &&
    await page.locator('#chat-thread').getByRole('button', { name: '做成讲义', exact: true }).count() === 0);
  await page.screenshot({ path: path.join(out, 'stopped-web-tool.png') });

  await page.locator('#chat-input').fill('slow-web: another page');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await until(() => slowRequests === 2);
  const runningSid = await page.evaluate(() => state.chatRequest.sessionId);
  const other = (await api('/api/sessions/new')).sessionId;
  await page.evaluate(async (sid) => { await openChatSession(sid); }, other);
  check('an idle session shows Send while another one keeps running',
    await page.getByRole('button', { name: '发送', exact: true }).count() === 1 &&
    await page.evaluate(() => state.busyTurn === false) &&
    await page.evaluate((sid) => isSessionRunning(sid), runningSid));
  await page.evaluate(async (sid) => { await openChatSession(sid); }, runningSid);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor({ timeout: 3000 });
  check('after switching sessions, Stop still cancels the actually running turn', (await events(runningSid)).at(-1).payload.ok === false);
  check('the newly selected empty session was not modified by the old response', (await events(other)).length === 0);

  const held = new Promise((r) => { releaseResponse = r; });
  await page.route('**/api/agent/ask-pi', async (route) => {
    const response = await route.fetch(); await held;
    try { await route.fulfill({ response }); } catch { /* the browser correctly aborted its completed request */ }
  });
  await page.locator('#chat-input').fill('fast-answer');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止', exact: true }).waitFor();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor({ timeout: 3000 });
  check('terminal events release busy UI even while the generation HTTP response is withheld', !(await page.evaluate(() => state.busyTurn)));
  releaseResponse(); await page.unroute('**/api/agent/ask-pi');
  const matching = await page.evaluate(() => {
    const ev = (type, payload) => ({ turnId: 't', type, at: new Date().toISOString(), payload });
    const t = turnsFromEvents([ev('tool/call', { tool: 'web_fetch', callId: 'a' }), ev('tool/call', { tool: 'web_fetch', callId: 'b' }),
      ev('tool/result', { tool: 'web_fetch', callId: 'a', summary: 'result A', ok: true })])[0];
    return t.items[0].summary === 'result A' && t.items[1].running;
  });
  check('parallel calls of the same tool match their own result ids', matching);
  const timeline=await page.evaluate(()=>{
    const events=[
      {type:'assistant/thinking',payload:{text:'思考一',ms:1000}},
      {type:'assistant/delta',payload:{text:'先检查文件。'}},
      {type:'tool/call',payload:{tool:'read',callId:'read-one',args:{path:'a'}}},
      {type:'tool/result',payload:{tool:'read',callId:'read-one',ok:true,summary:'检查完成'}},
      {type:'assistant/thinking',payload:{text:'思考二',ms:1000}},
      {type:'assistant/delta',payload:{text:'现在写入修改。'}},
      {type:'tool/call',payload:{tool:'write',callId:'write-one',args:{path:'a',content:'ok'}}},
      {type:'tool/result',payload:{tool:'write',callId:'write-one',ok:true,summary:'写入完成'}},
      {type:'assistant/message',payload:{text:'已经完成。'}},
      {type:'turn/end',payload:{ok:true}}
    ].map(e=>({...e,turnId:'timeline-check'}));
    const turn=turnsFromEvents(events)[0],node=renderTurnBlock(turn,false);
    return [...node.children].filter(n=>n.dataset.timelineKind).map(n=>({kind:n.dataset.timelineKind,text:n.textContent}));
  });
  check('phase text stays between the process blocks that produced it',timeline.map(n=>n.kind).join(',')==='process,text,process,text,process,text'&&timeline[1].text==='先检查文件。'&&timeline[3].text==='现在写入修改。'&&timeline[5].text==='已经完成。');
  check('no JavaScript errors', errors.length === 0);
  console.log('RESULT ' + passed + ' passed; isolated data=' + dir);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (releaseResponse) releaseResponse(); if (browser) await browser.close(); if (core) core.kill(); service.closeAllConnections(); service.close();
});
