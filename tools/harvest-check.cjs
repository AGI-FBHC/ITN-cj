/* R29 and R26 acceptance against the real kernel and renderer, isolated data only.
   --github adds one live public-repository probe; offline checks use a local HTTP page. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.ITN_PLAYWRIGHT_DIR || 'D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const repo = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-harvest-'));
const out = path.join(repo, 'tmp', 'harvest-acceptance');
fs.mkdirSync(out, { recursive: true });
const portFile = path.join(data, 'port');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let kernel, browser, base, version = 1, passes = 0;
const check = (label, condition) => { assert(condition, label); console.log('PASS ' + label); passes++; };
const server = http.createServer((req, res) => {
  if(req.url==='/missing'){res.writeHead(404);res.end('not found');return;}
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<html><title>收集验收资料</title><body><h1>收集验收资料</h1><p>harvest-marker-version-' + version + '</p>' +
    '<p>可靠的来源与明确的用户确认。</p>'.repeat(900) + '<p>tail-marker-full-page</p></body></html>');
});
async function api(route, body = {}) {
  const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok || j.code) throw new Error(j.message || ('HTTP ' + res.status));
  return j.data;
}
async function rejected(label, route, body) {
  let failed = false; try { await api(route, body); } catch { failed = true; }
  check(label, failed);
}
async function startKernel() {
  if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  const log = fs.openSync(path.join(out, 'core.log'), 'a');
  kernel = spawn(path.join(repo, 'core/target/release/bin/main.exe'), [
    '--data-dir=' + data, '--port-file=' + portFile, '--ui-dir=' + path.join(repo, 'shell/renderer'),
    '--skills-dir=' + path.join(repo, 'shell/skills')],
  { cwd: repo, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, cjHeapSize: '2GB' } });
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(portFile)) { base = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').trim(); return; }
    await sleep(200);
  }
  throw new Error('kernel did not start');
}
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/article';
  await startKernel();
  const sourceDir = path.join(data, 'fixture'); fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'original.md'), '# 原有资料\n\n这份资料用于验证暂存资料没有进入知识库。');
  await api('/api/kb/import', { id: 'accept', name: '验收知识库', path: sourceDir, kind: 'folder' });
  await api('/api/kb/build', { id: 'accept' });
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);await page.waitForFunction(() => !document.querySelector('#boot'));
  await page.evaluate(() => {state.resTab='network';return go('notes');});await page.waitForSelector('#harvest-url');
  await page.getByRole('button',{name:'抓取到暂存区',exact:true}).click();
  check('empty source gives an inline message instead of starting a request',(await page.locator('.harvest-panel').innerText()).includes('先填写链接或仓库'));
  await page.fill('#harvest-url',url.replace('/article','/missing'));await page.getByRole('button',{name:'抓取到暂存区',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.harvest-panel')?.innerText.includes('抓取失败'));
  check('failed HTTP source has actionable feedback and allows retry',await page.getByRole('button',{name:'抓取到暂存区',exact:true}).isEnabled());
  await page.fill('#harvest-url',url);await page.getByRole('button',{name:'抓取到暂存区',exact:true}).click();
  await page.waitForSelector('.harvest-source');
  const staged = (await api('/api/kb/sources')).sources.find(s=>s.url===url&&s.status==='staged');
  check('staged source returns real file list and provenance', staged.status === 'staged' && staged.files.length === 1 && staged.url === url && staged.fetchedAt);
  const stagedPath = path.join(data, 'staging', staged.id, 'page.md');
  check('full page survives beyond 6000-byte prompt excerpt', fs.readFileSync(stagedPath, 'utf8').includes('tail-marker-full-page'));
  check('staging does not touch the source directory', !fs.existsSync(path.join(sourceDir, 'sources')));
  const searchBefore = await api('/api/kb/search', { id: 'accept', query: 'harvest-marker-version', topK: 3 });
  check('staging not searchable', searchBefore.hits.length === 0);
  await rejected('ingest without user confirmation rejected', '/api/kb/ingest', { id: staged.id, kbId: 'accept' });
  await rejected('source id escape rejected', '/api/kb/source/preview', { id: '../fixture', path: 'original.md' });
  await rejected('preview path escape rejected', '/api/kb/source/preview', { id: staged.id, path: '../../fixture/original.md' });

  // 0.8.4 起首页不再有旧星云卡片；等应用壳就绪后直接按路由进入知识库页
  await page.waitForFunction(() => !document.querySelector('#boot'));
  await page.waitForSelector('.rail .nav-item');
  await page.evaluate(() => go('kb'));
  await page.waitForSelector('.harvest-entry');
  await page.waitForFunction(() => !document.querySelector('#view .spinner'));
  await page.locator('.harvest-entry summary').first().click();
  const source = page.locator('.harvest-source', { hasText: '收集验收资料' }).first();
  await source.waitFor();
  check('real navigation reaches source and confirmation starts disabled', await source.getByRole('button', { name: '确认并入并建索引' }).isDisabled());
  await source.locator('summary').click();
  await source.getByRole('button', { name: /^page.md/ }).click();
  await page.waitForFunction(() => document.querySelector('.harvest-preview')?.textContent.includes('harvest-marker-version-1'));
  await source.screenshot({ path: path.join(out, '01-staging-review.png') });
  await source.getByRole('checkbox', { name: '我已检查清单与来源' }).check();
  // Reproduce a real follow-up failure: copying succeeds but index construction fails.
  await page.route('**/api/kb/build',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:500,message:'验收：索引服务暂不可用'})}));
  await source.getByRole('button', { name: '确认并入并建索引' }).click();
  await page.waitForFunction(()=>document.querySelector('#view')?.innerText.includes('准备资料失败'));
  await page.waitForTimeout(200);
  check('index failure remains visible next to the ingested source',(await source.innerText()).includes('索引未完成'));
  await page.unroute('**/api/kb/build');
  await source.getByRole('button',{name:'重建此库索引',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#view')?.innerText.includes('资料准备完成'));
  // 完成信号以服务端状态为准（旧文案“索引完成”已下线，现在是“已并入 + 重建索引”）
  const ingestDeadline = Date.now() + 60000; let ingested = false;
  while (Date.now() < ingestDeadline) {
    const sources = (await api('/api/kb/sources')).sources || [];
    if (sources.some((x) => x.id === staged.id && x.status === 'ingested')) { ingested = true; break; }
    await sleep(500);
  }
  check('UI confirmation promotes the source to ingested', ingested);
  const searchAfter = await api('/api/kb/search', { id: 'accept', query: 'harvest-marker-version', topK: 3 });
  check('UI confirmation promotes source and search finds it', searchAfter.hits.length > 0);
  await rejected('duplicate ingest does not overwrite', '/api/kb/ingest', { id: staged.id, kbId: 'accept', confirmed: true });
  version = 2;
  const fresh = await api('/api/kb/source/refetch', { id: staged.id });
  const both = await api('/api/kb/sources');
  check('source list returns every sibling snapshot', both.sources.length === 2);
  check('refetch creates a separate unconfirmed snapshot', fresh.id !== staged.id && fresh.status === 'staged' &&
    fs.readFileSync(path.join(sourceDir, 'sources', staged.id, 'page.md'), 'utf8').includes('version-1'));
  await api('/api/kb/source/discard', { id: fresh.id });
  await rejected('discarded source cannot be ingested', '/api/kb/ingest', { id: fresh.id, kbId: 'accept', confirmed: true });
  await rejected('ingested source cannot be discarded', '/api/kb/source/discard', { id: staged.id });
  // 网络资料现在在“我的资源”页的标签里：直接把标签状态切到 network 再进入
  await page.evaluate(() => { state.resTab = 'network'; return go('notes'); });
  await page.waitForTimeout(900);   // 网络资料在“我的资源”页里直接渲染，标签栏已挪到顶栏工作区标签
  await page.locator('.harvest-source').waitFor().catch(async (e) => {
    console.log('NETWORK FAILURE ' + JSON.stringify(await page.evaluate(() => ({ tab: state.resTab, text: document.querySelector('#view').innerText, errors: [] }))));
    await page.screenshot({ path: path.join(out, 'network-failure.png') }); throw e;
  });
  check('network resources has persisted ingested source', (await page.locator('.harvest-source').innerText()).includes('已并入'));
  await page.screenshot({ path: path.join(out, '02-network-resources.png') });
  await page.setViewportSize({ width: 800, height: 900 });
  check('desktop narrow window has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1000 });

  for (let i = 1; i < 10; i++) {
    const dir = path.join(data, 'kb-' + i); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'chapter.md'), '# 第' + i + '章\n\n这是独立知识库里的有效正文，足够长以形成一个真实的章节节点。');
    await api('/api/kb/import', { id: 'kb-' + i, name: '知识库 ' + i, path: dir, kind: 'folder' });
    await api('/api/kb/build', { id: 'kb-' + i });
  }
  // 旧首页的星云折叠视图已随 0.8.4 下线；后端折叠计算仍在，用接口断言守住它（将来若要复用视图可直接接回）
  const nebula = await api('/api/nebula');
  check('10 real indexed libraries fold to 8 in the backend fold calculation', nebula.foldedClusters === 2);
  // 星云渲染器本身已随旧首页下线（NEBULA/nebulaPaint 不再存在），对应的帧率断言一并退场。
  if (process.argv.includes('--github')) {
    const gh = await api('/api/kb/stage', { kind: 'repo', url: 'https://github.com/octocat/Spoon-Knife/' });
    check('live GitHub source is pinned to full commit and has real files', gh.commit.length === 40 && gh.files.length > 0 && gh.status === 'staged');
    console.log('GITHUB ' + gh.url + ' @ ' + gh.commit + ' files=' + gh.files.length);
    const web=await api('/api/kb/stage',{kind:'url',url:'https://example.com'});
    check('live HTTPS article contains the actual page text',(await api('/api/kb/source/preview',{id:web.id,path:'page.md'})).text.includes('Example Domain'));
    for(const source of [gh,web]){
      await page.evaluate(()=>{state.resTab='network';return go('notes');});
      const row=page.locator('.harvest-source[data-source-id="'+source.id+'"]');await row.waitFor();
      await row.getByLabel('并入目标知识库').selectOption('accept');
      await row.getByRole('checkbox',{name:'我已检查清单与来源'}).check();
      await row.getByRole('button',{name:'确认并入并建索引',exact:true}).click();
      await page.waitForFunction(id=>document.querySelector('.harvest-source[data-source-id="'+id+'"]')?.innerText.includes('已并入'),source.id);
      const query=source===gh?'Spoon-Knife':'Example Domain';
      let hits=[];for(let i=0;i<30;i++){hits=(await api('/api/kb/search',{id:'accept',query,topK:5})).hits;if(hits.length)break;await sleep(200);}
      check('live '+(source===gh?'repository':'web page')+' reaches user-confirmed indexed search',hits.length>0);
    }
  }
  check('browser has no console or page errors', errors.length === 0);
  await browser.close(); browser = null;
  kernel.kill(); await new Promise((r) => kernel.once('exit', r));
  await startKernel();
  const persisted = await api('/api/kb/sources');
  check('sources persist across a real kernel restart', persisted.sources.some((s) => s.id === staged.id && s.status === 'ingested' && s.kbId === 'accept'));
  console.log('RESULT ' + passes + ' passed; isolated data=' + data);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); if (kernel) kernel.kill(); server.close();
});
