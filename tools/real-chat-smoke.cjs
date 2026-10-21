/** 真实模型单次 smoke：TEMP 只读副本取本机模型配置（默认 deepseek），经仓颉内核一问一答，结束清零凭据副本。
 * 不打印密钥；REAL_SMOKE_MODEL_ID 可覆盖模型 id。 */
/** 单次真实模型 smoke：从 TEMP 只读副本取 DeepSeek 配置，经仓颉内核跑一问一答，结束清零凭据副本。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const root='D:/Desktop/ITN/ITN-Desktop';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const credDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-cred-'));
 const cred=path.join(credDir,'cred.db');
 fs.copyFileSync(path.join(process.env.LOCALAPPDATA,'Lumin','itn.db'),cred);
 let model;
 try{
   const db=new DatabaseSync(cred,{readOnly:true});
   model=db.prepare("SELECT base_url,api_key,model FROM models WHERE id=?").get(process.env.REAL_SMOKE_MODEL_ID||'deepseek');
   db.close();
 }catch(e){throw new Error('读取凭据副本失败：'+e.message);}
 if(!model?.api_key)throw new Error('副本里没有可用的 deepseek 配置');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-deepseek-'));
 const pf=path.join(dir,'port');
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
 try{
   for(let i=0;i<200&&!fs.existsSync(pf);i++)await pause(100);
   if(!fs.existsSync(pf))throw new Error('内核未启动');
   const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
   const post=async(route,body={})=>{
     const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
     const j=await r.json(); if(j.code!==0)throw new Error(route+': '+j.message); return j.data;
   };
   await post('models/save',{id:'real-smoke',name:'真实单次验收',baseUrl:model.base_url,apiKey:model.api_key,model:model.model});
   await post('models/roles',{chatModelId:'real-smoke'});
   const sid=(await post('sessions/new',{})).sessionId;
   const ask=post('agent/ask-pi',{kbId:'',question:'请用一个具体例子，一句话说明函数返回值是什么。不要调用工具。',sessionId:sid,web:'auto',mode:'chat',skill:'',perm:'auto'});
   let events=[];
   const result=await ask;
   for(let i=0;i<600;i++){
     events=(await post('sessions/events',{sessionId:sid})).events||[];
     if(events.some(e=>e.type==='turn/end'))break;
     await pause(200);
   }
   const end=events.find(e=>e.type==='turn/end');
   const answer=events.filter(e=>e.type==='assistant/message').map(e=>e.payload?.text||'').join('\n').trim();
   const failed=events.find(e=>e.type==='model/response'&&e.payload?.failed);
   console.log('MODEL='+model.model);
   console.log('ASK_OK='+(result.ok===true));
   console.log('TURN_OK='+(end?.payload?.ok===true));
   if(failed)console.log('MODEL_FAILED='+JSON.stringify(failed.payload).slice(0,200));
   if(end?.payload?.message)console.log('TURN_MESSAGE='+String(end.payload.message).slice(0,200));
   console.log('ANSWER_CHARS='+answer.length);
   console.log('ANSWER_HEAD='+answer.replace(/\s+/g,' ').slice(0,80));
   process.exitCode=(result.ok===true&&end?.payload?.ok===true&&answer.length>0)?0:1;
 }finally{
   try{core.kill();}catch{}
   fs.writeFileSync(cred,'');
 }
})().catch(e=>{console.error('SMOKE_ERROR '+String(e.message).slice(0,200));process.exitCode=1;});
