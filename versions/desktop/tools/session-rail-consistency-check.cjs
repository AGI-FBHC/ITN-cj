/* Renderer race regression: real Edge + gated, loopback-only HTTP. No core,
 * database, credentials or model. Run: node tools/session-rail-consistency-check.cjs
 * Optional --app=absolute/app.js replays a saved renderer against the same tests.
 * Responses are released by the test, rather than relying on timing sleeps.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const appFile = process.argv.find(a => a.startsWith('--app='))?.slice(6) || path.join(root, 'shell/renderer/app.js');
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-rail-consistency-'));
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const summary = (sessionId, projectId = '', rowid = 1, lastAt = new Date().toISOString()) =>
  ({ sessionId, title: '会话 ' + sessionId, projectId, kind: projectId ? 'work' : 'ask', lastAt, createdAt: lastAt, eventCount: 0, rowid });
const projects = [{ id: 'p-a', name: '项目甲', root: 'C:/fixture/a' }, { id: 'p-b', name: '项目乙', root: 'C:/fixture/b' }];
const cases = [];
const test = (name, run) => cases.push({ name, run });

async function fixture() {
  const f = { sessions: [summary('old', '', 1, '2025-01-01T00:00:00Z')], calls: [], queue: new Map(), asks: new Map(), events: new Map(), failEventSessions: new Set(), nextId: 1 };
  f.hold = route => {
    const hit = deferred(), release = deferred();
    const gate = { hit: hit.promise, release: value => release.resolve(value), entered: hit, pending: release };
    if (!f.queue.has(route)) f.queue.set(route, []);
    f.queue.get(route).push(gate);
    return gate;
  };
  f.server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!pathname.startsWith('/api/') && pathname !== '/health') {
        const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
        const file = pathname === '/app.js' ? appFile : path.resolve(root, 'shell/renderer', relative);
        if (!file.startsWith(path.resolve(root, 'shell/renderer') + path.sep) && pathname !== '/app.js') { res.writeHead(403).end(); return; }
        if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(file)); return;
      }
      let raw = ''; for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      const call = { path: pathname, body, snapshot: clone(f.sessions) }; f.calls.push(call);
      const gate = f.queue.get(pathname)?.shift();
      if (gate) { gate.entered.resolve(call); const result = await gate.pending.promise; if (result?.disconnect) { res.destroy(); return; } if (result?.data) { reply(result.data); return; } }
      if (pathname === '/api/sessions/list' && f.failListReads) { res.destroy(); return; }
      let data = {};
      switch (pathname) {
        case '/health': data = { status: 'ok' }; break;
        case '/api/settings': data = { models: [{ id: 'fixture', model: 'fixture' }], chatModelId: 'fixture', knowledgeBases: [] }; break;
        case '/api/projects/list': data = { projects }; break;
        case '/api/sessions/list': data = { sessions: body.force ? clone(f.sessions) : call.snapshot }; break;
        case '/api/sessions/new': {
          const id = 'created-' + f.nextId++;
          const item = { ...summary(id, body.projectId || '', 100 + f.nextId), title: '新对话' };
          f.sessions.unshift(item); data = { sessionId: id, projectId: item.projectId, session: clone(item) }; break;
        }
        case '/api/sessions/events':
          if (!Object.hasOwn(body, 'sinceId') && f.failEventSessions.has(body.sessionId)) throw Error('deliberate old request failure');
          data = { events: f.events.get(body.sessionId) || [], lastId: 0 }; break;
        case '/api/agent/reasoning': data = { mode: 'default', effectiveMode: 'default', options: [{ id: 'default', label: '默认' }] }; break;
        case '/api/agent/approvals': data = { requests: [], pending: 0 }; break;
        case '/api/agent/ask-pi': {
          const request = deferred(); f.asks.set(body.sessionId, { ...request, body });
          data = await request.promise; break;
        }
        case '/api/sessions/title': data = { generated: false }; break;
        case '/api/skills/list': data = { skills: [] }; break;
        case '/api/tasks/list': data = { tasks: [] }; break;
      }
      reply(data);
      function reply(data) { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 0, data })); } }
    } catch (e) { if (!res.destroyed) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 1, message: e.message })); } }
  });
  await new Promise(r => f.server.listen(0, '127.0.0.1', r));
  f.base = 'http://127.0.0.1:' + f.server.address().port;
  f.close = async () => {
    for (const gates of f.queue.values()) for (const gate of gates) gate.release({ disconnect: true });
    for (const request of f.asks.values()) request.resolve({ ok: false, message: 'fixture closed' });
    f.server.closeAllConnections(); await new Promise(r => f.server.close(r));
  };
  return f;
}

async function rows(page) {
  return page.evaluate(() => {
    let group = ''; const result = [];
    for (const node of document.querySelector('#panel-body').children) {
      if (node.matches('.rail-group-head')) group = node.dataset.group;
      const item = node.querySelector('.panel-item[data-id]');
      if (item) result.push({ id: item.dataset.id, group, title: item.querySelector('.panel-item-label')?.textContent, busy: !!item.querySelector('.panel-item-spin') });
    }
    return result;
  });
}
async function idle(page) {
  await page.waitForFunction(() => !sessionsCache.promise && !busyActions.has('session:new') && !state.chatStarting);
}
async function oldRead(page, f, force = false) {
  const gate = f.hold('/api/sessions/list');
  await page.evaluate(force => { sessionsCache.at = 0; window.raceRead = loadSessions(force); }, force);
  await gate.hit;
  return gate;
}
async function send(page, f, text) {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-input').press('Enter');
  await page.waitForFunction(() => state.busyTurn);
  const sid = await page.evaluate(() => state.chatSessionId);
  await page.waitForFunction(() => state.chatRequest && !state.chatStarting);
  // Server-side arrival is observed independently of the renderer's busy flag.
  for (let i = 0; !f.asks.has(sid); i++) { if (i > 100) throw Error('ask did not reach HTTP fixture'); await new Promise(r => setTimeout(r, 10)); }
  return sid;
}

test('force issued during a passive read sends a second, forced HTTP read', async (page, f) => {
  const gate = await oldRead(page, f);
  f.sessions.push(summary('written', 'p-a', 20));
  await page.evaluate(() => { window.raceForce = loadSessions(true); });
  gate.release({});
  await page.evaluate(() => Promise.all([window.raceRead, window.raceForce]));
  assert.equal(f.calls.filter(c => c.path === '/api/sessions/list').at(-1).body.force, true);
  assert.ok(await page.evaluate(() => state.sessions.some(s => s.sessionId === 'written')));
});

test('a second write during an in-flight forced read is reconciled again', async (page, f) => {
  const gate = await oldRead(page, f, true);
  f.sessions.push(summary('write-after-force', 'p-b', 21));
  await page.evaluate(() => { window.raceForce = loadSessions(true); });
  gate.release({ data: { sessions: (await gate.hit).snapshot } });
  await page.evaluate(() => Promise.all([window.raceRead, window.raceForce]));
  assert.ok(await page.evaluate(() => state.sessions.some(s => s.sessionId === 'write-after-force')));
});

test('create response appears before the old list, survives it, and adopts real metadata', async (page, f) => {
  f.sessions.push(summary('older-in-project', 'p-a', 50, '2025-01-01T00:00:00Z'));
  const gate = await oldRead(page, f), forceGate = f.hold('/api/sessions/list');
  await page.evaluate(() => { window.raceCreate = newChat('p-a', 'work'); });
  await page.waitForFunction(() => state.chatSessionId.startsWith('created-'));
  const sid = await page.evaluate(() => state.chatSessionId);
  const expected = clone(f.sessions.find(s => s.sessionId === sid));
  try {
    await page.waitForFunction(sid => !!document.querySelector('#panel-body .panel-item[data-id="' + sid + '"]'), sid, { timeout: 1500 });
    assert.equal((await rows(page)).filter(r => r.group === 'p-a')[0]?.id, sid);
    const meta = await page.evaluate(sid => state.sessions.find(s => s.sessionId === sid), sid);
    assert.equal(meta.rowid, expected.rowid); assert.equal(meta.createdAt, expected.createdAt);
    gate.release({});
    await page.evaluate(() => window.raceRead);
    assert.ok(await page.evaluate(sid => state.sessions.some(s => s.sessionId === sid), sid));
    await forceGate.hit; forceGate.release({});
    await page.evaluate(() => window.raceCreate); await idle(page);
    assert.equal((await rows(page)).find(r => r.id === sid)?.group, 'p-a');
  } finally { gate.release({}); forceGate.release({}); }
});

test('network failure retains the existing rows and allows the next read to retry', async (page, f) => {
  const before = await page.evaluate(() => state.sessions);
  assert.ok(before.length > 0, 'fixture must start with a visible saved conversation');
  const gate = await oldRead(page, f);
  f.failListReads = true; gate.release({ disconnect: true });
  await page.evaluate(() => window.raceRead);
  assert.deepEqual(await page.evaluate(() => state.sessions), before);
  f.failListReads = false;
  f.sessions.push(summary('after-network-retry', 'p-b', 22));
  await page.evaluate(() => loadSessions());
  assert.ok(await page.evaluate(() => state.sessions.some(s => s.sessionId === 'after-network-retry')), JSON.stringify({ calls: f.calls.filter(c => c.path === '/api/sessions/list'), cache: await page.evaluate(() => ({ at: sessionsCache.at, ids: state.sessions.map(s => s.sessionId) })) }));
});

test('successful empty force clears saved rows after deletion', async (page, f) => {
  assert.ok((await rows(page)).length > 0);
  f.sessions = [];
  await page.evaluate(() => reloadSessions());
  assert.deepEqual(await page.evaluate(() => state.sessions), []);
  assert.deepEqual(await rows(page), []);
});

test('successful empty force clears an unacknowledged local create after deletion', async (page, f) => {
  const old = await oldRead(page, f), reconcile = f.hold('/api/sessions/list');
  await page.evaluate(() => { window.raceCreate = newChat('p-a', 'work'); });
  await page.waitForFunction(() => state.chatSessionId.startsWith('created-'));
  f.sessions = [];
  old.release({}); await page.evaluate(() => window.raceRead);
  await reconcile.hit; reconcile.release({});
  await page.evaluate(() => window.raceCreate); await idle(page);
  assert.deepEqual(await page.evaluate(() => state.sessions), []);
  await page.waitForFunction(() => !document.querySelector('#panel-body .rail-session'));
  assert.deepEqual(await rows(page), []);
});

test('create uses nested session metadata before a delayed list can reconcile it', async (page, f) => {
  const create = f.hold('/api/sessions/new'), list = f.hold('/api/sessions/list');
  const item = { ...summary('metadata-priority', 'p-b', 77), title: '内核摘要的标题' };
  f.sessions.push(item);
  await page.evaluate(() => { window.raceCreate = newChat('p-a', 'work'); }); await create.hit;
  create.release({ data: { sessionId: item.sessionId, projectId: 'p-a', session: item } });
  try {
    await page.waitForFunction(sid => state.chatSessionId === sid, item.sessionId);
    await page.waitForFunction(sid => !!document.querySelector('#panel-body .panel-item[data-id="' + sid + '"]'), item.sessionId);
    assert.deepEqual(await page.evaluate(sid => state.sessions.find(s => s.sessionId === sid), item.sessionId), item);
    assert.equal(await page.evaluate(() => state.chatProject), item.projectId);
    assert.equal((await rows(page)).find(r => r.id === item.sessionId)?.group, item.projectId);
  } finally { list.release({}); await page.evaluate(() => window.raceCreate); }
});

test('old list cannot roll back activity while the pending force later adopts server rowid', async (page, f) => {
  const gate = await oldRead(page, f);
  await page.evaluate(() => markSessionActivity('old', '2030-01-02T03:04:05Z', { title: '最新标题', projectId: 'p-a' }));
  gate.release({}); await page.evaluate(() => window.raceRead);
  assert.equal(await page.evaluate(() => state.sessions.find(s => s.sessionId === 'old').lastAt), '2030-01-02T03:04:05Z');
  assert.equal(await page.evaluate(() => state.sessions.find(s => s.sessionId === 'old').projectId), 'p-a');
  assert.equal(await page.evaluate(() => state.sessions.find(s => s.sessionId === 'old').title), '最新标题');
  f.sessions[0].lastAt = '2030-01-02T03:04:06Z'; f.sessions[0].rowid = 40;
  await page.evaluate(() => loadSessions(true));
  assert.equal(await page.evaluate(() => state.sessions.find(s => s.sessionId === 'old').rowid), 40);
});

test('two background placeholders use their own request or saved project/title', async (page, f) => {
  await page.evaluate(() => {
    state.sessions = [];
    state.chatSessionId = 'old'; state.chatProject = ''; state.lastQuestion = 'OTHER SESSION QUESTION';
    state.chatRequests.set('background-a', { sessionId: 'background-a', projectId: 'p-a', title: '甲的问题', kind: 'work' });
    state.chatRequests.set('background-b', { sessionId: 'background-b', projectId: 'p-b', title: '乙的问题', kind: 'work' });
  });
  await page.evaluate(() => loadSessions(true)); await page.evaluate(() => renderPanel());
  const got = await rows(page);
  assert.equal(got.find(r => r.id === 'background-a')?.group, 'p-a');
  assert.equal(got.find(r => r.id === 'background-a')?.title, '甲的问题');
  assert.equal(got.find(r => r.id === 'background-b')?.group, 'p-b');
  assert.equal(got.find(r => r.id === 'background-b')?.title, '乙的问题');
});

test('legacy create placeholder yields to real rowid and tied activity sorts by creation order', async (page, f) => {
  const gate = f.hold('/api/sessions/new');
  f.sessions.push({ ...summary('legacy-created', 'p-a', 30), title: '新对话' });
  await page.evaluate(() => { window.raceCreate = newChat('p-a', 'work'); }); await gate.hit;
  gate.release({ data: { sessionId: 'legacy-created', projectId: 'p-a' } });
  await page.evaluate(() => window.raceCreate); await idle(page);
  assert.equal(await page.evaluate(() => state.sessions.find(s => s.sessionId === 'legacy-created').rowid), 30);
  const stamp = '2030-01-01T01:00:00+08:00';
  f.sessions.find(s => s.sessionId === 'legacy-created').lastAt = stamp;
  f.sessions.push(summary('created-later', 'p-a', 31, '2029-12-31T17:00:00Z'));
  await page.evaluate(() => reloadSessions());
  assert.deepEqual((await rows(page)).filter(r => r.group === 'p-a').map(r => r.id), ['created-later', 'legacy-created']);
  f.sessions.find(s => s.sessionId === 'legacy-created').lastAt = '2030-01-02T01:00:00Z';
  await page.evaluate(() => reloadSessions());
  assert.equal((await rows(page)).filter(r => r.group === 'p-a')[0]?.id, 'legacy-created');
});

test('double create is deduplicated and delayed create cannot override an in-place session navigation', async (page, f) => {
  f.sessions.push(summary('navigate-b', 'p-b', 42));
  await page.evaluate(() => reloadSessions());
  const gate = f.hold('/api/sessions/new');
  await page.locator('.rail-group-head[data-group="p-a"]').hover();
  await page.locator('.rail-group-head[data-group="p-a"] [aria-label="新建会话"]').dblclick(); await gate.hit;
  await page.locator('#panel-body .panel-item[data-id="navigate-b"]').click();
  gate.release({}); await idle(page);
  assert.equal(f.calls.filter(c => c.path === '/api/sessions/new').length, 1);
  assert.equal(await page.evaluate(() => state.chatSessionId), 'navigate-b');
  assert.ok((await rows(page)).some(r => r.id.startsWith('created-') && r.group === 'p-a'));
});

test('delayed create remains listed without returning from a different page', async (page, f) => {
  const gate = f.hold('/api/sessions/new');
  await page.evaluate(() => { window.raceCreate = newChat('p-b', 'work'); }); await gate.hit;
  await page.evaluate(() => go('chat', 'overview'));
  gate.release({}); await page.evaluate(() => window.raceCreate); await idle(page);
  assert.equal(await page.evaluate(() => currentSection), 'overview');
  assert.ok((await rows(page)).some(r => r.id.startsWith('created-') && r.group === 'p-b'));
});

test('background completion failure cannot erase another live question, busy state or cancel flag', async (page, f) => {
  await page.evaluate(() => newChat('p-a', 'work')); await idle(page);
  const a = await send(page, f, '甲独有的问题');
  await page.evaluate(() => newChat('p-b', 'work')); await idle(page);
  const b = await send(page, f, '乙独有的问题');
  assert.notEqual(a, b); assert.equal(f.asks.get(a).body.mode, 'work'); assert.equal(f.asks.get(b).body.question, '乙独有的问题');
  await page.evaluate(sid => { state.cancelRequested = sid; }, b);
  f.failEventSessions.add(a);
  f.asks.get(a).resolve({ ok: true });
  await page.waitForFunction(sid => !state.chatRequests.has(sid), a);
  const result = await page.evaluate(() => ({ sid: state.chatSessionId, busy: state.busyTurn, cancel: state.cancelRequested, users: state.chatTurns.map(t => t.user) }));
  assert.equal(result.sid, b); assert.equal(result.busy, true); assert.equal(result.cancel, b);
  assert.ok(result.users.includes('乙独有的问题')); assert.ok(!result.users.includes('甲独有的问题'));
  assert.ok((await rows(page)).find(r => r.id === b)?.busy);
});

test('two live projects survive an older passive list with separate spinners and questions', async (page, f) => {
  const old = await oldRead(page, f), force = f.hold('/api/sessions/list');
  try {
    await page.evaluate(() => newChat('p-a', 'work'));
    const a = await send(page, f, '甲的后台问题');
    await page.evaluate(() => newChat('p-b', 'work'));
    const b = await send(page, f, '乙的前台问题');
    old.release({}); await page.evaluate(() => window.raceRead); await force.hit;
    const got = await rows(page);
    assert.ok(got.find(r => r.id === a && r.group === 'p-a' && r.busy));
    assert.ok(got.find(r => r.id === b && r.group === 'p-b' && r.busy));
    assert.deepEqual(await page.evaluate(() => state.chatTurns.map(t => t.user)), ['乙的前台问题']);
    assert.equal(f.asks.get(a).body.question, '甲的后台问题');
    await page.evaluate(() => openChatSession('old'));
    assert.equal(await page.evaluate(() => state.busyTurn), false);
    assert.equal(await page.evaluate(() => state.chatProject), '');
    await page.screenshot({ path: path.join(artifactDir, 'parallel-projects.png') });
  } finally { old.release({}); force.release({}); }
});

test('a delayed create cannot block sending in an existing session after navigation', async (page, f) => {
  f.sessions.push(summary('send-during-create', 'p-b', 45));
  await page.evaluate(() => reloadSessions());
  const create = f.hold('/api/sessions/new');
  await page.evaluate(() => { window.raceCreate = newChat('p-a', 'work'); }); await create.hit;
  try {
    await page.locator('#panel-body .panel-item[data-id="send-during-create"]').click();
    await page.locator('#chat-input').fill('乙继续发送的问题');
    await page.locator('#chat-input').press('Enter');
    await page.waitForFunction(() => state.chatRequests.has('send-during-create'), null, { timeout: 1500 });
    assert.equal(await page.evaluate(() => state.chatProject), 'p-b');
  } finally { create.release({}); await page.evaluate(() => window.raceCreate); }
});

test('sending while create is pending stays blocked in the original composer', async (page, f) => {
  await page.evaluate(() => openChatSession('old'));
  const create = f.hold('/api/sessions/new');
  await page.evaluate(() => { window.raceCreate = newChat('p-a', 'work'); }); await create.hit;
  try {
    await page.locator('#chat-input').fill('等待新建后发送的问题');
    await page.locator('#chat-input').press('Enter');
    assert.equal(await page.evaluate(() => state.busyTurn), false);
    assert.ok(!f.calls.some(c => c.path === '/api/agent/ask-pi'));
  } finally { create.release({}); await page.evaluate(() => window.raceCreate); }
});

test('implicit draft creation cannot block a different existing session or send the abandoned question', async (page, f) => {
  f.sessions.push(summary('draft-navigation', 'p-b', 46));
  await page.evaluate(() => reloadSessions());
  const create = f.hold('/api/sessions/new');
  await page.locator('#chat-input').fill('被导航放弃的草稿问题'); await page.locator('#chat-input').press('Enter');
  await create.hit;
  try {
    await page.locator('#panel-body .panel-item[data-id="draft-navigation"]').click();
    assert.equal(await page.locator('.composer-send').isEnabled(), true);
    await page.locator('#chat-input').fill('现有会话独立问题'); await page.locator('#chat-input').press('Enter');
    await page.waitForFunction(() => state.chatRequests.has('draft-navigation'), null, { timeout: 1500 });
  } finally { create.release({}); }
  await page.waitForFunction(() => !state.chatStarting && !sessionsCache.promise);
  assert.equal(await page.evaluate(() => state.chatSessionId), 'draft-navigation');
  assert.ok(!f.calls.some(c => c.path === '/api/agent/ask-pi' && c.body.question === '被导航放弃的草稿问题'));
});

test('history response opened before sending cannot erase the new local question', async (page, f) => {
  const history = f.hold('/api/sessions/events');
  await page.evaluate(() => { window.raceOpen = openChatSession('old'); }); await history.hit;
  try {
    await send(page, f, '历史读取期间新发的问题');
    history.release({}); await page.evaluate(() => window.raceOpen);
    assert.ok(await page.evaluate(() => state.chatTurns.some(t => t.user === '历史读取期间新发的问题')));
    assert.equal(await page.evaluate(() => state.busyTurn), true);
  } finally { history.release({}); }
});

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const report = { browser: browser.version(), app: appFile, artifactDir, results: [] };
  try {
    const filter = process.argv.find(a => a.startsWith('--case='))?.slice(7);
    for (const item of cases.filter(item => !filter || item.name.includes(filter))) {
      const f = await fixture(), context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await context.route('**/*', route => new URL(route.request().url()).origin === f.base ? route.continue() : route.abort());
      try {
        await page.goto(f.base + '/#/chat');
        await page.waitForSelector('#chat-input'); await page.waitForFunction(() => !document.getElementById('boot'));
        await idle(page); await item.run(page, f);
        assert.deepEqual(errors, [], 'uncaught browser errors');
        report.results.push({ name: item.name, ok: true }); console.log('PASS ' + item.name);
      } catch (e) {
        const result = { name: item.name, ok: false, error: String(e.stack || e) }; report.results.push(result);
        console.log('FAIL ' + item.name + '\n' + result.error.slice(0, 1200));
        await page.screenshot({ path: path.join(artifactDir, report.results.length + '-failure.png') }).catch(() => {});
      } finally { await context.close(); await f.close(); }
    }
  } finally { await browser.close(); fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2)); }
  const failed = report.results.filter(r => !r.ok).length;
  console.log(`RESULT ${report.results.length - failed}/${report.results.length} passed; ${artifactDir}`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
