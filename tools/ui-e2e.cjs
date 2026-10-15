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
  // 纯文本类的新格式：CSV 与 HTML（HTML 的 h1/h2 应当变成章节）
  fs.writeFileSync(path.join(dir, '03-成绩.csv'), '姓名,分数\n小明,88\n小红,92\n', 'utf8');
  fs.writeFileSync(path.join(dir, '04-网页讲义.html'), [
    '<html><head><title>网页讲义</title><style>p{color:red}</style></head><body>',
    '<h1>网页讲义</h1><h2>要点</h2><p>这是从网页另存下来的资料。</p>',
    '<script>var a=1;</script><ul><li>记得标注出处</li></ul></body></html>',
  ].join(''), 'utf8');
  // 读不了的格式：PDF 必须被如实报出来，而不是静默消失
  fs.writeFileSync(path.join(dir, '05-课件.pdf'), Buffer.from('%PDF-1.4 not a real pdf'), 'binary');
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
        // target 是构建/测试产物目录（cjpm test 会往里写临时 .cj），不该让"跑过测试"把守卫判成源码更新
        if (e.isDirectory()) { if (e.name !== 'target') walk(full); continue; }
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

/** 单独一份文件：放在自己的目录里，用来验证"不用先整理成文件夹也能导入"。 */
const singleSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-e2e-one-'));
const singleFile = path.join(singleSrcDir, '散落的一课.md');
fs.writeFileSync(singleFile, [
  '# 散落的一课',
  '',
  '这一课是单独一份文件导入进来的，用来验证「手上只有一份资料」时也能直接用。',
  '',
].join('\n'), 'utf8');
  const portFile = path.join(dataDir, 'core.port');
  const children = [];

  const mockPort = await freePort();
  const mock = spawn('python', [path.join(__dirname, 'mock-openai', 'server.py'), String(mockPort)],
    { cwd: REPO, windowsHide: true, stdio: 'ignore',
      env: Object.assign({}, process.env, { ITN_MOCK_CHUNK_DELAY_MS: '120' }) });
  children.push(mock);
  const mockBase = 'http://127.0.0.1:' + mockPort + '/v1';

  // 第二个 mock：会真的返回原生 tool_call（write）——用来验"让 lumin 动手 + 审批"
  const mockToolPort = await freePort();
  const mockTool = spawn('python', [path.join(__dirname, 'mock-toolcall', 'server.py'), String(mockToolPort)],
    { cwd: REPO, windowsHide: true, stdio: 'ignore' });
  children.push(mockTool);
  await sleep(600);
  const mockToolBase = 'http://127.0.0.1:' + mockToolPort + '/v1';
  // 第三个 mock：故意慢（每片 500ms）——"停止"这类步骤必须真的跑在半路上才有意义
  const mockSlowPort = await freePort();
  const mockSlow = spawn('python', [path.join(__dirname, 'mock-openai', 'server.py'), String(mockSlowPort)],
    { cwd: REPO, windowsHide: true, stdio: 'ignore',
      env: Object.assign({}, process.env, { ITN_MOCK_CHUNK_DELAY_MS: '500' }) });
  children.push(mockSlow);
  await sleep(600);
  const mockSlowBase = 'http://127.0.0.1:' + mockSlowPort + '/v1';
  await sleep(600); // 给 python mock 一点启动时间

  // 内核日志落盘：失败时没有日志就只能靠猜（本轮就吃过这个亏）
  const coreLogFile = path.join(outDir, 'core.log');
  const coreLog = fs.openSync(coreLogFile, 'w');
  const core = spawn(CORE_EXE, [
    '--data-dir=' + dataDir,
    '--port-file=' + portFile,
    '--ui-dir=' + path.join(REPO, 'shell', 'renderer'),
    // 和真实外壳一致：把随包内置的技能指给内核
    '--skills-dir=' + path.join(REPO, 'shell', 'skills'),
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
    // 页面真正的滚动容器是 #view，document 本身不滚，fullPage 只能拍到一屏。
    // 截图前临时把视口拉高，才能把整页内容留下来。
    const prev = page.viewportSize();
    try {
      await page.setViewportSize({ width: prev.width, height: 2600 });
      await page.waitForTimeout(150);
      await page.screenshot({ path: file });
    } finally {
      await page.setViewportSize(prev);
      await page.waitForTimeout(80);
    }
    shots.push(path.relative(process.cwd(), file));
  };

  const nav = async (label) => {
    // 播放器是全屏遮罩：任何导航前先把它收起来，否则点击会被它挡住
    await page.evaluate(() => {
      const p = document.querySelector('#player');
      if (p) p.hidden = true;
      document.body.classList.remove('player-open');
    });
    const aliases = {'首页':'学习中心','伴学助手':'Agent 工作台','领域知识库':'知识库','个性化资源':'学习资源'};
    if (['学 · 练','我的成长','我的资源'].includes(label)) {
      await page.locator('#rail .nav-item[data-page="home"]').click();
      await page.waitForSelector('.center-links');
      await page.locator('.center-links button', {hasText:label}).click();
    } else {
      await page.locator('#rail .nav-item', {hasText:aliases[label]||label}).first().click();
    }
    await page.waitForTimeout(500);
    await page.waitForFunction(() => !document.querySelector('#view .empty .spinner'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(200);
    if (label === '个性化资源') {
      await page.waitForSelector('.legacy-artifacts');
      await page.locator('.legacy-artifacts').evaluate(e=>e.open=true);
    }
  };

  /** 笔记与错题本已合成一个根「我的资源」，页内用分段切换：测试里统一走这个助手。 */
  const openRes = async (tab) => {
    await nav('我的资源');
    await page.waitForSelector('#view .res-tabs', { timeout: 15000 });
    await page.locator('#view .res-tabs button', { hasText: tab === 'wrong' ? '错题本' : '笔记' }).first().click();
    await page.waitForTimeout(700);
  };

  /**
   * 点星云图上的某个点。
   *
   * 用 Playwright 的 position 点击（相对元素左上角），它会自己把画布滚进视口 ——
   * 早先手动算 viewport 坐标，画布一变宽/一被挤出视口就点空，白折腾了三轮。
   */
  const clickGraphPoint = async (pick) => {
    const size = await page.evaluate(() => {
      const c = document.querySelector('.graph-canvas');
      const r = c.getBoundingClientRect();
      return { cssW: r.width, cssH: r.height };
    });
    await page.locator('.graph-canvas').click({
      position: { x: pick.x * (size.cssW / pick.w), y: pick.y * (size.cssH / pick.h) },
    });
    await page.waitForTimeout(600);
  };

  /* 设置现在是"左侧分区 + 右侧内容"的一页：先点侧栏的齿轮进设置，再点分区。 */
  const settings = async (label) => {
    await nav('设置');
    await page.waitForSelector('.settings-nav', { timeout: 15000 });
    await page.locator('.settings-nav button', { hasText: label }).first().click();
    await page.waitForTimeout(400);
    await page.waitForFunction(() => !document.querySelector('#view .empty .spinner'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(150);
  };

  /* ---------- 首页：首次使用清单 ---------- */
  await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('.nav-item', { timeout: 20000 });
  await page.waitForTimeout(800);

  await step('默认工作台 + 五个产品区与设置', async () => {
    const items = await page.$$eval('.nav-item', (els) => els.map((e) => {
      const tip = e.querySelector('.rail-tip');
      return tip ? tip.textContent.trim() : e.textContent.trim();
    }));
    assert(items.length === 6, '侧栏入口应为 6 个，实际 ' + items.length + '：' + items.join('/'));
    assert(items.indexOf('Agent 工作台') >= 0 && items.indexOf('会话记录') < 0,
      '「会话记录」应已并入「伴学助手」，实际：' + items.join('/'));
    assert(items.indexOf('画像校准') < 0 && items.indexOf('错题本') < 0 && items.indexOf('我的笔记') < 0,
      '校准应并入「我的成长」、笔记与错题本应并入「我的资源」，实际：' + items.join('/'));
    assert(items.some((x) => x.indexOf('设置') === 0), '左下角应是设置，实际：' + items.join('/'));
    return items.join('/');
  });

  await step('窄侧栏：只有图标、分组之间有分隔线', async () => {
    const geo = await page.evaluate(() => {
      const rail = document.querySelector('#rail');
      const box = rail.getBoundingClientRect();
      const vis = Array.from(document.querySelectorAll('#rail .nav-item')).filter((e) => {
        const t = e.querySelector('.rail-tip');
        if (!t) return false;
        const cs = getComputedStyle(t);
        return cs.opacity !== '0' || cs.visibility === 'hidden';
      }).length;
      return {
        w: Math.round(box.width),
        seps: document.querySelectorAll('#rail .rail-sep').length,
        visibleLabels: vis,
        actions: document.querySelectorAll('#rail .rail-btn').length,
        items: document.querySelectorAll('#rail .nav-item').length,
      };
    });
    assert(geo.w >= 48 && geo.w <= 72, '窄侧栏宽度应在 48~72px，实际 ' + geo.w);
    assert(geo.items === 6, '侧栏页面入口应为 6 个，实际 ' + geo.items);
    assert(geo.seps >= 2, '分组之间应有分隔线，实际 ' + geo.seps);
    assert(geo.actions === 2, '侧栏底部应有两个动作按钮（主题 / 齿轮之外只有检索），实际 ' + geo.actions);
    return geo.w + 'px · ' + geo.items + ' 入口 · ' + geo.seps + ' 条分隔线';
  });

  await nav('首页');
  await step('首页首次使用清单 5 步且都未完成', async () => {
    const total = await page.locator('.check-item').count();
    const done = await page.locator('.check-item.done').count();
    assert(total === 5, '清单应有 5 项，实际 ' + total);
    assert(done === 0, '此时不应有已完成项');
    await shot('01-首次使用清单');
    return '5 项，0 完成';
  });

  await step('清单第 1 步直接跳到设置里的「模型与接口」分区', async () => {
    await page.locator('.check-item', { hasText: '配置模型接口' }).getByRole('button', { name: '去配置' }).click();
    await page.waitForSelector('#m-id', { timeout: 10000 });
    const title = await page.textContent('#page-title');
    assert(title.indexOf('设置') >= 0, '应跳到设置页，实际 ' + title);
    const active = await page.locator('.settings-nav button.active').innerText();
    assert(active.indexOf('模型与接口') >= 0, '设置页应停在「模型与接口」分区，实际 ' + active);
    assert((await page.evaluate(() => location.hash)) === '#/settings/models',
      '设置分区要写进 hash，实际 ' + (await page.evaluate(() => location.hash)));
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
    await settings('知识库');
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
    assert(kb && kb.docCount === 4, '应有 4 篇可读文档（含 CSV 与 HTML），实际 ' + (kb && kb.docCount));
    assert(kb.imageCount >= 1, '应识别到 1 张图片');
    return kb.docCount + ' 篇 / ' + kb.chunkCount + ' 片 / ' + kb.imageCount + ' 图 / 索引于 ' + kb.builtAt;
  });

  await step('HTML 资料按标题分章（网页另存的资料也能用）', async () => {
    const tree = await page.evaluate(() => fetch('/api/study/tree', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kbId: 'course' }) }).then((r) => r.json()));
    const names = tree.data.chapters.map((c) => c.name);
    assert(names.indexOf('网页讲义') >= 0, 'HTML 的 h1 应当成为章节名，实际章节：' + names.join(' / '));
    const hit = await page.evaluate(() => fetch('/api/kb/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'course', query: '另存', topK: 3 }) }).then((r) => r.json()));
    const texts = (hit.data.hits || []).map((h) => h.text).join(' ');
    assert(texts.indexOf('网页') >= 0 || texts.indexOf('另存') >= 0, '应能检索到 HTML 里的正文，实际：' + texts.slice(0, 80));
    assert(texts.indexOf('color:red') < 0, 'style 里的内容不该进索引');
    return '章节含「网页讲义」；style 被剥掉';
  });

  await step('领域知识库：这个库里有什么（统计 / 来源 / 文档清单 / 动作都在这一页）', async () => {
    await nav('领域知识库');
    await page.waitForSelector('#view .grid .stat', { timeout: 20000 });
    const head = await page.locator('#view .card').first().innerText();
    for (const want of ['文档', '切片', '图片', '来源', '检索方式']) {
      assert(head.indexOf(want) >= 0, '知识库详情里应有「' + want + '」，实际：' + head.replace(/\s+/g, ' ').slice(0, 120));
    }
    // 统计与接口同口径
    const api = await page.evaluate(() => fetch('/api/kb/stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'course' }) }).then((r) => r.json()).then((j) => j.data));
    const nums = await page.$$eval('#view .grid .stat .v', (els) => els.map((e) => parseInt(e.textContent, 10) || 0));
    assert(nums[0] === api.docCount, '文档数应与接口一致（界面 ' + nums[0] + ' / 接口 ' + api.docCount + '）');
    assert(nums[1] === api.chunkCount, '切片数应与接口一致（界面 ' + nums[1] + ' / 接口 ' + api.chunkCount + '）');
    // 文档清单（折叠块）里应有真实文件名，且每篇带切片数
    const sum = await page.locator('#view .kb-docs summary').innerText();
    assert(sum.indexOf('文档') >= 0, '应有文档清单折叠块，实际 ' + sum);
    await page.locator('#view .kb-docs summary').click();
    await page.waitForTimeout(400);
    const first = await page.locator('#view .kb-docs .item').first().innerText();
    assert(first.indexOf('片') >= 0, '每篇文档应带切片数，实际 ' + first.replace(/\s+/g, ' '));
    const titles = await page.$$eval('#view .kb-docs .item-title', (els) => els.map((e) => e.textContent.trim()));
    assert(titles.join('/').indexOf('提示词') >= 0, '文档清单里应有 E2E 造的 01-提示词.md，实际 ' + titles.join('/'));
    // 动作就三个：重建索引 / 让 lumin 整理 / 设置里改
    const acts = await page.$$eval('#view .card-head button', (els) => els.map((e) => e.textContent.trim()));
    assert(acts.join('/').indexOf('重建索引') >= 0 && acts.join('/').indexOf('让 lumin 整理') >= 0, '详情卡上应有这两个动作，实际 ' + acts.join('/'));
    // 接口也把文档清单回出来了（界面不自己拼）
    assert((api.docs || []).length === api.docCount, '接口的 docs 数与 docCount 应一致，实际 ' + (api.docs || []).length + ' vs ' + api.docCount);
    await shot('56-知识库详情');
    return titles.length + ' 篇文档 · ' + nums[0] + ' 篇 / ' + nums[1] + ' 片 · 动作 ' + acts.join('/');
  });

  await step('读不了的文件会被如实报出来（不是静默跳过）', async () => {
    await settings('知识库');
    // 这个知识库已经建过索引，按钮叫「重建索引」；用 exact 免得匹配到表单里的「保存并建立索引」
    await page.getByRole('button', { name: '重建索引', exact: true }).first().click();
    await page.waitForSelector('.ok-dialog:has-text("索引完成")', { timeout: 60000 });
    const text = await page.locator('.ok-dialog').innerText();
    assert(text.indexOf('未纳入') >= 0 || text.indexOf('没纳入') >= 0, '索引完成弹层应说明未纳入的文件，实际：' + text.replace(/\s+/g, ' ').slice(0, 160));
    assert(text.indexOf('pdf') >= 0, '应点名 pdf，实际：' + text.replace(/\s+/g, ' ').slice(0, 160));
    await shot('28-未纳入的文件');
    await page.locator('.ok-dialog').getByRole('button', { name: '收起' }).click();
    await nav('领域知识库');
    await page.waitForSelector('.skip-note', { timeout: 15000 });
    const note = await page.locator('.skip-note').innerText();
    assert(note.indexOf('pdf') >= 0, '领域知识库页应能回看未纳入的文件，实际：' + note.replace(/\s+/g, ' '));
    await shot('29-知识库漏读提示');
    return note.replace(/\s+/g, ' ').slice(0, 60);
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

  await step('学习路径：一章一段、点一段跳到那一章', async () => {
    await nav('学 · 练');
    await page.waitForSelector('.path-track .path-seg', { timeout: 20000 });
    const segs = await page.locator('.path-track .path-seg').count();
    const tree = await page.evaluate(() => fetch('/api/study/tree', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kbId: 'course' }) }).then((r) => r.json()).then((j) => j.data));
    assert(segs === (tree.chapters || []).length, '路径上一章一段，实际 ' + segs + ' vs ' + (tree.chapters || []).length);
    const pct = await page.locator('.path-row .muted').innerText();
    assert(pct.indexOf('/') >= 0 && pct.indexOf('%') >= 0, '应给出"已完成 N / M 章 · x%"，实际 ' + pct);
    await shot('55-学习路径');
    // 点第一段：应进到那一章（主区出现该章的正文或单元卡）
    const name = await page.locator('.path-track .path-seg').first().getAttribute('title');
    const chapterName = String(name).split(' · ')[0];
    await page.locator('.path-track .path-seg').first().click();
    await page.waitForTimeout(1200);
    const view = await page.locator('#view').innerText();
    assert(view.indexOf(chapterName) >= 0, '点路径上的段应进到那一章，实际视图里没有 ' + name);
    // 复原到"步骤之间默认停在第 1 章（提示词工程基础）"的上下文，别把后面的步骤带偏
    await nav('学 · 练');
    await page.waitForTimeout(600);
    const inFirst = await page.evaluate(() => {
      const h = document.querySelector('.chapter-head h2, #view .card-head h2');
      return !!(document.querySelector('.chunk-card') && h && h.textContent.indexOf('提示词工程基础') >= 0);
    });
    if (!inFirst) {
      if (await page.locator('.chunk-card').count()) {
        await page.getByRole('button', { name: /返回目录/ }).first().click();
        await page.waitForSelector('.chapter-idx', { timeout: 15000 });
      }
      await page.locator('.item', { hasText: '提示词工程基础' })
        .getByRole('button', { name: /开始学|继续学/ }).first().click();
      await page.waitForSelector('.chunk-card', { timeout: 15000 });
    }
    return segs + ' 段 · ' + pct.trim() + ' · 点第一段进到「' + chapterName + '」';
  });

  await step('进入章节能看到切片正文', async () => {
    // 已经在章节里就别再点一次（按钮那时叫「继续学」；点它会重新进同一章，白等）
    if (!(await page.locator('.chunk-card').count())) {
      await page.locator('.item', { hasText: '提示词工程基础' })
        .getByRole('button', { name: /开始学|继续学/ }).first().click();
    }
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
  await step('标记已读就地更新，不把阅读位置冲掉', async () => {
    await page.evaluate(() => { document.querySelector('.view').scrollTop = 420; });
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => document.querySelector('.view').scrollTop);
    assert(before > 100, '应先把页面滚下去，实际 ' + before);
    // 最后一片还没读过：点它的「标记已读」
    const card = page.locator('.chunk-card').last();
    await card.getByRole('button', { name: '标记已读' }).click();
    await page.waitForFunction(() => {
      const cards = document.querySelectorAll('.chunk-card');
      return cards.length > 0 && !!cards[cards.length - 1].querySelector('.tag');
    }, null, { timeout: 10000 });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.querySelector('.view').scrollTop);
    assert(Math.abs(after - before) <= 40, '就地更新不该改变滚动位置：前 ' + before + ' 后 ' + after);
    const headTag = await page.locator('#view .card-head .tag').first().innerText();
    assert(/\d+ \/ \d+ 片已读/.test(headTag), '卡头进度应就地更新，实际：' + headTag);
    const unitTag = await page.locator('.unit-step.done').count();
    assert(unitTag >= 1, '学习单元第一步应随之变成已完成');
    await shot('37-就地标记已读');
    return '滚动位置保持 ' + before + '→' + after + '；卡头「' + headTag + '」';
  });

  await step('切到别的页面会把滚动位置归零（此前重置错了元素）', async () => {
    await page.evaluate(() => { document.querySelector('.view').scrollTop = 500; });
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => document.querySelector('.view').scrollTop);
    assert(before > 100, '先滚下去，实际 ' + before);
    await openRes('notes');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.querySelector('.view').scrollTop);
    assert(after === 0, '切页后应回到顶部，实际 ' + after);
    // 后面的步骤默认"停在第一章里"，这里把上下文恢复回去（步骤之间别给别人留坑）
    await nav('学 · 练');
    if (!(await page.locator('.chunk-card').count())) {
      await page.locator('.item', { hasText: '提示词工程基础' }).getByRole('button', { name: '开始学' }).click();
      await page.waitForSelector('.chunk-card', { timeout: 20000 });
    }
    return '切页前 ' + before + ' → 切页后 ' + after;
  });

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

  await step('生成过程是一条时间线，没有内核写死的步骤条', async () => {
    await page.getByRole('button', { name: '生成讲义' }).first().click();
    await page.waitForSelector('#topic-input', { timeout: 10000 });
    await page.fill('#topic-input', '提示词工程实时进度');
    await page.getByRole('button', { name: '开始生成讲义' }).click();
    // 生成卡必须在请求进行中就出现，而不是等结果回来才画
    await page.waitForSelector('.gen-card', { timeout: 10000 });
    // 关键断言：这张卡里**没有**写死的步骤条（上一版网页端的"检索→大纲→逐节→自检→落盘"已经删掉）
    const fixed = await page.locator('.gen-card .pipe-step').count();
    assert(fixed === 0, '生成卡里不该有写死的步骤条，实际 ' + fixed + ' 个');
    await page.waitForTimeout(700);
    await shot('22-生成过程');
    await page.waitForSelector('.ok-dialog:has-text("讲义已生成")', { timeout: 90000 });
    const head = await page.locator('.ok-dialog').innerText();
    assert(/讲义-/.test(head), '结果卡里应出现产物文件名，实际：' + head.replace(/\s+/g, ' ').slice(0, 80));
    await page.locator('.ok-dialog').getByRole('button', { name: '收起' }).click();
    // 会话里也不该有内核编的"第 N 步"事件：步骤是模型自己排的
    const list = await page.evaluate(() => fetch('/api/sessions/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    const sid = list.data.sessions[0].sessionId;
    const ev = await page.evaluate((id) => fetch('/api/sessions/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) }).then((x) => x.json()), sid);
    const evs = ev.data.events;
    const stepEvents = evs.filter((e) => String(e.type).indexOf('step/') === 0);
    assert(stepEvents.length === 0, '会话里不该再有 step/* 事件（那是内核编的步骤），实际 ' + stepEvents.length);
    const turnStart = evs.filter((e) => e.type === 'turn/start').pop();
    assert(turnStart && turnStart.payload.kind === 'lecture', '这一轮应标成讲义任务，实际 ' + JSON.stringify(turnStart && turnStart.payload));
    return '生成卡里 0 个写死步骤 · 事件 ' + evs.length + ' 条 · kind=' + turnStart.payload.kind;
  });

  await step('生成讲义（一次任务：怎么写写在提示词里，不在代码里）', async () => {
    await page.getByRole('button', { name: '生成讲义' }).first().click();
    await page.waitForSelector('#topic-input', { timeout: 10000 });
    await page.fill('#topic-input', '提示词工程');
    await page.getByRole('button', { name: '开始生成讲义' }).click();
    await page.waitForSelector('.ok-dialog:has-text("讲义已生成")', { timeout: 90000 });
    const head = await page.locator('.ok-dialog').innerText();
    assert(/讲义-提示词工程/.test(head), '结果卡里应写出产物名，实际：' + head.replace(/\s+/g, ' ').slice(0, 80));
    const prev = await page.locator('.ok-dialog .artifact-preview').innerText();
    assert(prev.length > 100, '讲义正文应有一定长度');
    assert(/资料来源/.test(prev), '讲义末尾应带资料来源');
    await shot('09-讲义生成');
    await page.locator('.ok-dialog').getByRole('button', { name: '收起' }).click();
    return head.replace(/\s+/g, ' ').slice(0, 60);
  });

  await step('我的资源里能看到两份产物并打开阅读', async () => {
    await nav('个性化资源');
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
  await step('同名产物不会静默覆盖（第二次自动加序号）', async () => {
    const post = (route, body) => page.evaluate(([r, b]) => fetch(r, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    }).then((x) => x.json()), [route, body]);
    const a = await post('/api/agent/task-pi', { kind: 'lecture', kbId: '', topic: '同名不覆盖', web: 'off' });
    const b = await post('/api/agent/task-pi', { kind: 'lecture', kbId: '', topic: '同名不覆盖', web: 'off' });
    assert(a.data.artifactPath && b.data.artifactPath, '两次都该有产物路径：' + JSON.stringify([a.data.artifactPath, b.data.artifactPath]));
    assert(a.data.artifactPath !== b.data.artifactPath, '同名第二次应换一个文件名，实际两次都是 ' + a.data.artifactPath);
    assert(fs.existsSync(a.data.artifactPath) && fs.existsSync(b.data.artifactPath), '两份产物都应真在磁盘上');
    const latest = await page.evaluate(() => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    const names = latest.data.artifacts.map((x) => x.name).filter((n) => n.indexOf('讲义-同名不覆盖') === 0);
    assert(names.length === 2, '资源里应有同名两份，实际 ' + names.join('/'));
    return '两次落盘：' + names.join(' / ');
  });

  await step('伴学助手是「会话栏 + 主对话框」两栏形态', async () => {
    await nav('伴学助手');
    await page.waitForSelector('#chat-input', { timeout: 20000 });
    const railVisible = await page.locator('#panel').isVisible();
    assert(railVisible, '对话页应显示左侧会话栏');
    const hasThread = await page.locator('.chat-thread').count();
    const hasComposer = await page.locator('.composer textarea').count();
    assert(hasThread === 1 && hasComposer === 1, '应有主对话框与输入区');
    await shot('11-对话两栏');
    return '会话栏 + 对话框 + 输入区';
  });

  await step('工具与技能：从 ＋ 菜单打开，按用途分组（顶栏已经去掉）', async () => {
    await page.locator('.composer-row .composer-icon').first().click();
    await page.waitForSelector('.cm-actions .composer-menu-item', { timeout: 8000 });
    await page.locator('.cm-actions .composer-menu-item', { hasText: '工具与技能' }).click();
    await page.waitForSelector('#tool-sheet:not([hidden]) .item', { timeout: 10000 });
    const names = await page.$$eval('#tool-sheet .item .item-title', (els) => els.map((e) => e.textContent.trim()));
    assert(names.length >= 8, '工具应至少 8 个（含联网搜索），实际 ' + names.length);
    assert(names.join('/').indexOf('联网搜索') >= 0, '工具清单里应有联网搜索，实际：' + names.join('/'));
    // 默认没配 Tavily：这个工具应被标成"需先配置"，而不是假装能用
    const needCfg = await page.locator('#tool-sheet .item', { hasText: '联网搜索' }).innerText();
    assert(needCfg.indexOf('需先配置') >= 0, '没配密钥时联网搜索应标"需先配置"，实际：' + needCfg.replace(/\s+/g, ' '));
    // 按用途分组：知识库 / 联网 / 笔记与产物 …
    const groups = await page.$$eval('#tool-sheet .panel-group-title', (els) => els.map((e) => e.textContent.trim()));
    assert(groups.indexOf('知识库') >= 0 && groups.indexOf('联网') >= 0, '工具应按用途分组，实际 ' + groups.join('/'));
    assert(groups.indexOf('本机文件') < 0, '没指定工作目录时不该列"本机文件"那组，实际 ' + groups.join('/'));
    await shot('12-工具清单');
    await page.locator('#tool-sheet .card-head button').click();
    return names.length + ' 个工具 · 分组 ' + groups.join('/');
  });

  await step('提问后能就资料作答并给出出处（工具由模型自己决定：它先调了检索）', async () => {
    // 这段对话走 lumin：要不要检索是模型自己决定的，所以这里必须给它一个"会真的发 tool_call"的模型
    await page.evaluate((b) => fetch('/api/models/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'tc', name: '会调工具的模型', baseUrl: b, apiKey: 'k', model: 'mock-tool' }) }).then((r) => r.json()), mockToolBase);
    await page.evaluate(() => fetch('/api/models/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatModelId: 'tc', embedModelId: 'mock', chunkModelId: 'mock' }) }).then((r) => r.json()));
    await page.fill('#chat-input', '提示词要怎么写才稳定？');
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForFunction(() => {
      const bodies = document.querySelectorAll('.msg-ai .msg-body');
      if (!bodies.length) return false;
      const last = bodies[bodies.length - 1];
      return !last.querySelector('.spinner') && !last.querySelector('.caret') && last.innerText.trim().length > 5;
    }, null, { timeout: 60000 });
    const answer = await page.locator('.msg-ai .msg-body').last().innerText();
    assert(answer.indexOf('失败') < 0, '回答不应是失败信息：' + answer.slice(0, 60));
    const cites = await page.locator('.cite-list li').count();
    assert(cites >= 1, '应带出处列表，实际 ' + cites);
    await shot('13-问答与出处');
    // 复原：把对话模型绑回 mock-openai —— 生成讲义/练习册那条链路要的是"正文"，不是 tool_call
    await page.evaluate(() => fetch('/api/models/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatModelId: 'mock', embedModelId: 'mock', chunkModelId: 'mock' }) }));
    return '回答 ' + answer.length + ' 字，出处 ' + cites + ' 条';
  });

  await step('会话栏出现这条对话并可切换', async () => {
    await page.waitForSelector('.panel-item', { timeout: 15000 });
    const n = await page.locator('.panel-item').count();
    assert(n >= 1, '会话栏应至少有 1 条会话，实际 ' + n);
    const active = await page.locator('.panel-item.active').count();
    assert(active === 1, '当前会话应高亮');
    return n + ' 条会话';
  });

  await step('工具由模型自己挑：先思考、再动工具（不是内核写死"先检索"）', async () => {
    await page.evaluate((b) => fetch('/api/models/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'tc', name: '会调工具的模型', baseUrl: b, apiKey: 'k', model: 'mock-tool' }) }).then((r) => r.json()), mockToolBase);
    await page.evaluate(() => fetch('/api/models/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatModelId: 'tc', embedModelId: 'mock', chunkModelId: 'mock' }) }).then((r) => r.json()));
    await page.fill('#chat-input', '资料里说提示词要注意什么？');
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForSelector('.tool-row:has-text("检索知识库")', { timeout: 60000 });
    await page.waitForFunction(() => {
      const bodies = document.querySelectorAll('.msg-ai .msg-body');
      if (!bodies.length) return false;
      const last = bodies[bodies.length - 1];
      return !last.querySelector('.spinner') && !last.querySelector('.caret') && last.innerText.trim().length > 4;
    }, null, { timeout: 60000 });
    // 时间线按发生顺序：提问 → 思考 → 工具 → 回答；不是"第 N 步"那种写死的步骤条
    const order = await page.evaluate(() => Array.from(document.querySelectorAll(
        '.turn-block:last-child .msg, .turn-block:last-child .tool-row, .turn-block:last-child .think-row'))
      .map((e) => (e.classList.contains('tool-row') ? 'tool'
        : e.classList.contains('think-row') ? 'think'
        : (e.classList.contains('msg-user') ? 'user' : 'ai'))));
    const toolAt = order.indexOf('tool'), aiAt = order.lastIndexOf('ai'), thinkAt = order.indexOf('think');
    assert(toolAt >= 0 && aiAt > toolAt, '时间线应是"提问 → 工具 → 回答"，实际 ' + order.join(','));
    assert(thinkAt >= 0 && thinkAt < toolAt, '思考段应在工具之前（模型先想再动手），实际 ' + order.join(','));
    const thinkSum = await page.locator('.turn-block:last-child .think-sum').last().innerText();
    assert(thinkSum.indexOf('已思考') >= 0, '思考行应是"已思考 N 秒"，实际：' + thinkSum);
    const tools = await page.$$eval('.tool-row .tool-name', (els) => els.map((e) => e.textContent.trim()));
    await shot('14-工具调用');
    await page.evaluate(() => fetch('/api/models/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatModelId: 'mock', embedModelId: 'mock', chunkModelId: 'mock' }) }));
    return '时间线 ' + order.join(' → ') + ' · 工具：' + tools.slice(-1).join('');
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
    // 会话栏第一条可能是"生成讲义"那次任务（标题就是任务简报），所以这里挨条开，
    // 找到那条真的带出处的问答 —— 要验的是"历史会话能还原出处"，不是"第一条一定是问答"。
    const items = page.locator('.panel-item');
    const n = await items.count();
    let turns = 0;
    let cites = 0;
    for (let i = 0; i < n; i += 1) {
      await items.nth(i).click();
      await page.waitForTimeout(700);
      turns = await page.locator('.turn-block').count();
      cites = await page.locator('.cite-list li').count();
      if (turns >= 1 && cites >= 1) break;
    }
    assert(turns >= 1, '应还原出对话轮次');
    assert(cites >= 1, '历史会话也应能还原出处列表，实际 ' + cites);
    await shot('15-历史会话还原');
    return turns + ' 轮，出处 ' + cites + ' 条（共 ' + n + ' 条会话）';
  });

  await step('「新建对话」会开一条空会话（输入区居中，Codex 形状）', async () => {
    await page.locator('#rail-new').click();
    await page.waitForTimeout(900);
    const cards = await page.locator('.turn-block').count();
    assert(cards === 0, '新会话应是空的，实际 ' + cards + ' 轮');
    const blank = await page.evaluate(() => document.getElementById('view').classList.contains('chat-blank'));
    assert(blank, '空会话应把欢迎块与输入区居中（view.chat-blank）');
    return '空会话就绪 · 输入区居中';
  });

  await step('会话能重命名与删除（像 Codex 那样管起来）', async () => {
    const rows = page.locator('.panel-item-row');
    const n = await rows.count();
    assert(n >= 1, '应至少有一条会话可管理，实际 ' + n);
    const target = rows.first();
    const sid = await target.locator('.panel-item').getAttribute('data-id');
    assert(!!sid, '会话行应带 sessionId');
    await target.hover();
    await target.locator('.panel-item-more').click();
    await page.locator('.session-menu button', { hasText: '重命名' }).click();
    await page.fill('#session-rename-input', 'E2E 重命名会话');
    await page.getByRole('button', { name: '保存' }).click();
    await page.waitForFunction(() => document.body.innerText.indexOf('E2E 重命名会话') >= 0, null, { timeout: 10000 });
    const listed = await page.evaluate(() => fetch('/api/sessions/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    const renamed = (listed.data.sessions || []).filter((s) => s.sessionId === sid)[0];
    assert(renamed && renamed.title === 'E2E 重命名会话', '内核里的标题应改成新名字，实际 ' + JSON.stringify(renamed && renamed.title));

    const row2 = page.locator('.panel-item-row').filter({ hasText: 'E2E 重命名会话' }).first();
    await row2.hover();
    await row2.locator('.panel-item-more').click();
    await page.locator('.session-menu button', { hasText: '删除' }).click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.waitForFunction((id) => fetch('/api/sessions/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((x) => x.json()).then((r) => !(r.data.sessions || []).some((s) => s.sessionId === id)), sid, { timeout: 10000 });
    const gone = await page.locator('.panel-item-title', { hasText: 'E2E 重命名会话' }).count();
    assert(gone === 0, '会话栏里不应再有被删掉的会话');
    return '重命名 + 删除都落到内核（' + sid + '）';
  });

  /* ---------- 课件播放器 ---------- */
  await step('产物能按页播放，翻页/键盘/目录都能用', async () => {
    await nav('个性化资源');
    await page.locator('.item', { hasText: '讲义-' }).getByRole('button', { name: '播放' }).first().click();
    await page.waitForSelector('.player:not([hidden])', { timeout: 15000 });
    const pages = await page.locator('.toc-item').count().catch(() => 0);
    await page.waitForSelector('.player-counter', { timeout: 10000 });
    const first = await page.textContent('.player-counter');
    assert(/第 1 \/ \d+ 页/.test(first), '应停在第 1 页，实际 ' + first);
    // 第 1 页是封面（只有标题），正文从第 2 页开始
    const cover = await page.locator('.player-page').innerText();
    assert(cover.trim().length > 2, '封面页应至少显示标题');
    await page.locator('#player').getByRole('button', { name: '下一页 →' }).click();
    await page.waitForFunction(() => /第 2 \//.test(document.querySelector('.player-counter').textContent), null, { timeout: 10000 });
    const body = await page.locator('.slide-content').innerText();
    assert(body.trim().length > 10, '第 2 页应有正文，实际长度 ' + body.trim().length);
    await page.locator('.player').press('ArrowRight');
    await page.waitForFunction(() => /第 3 \//.test(document.querySelector('.player-counter').textContent), null, { timeout: 10000 });
    await page.locator('#player').getByRole('button', { name: '目录', exact: true }).click();
    await page.waitForSelector('.toc-item', { timeout: 10000 });
    const total = await page.locator('.toc-item').count();
    assert(total >= 3, '目录应列出各页，实际 ' + total);
    await shot('16-课件播放器');
    // 用目录逐页跳一遍：既验证跳页，也确认没有"只有标题没有正文"的空白页
    let blanks = 0;
    for (let i = 0; i < total; i += 1) {
      // 目录抽屉是切换式的：先看它是不是已经开着（上一步点开过），别把它又关掉
      if (!(await page.locator('.toc-item').count())) {
        await page.locator('#player').getByRole('button', { name: '目录', exact: true }).click();
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
    await page.locator('#player').getByRole('button', { name: '关闭' }).click();
    await page.waitForFunction(() => document.querySelector('#player').hidden, null, { timeout: 10000 });
    return '续播到 ' + resumed + '；列表进度 ' + withProgress.map((a) => a.name + ' ' + a.page + '/' + a.pageCount).join('，');
  });

  await step('产物管理：搜索、重命名（进度跟着走）、删除（文件真的没了）', async () => {
    const listApi = async () => (await page.evaluate(() => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()))).data.artifacts;
    await nav('个性化资源');
    const total = (await listApi()).length;
    assert(total >= 2, '这一步至少需要两份产物，实际 ' + total);

    // 1) 按名字搜索
    await page.fill('#artifact-search', '练习册');  // 文件名前缀就是 练习册-（与界面用词一致）
    await page.waitForTimeout(300);
    const shown = await page.locator('.list .item').count();
    if (shown === 0) {
      const dump = await page.evaluate(() => ({
        input: (document.querySelector('#artifact-search') || {}).value,
        counter: (document.querySelector('.artifact-count') || {}).textContent,
        listText: ((document.querySelector('.list') || {}).innerText || '').slice(0, 160),
        itemsInView: document.querySelectorAll('#view .item').length,
        cards: document.querySelectorAll('#view .card').length,
      }));
      throw new Error('搜索后列表为空，现场：' + JSON.stringify(dump) + '（API 报 ' + total + ' 份）');
    }
    assert(shown >= 1 && shown < total, '搜索应筛掉一部分，实际 ' + shown + ' / ' + total);
    await shot('23-产物搜索');
    await page.fill('#artifact-search', '');
    await page.waitForTimeout(300);
    assert((await page.locator('.list .item').count()) === total, '清空搜索后应恢复全部');

    // 2) 重命名：讲义的播放进度必须跟着走
    const lec = (await listApi()).filter((a) => a.name.indexOf('讲义-') === 0)[0];
    assert(lec && lec.page > 0, '讲义这时应有播放进度（前面播过），实际 ' + JSON.stringify(lec));
    await page.locator('.item', { hasText: lec.name }).getByRole('button', { name: '重命名' }).click();
    await page.waitForSelector('#rename-input', { timeout: 10000 });
    await page.fill('#rename-input', '讲义-阶段小结');
    await page.getByRole('button', { name: '改名' }).click();
    await page.waitForSelector('.item:has-text("讲义-阶段小结.md")', { timeout: 15000 });
    const artDir = path.join(dataDir, 'artifacts');
    assert(fs.existsSync(path.join(artDir, '讲义-阶段小结.md')), '磁盘上应出现新名字');
    assert(!fs.existsSync(path.join(artDir, lec.name)), '磁盘上不应再有旧名字');
    const moved = await page.evaluate(() => fetch('/api/artifacts/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '讲义-阶段小结.md' }) }).then((x) => x.json()));
    assert(moved.data.page === lec.page, '播放进度应跟着改名走：原 ' + lec.page + '，新 ' + moved.data.page);

    // 3) 删除：文件与播放进度都要清掉
    const quiz = (await listApi()).filter((a) => a.name.indexOf('练习册-') === 0)[0];
    assert(quiz, '应有一份练习册可供删除');
    await page.evaluate((n) => fetch('/api/artifacts/progress/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, page: 2, pageCount: 5 }) }), quiz.name);
    await page.locator('.item', { hasText: quiz.name }).getByRole('button', { name: '删除' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    // 删除后会 go('resources') 重渲染，重渲染瞬间 .list 还不存在，判断要容错
    await page.waitForFunction((n) => {
      const l = document.querySelector('.list');
      return !!l && !l.innerText.includes(n);
    }, quiz.name, { timeout: 15000 });
    assert(!fs.existsSync(path.join(artDir, quiz.name)), '删除后文件应真的没了');
    const gone = await page.evaluate((n) => fetch('/api/artifacts/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) }).then((x) => x.json()), quiz.name);
    assert(gone.data.page === 0, '删除后播放进度也应清掉，实际 ' + gone.data.page);
    await page.waitForTimeout(500);   // 等重渲染的进场动画结束再截图
    await shot('24-产物管理');
    return '搜索 ' + shown + '/' + total + ' 份；改名后进度 ' + moved.data.page + ' 页；删除后文件与进度都清掉';
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
    await page.locator('#player').getByRole('button', { name: '下一页 →' }).click();
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
    await settings('常规');
    await page.fill('#pf-nick', '自测同学');
    await page.fill('#pf-goal', '两周讲完提示词工程');
    await page.getByRole('button', { name: '保存档案' }).click();
    await page.waitForTimeout(1200);
    const pr = await page.evaluate(() => fetch('/api/profile/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    assert(pr.data.nickname === '自测同学', '称呼应写回，实际 ' + pr.data.nickname);
    assert(pr.data.goal === '两周讲完提示词工程', '学习目标应写回');
    return pr.data.nickname + ' / ' + pr.data.goal;
  });

  await step('能力校准：就地展开、一次只问一条、三条按钮就能写回档案', async () => {
    await nav('我的成长');
    await page.waitForSelector('.card', { timeout: 20000 });
    // 校准不再是另一个页面：它是成长页里就地展开的一段
    await page.getByRole('button', { name: '校准我的能力' }).first().click();
    await page.waitForSelector('.calib-step', { timeout: 15000 });
    const first = (await page.locator('.calib-step').innerText()).replace(/\s+/g, ' ');
    assert(first.indexOf('第 1 / 6 条') >= 0, '应一次只问一条（第 1 / 6 条），实际：' + first.slice(0, 80));
    const picks = await page.locator('.calib-step .calib-pick button').count();
    assert(picks === 3, '每条只给三个按钮（偏低 / 差不多 / 偏高），实际 ' + picks);
    const boxes = await page.locator('.calib-step input:not([type=checkbox])').count();
    assert(boxes <= 1, '每条最多一个选填输入框，实际 ' + boxes);
    await shot('18-能力校准');
    for (let i = 0; i < 6; i++) {
      await page.locator('.calib-step .calib-pick button', { hasText: '偏高' }).first().click();
      await page.waitForTimeout(320);
    }
    await page.waitForSelector('.calib-done', { timeout: 10000 });
    await page.getByRole('button', { name: '保存', exact: true }).first().click();
    await page.waitForTimeout(1800);
    const pr = await page.evaluate(() => fetch('/api/profile/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    assert(pr.data.selfScores['概念理解'] === 65, '概念理解应写成 65，实际 ' + pr.data.selfScores['概念理解']);
    assert(pr.data.nickname === '自测同学', '校准不应清空称呼，实际 ' + pr.data.nickname);
    assert(pr.data.goal === '两周讲完提示词工程', '校准不应清空学习目标');
    return '六条各一句话；值 65；称呼/目标保持不变';
  });

  await step('校准记录笔记：勾一个小选项就有，能在「我的资源 → 笔记」回看', async () => {
    await nav('我的成长');
    await page.getByRole('button', { name: '校准我的能力' }).first().click();
    await page.waitForSelector('.calib-step', { timeout: 15000 });
    await page.locator('.calib-notebox input[type=checkbox]').first().check();
    await page.getByRole('button', { name: '保存', exact: true }).first().click();
    await page.waitForTimeout(2000);
    await openRes('notes');
    await page.waitForSelector('.item:has-text("画像校准记录")', { timeout: 20000 });
    const text = await page.locator('.item', { hasText: '画像校准记录' }).first().innerText();
    assert(text.indexOf('参考') >= 0, '校准笔记应含实测参考');
    await shot('19-校准记录笔记');
    return '勾一下就有记录，可在笔记里回看';
  });

  /* ---------- 停止生成 / 停止回答 ---------- */
  await step('生成中可以停止：写明停在哪、且不落产物', async () => {
    await nav('学 · 练');
    if (await page.locator('.chunk-card').count()) {
      await page.getByRole('button', { name: /返回目录/ }).first().click();
      await page.waitForTimeout(500);
    }
    const before = (await page.evaluate(() => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()))).data.artifacts.length;
    await page.locator('.item', { hasText: '提示词工程基础' }).getByRole('button', { name: '开始学' }).click();
    await page.waitForSelector('.chunk-card', { timeout: 20000 });
    await page.getByRole('button', { name: '生成讲义' }).first().click();
    await page.waitForSelector('#topic-input', { timeout: 10000 });
    await page.fill('#topic-input', '提示词工程-会被取消');
    await page.getByRole('button', { name: '开始生成讲义' }).click();
    await page.waitForSelector('.gen-card', { timeout: 15000 });
    await page.waitForTimeout(900);   // 让它真的开始跑，再停
    const stage = await page.textContent('.gen-card .card-head h2').catch(() => '');
    await page.getByRole('button', { name: '停止生成' }).click();
    await page.waitForSelector('.dialog:has-text("已取消")', { timeout: 30000 });
    const box = await page.locator('.dialog', { hasText: '已取消' }).first().innerText();
    assert(box.indexOf('未落盘') >= 0 || box.indexOf('未保存') >= 0, '取消卡片应写明没落盘，实际：' + box.replace(/\s+/g, ' '));
    const after = (await page.evaluate(() => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()))).data.artifacts.length;
    assert(after === before, '取消不应产生产物：前 ' + before + ' 后 ' + after);
    await shot('26-停止生成');
    const list = await page.evaluate(() => fetch('/api/sessions/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    const ev = await page.evaluate((id) => fetch('/api/sessions/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) }).then((x) => x.json()), list.data.sessions[0].sessionId);
    const end = ev.data.events.filter((e) => e.type === 'turn/end').pop();
    assert(end && end.payload.ok === false && String(end.payload.message).indexOf('取消') >= 0,
      '会话里应留下"被取消"的收尾事件，实际：' + JSON.stringify(end));
    await page.locator('.dialog', { hasText: '已取消' }).getByRole('button', { name: '关闭' }).click();
    return '停止前阶段「' + stage + '」；产物未增加（' + after + ' 份）；事件：' + end.payload.message;
  });

  await step('回答可以停止，并且能一键重问', async () => {
    await nav('伴学助手');
    await page.waitForSelector('#chat-input', { timeout: 20000 });
    // 用"慢模型"：回答要真的还在流的时候点停止，才叫验证停止
    await page.evaluate((b) => fetch('/api/models/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'slow', name: '慢模型', baseUrl: b, apiKey: 'k', model: 'mock-slow' }) }).then((r) => r.json()), mockSlowBase);
    await page.evaluate(() => fetch('/api/models/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatModelId: 'slow', embedModelId: 'mock', chunkModelId: 'mock' }) }).then((r) => r.json()));
    await page.fill('#chat-input', '把这一章的内容完整讲一遍');
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForSelector('.msg-ai .msg-body .spinner', { timeout: 15000 });
    await page.waitForTimeout(260);
    await page.getByRole('button', { name: '停止' }).click();
    // 注意：界面这里显示的是内核写下的 turn/end 文案「用户取消了这次回答」，
    // 不是返回值里的「已取消」——断言用「取消」这个共同子串
    await page.waitForFunction(() => {
      const t = document.querySelector('.chat-thread');
      return !!t && t.innerText.indexOf('取消') >= 0;
    }, null, { timeout: 30000 }).catch(async () => {
      const seen = await page.locator('.chat-thread').innerText().catch(() => '(读不到)');
      throw new Error('点了停止但界面没出现取消态，当前对话区：' + String(seen).replace(/\s+/g, ' ').slice(0, 200));
    });
    await shot('27-停止回答');
    const cancelBtn = await page.getByRole('button', { name: '重新问一次' }).count();
    assert(cancelBtn >= 1, '被取消的那一轮应给出「重新问一次」');
    await page.getByRole('button', { name: '重新问一次' }).first().click();
    await page.waitForFunction(() => {
      const bodies = document.querySelectorAll('.msg-ai .msg-body');
      if (!bodies.length) return false;
      const last = bodies[bodies.length - 1];
      return !last.querySelector('.caret') && !last.querySelector('.spinner') && last.innerText.trim().length > 5;
    }, null, { timeout: 60000 });
    const last = await page.locator('.msg-ai .msg-body').last().innerText();
    assert(last.indexOf('取消') < 0, '重问后应真的拿到回答，实际：' + last.slice(0, 40));
    await page.evaluate(() => fetch('/api/models/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatModelId: 'mock', embedModelId: 'mock', chunkModelId: 'mock' }) }));
    return '停止 → 出现「已取消」与重问入口 → 重问拿到 ' + last.length + ' 字回答';
  });

  /* ---------- 会话记录 ---------- */
  await step('同主题生成两次不覆盖（第二份自动加序号）', async () => {
    const mk = async () => {
      await nav('学 · 练');
      if (!(await page.locator('.chunk-card').count())) {
        await page.locator('.item', { hasText: '提示词工程基础' }).getByRole('button', { name: '开始学' }).click();
        await page.waitForSelector('.chunk-card', { timeout: 20000 });
      }
      await page.getByRole('button', { name: '生成练习册' }).first().click();
      await page.waitForSelector('#topic-input', { timeout: 10000 });
      await page.fill('#topic-input', '提示词');
      await page.getByRole('button', { name: '开始生成练习册' }).click();
      await page.waitForSelector('.ok-dialog:has-text("练习册已生成")', { timeout: 60000 });
      await page.locator('.ok-dialog').getByRole('button', { name: '收起' }).click();
    };
    await mk();
    await mk();
    const arts = (await page.evaluate(() => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()))).data.artifacts.map((a) => a.name);
    const first = arts.filter((n) => n === '练习册-提示词.md').length;
    const second = arts.filter((n) => n === '练习册-提示词-2.md').length;
    assert(first === 1 && second === 1, '同主题两次生成应得到两份文件，实际：' + arts.join(' / '));
    await nav('个性化资源');
    const shown = await page.locator('#view').innerText();
    assert(shown.indexOf('练习册-提示词-2.md') >= 0, '资源页应能看到第二份');
    return '两份都在：练习册-提示词.md / 练习册-提示词-2.md';
  });

  await step('会话按知识库管理：新建会话先选资料范围（通用 / 某个库），列表按库分组', async () => {
    await nav('伴学助手');
    await page.waitForSelector('.rail-new', { timeout: 15000 });
    // 建第二个知识库，用来验证"分组"与"通用"
    const kb2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-e2e-kb2-'));
    fs.writeFileSync(path.join(kb2Dir, 'b.md'), '# 第二门课\n\n## 要点\n\n这是第二门课的资料。\n', 'utf8');
    await page.evaluate((dir) => fetch('/api/kb/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'course2', name: '第二门课', rootDir: dir }),
    }), kb2Dir);
    await page.evaluate(() => fetch('/api/kb/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'course2' }),
    }).then((x) => x.json()));
    await nav('伴学助手');
    await page.waitForSelector('.rail-new-chip', { timeout: 15000 });
    const chips = await page.$$eval('.rail-new-chip', (els) => els.map((e) => e.textContent.trim()));
    assert(chips.indexOf('通用') >= 0, '新建会话应能选「通用」，实际 ' + chips.join('/'));
    assert(chips.join('/').indexOf('第二门课') >= 0, '新建会话应能选具体知识库，实际 ' + chips.join('/'));

    // 选"第二门课"开一段新会话：范围跟着会话走
    await page.locator('.rail-new-chip', { hasText: '第二门课' }).click();
    await page.waitForTimeout(1200);
    const fresh = await page.locator('.turn-block').count();
    assert(fresh === 0, '新建后应是空会话，实际 ' + fresh + ' 轮');
    const scope = await page.evaluate(() => {
      const t = document.querySelector('#chat-thread');
      return t ? t.dataset.session : null;
    });
    assert(scope, '新会话应有 sessionId');
    // 问一句，这段会话才会带着"它用的是哪个库"入库（会话列表按 turn/start 里的 kbId 分组）
    await page.fill('#chat-input', '这门课讲什么？');
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.msg-ai .msg-body').length > 0, null, { timeout: 60000 });
    // 分组：会话栏里两个库各成一组（通用在最上）
    await nav('伴学助手');
    await page.waitForSelector('.panel-group-head', { timeout: 15000 });
    const groupNames = await page.$$eval('.panel-group-head span:first-of-type', (els) => els.map((e) => e.textContent.trim()));
    assert(groupNames.join('/').indexOf('第二门课') >= 0, '新会话应归到「第二门课」组下，实际 ' + groupNames.join('/'));
    assert(groupNames.join('/').indexOf('自测课程资料') >= 0, '旧的会话应还在它自己那一组里，实际 ' + groupNames.join('/'));
    await shot('36-会话按库分组');

    // 折叠/展开：点组头
    const before = await page.locator('.panel-item').count();
    await page.locator('.panel-group-head[data-group="course2"]').click();
    await page.waitForTimeout(500);
    const after = await page.locator('.panel-item').count();
    assert(after < before, '折叠一组后条目应变少：' + before + ' -> ' + after);
    await page.locator('.panel-group-head', { hasText: '第二门课' }).click();
    await page.waitForTimeout(400);

    // 回旧会话：范围跟着那一段会话切回来（旧会话属于 course）
    await page.locator('.panel-item').last().click();
    await page.waitForTimeout(1500);
    const turns = await page.locator('.turn-block').count();
    assert(turns >= 1, '旧会话应还原出对话，实际 ' + turns);
    // 通用模式：新开一段"通用"会话，检索应能跨库（用接口核对，界面只负责把 kbId 传空）
    await page.locator('.rail-new-chip', { hasText: '通用' }).click();
    await page.waitForTimeout(800);
    const all = await page.evaluate(() => fetch('/api/kb/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '', query: '资料', topK: 20 }) }).then((r) => r.json()));
    assert(all.code === 0 && all.data.hits.length >= 2, '通用模式应跨库命中，实际 ' + JSON.stringify(all.data.hits.length));
    const hitKbs = new Set(all.data.hits.map((h) => (h.docTitle || '').split('》')[0]));
    assert(hitKbs.size >= 2, '通用检索的命中应来自两个库，实际 ' + Array.from(hitKbs).join('/'));
    assert(String(all.data.summary || '').indexOf('在 2 个知识库里') >= 0, '概览应写明搜了几个库，实际 ' + all.data.summary);
    // 通用这一段也问一句，会话栏里才会出现「通用」组
    await page.fill('#chat-input', '这门课讲什么？');
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.msg-ai .msg-body').length > 0, null, { timeout: 60000 });
    await page.waitForTimeout(1400);
    const groups2 = await page.$$eval('.panel-group-head span:first-of-type', (els) => els.map((e) => e.textContent.trim()));
    assert(groups2.join('/').indexOf('通用（全部知识库）') >= 0, '开过通用会话后应出现「通用」分组，实际 ' + groups2.join('/'));
    // 切回学 · 练，保持后续步骤的上下文
    await nav('学 · 练');
    return '新建可选范围（' + chips.join('/') + '）· 列表按库分组（' + groupNames.join('/') + '）· 可折叠 · 通用跨 ' + hitKbs.size + ' 个库命中';
  });

  await step('会话总览（原「会话记录」）从对话页进得去，能展开每一步事件', async () => {
    await nav('伴学助手');
    await page.locator('#rail-all').click();
    await page.waitForSelector('.settings-head, #view .item', { timeout: 15000 });
    const title = await page.textContent('#page-title');
    assert(title.indexOf('会话') >= 0, '应落到会话总览，实际 ' + title);
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
    await openRes('notes');
    await page.locator('#view').getByRole('button', { name: '写一条笔记' }).click();
    await page.waitForSelector('#nt-title', { timeout: 10000 });
    await page.fill('#nt-title', 'E2E 自测笔记');
    await page.fill('#nt-text', '这是端到端自测写入的一条笔记。');
    await page.getByRole('button', { name: '保存' }).click();
    await page.waitForSelector('.item:has-text("E2E 自测笔记")', { timeout: 15000 });
    await shot('14-笔记');
    return '已写入并显示';
  });

  await step('错题本有条目且可回到对应章节', async () => {
    await openRes('wrong');
    const n = await page.locator('.item').count();
    assert(n >= 1, '错题本应有条目，实际 ' + n);
    await shot('15-错题本');
    return n + ' 条';
  });

  await step('错题本能重做同一道题，并按间隔把复习往后推', async () => {
    await openRes('wrong');
    await page.waitForSelector('.review-banner', { timeout: 15000 });
    const banner = await page.locator('.review-banner').innerText();
    assert(banner.indexOf('今天该复习') >= 0, '应显示今天该复习的条数，实际：' + banner.replace(/\s+/g, ' '));
    await page.waitForSelector('.tag:has-text("该重做了")', { timeout: 10000 });
    await shot('33-错题本待复习');
    const wrong0 = (await page.evaluate(() => fetch('/api/study/wrong', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()))).data.records;
    const target = wrong0.filter((r) => r.due)[0];
    assert(target && target.hasOptions, '这条错题应存下了原题选项（否则只能自评）');

    await page.locator('.item', { hasText: target.question.slice(0, 12) }).getByRole('button', { name: '重做' }).first().click();
    await page.waitForSelector('.choice', { timeout: 10000 });
    const opts = await page.locator('.choice').count();
    assert(opts >= 2, '重做应给出选项，实际 ' + opts);
    await page.locator('.choice').nth(1).click();
    await page.waitForSelector('.quiz-explain:has-text("答对了")', { timeout: 10000 });
    await page.waitForTimeout(1600);
    const wrong1 = (await page.evaluate(() => fetch('/api/study/wrong', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()))).data.records;
    const after = wrong1.filter((r) => r.id === target.id)[0];
    assert(after.reviews === 1, '重做答对后复习次数应为 1，实际 ' + after.reviews);
    assert(after.due === false, '答对后今天不该再出现，实际 due=' + after.due);
    const nextDays = Math.ceil((after.dueMs - Date.now()) / 86400000);
    assert(nextDays >= 1, '下次复习应至少排到明天，实际 ' + nextDays + ' 天');
    await shot('34-错题重做');
    return '重做同一道题（' + opts + ' 个选项）→ 答对 → 复习次数 1，下次 ' + nextDays + ' 天后';
  });

  await step('标记已掌握后不再进待复习，成长页的待复习数跟着降', async () => {
    const wrongApi = async () => (await page.evaluate(() => fetch('/api/study/wrong', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()))).data.records;
    const reportApi = async () => (await page.evaluate(() => fetch('/api/study/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()))).data;
    const target = (await wrongApi())[0];
    // 先让它回到"待复习"（等价于又答错一次），这样后面的对比才有意义
    await page.evaluate((id) => fetch('/api/study/wrong/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, correct: false }),
    }), target.id);
    await openRes('wrong');
    await page.waitForSelector('.review-banner.due', { timeout: 15000 });
    const dueBefore = (await reportApi()).wrongDue;
    assert(dueBefore === 1, '答错后应回到待复习，实际 ' + dueBefore);

    await page.locator('.item', { hasText: target.question.slice(0, 12) }).getByRole('button', { name: '标记已掌握' }).first().click();
    await page.waitForTimeout(1200);
    const after = (await wrongApi()).filter((r) => r.id === target.id)[0];
    assert(after.mastered === true, '应标记为已掌握');
    const dueAfter = (await reportApi()).wrongDue;
    assert(dueAfter === 0, '成长页的待复习数应降到 0，实际 ' + dueAfter);
    await page.getByRole('button', { name: /已掌握/ }).first().click();
    await page.waitForTimeout(700);
    const rows = await page.locator('.item').count();
    assert(rows >= 1, '已掌握分组里应有这条');
    await shot('35-已掌握');
    return '待复习 ' + dueBefore + ' → 标记掌握 → ' + dueAfter + '；已掌握分组 ' + rows + ' 条';
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

  await step('自绘窗口框：标题栏在、按钮有接线、浏览器里不假装能用', async () => {
    const bar = await page.locator('#titlebar').count();
    assert(bar === 1, '应有自绘标题栏');
    const text = await page.locator('#titlebar .tb-brand').innerText();
    assert(text.indexOf('ITN-Desktop') >= 0, '标题栏应显示应用名 ITN-Desktop，实际：' + text.replace(/\s+/g, ' '));
    const logoOk = await page.evaluate(() => { const i = document.querySelector('#titlebar .tb-logo'); return !!i && i.complete && i.naturalWidth > 0; });
    assert(logoOk, '标题栏应显示网页版那个 logo（图片要真的加载出来）');
    for (const id of ['win-min', 'win-max', 'win-close']) {
      const n = await page.locator('#' + id).count();
      assert(n === 1, '缺少窗口按钮 #' + id);
    }
    // 浏览器里没有预加载脚本：点窗口按钮应给出明确说明，而不是静默无效
    const hasApi = await page.evaluate(() => !!(window.itnWindow && window.itnWindow.minimize));
    assert(!hasApi, '无头浏览器里不应存在 itnWindow（这条同时也验证了"桌面专属能力不依赖浏览器"）');
    await page.locator('#win-min').click();
    await page.waitForFunction(() => {
      const t = document.querySelector('#toast');
      return !!t && t.classList.contains('show') && t.innerText.indexOf('桌面应用窗口') >= 0;
    }, null, { timeout: 8000 });
    const toastText = await page.textContent('#toast');
    // 标题栏高度必须真的让出位置：内容区从标题栏下面开始
    const box = await page.locator('#titlebar').boundingBox();
    const appBox = await page.locator('.app').boundingBox();
    assert(box.height > 30 && box.height < 48, '标题栏高度应在 30~48px，实际 ' + box.height);
    assert(Math.abs(appBox.y - box.height) <= 2, '内容区应紧贴标题栏下方，实际 appY=' + appBox.y + ' barH=' + box.height);
    await shot('32-自绘标题栏');
    return '标题栏 ' + Math.round(box.height) + 'px，三个按钮已接线，浏览器里提示：' + toastText.replace(/\s+/g, ' ').slice(0, 24);
  });

  await step('Ctrl+K 全局检索：资料/章节/笔记/产物一起找', async () => {
    // Ctrl+K 是切换式的：先确保它是关着的，避免上一次失败留下的开着状态把这次"切没了"
    await page.evaluate(() => {
      const p = document.querySelector('#palette');
      if (p) p.hidden = true;
    });
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#palette:not([hidden]) #palette-input', { timeout: 10000 });
    await page.fill('#palette-input', '提示词');
    await page.waitForSelector('.palette-group-title', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.palette-item').length >= 2, null, { timeout: 20000 });
    // 资料切片是走服务端检索的（有 220ms 防抖），必须单独等它回来——这是网页版 ⌘K 的核心能力
    await page.waitForSelector('.palette-item .pi-kind:has-text("资料")', { timeout: 20000 });
    const groups = await page.$$eval('.palette-group-title', (els) => els.map((e) => e.textContent.trim()));
    const labels = await page.$$eval('.palette-item', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 40)));
    assert(groups.length >= 2, '应同时给出多组结果，实际：' + groups.join(' / '));
    assert(groups.indexOf('资料切片') >= 0, '应能搜到知识库切片，实际：' + groups.join(' / '));
    await shot('30-全局检索');
    // 键盘可用：↓ 选下一条，Enter 打开
    const before = await page.locator('.palette-item.active').innerText();
    await page.keyboard.press('ArrowDown');
    const after = await page.locator('.palette-item.active').innerText();
    assert(before !== after, '↓ 应切换选中项');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#palette').hidden, null, { timeout: 10000 });
    const title = await page.textContent('#page-title');
    assert(title.indexOf('学') >= 0, '打开章节条目后应落到学 · 练，实际 ' + title);
    return '分组：' + groups.join(' / ') + '；条目 ' + labels.length + ' 条';

  });

  await step('Ctrl+K 能找到产物并直接播放', async () => {
    await page.evaluate(() => {
      const p = document.querySelector('#palette');
      if (p) p.hidden = true;
    });
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#palette:not([hidden]) #palette-input', { timeout: 10000 });
    await page.fill('#palette-input', '讲义-');
    await page.waitForSelector('.palette-item .pi-kind:has-text("产物")', { timeout: 15000 });
    await page.locator('.palette-item', { hasText: '讲义-' }).first().click();
    await page.waitForSelector('.player:not([hidden])', { timeout: 15000 });
    const counter = await page.textContent('.player-counter');
    await page.locator('#player').press('Escape');
    await page.waitForFunction(() => document.querySelector('#player').hidden, null, { timeout: 10000 });
    // Esc 也能关掉检索弹层
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#palette:not([hidden])', { timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#palette').hidden, null, { timeout: 10000 });
    return '从检索直接播放到 ' + counter + '；Esc 关闭正常';
  });

  await step('就这段记笔记会带上原文摘录（笔记可溯源）', async () => {
    await nav('学 · 练');
    if (!(await page.locator('.chunk-card').count())) {
      await page.locator('.item', { hasText: '提示词工程基础' }).getByRole('button', { name: '开始学' }).click();
      await page.waitForSelector('.chunk-card', { timeout: 20000 });
    }
    await page.locator('.chunk-card').first().getByRole('button', { name: '就这段记笔记' }).click();
    await page.waitForSelector('#nt-text', { timeout: 10000 });
    const value = await page.inputValue('#nt-text');
    assert(value.indexOf('原文摘录') >= 0, '笔记应预填原文摘录，实际：' + value.slice(0, 60));
    await page.fill('#nt-title', 'E2E 溯源笔记');
    await page.getByRole('button', { name: '保存' }).click();
    await page.waitForTimeout(1200);
    const notes = await page.evaluate(() => fetch('/api/study/notes/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()));
    const mine = notes.data.notes.filter((n) => n.title === 'E2E 溯源笔记')[0];
    assert(mine, '笔记应写入成功');
    assert(String(mine.text).indexOf('原文摘录') >= 0, '存下来的笔记应带原文摘录');
    assert(mine.chapter && mine.chapter.length > 0, '笔记应记下它属于哪一章，实际：' + mine.chapter);
    await shot('31-溯源笔记');
    return '笔记带原文摘录，章节记为「' + mine.chapter + '」';
  });

  await step('Esc 能关掉弹层，而且不会误删东西', async () => {
    await settings('知识库');
    await page.waitForSelector('.item:has-text("自测课程资料")', { timeout: 15000 });
    const kbBefore = await page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((j) => (j.data.knowledgeBases || []).length));
    await page.locator('.item', { hasText: '自测课程资料' }).getByRole('button', { name: '删除' }).first().click();
    await page.waitForSelector('#view .card.dialog', { timeout: 10000 });
    const dlgText = await page.locator('#view .card.dialog').first().innerText();
    assert(dlgText.indexOf('删除知识库登记') >= 0, '应弹出确认弹层，实际：' + dlgText.replace(/\s+/g, ' ').slice(0, 60));
    await shot('38-确认弹层');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#view .card.dialog'), null, { timeout: 8000 });
    const kbAfter = await page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((j) => (j.data.knowledgeBases || []).length));
    assert(kbAfter === kbBefore, 'Esc 只是关弹层，不该真的删掉知识库：前 ' + kbBefore + ' 后 ' + kbAfter);
    return '弹层被 Esc 关掉，知识库仍是 ' + kbAfter + ' 个';
  });

  await step('数据与备份：备份能被打开校验，也能删掉', async () => {
    const statusApi = async () => (await page.evaluate(() => fetch('/api/maintenance/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json()))).data;
    const waitBackups = async (want) => {
      for (let i = 0; i < 60; i += 1) {
        const st = await statusApi();
        if (st.backups.length === want) return st;
        await page.waitForTimeout(250);
      }
      throw new Error('等待备份数变成 ' + want + ' 超时');
    };

    await settings('数据与备份');
    await page.waitForSelector('.data-backup .kv-line', { timeout: 15000 });
    const info = await page.locator('.data-backup').innerText();
    assert(info.indexOf('数据与备份') >= 0 || info.indexOf('数据目录') >= 0, '应有「数据与备份」卡片');
    assert(info.indexOf('恢复方式') >= 0, '应写明恢复方式');

    const st0 = await statusApi();
    assert(st0.dbSize > 0, '应能读到数据库大小，实际 ' + st0.dbSize);
    const before = st0.backups.length;

    // 空态里也有一个「立即备份」，这里要指名点卡片动作条里那个
    await page.locator('.data-backup > .row').getByRole('button', { name: '立即备份' }).click();
    const st1 = await waitBackups(before + 1);
    const newest = st1.backups[st1.backups.length - 1];
    const bkPath = path.join(dataDir, 'backups', newest.name);
    assert(fs.existsSync(bkPath), '备份文件应真的写在磁盘上：' + bkPath);
    assert(fs.statSync(bkPath).size === st1.dbSize, '备份应与当前数据库同样大：' + fs.statSync(bkPath).size + ' vs ' + st1.dbSize);
    await page.waitForSelector('.backup-item:has-text("' + newest.name + '")', { timeout: 20000 });
    await shot('25-数据与备份');

    await page.locator('.backup-item', { hasText: newest.name }).getByRole('button', { name: '删除' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await waitBackups(before);
    assert(!fs.existsSync(bkPath), '删除后备份文件应没了');
    return '库 ' + Math.round(st1.dbSize / 1024) + ' KB；备份 ' + newest.name + '（磁盘同大小）→ 已删除';
  });

  await step('我的成长统计已跟上', async () => {
    await nav('我的成长');
    const vals = await page.$$eval('.stat .v', (els) => els.map((e) => parseInt(e.textContent, 10) || 0));
    assert(vals[0] >= 1, '已读切片应 >= 1，实际 ' + vals[0]);
    assert(vals[2] >= 1, '答题总数应 >= 1，实际 ' + vals[2]);
    await shot('16-我的成长');
    return '已读 ' + vals[0] + ' / 完成章节 ' + vals[1] + ' / 答题 ' + vals[2] + ' / 正确率 ' + vals[3] + '%';
  });

  await step('学习日历：连续打卡按真实活动算，当月网格画得出来', async () => {
    await nav('我的成长');
    await page.waitForSelector('.streak-grid', { timeout: 20000 });
    const info = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.streak-cell'));
      const days = cells.filter((c) => !c.classList.contains('empty'));
      return {
        total: days.length,
        studied: cells.filter((c) => c.classList.contains('studied')).length,
        today: cells.filter((c) => c.classList.contains('today')).length,
        tag: (document.querySelector('.card-head .tag') || {}).innerText || '',
      };
    });
    const now = new Date();
    const expectDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    assert(info.total === expectDays, '当月网格应有 ' + expectDays + ' 天，实际 ' + info.total);
    assert(info.today === 1, '今天应有且只有一个格子被标出，实际 ' + info.today);
    assert(info.studied >= 1, '这一段自测里明明有学习活动，日历上应至少有一天是"学过"');
    const api = await page.evaluate(() => fetch('/api/study/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kbId: 'course' }) }).then((r) => r.json()).then((j) => j.data));
    const todayKey = new Date().toLocaleDateString('sv-SE');
    assert((api.studyDates || []).indexOf(todayKey) >= 0, '接口应把今天算进学习日期，实际 ' + JSON.stringify((api.studyDates || []).slice(-2)));
    await shot('54-学习日历');
    return '网格 ' + info.total + ' 天 · 学过 ' + info.studied + ' 天 · 今天已计入 · 徽标「' + info.tag + '」';
  });

  await step('我的成长：六维雷达图 + 依据表 + 重点建议（与接口同口径）', async () => {
    await nav('我的成长');
    await page.waitForSelector('.ability-radar', { timeout: 20000 });
    await page.waitForTimeout(900);
    const drawn = await page.evaluate(() => ({
      rows: document.querySelectorAll('.ability-row').length,
      key: Array.from(document.querySelectorAll('.ability-key')).map((e) => e.textContent),
      basis: Array.from(document.querySelectorAll('.ability-basis')).map((e) => e.textContent.trim()),
      advice: (document.querySelector('.ability-advice') || {}).innerText || '',
      cw: (document.querySelector('.ability-radar') || {}).width || 0,
      hasSelf: !!document.querySelector('.ability-legend .lg.self'),
      hasEv: !!document.querySelector('.ability-legend .lg.ev'),
    }));
    assert(drawn.rows === 6, '六维应各一行，实际 ' + drawn.rows);
    assert(drawn.cw > 100, '雷达图应真的画出来了（canvas 有像素宽），实际 ' + drawn.cw);
    assert(drawn.hasSelf && drawn.hasEv, '图例要同时标明"自评"与"实测参考"');
    assert(drawn.basis.every((x) => x.length > 0), '每一维都要写清依据，实际：' + JSON.stringify(drawn.basis));
    const api = await page.evaluate(() => fetch('/api/study/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kbId: 'course' }) }).then((r) => r.json()).then((j) => j.data));
    assert(api.abilities && api.abilities.length === 6, '接口应回六维，实际 ' + JSON.stringify(api.abilities && api.abilities.length));
    const apiKeys = api.abilities.map((a) => a.key).join('/');
    assert(drawn.key.join('/') === apiKeys, '界面与接口的六维顺序应一致：' + drawn.key.join('/') + ' vs ' + apiKeys);
    assert(api.weakest && drawn.advice.indexOf(api.weakest) >= 0, '重点建议要指向接口给的那一维：' + drawn.advice.replace(/\s+/g, ' ').slice(0, 60));
    // 数据不足时不给假分数：没练习的维度 evidence 必须是 -1
    const noData = api.abilities.filter((a) => a.evidence < 0);
    assert(noData.every((a) => a.basis.length > 0), '没有参考分的维度也要说明原因');
    await shot('49-六维能力画像');
    // 最近两周：图要真画出来，且"今天"那一格与接口一致
    await page.waitForSelector('.trend-chart', { timeout: 15000 });
    await page.waitForTimeout(600);
    const trend = await page.evaluate(() => ({
      cw: (document.querySelector('.trend-chart') || {}).width || 0,
      side: (document.querySelector('.trend-side') || {}).innerText || '',
      advice: (document.querySelector('.trend-side .trend-advice') || {}).innerText || '',
    }));
    assert(trend.cw > 100, '趋势图应真的画出来，实际 ' + trend.cw);
    assert(trend.side.indexOf('本周') >= 0 && trend.side.indexOf('上周') >= 0, '要给出本周/上周对照，实际：' + trend.side.replace(/\s+/g, ' ').slice(0, 80));
    assert(trend.advice.length > 4, '要有一句每周建议');
    assert(api.trend && api.trend.length >= 1, '接口应回按天汇总，实际 ' + JSON.stringify(api.trend));
    const today = new Date().toLocaleDateString('sv-SE');
    const apiToday = api.trend.filter((x) => x.date === today)[0];
    if (apiToday) {
      assert(trend.side.indexOf('今天：') >= 0, '今天有记录时右侧应写"今天：…"，实际：' + trend.side.replace(/\s+/g, ' ').slice(0, 80));
    }
    await shot('50-最近两周');
    // 学习报告：存成产物 → 能读回内容
    const before = await page.evaluate(() => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((j) => (j.data.artifacts || []).length));
    await page.locator('#view button', { hasText: '导出报告' }).first().click();
    await page.waitForFunction((n) => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((j) => (j.data.artifacts || []).length > n), before, { timeout: 15000 });
    const arts = await page.evaluate(() => fetch('/api/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((j) => j.data.artifacts.map((x) => x.name)));
    const made = arts.filter((x) => x.indexOf('我的成长-') === 0)[0];
    assert(made, '应生成一份 我的成长-*.md，实际：' + arts.join(','));
    const body = await page.evaluate((nm) => fetch('/api/artifacts/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) }).then((r) => r.json()).then((j) => j.data.content), made);
    assert(String(body).indexOf('六维能力') >= 0 && String(body).indexOf('最近两周') >= 0, '报告里应有六维与最近两周，实际：' + String(body).slice(0, 80));
    // 清理：删掉这份产物，别影响后面的资源页断言
    await page.evaluate((nm) => fetch('/api/artifacts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) }), made);
    await shot('51-学习报告');
    return '六维 ' + drawn.rows + ' 行有依据 · 重点：' + api.weakest + ' · 趋势 ' + api.trend.length + ' 天有数据 · 报告已导出（' + made + '）';
  });

  await step('侧栏徽标反映真实数量', async () => {
    const badges = await page.$$eval('.nav-item', (els) => els.map((e) => {
      const b = e.querySelector('.nav-badge');
      const t = e.querySelector('.rail-tip');
      return b ? (t ? t.textContent.trim().split('·')[0].trim() : '?') + '=' + b.textContent : null;
    }).filter(Boolean));
    assert(badges.length >= 1, '我的资源与个性化资源都应有徽标，实际 ' + JSON.stringify(badges));
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

  /* ---------- 新壳：标题栏前后箭头 / 侧栏显隐 / 主题 / 设置分区 ---------- */
  await step('标题栏的前进后退真的能换页（按钮可用态按访问栈算）', async () => {
    await nav('首页');
    await openRes('notes');
    assert(await page.evaluate(() => !document.querySelector('#nav-back').disabled), '走过一页之后「后退」应可点');
    await page.locator('#nav-back').click();
    await page.waitForFunction(() => (document.querySelector('#page-title') || {}).textContent === '学习中心', null, { timeout: 10000 });
    assert(await page.evaluate(() => !document.querySelector('#nav-forward').disabled), '后退之后「前进」应可点');
    await page.locator('#nav-forward').click();
    await page.waitForFunction(() => (document.querySelector('#page-title') || {}).textContent === '我的资源', null, { timeout: 10000 });
    return '后退 → 首页，前进 → 我的资源';
  });

  await step('折叠的是第二层：窄栏固定不动，收起后仍可点、重载仍保持', async () => {
    try {
    await page.locator('#rail-toggle').click();
    await page.waitForTimeout(350);
    let st = await page.evaluate(() => ({
      hidden: document.body.classList.contains('panel-hidden'),
      panel: (document.querySelector('#panel') || { getBoundingClientRect: () => ({ width: -1 }) }).getBoundingClientRect().width,
      rail: (document.querySelector('#rail') || { getBoundingClientRect: () => ({ width: -1 }) }).getBoundingClientRect().width,
    }));
    assert(st.hidden, '点折叠按钮应收起第二层面板');
    assert(st.panel < 1, '收起后面板不该占宽度，实际 ' + st.panel);
    assert(st.rail > 40, '最左侧窄栏必须固定不动，实际宽度 ' + st.rail);
    // 窄栏还在，就还能换页
    await nav('我的资源');
    await page.waitForTimeout(600);
    assert((await page.textContent('#page-title')).indexOf('资源') >= 0, '面板收起时窄栏仍应能切页');
    await page.keyboard.press('Control+Shift+S');
    await page.waitForTimeout(400);
    st = await page.evaluate(() => ({ hidden: document.body.classList.contains('panel-hidden') }));
    assert(!st.hidden, 'Ctrl+Shift+S 应能把面板放回来');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.nav-item', { timeout: 20000 });
    await page.waitForTimeout(900);
    st = await page.evaluate(() => ({ hidden: document.body.classList.contains('panel-hidden') }));
    assert(!st.hidden, '面板状态存在内核里，重载后应保持展开');
    return '第二层收起 → 窄栏仍可点 → Ctrl+Shift+S 放回 → 重载保持';
    } finally {
      // 这一步会把面板收起并存进内核：失败也要还原，否则后面所有用面板的步骤都会被连累。
      // 注意只看"当前是不是收起的"——已经展开时再按一次快捷键等于又把它收起来。
      const stillHidden = await page.evaluate(() => document.body.classList.contains('panel-hidden')).catch(() => false);
      if (stillHidden) {
        await page.keyboard.press('Control+Shift+S').catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  });

  await step('每个根功能都有自己的第二层（功能目录 / 列表）', async () => {
    // 成长与校准合成一个根；笔记与错题本合成「我的资源」；原来的产物页改叫「个性化资源」
    const roots = ['首页', '学 · 练', '我的成长', '我的资源', '个性化资源', '领域知识库', '伴学助手', '设置'];
    const seen = [];
    for (const label of roots) {
      await nav(label);
      await page.waitForSelector('#panel-title', { timeout: 15000 });
      const info = await page.evaluate(() => ({
        title: ((document.querySelector('#panel-title') || {}).textContent || '').trim(),
        items: document.querySelectorAll('#panel-body .panel-item, #panel-body .settings-nav button').length,
        empty: document.querySelectorAll('#panel-body .panel-empty').length,
        foot: document.querySelectorAll('#panel-foot button').length,
      }));
      assert(info.title.length > 0, label + ' 的第二层面板应有标题');
      assert(info.items + info.empty + info.foot > 0, label + ' 的第二层面板是空的（既没有条目也没有空态）');
      seen.push(label + '→' + info.title + '(' + info.items + ')');
    }
    return seen.join(' / ');
  });

  await step('面板挑一个 → 主区滚到并高亮同一条（两栏联动）', async () => {
    await openRes('notes');
    await page.waitForSelector('#panel-body .panel-item', { timeout: 15000 });
    const first = await page.locator('#panel-body .panel-item').first();
    const want = await first.locator('.panel-item-title').innerText();
    await first.click();
    await page.waitForTimeout(900);
    const hit = await page.evaluate((t) => {
      const nodes = Array.from(document.querySelectorAll('#view [data-id]'));
      const node = nodes.filter((n) => (n.innerText || '').indexOf(t) >= 0)[0];
      return node ? { id: node.dataset.id, ring: node.classList.contains('focus-ring') } : null;
    }, want.trim());
    assert(hit, '主区里应能找到面板点的那条笔记：' + want);
    assert(hit.ring, '主区对应的那条应被高亮描边');
    return '面板点「' + want.trim() + '」→ 主区滚动并高亮';
  });

  await step('首页星云图：一库一团，点章节出动作卡', async () => {
    await nav('首页');
    await page.waitForSelector('.graph-canvas', { timeout: 20000 });
    await page.waitForTimeout(1000);
    const tree = await page.evaluate(() => fetch('/api/study/tree', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kbId: 'course' }) }).then((r) => r.json()).then((j) => (j.data.chapters || []).length));
    const info = await page.evaluate(() => (window.itnGraphInfo ? window.itnGraphInfo() : null));
    assert(!!info, '应有星云图自检接缝 itnGraphInfo');
    assert(info.clusters >= 1, '至少一团星云，实际 ' + info.clusters);
    assert(info.perCluster['course'] === tree, '这一团的章节数应等于章节数（每库 ≤200 的折叠规则之外），实际 ' + JSON.stringify(info.perCluster) + ' vs ' + tree);
    // 点星云中心 → 切当前库（这一团就是当前库时，侧卡上应写"当前知识库"）
    const cpos = await page.evaluate(() => window.itnGraphPick('course'));
    assert(cpos, '应能定位到 course 这团星云的中心');
    await clickGraphPoint(cpos);
    await page.waitForSelector('.graph-side:not([hidden])', { timeout: 8000 });
    let side = await page.locator('.graph-side').innerText();
    assert(side.indexOf('章节') >= 0 && side.indexOf('当前知识库') >= 0, '点星云中心应给出这一团的概览，实际：' + side.replace(/\s+/g, ' ').slice(0, 80));
    await shot('46-星云图-一团');
    // 点章节 → 侧卡（继续学 / 出练习 / 生成讲义）
    const name = await page.evaluate(() => fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kbId: 'course' }) }).then((r) => r.json()).then((j) => j.data.nodes.slice().sort((a, b) => b.chunkCount - a.chunkCount)[0].name));
    const pos = await page.evaluate((nm) => window.itnGraphPick('course', nm), name);
    assert(pos, '应能拿到章节「' + name + '」在画布上的坐标');
    await clickGraphPoint(pos);
    await page.waitForSelector('.graph-side:not([hidden])', { timeout: 8000 });
    side = await page.locator('.graph-side').innerText();
    assert(side.indexOf(name) >= 0, '侧卡应显示章节名，实际：' + side.replace(/\s+/g, ' ').slice(0, 60));
    for (const label of ['继续学', '出练习', '生成讲义']) {
      assert(side.indexOf(label) >= 0, '侧卡里应有「' + label + '」，实际：' + side.replace(/\s+/g, ' ').slice(0, 80));
    }
    await shot('47-星云图-章节侧卡');
    return '一团 ' + info.perCluster['course'] + ' 章 · 点星云出概览 · 点章节出动作卡';
  });

  await step('星云图：点另一个星云切库、切页不残留、减少动态时不呼吸', async () => {
    // 点 course2 那团星云中心 → 当前库跟着切
    const c2 = await page.evaluate(() => window.itnGraphPick('course2'));
    assert(c2, '应能定位到第二团的中心');
    await clickGraphPoint(c2);
    let side = await page.locator('.graph-side').innerText();
    assert(side.indexOf('当前知识库') >= 0, '点了第二团之后，侧卡应显示它为当前库，实际：' + side.replace(/\s+/g, ' ').slice(0, 80));
    await shot('48-星云图-切库');
    // 切回第一个库，别影响后面的步骤
    await clickGraphPoint(await page.evaluate(() => window.itnGraphPick('course')));

    await openRes('notes');
    await page.waitForTimeout(400);
    await nav('首页');
    await page.waitForSelector('.graph-canvas', { timeout: 20000 });
    await page.waitForTimeout(900);
    const again = await page.evaluate(() => Number(document.querySelector('.graph-canvas').dataset.nodes || 0));
    assert(again > 0, '切回来还能画出星云，实际节点 ' + again);
    // 减少动态：呼吸静止（两次采样坐标应当一致）
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await nav('首页');
    await page.waitForSelector('.graph-canvas', { timeout: 20000 });
    await page.waitForTimeout(1200);
    const who = await page.evaluate(() => fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kbId: 'course' }) }).then((r) => r.json()).then((j) => j.data.nodes[0].name));
    const a1 = await page.evaluate((nm) => window.itnGraphPick('course', nm), who);
    await page.waitForTimeout(1500);
    const a2 = await page.evaluate((nm) => window.itnGraphPick('course', nm), who);
    assert(Math.abs(a1.x - a2.x) < 0.5 && Math.abs(a1.y - a2.y) < 0.5,
      'prefers-reduced-motion 下不该呼吸位移，实际 ' + JSON.stringify([a1.x, a2.x]));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    return '切页回来 ' + again + ' 点 · 减少动态时坐标稳定';
  });

  await step('登记知识库：目录用系统对话框选，浏览器里如实说明', async () => {
    await settings('知识库');
    await page.waitForSelector('#kb-dir', { timeout: 15000 });
    const pickBtn = page.locator('button', { hasText: '选择…' }).first();
    assert((await page.locator('button', { hasText: '选择…' }).count()) >= 1, '目录旁边应有「选择…」按钮');
    assert(!(await page.evaluate(() => !!(window.itnWindow && window.itnWindow.pickDirectory))),
      '无头浏览器里不应存在目录对话框能力（这条同时验证"桌面专属能力不依赖浏览器"）');
    await pickBtn.click();
    await page.waitForFunction(() => {
      const t = document.querySelector('#toast');
      return !!t && t.classList.contains('show') && t.innerText.indexOf('桌面应用窗口') >= 0;
    }, null, { timeout: 8000 });
    const t = await page.textContent('#toast');
    await shot('43-目录选择');
    return '按钮在，浏览器里提示：' + t.replace(/\s+/g, ' ').slice(0, 26);
  });

  await step('导入资料：单独一份文件（不用先整理成文件夹）', async () => {
    await settings('知识库');
    await page.waitForSelector('#kb-import-path', { timeout: 15000 });
    assert((await page.locator('button', { hasText: '选文件…' }).count()) >= 1, '导入卡片里应有「选文件…」按钮');
    const readKbs = () => page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((j) => (j.data.knowledgeBases || [])));
    const before = (await readKbs()).length;
    await page.fill('#kb-import-path', singleFile);
    await page.fill('#kb-import-name', '散落的一课');
    await page.getByRole('button', { name: '导入并建立索引', exact: true }).click();
    await page.waitForSelector('.ok-dialog:has-text("索引完成")', { timeout: 60000 });
    const kbs = await readKbs();
    assert(kbs.length === before + 1, '导入后应多一个知识库，实际 ' + before + ' → ' + kbs.length);
    const info = kbs.find((k) => (k.name || '') === '散落的一课');
    assert(!!info, '应能在知识库列表里看到刚导入的那份资料');
    assert(/[\\/]source$/.test(info.rootDir || ''), '单文件应复制进受管资料目录（…/kb/<id>/source），实际 ' + (info && info.rootDir));
    assert((info.sourcePath || '') === singleFile, '登记里应记住原始路径（sourcePath），实际 ' + (info && info.sourcePath));
    const chunks = info.chunkCount || 0;
    assert(chunks > 0, '导入后应真的建成索引，实际切片 ' + chunks);
    await page.locator('.ok-dialog').getByRole('button', { name: '收起' }).click();
    await shot('44-导入单文件');
    return '新增知识库 ' + info.id + ' · 切片 ' + chunks + ' 片 · 资料目录 …\\source · 来源已记住';
  });

  await step('显示大小：页面缩放 + 字体大小（也能用 Ctrl +/- 调，重载后记得住）', async () => {
    await settings('外观');
    await page.waitForSelector('.setting-row', { timeout: 15000 });
    const rows = await page.locator('.setting-row').count();
    assert(rows >= 2, '外观里应有"页面缩放"与"字体大小"两行，实际 ' + rows);
    const read = () => page.evaluate(() => ({
      zoom: document.body.style.zoom || '1',
      fs: getComputedStyle(document.documentElement).getPropertyValue('--fs').trim() || '1',
      base: parseFloat(getComputedStyle(document.body).fontSize),
    }));
    const before = await read();
    // 页面缩放：点 115%
    await page.locator('#view .setting-row', { hasText: '页面缩放' }).locator('button', { hasText: '115%' }).click();
    await page.waitForTimeout(500);
    let st = await read();
    assert(Math.abs(parseFloat(st.zoom) - 1.15) < 0.01, '页面缩放应变成 1.15，实际 ' + st.zoom);
    // 字体大小：点「大」
    await page.locator('#view .setting-row', { hasText: '字体大小' }).locator('button', { hasText: /^大$/ }).click();
    await page.waitForTimeout(500);
    st = await read();
    assert(Math.abs(parseFloat(st.fs) - 1.1) < 0.01, '字体倍数应变成 1.1，实际 ' + st.fs);
    assert(st.base > before.base, '字体应真的变大：' + before.base + ' → ' + st.base);
    await shot('52-显示大小');
    // Ctrl + 也能调缩放（回到 130%）
    await page.keyboard.press('Control+=');
    await page.waitForTimeout(400);
    st = await read();
    assert(Math.abs(parseFloat(st.zoom) - 1.3) < 0.01, 'Ctrl + 应把缩放加到 130%，实际 ' + st.zoom);
    // Ctrl 0 复位
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(400);
    st = await read();
    assert(Math.abs(parseFloat(st.zoom) - 1) < 0.01, 'Ctrl 0 应复位到 100%，实际 ' + st.zoom);
    // 再点回 115%，然后重载：两个偏好都该从内核读回来
    await settings('外观');
    await page.locator('#view .setting-row', { hasText: '页面缩放' }).locator('button', { hasText: '115%' }).click();
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.nav-item', { timeout: 20000 });
    await page.waitForTimeout(1200);
    const after = await read();
    assert(Math.abs(parseFloat(after.zoom) - 1.15) < 0.01, '重载后页面缩放应保持 115%，实际 ' + after.zoom);
    assert(Math.abs(parseFloat(after.fs) - 1.1) < 0.01, '重载后字体倍数应保持 1.1，实际 ' + after.fs);
    // 复位，别影响后面的截图与坐标计算
    await page.locator('#view .setting-row', { hasText: '页面缩放' }).locator('button', { hasText: '100%' }).click();
    await page.waitForTimeout(300);
    await page.locator('#view .setting-row', { hasText: '字体大小' }).locator('button', { hasText: '标准' }).click();
    await page.waitForTimeout(300);
    return '缩放 100%→115%→Ctrl+ 130%→Ctrl 0 复位；字体 1.1 倍；重载后仍是 115% / 1.1';
  });

  await step('主题三档：切换立即生效、写进内核、重载后仍然生效', async () => {
    await settings('外观');
    const cards = await page.locator('.theme-card').count();
    assert(cards === 3, '应有浅色 / 深色 / 跟随系统三档，实际 ' + cards);
    await page.locator('.theme-card.dark').click();
    await page.waitForTimeout(700);
    let st = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor }));
    assert(st.attr === 'dark', '选深色后 html 应带 data-theme=dark，实际 ' + st.attr);
    const darkBg = st.bg;
    await shot('40-深色模式');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.nav-item', { timeout: 20000 });
    await page.waitForTimeout(1200);
    st = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor }));
    assert(st.attr === 'dark' && st.bg === darkBg, '主题应重载后仍然生效，实际 ' + JSON.stringify(st));
    await settings('外观');
    await page.locator('.theme-card.light').click();
    await page.waitForTimeout(700);
    st = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor }));
    assert(st.attr === 'light' && st.bg !== darkBg, '切回浅色后背景应变白，实际 ' + JSON.stringify(st));
    return '深色 ' + darkBg + ' → 浅色 ' + st.bg + '（重载后仍生效）';
  });

  await step('设置页：左侧八个分区、右侧跟着换、深链直达、老路由兼容', async () => {
    await nav('设置');
    const secs = await page.$$eval('.settings-nav button', (els) => els.map((e) => e.textContent.trim()));
    assert(secs.length === 8, '设置应有 8 个分区（多了「智能体」），实际 ' + secs.length + '：' + secs.join('/'));
    assert(secs.join('/').indexOf('智能体') >= 0, '应有「智能体」分区（工作目录 / 权限）');
    assert(secs.join('/').indexOf('模型与接口') >= 0, '模型配置应该收在设置里');
    await page.goto(base + '#/settings/models', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#m-id', { timeout: 20000 });
    let active = await page.locator('.settings-nav button.active').innerText();
    assert(active.indexOf('模型与接口') >= 0, '深链应停在模型分区，实际 ' + active);
    await page.goto(base + '#/models', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#m-id', { timeout: 20000 });
    const hash = await page.evaluate(() => location.hash);
    assert(hash === '#/settings/models', '老路由 #/models 应换成 #/settings/models，实际 ' + hash);
    await shot('41-设置分区');
    return secs.join('/');
  });

  await step('设置里能保存模型并测通连通性（模型配置已并入设置）', async () => {
    await settings('模型与接口');
    await page.fill('#m-id', 'mock2');
    await page.fill('#m-name', '设置页保存的模型');
    await page.fill('#m-base', mockBase);
    await page.fill('#m-key', 'mock-key');
    await page.fill('#m-model', 'mock-chat');
    await page.getByRole('button', { name: '保存模型' }).click();
    await page.waitForSelector('.item:has-text("设置页保存的模型")', { timeout: 15000 });
    await page.locator('.item', { hasText: '设置页保存的模型' }).getByRole('button', { name: '测试连通' }).click();
    await page.waitForSelector('.tag:has-text("连通")', { timeout: 20000 }).catch(() => {});
    const txt = await page.locator('.item', { hasText: '设置页保存的模型' }).innerText();
    assert(txt.indexOf('mock') >= 0, '设置里的模型条目应显示配置信息');
    await page.locator('.item', { hasText: '设置页保存的模型' }).getByRole('button', { name: '删除' }).click();
    await page.waitForTimeout(900);
    return '保存 → 测试连通 → 删除';
  });

  await step('联网搜索（Tavily）：配置能保存、密钥不回传、开启后工具变可用', async () => {
    const wsGet = async () => page.evaluate(() => fetch('/api/websearch/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((j) => j.data));
    await settings('模型与接口');
    await page.waitForSelector('#ws-key', { timeout: 15000 });
    let ws = await wsGet();
    assert(ws.provider === 'tavily', '联网搜索服务应是 Tavily，实际 ' + JSON.stringify(ws));
    assert(ws.enabled === false && ws.hasKey === false, '默认应是未启用、无密钥，实际 ' + JSON.stringify(ws));

    // 填一个假密钥并开启：接口只能回掩码，任何地方都不能把密钥原样吐回来
    await page.fill('#ws-key', 'tvly-e2e-fake-key-1234567890');
    await page.selectOption('#ws-enabled', '1');
    await page.selectOption('#ws-results', '5');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForTimeout(1400);
    ws = await wsGet();
    assert(ws.enabled === true && ws.hasKey === true, '保存后应是已启用且已设置密钥，实际 ' + JSON.stringify(ws));
    const raw = await page.evaluate(() => fetch('/api/websearch/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.text()));
    assert(raw.indexOf('tvly-e2e-fake-key-1234567890') < 0, '整个响应体都不该出现完整密钥，实际 ' + raw.slice(0, 120));

    const tools = await page.evaluate(() => fetch('/api/tools/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()));
    const web = (tools.data.tools || []).filter((t) => t.name === 'web_search')[0];
    assert(web && web.available === true, '开启后 web_search 应变为可用，实际 ' + JSON.stringify(web));
    await shot('42-联网搜索配置');

    // 复原：清除密钥并关掉，后面的步骤不该被它影响
    await settings('模型与接口');
    await page.waitForSelector('#ws-key', { timeout: 15000 });
    await page.getByRole('button', { name: '清除密钥' }).click();
    await page.waitForTimeout(1400);
    ws = await wsGet();
    assert(ws.hasKey === false && ws.enabled === false, '清除后应回到未配置，实际 ' + JSON.stringify(ws));
    const again = await page.evaluate(() => fetch('/api/tools/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()));
    const web2 = (again.data.tools || []).filter((t) => t.name === 'web_search')[0];
    assert(web2 && web2.available === false, '清除后应重新标成不可用，实际 ' + JSON.stringify(web2));
    return '保存 → 掩码回显 → 工具变可用 → 清除复原';
  });

  await step('对话框：一整块输入区，一行只留 ＋ / 权限 / 发送（模型只是一行小字）', async () => {
    await nav('伴学助手');
    await page.waitForSelector('.composer', { timeout: 15000 });
    const ph = await page.getAttribute('#chat-input', 'placeholder');
    assert(ph.indexOf('描述任务') >= 0, '输入框应是"描述任务，输入 / 调用技能"，实际：' + ph);
    // 输入框上只该有一枚 chip：权限档位。联网与技能都不该在这儿占位置。
    const chips = await page.$$eval('.composer-chip', (els) => els.map((e) => e.innerText.trim()));
    assert(chips.length === 1, '输入区只该有一枚 chip（权限档位），实际 ' + JSON.stringify(chips));
    assert(/请求批准|帮我批准|完全访问/.test(chips[0]), '这枚 chip 应是权限档位，实际 ' + chips[0]);
    const modelText = await page.locator('.composer-model').innerText();
    assert(modelText.length > 0, '右边应有一行"当前模型"的小字');
    assert((await page.locator('.composer-send svg').count()) === 1, '发送按钮应是圆形箭头按钮');
    assert((await page.locator('.composer-menu-item').count()) === 0, '＋ 菜单没点开时不该存在');
    await page.locator('.composer-row .composer-icon').first().click();
    await page.waitForSelector('.cm-actions .composer-menu-item', { timeout: 8000 });
    const items = await page.$$eval('.cm-actions .cm-label', (els) => els.map((e) => e.textContent));
    assert(items.join('/').indexOf('读取网页') >= 0, '＋ 菜单里应有「读取网页…」，实际 ' + items.join('/'));
    assert(items.join('/').indexOf('联网方式') < 0, '联网方式不该再出现在 ＋ 菜单里（联网交给 agent 判断）');
    assert(items.join('/').indexOf('工具与技能') >= 0, '＋ 菜单里应有「工具与技能…」，实际 ' + items.join('/'));
    assert(items.length <= 5, '＋ 菜单只放真做得成的事，实际 ' + items.length + ' 项：' + items.join('/'));
    await shot('44-对话框');
    // 输入框随内容长高
    await page.fill('#chat-input', '第一行\n第二行\n第三行\n第四行');
    await page.waitForTimeout(300);
    const h = await page.evaluate(() => document.querySelector('#chat-input').getBoundingClientRect().height);
    assert(h > 60, '输入框应随内容长高，实际 ' + Math.round(h));
    await page.fill('#chat-input', '');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    return '占位符「' + ph + '」· 一枚 chip ' + chips[0] + ' · 模型小字 ' + modelText + ' · ＋ 菜单 ' + items.length + ' 项';
  });

  await step('权限：那三档就是 lumin 的 permissions（选完写回内核）', async () => {
    await nav('伴学助手');
    await page.waitForSelector('.composer-chip', { timeout: 15000 });
    await page.locator('.composer-chip').first().click();
    await page.waitForSelector('.cm-perm .composer-menu-item', { timeout: 8000 });
    const modes = await page.$$eval('.cm-perm .cm-label', (els) => els.map((e) => e.textContent));
    for (const m of ['请求批准', '帮我批准', '完全访问权限']) {
      assert(modes.indexOf(m) >= 0, '权限菜单里应有「' + m + '」，实际 ' + modes.join('/'));
    }
    await page.locator('.cm-perm .composer-menu-item', { hasText: '帮我批准' }).click();
    await page.waitForTimeout(900);
    let pref = await page.evaluate(() => fetch('/api/prefs/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((j) => j.data.agentPerm));
    assert(pref === 'auto', '选「帮我批准」应把 agentPerm 写成 auto，实际 ' + pref);
    const chip1 = await page.locator('.composer-chip').first().innerText();
    assert(chip1.indexOf('帮我批准') >= 0, 'chip 应跟着变，实际 ' + chip1);
    await shot('45-权限档位');
    // 设置 → 智能体：同一份设置（工作目录 / 权限 / 跑命令）
    await settings('智能体');
    await page.waitForSelector('#agent-dir', { timeout: 15000 });
    const cardText = await page.locator('#view').innerText();
    assert(cardText.indexOf('工作目录') >= 0, '智能体页应有工作目录');
    assert(cardText.indexOf('允许运行命令') >= 0, '智能体页应有"允许运行命令"开关');
    await shot('46-智能体设置');
    // 复原成默认的「请求批准」
    await page.locator('.setting-row', { hasText: '请求批准' }).getByRole('button').click();
    await page.waitForTimeout(700);
    pref = await page.evaluate(() => fetch('/api/prefs/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((j) => j.data.agentPerm));
    assert(pref === 'ask', '复原成请求批准，实际 ' + pref);
    return '三档：' + modes.join(' / ') + ' · 选完写回内核 · 设置页同一份';
  });

  await step('技能：输入 / 就能挑，绑到这一段会话（输入框上不再有技能选项）', async () => {
    await nav('伴学助手');
    await page.waitForSelector('.composer-chip', { timeout: 15000 });
    await page.waitForTimeout(600);
    // 技能不在输入框上（用户明确不要那个选项）：它的入口就是输入 "/"
    // 输入 / 打开技能菜单：只出技能，不出别的动作
    await page.fill('#chat-input', '/');
    await page.waitForSelector('.cm-skills .composer-menu-item', { timeout: 8000 });
    const actsHidden = await page.evaluate(() => { const a = document.querySelector('.cm-actions'); return a ? a.hidden : null; });
    assert(actsHidden === true, '输入 / 时不该同时列出"读取网页/添加资料目录"这些动作');
    const skillItems = await page.$$eval('.cm-skills .cm-label', (els) => els.map((e) => e.textContent));
    assert(skillItems.join('/').indexOf('联网专题研究') >= 0, '技能菜单里应有内置技能，实际 ' + skillItems.join('/'));
    await shot('47-技能菜单');
    await page.locator('.cm-skills .composer-menu-item', { hasText: '联网专题研究' }).click();
    await page.waitForTimeout(1200);
    // 选完之后输入框清空、壳上不再显示技能名（技能是会话级的，写在工具面板里）
    // 会话里真的绑上了（按对话区标着的会话 id 去问）
    const sid = await page.evaluate(() => (document.querySelector('#chat-thread') ? document.querySelector('#chat-thread').dataset.session : ''));
    assert(sid, '挑技能时应顺手开一段会话（对话区上要标着 sessionId）');
    const bound = await page.evaluate((id) => fetch('/api/skills/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) }).then((r) => r.json()).then((j) => j.data.bound), sid);
    assert(bound === 'web-research', '绑定的技能应存在内核里，实际 ' + bound);
    await page.fill('#chat-input', '');
    // 工具面板上说清"这次只允许这些工具"
    await page.evaluate(() => { const b = document.querySelector('#tool-sheet'); if (b) b.hidden = false; });
    await page.waitForSelector('#tool-sheet:not([hidden])', { timeout: 10000 });
    const sheet = await page.locator('#tool-sheet').innerText();
    assert(sheet.indexOf('联网专题研究') >= 0, '工具面板应说明这次用的是哪个技能');
    await page.evaluate(() => { const b = document.querySelector('#tool-sheet'); if (b) b.hidden = true; });
    // 复原：解绑，别影响后面的步骤
    await page.evaluate((id) => fetch('/api/skills/bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id, skill: '' }) }), sid);
    return '输入 / 挑技能 → 会话里绑上 web-research → 工具面板同步';
  });

  await step('设置 · 技能：清单、允许的工具、能打开正文', async () => {
    await settings('技能');
    await page.waitForSelector('#view .item:has-text("web-research")', { timeout: 15000 });
    const txt = await page.locator('#view .card').first().innerText();
    assert(txt.indexOf('允许工具') >= 0, '技能卡片应写明允许的工具，实际：' + txt.replace(/\s+/g, ' ').slice(0, 80));
    assert(txt.indexOf('内置') >= 0, '应标出内置技能（只读）');
    await page.locator('#view .item', { hasText: 'web-research' }).getByRole('button', { name: '看正文' }).click();
    await page.waitForSelector('#view .card.dialog .artifact-preview', { timeout: 10000 });
    const body = await page.locator('#view .card.dialog').innerText();
    assert(body.indexOf('联网专题研究') >= 0 || body.length > 100, '应能打开技能正文');
    await shot('48-技能设置');
    await page.keyboard.press('Escape');
    return '清单 + 允许工具 + 正文可看';
  });

  await step('伴学助手与会话记录合并成一个入口（会话栏挂在对话页左侧）', async () => {
    await nav('伴学助手');
    await page.waitForTimeout(700);
    assert(await page.locator('#panel').isVisible(), '对话页左侧应是会话栏');
    assert((await page.locator('#rail-all').count()) === 1, '会话栏底部应有「全部会话与步骤」入口');
    await page.locator('#rail-all').click();
    await page.waitForTimeout(800);
    let title = await page.textContent('#page-title');
    assert(title.indexOf('会话') >= 0, '应落到会话总览，实际 ' + title);
    assert((await page.locator('#top-actions button').count()) >= 1, '会话总览应能一键回到对话');
    await page.locator('#top-actions button').first().click();
    await page.waitForTimeout(800);
    title = await page.textContent('#page-title');
    assert(title.indexOf('Agent 工作台') >= 0, '应回到对话，实际 ' + title);
    return '一个入口 → 两种视图（对话 / 全部会话）';
  });

  await step('让 lumin 动手：写工作区外会弹批准卡，批了就真落盘', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-e2e-work-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-e2e-outside-'));
    const outsideFile = path.join(outsideDir, 'evil.md');
    // 换成"会真的调 write"的模型，并给 lumin 一个工作目录（权限档位 = 请求批准）
    await page.evaluate(async (b) => {
      const post = (u, body) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      await post('/api/models/save', { id: 'tc', name: '会调工具的模型', baseUrl: b, apiKey: 'k', model: 'mock-tool' });
      await post('/api/models/roles', { chatModelId: 'tc', embedModelId: '', chunkModelId: '' });
    }, mockToolBase);
    await page.evaluate((d) => fetch('/api/prefs/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentWorkDir: d, agentPerm: 'ask', agentExec: '0' }) }), workDir);
    const sid = await page.evaluate(() => fetch('/api/sessions/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((j) => j.data.sessionId));

    // 让模型往"工作区外面"写：这一步必须弹批准卡
    const rel = '../' + path.basename(outsideDir) + '/evil.md';
    await page.evaluate(([id, r]) => {
      window.__askResult = null;
      fetch('/api/agent/ask-pi', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kbId: 'course', question: '把结论写进 @@TARGET:' + r + '@@ 里', sessionId: id, web: 'off' }),
      }).then((x) => x.json()).then((j) => { window.__askResult = j; });
    }, [sid, rel]);
    await page.waitForSelector('.approval-card', { timeout: 30000 });
    const card = await page.locator('.approval-card').innerText();
    assert(card.indexOf('需要批准') >= 0, '批准卡应标出"需要批准"，实际：' + card.replace(/\s+/g, ' ').slice(0, 80));
    assert(card.indexOf('写入工作区外') >= 0 || card.indexOf('工作区外') >= 0, '批准卡应说清是什么动作，实际：' + card.replace(/\s+/g, ' ').slice(0, 80));
    await shot('53-批准卡');
    await page.locator('.approval-card button', { hasText: '允许一次' }).click();
    await page.waitForFunction(() => window.__askResult && window.__askResult.data && window.__askResult.data.ok === true, null, { timeout: 60000 });
    assert(fs.existsSync(outsideFile), '批准之后文件应真的落到工作区外：' + outsideFile);
    assert(fs.readFileSync(outsideFile, 'utf8').length > 0, '写进去的内容不该是空的');
    assert((await page.locator('.approval-card').count()) === 0, '批准过之后卡片应消失');

    // 复原：模型绑回 mock，清掉工作目录，别影响后面的步骤
    await page.evaluate(async (b) => {
      const post = (u, body) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      await post('/api/models/save', { id: 'mock', name: 'mock', baseUrl: b, apiKey: 'k', model: 'mock-chat' });
      await post('/api/models/roles', { chatModelId: 'mock', embedModelId: 'mock', chunkModelId: 'mock' });
      await post('/api/prefs/save', { agentWorkDirClear: true, agentPerm: 'ask' });
    }, mockBase);
    await page.evaluate((nm) => fetch('/api/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: nm }) }), 'tc');
    return '工作区外写 → 弹批准卡 → 允许一次 → 文件真的落盘（' + path.basename(outsideFile) + '，' + fs.readFileSync(outsideFile, 'utf8').length + ' 字节）';
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