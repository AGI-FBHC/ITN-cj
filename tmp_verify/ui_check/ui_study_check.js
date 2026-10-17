/**
 * 我的学习 UI check: courses / resources (quiz grading) / presentations
 * (slides data layer) / sessions pages against Spire via the Vite proxy.
 *
 * Same harness as ui_wrong_notes_check.js: Spring Boot /api login is not
 * running, so a JWT session is injected into localStorage (lf.knownAccounts).
 * Edge connects via --remote-debugging-port; waits on real request/response
 * traffic (remote MySQL can take seconds).
 *
 * Required env: JWT_SECRET, VITE_BASE, UI_TAG, UI_QUIZ_ID, UI_COURSE_ID,
 * UI_CHAPTER_ID, UI_PPT_ID, UI_SESSION_ID.
 */
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VITE = process.env.VITE_BASE || 'http://localhost:3002';
const JWT_SECRET = process.env.JWT_SECRET;
const TAG = process.env.UI_TAG || 'UISTUDY';
const UI_QUIZ_ID = process.env.UI_QUIZ_ID || '';
const UI_COURSE_ID = process.env.UI_COURSE_ID || '';
const UI_CHAPTER_ID = process.env.UI_CHAPTER_ID || '';
const UI_PPT_ID = process.env.UI_PPT_ID || '';
const UI_SESSION_ID = process.env.UI_SESSION_ID || '';
const USER = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const RDP = Number(process.env.EDGE_RDP || 9341);
const UDIR = `C:/Users/Lenovo/AppData/Local/Temp/edge-uist-${process.pid}`;
const NET_WAIT_MS = Number(process.env.NET_WAIT_MS || 30000);

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

function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      let hit;
      try {
        hit = await predicate();
      } catch {
        hit = null;
      }
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
  for (const [k, v] of Object.entries({ UI_QUIZ_ID, UI_COURSE_ID, UI_CHAPTER_ID, UI_PPT_ID, UI_SESSION_ID })) {
    if (!v) throw new Error(`${k} is required`);
  }
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
    const known = { 'ui-check@local': { learnerId: user, lastAt: Date.now() } };
    window.localStorage.setItem('lf.schemaVersion', '2');
    window.localStorage.setItem('lf.bootSeen:v1', '1');
    window.localStorage.setItem('lf.token', tok);
    window.localStorage.setItem('lf.auth', JSON.stringify(session));
    window.localStorage.setItem('lf.knownAccounts', JSON.stringify(known));
  }, token, USER);

  const mark = (from) => v1Traffic.slice(from);

  // ---- 1. courses: /me (我的学习 hub -> useCourseLearning -> GET /v1/courses) ----
  let from = v1Traffic.length;
  await page.goto(`${VITE}/me`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const coursesGet = await waitFor(
    () => mark(from).find((t) => t.includes('GET /v1/courses') && t.startsWith('200')),
    NET_WAIT_MS,
  );
  await new Promise((r) => setTimeout(r, 1000));
  let body = await page.evaluate(() => document.body.innerText);
  check('me GET /v1/courses 200', !!coursesGet, coursesGet || mark(from).join(' || ').slice(0, 160));
  check('me page 我的学习 loaded', body.includes('我的学习') || body.includes('继续') || body.includes('学习'),
    body.slice(0, 140).replace(/\n/g, ' '));
  check('me not stuck on BootGate', !body.includes('正在准备一些系统资源'),
    body.slice(0, 140).replace(/\n/g, ' '));
  await page.screenshot({ path: `${__dirname}/study_me.png`, fullPage: true });

  // ---- 2. resources + quiz grading ----
  from = v1Traffic.length;
  const resUrl = `${VITE}/resources?courseId=${UI_COURSE_ID}&chapterId=${UI_CHAPTER_ID}&tab=quiz`;
  await page.goto(resUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const resGet = await waitFor(
    () => mark(from).find((t) => t.includes('GET /v1/learning-resources/') && t.startsWith('200')),
    NET_WAIT_MS,
  );
  // wait for the quiz UI itself (remote DB load can take seconds)
  await waitFor(async () => {
    const t = await page.evaluate(() => document.body.innerText);
    return t.includes(TAG) && !t.includes('正在读取课程资源');
  }, NET_WAIT_MS);
  await new Promise((r) => setTimeout(r, 500));
  body = await page.evaluate(() => document.body.innerText);
  check('resources GET /v1/learning-resources 200', !!resGet,
    resGet || mark(from).join(' || ').slice(0, 200));
  check('resources shows quiz', body.includes(TAG) && !body.includes('正在读取课程资源'),
    body.slice(0, 160).replace(/\n/g, ' '));
  check('resources not stuck on BootGate', !body.includes('正在准备一些系统资源'),
    body.slice(0, 120).replace(/\n/g, ' '));

  // click the first quiz option (QuizContent renders "A." + option text buttons)
  from = v1Traffic.length;
  const clicked = await waitFor(async () => {
    const hit = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('button')].filter((b) => {
        const t = (b.textContent || '').trim();
        return /^[A-D]\./.test(t) && t.length < 60 && !b.disabled;
      });
      const target = cands[0];
      if (target) { target.click(); return (target.textContent || '').slice(0, 30); }
      return null;
    });
    return hit;
  }, NET_WAIT_MS);
  check('quiz option clicked', !!clicked, String(clicked));
  const answerPost = await waitFor(
    () => mark(from).find((t) => t.includes('/answers') && (t.startsWith('200') || t.startsWith('201'))),
    NET_WAIT_MS,
  );
  const answerFail = mark(from).find((t) => t.includes('/answers') && (t.startsWith('4') || t.startsWith('5') || t.startsWith('FAIL')));
  check('quiz POST answers 200', !!answerPost && !answerFail,
    answerPost || answerFail || mark(from).join(' || ').slice(0, 200));
  check('quiz answer body has correct flag', !!answerPost && /correct/.test(answerPost),
    (answerPost || '').slice(0, 160));
  await new Promise((r) => setTimeout(r, 600));
  body = await page.evaluate(() => document.body.innerText);
  check('quiz feedback rendered (回答正确/回答错误)', body.includes('回答正确') || body.includes('回答错误'),
    body.slice(0, 160).replace(/\n/g, ' '));
  await page.screenshot({ path: `${__dirname}/study_resources_quiz.png`, fullPage: true });

  // ---- 3. presentations (slides data layer) ----
  from = v1Traffic.length;
  await page.goto(`${VITE}/learn/ppt-preview/${UI_PPT_ID}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const pptGet = await waitFor(
    () => mark(from).find((t) => t.includes(`/v1/presentations/${UI_PPT_ID}`) && !t.includes('/slides')
      && (t.startsWith('200') || t.startsWith('304'))),
    NET_WAIT_MS,
  );
  await new Promise((r) => setTimeout(r, 1000));
  body = await page.evaluate(() => document.body.innerText);
  check('ppt-preview GET /v1/presentations/{id} 200', !!pptGet,
    pptGet || mark(from).join(' || ').slice(0, 200));
  check('ppt-preview renders title/slide data', body.includes(TAG) || body.includes('幻灯片') || body.includes('课件')
    || body.includes('讲解') || body.includes('标题页说明'),
    body.slice(0, 160).replace(/\n/g, ' '));
  check('ppt-preview not stuck on BootGate', !body.includes('正在准备一些系统资源'),
    body.slice(0, 120).replace(/\n/g, ' '));
  await page.screenshot({ path: `${__dirname}/study_ppt_preview.png`, fullPage: true });

  // slides endpoint itself (data layer, independent of render)
  from = v1Traffic.length;
  const slidesStatus = await page.evaluate(async (taskId) => {
    const res = await fetch(`/v1/presentations/${taskId}/slides`, {
      headers: { Authorization: `Bearer ${window.localStorage.getItem('lf.token') || ''}` },
    });
    let n = -1;
    let shape = '';
    try {
      const data = await res.json();
      // real payload: {slideCount, imageUrl, audioUrl, speakerNotes[], teachingMoments[], audioAvailable[]}
      shape = Object.keys(data || {}).join(',');
      n = typeof data?.slideCount === 'number' ? data.slideCount : -2;
    } catch { /* ignore */ }
    return { status: res.status, n, shape };
  }, UI_PPT_ID);
  check('slides GET /v1/presentations/{id}/slides 200', slidesStatus.status === 200, JSON.stringify(slidesStatus));
  check('slides payload has slideCount', slidesStatus.n >= 1, JSON.stringify(slidesStatus));

  // ---- 4. sessions (AgentContext -> GET /v1/agent-sessions; dock select lists titles) ----
  from = v1Traffic.length;
  await page.goto(`${VITE}/agents`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const sessGet = await waitFor(
    () => mark(from).find((t) => t.includes('GET /v1/agent-sessions') && t.startsWith('200')),
    NET_WAIT_MS,
  );
  await new Promise((r) => setTimeout(r, 1200));
  check('agents GET /v1/agent-sessions 200', !!sessGet, sessGet || mark(from).join(' || ').slice(0, 200));

  // data layer: the sessions payload itself must carry the seeded title
  const sessJson = await page.evaluate(async () => {
    const res = await fetch('/v1/agent-sessions', {
      headers: { Authorization: `Bearer ${window.localStorage.getItem('lf.token') || ''}` },
    });
    let text = '';
    try { text = await res.text(); } catch { /* ignore */ }
    return { status: res.status, hasTag: text.includes(window.__uiTag || ''), len: text.length };
  });
  check('sessions payload 200 + seeded title', sessJson.status === 200 && sessJson.hasTag,
    JSON.stringify(sessJson));

  // UI layer: open the 伴学助手 dock and look for the title in its session <select>
  await page.evaluate((t) => { window.__uiTag = t; }, TAG);
  const fab = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.title === '伴学助手');
    if (btn) { btn.click(); return true; }
    return false;
  });
  check('伴学助手 dock opened', !!fab, String(fab));
  const dockSessions = await waitFor(async () => {
    const r = await page.evaluate((t) => {
      const opts = [...document.querySelectorAll('select option')].map((o) => (o.textContent || '').trim());
      return { opts, hit: opts.some((o) => o.includes(t)) };
    }, TAG);
    return r.hit ? r : null;
  }, NET_WAIT_MS) ?? await page.evaluate((t) => {
    const opts = [...document.querySelectorAll('select option')].map((o) => (o.textContent || '').trim());
    return { opts, hit: opts.some((o) => o.includes(t)) };
  }, TAG);
  check('dock session select shows seeded title', dockSessions.hit, JSON.stringify(dockSessions).slice(0, 200));
  body = await page.evaluate(() => document.body.innerText);
  check('agents not stuck on BootGate', !body.includes('正在准备一些系统资源'),
    body.slice(0, 120).replace(/\n/g, ' '));
  await page.screenshot({ path: `${__dirname}/study_agents_sessions.png`, fullPage: true });

  console.log('V1_REQUESTS');
  v1Requests.forEach((t) => console.log(' ', t));
  console.log('V1_TRAFFIC');
  v1Traffic.forEach((t) => console.log(' ', t));

  await browser.close();
  try { child.kill(); } catch { /* ignore */ }

  const fail = results.filter((r) => !r.ok);
  console.log('===== UI STUDY SUMMARY =====');
  console.log(`total=${results.length} pass=${results.length - fail.length} fail=${fail.length}`);
  fail.forEach((f) => console.log('FAIL', f.name, f.detail));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error('UI_CHECK_CRASH', e);
  process.exit(2);
});
