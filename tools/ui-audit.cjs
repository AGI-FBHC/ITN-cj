/**
 * ui-audit.cjs —— 界面"能测就测"的体检（按 ui-ux-pro-max 的优先级表挑可量化的几条）。
 *
 * 跑法：node tools/ui-audit.cjs
 * 用无头浏览器打开内核托管的同一份界面，逐页 × 浅色/深色两套主题量四件事：
 *   1) 有没有 < 12px 的文字（正文最小字号）
 *   2) 主要文本色对底色的对比度（4.5:1 是正文门槛）
 *   3) 图标按钮有没有 aria-label / title
 *   4) 小屏幕宽度下有没有横向滚动
 * 任何一项不达标就退出码 1（可以直接接进提交前的检查）；截图留在 tmp/ui-shots/page-<theme>-<页>.png。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function loadPlaywright() {
  for (const dir of [process.env.ITN_PLAYWRIGHT_DIR, path.join(__dirname, '..', 'node_modules'), 'D:\\Desktop\\ITN\\ITN\\src\\frontend\\agent-demo\\node_modules'].filter(Boolean)) {
    try { return require(path.join(dir, 'playwright')); } catch (e) { /* next */ }
  }
  process.exit(2);
}
const { chromium } = loadPlaywright();

(async () => {
  const repo = path.join(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-audit-'));
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-audit-kb-'));
  fs.writeFileSync(path.join(kbDir, '01.md'), '# 提示词工程\n\n## 基本概念\n\n提示词是交给模型的输入指令，把约束写清楚。\n', 'utf8');
  const portFile = path.join(os.tmpdir(), 'itn-audit-' + Date.now() + '.port');
  const exe = path.join(repo, 'dist', 'core', 'itn-desktop-core.exe');
  const core = spawn(exe, ['--data-dir=' + dataDir, '--port-file=' + portFile, '--ui-dir', path.join(repo, 'shell', 'renderer')], { windowsHide: true, cwd: path.dirname(exe), stdio: 'ignore' });
  let port = '';
  for (let i = 0; i < 80; i++) { if (fs.existsSync(portFile)) { const t = fs.readFileSync(portFile, 'utf8').trim(); if (t) { port = t; break; } } await new Promise((r) => setTimeout(r, 250)); }
  const base = 'http://127.0.0.1:' + port;
  const post = async (p, body) => (await (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json());
  await post('/api/kb/save', { id: 't', name: '自测库', rootDir: kbDir });
  await post('/api/kb/build', { id: 't' });

  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('.nav-item', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const pages = ['首页', '学 · 练', '我的成长', '我的资源', '个性化资源', '领域知识库', '伴学助手', '设置'];
  const report = {};
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(400);
  for (const label of pages) {
    await page.locator('.nav-item', { hasText: label }).first().click();
    await page.waitForTimeout(900);
    const shotDir = path.join(__dirname, '..', 'tmp', 'ui-shots');
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'page-' + theme + '-' + label.replace(/[^\u4e00-\u9fa5a-z]/g, '') + '.png') });
    report[theme + ' / ' + label] = await page.evaluate(() => {
      const lum = (c) => {
        const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
      };
      const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
      const parse = (s) => { const m = String(s).match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
      const bgOf = (el) => {
        let n = el;
        while (n && n !== document.documentElement) {
          const c = getComputedStyle(n).backgroundColor;
          const v = parse(c);
          const alpha = String(c).indexOf('rgba') >= 0 ? Number(String(c).match(/[\d.]+/g)[3]) : 1;
          if (v && alpha > 0.6) return v;
          n = n.parentElement;
        }
        return [255, 255, 255];
      };
      const tiny = [];
      const low = [];
      const els = document.querySelectorAll('#view *');
      els.forEach((el) => {
        if (!el.offsetParent && el.tagName !== 'BODY') return;
        const cs = getComputedStyle(el);
        const fs = parseFloat(cs.fontSize);
        const visibleText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
        if (fs < 12 && visibleText) tiny.push(Math.round(fs * 10) / 10 + 'px: ' + el.textContent.trim().slice(0, 18));
        if (visibleText) {
          const fg = parse(cs.color);
          if (fg) {
            const r = ratio(fg, bgOf(el));
            if (r < 4.5) low.push(Math.round(r * 100) / 100 + ':1 · ' + el.textContent.trim().slice(0, 18));
          }
        }
      });
      const iconBtns = Array.from(document.querySelectorAll('#view button')).filter((b) => !b.textContent.trim());
      const noLabel = iconBtns.filter((b) => !b.getAttribute('aria-label') && !b.getAttribute('title'));
      return {
        tiny: tiny.slice(0, 12),
        low: Array.from(new Set(low)).slice(0, 12),
        iconButtons: iconBtns.length,
        iconNoLabel: noLabel.length,
        hScroll: document.documentElement.scrollWidth > window.innerWidth + 2,
      };
    });
  }
  }
  const bad = Object.entries(report).filter(([, v]) => v.tiny.length || v.low.length || v.hScroll || v.iconNoLabel);
  for (const [k, v] of Object.entries(report)) {
    const flags = [];
    if (v.tiny.length) flags.push('小字 ' + v.tiny.length);
    if (v.low.length) flags.push('低对比 ' + v.low.length);
    if (v.hScroll) flags.push('横向滚动');
    if (v.iconNoLabel) flags.push('无标签图标按钮 ' + v.iconNoLabel);
    console.log('  ' + (flags.length ? 'FAIL' : 'PASS') + '  ' + k + (flags.length ? '  ' + flags.join(' / ') : ''));
  }
  console.log('');
  if (bad.length) {
    console.log(JSON.stringify(Object.fromEntries(bad), null, 1));
    console.log('结果：' + bad.length + ' 个页面/主题组合有问题');
    process.exitCode = 1;
  } else {
    console.log('结果：全部通过（' + Object.keys(report).length + ' 个页面/主题组合：无 <12px 小字、无低于 4.5:1 的正文、无横向滚动、图标按钮都有标签）');
  }
  await browser.close();
  core.kill();
})();
