const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-session-switch-')),mp=await freePort(),pf=path.join(dir,'port');
 const mock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(mp)],{windowsHide:true,stdio:'ignore',env:{...process.env,ITN_MOCK_CHUNK_DELAY_MS:'0',ITN_MOCK_SLOW_MS:'10000'}});
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});
 let browser,passed=0;
 const check=(n,b)=>{if(!b)throw Error(n);passed++;console.log('PASS '+n);};
 const until=async(fn,ms=30000)=>{const t0=Date.now();for(;;){if(await fn())return;if(Date.now()-t0>ms)throw Error('等待条件超时');await sleep(150);}};
 try{
  for(let i=0;i<100&&!fs.existsSync(pf);i++)await sleep(100);
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const raw=async(u,b)=>{const r=await fetch(base+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json();};
  const post=async(u,b)=>{const j=await raw(u,b);if(j.code!==0)throw Error(u+': '+j.message);return j.data;};
  await post('/api/models/save',{id:'mock',name:'test',baseUrl:'http://127.0.0.1:'+mp+'/v1',apiKey:'test',model:'mock'});
  await post('/api/models/roles',{chatModelId:'mock'});

  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');
  const approvalSids=[];
  await page.route('**/api/agent/approvals',async route=>{approvalSids.push(route.request().postDataJSON()?.sessionId||'');await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{requests:[],pending:0}})});});

  const timeLabels=await page.evaluate(()=>{
    const now=new Date(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate(),9,5),yesterday=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1,9,5);
    const p=x=>String(x).padStart(2,'0');
    return {today:railMetaOf({kind:'ask',lastAt:today.toISOString()}),yesterday:railMetaOf({kind:'ask',lastAt:yesterday.toISOString()}),wantYesterday:p(yesterday.getMonth()+1)+'-'+p(yesterday.getDate())+' 09:05'};
  });
  check('today session time omits the date',timeLabels.today==='09:05');
  check('older session time includes its date',timeLabels.yesterday===timeLabels.wantYesterday);

  await page.setViewportSize({width:2200,height:1200});
  await sleep(120);
  const fullWidth=await page.evaluate(()=>{const c=document.querySelector('.composer').getBoundingClientRect(),v=document.querySelector('#view').getBoundingClientRect();return {width:c.width,left:c.left-v.left,right:v.right-c.right};});
  check('composer is capped on a maximized window',fullWidth.width<=921&&Math.abs(fullWidth.left-fullWidth.right)<=2);
  await page.setViewportSize({width:1440,height:960});

  // A 段开始一段慢任务（mock 每段模型请求睡 10 秒）
  await page.locator('#chat-input').fill('慢速任务测试：开始一段长任务');
  await page.locator('.composer-send').click();
  await page.waitForFunction(()=>state.busyTurn&&state.chatRequest&&state.chatRequest.sessionId===state.chatSessionId,null,{timeout:20000});
  const sidA=await page.evaluate(()=>state.chatSessionId);
  await until(async()=>approvalSids.includes(sidA),7000);
  check('normal chat approval polling is scoped to the active session',approvalSids.filter(Boolean).every(x=>x===sidA));
  check('the first session starts running',!!sidA);

  // A 还在跑：新建 B 段并立即提问 —— 以前这里会被当成“插话”并卡住
  await page.locator('#rail-new').click();
  await page.waitForSelector('.rail-menu-item');
  await page.locator('.rail-menu-item').filter({hasText:'常规聊天'}).click();
  await until(async()=>{const s=await page.evaluate(()=>state.chatSessionId);return s&&s!==sidA;},15000);
  const sidB=await page.evaluate(()=>state.chatSessionId);
  check('a new session opens while the other one keeps running',await page.evaluate(sid=>isSessionRunning(sid)&&state.busyTurn===false,sidA));
  check('the running session keeps its spinner even when not selected',await page.locator('#panel-body .panel-item[data-id="'+sidA+'"] .panel-item-spin').count()>=1);

  await page.locator('#chat-input').fill('B 会话的普通问题');
  await page.locator('.composer-send').click();
  await sleep(300);
  check('the new session sends a normal turn instead of steering',await page.evaluate(()=>!document.querySelector('#chat-thread .msg-flag')&&state.chatTurns.some(t=>t.user==='B 会话的普通问题'&&!t.steer)));
  await until(async()=>await page.locator('#panel-body .rail-session .panel-item[data-id="'+sidB+'"]').count()===1,10000);
  const orderAfterB=await page.evaluate(()=>[...document.querySelectorAll('#panel-body .rail-session .panel-item')].map(x=>x.dataset.id).filter(Boolean));
  const orderDebug=await page.evaluate(()=>({sessions:(state.sessions||[]).map(x=>({id:x.sessionId,at:x.lastAt,title:x.title})),running:[...state.chatRequests.keys()],active:state.chatSessionId}));
  console.log('ORDER_DEBUG '+JSON.stringify({sidA,sidB,orderAfterB,orderDebug}));
  check('a newly updated conversation moves to the first row',orderAfterB.indexOf(sidB)>=0&&orderAfterB.indexOf(sidA)>=0&&orderAfterB.indexOf(sidB)<orderAfterB.indexOf(sidA));

  // 立刻切回 A 并插话：保证插话落在 A 第一段模型请求的等待窗内（慢速 mock 每段睡 10 秒）
  await page.evaluate(id=>openChatSession(id),sidA);
  check('switching back shows the running session as busy',await page.evaluate(()=>state.busyTurn===true));
  await page.locator('#chat-input').fill('插话测试：补充一句');
  await page.locator('#chat-input').press('Enter');
  await page.waitForFunction(()=>!!document.querySelector('#chat-thread .msg-flag'),null,{timeout:10000});
  check('steering into the running turn still works',(await page.locator('#chat-thread .msg-flag').first().innerText()).includes('插话'));
  await until(async()=>{const order=await page.evaluate(()=>[...document.querySelectorAll('#panel-body .rail-session .panel-item')].map(x=>x.dataset.id).filter(Boolean));return order.indexOf(sidA)>=0&&order.indexOf(sidA)<order.indexOf(sidB);},10000);
  check('steering updates the conversation order too',true);

  // B 在后台照常跑完（A 还在跑）
  await until(async()=>{const d=await post('/api/sessions/events',{sessionId:sidB});return (d.events||[]).some(e=>e.type==='turn/end'&&(e.payload||{}).ok!==false);},40000);
  const evB=await post('/api/sessions/events',{sessionId:sidB});
  check('the new session answers normally while the first one keeps running',JSON.stringify(evB.events||[]).includes('MOCK_REPLY')&&await page.evaluate(sid=>isSessionRunning(sid),sidA));
  check('nothing leaked into the new session',!JSON.stringify(evB.events||[]).includes('插话测试'));

  // A 跑完：插话被这一轮消费，而不是被丢掉或留到下一轮
  await page.waitForFunction(()=>!state.busyTurn,null,{timeout:90000});
  await until(async()=>(await page.locator('#chat-thread').innerText()).includes('收到插话'),20000);
  check('the running turn finishes with the injected steering',true);
  const evA=await post('/api/sessions/events',{sessionId:sidA});
  check('the injected steering reaches the next model request',(evA.events||[]).some(e=>e.type==='model/request'&&JSON.stringify(e.payload||{}).includes('插话测试')));
  check('steering an idle session is rejected instead of queued',(await raw('/api/agent/steer',{sessionId:sidB,text:'x'})).code!==0);
  check('no JavaScript exceptions',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; data: '+dir);
 }finally{if(browser)await browser.close();core.kill();mock.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
