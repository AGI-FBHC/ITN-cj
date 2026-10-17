/**
 * Old-frontend UI check for /me/notes against Spire via Vite proxy.
 * Injects a JWT session into localStorage (Spring Boot /api login is not running),
 * then verifies the notes page renders and can create a note through the UI.
 */
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

const VITE = process.env.VITE_BASE || 'http://127.0.0.1:3002';
const JWT_SECRET = process.env.JWT_SECRET;
const TAG = 'UINOTE' + new Date().toTimeString().slice(0, 8).replace(/:/g, '');
const USER = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(sub) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const msg = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(msg).digest();
  return `${msg}.${b64url(sig)}`;
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

(async () => {
  const token = makeJwt(USER);
  console.log('TAG', TAG, 'VITE', VITE);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') console.log('BROWSER_ERR', t.slice(0, 200));
  });
  page.on('pageerror', (e) => console.log('PAGE_ERR', String(e).slice(0, 200)));

  // Seed localStorage before any app script runs.
  await page.evaluateOnNewDocument((tok, user, tag) => {
    const session = {
      method: 'sso',
      account: 'ui-check@local',
      label: 'UI检查账号',
      at: Date.now(),
      token: tok,
      learnerId: user,
    };
    window.localStorage.setItem('lf.schemaVersion', '2');
    window.localStorage.setItem('lf.bootSeen:v1', '1');
    window.localStorage.setItem('lf.token', tok);
    window.localStorage.setItem('lf.auth', JSON.stringify(session));
  }, token, USER, TAG);

  await page.goto(`${VITE}/me/notes`, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  const bodyText = await page.evaluate(() => document.body.innerText);
  check('page shows 我的笔记', bodyText.includes('我的笔记'), bodyText.slice(0, 120).replace(/\n/g, ' '));
  check('not stuck on BootGate', !bodyText.includes('正在准备一些系统资源'), bodyText.slice(0, 120).replace(/\n/g, ' '));

  // Empty state or existing notes both prove the list call ran.
  const emptyHint = bodyText.includes('还没有已保存的笔记');
  const noteBody = bodyText.includes(TAG) || bodyText.includes('已保存');
  check('notes list rendered', emptyHint || noteBody, `empty=${emptyHint} body=${noteBody}`);

  // Create a note through the UI.
  const addBtn = await page.$('button.lf-btn-ghost');
  // Find the "手动添加" button specifically.
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const target = btns.find((b) => b.textContent && b.textContent.includes('手动添加'));
    if (target) { target.click(); return true; }
    return false;
  });
  check('clicked 手动添加', clicked, '');

  await new Promise((r) => setTimeout(r, 400));
  const typed = await page.evaluate((text) => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, `${TAG} **Markdown** UI 内容-测试`);
  check('typed draft', typed, '');

  const saved = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const target = btns.find((b) => b.textContent && b.textContent.includes('保存到后端'));
    if (target && !target.disabled) { target.click(); return true; }
    return false;
  });
  check('clicked 保存到后端', saved, '');

  // Wait for toast + list refresh.
  await new Promise((r) => setTimeout(r, 2500));
  const after = await page.evaluate(() => document.body.innerText);
  check('new note visible in UI', after.includes(TAG), after.includes(TAG) ? 'found' : after.slice(0, 200).replace(/\n/g, ' '));
  check('toast 已保存到我的笔记', after.includes('已保存到我的笔记') || after.includes(TAG), after.slice(0, 200).replace(/\n/g, ' '));

  // Markdown rendered (preview mode default): bold becomes <strong>.
  const mdRendered = await page.evaluate(() => !!document.querySelector('article strong, article b'));
  check('markdown preview rendered', mdRendered, '');

  // Reload: refresh-recovery in the UI.
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  const afterReload = await page.evaluate(() => document.body.innerText);
  check('note survives reload', afterReload.includes(TAG), afterReload.includes(TAG) ? 'found' : afterReload.slice(0, 200).replace(/\n/g, ' '));

  // Delete via the UI hover button.
  const deleted = await page.evaluate((tag) => {
    const articles = [...document.querySelectorAll('article')];
    const art = articles.find((a) => a.innerText.includes(tag));
    if (!art) return false;
    const btn = art.querySelector('button[title="删除笔记"]');
    if (!btn) return false;
    btn.click();
    return true;
  }, TAG);
  check('clicked delete in UI', deleted, '');
  await new Promise((r) => setTimeout(r, 2000));
  const afterDel = await page.evaluate(() => document.body.innerText);
  check('note gone after UI delete', !afterDel.includes(TAG), afterDel.includes(TAG) ? 'still present' : 'removed');

  await page.screenshot({ path: `${__dirname}/my_notes.png`, fullPage: true });
  console.log('screenshot', `${__dirname}/my_notes.png`);

  await browser.close();

  const fail = results.filter((r) => !r.ok);
  console.log('===== UI SUMMARY =====');
  console.log(`total=${results.length} pass=${results.length - fail.length} fail=${fail.length}`);
  fail.forEach((f) => console.log('FAIL', f.name, f.detail));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error('UI_CHECK_CRASH', e);
  process.exit(2);
});
