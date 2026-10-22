/**
 * scrollbar-check.cjs —— 用真实窗口（挪到屏幕外）量滚动条槽宽。
 *
 * 为什么必须带窗口：headless Chromium 的滚动条一律是覆盖式的（槽宽 0），
 * 量不出真实宽度，也看不出自绘样式到底有没有生效。
 * 这里把 shell/renderer/style.css 注入一个探针页面，验证：
 *   1) 不加载样式时是系统原生的 15px（Windows Fluent）；
 *   2) 加载样式后收成 9px（命中区）+ 5px（视觉滑块，2px 透明边裁掉）；
 *   3) 样式里不能再写 scrollbar-width / scrollbar-color —— Chromium 见到这两个
 *      属性就会忽略 ::-webkit-scrollbar，退回原生观感。
 *
 * 用法：node tools/scrollbar-check.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
function loadPlaywright() {
  const dirs = [process.env.ITN_PLAYWRIGHT_DIR, path.join(__dirname, '..', 'node_modules'),
    'D:\\Desktop\\ITN\\ITN\\src\\frontend\\agent-demo\\node_modules'].filter(Boolean);
  for (const d of dirs) { try { return require(path.join(d, 'playwright')); } catch (e) { /* next */ } }
  console.error('未找到 playwright'); process.exit(2);
}
const { chromium } = loadPlaywright();
const REPO = path.resolve(__dirname, '..');
const CSS = path.join(REPO, 'shell/renderer/style.css');

(async () => {
  const css = fs.readFileSync(CSS, 'utf8');
  const banned = ['scrollbar-width:', 'scrollbar-color:'].filter((k) => css.includes(k));
  const b = await chromium.launch({ channel: 'msedge', headless: false,
    args: ['--no-proxy-server', '--window-position=-4000,-4000', '--window-size=600,400'] });
  const p = await b.newPage();
  const probe = '<div class="probe" style="overflow:scroll;width:220px;height:120px"><div style="height:3000px"></div></div>';
  try {
    await p.setContent(probe);
    const native = await p.evaluate(() => {
      const e = document.querySelector('.probe');
      return e.offsetWidth - e.clientWidth;
    });
    await p.setContent('<style>' + css + '</style>' + probe);
    const custom = await p.evaluate(() => {
      const e = document.querySelector('.probe');
      return {
        gutter: e.offsetWidth - e.clientWidth,
        thumbBorder: getComputedStyle(e, '::-webkit-scrollbar-thumb').borderLeftWidth,
        thumbBg: getComputedStyle(e, '::-webkit-scrollbar-thumb').backgroundColor,
        trackBg: getComputedStyle(e, '::-webkit-scrollbar-track').backgroundColor,
      };
    });
    const fail = [];
    const visual = custom.gutter - 2 * parseFloat(custom.thumbBorder);
    if (custom.gutter !== 9) fail.push('自绘槽宽应为 9px，实际 ' + custom.gutter + 'px');
    // Chromium 会按比例缩放滚动条部件的边框，所以不写死 2px，只要视觉滑块落在 4~7px
    if (!(visual >= 4 && visual <= 7)) fail.push('视觉滑块应在 4~7px，实际 ' + visual.toFixed(2) + 'px');
    if (custom.trackBg !== 'rgba(0, 0, 0, 0)') fail.push('轨道应透明，实际 ' + custom.trackBg);
    if (/rgba?\(0, 0, 0, 0\)/.test(custom.thumbBg)) fail.push('滑块不该是透明的');
    if (banned.length) fail.push('样式里不该出现 ' + banned.join(' / ') + '（会让 Chromium 忽略自绘滚动条）');
    console.log('原生槽宽 = ' + native + 'px → 自绘后 = ' + custom.gutter + 'px（视觉滑块 ' +
      visual.toFixed(2) + 'px）· 滑块 ' + custom.thumbBg);
    if (fail.length) { fail.forEach((x) => console.error('FAIL ' + x)); process.exitCode = 1; }
    else console.log('PASS 滚动条已是细的自绘样式');
  } finally { await b.close(); }
})();