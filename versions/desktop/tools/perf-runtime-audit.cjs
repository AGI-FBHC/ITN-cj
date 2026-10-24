/** Diagnostic only: run the shipped Electron + Cangjie in an isolated data home.
 * Never patches application files. Snapshot mode copies the user's DB, removes
 * remote models via native APIs, and measures read-only UI plus new test chats.
 * Controlled SSE separates renderer/kernel latency from remote model waiting.
 */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const {_electron}=require(require.resolve('playwright',{paths:['D:/Desktop/ITN/ITN/src/frontend/agent-demo',path.resolve(__dirname,'..')]}));
const root=path.resolve(__dirname,'..');
const packOption=process.argv.find(a=>a.startsWith('--pack='))?.slice(7)||process.env.LUMIN_PERF_PACK;
const pack=packOption?path.resolve(packOption):path.join(root,'dist','Lumin-'+JSON.parse(fs.readFileSync(path.join(root,'shell/package.json'),'utf8')).version);
const dataset=(process.argv.find(a=>a.startsWith('--dataset='))||'--dataset=snapshot').split('=')[1];
const cycles=Number((process.argv.find(a=>a.startsWith('--cycles='))||'--cycles=8').split('=')[1]);
const phase=(process.argv.find(a=>a.startsWith('--phase='))||'--phase=full').split('=')[1];
const runDir=path.join(root,'tmp','perf-runtime-'+dataset+'-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(runDir,{recursive:true});
const home=path.join(runDir,'home'),data=path.join(home,'Lumin');fs.mkdirSync(data,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const releaseInfo=JSON.parse(fs.readFileSync(path.join(pack,'release.json'),'utf8'));
const report={dataset,pack,version:releaseInfo.version,sourceCommit:releaseInfo.sourceCommit,started:new Date().toISOString(),scope:'shipped Electron and Cangjie; isolated DB; controlled local SSE; no product fixes',stages:[],errors:[],network:[],modelRequests:[]};
const flush=()=>fs.writeFileSync(path.join(runDir,'result.json'),JSON.stringify(report,null,2));
const source=path.join(process.env.LOCALAPPDATA,'Lumin','itn.db');
let setupCore,app,page,cdp,mock;
async function post(base,route,body={}){
  const t=performance.now();
  const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const j=await r.json();if(j.code!==0)throw Error(route+': '+String(j.message).slice(0,160));
  return {data:j.data,ms:Math.round(performance.now()-t)};
}
async function prepare(){
  if(dataset==='snapshot'){
    for(const suffix of ['', '-wal'])if(fs.existsSync(source+suffix))fs.copyFileSync(source+suffix,path.join(data,'itn.db')+suffix);
    const db=new DatabaseSync(path.join(data,'itn.db'),{readOnly:true});report.counts={};
    for(const table of ['sessions','session_events','knowledge_nodes','knowledge_links','notes','quiz_records','learning_events','learning_resources','personal_resources','knowledge_bases','kb_chunks']){
      try{report.counts[table]=db.prepare('SELECT COUNT(*) n FROM '+table).get().n;}catch{}
    }
    report.sessionScale=db.prepare('SELECT session_id,COUNT(*) n FROM session_events GROUP BY session_id ORDER BY n DESC LIMIT 5').all().map((s,i)=>({id:s.session_id,alias:'history-'+i,events:s.n}));db.close();
    report.sourceStamp={bytes:fs.statSync(source).size,mtimeMs:fs.statSync(source).mtimeMs};
  }
  mock=http.createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'perf-local'}]}));return;}
    const buffers=[];for await(const chunk of req)buffers.push(chunk);
    let body={};try{body=JSON.parse(Buffer.concat(buffers).toString());}catch{}
    const latest=(body.messages||[]).filter(m=>m.role==='user').at(-1)?.content||'';
    const system=(body.messages||[]).filter(m=>m.role==='system').map(m=>m.content||'').join(' ');
    const long=typeof latest==='string'&&latest.includes('PERF_STREAM_LONG')&&!system.includes('起名')&&!system.includes('命名')&&!system.includes('名字');
    const request={started:Date.now(),long,chunks:0,closed:false};report.modelRequests.push(request);
    res.on('close',()=>{request.closed=true;request.ended=Date.now();});
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const text=long?Array.from({length:130},(_,i)=>'### 学习片段 '+(i+1)+'\n\n'+('这里是用于测量连续输出与滚动响应的内容。').repeat(8)+'\n\n| 项目 | 说明 |\n| --- | --- |\n| 输入 | 检查边界 |\n| 输出 | 记录结果 |\n\n```js\nconst value = '+i+';\nconsole.log(value);\n```\n\n').join(''):'性能测试回复完成。';
    for(let i=0;i<text.length&&!res.destroyed;i+=90){res.write('data: '+JSON.stringify({choices:[{delta:{content:text.slice(i,i+90)},finish_reason:null}]})+'\n\n');request.chunks++;await pause(long?24:8);}
    if(!res.destroyed){res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:Math.ceil(text.length/2)}})+'\n\ndata: [DONE]\n\n');res.end();}
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const pf=path.join(runDir,'setup.port');
  const setupData=phase==='features'?path.join(runDir,'native-fixture'):data;
  const args=['--data-dir='+setupData,'--port-file='+pf,'--ui-dir='+path.join(pack,'resources/app/renderer')];
  if(dataset==='seed'&&phase==='features')args.push('--seed-guided-fixture=1');
  else if(dataset==='seed')args.push('--seed-fixture=15000','--seed-guided-fixture=1','--seed-growth-activity=1');
  setupCore=spawn(path.join(pack,'resources/kernel/lumin-core.exe'),args,{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
  for(let i=0;i<900&&!fs.existsSync(pf);i++)await pause(100);
  if(!fs.existsSync(pf))throw Error('setup kernel not ready');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  if(phase==='features'){
    // Keep the native fixture's model server alive, with the app using a separate DB copy.
    for(const suffix of ['', '-wal'])if(fs.existsSync(path.join(setupData,'itn.db')+suffix))fs.copyFileSync(path.join(setupData,'itn.db')+suffix,path.join(data,'itn.db')+suffix);
    return;
  }
  const cfg=await(await fetch(base+'/api/settings')).json();
  for(const m of cfg.data.models||[])await post(base,'models/delete',{id:m.id});
  await post(base,'models/save',{id:'perf-local',name:'隔离性能测试',baseUrl:'http://127.0.0.1:'+mock.address().port+'/v1',apiKey:'local-fixture',model:'perf-local',reasoningProfile:'none'});
  await post(base,'models/roles',{chatModelId:'perf-local'});
  setupCore.kill();await new Promise(r=>setupCore.once('exit',r));setupCore=null;
}
function installProbe(){
  if(window.__runtimePerf)return;
  const probe=window.__runtimePerf={tasks:[],frames:[],requests:[],intervals:new Map(),stage:'startup'};
  try{new PerformanceObserver(list=>{for(const e of list.getEntries())probe.tasks.push({at:e.startTime,ms:e.duration,stage:probe.stage});}).observe({entryTypes:['longtask']});}catch{}
  const originalFetch=window.fetch;
  window.fetch=async function(input,...args){const url=String(typeof input==='string'?input:input.url),at=performance.now(),stage=probe.stage;try{const r=await originalFetch.call(this,input,...args);probe.requests.push({url:new URL(url,location.href).pathname,at,ms:performance.now()-at,status:r.status,stage});return r;}catch(e){probe.requests.push({url:new URL(url,location.href).pathname,at,ms:performance.now()-at,error:e.name,stage});throw e;}};
  const originalInterval=window.setInterval,originalClear=window.clearInterval;
  window.setInterval=function(fn,ms,...args){const id=originalInterval.call(this,fn,ms,...args);probe.intervals.set(id,{ms,stack:new Error().stack.split('\n').slice(2,4).join('\n')});return id;};
  window.clearInterval=function(id){probe.intervals.delete(id);return originalClear.call(this,id);};
  let last=0;const tick=t=>{if(last&&document.visibilityState==='visible'&&t-last>40)probe.frames.push({at:t,ms:t-last,stage:probe.stage});last=t;requestAnimationFrame(tick);};requestAnimationFrame(tick);
}
async function metrics(){
  const [heap,dom,perf]=await Promise.all([cdp.send('Runtime.getHeapUsage'),cdp.send('Memory.getDOMCounters'),cdp.send('Performance.getMetrics')]);
  const m=Object.fromEntries(perf.metrics.map(x=>[x.name,x.value]));
  return {heapMB:Math.round(heap.usedSize/1048576*10)/10,nodes:dom.nodes,listeners:dom.jsEventListeners,documents:dom.documents,taskMs:Math.round(m.TaskDuration*1000),scriptMs:Math.round(m.ScriptDuration*1000),layoutMs:Math.round(m.LayoutDuration*1000),layoutCount:m.LayoutCount};
}
async function stage(name,action,settle=400){
  await page.evaluate(name=>{window.__runtimePerf.stage=name;},name);
  const before=await metrics(),started=performance.now();let error;
  try{await action();}catch(e){error=String(e.message).slice(0,230);report.errors.push({stage:name,message:error});}
  const readyMs=Math.round(performance.now()-started);await pause(settle);
  const after=await metrics(),samples=await page.evaluate(name=>({tasks:window.__runtimePerf.tasks.filter(x=>x.stage===name),frames:window.__runtimePerf.frames.filter(x=>x.stage===name),requests:window.__runtimePerf.requests.filter(x=>x.stage===name),intervals:[...window.__runtimePerf.intervals.values()]}),name);
  const item={name,readyMs,windowMs:Math.round(performance.now()-started),before,after,...samples,error};report.stages.push(item);flush();
  console.log(JSON.stringify({name,readyMs,longestTask:Math.round(Math.max(0,...samples.tasks.map(x=>x.ms))),longestFrame:Math.round(Math.max(0,...samples.frames.map(x=>x.ms))),heapMB:after.heapMB,requests:samples.requests.length,error}));return item;
}
async function navigate(target,section=''){
  const rail=page.locator('#rail [data-page="'+target+'"]');
  if(await rail.count() && !section)await rail.click();
  else await page.evaluate(([p,s])=>{void go(p,s);},[target,section]);
  await page.waitForFunction(p=>current===p&&document.getElementById('view')?.getAttribute('aria-busy')==='false',target==='wrong'?'notes':target,{timeout:15000});
}
async function featureAudit(base){
  report.featureResults=[];
  const nodes=[];
  for(const count of [25,100,200]){
    const seedAt=performance.now();
    for(let i=nodes.length;i<count;i++){
      const node=(await post(base,'knowledge/save',{title:'性能知识点 '+i,definition:'用于观察知识网络的布局、选择和持续动画性能。',color:i%2?'#88AABB':'#BBAA88'})).data;
      nodes.push(node.id);
      if(i>0)await post(base,'knowledge/link',{from:nodes[Math.floor((i-1)/2)],to:node.id,label:'关联'});
    }
    report.featureResults.push({name:'seed-knowledge-'+count,ms:Math.round(performance.now()-seedAt)});
    await stage('graph-'+count+'-idle',async()=>{await navigate('home');await pause(3000);},200);
    await stage('graph-'+count+'-drag',async()=>{
      const b=await page.locator('.knowledge-canvas').boundingBox();
      await page.mouse.move(b.x+b.width*.5,b.y+b.height*.5);await page.mouse.down();await page.mouse.move(b.x+b.width*.65,b.y+b.height*.6,{steps:24});await page.mouse.up();
    },500);
    await stage('graph-'+count+'-inspector',async()=>{await page.evaluate(id=>openKnowledgePoint(id),nodes[0]);},500);
    await page.locator('.knowledge-close').click();
    await stage('timeline-'+count,async()=>{await page.evaluate(()=>setKnowledgeView('timeline'));await pause(300);},300);
    await page.evaluate(()=>setKnowledgeView('graph'));
  }
  await stage('learn-open',()=>navigate('learn'));
  await stage('mindmap-generate-native-fixture',async()=>{
    const button=page.locator('#course-generate');if(await button.count())await button.click();
    await page.waitForSelector('.course-node',{timeout:45000});
  },500);
  await stage('mindmap-drag',async()=>{
    const host=page.locator('.course-stage');
    const b=await host.count()?await host.boundingBox():await page.locator('.course-world').boundingBox();
    await page.mouse.move(b.x+b.width*.5,b.y+b.height*.5);await page.mouse.down();await page.mouse.move(b.x+b.width*.55,b.y+b.height*.6,{steps:20});await page.mouse.up();
  },300);
  for(const kind of ['lecture','practice','quiz','ppt']){
    await stage('resource-generate-'+kind,async()=>{
      await navigate('learn');
      await page.locator('.course-node').filter({hasText:'工具调用'}).first().click();
      const tile=page.locator('.course-resource-tile[data-kind="'+kind+'"]');
      await tile.getByRole('button',{name:'去对话生成',exact:true}).click();
      await page.waitForSelector('#chat-input');
      await page.waitForFunction(()=>!state.busyTurn,null,{timeout:20000});
      const sid=await page.evaluate(()=>state.chatSessionId);
      await page.locator('#chat-input').fill('要求已说明，面向入门者，内容简短，直接生成这类学习资源。');
      await page.locator('.composer-send[aria-label="发送"]').click();
      for(let i=0;i<450;i++){
        const events=(await post(base,'sessions/events',{sessionId:sid})).data.events||[];
        const result=events.filter(e=>e.type==='resource/saved').at(-1)?.payload;
        if(result){report.featureResults.push({name:'generated-'+kind,kind:result.kind,id:result.id,version:result.version});return;}
        const error=events.findLast(e=>e.type==='turn/end'&&e.payload?.ok===false);if(error)throw Error(error.payload.message||'generation failed');
        await pause(100);
      }
      throw Error('resource generation timed out');
    },300);
    const resource=report.featureResults.findLast(r=>r.name==='generated-'+kind);
    if(resource){
      await stage('resource-preview-'+kind,async()=>{await page.evaluate(({id,version})=>openLearningResource(id,version),resource);},400);
      await page.evaluate(()=>closeResourceDock());
      await stage('study-open-'+kind,()=>navigate('study',resource.id+'@'+resource.version),500);
      if(kind==='ppt'){
        await stage('guided-ask',async()=>{
          await page.locator('.sp-chat-input').fill('解释这一页的输入和输出。');await page.locator('.sp-chat-send').click();
          await page.waitForFunction(()=>!document.querySelector('.sp-chat-send')?.disabled,null,{timeout:20000});
        },400);
      }
    }
  }
  const fixtureDir=path.join(runDir,'files');fs.mkdirSync(fixtureDir,{recursive:true});
  const mdFile=path.join(fixtureDir,'long-markdown.md'),htmlFile=path.join(fixtureDir,'long-page.html');
  fs.writeFileSync(mdFile,Array.from({length:400},(_,i)=>'## 性能测试 '+i+'\n\n'+('正文包含表格、代码和中文。').repeat(12)+'\n\n| 名称 | 结果 |\n| --- | --- |\n| 测试 | 正常 |\n\n```js\nconst number = '+i+';\n```\n\n').join(''));
  fs.writeFileSync(htmlFile,'<!doctype html><meta charset="utf-8"><h1>文件预览性能</h1>'+Array.from({length:4000},(_,i)=>'<p>第 '+i+' 行：独立文件预览的布局和滚动测试。</p>').join(''));
  const pptFile=path.join(fixtureDir,'actual-nine-slide.pptx');
  const previousPpt=path.join(root,'tmp/real-ppt-check/run1.pptx');
  if(fs.existsSync(previousPpt)){
    fs.copyFileSync(previousPpt,pptFile);fs.copyFileSync(path.join(root,'tmp/real-ppt-check/run1.preview.html'),pptFile+'.preview.html');
  }
  for(const file of [mdFile,htmlFile,...(fs.existsSync(pptFile)?[pptFile]:[])]){
    await navigate('chat');
    await stage('file-preview-'+path.extname(file),async()=>{await page.evaluate(file=>openFilePreview(file),file);},1000);
    await page.evaluate(()=>closeResourceDock());
    await stage('personal-import-'+path.extname(file),async()=>{const saved=await post(base,'personal/save',{path:file,title:path.basename(file),confirmed:true});report.featureResults.push({name:'personal-saved',kind:path.extname(file),id:saved.data.id});},200);
  }
  await stage('personal-list',()=>navigate('resources'));
  const kbDir=path.join(runDir,'source-kb');fs.mkdirSync(kbDir);
  for(let i=0;i<40;i++)fs.writeFileSync(path.join(kbDir,'chapter-'+i+'.md'),'# 学习资料 '+i+'\n\n'+Array.from({length:35},(_,j)=>'## 第 '+j+' 节\n\n检索、知识点与学习记录互相联系。'+('这是性能测试资料。').repeat(30)+'\n\n| 项目 | 内容 |\n| --- | --- |\n| 结果 | 应可查询 |\n\n').join(''));
  await post(base,'kb/save',{id:'perf-library',name:'40篇资料性能库',rootDir:kbDir});
  await stage('kb-index-40-docs',async()=>{const result=await post(base,'kb/build',{id:'perf-library'});report.featureResults.push({name:'kb-index',ms:result.ms});},200);
  await page.evaluate(()=>{state.kb='perf-library';});
  await stage('kb-open-40-docs',()=>navigate('kb'));
  await stage('kb-search',async()=>{await page.getByLabel('搜索资料内容',{exact:true}).fill('知识点');await page.getByLabel('搜索资料内容',{exact:true}).press('Enter');await page.waitForFunction(()=>document.querySelector('.library-results')?.textContent.includes('找到'),null,{timeout:15000});},300);
  await stage('kb-document-preview',async()=>{await page.locator('.library-document').first().getByRole('button',{name:'看内容',exact:true}).click();await page.waitForSelector('.preview-chunk');},500);
  for(let i=0;i<40;i++)await post(base,'study/notes/save',{title:'性能笔记 '+i,text:'笔记操作与列表响应测试。'.repeat(60),kbId:'perf-library'});
  for(let i=0;i<12;i++)await post(base,'study/quiz/submit',{kbId:'perf-library',chapter:'检索与知识',question:'性能错题 '+i,myAnswer:'错误答案',reference:'正确答案',correct:false});
  await stage('notes-40-list',()=>navigate('notes'));
  await stage('wrong-12-list',()=>navigate('wrong'));
  await stage('growth-after-learning-data',()=>navigate('report'));
  await stage('memory-after-learning-data',()=>navigate('memory'));
  await stage('calibration',()=>navigate('calibrate'));
}
(async()=>{
  console.log('ARTIFACTS='+runDir);await prepare();
  const env={...process.env,LOCALAPPDATA:home,APPDATA:path.join(home,'roaming'),TEMP:runDir,TMP:runDir};delete env.ELECTRON_RUN_AS_NODE;
  const launchAt=performance.now();
  app=await _electron.launch({executablePath:path.join(pack,'Lumin.exe'),args:[],env,timeout:45000});
  page=await app.firstWindow();page.setDefaultTimeout(15000);
  page.on('pageerror',e=>report.errors.push({stage:'page',message:e.message}));
  page.on('requestfailed',r=>report.network.push({url:new URL(r.url()).pathname,error:r.failure()?.errorText}));
  await page.waitForURL(/127\.0\.0\.1/, {timeout:45000});
  await page.waitForFunction(()=>document.getElementById('view')?.getAttribute('aria-busy')==='false'&&!document.getElementById('boot'),null,{timeout:45000});
  report.startupReadyMs=Math.round(performance.now()-launchAt);
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,960);w.show();w.focus();});
  await page.addInitScript(installProbe);await page.reload();
  await page.waitForFunction(()=>document.getElementById('view')?.getAttribute('aria-busy')==='false'&&!document.getElementById('boot'),null,{timeout:45000});
  cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
  report.browser=await app.evaluate(({app})=>({electron:process.versions.electron,chrome:process.versions.chrome,metrics:app.getAppMetrics().map(p=>({type:p.type,cpu:p.cpu,memory:p.memory}))}));
  const base=new URL(page.url()).origin;report.pageKeys=await page.evaluate(()=>Object.keys(PAGES));
  if(phase==='features'){
    await featureAudit(base);report.finished=new Date().toISOString();flush();console.log('FEATURE_AUDIT_DONE='+runDir);return;
  }
  if(phase==='leak'){
    await navigate('chat');await cdp.send('HeapProfiler.collectGarbage');await pause(200);report.beforeCycles=await metrics();
    for(let i=0;i<cycles;i++){
      await stage('fast-cycle-'+i,async()=>{for(const name of ['home','kb','settings','chat'])await navigate(name);},50);
      if(i%5===4){await cdp.send('HeapProfiler.collectGarbage');await pause(200);report.stages.at(-1).afterGc=await metrics();flush();}
    }
    await cdp.send('HeapProfiler.collectGarbage');await pause(300);report.afterCycles=await metrics();
    report.listenerSites=await page.evaluate(()=>({intervals:[...window.__runtimePerf.intervals.values()]}));
    report.finished=new Date().toISOString();flush();console.log('LEAK_AUDIT_DONE='+runDir);return;
  }
  if(phase==='history'){
    await navigate('chat');
    for(let round=0;round<3;round++)for(const [i,s]of(report.sessionScale||[]).slice(0,3).entries()){
      const alias='history-'+i+'-round-'+round;
      await stage(alias,async()=>{await page.evaluate(sid=>state.chatOpenSession(sid),s.id);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));},500);
      await stage(alias+'-scroll',async()=>{await page.locator('#chat-thread').hover();await page.mouse.wheel(0,-1800);await pause(200);},100);
    }
    report.finished=new Date().toISOString();flush();console.log('HISTORY_AUDIT_DONE='+runDir);return;
  }
  for(const name of ['chat','home','report','resources','notes','wrong','kb','memory','settings'])await stage('cold-'+name,()=>navigate(name));
  for(const name of ['agent','models','general','appearance','skills','data','about'])await stage('settings-'+name,()=>navigate('settings',name));
  for(const section of ['view','harvest','manage'])await stage('kb-'+section,()=>navigate('kb',section));
  if(report.sessionScale?.length){
    await navigate('chat');
    for(const [i,s]of report.sessionScale.slice(0,3).entries())await stage('open-history-'+i,async()=>{await page.evaluate(sid=>state.chatOpenSession(sid),s.id);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));},800);
  }
  await stage('idle-chat-5s',async()=>{await navigate('chat');await pause(5000);},100);
  for(const name of ['home','report','resources','kb'])await stage('idle-'+name+'-5s',async()=>{await navigate(name);await pause(5000);},100);
  await navigate('chat');await cdp.send('HeapProfiler.collectGarbage');report.beforeCycles=await metrics();
  for(let i=0;i<cycles;i++)await stage('navigation-cycle-'+i,async()=>{for(const name of ['home','report','resources','kb','settings','chat'])await navigate(name);},100);
  await cdp.send('HeapProfiler.collectGarbage');report.afterCycles=await metrics();
  await stage('stream-start',async()=>{
    await page.evaluate(()=>newChat('','chat'));await page.locator('#chat-input').fill('PERF_STREAM_LONG 请输出性能测试内容');await page.locator('.composer-send').click();
    await page.waitForFunction(()=>state.busyTurn===true,null,{timeout:15000});await pause(1200);
  },200);
  const streamingSid=await page.evaluate(()=>state.chatSessionId);
  for(const name of ['home','report','settings','kb','chat'])await stage('stream-switch-'+name,()=>navigate(name),200);
  await stage('stream-new-session-short',async()=>{
    await page.evaluate(()=>newChat('','chat'));await page.locator('#chat-input').fill('PERF_SHORT 只回复完成');await page.locator('.composer-send').click();
    await page.waitForFunction(()=>!state.busyTurn,null,{timeout:20000});
  },200);
  await stage('stop-background-stream',async()=>{await post(base,'agent/cancel',{sessionId:streamingSid});},1000);
  report.polling=await page.evaluate(()=>({intervals:[...window.__runtimePerf.intervals.values()],requests:window.__runtimePerf.requests}));
  report.final=await metrics();report.browserFinal=await app.evaluate(({app})=>app.getAppMetrics().map(p=>({type:p.type,cpu:p.cpu,memory:p.memory})));
  await page.screenshot({path:path.join(runDir,'final.png')});
  report.finished=new Date().toISOString();flush();console.log('DIAGNOSIS_DONE='+runDir);
})().catch(e=>{report.fatal=String(e.stack||e).slice(0,1400);flush();console.error('AUDIT_ERROR '+report.fatal);process.exitCode=1;}).finally(async()=>{
  if(app)await app.close().catch(()=>{});if(setupCore)setupCore.kill();if(mock)mock.closeAllConnections?.();if(mock)await new Promise(r=>mock.close(r));
  for(const suffix of ['','-wal','-shm']){const f=path.join(data,'itn.db')+suffix;if(fs.existsSync(f))fs.writeFileSync(f,'');}
  if(dataset==='snapshot'&&fs.existsSync(source)){report.originalFileUnchanged=report.sourceStamp?.mtimeMs===fs.statSync(source).mtimeMs&&report.sourceStamp?.bytes===fs.statSync(source).size;flush();}
});
