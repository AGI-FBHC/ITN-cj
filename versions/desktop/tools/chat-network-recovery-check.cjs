/** Real renderer + native Edge clicks; all HTTP/events live in memory.
 * No kernel, database, credentials or model tokens. Override RECOVERY_UI_DIR to
 * prove the checks fail against an older renderer. Does not verify provider replay.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(require.resolve('playwright', {paths: [
  process.env.ITN_PLAYWRIGHT_DIR && path.dirname(process.env.ITN_PLAYWRIGHT_DIR),
  path.resolve(__dirname, '..'), 'D:/Desktop/ITN/ITN/src/frontend/agent-demo',
].filter(Boolean)}));
const ui = path.resolve(process.env.RECOVERY_UI_DIR || path.join(__dirname, '../shell/renderer'));
const original = '请完成原始完整任务：检索资料并生成分析报告。ORIGINAL_TASK_947';
const tail = '正文末尾_继续锚点_947';
const partial = '这是已经完成的分析。'.repeat(400).slice(0, 3134-tail.length) + tail;
const network = '模型连接中断：SocketException error code 10054 Connection reset by peer';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function events({message = network, answer = partial, tool = true, end = true, turnId = 't1'} = {}) {
  const e = (type, payload) => ({type, payload, turnId, at: new Date().toISOString()});
  return [e('turn/start', {kind:'ask'}), e('user/message', {text:original}),
    ...(tool ? [e('tool/call', {callId:'c1', tool:'read', args:{path:'fixture.md'}}),
      e('tool/result', {callId:'c1', tool:'read', ok:true, summary:'已完成的工具结果_947'})] : []),
    ...(answer ? [e('assistant/delta', {text:answer})] : []),
    ...(end ? [e('turn/end', {ok:false, message})] : [])];
}
async function fixture(browser, history = events()) {
  const page = await browser.newPage({viewport:{width:1280, height:960}});
  page.setDefaultTimeout(8000);
  const f = {page, sessions:{s1:history, s2:events()}, asks:[], cancels:[], errors:[], paths:[], gates:[]};
  page.on('pageerror', e => f.errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'recovery.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      const body = route.request().postDataJSON() || {};
      f.paths.push(url.pathname);
      let data = {};
      if (url.pathname === '/api/settings') data = {models:[{id:'fixture', name:'Fixture', model:'fixture'}], chatModelId:'fixture', knowledgeBases:[]};
      if (url.pathname === '/api/projects/list') data = {projects:[]};
      if (url.pathname === '/api/skills/list') data = {skills:[], bound:''};
      if (url.pathname === '/api/sessions/list') data = {sessions:Object.keys(f.sessions).map(sessionId => ({sessionId, title:'Fixture '+sessionId, projectId:''}))};
      if (url.pathname === '/api/sessions/state') data = {status:'idle'};
      if (url.pathname === '/api/agent/approvals') data = {requests:[]};
      if (url.pathname === '/api/sessions/events') {
        const all = f.sessions[body.sessionId] || [];
        data = {events:all.slice(body.sinceId || 0), lastId:all.length};
      }
      if (url.pathname === '/api/agent/ask-pi') {
        const gate = deferred(); f.gates.push(gate);
        const turnId = 'request-' + (f.asks.length+1);
        const ask = {body, gate, turnId}; f.asks.push(ask);
        f.sessions[body.sessionId].push(
          {turnId, type:'turn/start', payload:{kind:'ask'}},
          {turnId, type:'user/message', payload:{text:body.question, attachments:body.attachments}});
        if (f.streamNext) {
          f.streamNext = false;
          f.sessions[body.sessionId].push(...events({turnId, end:false}).slice(2));
        }
        await gate.promise;
        data = {ok:true};
      }
      if (url.pathname === '/api/agent/cancel') {
        f.cancels.push(body);
        const ask = f.asks.findLast(x => x.body.sessionId === body.sessionId);
        f.sessions[body.sessionId].push({turnId:ask.turnId, type:'turn/end', payload:{ok:false, message:'已取消'}});
        ask.gate.resolve();
      }
      return route.fulfill({json:{code:0, data}});
    }
    const file = path.join(ui, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
    if (!fs.existsSync(file)) return route.fulfill({status:404, body:''});
    const raw = fs.readFileSync(file);
    return route.fulfill({body:url.pathname === '/' ? raw.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') : raw,
      contentType:url.pathname === '/' ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'});
  });
  await page.goto('http://recovery.test/');
  await page.addStyleTag({path:path.join(ui, 'style.css')});
  await page.addScriptTag({path:path.join(ui, 'app.js')});
  await page.addScriptTag({path:path.join(ui, 'workbench.js')});
  await page.evaluate(async () => {
    document.getElementById('boot')?.remove();
    current='chat'; currentSection=''; state.chatSessionId='s1';
    await PAGES.chat.render(); refreshChatHeader();
  });
  f.button = label => page.getByRole('button', {name:label, exact:true});
  f.switch = sid => page.evaluate(async id => { await openChatSession(id); }, sid);
  f.burst = async button => {
    await button.scrollIntoViewIfNeeded();
    const b = await button.boundingBox(); assert(b);
    for (let i=0;i<5;i++) await page.mouse.click(b.x+b.width/2, b.y+b.height/2);
  };
  f.roundtrip = () => page.evaluate(() => api('/api/prefs/get', {}));
  f.waitAsks = n => page.waitForFunction(n => state.chatRequests.size === n, n);
  f.close = async () => { for (const gate of f.gates) gate.resolve(); await page.close(); };
  return f;
}
async function main() {
  const browser = await chromium.launch({channel:'msedge', headless:true, args:['--no-proxy-server']});
  let passed=0;
  async function test(name, history, fn) {
    const f = await fixture(browser, history);
    try { await fn(f); assert.deepEqual(f.errors, []); console.log('PASS '+name); passed++; }
    finally { await f.close(); }
  }
  try {
    await test('history recovery: real clicks, retained answer/tools, no original replay, duplicate guard and concurrent sessions', events(), async f => {
      const {page} = f;
      assert.equal(await page.evaluate(() => typeof state.chatResend), 'undefined', 'history must work before any send');
      assert((await page.locator('#chat-thread').innerText()).includes(partial));
      const button = f.button('继续回答');
      assert.equal(await button.count(), 1, 'network history needs a recovery entry immediately');
      assert.equal(await page.locator('.err-text').textContent(), '模型连接中断，已保留当前结果。');
      await page.getByText('错误详情', {exact:true}).click();
      assert((await page.locator('details[open]').allTextContents()).join('').includes('10054'));
      await f.burst(button); await f.waitAsks(1); await f.roundtrip();
      assert.equal(f.asks.length, 1);
      const q = f.asks[0].body;
      assert.equal(q.sessionId, 's1'); assert.equal(q.mode, 'chat');
      assert(!q.question.includes(original)); assert(!q.question.includes('ORIGINAL_TASK_947'));
      assert.match(q.question, /本会话.*工具结果/); assert.match(q.question, /末尾.*继续/);
      assert.match(q.question, /不要.*重新.*工具/); assert(q.question.includes('正文末尾_继续锚点_947'));
      assert(q.question.length < 900); assert.deepEqual(q.attachments, []);
      assert((await page.locator('#chat-thread').innerText()).includes(partial));
      await f.switch('s1');
      assert.equal(await f.button('继续回答').count(), 0, 'older failure must lose its action while the next turn runs');
      await f.roundtrip(); assert.equal(f.asks.length, 1);
      await f.switch('s2'); assert.equal(await f.button('继续回答').isDisabled(), false);
      await f.button('继续回答').click(); await f.waitAsks(2); assert.equal(f.asks.length, 2);
      f.asks[0].gate.resolve();
      await page.waitForFunction(() => !state.chatRequests.has('s1'));
      assert.equal(await page.evaluate(() => state.chatSessionId), 's2');
      f.asks[1].gate.resolve(); await f.waitAsks(0);
      await f.switch('s1');
      assert.equal(await page.evaluate(() => state.chatTurns[0].items.filter(i=>i.t==='tool' && i.ok).length), 1);
      assert(!f.paths.some(p => /\/tools?\//.test(p)), 'UI must never invoke a tool endpoint');
    });
    await test('draft text, attachment and inline edits are protected', events(), async f => {
      await f.page.fill('#chat-input', '尚未发出的新草稿');
      await f.button('继续回答').click(); await f.roundtrip();
      assert.equal(f.asks.length, 0); assert.equal(await f.page.inputValue('#chat-input'), '尚未发出的新草稿');
      await f.page.fill('#chat-input', '');
      await f.page.evaluate(() => addChatAttachments([{kind:'file', name:'draft.md', path:'draft.md'}]));
      await f.button('继续回答').click(); await f.roundtrip(); assert.equal(f.asks.length, 0);
      assert.equal(await f.page.evaluate(() => chatAttachments().length), 1);
      await f.page.evaluate(() => { delete state.attachmentDrafts[attachmentKey()]; state.paintAttachments(); });
      await f.page.getByRole('button', {name:'改这条重发', exact:true}).click();
      await f.page.locator('.bubble-edit').fill('编辑中的问题');
      await f.button('继续回答').click(); await f.roundtrip(); assert.equal(f.asks.length, 0);
      assert.equal(await f.page.locator('.bubble-edit').inputValue(), '编辑中的问题');
    });
    await test('empty network turn retries original question once', events({answer:'', tool:false}), async f => {
      assert.equal(await f.button('继续回答').count(), 0);
      await f.burst(f.button('重试')); await f.waitAsks(1); await f.roundtrip();
      assert.equal(f.asks.length, 1); assert.equal(f.asks[0].body.question, original);
    });
    await test('completed tools alone allow continuation', events({answer:''}), async f => {
      await f.button('继续回答').click(); await f.waitAsks(1);
      assert(!f.asks[0].body.question.includes(original));
      assert.match(f.asks[0].body.question, /工具结果/);
    });
    for (const message of ['已取消（10054）', 'AbortError: request aborted', 'HTTP 400 invalid parameter: 模型连接中断', 'HTTP 429 rate limit: 模型连接中断', '参数错误：模型连接中断']) {
      await test('no network recovery for '+message, events({message}), async f => {
        assert.equal(await f.button('继续回答').count(), 0); assert.equal(await f.button('重试').count(), 0);
        if (message.startsWith('已取消')) assert.equal(await f.button('重新问一次').count(), 1);
      });
    }
    await test('only latest turn recovers; raw legacy English reset recognized', [...events(), ...events({turnId:'t2', message:'Connection reset by peer (10054)'})], async f => {
      assert.equal(await f.button('继续回答').count(), 1);
      assert.equal(await f.page.locator('.turn-block').first().getByRole('button', {name:'继续回答', exact:true}).count(), 0);
    });
    await test('real send/poll: retry audit, partial stream, disconnect, continuation and cancellation', [], async f => {
      f.streamNext = true;
      await f.page.fill('#chat-input', original); await f.page.locator('.composer-send').click();
      await f.waitAsks(1);
      await f.page.waitForFunction(text => document.getElementById('chat-thread').innerText.includes(text), partial);
      const turnId = f.asks[0].turnId;
      const audit = (reason, attempt) => ({turnId, type:'model/retry', payload:{reason, attempt, maxAttempts:3, delayMs:1000}});
      f.sessions.s1.push(audit('network_retry', 2));
      await f.page.getByText(/网络.*重连.*2\/3/).waitFor();
      f.sessions.s1.push(audit('network_retry', 3));
      await f.page.getByText(/网络.*重连.*3\/3/).waitFor();
      f.sessions.s1.push(audit('truncated_tool_args', 2));
      await f.page.getByText('输出太长，正在重新生成完整参数…', {exact:false}).waitFor();
      f.sessions.s1.push({turnId, type:'turn/end', payload:{ok:false, message:network}});
      f.asks[0].gate.resolve(); await f.waitAsks(0);
      await f.button('继续回答').click(); await f.waitAsks(1); assert.equal(f.asks.length, 2);
      assert(!f.asks[1].body.question.includes(original));
      assert((await f.page.locator('#chat-thread').innerText()).includes(partial));
      // A real stop click must still reach the ordinary cancel endpoint.
      await f.page.locator('.composer-send').click();
      await f.waitAsks(0); assert.equal(f.cancels.length, 1); assert.equal(f.cancels[0].sessionId, 's1');
      await f.button('重新问一次').waitFor({state:'visible'});
      assert.equal(await f.button('继续回答').count(), 0);
      assert.equal(await f.button('重新问一次').count(), 1);
      assert.equal(f.asks.length, 2);
    });
    console.log('RESULT '+passed+' passed; fixture HTTP only; provider/database behavior outside coverage');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e.stack); process.exitCode=1; });
