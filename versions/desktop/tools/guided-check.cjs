/** PPT 演示 + 普通会话侧栏端到端检查：真实仓颉内核、SQLite、HTTP 与 Edge。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-guided-')),pf=path.join(dir,'port');
  const shots=path.join(root,'tmp/guided-shots');fs.mkdirSync(shots,{recursive:true});
  let core=null,browser=null,page=null,base='',passed=0;const pageErrors=[],serverErrors=[];
  const start=seed=>{
    try{fs.unlinkSync(pf)}catch{}
    core=spawn(process.env.GUIDED_CORE_EXE||path.join(root,'dist/core/itn-desktop-core.exe'),[
      '--data-dir='+dir,'--port-file='+pf,'--ui-dir='+(process.env.GUIDED_UI_DIR||path.join(root,'shell/renderer')),
      ...(seed?['--seed-guided-fixture=1']:[])
    ],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    core.stderr.on('data',s=>serverErrors.push(s.toString()));
  };
  const until=async(fn,ms=30000,label='condition')=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error(label+' timed out');};
  const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
  const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
  try{
    start(true);await until(()=>fs.existsSync(pf),15000,'core port');base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
    const resources=(await post('learning/resources',{kbId:'course-alpha'})).resources;
    const ppt=resources.find(x=>x.kind==='ppt');check('guided fixture exposes a confirmed PPT resource',!!ppt&&ppt.version>0);

    const first=await post('guided/session/resolve',{resourceId:ppt.id,version:ppt.version});
    check('first resolve creates a guided session',first.created===true&&!!first.sessionId);
    const second=await post('guided/session/resolve',{resourceId:ppt.id,version:ppt.version});
    check('same resource version restores its selected session',second.created===false&&second.sessionId===first.sessionId&&second.context.currentSlide===1);

    const normalList=await post('sessions/list');
    const listed=normalList.sessions.find(s=>s.sessionId===first.sessionId);
    check('guided session appears in the normal session list',!!listed);
    check('normal session list carries the resource tag',listed?.resource?.resourceId===ppt.id&&Number(listed?.resource?.resourceVersion)===ppt.version);

    const extra=await post('guided/session/new',{resourceId:ppt.id,version:ppt.version,slide:3});
    check('a PPT can create another guided session',extra.sessionId!==first.sessionId&&extra.slide===3);
    const guidedList=await post('guided/sessions',{resourceId:ppt.id,version:ppt.version});
    check('guided session list returns both resource-bound sessions',guidedList.sessions.length===2&&guidedList.sessions.some(s=>s.sessionId===first.sessionId)&&guidedList.sessions.some(s=>s.sessionId===extra.sessionId));
    await post('guided/session/select',{resourceId:ppt.id,version:ppt.version,sessionId:first.sessionId});
    const selectedFirst=await post('guided/session/resolve',{resourceId:ppt.id,version:ppt.version});
    check('explicit session selection survives resolve',selectedFirst.sessionId===first.sessionId&&selectedFirst.slide===1);

    browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1500,height:1000}});
    page.on('pageerror',e=>pageErrors.push(e.message));
    let delayedResolve=true;
    const resolveDelay=async route=>{if(delayedResolve)await sleep(450);await route.continue();};
    await page.route('**/api/guided/session/resolve',resolveDelay);
    await page.goto(base);await page.waitForSelector('#chat-input');await page.waitForFunction(()=>!document.getElementById('boot'));
    await page.evaluate(a=>go('study',a.id+'@'+a.version),ppt);
    await page.waitForSelector('.sp-study-layout');await page.waitForSelector('.sp-stage-pos');

    // 初始化被故意延迟；用户先翻页不能被旧响应拉回第一页。
    await page.keyboard.press('ArrowRight');
    await until(async()=>(await page.locator('.sp-stage-pos').innerText()).includes('2 /'),5000,'page 2');
    await sleep(700);
    check('early navigation wins over delayed guided initialization',(await page.locator('.sp-stage-pos').innerText()).includes('2 /'));
    delayedResolve=false;await page.unroute('**/api/guided/session/resolve',resolveDelay);
    await page.waitForSelector('.sp-study-chat');
    await until(async()=>await page.locator('.sp-chat-session').inputValue()===first.sessionId,5000,'initial session select');

    const shell=await page.evaluate(()=>{
      const deck=document.querySelector('.sp-study-deck').getBoundingClientRect();
      const chat=document.querySelector('.sp-study-chat').getBoundingClientRect();
      const view=document.getElementById('view');
      const titlebar=document.getElementById('titlebar');
      return {
        deck:{top:deck.top,bottom:deck.bottom,width:deck.width},chat:{top:chat.top,bottom:chat.bottom,width:chat.width},
        topbar:getComputedStyle(document.querySelector('.main > .topbar')).display,
        panel:getComputedStyle(document.getElementById('panel')).display,
        titlebar:getComputedStyle(titlebar).display,
        scrollWidth:view.scrollWidth,clientWidth:view.clientWidth,
        bodyOverflow:getComputedStyle(document.body).overflow
      };
    });
    check('study workspace uses the full area under the unchanged titlebar',shell.topbar==='none'&&shell.panel==='none'&&shell.titlebar!=='none');
    check('PPT and chat columns have equal height',Math.abs(shell.deck.top-shell.chat.top)<=1&&Math.abs(shell.deck.bottom-shell.chat.bottom)<=2);
    check('desktop chat is a practical side column',shell.chat.width>=330&&shell.chat.width<=400);
    check('study layout introduces no horizontal page scrollbar',shell.scrollWidth<=shell.clientWidth+1&&shell.bodyOverflow!=='auto');

    await page.keyboard.press('ArrowRight');
    await until(async()=>{const c=await post('guided/context',{sessionId:first.sessionId});return c.currentSlide===3&&c.visitedSlides.includes(3);},5000,'focus page 3');
    check('page navigation updates the server-owned guided focus',(await page.locator('.sp-stage-pos').innerText()).includes('3 /'));

    const noteButton=page.getByRole('button',{name:'记笔记',exact:true});
    check('note control is a pencil icon button',await noteButton.getAttribute('title')==='记笔记'&&await noteButton.locator('svg').count()===1);
    await noteButton.click();await page.waitForSelector('.sp-note-form');
    check('note dialog carries the current page source',(await page.locator('.sp-note-source').innerText()).trim().length>6);
    await page.fill('.sp-note-textarea','我会先写明输入与预期，再保留真实输出逐项核对。');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    await until(async()=>await page.locator('.course-modal-overlay').count()===0,5000,'note dialog close');
    const notes=(await post('study/notes/list')).notes;
    const savedNote=notes.find(n=>n.text.includes('逐项核对'));
    check('saved note links resource, version and current page',!!savedNote&&savedNote.resourceId===ppt.id&&savedNote.resourceVersion===ppt.version&&savedNote.page===3);
    check('saved note is shown in the current conversation',await page.locator('.sp-chat-note').count()===1);

    await page.fill('.sp-chat-input','请解释这一页最关键的判断。');await page.locator('.sp-chat-send').click();
    await until(async()=>await page.locator('.sp-chat-msg.assistant').filter({hasText:'真实输出要能被观察和复核'}).count()>0,30000,'guided assistant reply');
    check('guided question reaches the contextual Agent and renders a reply',await page.locator('.sp-chat-msg.user').filter({hasText:'最关键的判断'}).count()===1);
    const events=await post('sessions/events',{sessionId:first.sessionId});
    check('guided chat uses the same normal session event stream',events.events.some(e=>e.type==='user/message')&&events.events.some(e=>e.type==='assistant/message'));

    // 关键并发路径：第一条会话回复未结束时新建并切换到另一条，后台回复必须继续完成。
    let delayedAsk=true;
    await page.route('**/api/agent/ask-pi',async route=>{if(delayedAsk){delayedAsk=false;await sleep(1200);}await route.continue();});
    const assistantsBefore=(await post('sessions/events',{sessionId:first.sessionId})).events.filter(e=>e.type==='assistant/message').length;
    await page.fill('.sp-chat-input','切换会话时请保留这一轮的回复。');await page.locator('.sp-chat-send').click();
    await until(async()=>await page.locator('.sp-chat-msg.user').filter({hasText:'切换会话时'}).count()===1,3000,'parallel question visible');
    await page.getByRole('button',{name:'新建会话',exact:true}).click();
    await until(async()=>await page.locator('.sp-chat-session').inputValue()!==first.sessionId,5000,'new guided session selected');
    const thirdSid=await page.locator('.sp-chat-session').inputValue();
    check('creating a session while another reply is running switches immediately',thirdSid!==first.sessionId&&!!thirdSid);
    await sleep(1300);
    await page.selectOption('.sp-chat-session',first.sessionId);
    await until(async()=>await page.locator('.sp-chat-msg.user').filter({hasText:'切换会话时'}).count()===1,3000,'first session restored');
    await until(async()=>!await page.locator('.sp-chat-send').evaluate(e=>e.classList.contains('stop')),15000,'background reply completes');
    const assistantsAfter=(await post('sessions/events',{sessionId:first.sessionId})).events.filter(e=>e.type==='assistant/message').length;
    check('switching sessions does not abort the background Agent reply',assistantsAfter>assistantsBefore);
    await until(async()=>await page.locator('.sp-chat-msg.assistant').count()>=2,5000,'finished background reply visible');
    check('switching back shows the background reply in its original session',await page.locator('.sp-chat-msg.assistant').count()>=2);
    await page.selectOption('.sp-chat-session',thirdSid);
    await until(async()=>await page.locator('.sp-chat-session').inputValue()===thirdSid,3000,'third session selected');
    await until(async()=>await page.locator('.sp-chat-msg.user').count()===0,3000,'third session empty panel painted');
    check('new session has its own empty conversation',await page.locator('.sp-chat-msg.user').filter({hasText:'切换会话时'}).count()===0);
    await page.selectOption('.sp-chat-session',first.sessionId);
    await until(async()=>await page.locator('.sp-chat-session').inputValue()===first.sessionId,3000,'first session selected again');
    await until(async()=>await page.locator('.sp-chat-msg.user').filter({hasText:'切换会话时'}).count()===1,3000,'first session history painted');
    check('switching back restores the finished conversation',await page.locator('.sp-chat-msg.user').filter({hasText:'切换会话时'}).count()===1);

    const lightBg=await page.locator('.sp-study-chat').evaluate(e=>getComputedStyle(e).backgroundColor);
    await page.screenshot({path:path.join(shots,'guided-desktop-light.png')});
    await page.emulateMedia({colorScheme:'dark'});await sleep(160);
    const darkBg=await page.locator('.sp-study-chat').evaluate(e=>getComputedStyle(e).backgroundColor);
    check('conversation surface follows the app theme',darkBg!==lightBg&&darkBg!=='rgba(0, 0, 0, 0)');
    await page.screenshot({path:path.join(shots,'guided-desktop-dark.png')});
    await page.emulateMedia({colorScheme:'light'});

    await page.setViewportSize({width:900,height:1000});await sleep(300);
    check('narrow layout starts with the conversation drawer closed',!await page.locator('.sp-study-chat').isVisible());
    await page.getByRole('button',{name:'打开对话',exact:true}).click();
    await until(async()=>await page.locator('.sp-study-chat').isVisible(),3000,'narrow chat drawer');
    check('narrow conversation drawer has a dismiss scrim',!(await page.locator('.sp-chat-scrim').evaluate(e=>e.hidden)));
    const drawer=await page.locator('.sp-study-chat').evaluate(e=>{const r=e.getBoundingClientRect(),v=document.getElementById('view').getBoundingClientRect();return{width:r.width,right:r.right,viewRight:v.right};});
    check('narrow conversation drawer stays inside the study view',drawer.width<=430&&drawer.right<=drawer.viewRight+1);
    await page.screenshot({path:path.join(shots,'guided-narrow.png')});
    await page.locator('.sp-chat-scrim').click({position:{x:20,y:200}});await sleep(150);

    await page.setViewportSize({width:1500,height:1000});
    await page.selectOption('.sp-chat-session',thirdSid);
    await until(async()=>await page.locator('.sp-chat-session').inputValue()===thirdSid,3000,'persist selected third session');
    await page.reload({waitUntil:'load'});await page.waitForSelector('.sp-study-layout');await page.waitForSelector('.sp-stage-pos');
    await until(async()=>await page.locator('.sp-chat-session').inputValue()===thirdSid,8000,'restore selected session after reload');
    check('reload restores the selected guided session',(await page.locator('.sp-stage-pos').innerText()).includes('3 /'));

    let guidedEventsAfterLeave=0;page.on('request',r=>{if(r.url().includes('/api/sessions/events'))guidedEventsAfterLeave+=1;});
    await page.evaluate(()=>go('learn'));await page.waitForSelector('.course-workspace');await sleep(900);
    check('leaving the guide stops its event pollers',guidedEventsAfterLeave===0);
    check('no browser runtime errors',pageErrors.length===0);

    await browser.close();browser=null;core.kill();await sleep(700);
    start(false);await until(()=>fs.existsSync(pf),15000,'restart port');base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
    const restored=await post('guided/session/resolve',{resourceId:ppt.id,version:ppt.version});
    const restoredNotes=(await post('study/notes/list')).notes;
    const restartedList=await post('sessions/list');
    const restoredEntry=restartedList.sessions.find(s=>s.sessionId===thirdSid);
    check('selected guided session and notes survive a core restart',restored.sessionId===thirdSid&&restored.created===false&&restoredNotes.some(n=>n.resourceId===ppt.id&&n.page===3));
    check('normal session list still labels the restored guided session',restoredEntry?.resource?.resourceId===ppt.id&&Number(restoredEntry?.resource?.resourceVersion)===ppt.version);
    check('no core API exception was logged',!serverErrors.join('').includes('[api]'));
    console.log('RESULT=OK '+passed+' checks; data='+dir+'; shots='+shots);
  }catch(e){
    if(page){await page.screenshot({path:path.join(shots,'failure.png')}).catch(()=>{});console.error('PAGE:',(await page.locator('#view').innerText().catch(()=>'' )).slice(-1800));}
    throw e;
  }finally{if(browser)await browser.close().catch(()=>{});if(core)core.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
