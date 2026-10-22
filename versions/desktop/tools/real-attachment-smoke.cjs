/** 真实模型 + 附件读取批准：要求模型用 read 读取附件里的校验码，批准后核对结果。凭据只从 TEMP 副本读取并清零。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const root='D:/Desktop/ITN/ITN-Desktop',pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const credDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-cred-attach-')),cred=path.join(credDir,'cred.db');
 fs.copyFileSync(path.join(process.env.LOCALAPPDATA,'Lumin','itn.db'),cred);
 const db=new DatabaseSync(cred,{readOnly:true});
 const model=db.prepare("SELECT base_url,api_key,model FROM models WHERE id=?").get(process.env.REAL_SMOKE_MODEL_ID||'deepseek');
 db.close();
 if(!model?.api_key)throw new Error('no model key');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-attach-')),pf=path.join(dir,'port');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-attach-files-'));
 const marker='LUMIN-ATTACH-7K3P',file=path.join(work,'note.md');
 fs.writeFileSync(file,'# 小抄\n\n校验码：'+marker+'\n\n下一步练习：给函数补一个边界用例。\n');
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
 try{
  for(let i=0;i<200&&!fs.existsSync(pf);i++)await pause(100);
  if(!fs.existsSync(pf))throw new Error('kernel did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(route,body={})=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});const j=await r.json();if(j.code!==0)throw new Error(route+': '+j.message);return j.data;};
  await post('models/save',{id:'real-attach',name:'真实附件验收',baseUrl:model.base_url,apiKey:model.api_key,model:model.model});
  await post('models/roles',{chatModelId:'real-attach'});
  await post('prefs/save',{agentWorkDir:work,agentPerm:'ask',agentExec:'0'});
  const sid=(await post('sessions/new',{})).sessionId;
  const ask=post('agent/ask-pi',{kbId:'',question:'请使用 read 工具读取附件 note.md，只读这个文件，把其中的校验码原样告诉我，再用一句话提醒下一步练什么。不要扫描其他文件。',sessionId:sid,web:'auto',mode:'work',skill:'',perm:'ask',confirmFileAccess:true,attachments:[{kind:'file',name:'note.md',path:file}]});
  let approved=false, notice='';
  const end0=Date.now()+90000;
  while(Date.now()<end0){
    const reqs=(await post('agent/approvals',{sessionId:sid})).requests||[];
    const pending=reqs.filter(r=>!r.decision&&r.tool==='read');
    if(pending.length){await post('agent/approvals/answer',{id:pending[0].id,decision:'once'});approved=true;break;}
    const evs=(await post('sessions/events',{sessionId:sid})).events||[];
    if(evs.some(e=>e.type==='turn/end')){notice='turn ended before approval';break;}
    await pause(300);
  }
  await ask.catch(()=>{});
  let events=[];
  for(let i=0;i<900;i++){events=(await post('sessions/events',{sessionId:sid})).events||[];if(events.some(e=>e.type==='turn/end'))break;await pause(200);}
  const end=events.find(e=>e.type==='turn/end');
  const reads=events.filter(e=>e.type==='tool/result'&&e.payload?.tool==='read').map(e=>({ok:e.payload?.ok,summary:String(e.payload?.summary||'').slice(0,60)}));
  const answer=events.filter(e=>e.type==='assistant/message').map(e=>e.payload?.text||'').join('\n').trim();
  console.log('MODEL='+model.model+' APPROVED='+approved+' TURN_OK='+(end?.payload?.ok===true));
  console.log('READ_RESULTS='+JSON.stringify(reads));
  console.log('MARKER_IN_ANSWER='+answer.includes(marker)+' ANSWER_CHARS='+answer.length);
  if(notice)console.log('NOTICE='+notice);
  if(end?.payload?.message)console.log('TURN_MESSAGE='+String(end.payload.message).slice(0,200));
  const productOk=approved&&end?.payload?.ok===true&&reads.some(r=>r.ok===true)&&answer.includes(marker);
  console.log('RESULT='+(productOk?'PASS':(approved?'FAIL':'INCONCLUSIVE_MODEL_DID_NOT_ASK_READ')));
  process.exitCode=productOk?0:(approved?1:2);
 }finally{try{core.kill();}catch{}fs.writeFileSync(cred,'');}
})().catch(e=>{console.error('ATTACH_SMOKE_ERROR '+String(e.message).slice(0,220));process.exitCode=1;});
