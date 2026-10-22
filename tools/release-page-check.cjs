/** Real-browser acceptance checks for the public Lumin release page. */
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(require.resolve('playwright', {paths: [
  process.env.ITN_PLAYWRIGHT_DIR && path.dirname(process.env.ITN_PLAYWRIGHT_DIR),
  path.resolve(__dirname, '..'),
  'D:/Desktop/ITN/ITN/src/frontend/agent-demo',
].filter(Boolean)}));
const version = require('../shell/package.json').version;

const url = process.env.RELEASE_PAGE_URL || 'http://127.0.0.1:6026/';
const outputDir = path.join(__dirname, '..', 'tmp', 'release-page-check');
fs.mkdirSync(outputDir, {recursive: true});

let assertions = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log('PASS  ' + message);
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--no-proxy-server'],
  });
  const pageErrors = [];
  const consoleErrors = [];
  let browserPage;

  try {
    browserPage = await browser.newPage({viewport: {width: 1440, height: 1000}});
    browserPage.on('pageerror', error => pageErrors.push(error.message));
    browserPage.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await browserPage.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000});
    await browserPage.waitForLoadState('load', {timeout: 60000});
    const revealPage = () => browserPage.evaluate(async () => {
      document.documentElement.style.scrollBehavior = 'auto';
      const step = Math.max(500, Math.floor(window.innerHeight * .8));
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo({top: y, behavior: 'instant'});
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      window.scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'});
      await new Promise(resolve => setTimeout(resolve, 260));
      window.scrollTo({top: 0, behavior: 'instant'});
      await new Promise(resolve => setTimeout(resolve, 220));
    });
    await revealPage();
    await browserPage.waitForFunction(
      () => Array.from(document.images).every(image => image.naturalWidth > 0),
      null,
      {timeout: 15000}
    );

    assert(await browserPage.title() === 'Lumin 桌面版下载', '页面标题正确');
    assert((await browserPage.locator('body').innerText()).includes('Lumin ' + version), '页面显示当前版本');
    assert(await browserPage.getByText('Powered by Cangjie', {exact:true}).count() === 2, '页面突出展示仓颉技术支持');

    const imageState = await browserPage.locator('img').evaluateAll(images =>
      images.map(image => ({src: image.getAttribute('src'), complete: image.complete, width: image.naturalWidth}))
    );
    assert(imageState.length >= 9, '界面与 logo 图片已加载');
    assert(imageState.every(image => image.width > 0), '所有图片资源加载成功');

    const downloadState = await browserPage.locator('a[download]').evaluateAll(links =>
      links.map(link => ({href: link.href, download: link.hasAttribute('download')}))
    );
    assert(downloadState.length >= 4, '所有下载入口均存在');
    assert(downloadState.filter(link => link.href.endsWith('/Lumin-Setup-' + version + '.exe')).length >= 4, '主要下载入口均指向当前 EXE 安装包');
    assert(downloadState.filter(link => link.href.endsWith('/Lumin-' + version + '.zip')).length === 2, '两个便携版入口仍指向当前 ZIP');
    assert((await browserPage.locator('.file-details').innerText()).includes('EXE 安装程序'), '文件信息显示安装包格式');
    const installerHead = await browserPage.request.head(new URL('/Lumin-Setup-' + version + '.exe', url).href);
    assert(installerHead.ok() && Number(installerHead.headers()['content-length']) > 100000000, '页面安装包真实可下载且大小合理');

    await browserPage.locator('#tab-network').click();
    assert(await browserPage.locator('#view-network').isVisible(), '点击“知识网络”可切换预览');
    assert(await browserPage.locator('#view-guided').isHidden(), '切换后旧预览被隐藏');
    await browserPage.locator('#tab-network').press('ArrowRight');
    assert(await browserPage.locator('#tab-study').getAttribute('aria-selected') === 'true', '方向键可切换预览标签');

    await browserPage.locator('.faq-item summary').first().click();
    assert(await browserPage.locator('.faq-item').first().getAttribute('open') !== null, '安装说明可展开');

    for (const viewport of [
      {name: 'desktop', width: 1440, height: 1000},
      {name: 'tablet', width: 768, height: 900},
      {name: 'mobile', width: 390, height: 844},
    ]) {
      await browserPage.setViewportSize({width: viewport.width, height: viewport.height});
      await browserPage.reload({waitUntil: 'load', timeout: 60000});
      await revealPage();
      await browserPage.waitForFunction(
        () => document.querySelectorAll('.reveal:not(.is-visible)').length === 0,
        null,
        {timeout: 8000}
      );
      const overflow = await browserPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 2, viewport.name + ' 宽度无横向溢出');
      const unrevealed = await browserPage.locator('.reveal:not(.is-visible)').count();
      assert(unrevealed === 0, viewport.name + ' 内容滚动后全部显示');
      await browserPage.screenshot({
        path: path.join(outputDir, viewport.name + '.png'),
        fullPage: true,
      });
      await browserPage.screenshot({path: path.join(outputDir, viewport.name + '-fold.png')});
    }

    assert(pageErrors.length === 0, '页面无 JavaScript 异常');
    assert(consoleErrors.length === 0, '浏览器控制台无资源错误');
    console.log('RESULT  ' + assertions + '/' + assertions + ' PASS');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('FAIL  ' + error.message);
  process.exit(1);
});
