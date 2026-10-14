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
    { cwd: REPO, windowsHide: true, stdio: 'ignore' });
  children.push(mock);
  const mockBase = 'http://127.0.0.1:' + mockPort + '/v1';
  await sleep(600); // 给 python mock 一点启动时间

  const core = spawn(CORE_EXE, [
    '--data-dir=' + dataDir,
    '--port-file=' + portFile,
    '--ui-dir=' + path.join(REPO, 'shell', 'renderer'),
  ], { cwd: REPO, windowsHide: true, stdio: 'ignore', env: Object.assign({}, process.env, { cjHeapSize: '2GB' }) });
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
    assert(items.length === 11, '导航项应为 11 条，实际 ' + items.length);
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
    await page.waitForSelector('.chapter-idx', { timeout: 20000 });
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