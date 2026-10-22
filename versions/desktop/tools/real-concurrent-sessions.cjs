/** 真实模型并发会话：A 长回答进行中新建 B 提问，验证 A 继续、B 正常、两边事件不串。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root='D:/Desktop/ITN/ITN-Desktop',pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const credDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-cred-conc-')),cred=path.join(credDir,'cred.db');
 fs.copyFileSync(path.join(process.env.LOCALAPPDATA,'Lumin','itn.db'),cred);
 const db=new DatabaseSync(cred,{readOnly:true});
 const model=db.prepare("SELECT base_url,api_key,model FROM models WHERE id=?").get(process.env.REAL_SMOKE_MODEL_ID||'deepseek');
 db.close();
 if(!model?.api_key)throw new Error('no model key');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-conc-')),pf=path.join(dir,'port');
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
 let browser;
 try{
  for(let i=0;i<200&&!fs.existsSync(pf);i++)await pause(100);
  if(!fs.existsSync(pf))throw new Error('kernel did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(route,body={})=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.code!==0)throw new Error(route+': '+j.message);return j.data;};
  await post('models/save',{id:'real-conc',name:'真实并发',baseUrl:model.base_url,apiKey:model.api_key,model:model.model});
  await post('models/roles',{chatModelId:'real-conc'});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');await page.waitForFunction(()=>!document.getElementById('boot'));
  const send=async text=>{await page.fill('#chat-input',text);await page.locator('.composer-send').click();};
  // A：要求较长输出，确保 B 提问时 A 仍在运行
  await send('请写一段约 300 字、分三点的说明：什么是函数式编程。不要调用工具。');
  await page.waitForFunction(()=>state.busyTurn===true,null,{timeout:20000});
  const sidA=await page.evaluate(()=>state.chatSessionId);
  const runningWhileNew=p=>page.evaluate(s=>state.chatRequests.has(s),p);
  // B：A 还在跑时新建会话
  await page.evaluate(()=>newChat('','chat'));
  await page.waitForFunction(sid=>state.chatSessionId!==sid,sidA,{timeout:20000});
  const sidB=await page.evaluate(()=>state.chatSessionId);
  const aStillRunning=await page.evaluate(s=>state.chatRequests.has(s),sidA);
  await send('请用一句话说明循环的作用。不要调用工具。');
  await page.waitForFunction(()=>state.busyTurn===false,null,{timeout:180000});
  await pause(800);
  const bEvents=(await post('sessions/events',{sessionId:sidB})).events||[];
  const bAnswer=bEvents.filter(e=>e.type==='assistant/message').map(e=>e.payload?.text||'').join('\n');
  const bHasA=/函数式编程/.test(bAnswer);
  // 回到 A，等它收尾
  await page.locator('#panel-body .panel-item[data-id="'+sidA+'"]').click();
  const endA=Date.now()+180000;
  let aEvents=[];
  while(Date.now()<endA){aEvents=(await post('sessions/events',{sessionId:sidA})).events||[];if(aEvents.some(e=>e.type==='turn/end'))break;await pause(400);}
  const aAnswer=aEvents.filter(e=>e.type==='assistant/message').map(e=>e.payload?.text||'').join('\n');
  const aEnd=aEvents.find(e=>e.type==='turn/end');
  const aHasB=/循环/.test(aAnswer);
  await pause(600);
  const back=await page.evaluate(()=>({open:state.chatSessionId,highlighted:document.querySelector('#panel-body .panel-item.active')?.dataset.id||''}));
  const bStayedOnB=await page.evaluate(s=>state.chatSessionId===s,sidB);
  const result={model:model.model,sidA,sidB,aStillRunning,bStayedOnB,aChars:aAnswer.length,bChars:bAnswer.length,
    aTurnOk:aEnd?.payload?.ok===true,aHasB,bHasA,backOpen:back.open===sidA,backHighlight:back.highlighted===sidA,errors:errors.length};
  console.log(JSON.stringify(result,null,1));
  const ok=aStillRunning&&!bHasA&&!/函数式编程/.test(JSON.stringify(bEvents))&&aEnd?.payload?.ok===true&&aAnswer.length>80&&bAnswer.length>0&&!aHasB&&back.open===sidA&&back.highlighted===sidA&&errors.length===0;
  console.log('RESULT='+(ok?'PASS':'FAIL'));
  process.exitCode=ok?0:1;
 }finally{
  if(browser)await browser.close();
  try{core.kill();}catch{}
  fs.writeFileSync(cred,'');
  try{fs.writeFileSync(path.join(dir,'itn.db'),'');}catch(e){}
 }
})().catch(e=>{console.error('CONC_SMOKE_ERROR '+String(e.message).slice(0,250));process.exitCode=1;});
