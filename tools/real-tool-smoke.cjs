/** 真实模型 + 工具回路：要求模型调用 calc，验证 tool/call → tool/result → 最终回答整条链路。凭据只从 TEMP 副本读取并清零。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const root='D:/Desktop/ITN/ITN-Desktop',pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const credDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-cred-tool-')),cred=path.join(credDir,'cred.db');
 fs.copyFileSync(path.join(process.env.LOCALAPPDATA,'Lumin','itn.db'),cred);
 let model;
 try{const db=new DatabaseSync(cred,{readOnly:true});model=db.prepare("SELECT base_url,api_key,model FROM models WHERE id=?").get(process.env.REAL_SMOKE_MODEL_ID||'deepseek');db.close();}catch(e){throw new Error('读凭据副本失败：'+e.message);}
 if(!model?.api_key)throw new Error('副本里没有可用模型配置');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-tool-')),pf=path.join(dir,'port');
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
 try{
  for(let i=0;i<200&&!fs.existsSync(pf);i++)await pause(100);
  if(!fs.existsSync(pf))throw new Error('内核未启动');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(route,body={})=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});const j=await r.json();if(j.code!==0)throw new Error(route+': '+j.message);return j.data;};
  await post('models/save',{id:'real-tool',name:'真实工具验收',baseUrl:model.base_url,apiKey:model.api_key,model:model.model});
  await post('models/roles',{chatModelId:'real-tool'});
  const sid=(await post('sessions/new',{})).sessionId;
  const parallel=process.env.REAL_TOOL_PARALLEL==='1';
  const question=parallel?'请在同一次工具调用回复中并行调用 calc 两次，分别计算 (12+8)*3/4 和 7*8。工具结果返回后，用一句话给出这两个结果。不要执行其他操作。':'请调用 calc 工具计算 (12+8)*3/4，并用一句话告诉我结果。';
  const res=await post('agent/ask-pi',{kbId:'',question,sessionId:sid,web:'auto',mode:'chat',skill:'',perm:'auto'});
  let events=[];
  for(let i=0;i<900;i++){events=(await post('sessions/events',{sessionId:sid})).events||[];if(events.some(e=>e.type==='turn/end'))break;await pause(200);}
  const end=events.find(e=>e.type==='turn/end');
  const calls=events.filter(e=>e.type==='tool/call').map(e=>e.payload?.tool);
  const results=events.filter(e=>e.type==='tool/result').map(e=>({tool:e.payload?.tool,ok:e.payload?.ok,summary:String(e.payload?.summary||'').slice(0,80)}));
  const answer=events.filter(e=>e.type==='assistant/message').map(e=>e.payload?.text||'').join('\n').trim();
  console.log('MODEL='+model.model+' ASK_OK='+(res.ok===true)+' TURN_OK='+(end?.payload?.ok===true));
  console.log('TOOL_CALLS='+JSON.stringify(calls));
  console.log('TOOL_RESULTS='+JSON.stringify(results));
  console.log('ANSWER_CHARS='+answer.length+' ANSWER_HEAD='+answer.replace(/\s+/g,' ').slice(0,90));
  if(end?.payload?.message)console.log('TURN_MESSAGE='+String(end.payload.message).slice(0,180));
  const ok=res.ok===true&&end?.payload?.ok===true&&calls.filter(t=>t==='calc').length>=(parallel?2:1)&&results.filter(r=>r.tool==='calc'&&r.ok===true).length>=(parallel?2:1)&&/15/.test(answer)&&(!parallel||/56/.test(answer));
  process.exitCode=ok?0:1;
 }finally{try{core.kill();}catch{}await pause(300);fs.writeFileSync(cred,'');for(const name of ['itn.db','itn.db-wal','itn.db-shm']){const file=path.join(dir,name);if(fs.existsSync(file))fs.writeFileSync(file,'');}}
})().catch(e=>{console.error('TOOL_SMOKE_ERROR '+String(e.message).slice(0,220));process.exitCode=1;});
