/** Real model + native session/project APIs and visible rail. Only TEMP data writes.
 * Credentials come from a private copied database and are never printed.
 * Does not benchmark the upstream model or stress arbitrary file operations.
 */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const {chromium}=require(require.resolve('playwright',{paths:['D:/Desktop/ITN/ITN/src/frontend/agent-demo',path.resolve(__dirname,'..')]}));
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const credDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-session-real-cred-'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-session-real-')),pf=path.join(dir,'port');
  const result={checks:[],timings:{}};let core,browser,credentialDb;
  try{
    const source=path.join(process.env.LOCALAPPDATA,'Lumin','itn.db');
    for(const suffix of ['','-wal'])if(fs.existsSync(source+suffix))fs.copyFileSync(source+suffix,path.join(credDir,'itn.db')+suffix);
    credentialDb=new DatabaseSync(path.join(credDir,'itn.db'),{readOnly:true});
    const model=credentialDb.prepare('SELECT base_url,api_key,model FROM models WHERE id=?').get(process.env.REAL_SMOKE_MODEL_ID||'deepseek');credentialDb.close();credentialDb=null;
    assert(model?.api_key,'no model in private credential copy');
    core=spawn(process.env.SESSION_REAL_CORE||path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+(process.env.SESSION_REAL_UI||path.join(root,'shell/renderer'))],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
    for(let i=0;i<250&&!fs.existsSync(pf);i++)await pause(100);
    assert(fs.existsSync(pf),'kernel startup');
    const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
    const post=async(route,body={})=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});const j=await r.json();assert.equal(j.code,0,route+': '+String(j.message||'').slice(0,180));return j.data;};
    const check=(name,ok)=>{assert(ok,name);result.checks.push(name);console.log('PASS '+name);};
    await post('models/save',{id:'real',name:'真实会话验收',baseUrl:model.base_url,apiKey:model.api_key,model:model.model,reasoningProfile:'deepseek'});
    await post('models/roles',{chatModelId:'real'});
    const roots=[path.join(dir,'project-a'),path.join(dir,'project-b')];roots.forEach(p=>fs.mkdirSync(p));
    const projects=[];for(let i=0;i<roots.length;i++)projects.push(await post('projects/save',{name:'验收项目'+i,root:roots[i]}));
    const a=await post('sessions/new',{projectId:projects[0].id}),b=await post('sessions/new',{projectId:projects[1].id});
    const initial=(await post('sessions/list',{force:true})).sessions;
    check('two empty chats persist with correct project before sending',initial.some(s=>s.sessionId===a.sessionId&&s.projectId===projects[0].id)&&initial.some(s=>s.sessionId===b.sessionId&&s.projectId===projects[1].id));
    browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.waitForSelector('#chat-input');
    await page.waitForFunction(()=>!document.getElementById('boot'));
    await page.evaluate(sid=>openChatSession(sid),a.sessionId);
    const started=Date.now();
    const pendingA=post('agent/ask-pi',{sessionId:a.sessionId,question:'请调用 calc 计算 17*19，随后写约400字，分三点解释函数返回值。正文以 REAL_A_MARKER 开始，不要查询资料或修改文件。',mode:'work',web:'off',exec:'0',reasoningMode:'low'});
    let ae=[];
    for(let i=0;i<100;i++){ae=(await post('sessions/events',{sessionId:a.sessionId})).events||[];if(ae.some(e=>e.type==='model/request'))break;await pause(80);}
    const runningAtB=(await post('sessions/state',{sessionId:a.sessionId})).status==='running';
    const startB=Date.now();
    const rb=await post('agent/ask-pi',{sessionId:b.sessionId,question:'不要调用工具，只回复 REAL_B_MARKER。',mode:'work',web:'off',exec:'0',reasoningMode:'off'});
    result.timings.bMs=Date.now()-startB;
    const ra=await pendingA;result.timings.bothMs=Date.now()-started;
    check('second chat starts while first chat is running',runningAtB);
    if(!ra.ok||!rb.ok){
      const scrub=message=>String(message||'').replaceAll(model.api_key,'[redacted]').slice(0,500);
      console.error('REAL_TURN_A='+JSON.stringify({ok:ra.ok,message:scrub(ra.message)}));
      console.error('REAL_TURN_B='+JSON.stringify({ok:rb.ok,message:scrub(rb.message)}));
    }
    check('both real-model turns finish successfully',ra.ok===true&&rb.ok===true);
    const eventsA=(await post('sessions/events',{sessionId:a.sessionId})).events||[],eventsB=(await post('sessions/events',{sessionId:b.sessionId})).events||[];
    const textA=eventsA.filter(e=>e.type==='assistant/message').map(e=>e.payload?.text||'').join(' '),textB=eventsB.filter(e=>e.type==='assistant/message').map(e=>e.payload?.text||'').join(' ');
    check('answers and event histories stay in their own sessions',textA.includes('REAL_A_MARKER')&&!JSON.stringify(eventsA).includes('REAL_B_MARKER')&&textB.includes('REAL_B_MARKER')&&!JSON.stringify(eventsB).includes('REAL_A_MARKER'));
    check('native tool continues in the first chat',eventsA.some(e=>e.type==='tool/result'&&e.payload?.tool==='calc'&&e.payload?.ok===true)&&textA.includes('323'));
    await page.evaluate(async()=>{await reloadSessions();await renderPanel();});
    const rows=await page.locator('#panel-body .rail-session .panel-item').evaluateAll(es=>es.map(e=>({id:e.dataset.id,group:e.closest('.rail-session')?.dataset.group})));
    check('both real chats remain visible in the rail',rows.some(r=>r.id===a.sessionId)&&rows.some(r=>r.id===b.sessionId));
    await page.evaluate(sid=>openChatSession(sid),b.sessionId);
    check('switching to second chat restores its own messages',(await page.locator('#chat-thread').innerText()).includes('REAL_B_MARKER')&&!(await page.locator('#chat-thread').innerText()).includes('REAL_A_MARKER'));
    const list=(await post('sessions/list',{force:true})).sessions;
    check('project bindings survive real turns and switching',list.find(s=>s.sessionId===a.sessionId)?.projectId===projects[0].id&&list.find(s=>s.sessionId===b.sessionId)?.projectId===projects[1].id);
    check('no renderer exceptions',errors.length===0);
    console.log(JSON.stringify({model:model.model,checks:result.checks.length,timings:result.timings,answerCharsA:textA.length,answerCharsB:textB.length}));
    console.log('REAL_SESSION_ISOLATION=PASS');
  } finally{
    if(credentialDb)credentialDb.close();if(browser)await browser.close();if(core){core.kill();await pause(400);}
    for(const folder of[credDir,dir])for(const suffix of['','-wal','-shm']){const p=path.join(folder,'itn.db')+suffix;if(fs.existsSync(p))fs.writeFileSync(p,'');}
  }
})().catch(e=>{console.error('REAL_SESSION_ISOLATION_ERROR '+String(e.message).slice(0,250));process.exitCode=1;});
