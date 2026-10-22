/**
 * Real Edge + the real renderer; all HTTP is intercepted, fixtures live in memory.
 * Hold branch responses for 10s, use native mouse clicks (no dispatchEvent), and
 * exercise rerenders, menu/slash aliases, failures, session switches and slow opens.
 * Also hold session/new while real menu clicks, /new and send race against it.
 * Does not start the kernel, read a user database, or verify kernel persistence.
 * BRANCH_UI_DIR can point to an older renderer to prove the checks detect bugs.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(require.resolve('playwright', {paths: [
  process.env.ITN_PLAYWRIGHT_DIR && path.dirname(process.env.ITN_PLAYWRIGHT_DIR),
  path.resolve(__dirname, '..'),
  path.resolve(path.dirname(process.execPath), '..'),
  'D:/Desktop/ITN/ITN/src/frontend/agent-demo',
].filter(Boolean)}));
const root = path.resolve(__dirname, '..');
const ui = path.resolve(process.env.BRANCH_UI_DIR || path.join(root, 'shell/renderer'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const delayMs = Number(process.env.BRANCH_DELAY_MS || 10000);
assert(Number.isFinite(delayMs) && delayMs >= 0, 'BRANCH_DELAY_MS must be non-negative');

async function until(fn, name, timeout = 8000) {
  const start = Date.now();
  while (!(await fn())) {
    assert(Date.now() - start < timeout, 'Timed out: ' + name);
    await sleep(25);
  }
}

async function fixture(browser) {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = [], requests = [], gates = [];
  const base = ['t1', 't2'].flatMap((turnId, i) => [
    {type: 'turn/start', turnId, payload: {kind: 'ask'}},
    {type: 'user/message', turnId, payload: {text: 'Question ' + i}},
    {type: 'assistant/message', turnId, payload: {text: 'Answer ' + i}},
    {type: 'turn/end', turnId, payload: {ok: true}},
  ]);
  // Deliberately reuse turn IDs in another session: identity must include sessionId.
  const sessions = {s1: base, s2: base};
  const openGates = [];
  const f = {page, requests, errors, sessions, newRequests: [], agentRequests: [], savedReports: [], holdOpen: false, openStarted: false, mouseAttempts: 0};
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'branch-guard.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      const body = route.request().postDataJSON() || {};
      let data = {};
      if (url.pathname === '/api/settings') data = {models: [{id: 'fixture', name: 'Fixture', model: 'fixture'}], chatModelId: 'fixture', knowledgeBases: []};
      if (url.pathname === '/api/projects/list') data = {projects: []};
      if (url.pathname === '/api/skills/list') data = {skills: [], bound: ''};
      if (url.pathname === '/api/web/cache') data = {mode: 'auto'};
      if (url.pathname === '/api/sessions/list') data = {sessions: Object.keys(sessions).map(sessionId => ({sessionId, title: sessionId, projectId: ''}))};
      if (url.pathname === '/api/sessions/state') data = {status: 'idle'};
      if (url.pathname === '/api/agent/ask-pi') { f.agentRequests.push(body); data = {ok: true}; }
      if (url.pathname === '/api/sessions/new') {
        const gate = deferred(); gates.push(gate);
        const entry = {body, gate, id: 'new-' + (f.newRequests.length + 1)};
        f.newRequests.push(entry);
        await gate.promise;
        sessions[entry.id] = [];
        data = {sessionId: entry.id, projectId: body.projectId || ''};
      }
      if (url.pathname === '/api/artifacts/save') {
        f.savedReports.push(body);
        await sleep(700);
        data = {name: body.name};
      }
      if (url.pathname === '/api/sessions/events') {
        if (f.holdOpen && body.sessionId.startsWith('branch-')) {
          f.openStarted = true;
          const gate = deferred(); gates.push(gate);
          openGates.push(gate);
          await gate.promise;
        }
        data = {events: sessions[body.sessionId] || [], lastId: (sessions[body.sessionId] || []).length};
      }
      if (url.pathname === '/api/sessions/branch') {
        const gate = deferred(); gates.push(gate);
        const entry = {body, gate, at: Date.now(), id: 'branch-' + (requests.length + 1)};
        requests.push(entry);
        const failure = await gate.promise;
        if (failure === 'transport') return route.abort('failed');
        if (failure) return route.fulfill({json: {code: 1, message: 'fixture branch failed'}});
        const end = base.findLastIndex(event => event.turnId === body.turnId) + 1;
        sessions[entry.id] = base.slice(0, end);
        data = {sessionId: entry.id, title: entry.id};
      }
      return route.fulfill({json: {code: 0, data}});
    }
    const file = path.join(ui, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
    if (!fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    const raw = fs.readFileSync(file);
    return route.fulfill({body: url.pathname === '/' ? raw.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') : raw,
      contentType: url.pathname === '/' ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'});
  });
  await page.goto('http://branch-guard.test/');
  await page.addStyleTag({path: path.join(ui, 'style.css')});
  await page.addScriptTag({path: path.join(ui, 'app.js')});
  await page.addScriptTag({path: path.join(ui, 'workbench.js')});
  await page.evaluate(async () => {
    document.getElementById('boot')?.remove();
    current = 'chat'; currentSection = ''; state.chatSessionId = 's1';
    await PAGES.chat.render(); refreshChatHeader();
  });
  f.button = index => page.locator('button[aria-label="从这里开分支"]').nth(index);
  f.switch = async sid => {
    await page.evaluate(async id => { closePopover(); await openChatSession(id); }, sid);
    await f.button(0).waitFor({state: 'visible'});
  };
  f.redraw = async () => {
    await page.evaluate(async () => { closePopover(); await PAGES.chat.render(); refreshChatHeader(); });
    await f.button(0).waitFor({state: 'visible'});
  };
  f.menu = async () => {
    await page.locator('button[aria-label="会话操作"]').click();
    return page.locator('.rail-menu-item').filter({hasText: /新建分支|正在开分支/});
  };
  // Native mouse input does not auto-wait for a disabled button to become enabled.
  f.clicks = async (locator, count = 5) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    assert(box, 'button must be visible for native clicks');
    for (let i = 0; i < count; i++) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      f.mouseAttempts++;
    }
  };
  f.busy = async locator => locator.evaluate(b => ({disabled: b.disabled, busy: b.classList.contains('is-busy'), aria: b.getAttribute('aria-busy'), title: b.title, text: b.textContent, svg: !!b.querySelector('svg')}));
  f.expectBusy = async locator => {
    const b = await f.busy(locator);
    assert(b.disabled && b.busy && b.aria === 'true' && /正在开分支/.test(b.title + b.text), JSON.stringify(b));
    assert(b.svg, 'loading must preserve the branch icon');
  };
  f.idle = () => until(() => page.evaluate(() => ![...busyActions].some(k => k.startsWith('branch:'))), 'branch lock released');
  f.releaseOpen = () => { for (const gate of openGates) gate.resolve(); };
  f.close = async () => {
    for (const gate of gates) gate.resolve(true);
    await page.close();
  };
  return f;
}

async function main() {
  const browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
  let passed = 0;
  const failures = [];
  async function scenario(name, run) {
    if (process.argv.includes('--new-chat-only') && !name.startsWith('newChat')) return;
    const f = await fixture(browser);
    try {
      await run(f);
      assert.deepEqual(f.errors, [], 'uncaught renderer exceptions');
      passed++; console.log('PASS ' + name + '; native mouse attempts=' + f.mouseAttempts);
    } catch (error) {
      failures.push(name); console.error('FAIL ' + name + ': ' + error.message);
    } finally { await f.close(); }
  }
  try {
    await scenario('newChat: delayed creation deduplicates real clicks/commands, blocks send and respects navigation', async f => {
      const pickNew = async () => {
        await f.page.locator('#rail-new').click();
        await f.clicks(f.page.locator('.rail-menu-item').filter({hasText: '常规聊天'}), 1);
      };
      await pickNew();
      await until(() => f.newRequests.length > 0, 'session/new pending');
      for (let i = 0; i < 4; i++) await pickNew();
      await f.page.evaluate(() => {
        const command = SLASH_COMMANDS.find(c => c.cmd === '/new');
        for (let i = 0; i < 5; i++) void command.run();
      });
      await f.page.locator('#chat-input').fill('Must not send into the old session while newChat is pending');
      await f.clicks(f.page.locator('.composer-send'), 3);
      await f.page.locator('#chat-input').press('Enter');
      await f.page.evaluate(() => api('/api/prefs/get', {}));
      assert.equal(f.newRequests.length, 1, 'menu clicks and /new must share one pending creation');
      assert.equal(f.agentRequests.length, 0, 'send must not target the old session while creation is pending');
      assert.equal(await f.page.locator('#chat-input').inputValue(), 'Must not send into the old session while newChat is pending');
      f.newRequests[0].gate.resolve();
      await until(() => f.page.evaluate(() => !busyActions.has('session:new')), 'newChat success unlock');
      assert.equal(await f.page.evaluate(() => state.chatSessionId), 'new-1');
      assert.equal(Object.keys(f.sessions).filter(id => id.startsWith('new-')).length, 1);

      // A later deliberate request must work, but its late result must respect a page change.
      await pickNew();
      await until(() => f.newRequests.length === 2, 'second deliberate creation');
      await f.page.evaluate(() => go('settings', 'about'));
      const route = await f.page.evaluate(() => location.hash);
      f.newRequests[1].gate.resolve();
      await until(() => f.page.evaluate(() => !busyActions.has('session:new')), 'background newChat unlock');
      assert.deepEqual(await f.page.evaluate(() => ({page: current, hash: location.hash, sid: state.chatSessionId})),
        {page: 'settings', hash: route, sid: 'new-1'}, 'late creation must not pull the user back to chat');
      assert.equal(f.newRequests.length, 2);
      assert.equal(Object.keys(f.sessions).filter(id => id.startsWith('new-')).length, 2);
    });

    await scenario('10s delay: repeat clicks, rerender, menu and slash share one request', async f => {
      await f.clicks(f.button(1));
      await until(() => f.requests.length > 0, 'first request');
      await f.expectBusy(f.button(1));
      const original = await f.button(1).elementHandle();
      await f.redraw();
      assert.equal(await original.evaluate(b => b.isConnected), false, 'force an actual replacement node');
      await f.expectBusy(f.button(1));
      await f.clicks(f.button(1));
      let menu = await f.menu();
      await f.expectBusy(menu);
      await f.clicks(menu);
      await f.page.evaluate(() => { for (let i = 0; i < 5; i++) void slashBranch(); });
      await f.page.evaluate(() => closePopover());
      // Two more bursts near the middle/end of the reported 10-second wait.
      await sleep(Math.max(0, delayMs / 2 - (Date.now() - f.requests[0].at)));
      await f.clicks(f.button(1));
      await f.redraw();
      await f.expectBusy(f.button(1));
      await sleep(Math.max(0, delayMs - (Date.now() - f.requests[0].at)));
      await f.clicks(f.button(1));
      assert.equal(f.requests.length, 1, 'repeated native clicks must send exactly one POST');
      f.requests[0].gate.resolve();
      await f.idle();
      assert.equal(Object.keys(f.sessions).filter(id => id.startsWith('branch-')).length, 1);
      assert.equal(await f.page.evaluate(() => state.chatSessionId), 'branch-1');
      await f.switch('s1');
      assert.equal(await f.button(1).isDisabled(), false, 'success unlocks fresh source buttons');
      console.log('  held response for ' + (Date.now() - f.requests[0].at) + 'ms; POSTs=' + f.requests.length);
    });

    await scenario('request identity: same turn IDs in two sessions have independent locks', async f => {
      await f.clicks(f.button(0));
      await until(() => f.requests.length === 1, 's1 request');
      await f.switch('s2');
      assert.equal(await f.button(0).isDisabled(), false, 's1 must not disable s2');
      await f.clicks(f.button(0));
      await until(() => f.requests.length >= 2, 's2 request');
      await f.switch('s1');
      await f.expectBusy(f.button(0));
      await f.clicks(f.button(0));
      assert.deepEqual(f.requests.map(r => r.body), [{sessionId: 's1', turnId: 't1'}, {sessionId: 's2', turnId: 't1'}]);
      await f.switch('s2');
      f.requests[0].gate.resolve();
      await until(() => Object.hasOwn(f.sessions, 'branch-1'), 'first success');
      await until(() => f.page.evaluate(() => !busyActions.has('branch:s1') && !busyActions.has('branch:' + JSON.stringify(['s1', 't1']))), 's1 unlock');
      assert.equal(await f.page.evaluate(() => state.chatSessionId), 's2', 'background success must not steal the active session');
      await f.expectBusy(f.button(0));
      f.requests[1].gate.resolve();
      await f.idle();
      assert.equal(f.requests.length, 2);
      assert.equal(await f.page.evaluate(() => state.chatSessionId), 'branch-2');
    });

    await scenario('different turns are different request identities', async f => {
      await f.clicks(f.button(0), 1);
      await until(() => f.requests.length === 1, 'first turn');
      assert.equal(await f.button(1).isDisabled(), false);
      await f.clicks(f.button(1), 1);
      await until(() => f.requests.length >= 2, 'second turn');
      assert.deepEqual(f.requests.map(r => r.body.turnId), ['t1', 't2']);
      for (const r of f.requests) r.gate.resolve(true);
      await f.idle();
      assert.equal(await f.button(0).isDisabled(), false);
      assert.equal(await f.button(1).isDisabled(), false);
    });

    for (const failure of ['api', 'transport']) {
      await scenario(failure + ' failure: rerendered menu/buttons recover and a real click retries', async f => {
        const menu = await f.menu();
        await f.clicks(menu, 1);
        await until(() => f.requests.length === 1, 'menu request');
        // Reopen using real UI; latest-turn button and menu are aliases of one request.
        await f.page.keyboard.press('Escape');
        const reopened = await f.menu();
        await f.expectBusy(reopened);
        await f.clicks(reopened);
        f.requests[0].gate.resolve(failure === 'transport' ? 'transport' : true);
        await f.idle();
        assert.match(await f.page.locator('#toast').textContent(), /分支失败/);
        assert.equal(await reopened.isDisabled(), false);
        assert.match(await reopened.textContent(), /新建分支/);
        assert.equal(await reopened.locator('svg').count(), 1);
        assert.equal(await f.button(1).isDisabled(), false);
        await f.clicks(reopened);
        await until(() => f.requests.length >= 2, 'retry request');
        assert.equal(f.requests.length, 2);
        f.requests[1].gate.resolve();
        await f.idle();
        assert.equal(await f.page.evaluate(() => state.chatSessionId), 'branch-2');
      });
    }

    await scenario('slow opening: source button cannot create a branch in the new session', async f => {
      f.holdOpen = true;
      await f.clicks(f.button(0), 1);
      await until(() => f.requests.length === 1, 'source request');
      f.requests[0].gate.resolve();
      await until(() => f.openStarted, 'branch history loading');
      await f.clicks(f.button(0));
      // This observes a full HTTP round trip, not just the immediate event handler.
      await f.page.evaluate(() => api('/api/prefs/get', {}));
      assert.equal(f.requests.length, 1, JSON.stringify(f.requests.map(r => r.body)));
      await f.expectBusy(f.button(0));
      await f.switch('s2');
      f.holdOpen = false;
      // Closing the delayed history request is separate from the already-complete POST.
      f.releaseOpen();
      await f.idle();
      assert.equal(await f.page.evaluate(() => state.chatSessionId), 's2');
      await f.switch('s1');
      assert.equal(await f.button(0).isDisabled(), false);
    });

    // Preserve the pre-existing non-branch check of the shared write guard.
    await scenario('existing export guard still writes one report per click burst', async f => {
      await f.page.evaluate(() => document.body.appendChild(growthReportCard()));
      await f.clicks(f.page.locator('.btn').filter({hasText: /^导出报告$/}), 4);
      await until(() => f.savedReports.length > 0, 'report save');
      await until(() => f.page.evaluate(() => !busyActions.has('report:export')), 'report save finished');
      assert.equal(f.savedReports.length, 1);
    });
    console.log('RESULT ' + passed + ' passed, ' + failures.length + ' failed; ui=' + ui);
    if (failures.length) process.exitCode = 1;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
