/** Real Cangjie/SQLite/Edge. Only native file-picker selection and connection failure are simulated. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-clarity-')),pf=path.join(dir,'port');
 const exe=process.env.CLARITY_CORE||path.join(root,'core/target/release/bin/main.exe');
 let core,browser,base,passed=0;const errors=[];
 const check=(label,ok)=>{if(!ok)throw Error(label);passed++;console.log('PASS '+label);};
 const until=async(fn,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error('condition timed out');};
 const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
 const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
 try{
  core=spawn(exe,['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),'--seed-course-fixture=1'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  core.stderr.on('data',s=>{if(String(s).includes('[api]'))errors.push(String(s));});
  await until(()=>fs.existsSync(pf));base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'));
  check('task icon stays in the window titlebar immediately',await page.locator('#titlebar-tasks .task-btn').count()===1);
  check('task button has no text label',await page.locator('.task-label').count()===0);
  check('connected indicator is visible and green',await page.locator('#status').evaluate(e=>e.dataset.connection==='online'&&getComputedStyle(e,'::before').backgroundColor===getComputedStyle(document.documentElement).getPropertyValue('--ok').trim().replace(/^#([0-9a-f]{6})$/i,(_,h)=>'rgb('+[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)).join(', ')+')')));
  check('connection status text is tooltip only',(await page.locator('#status').textContent())===''&&(await page.locator('#status').getAttribute('title'))==='内核已连接');
  await page.route('**/health',route=>route.abort());
  await page.waitForFunction(()=>document.getElementById('status').dataset.connection==='offline',null,{timeout:10000});
  check('health monitor detects a lost connection automatically',await page.locator('#status').getAttribute('title')==='内核未连接');
  await page.unroute('**/health');
  await page.waitForFunction(()=>document.getElementById('status').dataset.connection==='online',null,{timeout:10000});
  check('health monitor recovers without reloading the page',true);
  await page.locator('.task-btn').click();check('task popup is clickable above the app content',await page.locator('.task-pop').isVisible());await page.keyboard.press('Escape');

  await page.evaluate(()=>go('settings','kb'));await page.waitForSelector('#kb-import-path');
  check('there is one add form and no manual id form',await page.locator('#kb-import-path').count()===1&&await page.locator('#kb-id,#kb-dir').count()===0);
  check('main actions use short clear labels',await page.getByRole('button',{name:'添加并索引',exact:true}).count()===1&&await page.getByRole('button',{name:'仅添加',exact:true}).count()===1);
  const source=path.join(dir,'materials');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'lesson.md'),'# 工具调用\n\n## 原理\n\n工具调用的结果回填给模型。\n','utf8');
  await post('kb/save',{id:'legacy-manual',name:'原手动课程',rootDir:source});
  await page.evaluate(src=>{window.itnWindow={...window.itnWindow,pickDirectory:async()=>src};},source);
  await page.getByRole('button',{name:'选择文件夹',exact:true}).first().click();
  check('folder choice clearly shows how files are used',await page.locator('#kb-source-mode').innerText()==='文件夹 · 原地使用');
  await page.fill('#kb-import-name','工具课程');await page.getByRole('button',{name:'添加并索引',exact:true}).click();
  await until(async()=>{const s=(await (await fetch(base+'/api/settings')).json()).data;return s.knowledgeBases.some(k=>k.id==='legacy-manual'&&k.chunkCount>0);});
  const before=(await (await fetch(base+'/api/settings')).json()).data.knowledgeBases;
  const kb=before.find(k=>k.id==='legacy-manual');
  check('import reuses a legacy manually registered directory',before.filter(k=>k.rootDir===source).length===1&&kb.name==='工具课程');
  check('add-and-index actually creates searchable chunks',(await post('kb/search',{id:kb.id,query:'工具调用',topK:3})).hits.length>0);
  await page.evaluate(()=>go('settings','kb'));await page.waitForSelector('#kb-import-path');
  const row=page.locator('.item').filter({hasText:'工具课程'});
  await row.getByRole('button',{name:'重命名',exact:true}).click();await page.fill('#kb-rename-name','  ');
  await page.getByRole('dialog',{name:'重命名知识库'}).getByRole('button',{name:'保存',exact:true}).click();
  check('blank rename has a visible inline error',await page.locator('.kb-form-error').innerText()==='请输入名称');
  await page.fill('#kb-rename-name','Agent 入门');await page.keyboard.press('Enter');
  await until(async()=>(await (await fetch(base+'/api/settings')).json()).data.knowledgeBases.some(k=>k.id===kb.id&&k.name==='Agent 入门'));
  const after=(await (await fetch(base+'/api/settings')).json()).data.knowledgeBases.find(k=>k.id===kb.id);
  check('rename preserves id, source, counts and index timestamp',after.rootDir===kb.rootDir&&after.sourcePath===kb.sourcePath&&after.chunkCount===kb.chunkCount&&after.builtAt===kb.builtAt);
  check('renamed library remains searchable',(await post('kb/search',{id:kb.id,query:'工具调用',topK:3})).hits.length>0);
  check('unknown rename is rejected',(await raw('kb/rename',{id:'missing',name:'bad'})).code!==0);

  const file=path.join(dir,'extra.md');fs.writeFileSync(file,'# 额外资料\n\n单文件导入。\n');
  await page.evaluate(src=>{window.itnWindow={...window.itnWindow,pickFile:async()=>src};},file);
  await page.getByRole('button',{name:'选择文件',exact:true}).click();
  check('file choice clearly shows copying behavior',await page.locator('#kb-source-mode').innerText()==='文件 · 保存副本');
  await page.getByRole('button',{name:'仅添加',exact:true}).click();
  await until(async()=>(await (await fetch(base+'/api/settings')).json()).data.knowledgeBases.some(k=>k.sourcePath===file));
  const fileKb=(await (await fetch(base+'/api/settings')).json()).data.knowledgeBases.find(k=>k.sourcePath===file);
  check('add-only copies source and leaves indexing for later',fileKb.chunkCount===0&&fs.existsSync(path.join(fileKb.rootDir,'extra.md'))&&fs.existsSync(file));

  const full='这是一个超过八个字的会话全称';const sid=(await post('sessions/new',{})).sessionId;
  const turn=await post('agent/ask-pi',{sessionId:sid,question:'请确认一次会话标题测试。',web:'off'});check('title test uses a persisted successful conversation',turn.ok===true);
  await post('sessions/rename',{sessionId:sid,title:full});
  await page.evaluate(async id=>{await loadSessions(true);await openChatSession(id);},sid);await page.waitForSelector('.wb-crumb-title');
  check('conversation header has eight characters plus ellipsis',await page.locator('.wb-crumb-title').innerText()===Array.from(full).slice(0,8).join('')+'…');
  check('hover tooltip and accessible name retain the full title',await page.locator('.wb-crumb-title').getAttribute('title')===full&&await page.locator('.wb-crumb-title').getAttribute('aria-label')===full);
  check('task button remains fixed on conversation pages',await page.locator('#titlebar-tasks .task-btn').count()===1&&await page.locator('.wb-toolbar .task-btn').count()===0);
  for(const theme of ['light','dark']){
   await page.evaluate(t=>savePrefs({theme:t}),theme);await page.setViewportSize({width:850,height:800});
   check(theme+' titlebar keeps light and task icon visible at narrow width',await page.locator('#status').isVisible()&&await page.locator('.task-btn').isVisible());
   await page.locator('.task-btn').click();check(theme+' tasks popup stays within window',await page.locator('.task-pop').evaluate(e=>{const b=e.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0;}));await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width:1440,height:960});await page.evaluate(()=>go('settings','kb'));await page.waitForSelector('#kb-import-path');
  fs.mkdirSync(path.join(root,'tmp/clarity-shots'),{recursive:true});await page.screenshot({path:path.join(root,'tmp/clarity-shots/knowledge-settings.png')});
  check('no browser or Cangjie API exceptions',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; data='+dir);
 }catch(e){console.error('FAIL',e.stack);if(errors.length)console.error(errors);process.exitCode=1;}
 finally{if(browser)await browser.close();if(core&&!core.killed)core.kill();}
})();
