/** Real model calls in a clean database. Reads only one model credential from a supplied local test DB. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const credentialDb=process.env.LUMIN_TEST_CREDENTIAL_DB;if(!credentialDb)throw Error('Set LUMIN_TEST_CREDENTIAL_DB to a local disposable credential database.');
 const source=new DatabaseSync(credentialDb,{readOnly:true});
 const model=source.prepare("SELECT base_url,api_key,model FROM models WHERE id=?").get(process.env.LUMIN_TEST_MODEL_ID||'mimo');source.close();
 if(!model?.api_key)throw Error('Test model credential unavailable');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-memory-')),pf=path.join(dir,'port');let core,base,passed=0;
 const check=(n,ok)=>{if(!ok)throw Error(n);passed++;console.log('PASS '+n);};
 const post=async(name,body={})=>{const r=await(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(150000)})).json();if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
 const ask=async(question)=>{const sid=(await post('sessions/new')).sessionId;const start=Date.now();const r=await post('agent/ask-pi',{sessionId:sid,question,web:'off'});if(!r.ok)throw Error(r.message||'Agent failed');const events=(await post('sessions/events',{sessionId:sid})).events;console.log('MODEL '+model.model+' elapsedMs='+(Date.now()-start));return {r,events};};
 try{
  core=spawn(path.join(root,'core/target/release/bin/main.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});
  for(let i=0;i<150&&!fs.existsSync(pf);i++)await sleep(100);if(!fs.existsSync(pf))throw Error('kernel startup timeout');
  base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  await post('models/save',{id:'real-test',name:'真实模型测试',baseUrl:model.base_url,apiKey:model.api_key,model:model.model});
  await post('models/roles',{chatModelId:'real-test'});
  const remember=await ask('请分别记住两条通用学习信息：学习偏好是“我喜欢用图书馆借书来类比编程概念”；学习状态是“我刚学会函数，还没学类”。这两条适用于全部学习场景。简短确认即可。');
  const memories=(await post('learning/memories')).memories;
  check('real model actually calls the memory tool',remember.events.some(e=>e.type==='tool/call'&&e.payload.tool==='remember_learning_fact'));
  check('real tool saves preference and self-reported state with sources',memories.some(m=>m.kind==='preference'&&m.text.includes('图书馆借书')&&m.quote&&m.sessionId)&&memories.some(m=>m.kind==='status'&&m.text.includes('还没学类')&&m.kbId===''));
  const personalized=await ask('用四句话给我解释函数。请参考我已保存的学习偏好选择例子，并照顾我的当前学习阶段。');
  check('a new session uses the saved example without being told its content',/图书馆|借书/.test(personalized.r.answer));
  fs.writeFileSync(path.join(dir,'personalized-answer.txt'),personalized.r.answer);
  const forgetting=await ask('请忘记我所有关于讲解例子、图书馆借书的学习偏好，保留我的学习状态。');
  check('real model actually calls the forget tool',forgetting.events.some(e=>e.type==='tool/call'&&e.payload.tool==='forget_learning_fact'));
  check('forgetting removes the preference while keeping learning state',!(await post('learning/memories')).memories.some(m=>m.kind==='preference'&&m.text.includes('图书馆'))&&(await post('learning/memories')).memories.some(m=>m.kind==='status'));
  const after=await ask('我保存过的讲解例子偏好是什么？只根据当前学习记忆回答，没有记录就说“未记录”。');
  check('another new session does not recover the forgotten preference',!(/图书馆|借书/.test(after.r.answer))&&/未记录|没有|未保存|暂无/.test(after.r.answer));
  const verify=new DatabaseSync(path.join(dir,'itn.db'),{readOnly:true});
  const integrity=verify.prepare('PRAGMA integrity_check').all();verify.close();
  check('repeated real conversations leave the SQLite file structurally valid',integrity.length===1&&Object.values(integrity[0])[0]==='ok');
  console.log('RESULT=OK '+passed+' real checks; data='+dir);
 }finally{if(core&&!core.killed)core.kill();}
})().catch(e=>{console.error('FAIL '+e.message);process.exitCode=1;});
