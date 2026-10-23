/** Real headless Edge + real renderer + isolated Cangjie guided/model fixture.
 * Uses the native reasoning APIs when available; for an older core only these two
 * endpoints use a contract fixture. Options/labels are narrowed at the boundary
 * to verify that the UI honours the API rather than guessing from model aliases.
 * Existing settings/session persistence, asks, guided resources and events reach
 * the native core. Usage adds just the new nullable field to a real usage event.
 * This checks UI behaviour/request bodies, NOT real reasoning protocol adaptation,
 * billing, persistence across core restarts, or a screen reader audit.
 * REASONING_UI_REF=HEAD runs the identical test with old app.js/style.css and must
 * fail at the missing visible control. No Python, user database or remote model.
 * REASONING_CORE_EXE / ITN_PLAYWRIGHT_DIR may override local runtime locations.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require(require.resolve('playwright', {paths:[
  process.env.ITN_PLAYWRIGHT_DIR, path.join(process.env.ITN_PLAYWRIGHT_DIR || '', '..'),
  path.resolve(__dirname, '..'), 'D:/Desktop/ITN/ITN/src/frontend/agent-demo',
].filter(Boolean)}));
const root = path.resolve(__dirname, '..'), sleep = ms => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const until = async (fn, label, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(40); }
  throw Error('Timed out: ' + label);
};

(async () => {
  console.log('SCOPE: Edge clicks/keyboard, real isolated core. New reasoning APIs use native routes when available, contract fixtures otherwise. No real provider protocol or restart persistence claim.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-reasoning-ui-')), pf = path.join(dir, 'port');
  const core = spawn(process.env.REASONING_CORE_EXE || path.join(root, 'dist/core/itn-desktop-core.exe'), [
    '--data-dir=' + dir, '--port-file=' + pf, '--ui-dir=' + path.join(root, 'shell/renderer'), '--seed-guided-fixture=1',
  ], {windowsHide:true, stdio:['ignore','ignore','pipe']});
  let browser, page, passed = 0, model = 'course-fixture', saveGate = null, failSave = false;
  const modes = new Map(), reads = [], saves = [], asks = [], modelSaves = [], errors = [], readGates = new Map(), held = [];
  const check = (name, condition) => { assert.ok(condition, name); console.log('PASS ' + (++passed) + ' ' + name); };
  try {
    await until(() => fs.existsSync(pf), 'native core port', 15000);
    const base = 'http://127.0.0.1:' + fs.readFileSync(pf, 'utf8').trim();
    const post = async (url, body = {}) => {
      const j = await fetch(base + '/api/' + url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}).then(r => r.json());
      assert.equal(j.code, 0, url + ': ' + j.message); return j.data;
    };
    const settings = await fetch(base + '/api/settings').then(r => r.json()).then(j => j.data);
    const originalModel = settings.models[0];
    await post('models/save', {...originalModel, reasoningProfile:'deepseek', apiKey:'isolated-fixture'});
    await post('models/save', {...originalModel, id:'reasoning-alt', name:'第二个检查模型', reasoningProfile:'mimo', apiKey:'isolated-fixture'});
    await post('models/save', {...originalModel, id:'reasoning-unknown', name:'未配置思考的模型', reasoningProfile:'auto', apiKey:'isolated-fixture'});
    const probe = await fetch(base + '/api/agent/reasoning', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r => r.json());
    const nativeReasoning = probe.code === 0 && Array.isArray(probe.data?.options);
    console.log('REASONING_API=' + (nativeReasoning ? 'native; mode saves and reads reach Cangjie/SQLite' : 'contract fixture; backend reasoning persistence is not covered'));
    const a = (await post('sessions/new')).sessionId, b = (await post('sessions/new')).sessionId;
    // The UI must render exactly the supplied subset and labels, never infer extra
    // low/medium/max choices by looking at the model's deliberately opaque name.
    const capability = sid => {
      const options = model === 'reasoning-unknown' ? [{id:'default',label:'接口默认'}] :
        [{id:'default',label:'接口默认'}, {id:model === 'reasoning-alt' ? 'on' : 'high',label:model === 'reasoning-alt' ? '第二模型档位' : '接口深度档'}];
      const mode = modes.get(sid) || 'default';
      return {modelId:model, profile:model === 'reasoning-unknown' ? 'auto' : 'fixture', mode,
        effectiveMode:options.some(o => o.id === mode) ? mode : 'default', supported:model !== 'reasoning-unknown',
        requiresConfiguration:model === 'reasoning-unknown', options};
    };
    browser = await chromium.launch({channel:'msedge', headless:true});
    page = await browser.newPage({viewport:{width:1500,height:1000}});
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {
      if (r.url().endsWith('/api/models/save')) modelSaves.push(r.postDataJSON());
      if (/\/api\/agent\/(ask-pi|task-pi)$/.test(r.url())) asks.push({path:new URL(r.url()).pathname, body:r.postDataJSON()});
    });
    if (process.env.REASONING_UI_REF) {
      for (const file of ['app.js', 'style.css']) {
        const body = execFileSync('git', ['show', process.env.REASONING_UI_REF + ':shell/renderer/' + file], {cwd:root, maxBuffer:8*1024*1024});
        await page.route('**/' + file, route => route.fulfill({body, contentType:file.endsWith('.js') ? 'text/javascript' : 'text/css'}));
      }
    }
    await page.route('**/api/models/roles', async route => {
      const response = await route.fetch(); if (response.ok()) model = route.request().postDataJSON().chatModelId;
      await route.fulfill({response});
    });
    await page.route('**/api/agent/reasoning', async route => {
      const body = route.request().postDataJSON();
      let data = capability(body.sessionId || '');
      if (nativeReasoning) {
        const json = await (await route.fetch()).json(); assert.equal(json.code,0,'native reasoning read');
        const labels = data.options; data = {...json.data, options:json.data.options.filter(o => labels.some(l => l.id === o.id)).map(o => ({...o,label:labels.find(l => l.id === o.id).label}))};
      }
      reads.push({body, data}); const gate = readGates.get(body.sessionId || ''); if (gate) { readGates.delete(body.sessionId || ''); held.push(gate); await gate.promise; }
      await route.fulfill({json:{code:0, data}});
      if (gate) gate.delivered = true;
    });
    await page.route('**/api/sessions/reasoning', async route => {
      const body = route.request().postDataJSON(); saves.push(body);
      const gate = saveGate; saveGate = null; if (gate) { held.push(gate); await gate.promise; }
      if (failSave) { failSave = false; return route.fulfill({status:500, json:{code:500,message:'fixture save unavailable'}}); }
      assert.ok(capability(body.sessionId).options.some(o => o.id === body.mode), 'UI submitted unsupported mode');
      modes.set(body.sessionId, body.mode);
      let data = capability(body.sessionId);
      if (nativeReasoning) {
        const json = await (await route.fetch()).json(); assert.equal(json.code,0,'native reasoning save');
        const labels = data.options; data = {...json.data, options:json.data.options.filter(o => labels.some(l => l.id === o.id)).map(o => ({...o,label:labels.find(l => l.id === o.id).label}))};
      }
      await route.fulfill({json:{code:0,data}});
    });
    let usageReasoning = 7;
    await page.route('**/api/sessions/events', async route => {
      const response = await route.fetch(), json = await response.json();
      for (const event of json.data?.events || []) if (event.type === 'turn/usage') event.payload = {in:100,out:20,reasoning:usageReasoning};
      await route.fulfill({response,json});
    });
    await page.goto(base); await page.waitForFunction(() => !document.getElementById('boot'));
    await page.evaluate(() => go('chat')); await page.waitForSelector('#chat-input');
    check('a visible reasoning menu exists next to the existing model picker', await page.locator('.composer-reasoning').count() === 1);
    const trigger = () => page.locator('.composer-reasoning');
    const menu = () => page.locator('.reasoning-menu');
    const open = async () => { if (await menu().isHidden()) await trigger().click(); };
    const option = id => menu().locator('[data-mode="' + id + '"]');
    const ready = label => until(async () => (await trigger().innerText()).includes(label), 'reasoning ' + label);
    const switchTo = sid => page.evaluate(id => openChatSession(id), sid);

    await ready('接口默认'); await open();
    check('all menu option IDs and labels come from the API', JSON.stringify(await menu().locator('[data-mode]').evaluateAll(bs => bs.map(b => [b.dataset.mode,b.textContent]))) === JSON.stringify([['default','接口默认'],['high','接口深度档']]));
    await option('high').click(); await ready('接口深度档');
    check('a pre-session choice stays local without a save request', saves.length === 0);
    await page.locator('#chat-input').fill('请用一句话解释工具调用的输入输出。'); await page.locator('.composer-send').click();
    await until(() => asks.length === 1, 'draft ask');
    const draftSid = asks[0].body.sessionId;
    check('draft choice is attached to the created session and frozen in ask-pi', draftSid && asks[0].body.reasoningMode === 'high' && saves.some(s => s.sessionId === draftSid && s.mode === 'high'));
    await page.waitForFunction(() => !state.busyTurn);
    await until(async () => (await page.locator('.composer-usage').innerText()).includes('思考 7'), 'reasoning usage');
    check('reasoning tokens display separately without adding to output', (await page.locator('.composer-usage').innerText()).includes('↑100 ↓20 · 思考 7'));
    usageReasoning = null; await switchTo(draftSid);
    check('nullable reasoning usage is hidden while output stays unchanged', (await page.locator('.composer-usage').innerText()).trim() === '↑100 ↓20');
    usageReasoning = 0; await switchTo(draftSid);
    check('an explicit zero reasoning usage is displayed', (await page.locator('.composer-usage').innerText()).includes('思考 0'));

    await switchTo(a); await ready('接口默认'); await open();
    const before = saves.length, saving = saveGate = deferred();
    await option('high').click(); await until(() => saves.length > before, 'held save');
    check('saving disables all mode choices and exposes busy state', await option('default').isDisabled() && await option('high').isDisabled() && await trigger().getAttribute('aria-busy') === 'true');
    await option('high').dispatchEvent('click');
    check('repeated activation cannot issue a second save', saves.length === before + 1);
    await switchTo(b); await ready('接口默认'); saving.resolve();
    await until(async () => (await trigger().getAttribute('aria-busy')) === 'false', 'B ready');
    check('A save completing late cannot change B selection', (await trigger().innerText()).includes('接口默认'));
    await switchTo(a); await ready('接口深度档');
    check('switching back restores A own saved selection', true);
    if (nativeReasoning) check('native core persisted A mode independently from B', (await post('agent/reasoning',{sessionId:a})).mode === 'high' && (await post('agent/reasoning',{sessionId:b})).mode === 'default');
    await open(); failSave = true; await option('default').click();
    await until(async () => (await menu().innerText()).includes('保存失败'), 'failure feedback');
    check('failed save restores selected value and enables retry', await option('default').isEnabled() && await option('high').getAttribute('aria-checked') === 'true');
    await option('default').click(); await ready('接口默认');
    check('retry succeeds after a failed save', modes.get(a) === 'default');

    // Cache invalidation by a real model role write gives deterministic stale reads.
    // Hold A at model 2, switch to B and resolve B before releasing A.
    const delayed = deferred(); readGates.set(a, delayed);
    await page.locator('.composer-row > .composer-model').click();
    await page.locator('.cm-model-item[data-model="reasoning-alt"]').click();
    await until(() => held.includes(delayed), 'A model refresh held');
    await switchTo(b); await ready('接口默认'); await open();
    await until(async () => await option('on').count() === 1, 'new model options');
    await option('on').click(); await ready('第二模型档位');
    delayed.resolve(); await until(() => delayed.delivered, 'A stale read delivered');
    check('model change refreshes options and late A default cannot overwrite B selected mode', await option('high').count() === 0 && (await trigger().innerText()).includes('第二模型档位'));
    await page.locator('#chat-input').click();
    await page.locator('.composer-row > .composer-model').click(); await page.locator('.cm-model-item[data-model="reasoning-unknown"]').click();
    await ready('接口默认'); await open();
    check('unknown model retains usable default, management entry and unavailable preference', (await menu().innerText()).includes('配置思考协议') && (await menu().innerText()).includes('原选择当前不可用') && await option('default').isEnabled() && await menu().getByRole('menuitem',{name:'管理模型',exact:true}).isVisible() && modes.get(b) === 'on');
    await menu().getByRole('menuitem',{name:'管理模型',exact:true}).click();
    await page.waitForFunction(() => document.getElementById('m-id')?.value === 'reasoning-unknown' && document.activeElement?.id === 'm-reasoning-profile');
    check('management opens the current model and focuses its protocol setting', await page.locator('#m-reasoning-profile').inputValue() === 'auto');
    await page.evaluate(() => go('chat')); await ready('接口默认');
    await page.locator('#chat-input').click();
    await page.locator('.composer-row > .composer-model').click(); await page.locator('.cm-model-item[data-model="reasoning-alt"]').click(); await ready('第二模型档位');

    await trigger().focus(); await page.keyboard.press('ArrowDown');
    check('keyboard opens and focuses a menu choice', await menu().locator('button:focus').count() === 1);
    await page.keyboard.press('Escape');
    check('Escape closes the menu and restores trigger focus', await menu().isHidden() && await trigger().evaluate(e => e === document.activeElement));
    const contrast = async () => page.locator('.composer-reasoning').evaluate(e => {
      const rgb = s => s.match(/[\d.]+/g).slice(0,3).map(Number).map(v => {v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
      const lum = s => rgb(s).reduce((n,v,i) => n+v*[.2126,.7152,.0722][i],0), style = getComputedStyle(e);
      const a = lum(style.color), b = lum(style.backgroundColor), box = e.getBoundingClientRect();
      return {ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),width:box.width,height:box.height,bg:style.backgroundColor};
    });
    const colours = [];
    for (const theme of ['light','dark']) {
      await page.evaluate(t => applyTheme(t), theme); await open();
      const c = await contrast(); colours.push(c.bg);
      check(theme + ' menu keeps readable contrast and desktop pointer target', c.ratio >= 4.5 && c.width >= 24 && c.height >= 24);
      await page.screenshot({path:path.join(dir, 'chat-' + theme + '.png')}); await trigger().click();
    }
    check('both theme surfaces actually differ', colours[0] !== colours[1]);

    await page.evaluate(() => go('settings','models')); await page.waitForSelector('#m-reasoning-profile');
    check('new model form defaults to the safe default profile', await page.locator('#m-reasoning-profile').inputValue() === 'auto' &&
      JSON.stringify(await page.locator('#m-reasoning-profile option').evaluateAll(xs => xs.map(x => x.value))) === JSON.stringify(['auto','deepseek','mimo','qwen-budget','openai','none']) &&
      JSON.stringify(await page.locator('#m-reasoning-profile option').evaluateAll(xs => xs.map(x => x.textContent))) === JSON.stringify(['默认','DeepSeek','MiMo','Qwen','OpenAI','不启用思考']) &&
      (await page.locator('#m-reasoning-profile').locator('xpath=following-sibling::p').innerText()).includes('未适配的网关不会额外发送'));
    await page.locator('#m-reasoning-profile').selectOption('deepseek');
    check('selecting an adapted vendor explains its actual controls', (await page.locator('#m-reasoning-profile').locator('xpath=following-sibling::p').innerText()).includes('低、高、极深'));
    await page.locator('#m-reasoning-profile').selectOption('none');
    check('explicitly disabling thinking is distinct from the default profile', (await page.locator('#m-reasoning-profile').locator('xpath=following-sibling::p').innerText()).includes('任何接口都不发送'));
    await page.locator('.item').filter({hasText:'本地仓颉检查模型'}).getByRole('button',{name:'填到表单',exact:true}).click();
    await page.locator('#m-reasoning-profile').selectOption('mimo'); await page.getByRole('button',{name:'保存模型',exact:true}).click();
    await until(() => modelSaves.length > 0, 'model save');
    check('reasoningProfile is submitted in the existing full model save', modelSaves.at(-1).reasoningProfile === 'mimo' && modelSaves.at(-1).model === originalModel.model && modelSaves.at(-1).baseUrl === originalModel.baseUrl);
    await page.waitForFunction(() => current === 'settings' && document.getElementById('m-id')?.value === '' && document.getElementById('view').getAttribute('aria-busy') === 'false');

    const resources = (await post('learning/resources',{kbId:'course-alpha'})).resources, ppt = resources.find(r => r.kind === 'ppt');
    await page.evaluate(r => go('study',r.id+'@'+r.version), ppt);
    await page.waitForSelector('.sp-chat-input'); await until(async () => !!await page.locator('.sp-chat-session').inputValue(), 'guided session');
    await ready('接口默认'); await open(); await option('on').click(); await ready('第二模型档位');
    const guidedSid = await page.locator('.sp-chat-session').inputValue();
    check('guided composer reuses the same menu and saves its own session', modes.get(guidedSid) === 'on' && await page.locator('.guided-model').isVisible());
    const asksBefore = asks.length;
    await page.locator('.sp-chat-input').fill('解释这一页的输入输出。'); await page.locator('.sp-chat-send').click();
    await until(() => asks.length > asksBefore, 'guided ask');
    check('guided ask uses guided session reasoning instead of normal chat state', asks.at(-1).body.sessionId === guidedSid && asks.at(-1).body.reasoningMode === 'on');
    await until(async () => !(await page.locator('.sp-chat-send').getAttribute('class')).includes('stop'), 'guided answer', 30000);
    await open();
    const stableOption = await option('on').elementHandle(); await stableOption.focus();
    const polled = await page.evaluate(async sid => {
      const option = document.querySelector('.reasoning-menu [data-mode="on"]');
      for (let i = 0; i < 8; i++) {
        const data = await api('/api/sessions/events',{sessionId:sid});
        if (!data.events.some(e => e.type === 'turn/usage')) throw Error('Polling regression requires real usage history');
        await new Promise(resolve => setTimeout(resolve,40));
      }
      return {same:option === document.querySelector('.reasoning-menu [data-mode="on"]'),focused:document.activeElement === option};
    }, guidedSid);
    check('repeated full-history usage polls preserve the open option DOM and focus', polled.same && polled.focused && await stableOption.evaluate(e => e.isConnected));
    // A changed usage value may update the counter but must still leave this menu intact.
    usageReasoning = 9;
    await page.evaluate(sid => api('/api/sessions/events',{sessionId:sid}), guidedSid);
    check('changed usage updates the label without replacing the same mode option', await stableOption.evaluate(e => e === document.querySelector('.reasoning-menu [data-mode="on"]')) && (await page.locator('.sp-chat-composer > .composer-usage').innerText()).includes('思考 9'));
    await stableOption.click();
    await option('default').click(); await ready('接口默认');
    await option('on').click(); await ready('第二模型档位');
    check('mode choices remain clickable after repeated polling', modes.get(guidedSid) === 'on');
    await trigger().click();
    for (const theme of ['light','dark']) {
      await page.evaluate(t => applyTheme(t), theme); await open();
      const bounds = await page.locator('.reasoning-menu').boundingBox(), host = await page.locator('.sp-study-chat').boundingBox();
      check(theme + ' guided menu stays within the side column', bounds.x >= host.x - 1 && bounds.x + bounds.width <= host.x + host.width + 1);
      await page.screenshot({path:path.join(dir,'guided-' + theme + '.png')}); await trigger().click();
    }
    await page.getByRole('button',{name:'新建会话',exact:true}).click();
    await until(async () => await page.locator('.sp-chat-session').inputValue() !== guidedSid, 'new guided session'); await ready('接口默认');
    check('new guided session does not inherit the previous session preference', true);
    await page.locator('.sp-chat-session').selectOption(guidedSid); await ready('第二模型档位');
    check('returning to guided session restores its own mode', true);
    await page.setViewportSize({width:900,height:900}); await page.getByRole('button',{name:'打开对话',exact:true}).click(); await open();
    const narrow = await page.locator('.reasoning-menu').boundingBox();
    check('guided menu stays on screen in the narrow drawer', narrow.x >= 0 && narrow.x + narrow.width <= 901);
    await page.emulateMedia({reducedMotion:'reduce'}); await page.screenshot({path:path.join(dir,'guided-narrow.png')});
    await page.evaluate(() => go('chat')); await ready('第二模型档位');
    check('normal conversation selection survives leaving the guide', await page.evaluate(() => state.chatSessionId) === b);
    const taskStart = asks.length;
    await page.evaluate(() => { generateArtifact('lecture','检查思考档位传递').catch(e => {throw e;}); });
    await until(() => asks.length > taskStart, 'task request');
    check('task-pi receives the frozen selected reasoning mode', asks.at(-1).path.endsWith('task-pi') && asks.at(-1).body.reasoningMode === 'on');
    await until(async () => await page.locator('.gen-card').count() === 0, 'task completed', 30000);
    check('no browser JavaScript errors', errors.length === 0);
    console.log('RESULT=OK ' + passed + ' checks; artifacts=' + dir);
  } catch (e) {
    if (page) await page.screenshot({path:path.join(dir,'failure.png')}).catch(() => {});
    console.error('FAIL artifacts=' + dir); throw e;
  } finally {
    for (const gate of held) gate.resolve();
    if (browser) await browser.close(); core.kill();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
