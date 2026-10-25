/* Real Edge, production notification scripts/CSS, isolated in-memory persistence and task feed. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(require.resolve('playwright', {paths: [path.resolve(__dirname, '..'), 'D:/Desktop/ITN/ITN/src/frontend/agent-demo']}));
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-unread-tasks-'));
const report = {dir, startedAt: new Date().toISOString(), scope: 'Browser UI and task policy only. Mock persistence/task APIs; no kernel, model, or real user DB.', results: [], errors: []};
const baseline = process.argv.includes('--baseline');
let browser;
const check = async (name, fn) => {
  try {const detail = await fn(); report.results.push({name, ok: true, detail}); console.log('PASS ' + name);}
  catch (error) {report.results.push({name, ok: false, error: error.stack || String(error)}); console.log('FAIL ' + name + ': ' + error.message);}
};
const task = (id, sessionId, status = 'running', extra = {}) => ({id, kind: 'chat', title: 'Session ' + sessionId, status, startedAt: '2026-10-25T00:00:00Z', stage: 'Working', link: {page: 'chat', sessionId}, ...extra});
const rows = page => page.locator('.notification-row').evaluateAll(nodes => nodes.map(n => n.dataset.id));
const send = (page, running = [], recent = []) => page.evaluate(({running, recent}) => window.LuminNotifications.syncTasks({running, recent}), {running, recent});
const context = (page, sessionId, guidedSessionId = '', route = 'chat') => page.evaluate(data => window.LuminNotifications.setContext(data), {page: route, sessionId, guidedSessionId});
const history = page => page.evaluate(() => window.LuminNotifications.list());
async function fixture(initial = [], options = {}) {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => report.errors.push(error.stack || error.message));
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header id="titlebar" style="display:flex;justify-content:flex-end;padding:12px;gap:12px"><div id="titlebar-notifications"></div><div id="titlebar-tasks"></div></header><main><h1>Notification check</h1></main></body></html>');
  await page.addStyleTag({content: fs.readFileSync(path.join(root, 'shell/renderer/style.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'shell/renderer/notifications.css'), 'utf8')});
  await page.evaluate(({initial, options}) => {
    window.__test = {stored: initial, saved: [], apiCalls: [], navigation: [], taskData: {running: [], recent: []}, failNavigation: false, holdSaves: !!options.holdSaves};
    const clone = x => JSON.parse(JSON.stringify(x));
    window.api = async (route, body) => {
      const test = window.__test;
      test.apiCalls.push(route);
      if (route === '/api/notifications/get') {
        const items = clone(test.stored);
        if (options.delayLoad) await new Promise(resolve => {test.releaseLoad = resolve;});
        return {items};
      }
      if (route === '/api/notifications/save') {
        if (test.holdSaves) await new Promise(resolve => {test.releaseSave = resolve;});
        assertLimit(body.items.length);
        test.stored = clone(body.items); test.saved.push(clone(body.items)); return {items: clone(body.items)};
      }
      if (route === '/api/tasks/list') return clone(test.taskData);
      if (route === '/api/tasks/cancel') {test.cancelled = body.id; return {};}
      throw Error('Unexpected fixture API: ' + route);
    };
    function assertLimit(length) {if (length > 60) throw Error('Persistence API limit exceeded');}
    window.toast = message => {window.__test.lastToast = message;};
    window.go = async (page, section, options) => {if (window.__test.failNavigation) throw Error('fixture navigation failed'); window.__test.navigation.push({page, section, options});};
    window.openChatSession = async sessionId => {
      if (window.__test.failNavigation) throw Error('fixture navigation failed');
      window.__test.navigation.push({page: 'chat', sessionId});
      window.LuminNotifications.setContext?.({page: 'chat', sessionId, guidedSessionId: ''});
    };
  }, {initial, options});
  await page.addScriptTag({content: fs.readFileSync(path.join(root, 'shell/renderer/notifications.js'), 'utf8')});
  if (!options.delayLoad) await page.evaluate(() => Promise.resolve());
  return page;
}

(async () => {
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
    const page = await fixture();
    await page.locator('.notification-btn').click();
    await check('ordinary success and system information are absent from the bell', async () => {
      await page.evaluate(() => {
        LuminNotifications.push({id: 'ordinary-success', title: 'Saved', status: 'success'});
        LuminNotifications.push({id: 'ordinary-info', title: 'Connected', status: 'info'});
      });
      assert.deepEqual(await rows(page), []);
    });
    await check('read task disappears immediately instead of becoming a history row', async () => {
      await page.evaluate(() => {
        LuminNotifications.push({id: 'task:read-example', source: 'task', title: 'Task', status: 'success', action: {page: 'chat', sessionId: 'other'}});
        LuminNotifications.markRead('task:read-example', true);
      });
      assert(!(await rows(page)).includes('task:read-example'));
    });
    await check('running tasks can be manually marked read', async () => {
      await page.evaluate(() => LuminNotifications.start({id: 'task:running-example', title: 'Running'}));
      assert.equal(await page.locator('[data-id="task:running-example"] .notification-toggle').isEnabled(), true);
      await page.locator('[data-id="task:running-example"] .notification-toggle').click();
      assert(!(await rows(page)).includes('task:running-example'));
    });
    await check('same-state progress updates do not restore manually read tasks', async () => {
      await page.evaluate(() => {
        LuminNotifications.markRead('task:running-example', true);
        LuminNotifications.update('task:running-example', {status: 'running', detail: '80%', read: false});
      });
      assert(!(await rows(page)).includes('task:running-example'));
    });
    if (!baseline) {
      await check('setContext and syncTasks are public entry points', async () => assert(await page.evaluate(() => typeof LuminNotifications.syncTasks === 'function' && typeof LuminNotifications.setContext === 'function')));
      const p = await fixture();
      await p.locator('.notification-btn').click();
      const a = task('turn:a:one', 'a'), b = task('turn:b:one', 'b');
      await check('viewing one conversation suppresses only that conversation', async () => {
        await context(p, 'a'); await send(p, [a, b]);
        assert.deepEqual(await rows(p), ['task:' + b.id]);
        assert.equal((await history(p)).find(n => n.id === 'task:' + a.id).read, true);
      });
      await check('repeated context and identical task polls produce no extra persistence', async () => {
        const before = await p.evaluate(async () => {await new Promise(resolve => setTimeout(resolve, 0)); return window.__test.saved.length;});
        await p.evaluate(({a, b}) => {
          for (let i = 0; i < 100; i++) LuminNotifications.setContext({page: 'chat', sessionId: 'a', guidedSessionId: ''});
          for (let i = 0; i < 10; i++) LuminNotifications.syncTasks({running: [a, b], recent: []});
        }, {a, b});
        const after = await p.evaluate(async () => {await new Promise(resolve => setTimeout(resolve, 0)); return window.__test.saved.length;});
        assert.equal(after, before);
      });
      await check('unread running task contributes to badge and aria count', async () => {
        assert.equal(await p.locator('.notification-badge').innerText(), '1');
        assert.match(await p.locator('.notification-btn').getAttribute('aria-label'), /1/);
      });
      await check('leaving an active conversation exposes its running task immediately', async () => {
        await context(p, '', '', 'kb');
        assert.deepEqual(new Set(await rows(p)), new Set(['task:' + a.id, 'task:' + b.id]));
      });
      await check('returning to view a task marks only that session read', async () => {
        await context(p, 'a'); assert.deepEqual(await rows(p), ['task:' + b.id]);
      });
      await check('manual read survives ten changing progress polls', async () => {
        await p.locator('[data-id="task:' + b.id + '"] .notification-toggle').click();
        for (let i = 0; i < 10; i++) await send(p, [a, {...b, stage: 'Progress ' + i, tokens: {total: i + 1}}]);
        assert.deepEqual(await rows(p), []);
      });
      await check('background completion becomes a fresh unread after running was read', async () => {
        await send(p, [a], [{...b, status: 'completed'}]);
        assert.deepEqual(await rows(p), ['task:' + b.id]);
        assert.match(await p.locator('[data-id="task:' + b.id + '"]').innerText(), /已完成/);
      });
      await check('completed task acknowledgment survives same-state detail polls', async () => {
        await p.locator('[data-id="task:' + b.id + '"] .notification-toggle').click();
        await send(p, [a], [{...b, status: 'completed', stage: 'Final detail changed'}]);
        assert.deepEqual(await rows(p), []);
      });
      await check('foreground completion remains read when leaving later', async () => {
        await send(p, [], [{...a, status: 'completed'}, {...b, status: 'completed'}]);
        await context(p, '', '', 'resources'); assert.deepEqual(await rows(p), []);
      });
      await check('guided session visibility coexists with primary conversation', async () => {
        await context(p, 'a', 'guided');
        await send(p, [task('guided-task', 'guided'), task('new-a', 'a'), task('new-b', 'b')]);
        assert.deepEqual(await rows(p), ['task:new-b']);
      });
      await check('stale primary id on non-chat page does not suppress tasks', async () => {
        await context(p, 'a', 'guided', 'study');
        assert.deepEqual(new Set(await rows(p)), new Set(['task:new-a', 'task:new-b']));
      });
      await check('closing guided chat exposes that active task', async () => {
        await context(p, '', '', 'study'); assert((await rows(p)).includes('task:guided-task'));
      });
      await check('hidden document does not mark currently selected session read', async () => {
        await p.evaluate(() => {Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange'));});
        await context(p, 'hidden'); await send(p, [task('hidden-task', 'hidden')]);
        assert((await rows(p)).includes('task:hidden-task'));
      });
      await check('visible document automatically acknowledges the viewed session only', async () => {
        await p.evaluate(() => {delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));});
        assert(!(await rows(p)).includes('task:hidden-task')); assert((await rows(p)).includes('task:new-b'));
      });
      await check('click opens exact session, consumes notice and closes popover', async () => {
        await p.locator('[data-id="task:new-b"] .notification-main').click();
        await p.waitForFunction(() => window.__test.navigation.some(n => n.sessionId === 'b'));
        assert(!(await rows(p)).includes('task:new-b')); assert(await p.locator('.notification-pop').isHidden());
      });
      await check('leaving again after clicking a running notification restores its unread task', async () => {
        await context(p, 'a');
        assert((await rows(p)).includes('task:new-b'));
        assert.equal((await history(p)).find(n => n.id === 'task:new-b').read, false);
        await context(p, 'b');
        assert(!(await rows(p)).includes('task:new-b'));
      });
      await check('failed navigation keeps task unread and exposes error', async () => {
        await p.locator('.notification-btn').click();
        await p.evaluate(() => {window.__test.failNavigation = true;});
        await p.locator('[data-id="task:guided-task"] .notification-main').click();
        await p.waitForFunction(() => !!window.__test.lastToast);
        assert((await rows(p)).includes('task:guided-task'));
        assert.match(await p.evaluate(() => window.__test.lastToast), /fixture navigation failed/);
        await p.evaluate(() => {window.__test.failNavigation = false;});
      });
      await check('read-all acknowledges running entries and they stay gone on poll', async () => {
        await p.locator('.notification-read-all').click();
        assert.deepEqual(await rows(p), []);
        await send(p, [task('guided-task', 'guided'), task('new-a', 'a'), task('new-b', 'b'), task('hidden-task', 'hidden')]);
        assert.deepEqual(await rows(p), []);
      });
      await check('non-chat task action keeps KB target and can use parent navigator', async () => {
        await p.evaluate(() => LuminNotifications.setNavigator(async action => window.__test.navigation.push({custom: action})));
        await send(p, [{id: 'map-one', kind: 'course-map', title: 'Map', status: 'running', link: {page: 'learn', kbId: 'selected-kb'}}]);
        await p.locator('[data-id="task:map-one"] .notification-main').click();
        await p.waitForFunction(() => window.__test.navigation.some(n => n.custom?.kbId === 'selected-kb'));
        assert((await history(p)).find(n => n.id === 'task:map-one').read);
      });
      await check('old recent tasks are not backfilled as new unread on startup', async () => {
        const before = await rows(p); await send(p, [], [task('ancient', 'archive', 'completed', {updatedAt: '2020-01-01T00:00:00Z'})]);
        assert.deepEqual(await rows(p), before);
      });
      await check('task completed between polls is reported when freshly timestamped', async () => {
        await send(p, [], [task('quick', 'quick-session', 'failed', {updatedAt: new Date(Date.now() + 1000).toISOString()})]);
        assert((await rows(p)).includes('task:quick'));
      });
      const operations = await fixture();
      await context(operations, '', '', 'kb');
      await operations.locator('.notification-btn').click();
      await check('explicit task source exposes real long operations without task id prefix', async () => {
        await operations.evaluate(() => {
          LuminNotifications.start({id: 'ordinary-operation', title: 'Ordinary status', page: 'kb'});
          LuminNotifications.start({id: 'index-operation', source: 'task', title: 'Index', page: 'kb', action: {page: 'kb', section: 'manage', kbId: 'exact-kb'}});
        });
        assert.deepEqual(await rows(operations), ['index-operation']);
      });
      await check('non-session operation stays unread on the same page', async () => {
        await context(operations, 'stale-session', '', 'kb');
        assert.deepEqual(await rows(operations), ['index-operation']);
        assert.equal((await history(operations)).find(n => n.id === 'index-operation').read, false);
      });
      await check('long operation completion renotifies but repeated terminal finish does not', async () => {
        await operations.locator('[data-id="index-operation"] .notification-toggle').click();
        await operations.evaluate(() => LuminNotifications.finish('index-operation', 'success', 'Index complete'));
        assert.deepEqual(await rows(operations), ['index-operation']);
        await operations.locator('[data-id="index-operation"] .notification-toggle').click();
        await operations.evaluate(() => LuminNotifications.finish('index-operation', 'success', 'Final indexing summary'));
        assert.deepEqual(await rows(operations), []);
      });
      await check('parent navigator receives exact KB and section for long operation', async () => {
        await operations.evaluate(() => {
          LuminNotifications.setNavigator(async action => window.__test.navigation.push({custom: action}));
          LuminNotifications.start({id: 'organize-operation', source: 'task', title: 'Organize', page: 'kb', action: {page: 'kb', section: 'manage', kbId: 'other-kb'}});
        });
        await operations.locator('[data-id="organize-operation"] .notification-main').click();
        await operations.waitForFunction(() => window.__test.navigation.some(n => n.custom?.kbId === 'other-kb'));
        assert.deepEqual(await operations.evaluate(() => window.__test.navigation.at(-1).custom), {page: 'kb', section: 'manage', kbId: 'other-kb'});
        assert(!(await rows(operations)).includes('organize-operation'));
      });
      const legacy = [{id: 'old-system', title: 'Legacy information', status: 'info', read: false, createdAt: '2020-01-01', customHistory: 'keep'}, {id: 'task:legacy', title: 'Legacy read task', status: 'running', read: true, action: {page: 'chat', sessionId: 'legacy'}}];
      const saved = await fixture(legacy);
      await saved.locator('.notification-btn').click();
      await check('legacy read state is respected, generic history is hidden', async () => assert.deepEqual(await rows(saved), []));
      await check('persistence preserves hidden legacy records and task target metadata', async () => {
        await send(saved, [task('fresh', 'fresh')]);
        await saved.waitForFunction(() => window.__test.stored.some(n => n.id === 'task:fresh'));
        const stored = await saved.evaluate(() => window.__test.stored);
        assert.equal(stored.find(n => n.id === 'old-system').customHistory, 'keep');
        assert.equal(stored.find(n => n.id === 'task:fresh').action.sessionId, 'fresh');
      });
      await check('manual read survives actual module reload and a changed progress poll', async () => {
        await saved.locator('[data-id="task:fresh"] .notification-toggle').click();
        await saved.waitForFunction(() => window.__test.stored.find(n => n.id === 'task:fresh')?.read);
        const reloaded = await fixture(await saved.evaluate(() => window.__test.stored));
        await reloaded.locator('.notification-btn').click(); await send(reloaded, [task('fresh', 'fresh', 'running', {stage: 'Another poll'})]);
        assert.deepEqual(await rows(reloaded), []);
      });
      await check('late persistence load preserves acknowledged phase and queued completion', async () => {
        const delayed = await fixture([{id: 'task:waiting', source: 'task', title: 'Waiting', status: 'running', read: true, action: {page: 'chat', sessionId: 'waiting'}}], {delayLoad: true});
        await send(delayed, [task('waiting', 'waiting'), task('finishing', 'finish-session')]);
        await send(delayed, [task('waiting', 'waiting')], [task('finishing', 'finish-session', 'completed')]);
        await delayed.evaluate(() => window.__test.releaseLoad()); await delayed.locator('.notification-btn').click();
        assert.deepEqual(await rows(delayed), ['task:finishing']);
      });
      await check('task center stays intact and popovers remain mutually exclusive', async () => {
        await p.evaluate(data => {window.__test.taskData = data;}, {running: [task('center', 'center-session', 'running', {cancelable: true})], recent: [task('center-old', 'center-old-session', 'completed')]});
        await p.addScriptTag({content: fs.readFileSync(path.join(root, 'shell/renderer/tasks.js'), 'utf8')});
        await p.locator('.task-btn').click(); assert(await p.locator('.notification-pop').isHidden());
        await p.waitForFunction(() => document.querySelectorAll('.task-row').length === 2);
        const runningRow = p.locator('.task-row').filter({hasText: 'Session center-session'});
        await runningRow.getByRole('button', {name: '\u505c\u6b62', exact: true}).click();
        assert.equal(await p.evaluate(() => window.__test.cancelled), 'center');
        await runningRow.getByRole('button', {name: '\u6253\u5f00', exact: true}).click();
        await p.waitForFunction(() => window.__test.navigation.some(n => n.sessionId === 'center-session'));
        await p.locator('.task-btn').click();
        await p.locator('.notification-btn').click(); assert(await p.locator('.task-pop').isHidden());
        assert.equal(await p.locator('.task-section').count(), 2);
      });
      for (const [theme, width, zoom] of [['light', 1280, 1.3], ['dark', 768, 1], ['dark', 375, 1]]) {
        await check('theme, keyboard and geometry ' + theme + '/' + width + '/' + zoom, async () => {
          const visual = await fixture(); await visual.setViewportSize({width, height: 800});
          await visual.evaluate(({theme, zoom}) => {document.documentElement.dataset.theme = theme; document.body.style.zoom = zoom;}, {theme, zoom});
          await send(visual, [task('visual', 'visual', 'running', {title: 'A long background task title '.repeat(8)})]);
          await visual.locator('.notification-btn').focus(); await visual.keyboard.press('Enter');
          const bounds = await visual.locator('.notification-pop').boundingBox();
          assert(bounds.x >= -0.5 && bounds.x + bounds.width <= width + .5, JSON.stringify(bounds));
          await visual.locator('.notification-main').focus(); await visual.keyboard.press('Tab');
          assert(await visual.locator('.notification-toggle').evaluate(node => node === document.activeElement));
          await visual.screenshot({path: path.join(dir, theme + '-' + width + '.png')});
          await visual.keyboard.press('Escape'); assert(await visual.locator('.notification-pop').isHidden());
          assert(await visual.locator('.notification-btn').evaluate(node => node === document.activeElement));
        });
      }
      await check('reduced motion removes notification icon animation', async () => {
        await p.emulateMedia({reducedMotion: 'reduce'}); await p.locator('.notification-btn').click();
        const animation = await p.locator('.notification-btn svg').evaluate(node => getComputedStyle(node).animationName);
        assert.equal(animation, 'none');
      });
    }
    await page.screenshot({path: path.join(dir, baseline ? 'baseline.png' : 'basic-checks.png')});
    await check('no uncaught browser errors', async () => assert.deepEqual(report.errors, []));
  } catch (error) {report.fatal = error.stack || String(error); console.error(report.fatal);}
  finally {
    if (browser) await browser.close();
    report.passed = report.results.filter(r => r.ok).length; report.failed = report.results.filter(r => !r.ok).length + (report.fatal ? 1 : 0);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log('RESULT ' + report.passed + ' passed, ' + report.failed + ' failed; ' + path.join(dir, 'report.json'));
    if (report.failed) process.exitCode = 1;
  }
})();
