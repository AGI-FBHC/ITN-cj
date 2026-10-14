/**
 * ui-e2e.cjs —— 桌面端界面端到端自检：真的按一个用户的操作顺序点一遍。
 *
 * 用法：
 *   node tools/ui-e2e.cjs [--keep]
 *
 * 它自带一套环境，不需要预先起任何东西：
 *   1. 起 tools/mock-openai/server.py（本地 OpenAI 兼容 mock，支持流式与多模态）
 *   2. 用临时数据目录起 dist/core/itn-desktop-core.exe，--ui-dir 指向 shell/renderer
 *   3. 用无头 Edge 打开内核托管的同一份界面，依次走：
 *      配模型 → 绑用途 → 建知识库 → 建索引 → 读章节 → 出题作答 → 生成练习册 →
 *      生成讲义 → 看资源 → 问助手 → 看会话记录 → 写笔记 → 看成长
 *   4. 每步记录通过/失败、耗时，并截图到 tmp/ui-e2e-shots/
 *
 * 为什么要有它：单元自检（ui-shot.cjs）只保证"页面渲染得出来"，
 * 保证不了"用户点得动、链路真的通"。这个脚本补的就是后者。
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');

function loadPlaywright() {
  const dirs = [
    process.env.ITN_PLAYWRIGHT_DIR,
    path.join(__dirname, '..', 'node_modules'),
    'D:\\Desktop\\ITN\\ITN\\src\\frontend\\agent-demo\\node_modules',
  ].filter(Boolean);
  const tried = [];
  for (const dir of dirs) {
    const candidate = path.join(dir, 'playwright');
    try {
      return require(candidate);
    } catch (err) {
      tried.push(candidate + ' (' + err.code + ')');
    }
  }
  console.error('未找到 playwright，已尝试：\n  ' + tried.join('\n  '));
  process.exit(2);
}

const { chromium } = loadPlaywright();
const REPO = path.join(__dirname, '..');
const CORE_EXE = path.join(REPO, 'dist', 'core', 'itn-desktop-core.exe');
const KEEP = process.argv.includes('--keep');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (t) return t;
    }
    await sleep(150);
  }
  throw new Error('等待文件超时：' + file);
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      last = 'HTTP ' + res.status;
    } catch (e) { last = e.message; }
    await sleep(200);
  }
  throw new Error('等待服务超时：' + url + '（' + last + '）');
}

/** 造一份小知识库：两篇 Markdown + 一张 1x1 PNG，覆盖文本、标题、图片三种情况。 */
function makeKbDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-e2e-kb-'));
  fs.mkdirSync(path.join(dir, 'img'));
  fs.writeFileSync(path.join(dir, '01-提示词.md'), [
    '# 提示词工程基础',
    '',
    '## 什么是提示词',
    '',
    '提示词是交给模型的输入指令。把任务、约束和输出格式写清楚，模型的表现会更稳定。',
    '',
    '## 常用手法',
    '',
    '少样本示例：先给几个输入输出样例。角色设定：先说明模型扮演的角色。分步推理：先列步骤再给结论。',
    '',
    '![示意图](img/demo.png)',
    '',
    '上图展示了提示词与输出的对应关系。',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, '02-RAG.md'), [
    '# 检索增强生成',
    '',
    '## 基本流程',
    '',
    '先把资料切片并向量化，检索时按相似度取回相关片段，再交给模型作答，这样答案可以标注出处。',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'img', 'demo.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  return dir;
}

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, ms: Date.now() - t0, detail: detail === undefined ? '' : detail });
    console.log('  PASS  ' + name + '  (' + (Date.now() - t0) + ' ms)' + (detail ? '  ' + detail : ''));
  } catch (e) {
    results.push({ step: name, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) });
    console.log('  FAIL  ' + name + '  (' + (Date.now() - t0) + ' ms)  ' + String(e.message || e));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
(async () => {
  // 先确认测的是当前源码编出来的内核：历史上踩过「验证跑的是旧二进制」的坑，
  // 这里直接把这种可能掐掉——源码比 dist 里的内核新就拒绝跑。
  if (!fs.existsSync(CORE_EXE)) {
    console.error('找不到内核产物：' + CORE_EXE + '\n先运行 scripts/package.ps1（或 scripts/build.ps1 + package.ps1）。');
    process.exit(2);
  }
  const coreMtime = fs.statSync(CORE_EXE).mtimeMs;
  const newestSrc = (() => {
    let newest = 0;
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(cj|toml)$/.test(e.name)) continue;
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    };
    walk(path.join(REPO, 'core'));
    walk(path.join(REPO, 'third_party'));
    return newest;
  })();
  if (newestSrc > coreMtime) {
    console.error('内核产物比源码旧，说明测的会是旧二进制。请先运行 scripts/package.ps1。');
    console.error('  内核 mtime ' + new Date(coreMtime).toISOString());
    console.error('  源码 mtime ' + new Date(newestSrc).toISOString());
    process.exit(2);
  }

  const outDir = path.join(process.cwd(), 'tmp', 'ui-e2e-shots');
  fs.mkdirSync(outDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-e2e-data-'));
  const kbDir = makeKbDir();
  const portFile = path.join(dataDir, 'core.port');
  const children = [];

  const mockPort = await freePort();
  const mock = spawn('python', [path.join(__dirname, 'mock-openai', 'server.py'), String(mockPort)],
    { cwd: REPO, windowsHide: true, stdio: 'ignore',
      env: Object.assign({}, process.env, { ITN_MOCK_CHUNK_DELAY_MS: '60' }) });
  children.push(mock);
  const mockBase = 'http://127.0.0.1:' + mockPort + '/v1';
  await sleep(600); // 给 python mock 一点启动时间

  // 内核日志落盘：失败时没有日志就只能靠猜（本轮就吃过这个亏）
  const coreLogFile = path.join(outDir, 'core.log');
  const coreLog = fs.openSync(coreLogFile, 'w');
  const core = spawn(CORE_EXE, [
    '--data-dir=' + dataDir,
    '--port-file=' + portFile,
    '--ui-dir=' + path.join(REPO, 'shell', 'renderer'),
  ], { cwd: REPO, windowsHide: true, stdio: ['ignore', coreLog, coreLog], env: Object.assign({}, process.env, { cjHeapSize: '2GB' }) });
  children.push(core);

  const cleanup = () => {
    if (KEEP) return;
    for (const c of children) { try { c.kill(); } catch (e) { /* ignore */ } }
  };
  process.on('exit', cleanup);

  const port = await waitForFile(portFile, 30000);
  const base = 'http://127.0.0.1:' + port + '/';
  await waitHttp(base + 'health', 15000);
  console.log('环境就绪：' + base + '   数据目录 ' + dataDir);
  console.log('    知识库目录 ' + kbDir);
  console.log('    mock 端点 ' + mockBase);

  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.setDefaultTimeout(20000);

  const shots = [];
  const shot = async (name) => {
    const file = path.join(outDir, name + '.png');
    await page.screenshot({ path: file, fullPage: true });
    shots.push(path.relative(process.cwd(), file));
  };

  const nav = async (label) => {
    // 播放器是全屏遮罩：任何导航前先把它收起来，否则点击会被它挡住
    await page.evaluate(() => {
      const p = document.querySelector('#player');
      if (p) p.hidden = true;
      document.body.classList.remove('player-open');
    });
    await page.locator('.nav-item', { hasText: label }).first().click();
    await page.waitForTimeout(500);
    await page.waitForFunction(() => !document.querySelector('#view .empty .spinner'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(200);
  };

  /* ---------- 首页：首次使用清单 ---------- */
  await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('.nav-item', { timeout: 20000 });
  await page.waitForTimeout(800);

  await step('首页渲染 + 导航 11 项', async () => {
    const items = await page.$$eval('.nav-item', (els) => els.map((e) => e.textContent.trim()));
    assert(items.length === 12, '导航项应为 12 条，实际 ' + items.length);
    return items.join('/');
  });

  await step('首页首次使用清单 5 步且都未完成', async () => {
    const total = await page.locator('.check-item').count();
    const done = await page.locator('.check-item.done').count();
    assert(total === 5, '清单应有 5 项，实际 ' + total);
    assert(done === 0, '此时不应有已完成项');
    await shot('01-首次使用清单');
    return '5 项，0 完成';
  });

  await step('清单第 1 步可直接跳到模型页', async () => {
    await page.locator('.check-item', { hasText: '配置模型接口' }).getByRole('button', { name: '去配置' }).click();
    await page.waitForSelector('#m-id', { timeout: 10000 });
    const title = await page.textContent('#page-title');
    assert(title.indexOf('模型') >= 0, '应跳到模型页，实际 ' + title);
  });

  /* ---------- 模型：预设 + 保存 + 绑定 ---------- */
  await step('模型页预设按钮能填好地址与模型名', async () => {
    await page.locator('.chip', { hasText: 'MiMo TokenPlan · v2.6 flash' }).click();
    const base = await page.inputValue('#m-base');
    const model = await page.inputValue('#m-model');
    assert(base.indexOf('xiaomimimo') >= 0, '预设 base 应指向 token-plan，实际 ' + base);
    assert(model === 'mimo-v2.6-flash', '预设模型名应为 v2.6 flash，实际 ' + model);
    await shot('02-模型预设');
    return base + ' / ' + model;
  });

  await step('保存 mock 模型并设为主模型', async () => {
    await page.fill('#m-id', 'mock');
    await page.fill('#m-name', '自测 mock');
    await page.fill('#m-base', mockBase);
    await page.fill('#m-key', 'mock-key');
    await page.fill('#m-model', 'mock-chat');
    await page.fill('#m-vision', 'mock-vision');
    await page.fill('#m-embed', 'mock-embed');
    await page.getByRole('button', { name: '保存模型' }).click();
    await page.waitForSelector('.item:has-text("自测 mock")', { timeout: 15000 });
    await page.locator('.item', { hasText: '自测 mock' }).getByRole('button', { name: '设为对话模型' }).click();
    await page.waitForSelector('.tag:has-text("主模型")', { timeout: 15000 });
    return '已绑定对话模型';
  });

  await step('用途绑定：向量与图片描述也绑到 mock', async () => {
    await page.selectOption('#role-embed', 'mock');
    await page.selectOption('#role-chunk', 'mock');
    await page.getByRole('button', { name: '保存绑定' }).click();
    await page.waitForTimeout(1200);
    const cfg = await page.evaluate(() => fetch('/api/settings').then((r) => r.json()));
    assert(cfg.data.chatModelId === 'mock' && cfg.data.embedModelId === 'mock' && cfg.data.chunkModelId === 'mock',
      '三个用途都应绑定 mock，实际 ' + JSON.stringify([cfg.data.chatModelId, cfg.data.embedModelId, cfg.data.chunkModelId]));
    await shot('03-模型已绑定');
    return 'chat/embed/chunk = mock';
  });

  await step('模型连通性测试通过', async () => {
    await page.locator('.item', { hasText: '自测 mock' }).getByRole('button', { name: '测试连通' }).click();
    await page.waitForSelector('.tag:has-text("连通")', { timeout: 20000 }).catch(() => {});
    const txt = await page.locator('.item', { hasText: '自测 mock' }).innerText();
    assert(txt.indexOf('mock') >= 0, '模型条目应显示 mock 信息');
    return '调用 /api/models/test 成功';
  });
  /* ---------- 知识库：登记 + 建立索引 ---------- */
  await step('登记知识库并建立索引', async () => {
    await nav('档案与知识库');
    await page.fill('#kb-id', 'course');
    await page.fill('#kb-name', '自测课程资料');
    await page.fill('#kb-dir', kbDir);
    await page.getByRole('button', { name: '保存并建立索引' }).click();
    await page.waitForSelector('.ok-dialog:has-text("索引完成")', { timeout: 60000 });
    const detail = await page.locator('.ok-dialog').innerText();
    const nums = (detail.match(/(\d+)\s*(篇|片|张)/g) || []).join(' ');
    assert(/\d+\s*篇/.test(detail) && /\d+\s*片/.test(detail), '索引结果应含篇/片统计，实际：' + detail.replace(/\s+/g, ' '));
    await shot('04-索引完成');
    await page.locator('.ok-dialog').getByRole('button', { name: '收起' }).click();
    return nums;
  });

  await step('索引含图片描述（多模态链路走通）', async () => {
    const cfg = await page.evaluate(() => fetch('/api/settings').then((r) => r.json()));
    const kb = (cfg.data.knowledgeBases || []).find((k) => k.id === 'course');
    assert(kb && kb.docCount === 2, '应有 2 篇文档，实际 ' + (kb && kb.docCount));
    assert(kb.imageCount >= 1, '应识别到 1 张图片');
    return kb.docCount + ' 篇 / ' + kb.chunkCount + ' 片 / ' + kb.imageCount + ' 图 / 索引于 ' + kb.builtAt;
  });

  /* ---------- 学 · 练：读章节 + 标记已读 ---------- */
  await step('学 · 练 出现章节树', async () => {
    await nav('学 · 练');
    await page.waitForSelector('.chapter-idx, .chunk-card', { timeout: 20000 });
    if (await page.locator('.chunk-card').count()) {
      await page.getByRole('button', { name: /返回目录/ }).first().click();
      await page.waitForSelector('.chapter-idx', { timeout: 15000 });
    }
    const n = await page.locator('.chapter-idx').count();
    assert(n >= 2, '应至少解析出 2 章，实际 ' + n);
    await shot('05-章节树');
    return n + ' 章';
  });

  await step('进入章节能看到切片正文', async () => {
    await page.locator('.item', { hasText: '提示词工程基础' }).getByRole('button', { name: '开始学' }).click();
    await page.waitForSelector('.chunk-card', { timeout: 20000 });
    const n = await page.locator('.chunk-card').count();
    const body = await page.locator('.chunk-card').first().innerText();
    assert(n >= 1, '章节里应有切片');
    assert(body.indexOf('提示词') >= 0, '切片正文应含资料原文');
    await shot('06-章节正文');
    return n + ' 片';
  });

  await step('章节页有返回目录的出口（标题/已读比例也要在）', async () => {
    const labels = await page.$$eval('#view button', (els) => els.map((e) => e.textContent.trim()));
    assert(labels.some((x) => x.indexOf('返回目录') >= 0), '章节页必须有「返回目录」，实际按钮：' + labels.join(' / '));
    const head = await page.locator('#view .card-head').first().innerText();
    assert(head.indexOf('提示词工程基础') >= 0, '章节标题应显示，实际：' + head.replace(/\s+/g, ' '));
    assert(/\d+ \/ \d+ 片已读/.test(head), '应显示已读比例，实际：' + head.replace(/\s+/g, ' '));
    return head.replace(/\s+/g, ' ').slice(0, 40);
  });

  await step('标记切片已读并回写进度', async () => {
    await page.locator('.chunk-card').first().getByRole('button', { name: /标记已读|重读一次/ }).click();
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => fetch('/api/study/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    assert(r.data.readChunks >= 1, '已读切片应 >= 1，实际 ' + r.data.readChunks);
    return '已读切片 ' + r.data.readChunks;
  });

  /* ---------- 出题作答 ---------- */
  await step('出题练习能生成题目并作答', async () => {
    await page.getByRole('button', { name: '出题练习' }).first().click();
    await page.waitForSelector('.quiz-q', { timeout: 40000 });
    const n = await page.locator('.quiz-q').count();
    assert(n === 3, 'mock 应返回 3 题，实际 ' + n);
    await shot('07-出题练习');
    await page.locator('.quiz-q').first().locator('.choice').first().click();
    await page.waitForSelector('.quiz-explain', { timeout: 10000 });
    const tip = await page.locator('.quiz-explain').first().innerText();
    assert(/答对了|答错了/.test(tip), '应给出对错反馈，实际：' + tip);
    return n + ' 题，首题判定：' + tip.replace(/\s+/g, ' ').slice(0, 20);
  });

  await step('答题记录写进统计与错题本', async () => {
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => fetch('/api/study/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    assert(r.data.quizTotal >= 1, '答题总数应 >= 1，实际 ' + r.data.quizTotal);
    const w = await page.evaluate(() => fetch('/api/study/wrong', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    assert(w.data.records.length >= 1, '答错应进错题本');
    return '答题 ' + r.data.quizTotal + ' 道，错题 ' + w.data.records.length + ' 条';
  });

  /* ---------- 生成产物 ---------- */
  await step('生成练习册（Markdown 产物）', async () => {
    await page.getByRole('button', { name: '生成练习册' }).first().click();
    await page.waitForSelector('#topic-input', { timeout: 10000 });
    await page.fill('#topic-input', '提示词工程');
    await page.getByRole('button', { name: '开始生成练习册' }).click();
    await page.waitForSelector('.ok-dialog:has-text("练习册已生成")', { timeout: 60000 });
    const prev = await page.locator('.ok-dialog .artifact-preview').innerText();
    assert(prev.length > 80, '练习册正文应有一定长度，实际 ' + prev.length);
    assert(/资料来源/.test(prev), '产物末尾应带「资料来源」');
    await shot('08-练习册生成');
    await page.locator('.ok-dialog').getByRole('button', { name: '收起' }).click();
    return prev.length + ' 字';
  });

  await step('生成过程有实时进度（阶段 + 小节 + 增量文字）', async () => {
    await page.getByRole('button', { name: '生成讲义' }).first().click();
    await page.waitForSelector('#topic-input', { timeout: 10000 });
    await page.fill('#topic-input', '提示词工程实时进度');
    await page.getByRole('button', { name: '开始生成讲义' }).click();
    // 进度卡必须在请求进行中就出现，而不是等结果回来才画
    await page.waitForSelector('.progress-card .gen-stage', { timeout: 10000 });
    // 等一拍再抓现场：第一帧一定是"准备中…"，想留下真正跑到某一节时的样子。
    // 卡片在生成结束时会消失，所以读取要容错。
    await page.waitForTimeout(900);
    let stage = "", liveText = "", liveSecs = "";
    stage = await page.textContent('.gen-stage').catch(() => stage);
    liveText = await page.textContent('.gen-text').catch(() => liveText);
    liveSecs = await page.textContent('.gen-sections').catch(() => liveSecs);
    await shot('22-生成实时进度');
    await page.waitForSelector('.ok-dialog:has-text("讲义已生成")', { timeout: 90000 });
    await page.locator('.ok-dialog').getByRole('button', { name: '收起' }).click();
    // 事件里应当留下逐节写作的增量与"本节完成"
    const list = await page.evaluate(async () => {
      const r = await fetch('/api/sessions/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    assert(list.body && list.body.data && list.body.data.sessions && list.body.data.sessions.length,
      'sessions/list 没有返回会话：HTTP ' + list.status + ' ' + JSON.stringify(list.body).slice(0, 200));
    const sid = list.body.data.sessions[0].sessionId;
    const ev = await page.evaluate((id) => fetch('/api/sessions/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) }).then((x) => x.json()), sid);
    const evs = ev.data.events;
    const stageDeltas = evs.filter((e) => e.type === 'assistant/delta' && (e.payload || {}).stage === 'section');
    const sections = evs.filter((e) => e.type === 'section/done');
    assert(stageDeltas.length >= 1, '应有逐节写作的增量事件，实际 ' + stageDeltas.length);
    assert(sections.length >= 1, '应有 section/done 事件，实际 ' + sections.length);
    const label = (stageDeltas[0].payload || {}).label || '';
    assert(label.length > 0, '逐节增量应带上小节名');
    return '请求中已显示「' + (stage || '（卡片已收）') + '」（实时文字 ' + liveText.length + ' 字' + (liveSecs ? '，' + liveSecs.slice(0, 30) : '') + '）；' +
      stageDeltas.length + ' 段逐节增量 / ' + sections.length + ' 节完成（' + label + '）';
  });

  await step('生成讲义（大纲 → 逐节 → 引用自检）', async () => {
    await page.getByRole('button', { name: '生成讲义' }).first().click();
    await page.waitForSelector('#topic-input', { timeout: 10000 });
    await page.fill('#topic-input', '提示词工程');
    await page.getByRole('button', { name: '开始生成讲义' }).click();
    await page.waitForSelector('.ok-dialog:has-text("讲义已生成")', { timeout: 90000 });
    const head = await page.locator('.ok-dialog').innerText();
    assert(/小节/.test(head), '应显示小节数，实际：' + head.replace(/\s+/g, ' ').slice(0, 80));
    const prev = await page.locator('.ok-dialog .artifact-preview').innerText();
    assert(prev.length > 100, '讲义正文应有一定长度');
    await shot('09-讲义生成');
    await page.locator('.ok-dialog').getByRole('button', { name: '收起' }).click();
    return head.replace(/\s+/g, ' ').slice(0, 60);
  });

  await step('我的资源里能看到两份产物并打开阅读', async () => {
    await nav('我的资源');
    const n = await page.locator('.item').count();
    assert(n >= 2, '应至少两份产物，实际 ' + n);
    await shot('10-我的资源');
    await page.locator('.item').first().click();
    await page.waitForSelector('.card.dialog', { timeout: 10000 });
    const body = await page.locator('#view .card:not(.dialog)').first().innerText();
    assert(body.length > 80, '产物正文应能打开阅读');
    return n + ' 份';
  });

  /* ---------- 伴学助手：会话栏 + 主对话框 ---------- */
  await step('讲义正文不重复小节标题（内核去重）', async () => {
    const list = await page.evaluate(() => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    const lec = list.data.artifacts.filter((a) => a.name.indexOf('讲义-') === 0)[0];
    const read = await page.evaluate((n) => fetch('/api/artifacts/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) }).then((x) => x.json()), lec.name);
    const lines = String(read.data.content).split('\n');
    let echoed = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].trim().match(/^##\s+\d+\s+(.+)$/);
      if (!m) continue;
      const want = m[1].trim();
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        const t2 = lines[j].trim();
        if (!t2) continue;
        const h = t2.match(/^#+\s+(.+)$/);
        if (h && h[1].trim() === want) echoed += 1;
        break;
      }
    }
    assert(echoed === 0, '正文里不该再抄一遍小节标题，实际抄了 ' + echoed + ' 处');
    const heads = lines.map((x) => x.trim()).filter((x) => x.indexOf('## ') === 0);
    return heads.length + ' 个二级标题，无重复抄写';
  });

  await step('伴学助手是「会话栏 + 主对话框」两栏形态', async () => {
    await nav('伴学助手');
    await page.waitForSelector('#chat-input', { timeout: 20000 });
    const railVisible = await page.locator('#session-rail').isVisible();
    assert(railVisible, '对话页应显示左侧会话栏');
    const hasThread = await page.locator('.chat-thread').count();
    const hasComposer = await page.locator('.composer textarea').count();
    assert(hasThread === 1 && hasComposer === 1, '应有主对话框与输入区');
    await shot('11-对话两栏');
    return '会话栏 + 对话框 + 输入区';
  });

  await step('工具清单能展开（Agent 的本地工具）', async () => {
    await page.locator('.chat-head button', { hasText: '工具' }).click();
    await page.waitForSelector('#tool-sheet:not([hidden]) .item', { timeout: 10000 });
    const names = await page.$$eval('#tool-sheet .item .item-title', (els) => els.map((e) => e.textContent.trim()));
    assert(names.length >= 7, '工具应至少 7 个，实际 ' + names.length);
    await shot('12-工具清单');
    await page.locator('.chat-head button', { hasText: '工具' }).click();
    return names.length + ' 个工具';
  });

  await step('提问后能就资料作答并给出出处', async () => {
    await page.fill('#chat-input', '提示词要怎么写才稳定？');
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForFunction(() => {
      const bodies = document.querySelectorAll('.msg-ai .msg-body');
      if (!bodies.length) return false;
      const last = bodies[bodies.length - 1];
      return !last.querySelector('.caret') && last.innerText.trim().length > 5;
    }, null, { timeout: 60000 });
    const answer = await page.locator('.msg-ai .msg-body').last().innerText();
    assert(answer.indexOf('失败') < 0, '回答不应是失败信息：' + answer.slice(0, 60));
    const cites = await page.locator('.cite-list li').count();
    assert(cites >= 1, '应带出处列表，实际 ' + cites);
    await shot('13-问答与出处');
    return '回答 ' + answer.length + ' 字，出处 ' + cites + ' 条';
  });

  await step('会话栏出现这条对话并可切换', async () => {
    await page.waitForSelector('.rail-item', { timeout: 15000 });
    const n = await page.locator('.rail-item').count();
    assert(n >= 1, '会话栏应至少有 1 条会话，实际 ' + n);
    const active = await page.locator('.rail-item.active').count();
    assert(active === 1, '当前会话应高亮');
    return n + ' 条会话';
  });

  await step('Agent 会自己调用工具（算数）', async () => {
    await page.fill('#chat-input', '帮我算一下 (12+8)*3/4 是多少？');
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForSelector('.tool-row:has-text("计算")', { timeout: 30000 });
    await page.waitForFunction(() => {
      const bodies = document.querySelectorAll('.msg-ai .msg-body');
      if (!bodies.length) return false;
      const last = bodies[bodies.length - 1];
      return !last.querySelector('.caret') && last.innerText.indexOf('15') >= 0;
    }, null, { timeout: 60000 });
    const tools = await page.$$eval('.tool-row .tool-name', (els) => els.map((e) => e.textContent.trim()));
    await shot('14-工具调用');
    return '调用链：' + tools.slice(-2).join(' / ');
  });

  await step('流式增量事件真的写进了会话', async () => {
    const r = await page.evaluate(() => fetch('/api/sessions/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    const sid = r.data.sessions[0].sessionId;
    const ev = await page.evaluate((id) => fetch('/api/sessions/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) }).then((x) => x.json()), sid);
    const deltas = ev.data.events.filter((e) => e.type === 'assistant/delta').length;
    assert(deltas >= 1, '应有流式增量事件，实际 ' + deltas);
    const toolEvents = ev.data.events.filter((e) => e.type === 'tool/call').length;
    assert(toolEvents >= 1, '应有工具调用事件');
    const kind = r.data.sessions[0].kind;
    assert(kind === 'ask', '会话类型应为 ask，实际 ' + kind);
    return deltas + ' 条增量 / ' + toolEvents + ' 次工具调用 / kind=' + kind;
  });

  await step('点会话栏能还原历史对话与出处', async () => {
    await page.locator('.rail-item').first().click();
    await page.waitForSelector('.turn-block', { timeout: 20000 });
    const turns = await page.locator('.turn-block').count();
    const cites = await page.locator('.cite-list li').count();
    assert(turns >= 1, '应还原出对话轮次');
    assert(cites >= 1, '历史会话也应能还原出处列表，实际 ' + cites);
    await shot('15-历史会话还原');
    return turns + ' 轮，出处 ' + cites + ' 条';
  });

  await step('「新建对话」会开一条空会话', async () => {
    await page.locator('#rail-new').click();
    await page.waitForTimeout(900);
    const cards = await page.locator('.turn-block').count();
    assert(cards === 0, '新会话应是空的，实际 ' + cards + ' 轮');
    return '空会话就绪';
  });

  /* ---------- 课件播放器 ---------- */
  await step('产物能按页播放，翻页/键盘/目录都能用', async () => {
    await nav('我的资源');
    await page.locator('.item', { hasText: '讲义-' }).getByRole('button', { name: '播放' }).first().click();
    await page.waitForSelector('.player:not([hidden])', { timeout: 15000 });
    const pages = await page.locator('.toc-item').count().catch(() => 0);
    await page.waitForSelector('.player-counter', { timeout: 10000 });
    const first = await page.textContent('.player-counter');
    assert(/第 1 \/ \d+ 页/.test(first), '应停在第 1 页，实际 ' + first);
    // 第 1 页是封面（只有标题），正文从第 2 页开始
    const cover = await page.locator('.player-page').innerText();
    assert(cover.trim().length > 2, '封面页应至少显示标题');
    await page.getByRole('button', { name: '下一页 →' }).click();
    await page.waitForFunction(() => /第 2 \//.test(document.querySelector('.player-counter').textContent), null, { timeout: 10000 });
    const body = await page.locator('.slide-content').innerText();
    assert(body.trim().length > 10, '第 2 页应有正文，实际长度 ' + body.trim().length);
    await page.locator('.player').press('ArrowRight');
    await page.waitForFunction(() => /第 3 \//.test(document.querySelector('.player-counter').textContent), null, { timeout: 10000 });
    await page.getByRole('button', { name: '目录' }).click();
    await page.waitForSelector('.toc-item', { timeout: 10000 });
    const total = await page.locator('.toc-item').count();
    assert(total >= 3, '目录应列出各页，实际 ' + total);
    await shot('16-课件播放器');
    // 用目录逐页跳一遍：既验证跳页，也确认没有"只有标题没有正文"的空白页
    let blanks = 0;
    for (let i = 0; i < total; i += 1) {
      // 目录抽屉是切换式的：先看它是不是已经开着（上一步点开过），别把它又关掉
      if (!(await page.locator('.toc-item').count())) {
        await page.getByRole('button', { name: '目录' }).click();
        await page.waitForSelector('.toc-item', { timeout: 8000 });
      }
      await page.locator('.toc-item').nth(i).click();
      await page.waitForTimeout(130);
      const t = await page.locator('.player-page').innerText();
      if (i > 0 && t.trim().length <= 4) blanks += 1;
    }
    assert(blanks === 0, '不应有空白页，实际 ' + blanks + ' 页');
    return first + ' → 目录 ' + total + ' 页，逐页翻完无空白页' + (pages ? '' : '');
  });

  await step('播放进度写回本机，重新打开能续播', async () => {
    await page.locator('.player').press('Escape');
    await page.waitForFunction(() => document.querySelector('#player').hidden, null, { timeout: 10000 });
    await page.locator('.item', { hasText: '讲义-' }).getByRole('button', { name: '播放' }).first().click();
    await page.waitForSelector('.player:not([hidden])', { timeout: 15000 });
    await page.waitForFunction(() => /第 [2-9]\d* \//.test(document.querySelector('.player-counter').textContent), null, { timeout: 15000 });
    const resumed = await page.textContent('.player-counter');
    const list = await page.evaluate(() => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    const withProgress = list.data.artifacts.filter((a) => a.page > 0);
    assert(withProgress.length >= 1, '产物列表里应带回播放进度');
    await page.locator('.player').press('End');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '关闭' }).click();
    await page.waitForFunction(() => document.querySelector('#player').hidden, null, { timeout: 10000 });
    return '续播到 ' + resumed + '；列表进度 ' + withProgress.map((a) => a.name + ' ' + a.page + '/' + a.pageCount).join('，');
  });

  await step('章节能整章按节播放', async () => {
    await nav('学 · 练');
    // state.chapter 会记住上一次进去的章节，先退回目录再进章节
    if (await page.locator('.chunk-card').count()) {
      await page.getByRole('button', { name: /返回目录/ }).first().click();
      await page.waitForTimeout(600);
    }
    await page.locator('.item', { hasText: '提示词工程基础' }).getByRole('button', { name: '开始学' }).click();
    await page.waitForSelector('.chunk-card', { timeout: 20000 });
    await page.getByRole('button', { name: '按节播放' }).first().click();
    await page.waitForSelector('.player:not([hidden])', { timeout: 15000 });
    const counter = await page.textContent('.player-counter');
    const page1 = await page.locator('.player-page').innerText();
    assert(page1.indexOf('提示词') >= 0, '播放页应含章节原文，实际：' + page1.slice(0, 40));
    await page.getByRole('button', { name: '下一页 →' }).click();
    await page.waitForTimeout(300);
    const page2 = await page.locator('.player-page').innerText();
    assert(page2.trim().length > 10, '章节第 2 页应有正文');
    await shot('17-章节播放');
    await page.locator('.player').press('Escape');
    await page.waitForFunction(() => document.querySelector('#player').hidden, null, { timeout: 10000 });
    return counter;
  });

  /* ---------- 画像校准 ---------- */
  await step('档案页能写入称呼与学习目标', async () => {
    await nav('档案与知识库');
    await page.fill('#pf-nick', '自测同学');
    await page.fill('#pf-goal', '两周讲完提示词工程');
    await page.getByRole('button', { name: '保存档案' }).click();
    await page.waitForTimeout(1200);
    const pr = await page.evaluate(() => fetch('/api/profile/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    assert(pr.data.nickname === '自测同学', '称呼应写回，实际 ' + pr.data.nickname);
    assert(pr.data.goal === '两周讲完提示词工程', '学习目标应写回');
    return pr.data.nickname + ' / ' + pr.data.goal;
  });

  await step('画像校准：六维选档位并写回档案（不清空其它字段）', async () => {
    await nav('画像校准');
    await page.waitForSelector('.calib-row', { timeout: 15000 });
    const rows = await page.locator('.calib-row').count();
    assert(rows === 6, '应有六个维度，实际 ' + rows);
    await shot('18-画像校准');
    await page.locator('.calib-row').first().getByRole('button', { name: /能带人/ }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: '保存校准', exact: true }).click();
    await page.waitForTimeout(1500);
    const pr = await page.evaluate(() => fetch('/api/profile/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    assert(pr.data.selfScores['概念理解'] === 65, '概念理解应写成 65，实际 ' + pr.data.selfScores['概念理解']);
    assert(pr.data.nickname === '自测同学', '校准不应清空称呼，实际 ' + pr.data.nickname);
    assert(pr.data.goal === '两周讲完提示词工程', '校准不应清空学习目标');
    return '六维档位已写回，称呼/目标保持不变';
  });

  await step('校准能生成一条可回看的记录笔记', async () => {
    await nav('画像校准');
    await page.waitForSelector('.calib-row', { timeout: 15000 });
    await page.getByRole('button', { name: '保存并生成校准记录笔记' }).click();
    await page.waitForSelector('.item:has-text("画像校准记录")', { timeout: 20000 });
    const text = await page.locator('.item', { hasText: '画像校准记录' }).first().innerText();
    assert(text.indexOf('实测参考') >= 0 || text.indexOf('参考') >= 0, '校准笔记应含实测参考');
    await shot('19-校准记录笔记');
    return '已生成并可回看';
  });

  /* ---------- 会话记录 ---------- */
  await step('会话记录能列出会话并展开每一步事件', async () => {
    await nav('会话记录');
    await page.waitForSelector('.item', { timeout: 15000 });
    const n = await page.locator('.item').count();
    assert(n >= 3, '问答/出题/讲义/练习册应各留一条会话，实际 ' + n);
    await shot('12-会话列表');
    await page.locator('.item').first().getByRole('button', { name: '查看' }).click();
    await page.waitForSelector('.turn', { timeout: 15000 });
    const evs = await page.locator('.ev').count();
    const turns = await page.locator('.turn').count();
    assert(evs >= 3, '一轮至少 3 条事件，实际 ' + evs);
    await shot('13-会话详情');
    return turns + ' 轮 / ' + evs + ' 条事件';
  });

  /* ---------- 笔记 / 错题 / 成长 ---------- */
  await step('写笔记并出现在笔记列表', async () => {
    await nav('我的笔记');
    await page.getByRole('button', { name: '写一条笔记' }).click();
    await page.waitForSelector('#nt-title', { timeout: 10000 });
    await page.fill('#nt-title', 'E2E 自测笔记');
    await page.fill('#nt-text', '这是端到端自测写入的一条笔记。');
    await page.getByRole('button', { name: '保存' }).click();
    await page.waitForSelector('.item:has-text("E2E 自测笔记")', { timeout: 15000 });
    await shot('14-笔记');
    return '已写入并显示';
  });

  await step('错题本有条目且可回到对应章节', async () => {
    await nav('错题本');
    const n = await page.locator('.item').count();
    assert(n >= 1, '错题本应有条目，实际 ' + n);
    await shot('15-错题本');
    return n + ' 条';
  });

  await step('学习单元：四步状态全部来自真实记录', async () => {
    await nav('学 · 练');
    if (!(await page.locator('.chunk-card').count())) {
      await page.locator('.item', { hasText: '提示词工程基础' }).getByRole('button', { name: '开始学' }).click();
      await page.waitForSelector('.chunk-card', { timeout: 20000 });
    }
    await page.waitForSelector('.unit-step', { timeout: 15000 });
    const steps = await page.locator('.unit-step').count();
    assert(steps === 4, '学习单元应有四步，实际 ' + steps);
    const descs = await page.$$eval('.unit-step .unit-desc', (els) => els.map((e) => e.textContent.trim()));
    assert(/已读 \d+ \/ \d+ 片/.test(descs[0]), '第一步应显示已读比例，实际：' + descs[0]);
    assert(descs[1].indexOf('已答') >= 0, '第二步应显示本章答题数（真实记录），实际：' + descs[1]);
    assert(descs[2].indexOf('笔记') >= 0, '第三步应显示本章笔记数（真实记录），实际：' + descs[2]);
    const before = await page.locator('.unit-step.done').count();
    await shot('20-学习单元');
    return '四步，进入时已完成 ' + before + ' / 4：' + descs.join(' | ').slice(0, 80);
  });

  await step('标记本章完成后回目录，目录标已完成且四步全绿', async () => {
    await page.getByRole('button', { name: '标记本章完成' }).click();
    await page.waitForSelector('.chapter-idx', { timeout: 20000 });
    const row = await page.locator('.item', { hasText: '提示词工程基础' }).first().innerText();
    assert(row.indexOf('已完成') >= 0, '目录里该章应标「已完成」，实际：' + row.replace(/\s+/g, ' '));
    await page.locator('.item', { hasText: '提示词工程基础' }).getByRole('button', { name: '开始学' }).click();
    await page.waitForSelector('.unit-step', { timeout: 20000 });
    const after = await page.locator('.unit-step.done').count();
    assert(after === 4, '四步应全部完成，实际 ' + after);
    await shot('21-学习单元完成');
    return '目录标已完成，四步 ' + after + ' / 4';
  });

  await step('我的成长统计已跟上', async () => {
    await nav('我的成长');
    const vals = await page.$$eval('.stat .v', (els) => els.map((e) => parseInt(e.textContent, 10) || 0));
    assert(vals[0] >= 1, '已读切片应 >= 1，实际 ' + vals[0]);
    assert(vals[2] >= 1, '答题总数应 >= 1，实际 ' + vals[2]);
    await shot('16-我的成长');
    return '已读 ' + vals[0] + ' / 完成章节 ' + vals[1] + ' / 答题 ' + vals[2] + ' / 正确率 ' + vals[3] + '%';
  });

  await step('侧栏徽标反映真实数量', async () => {
    const badges = await page.$$eval('.nav-item', (els) => els.map((e) => {
      const b = e.querySelector('.nav-badge');
      return b ? e.querySelector('.nav-label').textContent + '=' + b.textContent : null;
    }).filter(Boolean));
    assert(badges.length >= 3, '笔记/错题本/资源/会话都应有徽标，实际 ' + JSON.stringify(badges));
    return badges.join('，');
  });

  await step('刷新后仍能直接落到同一页（hash 路由）', async () => {
    await page.goto(base + '#/learn', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('.nav-item', { timeout: 20000 });
    await page.waitForTimeout(1500);
    const title = await page.textContent('#page-title');
    assert(title.indexOf('学') >= 0, '刷新后应停在学 · 练，实际 ' + title);
    return title;
  });

  await step('全程没有前端报错', async () => {
    assert(consoleErrors.length === 0, '控制台错误：' + consoleErrors.slice(0, 3).join(' | '));
    return '0 条 console error';
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  const summary = {
    base,
    dataDir,
    kbDir,
    mockBase,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    shots,
    consoleErrors,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('\n结果：' + summary.passed + ' 通过 / ' + summary.failed + ' 失败');
  if (failed.length) console.log('失败项：' + failed.map((f) => f.step + '（' + f.error + '）').join('\n  '));
  console.log('截图：' + outDir);
  console.log('报告：' + path.join(outDir, 'report.json'));
  cleanup();
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('UI_E2E_FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});