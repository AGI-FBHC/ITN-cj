/** 交互导学端到端检查：真实仓颉内核、SQLite、HTTP 与 Edge。不调用外部模型。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const {DatabaseSync}=require('node:sqlite');
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
  const db=()=>new DatabaseSync(path.join(dir,'itn.db'),{readOnly:true});
  try{
    start(true);await until(()=>fs.existsSync(pf),15000,'core port');base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
    const resources=(await post('learning/resources',{kbId:'course-alpha'})).resources;
    const ppt=resources.find(x=>x.kind==='ppt');check('guided fixture exposes a confirmed ppt',!!ppt&&ppt.version>0);
    const first=await post('guided/session/resolve',{resourceId:ppt.id,version:ppt.version});
    check('first resolve creates a guided session',first.created===true&&!!first.sessionId);
    const second=await post('guided/session/resolve',{resourceId:ppt.id,version:ppt.version});
    check('same resource version restores the same guided session',second.created===false&&second.sessionId===first.sessionId);
    const normalList=await post('sessions/list');
    check('guided session stays out of the normal session list',!normalList.sessions.some(s=>s.sessionId===first.sessionId));
    check('guided context exposes outline and server-owned page',second.context.currentSlide===1&&second.context.outline.length===4);

    browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1500,height:1000}});
    page.on('pageerror',e=>pageErrors.push(e.message));
    let delayedResolve=true;
    const resolveDelay=async route=>{if(delayedResolve){await sleep(450);}await route.continue();};
    await page.route('**/api/guided/session/resolve',resolveDelay);
    await page.goto(base);await page.waitForSelector('#chat-input');await page.waitForFunction(()=>!document.getElementById('boot'));
    await page.evaluate(a=>go('study',a.id+'@'+a.version),ppt);await page.waitForSelector('.sp-slides');

    // 初始化请求被故意延迟；用户先翻页时，旧状态不能把页码回滚。
    await page.keyboard.press('ArrowRight');await until(async()=>(await page.locator('.sp-slide-pos').innerText()).includes('2 /'),5000,'page 2');
    await sleep(700);
    check('early user navigation wins over delayed guided initialization',(await page.locator('.sp-slide-pos').innerText()).includes('2 /'));
    delayedResolve=false;await page.unroute('**/api/guided/session/resolve',resolveDelay);
    await page.waitForSelector('.sp-guide-panel');
    check('desktop guide is open by default',await page.locator('.sp-guided-layout').evaluate(e=>e.classList.contains('guide-open')));
    const geometry=await page.evaluate(()=>{const p=document.querySelector('.sp-guide-panel').getBoundingClientRect(),s=document.querySelector('.sp-slides').getBoundingClientRect();return{pw:p.width,left:p.left,top:p.top,stageRight:s.right,scroll:document.getElementById('view').scrollWidth,client:document.getElementById('view').clientWidth};});
    check('desktop guide uses the intended side-column width',geometry.pw>=300&&geometry.pw<=390&&geometry.left>=geometry.stageRight);
    check('guided layout introduces no horizontal page scrollbar',geometry.scroll<=geometry.client+1);

    await page.keyboard.press('ArrowRight');await page.waitForSelector('.sp-guide-check.quiz');
    await until(async()=>{const c=await post('guided/context',{sessionId:first.sessionId});return c.currentSlide===3&&c.visitedSlides.includes(3);},5000,'focus page 3');
    check('page navigation updates focus and visited slides',await page.locator('.sp-slide-title').innerText()==='验证与复盘');
    check('quiz renders four explicit options',await page.locator('.sp-guide-option').count()===4);
    await page.locator('.sp-guide-option').filter({hasText:'跳过核对直接重复调用'}).click();
    await page.waitForSelector('.sp-guide-feedback.wrong');
    check('wrong checkpoint answer is graded by the server',(await page.locator('.sp-guide-option.right').count())===1&&(await page.locator('.sp-guide-option.wrong').count())===1);
    const answered=await post('guided/context',{sessionId:first.sessionId});
    check('checkpoint result persists in guided context',!!answered.answeredCheckpoints['s3-quiz-1']&&answered.answeredCheckpoints['s3-quiz-1'].correct===false);
    let conn=db();let count=conn.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind='guided-checkpoint' AND item_key='s3-quiz-1'").get().n;conn.close();
    check('first checkpoint attempt writes exactly one evidence event',Number(count)===1);
    const repeated=await post('guided/checkpoint',{sessionId:first.sessionId,momentId:'s3-quiz-1',answerIndex:0});
    check('repeat checkpoint submission cannot replace the first attempt',repeated.repeated===true&&repeated.answerIndex===1&&repeated.correct===false);
    conn=db();count=conn.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind='guided-checkpoint' AND item_key='s3-quiz-1'").get().n;conn.close();
    check('repeat checkpoint submission does not duplicate evidence',Number(count)===1);

    await page.locator('.sp-slide-controls .primary').click();await page.waitForSelector('.sp-guide-check.summary');
    check('summary checkpoint shows review points and note prompt',await page.locator('.sp-guide-points li').count()===3&&await page.locator('.sp-guide-note-prompt').count()===1);
    check('note control is a pencil icon button',await page.locator('.sp-guide-note-button').getAttribute('title')==='记笔记'&&await page.locator('.sp-guide-note-button svg').count()===1);
    await page.locator('.sp-guide-note-button').click();await page.waitForSelector('.sp-guide-note-form');
    check('note dialog carries the exact page source', (await page.locator('.sp-guide-note-source').innerText()).includes('先确认输入、预期结果与边界'));
    await page.fill('.sp-guide-note-textarea','我会先写明输入与预期，再保留真实输出逐项核对。');
    await page.getByRole('button',{name:'保存笔记',exact:true}).click();await until(async()=>await page.locator('.course-modal-overlay').count()===0,5000,'note dialog close');
    const notes=(await post('study/notes/list')).notes;
    const savedNote=notes.find(n=>n.text.includes('逐项核对'));
    check('saved note links resource, version, page and quote',!!savedNote&&savedNote.resourceId===ppt.id&&savedNote.resourceVersion===ppt.version&&savedNote.page===4&&savedNote.slideTitle==='独立实践与验收'&&savedNote.sourceQuote.length>0);
    check('saved note is shown back in the guide thread',await page.locator('.sp-guide-note-notice').count()===1);

    await page.fill('.sp-guide-input','请解释这一页最关键的判断。');await page.locator('.sp-guide-send').click();
    await until(async()=>await page.locator('.sp-guide-msg.assistant').filter({hasText:'真实输出要能被观察和复核'}).count()>0,30000,'guided assistant reply');
    check('guided question reaches the contextual Agent and streams a reply',await page.locator('.sp-guide-msg.user').filter({hasText:'最关键的判断'}).count()===1);
    const events=await post('sessions/events',{sessionId:first.sessionId});
    check('guided chat is stored in its hidden session',events.events.some(e=>e.type==='user/message')&&events.events.some(e=>e.type==='assistant/message'));

    await page.locator('.sp-guide-toggle').click();await until(async()=>await page.locator('.sp-guided-layout').evaluate(e=>e.classList.contains('guide-closed')),3000,'guide close');
    check('desktop guide can collapse to a pure slide view',!(await page.locator('.sp-guide-panel').isVisible()));
    await page.locator('.sp-guide-toggle').click();await until(async()=>await page.locator('.sp-guide-panel').isVisible(),3000,'guide reopen');
    check('desktop guide reopens without losing the page',(await page.locator('.sp-slide-pos').innerText()).includes('4 /'));
    const lightBg=await page.locator('.sp-guide-panel').evaluate(e=>getComputedStyle(e).backgroundColor);
    await page.screenshot({path:path.join(shots,'guided-desktop-light.png')});
    await page.emulateMedia({colorScheme:'dark'});await sleep(120);
    const darkBg=await page.locator('.sp-guide-panel').evaluate(e=>getComputedStyle(e).backgroundColor);
    check('guide uses a different theme surface in dark mode',darkBg!==lightBg&&darkBg!=='rgba(0, 0, 0, 0)');
    await page.screenshot({path:path.join(shots,'guided-desktop-dark.png')});
    await page.emulateMedia({colorScheme:'light'});

    await page.setViewportSize({width:900,height:1000});await sleep(250);
    check('narrow layout starts with the drawer closed',!await page.locator('.sp-guide-panel').isVisible());
    await page.locator('.sp-guide-toggle').click();await until(async()=>await page.locator('.sp-guide-panel').isVisible(),3000,'narrow drawer open');
    const drawer=await page.locator('.sp-guide-panel').evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e),v=document.getElementById('view').getBoundingClientRect();return{position:s.position,left:r.left,right:r.right,width:r.width,viewLeft:v.left,viewRight:v.right,viewWidth:v.width};});
    check('narrow guide is a right-side drawer with a dismiss backdrop',drawer.position==='fixed'&&drawer.width<=480&&drawer.left>=drawer.viewLeft+32&&drawer.right<=drawer.viewRight-8);
    check('narrow drawer shows a dismiss scrim',!(await page.locator('.sp-guide-scrim').evaluate(e=>e.hidden)));
    await page.screenshot({path:path.join(shots,'guided-narrow.png')});
    await page.locator('.sp-guide-scrim').click({position:{x:20,y:200}});await sleep(150);

    await page.setViewportSize({width:1500,height:1000});await page.reload({waitUntil:'load'});await page.waitForSelector('.sp-slide-pos');
    await until(async()=>(await page.locator('.sp-slide-pos').innerText()).includes('4 /'),8000,'resume page 4');
    check('reload restores the guided slide and sidebar',await page.locator('.sp-guided-layout').evaluate(e=>e.classList.contains('guide-open'))&&await page.locator('.sp-guide-note-button').isVisible());
    await page.locator('.sp-slide').click({position:{x:12,y:12}});await page.keyboard.press('ArrowLeft');await page.waitForSelector('.sp-guide-feedback.wrong');
    check('reload restores the locked first checkpoint result',await page.locator('.sp-guide-option.right').count()===1&&await page.locator('.sp-guide-option.wrong').count()===1);

    let guidedEventsAfterLeave=0;page.on('request',r=>{if(r.url().includes('/api/sessions/events'))guidedEventsAfterLeave+=1;});
    await page.evaluate(()=>go('learn'));await page.waitForSelector('.course-workspace');await sleep(900);
    check('leaving the guide stops its event poller',guidedEventsAfterLeave===0);
    check('no browser runtime errors',pageErrors.length===0);

    await browser.close();browser=null;core.kill();await sleep(700);
    start(false);await until(()=>fs.existsSync(pf),15000,'restart port');base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
    const restored=await post('guided/session/resolve',{resourceId:ppt.id,version:ppt.version});
    const restoredNotes=(await post('study/notes/list')).notes;
    check('guided session and notes survive a core restart',restored.sessionId===first.sessionId&&restored.created===false&&restoredNotes.some(n=>n.resourceId===ppt.id&&n.page===4));
    check('no core API exception was logged', !serverErrors.join('').includes('[api]'));
    console.log('RESULT=OK '+passed+' checks; data='+dir+'; shots='+shots);
  }catch(e){
    if(page){await page.screenshot({path:path.join(shots,'failure.png')}).catch(()=>{});console.error('PAGE:',(await page.locator('#view').innerText().catch(()=>'' )).slice(-1400));}
    throw e;
  }finally{if(browser)await browser.close().catch(()=>{});if(core)core.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
