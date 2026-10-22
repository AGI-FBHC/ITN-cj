/** 真实模型 + 随课导学：PPT 学习页右侧对话两次真实提问，验证作答与会话隔离。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root='D:/Desktop/ITN/ITN-Desktop',pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const credDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-cred-guided-')),cred=path.join(credDir,'cred.db');
 fs.copyFileSync(path.join(process.env.LOCALAPPDATA,'Lumin','itn.db'),cred);
 const db=new DatabaseSync(cred,{readOnly:true});
 const model=db.prepare("SELECT base_url,api_key,model FROM models WHERE id=?").get(process.env.REAL_SMOKE_MODEL_ID||'deepseek');
 db.close();
 if(!model?.api_key)throw new Error('no model key');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-guided-')),pf=path.join(dir,'port');
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),'--skills-dir='+path.join(root,'shell/skills'),'--seed-guided-fixture=1'],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
 let browser;
 try{
  for(let i=0;i<200&&!fs.existsSync(pf);i++)await pause(100);
  if(!fs.existsSync(pf))throw new Error('kernel did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(route,body={})=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const j=await r.json();if(j.code!==0)throw new Error(route+': '+j.message);return j.data;};
  await post('models/save',{id:'real-guided',name:'真实导学',baseUrl:model.base_url,apiKey:model.api_key,model:model.model});
  await post('models/roles',{chatModelId:'real-guided'});
  const resources=(await post('learning/resources',{kbId:'course-alpha'})).resources||[];
  const ppt=resources.find(r=>r.kind==='ppt');
  if(!ppt)throw new Error('seed guided fixture has no PPT resource');
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#/study/'+ppt.id+'@'+ppt.version);
  await page.waitForSelector('.sp-page',{timeout:30000});
  await page.waitForSelector('.sp-chat-input',{timeout:30000});
  const send=async text=>{
    await page.fill('.sp-chat-input',text);
    await page.locator('.sp-chat-send').click();
    await page.waitForFunction(()=>document.querySelector('.sp-chat-send')?.classList.contains('stop'),null,{timeout:20000}).catch(()=>{});
    await page.waitForFunction(()=>!document.querySelector('.sp-chat-send')?.classList.contains('stop'),null,{timeout:180000});
    await pause(700);
  };
  const sidA=await page.locator('.sp-chat-session').inputValue();
  await send('请用一句话说明这一页最关键的判断标准。');
  const first=await page.evaluate(()=>document.querySelector('.sp-chat-thread')?.innerText||'');
  await page.getByRole('button',{name:'新建会话',exact:true}).click();
  await pause(600);
  const sidB=await page.locator('.sp-chat-session').inputValue();
  await send('请用一句话告诉我这一页应该先观察什么。');
  const second=await page.evaluate(()=>document.querySelector('.sp-chat-thread')?.innerText||'');
  const bHasA=/最关键/.test(second);
  const sessionOptions=await page.evaluate(()=>({value:document.querySelector('.sp-chat-session')?.value||'',options:[...document.querySelectorAll('.sp-chat-session option')].map(o=>({v:o.value,t:o.textContent}))}));
  console.log('SESSIONS='+JSON.stringify(sessionOptions));
  if(sessionOptions.options.some(o=>o.v===sidA)){await page.selectOption('.sp-chat-session',sidA);}else{await page.evaluate(sid=>{const sel=document.querySelector('.sp-chat-session');if(sel){sel.value=sid;sel.dispatchEvent(new Event('change'));}},sidA);}
  await pause(800);
  const back=await page.evaluate(()=>({
    sid: document.querySelector('.sp-chat-session')?.value||'',
    text: document.querySelector('.sp-chat-thread')?.innerText||'',
    slide: !!document.querySelector('.sp-ppt-image, .sp-slide-fallback, .sp-ppt-frame'),
  }));
  console.log('MODEL='+model.model+' SID_A='+sidA+' SID_B='+sidB);
  console.log('FIRST_CHARS='+first.trim().length+' SECOND_CHARS='+second.trim().length+' B_HAS_A='+bHasA);
  console.log('BACK_SID_OK='+(back.sid===sidA)+' BACK_TEXT_CHARS='+back.text.trim().length+' SLIDE_VISIBLE='+back.slide+' ERRORS='+errors.length);
  const ok=first.trim().length>10&&second.trim().length>10&&!bHasA&&back.sid===sidA&&back.slide&&errors.length===0;
  console.log('RESULT='+(ok?'PASS':'FAIL'));
  process.exitCode=ok?0:1;
 }finally{
  if(browser)await browser.close();
  try{core.kill();}catch{}
  fs.writeFileSync(cred,'');
  try{fs.writeFileSync(path.join(dir,'itn.db'),'');}catch(e){}
 }
})().catch(e=>{console.error('GUIDED_SMOKE_ERROR '+String(e.message).slice(0,250));process.exitCode=1;});
