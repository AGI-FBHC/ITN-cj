/**
 * Real Edge + unmodified renderer with controlled incremental /sessions/events.
 * All HTTP is intercepted; no kernel, user database or remote model is used.
 * Native clicks drive send/stop/disclosures. Poll cursors, held ask responses and
 * a fresh browser document drive streaming, errors, cancellation and history.
 *
 * Run: node tools/thinking-stream-check.cjs
 * ITN_UI_DIR=<renderer directory> tests a packaged/older UI (0.8.43 must fail).
 * THINKING_UI_REF=<git ref> substitutes that ref's app.js/style.css/index.html.
 * THINKING_FILTER=<substring> runs selected scenarios. Artifacts/report go to a
 * temporary directory, or THINKING_ARTIFACT_DIR. This covers rendering contracts,
 * not provider reasoning availability, UTF-8 transport decoding or persistence.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {chromium} = require(require.resolve('playwright', {paths: [
  process.env.ITN_PLAYWRIGHT_DIR,
  process.env.ITN_PLAYWRIGHT_DIR && path.dirname(process.env.ITN_PLAYWRIGHT_DIR),
  path.resolve(__dirname, '..'),
  'D:/Desktop/ITN/ITN/src/frontend/agent-demo',
].filter(Boolean)}));

const root = path.resolve(__dirname, '..');
const ui = path.resolve(process.env.ITN_UI_DIR || path.join(root, 'shell/renderer'));
const output = process.env.THINKING_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'itn-thinking-stream-'));
fs.mkdirSync(output, {recursive: true});
const assets = new Map();
for (const name of fs.readdirSync(ui)) {
  if (fs.statSync(path.join(ui, name)).isFile()) assets.set(name, fs.readFileSync(path.join(ui, name)));
}
if (process.env.THINKING_UI_REF) {
  for (const name of ['app.js', 'style.css', 'index.html']) {
    assets.set(name, execFileSync('git', ['show', process.env.THINKING_UI_REF + ':shell/renderer/' + name], {cwd: root, maxBuffer: 12 * 1024 * 1024}));
  }
}
const signature = createHash('sha256').update(assets.get('app.js')).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
async function until(fn, name, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(30); }
  throw Error('Timed out: ' + name);
}

async function fixture(browser, options = {}) {
  const context = await browser.newContext({viewport: options.viewport || {width: 1440, height: 960}, reducedMotion: 'reduce'});
  const page = await context.newPage();
  const f = {context, page, events: [], asks: [], cancels: [], polls: [], errors: [], gates: [], closed: false};
  const turnId = 'thinking-turn';
  const settings = {models: [{id: 'fixture', name: '思考测试模型', model: 'fixture'}], chatModelId: 'fixture', knowledgeBases: []};
  const append = (type, payload = {}) => {
    const event = {id: f.events.length + 1, type, turnId, at: new Date().toISOString(), payload};
    f.events.push(event); return event.id;
  };
  page.on('pageerror', e => f.errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'thinking-stream.test') return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/api/')) {
      const body = route.request().postDataJSON() || {};
      let data = {};
      switch (url.pathname) {
        case '/api/settings': data = settings; break;
        case '/api/projects/list': data = {projects: []}; break;
        case '/api/skills/list': data = {skills: [], bound: ''}; break;
        case '/api/agent/approvals': data = {requests: []}; break;
        case '/api/web/cache': data = {mode: 'auto'}; break;
        case '/api/sessions/state': data = {status: 'idle'}; break;
        case '/api/sessions/list': data = {sessions: [{sessionId: 'thinking-session', title: '思考流定向测试', projectId: ''}]}; break;
        case '/api/agent/reasoning':
          data = {modelId: 'fixture', profile: 'auto', mode: 'default', effectiveMode: 'default', options: [{id: 'default', label: '接口默认'}]}; break;
        case '/api/sessions/events': {
          const since = Number(body.sinceId || 0);
          const events = f.events.filter(event => event.id > since);
          f.polls.push({since, lastId: f.events.length, count: events.length});
          data = {events, lastId: f.events.length}; break;
        }
        case '/api/agent/ask-pi': {
          const gate = deferred(); f.gates.push(gate); f.asks.push({body, gate});
          append('turn/start', {kind: 'ask'}); append('user/message', {text: body.question});
          const result = await gate.promise;
          if (f.closed) return;
          if (result === 'transport') return route.abort('connectionreset');
          if (result === 'http') return route.fulfill({status: 500, json: {code: 500, message: '受控接口失败'}});
          data = result || {ok: true}; break;
        }
        case '/api/agent/cancel':
          f.cancels.push(body); append('turn/end', {ok: false, message: '已取消'});
          f.asks.at(-1)?.gate.resolve({ok: false, message: '已取消'}); data = {ok: true}; break;
      }
      return route.fulfill({json: {code: 0, data}});
    }
    const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const body = assets.get(name);
    if (!body) return route.fulfill({status: 404, body: ''});
    const ext = path.extname(name);
    const types = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png'};
    return route.fulfill({body: name === 'index.html' ? body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') : body,
      contentType: types[ext] || 'application/octet-stream'});
  });
  f.bootstrap = async reload => {
    if (reload) await page.reload(); else await page.goto('http://thinking-stream.test/');
    await page.addScriptTag({content: assets.get('app.js').toString()});
    await page.addScriptTag({content: assets.get('workbench.js').toString()});
    await page.evaluate(async cfg => {
      document.getElementById('boot')?.remove();
      state.cfg = cfg; state.chatSessionId = 'thinking-session';
      current = 'chat'; currentSection = '';
      document.getElementById('view').className = 'view';
      await PAGES.chat.render(); refreshChatHeader();
    }, settings);
    await page.locator('#chat-input').waitFor({state: 'visible'});
  };
  f.send = async () => {
    await page.locator('#chat-input').fill('请先思考，再检索学习资料，最后回答。');
    await page.getByRole('button', {name: '发送', exact: true}).click();
    await until(() => f.asks.length === 1, 'held ask response');
  };
  // Wait for the actual incremental polling path to consume a specified batch;
  // do not invoke turnsFromEvents/paint or directly mutate the renderer's events.
  f.deliver = async batch => {
    for (const [type, payload] of batch) append(type, payload);
    const last = f.events.length;
    await until(() => page.evaluate(id => state.lastEventId >= id, last), 'poll cursor ' + last);
  };
  f.delta = async (text, segmentId = 'segment-1', ms = 1200) => {
    const payload = {text, ms}; if (segmentId) payload.segmentId = segmentId;
    await f.deliver([['assistant/thinking_delta', payload]]);
  };
  f.final = async (text, segmentId = 'segment-1', ms = 3200) => {
    const payload = {text, ms}; if (segmentId) payload.segmentId = segmentId;
    await f.deliver([['assistant/thinking', payload]]);
  };
  f.row = index => page.locator('.think-row').nth(index || 0);
  f.text = index => f.row(index).locator('.think-text');
  f.visibleText = async (text, index = 0) => {
    await until(async () => await f.text(index).count() === 1 && await f.text(index).isVisible(), 'visible live thinking', 2500);
    assert.equal(await f.text(index).textContent(), text, 'displayed thinking must match complete delivered Unicode');
  };
  f.finished = async () => {
    await until(() => page.evaluate(() => !state.busyTurn), 'generation finished');
    await page.getByRole('button', {name: '发送', exact: true}).waitFor({state: 'visible'});
    assert.equal(await page.locator('.composer-send.stop, .stream-line, .tool-card.running').count(), 0, 'no active generation decorations after termination');
    assert.doesNotMatch(await page.locator('#chat-thread').textContent(), /正在思考|进行中/, 'no stale thinking/working status after termination');
  };
  f.end = async (ok = true, message = '') => {
    append('turn/end', {ok, message}); f.asks.at(-1)?.gate.resolve({ok, message});
    await f.finished();
  };
  f.snapshot = name => page.screenshot({path: path.join(output, name + '.png')});
  f.close = async () => {
    f.closed = true; for (const gate of f.gates) gate.resolve({ok: false});
    await context.close();
  };
  await f.bootstrap(false);
  return f;
}

async function rememberReading(f) {
  return f.page.evaluate(() => {
    const text = document.querySelector('.think-text');
    const textNode = text.firstChild;
    const range = document.createRange(); range.setStart(textNode, 3); range.setEnd(textNode, 16);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    // Scroll the real user scroll containers; do not alter product CSS.
    const scrollers = [];
    for (let node = text; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2) {
        node.scrollTop = Math.min(180, node.scrollHeight - node.clientHeight);
        scrollers.push({node, top: node.scrollTop});
      }
    }
    window.__reading = {text, textNode, selection: selection.toString(), scrollers};
    return {selection: selection.toString(), scrollers: scrollers.map(x => x.top)};
  });
}
async function assertReading(f, label) {
  const result = await f.page.evaluate(() => {
    const r = window.__reading;
    return {sameElement: r.text === document.querySelector('.think-text') && r.text.isConnected,
      selection: getSelection().toString(), expected: r.selection,
      scrolls: r.scrollers.map(x => ({before: x.top, after: x.node.scrollTop}))};
  });
  assert.equal(result.selection, result.expected, label + ': selected Chinese text must remain selected');
  assert.equal(result.sameElement, true, label + ': the thinking content being read must stay mounted');
  assert.ok(result.scrolls.every(x => Math.abs(x.before - x.after) <= 1), label + ': reading scroll must remain stable ' + JSON.stringify(result.scrolls));
}

async function main() {
  console.log('SCOPE: real Edge renderer; intercepted HTTP and controlled event deltas. No user DB, kernel or paid models.');
  console.log('UI=' + ui + '; REF=' + (process.env.THINKING_UI_REF || 'working files') + '; APP_SHA256=' + signature);
  const browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
  const results = [];
  const scenario = async (name, run, options) => {
    if (process.env.THINKING_FILTER && !name.includes(process.env.THINKING_FILTER)) return;
    let f;
    const started = Date.now();
    try {
      f = await fixture(browser, options); await run(f);
      assert.deepEqual(f.errors, [], 'uncaught renderer exceptions');
      results.push({name, ok: true, ms: Date.now() - started, polls: f.polls});
      console.log('PASS ' + name);
    } catch (error) {
      const file = 'failure-' + (results.length + 1);
      if (f) await f.snapshot(file).catch(() => {});
      const dom = f ? await f.page.locator('#chat-thread').textContent().catch(() => '') : '';
      results.push({name, ok: false, error: error.message, stack: error.stack, screenshot: file + '.png', ms: Date.now() - started,
        events: f?.events, polls: f?.polls, errors: f?.errors, dom});
      console.error('FAIL ' + name + ': ' + error.message);
    } finally { if (f) await f.close(); }
  };
  try {
    await scenario('live deltas are visible before answer; final replaces without duplication', async f => {
      await f.send();
      let text = '';
      for (const chunk of ['先分析学习目标。', '\n比较 RAG 与 Agent。', '仓颉🦖，中文与标点都应保留。', '\n再核对资料范围。']) {
        text += chunk; await f.delta(chunk); await f.visibleText(text);
        assert.equal(await f.page.locator('.think-row').count(), 1, 'one disclosure for all deltas of one segment');
        assert.equal(await f.page.locator('.msg-ai .md').count(), 0, 'thinking must be available before any answer (a waiting-status row is allowed)');
      }
      await f.final(text + '（核对完成）');
      assert.equal(await f.page.locator('.think-row').count(), 1, 'final must update the existing segment rather than duplicate it');
      assert.equal(await f.text().textContent(), text + '（核对完成）', 'final is authoritative, not appended to deltas');
      await f.deliver([['assistant/delta', {text: '最终回答：可先建立知识库。'}]]);
      assert.equal(await f.page.locator('.msg-ai').textContent(), '最终回答：可先建立知识库。');
      await f.end();
    });

    await scenario('legacy deltas without segmentId still form a single thinking segment', async f => {
      await f.send(); await f.delta('旧事件协议，', ''); await f.visibleText('旧事件协议，');
      await f.delta('继续思考。', ''); await f.visibleText('旧事件协议，继续思考。');
      await f.final('旧事件协议，继续思考。', '');
      assert.equal(await f.page.locator('.think-row').count(), 1, 'no duplicate final for optional segmentId');
      await f.end();
    });

    await scenario('thinking before and after a tool remains separate and ordered', async f => {
      await f.send(); await f.delta('先确定检索问题。', 'before-tool'); await f.visibleText('先确定检索问题。');
      await f.final('先确定检索问题。', 'before-tool');
      await f.deliver([['tool/call', {callId: 'search-1', tool: 'kb_search', args: {query: 'Agent 工具调用'}}]]);
      await f.deliver([['tool/result', {callId: 'search-1', tool: 'kb_search', ok: true, summary: '找到两篇资料'}]]);
      await f.delta('结合工具结果继续推理。', 'after-tool'); await f.visibleText('结合工具结果继续推理。', 1);
      const blocks = await f.page.locator('.work-body').evaluate(body => [...body.children].map(node => ({
        kind: node.matches('.think-row') ? 'thinking' : 'tool', text: node.textContent,
      })));
      assert.deepEqual(blocks.map(x => x.kind), ['thinking', 'tool', 'thinking']);
      assert.match(blocks[0].text, /先确定检索问题/); assert.match(blocks[1].text, /找到两篇资料/);
      assert.match(blocks[2].text, /结合工具结果继续推理/);
      assert.doesNotMatch(await f.row(0).locator('summary').textContent(), /正在思考/, 'completed first segment is no longer live');
      await f.final('结合工具结果继续推理。', 'after-tool');
      assert.equal(await f.page.locator('.think-row').count(), 2);
      await f.end();
    });

    await scenario('manual collapse and reopen survive subsequent streaming deltas', async f => {
      await f.send(); let text = '这是一段可以自行收起的实时思考。';
      await f.delta(text); await f.visibleText(text);
      await f.row().locator('summary').click();
      await until(() => f.row().evaluate(node => !node.open), 'manual collapse');
      for (const chunk of ['补充一。', '补充二。']) {
        text += chunk; await f.delta(chunk);
        assert.equal(await f.row().evaluate(node => node.open), false, 'new deltas must not undo manual collapse');
        assert.equal(await f.text().isVisible(), false);
      }
      await f.row().locator('summary').click();
      await until(() => f.row().evaluate(node => node.open), 'manual expansion');
      text += '展开后仍可继续读。'; await f.delta('展开后仍可继续读。'); await f.visibleText(text);
      await f.final(text);
      assert.equal(await f.row().evaluate(node => node.open), true, 'final must preserve explicit expansion');
      await f.end();
    });

    await scenario('long Chinese stream preserves selected text and reading scroll', async f => {
      await f.send();
      const text = Array.from({length: 100}, (_, i) => `第${i + 1}条：仓颉知识网络需要保留完整中文、标点与🦖，先分析再检索。`).join('\n');
      await f.delta(text); await f.visibleText(text);
      const reading = await rememberReading(f);
      assert.ok(reading.selection.length > 0 && reading.scrollers.some(n => n > 0), 'exercise a real selected, scrolled thinking passage');
      const tail = '\n末尾增量：中文不会丢失，emoji 🧠 也不会损坏。';
      await f.delta(tail); await assertReading(f, 'delta append');
      assert.equal(await f.text().textContent(), text + tail);
      assert.doesNotMatch(await f.text().textContent(), /\uFFFD/);
      await f.end();
    });

    await scenario('final thinking event preserves the passage and selection being read', async f => {
      await f.send();
      const text = '正在阅读的中文思考内容需要在最后一次确认到达后保持选区，不应该突然消失。';
      await f.delta(text); await f.visibleText(text); await rememberReading(f);
      await f.final(text + '最终补全。');
      await assertReading(f, 'final thinking event');
      assert.equal(await f.text().textContent(), text + '最终补全。');
      await f.end();
    });

    await scenario('an explicitly opened thinking passage stays readable while the answer starts', async f => {
      await f.send();
      const text = '用户正在核对这段中文思考，开始生成正文时仍应能够继续阅读和复制这里的文字。';
      await f.delta(text); await f.visibleText(text); await f.final(text);
      if (!(await f.row().evaluate(node => node.open))) await f.row().locator('summary').click();
      await f.visibleText(text); await rememberReading(f);
      await f.deliver([['assistant/delta', {text: '根据刚才的分析，'}]]);
      await assertReading(f, 'answer start');
      await f.visibleText(text);
      await f.deliver([['assistant/delta', {text: '推荐先建立知识库。'}]]);
      await assertReading(f, 'answer continuation');
      await f.end();
    });

    await scenario('stop during thinking retains content and clears active output state', async f => {
      await f.send(); const text = '停止前已经收到的思考内容应保留。';
      await f.delta(text); await f.visibleText(text);
      await f.page.getByRole('button', {name: '停止', exact: true}).click();
      await until(() => f.cancels.length === 1, 'cancel request'); await f.finished();
      assert.equal(await f.text().textContent(), text);
      assert.equal(f.cancels[0].sessionId, 'thinking-session');
      assert.match(await f.page.locator('#chat-thread').textContent(), /取消/);
    });

    await scenario('failed turn retains partial thinking and clears streaming state', async f => {
      await f.send(); const text = '接口失败前已收到的思考。';
      await f.delta(text); await f.visibleText(text); await f.end(false, '模型接口返回 500：受控错误');
      assert.equal(await f.text().textContent(), text);
      assert.match(await f.page.locator('#chat-thread').textContent(), /受控错误/);
    });

    await scenario('transport failure without terminal event leaves no live thinking UI', async f => {
      await f.send(); const text = '响应连接中断前的思考仍然可读。';
      await f.delta(text); await f.visibleText(text);
      f.asks[0].gate.resolve('transport'); await f.finished();
      assert.equal(await f.text().textContent(), text);
    });

    await scenario('reload restores expandable historical thinking without duplicate finals', async f => {
      await f.send(); const text = '历史里的思考应该能够再次展开阅读。';
      await f.delta(text); await f.visibleText(text); await f.final(text); await f.end();
      await f.bootstrap(true);
      assert.equal(await f.page.locator('.think-row').count(), 1);
      const group = f.page.locator('.work-group');
      if (!(await group.evaluate(node => node.open))) await group.locator(':scope > summary').click();
      if (!(await f.row().evaluate(node => node.open))) await f.row().locator('summary').click();
      await f.visibleText(text);
      assert.doesNotMatch(await f.row().locator('summary').textContent(), /正在思考/);
      assert.ok(f.polls.filter(p => p.since === 0 && p.count > 0).length >= 2, 'history was fetched again in a fresh document');
    });

    for (const theme of ['light', 'dark']) {
      await scenario(theme + ' thinking remains readable and clickable at narrow desktop width', async f => {
        await f.page.evaluate(value => applyTheme(value), theme);
        await f.send(); const text = '实时思考：先确定学习目标，再检索已有资料。\n' + '知识库与 Agent 协同。'.repeat(18);
        await f.delta(text); await f.visibleText(text);
        const geometry = await f.text().evaluate(node => {
          const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
          const row = node.closest('.think-row'), head = row.querySelector('summary'), box = head.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return {left: rect.left, right: rect.right, width: innerWidth, ownOverflow: node.scrollWidth > node.clientWidth + 1,
            hit: hit === head || head.contains(hit), color: style.color, background: style.backgroundColor,
            font: parseFloat(style.fontSize), pageOverflow: document.documentElement.scrollWidth > innerWidth + 1};
        });
        assert.ok(geometry.left >= -1 && geometry.right <= geometry.width + 1, 'thinking passage within viewport: ' + JSON.stringify(geometry));
        assert.equal(geometry.ownOverflow || geometry.pageOverflow, false, 'Chinese thinking must wrap without horizontal page overflow');
        assert.ok(geometry.hit && geometry.font >= 12, 'visible disclosure has matching mouse hit area and readable text');
        assert.notEqual(geometry.color, geometry.background, 'thinking text is not painted in its background color');
        await f.snapshot('thinking-' + theme + '-narrow');
        await f.row().locator('summary').click(); assert.equal(await f.text().isVisible(), false);
        await f.row().locator('summary').click(); await f.visibleText(text);
        await f.end();
      }, {viewport: {width: 900, height: 820}});
    }

    await scenario('completed thinking turn exposes raw events and a cancellable user editor via real clicks', async f => {
      await f.send();
      const thinking = '先确认学习目标，再依据资料形成建议。';
      const answer = '建议先建立知识库，再围绕章节提问。';
      await f.delta(thinking); await f.visibleText(thinking); await f.final(thinking);
      await f.deliver([['assistant/delta', {text: '建议先建立知识库，'}]]);
      await f.deliver([['assistant/delta', {text: '再围绕章节提问。'}], ['assistant/message', {text: answer}]]);
      await f.end();

      const turn = f.page.locator('#chat-thread .turn-block[data-turn-id="thinking-turn"]');
      await turn.waitFor({state: 'visible'});
      const rawButton = turn.getByRole('button', {name: '看这一轮的内部事件（原始 JSON）', exact: true});
      await rawButton.click();
      const raw = turn.locator('.turn-raw');
      await raw.waitFor({state: 'visible', timeout: 2500});
      assert.deepEqual(JSON.parse(await raw.locator('.turn-raw-pre').textContent()), f.events,
        'raw events must appear inside the mounted turn and describe this completed turn');
      await rawButton.click();
      assert.equal(await turn.locator('.turn-raw').count(), 0, 'a second real click closes raw events');

      const user = turn.locator('.msg-user');
      const original = await user.locator('.msg-body').innerHTML();
      await user.getByRole('button', {name: '改这条重发', exact: true}).click();
      const editor = user.locator('.bubble-edit');
      await editor.waitFor({state: 'visible', timeout: 2500});
      assert.equal(await editor.inputValue(), f.asks[0].body.question, 'editing opens the original user message in the mounted turn');
      await editor.fill('尚未保存的编辑内容，不应发给模型。');
      await user.locator('.bubble-edit-actions').getByRole('button', {name: '取消', exact: true}).click();
      assert.equal(await user.locator('.bubble-edit').count(), 0, 'cancel removes the inline editor');
      assert.equal(await user.locator('.msg-body').innerHTML(), original, 'cancel restores the exact original user message');
      assert.equal(f.asks.length, 1, 'opening and cancelling an edit must not resend');
      assert.equal(await turn.locator('.msg-ai .md').textContent(), answer, 'the completed answer remains visible after cancellation');
    });
  } finally {
    await browser.close();
    const report = {ui, ref: process.env.THINKING_UI_REF || '', appSha256: signature,
      scope: 'real Edge; intercepted HTTP; no kernel, user DB or real provider',
      passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results};
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log('RESULT ' + report.passed + ' passed, ' + report.failed + ' failed; artifacts=' + output);
    if (!results.length || report.failed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
