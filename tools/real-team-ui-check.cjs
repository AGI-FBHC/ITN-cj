/** 真实模型 + 协作树界面：模型自选 research_topic_team，右侧弹窗渲染树、点节点出详情。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root='D:/Desktop/ITN/ITN-Desktop',pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const credDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-cred-teamui-')),cred=path.join(credDir,'cred.db');
 fs.copyFileSync(path.join(process.env.LOCALAPPDATA,'Lumin','itn.db'),cred);
 const db=new DatabaseSync(cred,{readOnly:true});
 const model=db.prepare("SELECT base_url,api_key,model FROM models WHERE id=?").get(process.env.REAL_SMOKE_MODEL_ID||'deepseek');
 db.close();
 if(!model?.api_key)throw new Error('no model key');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-teamui-')),pf=path.join(dir,'port');
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),'--skills-dir='+path.join(root,'shell/skills')],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
 let browser;
 try{
  for(let i=0;i<200&&!fs.existsSync(pf);i++)await pause(100);
  if(!fs.existsSync(pf))throw new Error('kernel did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(route,body={})=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.code!==0)throw new Error(route+': '+j.message);return j.data;};
  await post('models/save',{id:'real-team-ui',name:'真实协作树',baseUrl:model.base_url,apiKey:model.api_key,model:model.model});
  await post('models/roles',{chatModelId:'real-team-ui'});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');await page.waitForFunction(()=>!document.getElementById('boot'));
  await page.evaluate(()=>newChat('','chat'));
  await page.waitForSelector('#chat-input');
  await page.fill('#chat-input','请研究并对比 MCP 与 A2A 的定位、机制和适用场景，用多智能体协作完成，给出结论。');
  await page.locator('.composer-send').click();
  let team=false;
  const end=Date.now()+150000;
  while(Date.now()<end){
    team=await page.evaluate(()=>(state?.chatEvents||[]).some(e=>String(e.type||'').startsWith('team/')));
    if(team)break;
    await pause(800);
  }
  if(!team){
    const diag=await page.evaluate(()=>({events:(state?.chatEvents||[]).map(e=>e.type).slice(-12),answered:(state?.chatTurns||[]).some(t=>(t.items||[]).some(i=>i.t==='a'&&i.text)),errors:[]}));
    console.log('RESULT=INCONCLUSIVE_MODEL_DID_NOT_USE_TEAM '+JSON.stringify(diag));
    process.exitCode=2;
    return;
  }
  await page.waitForSelector('#team-panel.open',{timeout:30000});
  await page.waitForSelector('.team-node',{timeout:30000});
  const mid=await page.evaluate(()=>({nodes:document.querySelectorAll('.team-node').length,title:document.getElementById('team-panel-title')?.textContent||''}));
  const runEnd=Date.now()+150000;
  while(Date.now()<runEnd){
    const done=await page.evaluate(()=>(state?.chatEvents||[]).some(e=>e.type==='team/run_completed'));
    if(done)break;
    await pause(800);
  }
  await pause(800);
  const live=await page.evaluate(()=>({nodes:document.querySelectorAll('.team-node').length,completed:document.querySelectorAll('.team-node.status-completed').length,paths:document.querySelectorAll('#team-tree-lines path').length}));
  await page.locator('.team-node:not(.selected)').first().click().catch(()=>{});
  await pause(400);
  const detail=(await page.locator('#team-detail').innerText()).trim();
  console.log('MODEL='+model.model+' TITLE='+mid.title);
  console.log('LIVE='+JSON.stringify(live)+' DETAIL_CHARS='+detail.length);
  console.log('PAGE_ERRORS='+errors.length);
  const ok=live.nodes>=3&&live.completed>=2&&live.paths>=1&&detail.length>20&&errors.length===0;
  console.log('RESULT='+(ok?'PASS':'FAIL'));
  process.exitCode=ok?0:1;
 }finally{
  if(browser)await browser.close();
  try{core.kill();}catch{}
  fs.writeFileSync(cred,'');
  try{fs.writeFileSync(path.join(dir,'itn.db'),'');}catch(e){}
 }
})().catch(e=>{console.error('TEAM_UI_SMOKE_ERROR '+String(e.message).slice(0,250));process.exitCode=1;});
