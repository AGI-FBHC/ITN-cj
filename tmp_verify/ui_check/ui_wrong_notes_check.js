/**
 * Old-frontend UI check: notes + wrong-book pages against Spire via Vite proxy.
 *
 * Spring Boot /api login is not running, so we inject a JWT session into
 * localStorage. Edge's default profile is already open (puppeteer.launch
 * fails), so we start Edge with --remote-debugging-port and connect.
 *
 * Waits on request/response (not fixed sleeps only) — remote MySQL can take
 * several seconds, and a pending fetch must not look like a missing API call.
 */
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VITE = process.env.VITE_BASE || 'http://localhost:3002';
const JWT_SECRET = process.env.JWT_SECRET;
const TAG = 'UIWB' + new Date().toTimeString().slice(0, 8).replace(/:/g, '');
const USER = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const RDP = Number(process.env.EDGE_RDP || 9333);
const UDIR = `C:/Users/Lenovo/AppData/Local/Temp/edge-uiwb-${process.pid}`;
const NET_WAIT_MS = Number(process.env.NET_WAIT_MS || 25000);

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

function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const hit = predicate();
      if (hit) return resolve(hit);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function connectEdge() {
  const child = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${UDIR}`,
    `--remote-debugging-port=${RDP}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`http://127.0.0.1:${RDP}/json/version`);
      if (res.ok) {
        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${RDP}` });
        return { browser, child };
      }
    } catch {
      /* keep polling */
    }
  }
  child.kill();
  throw new Error('Edge remote debugging did not come up');
}

(async () => {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is required');
  const token = makeJwt(USER);
  console.log('TAG', TAG, 'VITE', VITE, 'RDP', RDP);

  const { browser, child } = await connectEdge();
  const page = await browser.newPage();
  const v1Traffic = [];
  const v1Requests = [];

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/v1/')) return;
    const line = `${req.method()} ${url.replace(VITE, '')}`;
    v1Requests.push(line);
    console.log('REQ', line);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (!url.includes('/v1/')) return;
    console.log('REQ_FAIL', req.method(), url.replace(VITE, ''), req.failure()?.errorText || '');
    v1Traffic.push(`FAIL ${req.method()} ${url.replace(VITE, '')} ${req.failure()?.errorText || ''}`);
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/v1/')) return;
    let bodySnippet = '';
    try { bodySnippet = (await res.text()).slice(0, 160); } catch { /* ignore */ }
    const line = `${res.status()} ${res.request().method()} ${url.replace(VITE, '')} ${bodySnippet}`;
    v1Traffic.push(line);
    console.log('V1', res.status(), res.request().method(), url.replace(VITE, ''), bodySnippet.slice(0, 100));
  });
  page.on('pageerror', (e) => console.log('PAGE_ERR', String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('BROWSER_ERR', m.text().slice(0, 300));
  });

  await page.evaluateOnNewDocument((tok, user) => {
    const session = {
      method: 'sso',
      account: 'ui-check@local',
      label: 'UI检查账号',
      at: Date.now(),
      token: tok,
      learnerId: user,
    };
    // RequireAuth redirects sso/sms/wechat to /welcome when knownOf(account) is null.
    // Seed lf.knownAccounts so notes/wrong pages are reachable without Spring Boot /api.
    const known = { 'ui-check@local': { learnerId: user, lastAt: Date.now() } };
    window.localStorage.setItem('lf.schemaVersion', '2');
    window.localStorage.setItem('lf.bootSeen:v1', '1');
    window.localStorage.setItem('lf.token', tok);
    window.localStorage.setItem('lf.auth', JSON.stringify(session));
    window.localStorage.setItem('lf.knownAccounts', JSON.stringify(known));
  }, token, USER);

  // ---- notes page ----
  await page.goto(`${VITE}/me/notes`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitFor(() => v1Traffic.some((t) => t.includes('/v1/notes')), NET_WAIT_MS);
  await new Promise((r) => setTimeout(r, 800));
  let body = await page.evaluate(() => document.body.innerText);
  check('notes page shows 我的笔记', body.includes('我的笔记'), body.slice(0, 120).replace(/\n/g, ' '));
  check('notes not stuck on BootGate', !body.includes('正在准备一些系统资源'), body.slice(0, 120).replace(/\n/g, ' '));
  check('notes list rendered',
    body.includes('还没有已保存的笔记') || body.includes('已保存') || body.includes(TAG),
    body.slice(0, 120).replace(/\n/g, ' '));

  // create a note through the UI
  let clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('手动添加'));
    if (btn) { btn.click(); return true; }
    return false;
  });
  check('notes clicked 手动添加', clicked, '');
  await new Promise((r) => setTimeout(r, 400));
  let typed = await page.evaluate((text) => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, `${TAG} **Markdown** UI 内容`);
  check('notes typed draft', typed, '');
  const notesBeforeCreate = v1Traffic.length;
  let saved = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('保存到后端'));
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  });
  check('notes clicked 保存到后端', saved, '');

  const postHit = await waitFor(
    () => v1Traffic.find((t) => t.includes('POST /v1/notes') && !t.startsWith('FAIL')),
    NET_WAIT_MS,
  );
  check('notes POST /v1/notes captured', !!postHit,
    postHit || `no POST after create (traffic +${v1Traffic.length - notesBeforeCreate}: ${v1Traffic.slice(notesBeforeCreate).join(' || ') || 'none'})`);
  check('notes POST /v1/notes 201', !!postHit && postHit.startsWith('201'), postHit || '');

  // UI should pick up the created note (setNotes after createNote resolves)
  let visible = false;
  {
    const start = Date.now();
    while (Date.now() - start < NET_WAIT_MS) {
      visible = await page.evaluate((tag) => document.body.innerText.includes(tag), TAG);
      if (visible) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  body = await page.evaluate(() => document.body.innerText);
  check('note visible in UI', visible, visible ? 'found' : body.slice(0, 160).replace(/\n/g, ' '));

  // reload: NotesContext listNotes must return the new note
  const trafficLenBeforeReload = v1Traffic.length;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  const reloadGet = await waitFor(
    () => v1Traffic.slice(trafficLenBeforeReload).find((t) => t.includes('GET /v1/notes')),
    NET_WAIT_MS,
  );
  await new Promise((r) => setTimeout(r, 600));
  body = await page.evaluate(() => document.body.innerText);
  check('note survives reload', body.includes(TAG), body.includes(TAG) ? 'found' : `${(reloadGet || 'no GET').slice(0, 80)} | ${body.slice(0, 120).replace(/\n/g, ' ')}`);

  await page.screenshot({ path: `${__dirname}/my_notes.png`, fullPage: true });

  // ---- wrong book page ----
  const trafficLenBeforeWrong = v1Traffic.length;
  await page.goto(`${VITE}/me/wrong`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const wrongGet = await waitFor(
    () => v1Traffic.slice(trafficLenBeforeWrong).find((t) => t.includes('/v1/wrong-answers')),
    NET_WAIT_MS,
  );
  const wrongReq = await waitFor(
    () => v1Requests.find((t) => t.includes('/v1/wrong-answers')),
    3000,
  );
  await new Promise((r) => setTimeout(r, 800));
  body = await page.evaluate(() => document.body.innerText);
  check('wrong page loaded', body.includes('错题') || body.includes('重做') || body.includes('暂无'),
    body.slice(0, 160).replace(/\n/g, ' '));
  check('wrong not stuck on BootGate', !body.includes('正在准备一些系统资源'), body.slice(0, 120).replace(/\n/g, ' '));

  let leftLoading = true;
  {
    const start = Date.now();
    while (Date.now() - start < NET_WAIT_MS) {
      body = await page.evaluate(() => document.body.innerText);
      if (!body.includes('正在读取后端错题记录')) { leftLoading = false; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  body = await page.evaluate(() => document.body.innerText);
  check('wrong list left loading state', !leftLoading,
    leftLoading ? `still loading; req=${wrongReq || 'none'} resp=${wrongGet || 'none'}` : body.slice(0, 160).replace(/\n/g, ' '));

  check('front called /v1 APIs', v1Traffic.some((t) => t.includes('/v1/')) || v1Requests.length > 0,
    v1Traffic.slice(0, 8).join(' || ') || 'no /v1 traffic');
  check('wrong GET /v1/wrong-answers 200', !!wrongGet && wrongGet.startsWith('200'),
    wrongGet || `no response; requests=${v1Requests.filter((t) => t.includes('wrong')).join(' || ') || 'none'}`);

  await page.screenshot({ path: `${__dirname}/wrong_book.png`, fullPage: true });
  console.log('screenshot', `${__dirname}/my_notes.png`, `${__dirname}/wrong_book.png`);
  console.log('V1_REQUESTS');
  v1Requests.forEach((t) => console.log(' ', t));
  console.log('V1_TRAFFIC');
  v1Traffic.forEach((t) => console.log(' ', t));

  await browser.close();
  try { child.kill(); } catch { /* ignore */ }

  const fail = results.filter((r) => !r.ok);
  console.log('===== UI SUMMARY =====');
  console.log(`total=${results.length} pass=${results.length - fail.length} fail=${fail.length}`);
  fail.forEach((f) => console.log('FAIL', f.name, f.detail));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error('UI_CHECK_CRASH', e);
  process.exit(2);
});
