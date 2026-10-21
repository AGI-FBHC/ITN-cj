/** 真实模型 + 会话栏：两次短问，验证 A/B 切换后正文与高亮都不串；凭据只从 TEMP 副本读取并清零。 */
/** 真实模型 + 会话栏：两次短问，验证 A/B 切换后正文与高亮都不串。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root='D:/Desktop/ITN/ITN-Desktop';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const credDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-cred-ui-'));
 const cred=path.join(credDir,'cred.db');
 fs.copyFileSync(path.join(process.env.LOCALAPPDATA,'Lumin','itn.db'),cred);
 const db=new DatabaseSync(cred,{readOnly:true});
 const model=db.prepare("SELECT base_url,api_key,model FROM models WHERE id=?").get('deepseek');
 db.close();
 if(!model?.api_key)throw new Error('no deepseek key in copy');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-ui-')),pf=path.join(dir,'port');
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
 let browser;
 try{
  for(let i=0;i<200&&!fs.existsSync(pf);i++)await pause(100);
  if(!fs.existsSync(pf))throw new Error('kernel did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(route,body={})=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.code!==0)throw new Error(route+': '+j.message);return j.data;};
  await post('models/save',{id:'real-ui',name:'真实会话验收',baseUrl:model.base_url,apiKey:model.api_key,model:model.model});
  await post('models/roles',{chatModelId:'real-ui'});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');await page.waitForFunction(()=>!document.getElementById('boot'));
  const ask=async(text)=>{
    await page.fill('#chat-input',text);
    await page.locator('.composer-send').click();
    await page.waitForFunction(()=>state.busyTurn===true,null,{timeout:15000}).catch(()=>{});
    await page.waitForFunction(()=>state.busyTurn===false,null,{timeout:180000});
    await pause(600);
    return page.evaluate(()=>state.chatTurns.map(t=>(t.items||[]).filter(i=>i.t==='a').map(i=>i.text).join('\n')).join('\n'));
  };
  console.log('STEP booted sid='+await page.evaluate(()=>state.chatSessionId));
  const a1=await ask('请用一句话说明变量在程序里的作用，不调用工具。');
  const sidA=await page.evaluate(()=>state.chatSessionId);
  console.log('STEP answerA sid='+sidA+' chars='+a1.length);
  await page.evaluate(()=>newChat('','chat'));
  console.log('STEP newChat called sid='+await page.evaluate(()=>state.chatSessionId));
  try{await page.waitForFunction(sid=>state.chatSessionId!==sid,sidA,{timeout:20000});}catch(e){console.log('STEP newChat state='+JSON.stringify(await page.evaluate(()=>({sid:state.chatSessionId,busy:state.busyTurn,cur:current,hash:location.hash}))));throw e;}
  const a2=await ask('请用一句话说明循环在程序里的作用，不调用工具。');
  const sidB=await page.evaluate(()=>state.chatSessionId);
  await page.locator('#panel-body .panel-item[data-id="'+sidA+'"]').click();
  await page.waitForFunction(sid=>state.chatSessionId===sid,sidA,{timeout:15000});
  await pause(800);
  const back=await page.evaluate(()=>({open:state.chatSessionId,highlighted:document.querySelector('#panel-body .panel-item.active')?.dataset.id||'',text:document.getElementById('chat-thread')?.innerText||''}));
  console.log('MODEL='+model.model);
  console.log('A_CHARS='+a1.length+' B_CHARS='+a2.length+' A_HAS_VAR='+/变量/.test(a1)+' B_HAS_LOOP='+/循环/.test(a2));
  console.log('SWITCH_OPEN='+(back.open===sidA)+' HIGHLIGHT='+(back.highlighted===sidA)+' A_TEXT_BACK='+/变量/.test(back.text)+' NO_B_BLEED='+!/循环/.test(back.text));
  console.log('PAGE_ERRORS='+errors.length);
  process.exitCode=(/变量/.test(a1)&&/循环/.test(a2)&&back.open===sidA&&back.highlighted===sidA&&/变量/.test(back.text)&&!/循环/.test(back.text)&&errors.length===0)?0:1;
 }finally{
  if(browser)await browser.close();
  try{core.kill();}catch{}
  fs.writeFileSync(cred,'');
 }
})().catch(e=>{console.error('UI_SMOKE_ERROR '+String(e.message).slice(0,300));console.error(String(e.stack||'').split('\n').slice(0,6).join('\n'));process.exitCode=1;});
