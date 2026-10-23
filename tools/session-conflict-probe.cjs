/** Session/project conflict probe: diagnostic only.
 * Packaged app + isolated DB snapshot + controlled local SSE; never touches user data.
 * Groups: A new-session immediacy/order, B project ownership, C parallel sessions.
 */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn,spawnSync}=require('node:child_process');
const {_electron}=require(require.resolve('playwright',{paths:['D:/Desktop/ITN/ITN/src/frontend/agent-demo',path.resolve(__dirname,'..')]}));
const root=path.resolve(__dirname,'..');
const packArg=process.argv.find(a=>a.startsWith('--pack='))?.slice('--pack='.length)||process.env.SESSION_CONFLICT_PACK;
if(packArg&&!path.isAbsolute(packArg))throw Error('--pack / SESSION_CONFLICT_PACK must be an absolute directory');
const pack=packArg||path.join(root,'dist','Lumin-'+JSON.parse(fs.readFileSync(path.join(root,'shell/package.json'),'utf8')).version);
const dataset=(process.argv.find(a=>a.startsWith('--dataset='))||'--dataset=snapshot').split('=')[1];
const runDir=path.join(root,'tmp','session-conflict-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(runDir,{recursive:true});
const home=path.join(runDir,'home'),data=path.join(home,'Lumin');fs.mkdirSync(data,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const report={started:new Date().toISOString(),pack,dataset,checks:[],timings:{},turns:[],errors:[],cleanup:{}};
const flush=()=>fs.writeFileSync(path.join(runDir,'result.json'),JSON.stringify(report,null,2));
const log=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);
const check=(name,ok,detail='')=>{report.checks.push({name,ok:!!ok,detail:String(detail)});if(!ok)process.exitCode=1;log((ok?'PASS':'FAIL')+' '+name+(detail?' :: '+detail:''));flush();return ok;};
const source=path.join(process.env.LOCALAPPDATA,'Lumin','itn.db');
let setupCore,app,page,mock,lastTurn,cleaning;
const ownedRoots=new Set(),ownedChildren=new Map(),sockets=new Set();
// Only this probe's process trees and kernels with this unique data path are eligible.
// Remember descendants before app.close(), which can orphan a kernel on Windows.
function captureOwned(){
  if(process.platform!=='win32')return;
  const script=`$all=@(Get-CimInstance Win32_Process); $ids=@(${[...ownedRoots].join(',')}); $dir='${runDir.replace(/'/g,"''")}'; $mine=@{}; foreach($p in $all){if($ids -contains [int]$p.ProcessId -or ($p.Name -in @('Lumin.exe','lumin-core.exe','itn-desktop-core.exe') -and ([string]$p.CommandLine).Contains($dir,[StringComparison]::OrdinalIgnoreCase))){$mine[[int]$p.ProcessId]=$true}}; do{$changed=$false; foreach($p in $all){if($mine.ContainsKey([int]$p.ParentProcessId) -and !$mine.ContainsKey([int]$p.ProcessId)){$mine[[int]$p.ProcessId]=$true;$changed=$true}}}while($changed); @($all | Where-Object {$mine.ContainsKey([int]$_.ProcessId)} | ForEach-Object {@{pid=[int]$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:12000});
  if(r.error||r.status!==0)throw Error('Owned-process inventory failed: '+(r.error?.message||r.stderr));
  const parsed=JSON.parse(r.stdout.trim()||'[]');
  for(const p of Array.isArray(parsed)?parsed:[parsed])ownedChildren.set(p.pid,p);
}
async function cleanup(){
  if(cleaning)return cleaning;
  cleaning=(async()=>{
    const errors=[];
    try{captureOwned();}catch(e){errors.push(String(e));}
    // Kill captured identities independently of app.close() and regardless of earlier failures.
    try{
      const records=JSON.stringify([...ownedChildren.values()]).replace(/'/g,"''");
      const script=`$records=ConvertFrom-Json '${records}'; foreach($r in $records){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$r.pid); if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $r.created){Stop-Process -Id $r.pid -Force -ErrorAction Stop}}`;
      const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000});
      if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr);
    }catch(e){errors.push(String(e));}
    for(const pid of ownedRoots){try{process.kill(pid);}catch(e){if(e.code!=='ESRCH')errors.push(String(e));}}
    if(app){let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('app.close timeout after targeted kill')),2500);})]);}catch{}finally{clearTimeout(timer);}}
    if(setupCore)try{setupCore.kill();}catch(e){errors.push(String(e));}
    try{for(const socket of sockets)socket.destroy();if(mock){mock.closeAllConnections?.();if(mock.listening)await new Promise(r=>mock.close(r));}}catch(e){errors.push(String(e));}
    await pause(200);
    const zeroed=[];
    // Scope is the private data directory created above, never the source user DB.
    for(const suffix of ['','-wal','-shm']){
      const f=path.join(data,'itn.db')+suffix;
      if(!fs.existsSync(f))continue;
      let success=false;
      for(let attempt=0;attempt<6;attempt++){try{fs.truncateSync(f,0);success=true;break;}catch{await pause(150);}}
      const bytes=fs.statSync(f).size;zeroed.push({path:path.relative(runDir,f),bytes});
      if(!success||bytes!==0)errors.push('Could not zero '+f);
    }
    const survivors=[];
    try{
      const records=JSON.stringify([...ownedChildren.values()]).replace(/'/g,"''");
      const script=`$records=ConvertFrom-Json '${records}'; @($records | Where-Object {$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.pid); $p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $_.created} | ForEach-Object {$_.pid}) | ConvertTo-Json -Compress`;
      const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:12000});
      if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr);
      const parsed=JSON.parse(r.stdout.trim()||'[]');survivors.push(...(Array.isArray(parsed)?parsed:[parsed]));
    }catch(e){errors.push(String(e));}
    report.cleanup={finished:new Date().toISOString(),owned:[...ownedChildren.values()],survivors,zeroed,mockClosed:!mock?.listening,errors};
    check('cleanup: own processes stopped, localhost closed, isolated DB zeroed',!survivors.length&&!errors.length&&!mock?.listening,JSON.stringify(report.cleanup));
    report.finished=new Date().toISOString();report.exitCode=process.exitCode||0;flush();
  })();
  return cleaning;
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{process.exitCode=signal==='SIGINT'?130:143;void cleanup().finally(()=>process.exit(process.exitCode));});

async function post(base,route,body={}){
  const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const j=await r.json();if(j.code!==0)throw Error(route+': '+String(j.message).slice(0,160));
  return j.data;
}
async function waitFor(fn,timeout=8000,poll=30){
  const t0=performance.now();
  while(performance.now()-t0<timeout){const v=await fn();if(v)return {...(typeof v==='object'?v:{}),value:v,ms:Math.round(performance.now()-t0)};await pause(poll);}
  return null;
}
(async()=>{
  if(dataset==='snapshot'){
    for(const suffix of ['','-wal'])if(fs.existsSync(source+suffix))fs.copyFileSync(source+suffix,path.join(data,'itn.db')+suffix);
  }
  mock=http.createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'conflict-local'}]}));return;}
    const buffers=[];for await(const chunk of req)buffers.push(chunk);
    let body={};try{body=JSON.parse(Buffer.concat(buffers).toString());}catch{}
    const latest=(body.messages||[]).filter(m=>m.role==='user').at(-1)?.content||'';
    const system=(body.messages||[]).filter(m=>m.role==='system').map(m=>m.content||'').join(' ');
    const titleRequest=system.startsWith('你是会话命名器');
    const long=typeof latest==='string'&&latest.includes('CONFLICT_STREAM_LONG')&&!titleRequest;
    report.turns.push({long,titleRequest,startedAt:Date.now()});
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const text=long?Array.from({length:500},(_,i)=>'### 并行片段 '+(i+1)+'\n\n'+('这里是并行会话压力测试的连续输出内容。').repeat(8)+'\n\n').join(''):'并行测试回复完成。';
    for(let i=0;i<text.length&&!res.destroyed;i+=90){res.write('data: '+JSON.stringify({choices:[{delta:{content:text.slice(i,i+90)},finish_reason:null}]})+'\n\n');await pause(long?60:10);}
    if(!res.destroyed){res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:Math.ceil(text.length/2)}})+'\n\ndata: [DONE]\n\n');res.end();}
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  mock.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  const pf=path.join(runDir,'setup.port');
  setupCore=spawn(path.join(pack,'resources/kernel/lumin-core.exe'),['--data-dir='+data,'--port-file='+pf,'--ui-dir='+path.join(pack,'resources/app/renderer')],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'1GB'}});
  for(let i=0;i<400&&!fs.existsSync(pf);i++)await pause(100);
  if(!fs.existsSync(pf))throw Error('setup kernel not ready');
  const sbase='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const cfg=await(await fetch(sbase+'/api/settings')).json();
  for(const m of cfg.data.models||[])await post(sbase,'models/delete',{id:m.id});
  await post(sbase,'models/save',{id:'conflict-local',name:'隔离并行测试',baseUrl:'http://127.0.0.1:'+mock.address().port+'/v1',apiKey:'local-fixture',model:'conflict-local',reasoningProfile:'none'});
  await post(sbase,'models/roles',{chatModelId:'conflict-local'});
  setupCore.kill();await new Promise(r=>setupCore.once('exit',r));setupCore=null;

  const env={...process.env,LOCALAPPDATA:home,APPDATA:path.join(home,'roaming'),TEMP:runDir,TMP:runDir};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:path.join(pack,'Lumin.exe'),args:[],env,timeout:45000});
  ownedRoots.add(app.process().pid);
  page=await app.firstWindow();page.setDefaultTimeout(20000);
  page.on('pageerror',e=>report.errors.push({stage:'page',message:e.message}));
  await page.waitForURL(/127\.0\.0\.1/,{timeout:45000});
  await page.waitForFunction(()=>document.getElementById('view')?.getAttribute('aria-busy')==='false'&&!document.getElementById('boot'),null,{timeout:45000});
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,960);w.show();});
  await page.addInitScript(()=>{
    const orig=window.fetch;window.__listLog=[];window.__askLog=[];
    window.fetch=async function(input,...args){
      const url=String(typeof input==='string'?input:input.url);
      if(url.includes('/api/agent/ask-pi')){
        const body=JSON.parse(args[0]?.body||'{}'),entry={sessionId:body.sessionId,at:performance.now(),done:false};window.__askLog.push(entry);
        try{const r=await orig.call(this,input,...args);const j=await r.clone().json();entry.done=true;entry.ok=j.data?.ok===true;entry.turnId=j.data?.turnId;return r;}catch(e){entry.done=true;entry.error=e.name;throw e;}
      }
      if(url.includes('/api/sessions/list')){
        const t=performance.now();
        try{const r=await orig.call(this,input,...args);const j=await r.clone().json();
          window.__listLog.push({at:t,ms:Math.round(performance.now()-t),count:(j.data?.sessions||[]).length});return r;}
        catch(e){window.__listLog.push({at:t,ms:Math.round(performance.now()-t),error:String(e)});throw e;}
      }
      return orig.call(this,input,...args);
    };
  });
  await page.reload();
  await page.waitForFunction(()=>document.getElementById('view')?.getAttribute('aria-busy')==='false'&&!document.getElementById('boot'),null,{timeout:45000});
  const base=new URL(page.url()).origin;
  // helper inside page: ordered rail rows with group + position
  const railRows=()=>page.evaluate(()=>{
    const body=document.getElementById('panel-body');
    if(!body)return [];
    const out=[];let g='';
    for(const n of body.children){
      if(n.classList&&n.classList.contains('rail-group-head'))g=n.dataset.group??'';
      else if(n.classList&&n.classList.contains('rail-session')){
        const b=n.querySelector('.panel-item');
        out.push({group:g,id:b?.dataset.id||'',title:b?.querySelector('.panel-item-label')?.textContent||'',busy:!!b?.querySelector('.panel-item-spin')});
      }
    }
    return out;
  });
  const goChat=async()=>{await page.evaluate(()=>go('chat'));await page.waitForFunction(()=>current==='chat'&&document.getElementById('view')?.getAttribute('aria-busy')==='false',null,{timeout:15000});};
  const send=async text=>{
    await page.waitForFunction(()=>!isCurrentSessionCreating(),null,{timeout:15000});
    const expected=await page.evaluate(()=>({sid:state.chatSessionId,count:window.__askLog.length}));
    await page.locator('#chat-input').fill(text);
    await page.locator('.composer-send[aria-label="发送"]').click();
    await page.waitForFunction(count=>window.__askLog.length>count,expected.count,{timeout:15000});
    const actual=await page.evaluate(count=>window.__askLog[count],expected.count);
    if(actual.sessionId!==expected.sid)throw Error('输入发送到了非当前会话');
    lastTurn={sid:actual.sessionId,index:expected.count};
  };
  const newViaMenu=async itemText=>{
    const available=await waitFor(async()=>await page.evaluate(()=>!state.chatStarting&&!busyActions.has('session:new')),15000,50);
    if(!available)throw Error('前一次创建操作未完成，不能开始下一次顺序创建');
    const previous=await page.evaluate(()=>state.chatSessionId);
    await page.locator('#rail-new').click();
    const menu=page.locator('.new-menu');
    await menu.waitFor({state:'visible',timeout:5000});
    await menu.locator('.rail-menu-item',{hasText:itemText}).first().click();
    await page.waitForFunction(previous=>state.chatSessionId&&state.chatSessionId!==previous,previous,{timeout:10000});
  };
  const listLog=()=>page.evaluate(()=>window.__listLog.slice());
  const sid=()=>page.evaluate(()=>state.chatSessionId);

  // ============ A 组：新建会话的即时性与排序 ============
  await goChat();
  const baseline=await railRows();
  const baselineIds=new Set(baseline.map(r=>r.id));

  // A1 冷静状态新建常规会话
  {
    const t0=performance.now();
    await newViaMenu('常规聊天');
    const newId=await waitFor(async()=>{const s=await sid();return s&&!baselineIds.has(s)?s:null;},8000);
    const railHit=await waitFor(async()=>{const rows=await railRows();const hit=rows.find(r=>r.id===newId?.value);return hit?{rows,hit}:null;},8000,30);
    const ms=Math.round(performance.now()-t0);
    report.timings.A1={newId:newId?.value,createdMs:newId?.ms,domMs:Math.round(performance.now()-t0)};
    check('A1 冷静新建：侧栏出现新会话',!!railHit,'domWait='+(railHit?railHit.ms:null)+'ms total='+ms+'ms');
    if(railHit){
      const inGroup=railHit.hit.group==='';
      const atTop=railHit.rows.filter(r=>r.group==='')[0]?.id===newId.value;
      check('A1 归入普通对话组',inGroup,'group='+JSON.stringify(railHit.hit.group));
      check('A1 新会话位于组内第 1 位',atTop,'index='+railHit.rows.filter(r=>r.group==='').findIndex(r=>r.id===newId.value));
    }
  }

  // A2 流式输出另一会话时新建：先造一段长流，再新建
  {
    await send('CONFLICT_STREAM_LONG 请持续输出较长的性能测试内容');
    await page.waitForFunction(()=>state.busyTurn===true,null,{timeout:15000});
    const streamSid=await sid();
    const before=await railRows();
    const t0=performance.now();
    await newViaMenu('常规聊天');
    const newId=await waitFor(async()=>{const s=await sid();return s&&s!==streamSid?s:null;},8000);
    const railHit=await waitFor(async()=>{const rows=await railRows();const hit=rows.find(r=>r.id===newId?.value);return hit?{rows,hit}:null;},8000,30);
    check('A2 流式中新建：侧栏出现新会话',!!railHit,'domWait='+(railHit?railHit.ms:null)+'ms');
    if(railHit){
      const normalRows=railHit.rows.filter(r=>r.group==='');
      check('A2 新会话在普通对话组第 1 位',normalRows[0]?.id===newId.value,'index='+normalRows.findIndex(r=>r.id===newId.value)+' 组行数='+normalRows.length);
    }
    // 老会话还在跑吗（新会话把状态切走后）
    const oldBusy=await page.evaluate(s=>isSessionRunning(s),streamSid);
    check('A2 切走后旧会话仍在跑',oldBusy,'streamSid='+streamSid);
    const ll=await listLog();
    const stale=ll.slice(-6);
    report.timings.A2={streamSid,newId:newId?.value,listTail:stale};
    await post(base,'agent/cancel',{sessionId:streamSid}).catch(()=>{});
    await pause(800);
  }

  // A3 连续快速新建 3 个
  {
    const ids=[];
    for(let i=0;i<3;i++){
      await newViaMenu('常规聊天');
      const prev=ids;
      const got=await waitFor(async()=>{const s=await sid();return s&&!prev.includes(s)?s:null;},8000);
      ids.push(got?.value);
    }
    const rows=await railRows();
    const normalIds=rows.filter(r=>r.group==='').map(r=>r.id);
    const allShown=ids.every(x=>x&&normalIds.includes(x));
    check('A3 连续新建 3 个全部出现在侧栏',allShown,'ids='+JSON.stringify(ids)+' railNormal='+normalIds.length);
    const idxs=ids.map(x=>normalIds.indexOf(x));
    check('A3 三个新会话都排在组内前 3',idxs.every(i=>i>=0&&i<3),'idx='+JSON.stringify(idxs));
  }

  // A4 同秒排序：旧会话刚回复完，立刻新建
  {
    await send('CONFLICT_SHORT 只回复完成');
    await page.waitForFunction(()=>!state.busyTurn,null,{timeout:20000});
    const finishedSid=await sid();
    await newViaMenu('常规聊天');
    const newId=await waitFor(async()=>{const s=await sid();return s&&s!==finishedSid?s:null;},8000);
    await pause(300);
    const rows=await railRows();
    const normalIds=rows.filter(r=>r.group==='').map(r=>r.id);
    const iNew=normalIds.indexOf(newId?.value),iOld=normalIds.indexOf(finishedSid);
    check('A4 旧会话刚回复完立刻新建：新会话排在旧会话之前',iNew>=0&&iOld>=0&&iNew<iOld,'new@'+iNew+' old@'+iOld+' total='+normalIds.length);
    // 服务端顺序（权威）：再拉一次列表对照 DOM
    const serverRows=(await post(base,'sessions/list',{force:true})).sessions.map(x=>x.sessionId);
    const siNew=serverRows.indexOf(newId?.value),siOld=serverRows.indexOf(finishedSid);
    check('A4 服务端列表同样新会话在前',siNew>=0&&siOld>=0&&siNew<siOld,'new@'+siNew+' old@'+siOld+' total='+serverRows.length);
  }

  // A5 自动命名后位置保持
  {
    // 当前新会话发一条消息，等回合结束（夹具会异步起名）
    await send('CONFLICT_SHORT 这是一条用于触发自动命名的消息');
    await page.waitForFunction(()=>!state.busyTurn,null,{timeout:20000});
    const named=await waitFor(async()=>{
      const cur=await sid();
      const rows=await railRows();
      const row=rows.find(r=>r.id===cur);
      return row&&row.title&&row.title!=='新对话'?row:null;
    },20000,200);
    const rows=await railRows();
    const normalIds=rows.filter(r=>r.group==='').map(r=>r.id);
    check('A5 自动命名出标题',!!named,'title='+(named&&named.value?named.value.title:'(未命名)'));
    const namedId=named&&named.value?named.value.id:'';
    check('A5 命名后会话仍在组内第 1 位',normalIds[0]===namedId,'index='+normalIds.indexOf(namedId));
  }

  // ============ B 组：项目归属冲突 ============
  const projARoot=path.join(runDir,'proj-a'),projBRoot=path.join(runDir,'proj-b'),projPRoot=path.join(runDir,'proj-p');
  for(const d of [projARoot,projBRoot,projPRoot])fs.mkdirSync(d,{recursive:true});
  const projA=await post(base,'projects/save',{id:'conflict-a',name:'冲突项目A',root:projARoot});
  const projB=await post(base,'projects/save',{id:'conflict-b',name:'冲突项目B',root:projBRoot});
  await page.evaluate(()=>{state.projects=undefined;});
  await page.evaluate(async()=>{state.projects=(await (await fetch('/api/projects/list',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json()).data.projects||[];});
  await page.evaluate(()=>renderPanel());
  await pause(300);

  // B1 项目工作区新建 → 归组正确
  {
    const before=await railRows();
    await newViaMenu('冲突项目A');
    const newId=await waitFor(async()=>{const s=await sid();return s&&!before.some(r=>r.id===s)?s:null;},8000);
    const railHit=await waitFor(async()=>{const rows=await railRows();const hit=rows.find(r=>r.id===newId?.value);return hit?{rows,hit}:null;},8000,30);
    check('B1 项目A工作区新建出现在侧栏',!!railHit,'id='+(newId||{}).value);
    if(railHit){
      const server=(await post(base,'sessions/list',{force:true})).sessions.find(x=>x.sessionId===newId.value);
      check('B1 归入项目A分组（DOM 与服务端一致）',railHit.hit.group===projA.id&&(server?.projectId||'')===projA.id,'domGroup='+JSON.stringify(railHit.hit.group)+' server='+(server?.projectId||''));
    }
  }

  // B2 项目A会话流式中，项目B新建并问答
  {
    await send('CONFLICT_STREAM_LONG 项目A的长任务输出');
    await page.waitForFunction(()=>state.busyTurn===true,null,{timeout:15000});
    const aSid=await sid();
    const before=await railRows();
    await newViaMenu('冲突项目B');
    const bId=await waitFor(async()=>{const s=await sid();return s&&s!==aSid?s:null;},8000);
    await send('CONFLICT_SHORT 项目B的快速提问');
    const bDone=await waitFor(async()=>!(await page.evaluate(()=>state.busyTurn)),20000,100);
    check('B2 项目A流式中项目B问答可用',!!bDone&&!!bId,'bId='+bId);
    const aStill=await page.evaluate(s=>isSessionRunning(s),aSid);
    check('B2 项目A会话仍在跑',aStill,'aSid='+aSid);
    const rows=await railRows();
    check('B2 项目B新会话归入项目B分组',rows.find(r=>r.id===bId?.value)?.group===projB.id,'group='+JSON.stringify(rows.find(r=>r.id===bId?.value)?.group));
    await post(base,'agent/cancel',{sessionId:aSid}).catch(()=>{});
    await pause(600);
  }

  // B3 项目占位行分组：项目P 新会话发出消息瞬间（服务端列表尚未包含它时）
  {
    const projP=await post(base,'projects/save',{id:'conflict-p',name:'冲突项目P',root:projPRoot});
    await page.evaluate(async()=>{state.projects=(await (await fetch('/api/projects/list',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json()).data.projects||[];});
    await page.evaluate(()=>renderPanel());await pause(250);
    await newViaMenu('冲突项目P');
    await page.waitForFunction(()=>!!state.chatSessionId,null,{timeout:8000});
    await send('CONFLICT_STREAM_LONG 项目P的长任务');
    await page.waitForFunction(()=>state.busyTurn===true,null,{timeout:15000});
    const pSid=await sid();
    await pause(120);
    const rows=await railRows();
    const row=rows.find(r=>r.id===pSid);
    report.timings.B3={pSid,row};
    check('B3 跑动中的项目P新会话已显示',!!row,'row='+JSON.stringify(row||{}));
    if(row)check('B3 占位/列表行的分组是项目P（不是普通对话）',row.group===projP.id,'group='+JSON.stringify(row.group));
    await post(base,'agent/cancel',{sessionId:pSid}).catch(()=>{});
    await pause(600);
  }

  // B4 双项目交错新建
  {
    const created=[];
    for(const proj of ['冲突项目A','冲突项目B','冲突项目A','冲突项目B']){
      const before=await railRows();
      await newViaMenu(proj);
      const newId=await waitFor(async()=>{const s=await sid();return s&&!before.some(r=>r.id===s)?s:null;},8000);
      created.push({proj,newId:newId?.value});
    }
    const rows=await railRows();
    const okAll=created.every(c=>{
      const row=rows.find(r=>r.id===c.newId);
      const expect=c.proj==='冲突项目A'?projA.id:projB.id;
      return row&&row.group===expect;
    });
    check('B4 双项目交错新建 4 个归属全部正确',okAll,JSON.stringify(created.map(c=>({p:c.proj,ok:rows.find(r=>r.id===c.newId)?.group}))));
  }

  // ============ C 组：会话并行与隔离 ============
  // C1 双会话同时流式 + 轻接口延迟
  {
    // 会话1：普通对话长流（当前会话即可）
    await goChat();
    await newViaMenu('常规聊天');
    await page.waitForFunction(()=>!!state.chatSessionId,null,{timeout:8000});
    await send('CONFLICT_STREAM_LONG 双流测试甲');
    await page.waitForFunction(()=>state.busyTurn===true,null,{timeout:15000});
    const sidA=await sid();
    // 会话2：从列表点开另一个普通会话（A4 的会话）并发短问
    const rows=await railRows();
    const other=rows.filter(r=>r.group==='').find(r=>r.id!==sidA);
    await page.evaluate(s=>openChatSession(s),other.id);
    await page.waitForFunction(()=>current==='chat'&&document.getElementById('view')?.getAttribute('aria-busy')==='false',null,{timeout:15000});
    const t0=performance.now();
    await send('CONFLICT_SHORT 双流测试乙');
    const bDone=await waitFor(async()=>!(await page.evaluate(()=>state.busyTurn)),30000,100);
    const bMs=Math.round(performance.now()-t0);
    const aStill=await page.evaluate(s=>isSessionRunning(s),sidA);
    check('C1 双流：乙会话问答在 30s 内完成',!!bDone,'耗时='+bMs+'ms');
    check('C1 双流：甲会话仍在跑',aStill,'sidA='+sidA);
    const light=await page.evaluate(async()=>{const t=performance.now();const r=await fetch('/api/settings');if(!r.ok)throw Error('settings request failed');await r.json();return Math.round(performance.now()-t);});
    check('C1 双流期间轻接口 settings 延迟 <1500ms',light<1500,light+'ms');
    report.timings.C1={bMs,light,aSid: sidA};
    await post(base,'agent/cancel',{sessionId:sidA}).catch(()=>{});
    await pause(800);
  }

  // C2 甲流式中切到乙连续三轮问答
  {
    await newViaMenu('常规聊天');
    await page.waitForFunction(()=>!!state.chatSessionId,null,{timeout:8000});
    await send('CONFLICT_STREAM_LONG 连续切换测试流');
    await page.waitForFunction(()=>state.busyTurn===true,null,{timeout:15000});
    const sidA=await sid();
    const rows=await railRows();
    const other=rows.filter(r=>r.group==='').find(r=>r.id!==sidA&&r.eventCount!==0);
    await page.evaluate(s=>openChatSession(s),other.id);
    await page.waitForFunction(()=>current==='chat'&&document.getElementById('view')?.getAttribute('aria-busy')==='false',null,{timeout:15000});
    let allOk=true;const dur=[];
    for(let i=0;i<3;i++){
      const t=performance.now();
      await send('CONFLICT_SHORT 切换问答第'+(i+1)+'轮');
      const done=await waitFor(async()=>!(await page.evaluate(()=>state.busyTurn)),30000,100);
      dur.push(Math.round(performance.now()-t));
      if(!done)allOk=false;
    }
    check('C2 流式中切到乙连续 3 轮问答全部完成',allOk,'durations='+JSON.stringify(dur));
    check('C2 甲仍在跑',await page.evaluate(s=>isSessionRunning(s),sidA),'sidA='+sidA);
    await post(base,'agent/cancel',{sessionId:sidA}).catch(()=>{});
    await pause(800);
  }

  // C3 甲流式中对甲停止 / 对甲删除保护
  {
    await newViaMenu('常规聊天');
    await page.waitForFunction(()=>!!state.chatSessionId,null,{timeout:8000});
    await send('CONFLICT_STREAM_LONG 停止与删除保护测试');
    await page.waitForFunction(()=>state.busyTurn===true,null,{timeout:15000});
    const sidA=await sid();
    // 删除保护：跑动中的会话应被拒绝（接口或 UI 层）
    const admitted=await waitFor(async()=>{const state=await post(base,'sessions/state',{sessionId:sidA});return state.status==='running';},10000,50);
    check('C3 内核确认会话正在执行',!!admitted);
    let delRejected=false;try{await post(base,'sessions/delete',{sessionId:sidA});}catch(e){delRejected=true;}
    check('C3 跑动中的会话删除被拒绝',delRejected,'(若未拒绝，检查是否有删除保护)');
    await post(base,'agent/cancel',{sessionId:sidA});
    const stopped=await waitFor(async()=>!(await page.evaluate(s=>isSessionRunning(s),sidA)),15000,100);
    check('C3 停止后会话退出跑动状态',!!stopped);
    await pause(500);
  }

  await page.screenshot({path:path.join(runDir,'final.png')});
  report.finished=new Date().toISOString();flush();
  const failed=report.checks.filter(c=>!c.ok);
  log('SUMMARY: '+report.checks.length+' checks, '+failed.length+' failed');
  log('CONFLICT_DONE='+runDir);
})().catch(async e=>{report.fatal=String(e.stack||e).slice(0,1400);if(page){await page.screenshot({path:path.join(runDir,'failure.png')}).catch(()=>{});report.failureState=await page.evaluate(()=>({current,sid:state.chatSessionId,chatStarting:!!state.chatStarting,newBusy:busyActions.has('session:new'),busy:state.busyTurn})).catch(()=>null);}flush();console.error('PROBE_ERROR '+report.fatal);process.exitCode=1;}).finally(async()=>{
  await cleanup();
});
