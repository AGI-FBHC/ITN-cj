/** Real Edge + isolated Cangjie fixture + gated HTTP; no user data, Python or external models.
 * node tools/route-lifecycle-check.cjs [--baseline]
 * ITN_PLAYWRIGHT_DIR, ROUTE_CORE_EXE and ROUTE_UI_DIR can target packaged resources.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), {spawn} = require('node:child_process');
const {chromium} = require(process.env.ITN_PLAYWRIGHT_DIR ? path.join(process.env.ITN_PLAYWRIGHT_DIR, 'playwright') : 'D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root = path.resolve(__dirname, '..'), sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(50); } throw Error('condition timed out'); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-route-')), pf = path.join(dir, 'port');
  const baseline = process.argv.includes('--baseline'), checks = [], errors = [], gates = [];
  let core, proxy, browser, page, base;
  const check = (name, ok, detail = '') => { checks.push({name, ok, detail}); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ': ' + detail : '')); };
  const post = async (name, body = {}) => { const j = await (await fetch(base + '/api/' + name, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})).json(); if(j.code !== 0) throw Error(name + ': ' + j.message); return j.data; };
  const gate = pathname => {
    let start, release;
    const g = {pathname, used:false, started:new Promise(r => start = r), wait:new Promise(r => release = r), start, release};
    gates.push(g); return g;
  };
  const ready = async () => { await page.waitForFunction(() => document.querySelector('#view')?.getAttribute('aria-busy') === 'false'); };
  const nav = async name => { await page.locator('#rail [data-page="' + name + '"]').click(); await ready(); };
  const learn = async () => { await nav('home'); await page.locator('.workspace-tabs [data-page="learn"]').click(); await ready(); };
  const settingsIntact = () => page.evaluate(() => current === 'settings' && document.body.dataset.page === 'settings' && !!document.querySelector('#view .settings-body') && !document.querySelector('#view .course-workspace, #view .course-growth, #chat-input') && !document.body.classList.contains('chat-mode'));
  const releaseAfterSwitch = async g => {
    await Promise.race([g.started, sleep(10000).then(() => {throw Error('gate not reached: ' + g.pathname);})]);
    await nav('settings'); g.release(); await sleep(450);
  };
  try {
    const uiDir=path.resolve(process.env.ROUTE_UI_DIR || path.join(root,'shell/renderer'));
    console.log('Renderer '+uiDir);
    core = spawn(process.env.ROUTE_CORE_EXE || path.join(root, 'dist/core/itn-desktop-core.exe'), ['--data-dir='+dir, '--port-file='+pf, '--ui-dir='+uiDir, '--seed-course-fixture=1', '--fixture-delay-ms=450'], {windowsHide:true, stdio:['ignore','ignore','pipe']});
    core.stderr.on('data', d => errors.push('core: ' + d));
    await until(() => fs.existsSync(pf));
    const upstream = 'http://127.0.0.1:' + fs.readFileSync(pf, 'utf8').trim();
    proxy = http.createServer(async (req, res) => {
      try {
        const chunks=[];for await(const chunk of req) chunks.push(chunk);
        const g = gates.find(g => !g.used && g.pathname === req.url.split('?')[0]);
        if(g) { g.used = true; g.start(); }
        const response = await fetch(upstream + req.url, {method:req.method, headers:{'Content-Type':req.headers['content-type'] || 'application/json'}, body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
        const bytes = Buffer.from(await response.arrayBuffer());
        if(g) await g.wait;
        if(!res.destroyed) { res.writeHead(response.status, {'Content-Type':response.headers.get('content-type') || 'application/octet-stream'}); res.end(bytes); }
      } catch(e) { if(!res.destroyed) {res.writeHead(502);res.end(String(e));} }
    });
    await new Promise(r => proxy.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+proxy.address().port;
    browser = await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
    page = await browser.newPage({viewport:{width:1440,height:960}});
    // The page must never fetch the user's running kernel, remote models or web resources.
    await page.route('**/*', route => route.request().url().startsWith(base + '/') || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);await page.waitForSelector('#chat-input');await ready();await page.waitForFunction(() => !document.getElementById('boot'));

    await nav('settings');
    let g=gate('/api/projects/list');await page.locator('#rail [data-page="chat"]').click();await releaseAfterSwitch(g);
    check('old panel load cannot replace settings panel', await page.locator('#panel-title').innerText() === '设置');

    g=gate('/api/web/cache');await page.locator('#rail [data-page="chat"]').click();await releaseAfterSwitch(g);
    check('old chat render cannot replace settings or enable chat layout', await settingsIntact());

    await nav('home');g=gate('/api/course/state');await page.locator('.workspace-tabs [data-page="learn"]').click();await releaseAfterSwitch(g);
    check('old course state cannot replace settings', await settingsIntact());

    await nav('home');g=gate('/api/settings');await page.locator('.workspace-tabs [data-page="report"]').click();await releaseAfterSwitch(g);
    check('old growth config cannot clear settings', await settingsIntact());

    await learn();g=gate('/api/course/history');await page.getByRole('button',{name:'历史导图',exact:true}).click();await releaseAfterSwitch(g);
    check('old history response cannot open modal on settings', await page.locator('.course-modal-overlay').count() === 0);
    await page.keyboard.press('Escape');

    await learn();await page.getByRole('button',{name:/^归档 \d+$/}).click();await page.waitForSelector('.course-modal-overlay');
    // A full-screen modal intentionally intercepts pointer input. Browser Back is a real
    // navigation path available while it is open; no force-click through the overlay.
    await page.goBack();await ready();
    check('navigation removes an already open course modal', await page.locator('.course-modal-overlay').count() === 0);
    await page.keyboard.press('Escape');

    // Generate a real fixture map in the background through the actual page button.
    await learn();await page.locator('#course-generate').click();
    await until(async () => (await post('course/state',{kbId:'course-alpha'})).job?.status === 'running');
    await nav('settings');
    await until(async () => (await post('course/state',{kbId:'course-alpha'})).job?.status === 'completed');
    check('Cangjie course job completes after leaving the page', !!(await post('course/state',{kbId:'course-alpha'})).map && await settingsIntact());
    await learn();check('returning to course shows completed map', await page.locator('.course-node').count() > 0);

    // A second generation has a candidate modal at completion; hold a status response
    // across navigation to expose post-await polling UI after the host was detached.
    g=gate('/api/course/job');await page.locator('#course-generate').click();await releaseAfterSwitch(g);
    await until(async () => (await post('course/state',{kbId:'course-alpha'})).job?.status === 'completed');
    await sleep(300);
    check('background rebuild cannot reopen course UI on settings', await settingsIntact() && await page.locator('.course-modal-overlay').count() === 0);

    await nav('chat');await page.locator('#chat-input').fill('请解释工具调用，简短回答即可。');
    await page.locator('.composer-send[aria-label="发送"]').click();
    await until(() => page.evaluate(() => state.chatRequests.size > 0));
    const sid=await page.evaluate(() => state.chatSessionId);
    await nav('settings');await until(() => page.evaluate(() => state.chatRequests.size === 0));
    const events=(await post('sessions/events',{sessionId:sid})).events || [];
    check('real Cangjie conversation completes after leaving chat', events.some(e => e.type === 'turn/end') && await settingsIntact());
    await nav('chat');check('returning to chat retains the finished reply', await page.locator('.chat-thread').innerText().then(t => t.includes('工具调用')));

    await page.evaluate(() => window.LuminTeamPanel.ingest([
      {type:'team/run_started',payload:{runId:'route-popup',tool:'research_topic_team',goal:'页面切换检查'}},
      {type:'team/node_created',payload:{runId:'route-popup',nodeId:'root',depth:0,title:'协作任务',role:'调度员'}},
    ], state.chatSessionId, {autoOpen:true}));
    await page.waitForSelector('#team-panel.open');
    await page.goBack();await ready();
    check('browser navigation closes the team popup without leaving its backdrop', await settingsIntact() && await page.locator('#team-panel-scrim').isHidden() && !await page.evaluate(() => window.LuminTeamPanel.isOpen()));
    await page.evaluate(() => window.LuminTeamPanel.close({immediate: true}));

    // Repeated real left-rail clicks plus browser history, with no canned render functions.
    for(let i=0;i<3;i++) { await page.locator('#rail [data-page="home"]').click();await page.locator('#rail [data-page="resources"]').click();await page.locator('#rail [data-page="settings"]').click();await ready();check('rapid rail switching keeps final page '+(i+1),await settingsIntact()); }
    await page.goBack();await ready();check('browser Back renders resources',await page.locator('.outcome-page').count()===1);
    await page.goForward();await ready();check('browser Forward renders settings',await settingsIntact());
    check('no renderer or fixture errors', errors.length === 0, errors.join('; '));
    await page.screenshot({path:path.join(dir,'final.png')});
    fs.writeFileSync(path.join(dir,'result.json'), JSON.stringify({baseline,checks,errors},null,2));
    console.log('RESULT '+checks.filter(c=>c.ok).length+'/'+checks.length+'; artifacts '+dir);
    if(checks.some(c=>!c.ok))process.exitCode=1;
  } finally {
    for(const g of gates)g.release();
    if(browser)await browser.close();
    if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
    if(core)core.kill(); // only this test's child, never a packaged user process
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
