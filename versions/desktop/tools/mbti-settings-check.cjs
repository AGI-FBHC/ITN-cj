/** Real Edge + isolated Cangjie kernel check for the MBTI profile controls. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {chromium} = require(require.resolve('playwright', {paths: ['D:/Desktop/ITN/ITN/src/frontend/agent-demo', path.resolve(__dirname, '..')]}));

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-mbti-'));
const portFile = path.join(dataDir, 'port');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let core, browser;
const passed = [];
const check = (name, ok, detail = '') => { if (!ok) throw new Error(name + (detail ? ' :: ' + detail : '')); passed.push(name); console.log('PASS ' + name); };

(async () => {
  try {
    core = spawn(process.env.MBTI_CORE || path.join(root, 'dist/core/itn-desktop-core.exe'), ['--data-dir=' + dataDir, '--port-file=' + portFile, '--ui-dir=' + (process.env.ITN_UI_DIR || path.join(root, 'shell/renderer'))], {windowsHide: true, stdio: 'ignore', env: {...process.env, cjHeapSize: '2GB'}});
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await sleep(100);
    assert(fs.existsSync(portFile), 'kernel did not start');
    const base = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').trim();
    const post = async (route, body = {}) => {
      const response = await fetch(base + '/api/' + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      const payload = await response.json();
      if (payload.code !== 0) throw new Error(route + ': ' + payload.message);
      return payload.data;
    };
    await post('models/save', {id: 'mbti-fixture', name: 'MBTI 测试模型', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only', model: 'fixture'});
    await post('models/roles', {chatModelId: 'mbti-fixture'});
    browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => !document.getElementById('boot'), null, {timeout: 20000});
    await page.evaluate(() => go('settings', 'general'));
    await page.waitForFunction(() => current === 'settings' && document.querySelector('#pf-mbti') && document.getElementById('view')?.getAttribute('aria-busy') === 'false');
    check('settings exposes both MBTI selectors', await page.locator('#pf-mbti').count() === 1 && await page.locator('#pf-lumin-mbti').count() === 1);
    check('Lumin defaults to ENFJ while the user type is unknown', await page.locator('#pf-mbti').inputValue() === '' && await page.locator('#pf-lumin-mbti').inputValue() === 'ENFJ');

    await page.locator('#pf-mbti').selectOption('INFP');
    await page.locator('#pf-lumin-mbti').selectOption('INTJ');
    await page.evaluate(async()=>{await go('chat');await go('settings','general');});
    const saved = await post('profile/get');
    check('changing both MBTI selectors and leaving immediately saves without the profile button', saved.mbtiType === 'INFP' && saved.luminMbtiType === 'INTJ');

    await page.evaluate(() => go('settings', 'general'));
    await page.waitForFunction(() => document.querySelector('#pf-mbti')?.value === 'INFP' && document.querySelector('#pf-lumin-mbti')?.value === 'INTJ');
    check('saved MBTI choices survive a settings rerender', true);

    await page.locator('#pf-mbti').selectOption('INTP');
    await page.locator('#pf-mbti').selectOption('ISFP');
    await page.locator('#pf-lumin-mbti').selectOption('ENTP');
    await page.locator('#pf-lumin-mbti').selectOption('ISTJ');
    await page.evaluate(async()=>{await go('chat');await go('settings','general');});
    const rapid=await post('profile/get');
    check('rapid edits followed by navigation keep the last choice for each side',rapid.mbtiType==='ISFP'&&rapid.luminMbtiType==='ISTJ');

    await post('profile/save',{mbtiType:'ENTJ',luminMbtiType:'ENFP',goal:'外部刚更新的目标'});
    await page.evaluate(()=>saveProfile({selfScores:{'概念理解':61}}));
    const external=await post('profile/get');
    check('saving self scores from a stale page cannot overwrite external MBTI or goal changes',external.mbtiType==='ENTJ'&&external.luminMbtiType==='ENFP'&&external.goal==='外部刚更新的目标'&&external.selfScores['概念理解']===61);
    await page.locator('#pf-nick').fill('只改称呼');
    await page.getByRole('button',{name:'保存档案',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#pf-mbti')?.value==='ENTJ'&&document.querySelector('#pf-lumin-mbti')?.value==='ENFP');
    const formSaved=await post('profile/get');
    check('the profile save button sends only edited fields and preserves external MBTI and goal',formSaved.nickname==='只改称呼'&&formSaved.mbtiType==='ENTJ'&&formSaved.luminMbtiType==='ENFP'&&formSaved.goal==='外部刚更新的目标');

    let readReady,releaseRead;
    const readStarted=new Promise(resolve=>{readReady=resolve;});
    const readGate=new Promise(resolve=>{releaseRead=resolve;});
    await page.route('**/api/profile/get',async route=>{const response=await route.fetch();readReady();await readGate;await route.fulfill({response});},{times:1});
    await page.evaluate(()=>{window.__lateProfile=loadProfile(true);});
    await readStarted;
    await page.evaluate(()=>saveProfile({mbtiType:'ISTP'}));
    releaseRead();
    await page.evaluate(()=>window.__lateProfile);
    check('a pre-save read that arrives late cannot roll back the saved profile',await page.evaluate(()=>state.profile.mbtiType==='ISTP'));

    await page.evaluate(()=>go('settings','general'));
    await page.waitForSelector('#pf-mbti');
    await page.route('**/api/profile/save',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:503,message:'保存失败测试'})}),{times:1});
    await page.locator('#pf-mbti').selectOption('ENFP');
    await page.waitForFunction(()=>document.querySelector('.mbti-save-status')?.textContent==='保存失败');
    check('save failures are visible and do not pretend to persist',(await post('profile/get')).mbtiType==='ISTP');
    await page.getByRole('button',{name:'重试',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.mbti-save-status')?.textContent==='已保存');
    check('failed selections can be retried without changing them again',(await post('profile/get')).mbtiType==='ENFP');

    let writeReady,releaseWrite;
    const writeStarted=new Promise(resolve=>{writeReady=resolve;});
    const writeGate=new Promise(resolve=>{releaseWrite=resolve;});
    await page.route('**/api/profile/save',async route=>{writeReady();await writeGate;await route.continue();},{times:1});
    await page.locator('#pf-nick').fill('保存后不抢回页面');
    await page.getByRole('button',{name:'保存档案',exact:true}).click();
    await writeStarted;
    await page.evaluate(()=>go('chat'));
    releaseWrite();
    await page.waitForFunction(async()=>{const p=await fetch('/api/profile/get',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json());return p.data?.nickname==='保存后不抢回页面';});
    await page.evaluate(()=>loadProfile(true));
    check('completing a profile save after navigation does not force the settings page back',await page.evaluate(()=>current==='chat'));

    await page.evaluate(()=>go('settings','general'));
    await page.waitForSelector('#pf-mbti');
    await page.locator('#pf-mbti').selectOption('INFP');
    await page.locator('#pf-lumin-mbti').selectOption('INTJ');
    await page.waitForFunction(()=>document.querySelector('.mbti-save-status')?.textContent==='已保存');
    await page.reload();
    await page.waitForSelector('#pf-mbti');
    check('saved selections survive an actual browser reload',await page.locator('#pf-mbti').inputValue()==='INFP'&&await page.locator('#pf-lumin-mbti').inputValue()==='INTJ');

    let releaseStart;
    const started = new Promise(resolve => { releaseStart=resolve; });
    let startRequests=0;
    await page.route('**/api/profile/mbti/start',async route=>{startRequests++;await started;await route.continue();});
    await page.getByRole('button', {name: '偏好问答',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.mbti-help button')?.disabled);
    check('assessment entry shows a pending state and rejects duplicate clicks',await page.locator('.mbti-help button').isDisabled());
    await page.locator('.mbti-help button').evaluate(b=>{b.click();b.click();});
    releaseStart();
    await page.waitForFunction(() => current === 'chat' && document.querySelector('#chat-input')?.value.includes('MBTI 偏好问答'), null, {timeout: 20000});
    check('unknown-type link opens a prepared assessment conversation',startRequests===1);
    const sessions = (await post('sessions/list', {force: true})).sessions || [];
    const sessionId = await page.evaluate(() => state.chatSessionId);
    check('assessment link creates a real chat session', sessions.some(s => s.sessionId === sessionId));
    const assessment=await post('profile/mbti/state');
    check('assessment has a persisted first question',assessment.sessionId===sessionId&&assessment.currentQuestion?.id==='q1'&&assessment.answered===0);
    const same=await Promise.all([post('profile/mbti/start'),post('profile/mbti/start')]);
    check('concurrent start requests resume the same assessment',same.every(a=>a.sessionId===sessionId));
    await page.evaluate(()=>go('settings','general'));
    await page.waitForSelector('.mbti-help button');
    await page.getByRole('button',{name:'偏好问答',exact:true}).click();
    await page.waitForFunction(sid=>current==='chat'&&state.chatSessionId===sid,sessionId);
    check('leaving and reopening keeps the same dedicated session',true);
    await page.evaluate(()=>go('settings','general'));
    await page.waitForSelector('#pf-mbti');
    await post('profile/save',{goal:'只修改目标'});
    const partial=await post('profile/get');
    check('partial profile updates preserve both MBTI choices',partial.mbtiType==='INFP'&&partial.luminMbtiType==='INTJ');
    for(const theme of ['light','dark']){
      await page.evaluate(t=>applyTheme(t),theme);await page.waitForTimeout(450);
      await page.screenshot({path:path.join(dataDir,'settings-'+theme+'.png')});
    }
    check('no renderer exceptions', errors.length === 0, errors.join(' | '));
    console.log('RESULT=OK ' + passed.length + ' checks; data=' + dataDir);
  } finally {
    if (browser) await browser.close();
    if (core) core.kill();
  }
})().catch(e => { console.error('RESULT=FAILED ' + e.stack); process.exitCode = 1; });
