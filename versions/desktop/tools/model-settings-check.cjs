/** Real Edge + real isolated Cangjie core for the simplified model settings flow.
 * Checks the basic three-field path, editing without replacing the key, preset
 * uniqueness, save debouncing, and light/dark/narrow layouts. It never calls a
 * provider, a user database, or Python.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {chromium} = require(require.resolve('playwright', {paths: [
  process.env.ITN_PLAYWRIGHT_DIR,
  path.join(process.env.ITN_PLAYWRIGHT_DIR || '', '..'),
  path.resolve(__dirname, '..'),
  'D:/Desktop/ITN/ITN/src/frontend/agent-demo',
].filter(Boolean)}));

const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, label, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw Error('Timed out: ' + label);
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-model-settings-'));
  const portFile = path.join(dir, 'port');
  const core = spawn(process.env.MODEL_SETTINGS_CORE_EXE || path.join(root, 'dist/core/itn-desktop-core.exe'), [
    '--data-dir=' + dir,
    '--port-file=' + portFile,
    '--ui-dir=' + path.join(root, 'shell/renderer'),
  ], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  let browser;
  let passed = 0;
  const pageErrors = [];
  const coreErrors = [];
  core.stderr.on('data', data => coreErrors.push(data.toString()));
  const check = (name, condition) => {
    assert.ok(condition, name);
    console.log('PASS ' + (++passed) + ' ' + name);
  };

  try {
    await until(() => fs.existsSync(portFile), 'native core port');
    const base = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').trim();
    const settings = async () => {
      const json = await fetch(base + '/api/settings').then(response => response.json());
      assert.equal(json.code, 0, json.message);
      return json.data;
    };

    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 960}});
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => !document.getElementById('boot'));
    await page.evaluate(() => go('settings', 'models'));
    await page.waitForSelector('#model-form');

    check('only the three essential model fields are visible by default',
      await page.locator('#m-base').isVisible() &&
      await page.locator('#m-key').isVisible() &&
      await page.locator('#m-model').isVisible() &&
      await page.locator('#m-id').isHidden() &&
      await page.locator('#m-advanced').evaluate(details => !details.open));
    check('advanced capabilities are available but not crowding the basic form',
      await page.locator('#m-advanced').count() === 1 &&
      await page.locator('#m-reasoning-profile').isHidden() &&
      await page.locator('#m-vision').isHidden() &&
      await page.locator('#m-tts-model').isHidden());

    await page.locator('#m-base').fill('http://127.0.0.1:9/v1');
    await page.locator('#m-key').fill('isolated-key-one');
    await page.locator('#m-model').fill('fresh-model');
    await page.getByRole('button', {name: '保存模型', exact: true}).click();
    await until(async () => (await settings()).models.length === 1, 'first model save');
    await until(async () => !!(await settings()).chatModelId, 'automatic chat role');
    let current = await settings();
    const first = current.models[0];
    check('first saved chat model becomes usable without opening role settings',
      first.model === 'fresh-model' && first.hasApiKey === true && current.chatModelId === first.id);
    check('basic save derives a readable name and a unique internal id',
      first.name === 'fresh-model' && /^model-/.test(first.id));

    await page.locator('.model-item').filter({hasText: 'fresh-model'}).getByRole('button', {name: '编辑', exact: true}).click();
    check('editing keeps the internal id and never exposes the stored key',
      await page.locator('#m-id').inputValue() === first.id &&
      await page.locator('#m-key').inputValue() === '' &&
      (await page.locator('#m-key').getAttribute('placeholder')).includes('留空保留'));
    await page.locator('#m-advanced > summary').click();
    await page.locator('#m-name').fill('研究模型');
    await page.locator('#m-vision').fill('vision-model');
    await page.locator('#m-embed').fill('embed-model');
    await page.locator('#m-reasoning-profile').selectOption('deepseek');
    await page.getByRole('button', {name: '保存模型', exact: true}).click();
    await until(async () => (await settings()).models[0].name === '研究模型', 'edited model save');
    current = await settings();
    check('editing preserves the key and all advanced fields',
      current.models[0].id === first.id &&
      current.models[0].hasApiKey === true &&
      current.models[0].visionModel === 'vision-model' &&
      current.models[0].embeddingModel === 'embed-model' &&
      current.models[0].reasoningProfile === 'deepseek');

    await page.getByRole('button', {name: 'MiMo Flash', exact: true}).click();
    await page.locator('#m-key').fill('isolated-key-two');
    await page.getByRole('button', {name: '保存模型', exact: true}).click();
    await until(async () => (await settings()).models.length === 2, 'first preset save');
    const secondId = (await settings()).models[1].id;
    await page.getByRole('button', {name: 'MiMo Flash', exact: true}).click();
    await page.locator('#m-key').fill('isolated-key-three');
    await page.getByRole('button', {name: '保存模型', exact: true}).click();
    await until(async () => (await settings()).models.length === 3, 'second preset save');
    current = await settings();
    check('using the same preset twice creates new models instead of overwriting the first',
      new Set(current.models.map(model => model.id)).size === 3 &&
      secondId !== current.models[2].id &&
      current.models[0].name === '研究模型');

    let saveCalls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/models/save', async route => {
      saveCalls++;
      if (saveCalls === 1) await gate;
      await route.continue();
    });
    await page.getByRole('button', {name: '自定义', exact: true}).click();
    await page.locator('#m-base').fill('http://127.0.0.1:9/v1');
    await page.locator('#m-key').fill('isolated-key-four');
    await page.locator('#m-model').fill('debounce-model');
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '保存模型');
      button.click();
      button.click();
    });
    await until(() => saveCalls === 1, 'held save request');
    check('double clicking save cannot create duplicate requests',
      saveCalls === 1 &&
      await page.getByRole('button', {name: '正在保存…', exact: true}).isDisabled());
    release();
    await until(async () => (await settings()).models.length === 4, 'debounced save completion');
    await page.waitForSelector('#model-form', {state:'visible'});
    await page.waitForFunction(() => document.getElementById('view')?.getAttribute('aria-busy') === 'false');
    await page.unroute('**/api/models/save');

    const shots = path.join(root, 'tmp', 'model-settings-shots');
    fs.mkdirSync(shots, {recursive: true});
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => applyTheme(value), theme);
      await page.waitForTimeout(600);
      await page.screenshot({path: path.join(shots, theme + '.png'), fullPage: true});
      check(theme + ' model settings keep the basic form readable',
        await page.locator('#m-base').isVisible() && await page.locator('#m-key').isVisible());
    }
    await page.setViewportSize({width: 720, height: 900});
    await page.evaluate(() => applyTheme('light'));
    await page.waitForTimeout(600);
    await page.screenshot({path: path.join(shots, 'narrow.png'), fullPage: true});
    const overflow = await page.evaluate(() => {
      const form = document.getElementById('model-form').getBoundingClientRect();
      return {page: document.documentElement.scrollWidth > window.innerWidth, form: form.right > window.innerWidth + 1};
    });
    check('narrow model settings do not create horizontal overflow', !overflow.page && !overflow.form);
    check('no browser JavaScript errors', pageErrors.length === 0);
    check('no unexpected core errors', coreErrors.filter(line => /exception|error/i.test(line)).length === 0);
    console.log('RESULT=OK ' + passed + ' checks; shots=' + shots + '; data=' + dir);
  } finally {
    if (browser) await browser.close();
    if (!core.killed) core.kill();
  }
})().catch(error => {
  console.error('FAIL', error.stack || error);
  process.exitCode = 1;
});
