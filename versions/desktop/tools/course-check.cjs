/** Native Cangjie fixture + real HTTP/Agent loop + real browser. No production data or external models. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-course-')),pf=path.join(dir,'port');let core,browser,passed=0;const errors=[];
 const start=(seed)=>{try{fs.unlinkSync(pf);}catch{};core=spawn(process.env.COURSE_CORE_EXE||path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+(process.env.COURSE_UI_DIR||path.join(root,'shell/renderer')),...(seed?['--seed-course-fixture=1']:[])],{windowsHide:true,stdio:['ignore','ignore','pipe']});core.stderr.on('data',s=>errors.push('core: '+s));};
 const until=async(fn,ms=30000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(await fn())return;await sleep(100);}throw Error('condition timed out');};
 const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 let base,page;
 const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
 const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
 const state=()=>post('course/state',{kbId:'course-alpha'});
 const close=async()=>{if(await page.locator('.course-modal-overlay').count())await page.locator('.course-close').click();};
 const goLearn=async()=>{await page.evaluate(()=>go('learn'));await page.waitForSelector('#course-kb');if(await page.locator('#course-kb').inputValue()!=='course-alpha'){await page.selectOption('#course-kb','course-alpha');await page.waitForFunction(()=>courseUi.kb==='course-alpha'&&courseUi.data?.map);}};
 const openNode=async()=>{await page.locator('.course-node').filter({hasText:'工具调用'}).click();await page.waitForSelector('.course-resource-grid');};
 /* 发送后必须先等到"真的进入运行"，否则 !isSessionRunning 会在请求注册之前立刻为真，
    测试随后读到的是上一轮的事件 —— 生成类步骤会误报"没有候选资源"。 */
 const waitTurn=async(sid,ms=60000)=>{
   await until(async()=>await page.evaluate(s=>isSessionRunning(s),sid),15000).catch(()=>{});
   await until(async()=>await page.evaluate(s=>!isSessionRunning(s),sid),ms);
 };
 const send=async text=>{const sid=await page.evaluate(()=>state.chatSessionId);await page.fill('#chat-input',text);await page.locator('.composer-send[aria-label="发送"]').click();await waitTurn(sid);};
 const produce=async(kind,regenerate=false)=>{
   await goLearn();await openNode();const tile=page.locator('.course-resource-tile[data-kind="'+kind+'"]');
   if(regenerate){await tile.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'重新生成',exact:true}).click();}
   else await tile.getByRole('button',{name:'去对话生成',exact:true}).click();
   await page.waitForSelector('#chat-input');
   const startedSid=await page.evaluate(()=>state.chatSessionId);
   await waitTurn(startedSid,30000);
   const sid=await page.evaluate(()=>state.chatSessionId),target=await post('course/target',{sessionId:sid});check('node session binds exact KB/node/kind '+kind,target.kbId==='course-alpha'&&target.kind===kind&&target.valid);
   await page.evaluate(()=>state.kb='course-beta');
   await send('要求已说明，面向入门者，内容简短，直接生成这类学习资源。');
   const events=(await post('sessions/events',{sessionId:sid})).events;const saved=events.filter(e=>e.type==='resource/saved').at(-1)?.payload;
   if(!saved)throw Error('no saved candidate for '+kind+': '+JSON.stringify(events.filter(e=>e.type==='tool/result'||e.type==='assistant/message').slice(-3).map(e=>({type:e.type,tool:e.payload.tool,ok:e.payload.ok,summary:e.payload.summary,text:e.payload.text}))));
   check('server target overrides a different client-selected KB '+kind,saved.kbId==='course-alpha');
   const before=await state();check('candidate does not occupy or replace a slot '+kind,before.resources.filter(a=>a.kind===kind).length===(regenerate?1:0));
   const card=page.locator('[data-resource="'+saved.id+'"]').first();await card.click();
   await page.getByRole('button',{name:'加入我的学习资源',exact:true}).click();await page.waitForSelector('#course-save-title');
   const during=await state();check('opening approval dialog does not publish '+kind,during.resources.filter(a=>a.kind===kind).length===(regenerate?1:0));
   const button=page.locator('.course-modal').getByRole('button',{name:regenerate?'确认替换，旧版归档':'确认加入',exact:true});await button.click();await until(async()=>!(await page.locator('#course-save-title').count()));
   const after=await state();const asset=after.resources.find(a=>a.kind===kind);check('confirmed resource is exact version '+kind,!!asset&&asset.learningId===saved.id&&asset.learningVersion===saved.version&&fs.existsSync(asset.path));
   return{asset,saved,sid,target};
 };
 try{
   start(true);await until(()=>fs.existsSync(pf));base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
   check('knowledge bases start without mind maps',(await state()).map===null);
   browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1500,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForSelector('#chat-input');await page.waitForFunction(()=>!document.getElementById('boot'));
   await page.evaluate(()=>go('learn'));await page.waitForSelector('#course-generate');await page.locator('#course-generate').click();await page.waitForSelector('.course-node',{timeout:45000});
   await page.waitForFunction(()=>document.querySelector('.course-world')?.style.transform.includes('scale('));
   const first=await state();check('fixed LLM pipeline publishes first validated tree',first.map.nodes.length===3&&first.map.sourceDocuments===2&&first.map.sourceChunks===2);
   check('mind map fills page without scrollbar',await page.locator('#view').evaluate(e=>e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1));
   check('map uses all available page width',await page.locator('.course-workspace').evaluate(e=>e.clientWidth>=e.parentElement.clientWidth-50));
   check('initial map is centered vertically',await page.evaluate(()=>{const s=document.querySelector('.course-stage').getBoundingClientRect(),n=document.querySelector('.course-root').getBoundingClientRect();return Math.abs(n.y+n.height/2-(s.y+s.height/2))<100;}));
    const dragNode=page.locator('.course-node').filter({hasText:'工具调用'}).first(),dragText=dragNode.locator('span').first(),dragBox=await dragText.boundingBox(),beforeDrag=await page.evaluate(()=>document.querySelector('.course-world').style.transform);
    await page.mouse.move(dragBox.x+dragBox.width/2,dragBox.y+dragBox.height/2);await page.mouse.down();await page.mouse.move(dragBox.x+dragBox.width/2+72,dragBox.y+dragBox.height/2+38,{steps:8});await page.mouse.up();
    const afterDrag=await page.evaluate(()=>document.querySelector('.course-world').style.transform),selection=await page.evaluate(()=>window.getSelection().toString());
    check('dragging from node text pans the map',beforeDrag!==afterDrag);
    check('dragging from node text does not select text',selection==='');
    await dragNode.click();await page.waitForSelector('.course-resource-grid');await page.keyboard.press('Escape');
    check('a node still opens after a text-drag gesture',await page.locator('.course-modal-overlay').count()===0);
   await openNode();check('four resources open in centered 2x2 modal',await page.locator('.course-resource-tile').count()===4&&await page.locator('.course-resource-grid').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length===2));check('close button stays at dialog top right',await page.evaluate(()=>{const d=document.querySelector('.course-modal').getBoundingClientRect(),b=document.querySelector('.course-close').getBoundingClientRect();return d.right-b.right<40;}));await page.keyboard.press('Escape');check('Escape returns to same map',await page.locator('.course-modal-overlay').count()===0&&await page.locator('.course-node').count()===3);
   const lecture=await produce('lecture');const replacement=await produce('lecture',true);
   let current=await state();check('replacement archives one old confirmed version',current.resources.length===1&&current.archiveCount===1&&current.resources[0].id!==lecture.asset.id);
   const archived=(await post('course/resources',{kbId:'course-alpha',status:'archive'})).resources[0];check('archived file is physically in archive folder',archived.path.includes('归档')&&fs.existsSync(archived.path)&&!fs.existsSync(lecture.asset.path));
   check('default personal list hides archived resources',(await post('personal/list')).resources.filter(a=>a.id===archived.id).length===0);
   await goLearn();await openNode();await page.locator('.course-resource-tile[data-kind="lecture"]').getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'移入回收站',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();await until(async()=>(await state()).trashCount===1);
   check('deleting a resource keeps map and node', (await state()).map.nodes.length===3&&(await state()).resources.length===0);
   check('normal exact-version read rejects trashed content',(await raw('learning/resource',{id:replacement.saved.id,version:replacement.saved.version})).code!==0);
   await close();await page.getByRole('button',{name:/^回收站 /}).click();await page.getByRole('button',{name:'恢复',exact:true}).click();await page.getByRole('button',{name:'确认关联',exact:true}).click();await until(async()=>(await state()).resources.length===1);check('trash restore reuses original stable resource ID',(await state()).resources[0].id===replacement.asset.id);
   await close();await page.getByRole('button',{name:/^归档 /}).click();await page.getByRole('button',{name:'关联 / 恢复',exact:true}).first().click();await page.getByRole('button',{name:'确认关联',exact:true}).click();await until(async()=>(await state()).resources[0]?.id===lecture.asset.id);check('restoring old version archives displaced current version',(await state()).archiveCount===1);
   await close();const oldMap=(await state()).map.id;await page.locator('#course-generate').click();await page.waitForSelector('.course-candidate-tree',{timeout:45000});check('rebuild candidate leaves current map usable',(await state()).map.id===oldMap&&(await state()).resources.length===1);
   await page.getByRole('button',{name:'旧图先继续用',exact:true}).click();check('declining candidate preserves current map',(await state()).map.id===oldMap);
   await page.getByRole('button',{name:'预览新版',exact:true}).click();await page.getByRole('button',{name:'确认切换新版',exact:true}).click();await until(async()=>(await state()).map.id!==oldMap);current=await state();check('publishing rebuild archives resources and retains old tree',current.resources.length===0&&current.archiveCount===2&&(await post('course/history',{kbId:'course-alpha'})).maps.some(m=>m.id===oldMap));
   check('old target cannot silently save to rebuilt map',(await raw('course/commit',{sessionId:lecture.sid,path:lecture.saved.artifactPath,expectedResourceId:'',confirmed:true})).code!==0);
   await post('course/resource/action',{id:lecture.asset.id,action:'attach',kbId:'course-alpha',nodeId:current.map.nodes.find(n=>n.title==='工具调用').id,expectedResourceId:'',confirmed:true});check('archived resource can attach to a new node',(await state()).resources[0].id===lecture.asset.id);
   const practice=await produce('practice'),quiz=await produce('quiz'),ppt=await produce('ppt');check('one node has exactly four distinct current kinds',(await state()).resources.length===4&&new Set((await state()).resources.map(a=>a.kind)).size===4);
   await post('learning/answer',{id:quiz.saved.id,version:quiz.saved.version,questionId:'q-1',choice:0,attemptId:'course-ui-attempt'});const beforeReport=await post('course/report',{kbId:'course-alpha'});check('growth uses actual first-attempt evidence',beforeReport.quizAttempts===1&&beforeReport.quizCorrect===1);
   await post('course/resource/action',{id:quiz.asset.id,action:'archive',confirmed:true});await post('course/resource/action',{id:quiz.asset.id,action:'restore',kbId:'course-alpha',nodeId:(await state()).map.nodes.find(n=>n.title==='工具调用').id,expectedResourceId:'',confirmed:true});check('archiving/restoring does not duplicate learning evidence',(await post('course/report',{kbId:'course-alpha'})).quizAttempts===1);
   await goLearn();await openNode();await page.getByRole('button',{name:'标记学完',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();await close();await page.evaluate(()=>go('report'));await page.waitForSelector('.course-growth-activity');const growthText=await page.locator('.course-growth').innerText();check('growth page shows node completion, real evidence and activity grid',growthText.includes('1 / 2')&&growthText.includes('首次作答 1 / 1')&&await page.locator('.course-growth-cell').count()===371);
   const shots=path.join(root,'tmp/course-shots');fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,'growth.png')});
   await goLearn();await page.screenshot({path:path.join(shots,'mindmap-light.png')});await openNode();await page.screenshot({path:path.join(shots,'resource-dialog-light.png')});await close();await page.evaluate(()=>applyZoom(1.3));await openNode();const box=await page.locator('.course-modal').boundingBox();check('resource dialog fits at 130% application zoom',box.x>=0&&box.x+box.width<=1501&&box.y>=0&&box.y+box.height<=1001);await close();await page.evaluate(()=>applyZoom(1));await page.emulateMedia({colorScheme:'dark'});await openNode();await page.screenshot({path:path.join(shots,'resource-dialog-dark.png')});await close();
   // —— 资源单独打开页（studyplayer）：四类资源各自的页面、深链与续播
    const goStudy=async(asset,kind)=>{await page.evaluate(a=>go('study',a.learningId+'@'+a.learningVersion),asset);await page.waitForSelector('.sp-page');if(kind==='ppt')await page.waitForSelector('.sp-slide-fallback, .sp-ppt-frame',{timeout:15000});else if(kind!=='quiz')await page.waitForSelector('.sp-block',{timeout:15000});};
    await goStudy(lecture.asset);
    check('lecture opens as a dedicated reading page with breadcrumb and sections',await page.locator('.sp-crumb').count()===1&&await page.locator('.sp-block').count()>=2&&await page.locator('#resource-dock').evaluate(e=>e.hidden));
    await page.locator('.sp-block .sp-mark').first().click();
    await until(async()=>await page.locator('.sp-block .sp-mark').first().evaluate(e=>e.classList.contains('on')));
    check('lecture section mark persists per item on the server',(await post('learning/resource',{id:lecture.saved.id,version:lecture.saved.version})).progressItems.includes('section-1-1'));
    await page.screenshot({path:path.join(root,'tmp/course-shots','study-lecture.png')});
    await page.reload({waitUntil:'load'});await page.waitForSelector('.sp-page');
    check('deep link to a resource survives reload with marks intact',await page.locator('.sp-crumb').count()===1&&await page.locator('.sp-block .sp-mark').first().evaluate(e=>e.classList.contains('on')));
    check('after reload the page still resolves the owning node',(await page.locator('.sp-crumb-trail').innerText()).includes('工具调用'));
    await page.getByRole('button',{name:'← 返回思维导图',exact:true}).click();
    await page.waitForSelector('.course-workspace');
    const lectureNodeNow=(await state()).resources.find(a=>a.learningId===lecture.saved.id).nodeId;
    await until(async()=>await page.evaluate(nid=>!!document.querySelector('.course-node[data-node="'+nid+'"].course-node-focus'),lectureNodeNow));
    check('returning to the map focuses the node the resource belongs to',true);
    // 审计：搜索过滤、弹窗关闭后的焦点归还
    const mutedCount=async()=>page.locator('.course-node.course-muted').count();
    const nodeCount=await page.locator('.course-node').count();
    await page.fill('#course-search','绝不存在-ZZQ-7788');
    await until(async()=>await mutedCount()===nodeCount);
    check('node search mutes everything when nothing matches',true);
    await page.fill('#course-search','工具');
    await until(async()=>await mutedCount()<nodeCount);
    check('node search keeps matches visible',await mutedCount()<nodeCount);
    await page.fill('#course-search','');
    await until(async()=>await mutedCount()===0);
    check('clearing the search restores every node',true);
    await page.locator('.course-node').filter({hasText:'工具调用'}).click();
    await page.waitForSelector('.course-modal');
    await page.keyboard.press('Escape');
    await until(async()=>await page.locator('.course-modal').count()===0);
    check('Escape closes the node modal and returns focus to its node',await page.evaluate(()=>document.activeElement?.classList?.contains('course-node')));
    await goStudy(practice.asset);
    check('practice page lists steps, safety and acceptance as its own page',await page.locator('.sp-step').count()>=2&&await page.locator('.sp-accept').count()===1);
    await page.locator('.sp-step .sp-mark').first().click();
    await until(async()=>await page.locator('.sp-step .sp-mark').first().evaluate(e=>e.classList.contains('on')));
    check('practice step completion persists as a per-item mark',(await post('learning/resource',{id:practice.saved.id,version:practice.saved.version})).progressItems.includes('step-1'));
    await goStudy(quiz.asset,'quiz');
    await page.waitForSelector('.sp-q');
    check('quiz page continues at the first unanswered question',(await page.locator('.sp-q-index').innerText()).includes('第 2 /')&&await page.locator('.sp-q').count()===1);
    const attemptsBefore=(await post('course/report',{kbId:'course-alpha'})).quizAttempts;
    await page.locator('.sp-opt:not([disabled])').first().click();
    await until(async()=>await page.locator('.sp-feedback').evaluate(e=>e.textContent.trim().length>0));
    const attemptsAfter=(await post('course/report',{kbId:'course-alpha'})).quizAttempts;
    check('answering inside the page records exact-version evidence',attemptsAfter===attemptsBefore+1);
    for(let i=0;i<12;i++){
      if(await page.locator('.sp-summary').count())break;
      const next=page.getByRole('button',{name:/下一题|查看小结/});
      if(await next.count()){await next.click();await sleep(140);continue;}
      const opt=page.locator('.sp-opt:not([disabled])').first();
      if(await opt.count()){await opt.click();await until(async()=>await page.locator('.sp-feedback').evaluate(e=>e.textContent.trim().length>0));continue;}
      break;
    }
    check('quiz finishes with a round summary and a retry entry',await page.locator('.sp-summary').count()===1&&await page.getByRole('button',{name:'再做一遍',exact:true}).count()===1);
    await page.getByRole('button',{name:'再做一遍',exact:true}).click();
    await page.waitForSelector('.sp-q');
    check('retry starts from a clean first question',(await page.locator('.sp-q-index').innerText()).includes('第 1 /')&&await page.locator('.sp-opt.right,.sp-opt.wrong').count()===0);
    await page.screenshot({path:path.join(root,'tmp/course-shots','study-quiz-retry.png')});
    await page.screenshot({path:path.join(root,'tmp/course-shots','study-quiz.png')});
    await goStudy(quiz.asset,'quiz');
    await page.waitForSelector('.sp-q');await page.screenshot({path:path.join(root,'tmp/course-shots','study-quiz-question.png')});
    await goStudy(ppt.asset,'ppt');
    check('ppt opens as an interactive guide page instead of the dock player',await page.locator('.sp-slide-frame').count()===1&&await page.locator('.sp-study-layout').count()===1&&await page.evaluate(()=>document.getElementById('player')?.hidden!==false));
    const slideTitle=async()=>{const frame=page.locator('.sp-ppt-frame');if(await frame.count())return await frame.getAttribute('title');return await page.locator('.sp-slide-fallback h2').innerText();};
    const firstSlide=await slideTitle();
    await page.keyboard.press('ArrowRight');
    await until(async()=>(await page.locator('.sp-stage-pos').innerText()).includes('2 /'));
    check('arrow keys page through the interactive guide',(await slideTitle())!==firstSlide);
    await page.getByRole('button',{name:'讲稿',exact:true}).click();
    check('speaker notes can be revealed',await page.locator('.sp-stage-notes').evaluate(e=>!e.hidden));
    await page.screenshot({path:path.join(root,'tmp/course-shots','study-ppt.png')});
    const pptKey='resource:'+ppt.saved.id+':v'+ppt.saved.version;
    await until(async()=>(await post('artifacts/progress',{name:pptKey})).page===2);
    await page.reload({waitUntil:'load'});await page.waitForSelector('.sp-slide-fallback, .sp-ppt-frame');
    check('interactive guide resumes from the saved slide after reload',(await page.locator('.sp-stage-pos').innerText()).includes('2 /'));
    await goLearn();
    await page.keyboard.press('ArrowRight');
    await sleep(200);
    check('guide arrow keys do not leak into other pages',await page.evaluate(()=>current==='learn')&&await page.locator('.course-workspace').count()===1);
    // 审计：对话侧栏预览的“全屏打开”进入资源页
    await page.evaluate(sid=>openChatSession(sid),lecture.sid);
    await page.waitForSelector('[data-resource="'+lecture.saved.id+'"]');
    await page.locator('[data-resource="'+lecture.saved.id+'"]').first().click();
    await page.waitForSelector('#resource-dock .resource-dock-head');
    await page.getByRole('button',{name:'全屏打开',exact:true}).click();
    await page.waitForSelector('.sp-page');
    check('dock full-screen entry opens the dedicated resource page',await page.evaluate(()=>current==='study')&&(await page.locator('.sp-title').innerText()).includes('讲义'));
    // 审计：在资源页里归档会释放槽位并落到归档
    const archivedBefore=(await state()).archiveCount;
    await page.getByRole('button',{name:'更多',exact:true}).click();
    await page.getByRole('button',{name:'归档这份资源',exact:true}).click();
    await page.getByRole('button',{name:'确认',exact:true}).click();
    await page.waitForSelector('.course-workspace');
    const afterArchive=await state();
    check('archiving from the resource page frees the slot and keeps the map',afterArchive.resources.length===3&&afterArchive.archiveCount===archivedBefore+1&&afterArchive.map!==null);
    await page.selectOption('#course-kb','course-beta');await page.waitForFunction(()=>courseUi.kb==='course-beta'&&courseUi.data.map===null);check('library selection does not show another library map',await page.locator('.course-node').count()===0);await page.locator('#course-generate').click();await page.waitForSelector('.course-node',{timeout:45000});check('each library owns exactly one independent current map',(await post('course/state',{kbId:'course-beta'})).map.kbId==='course-beta'&&(await post('course/state',{kbId:'course-beta'})).resources.length===0);
   const original=path.join(dir,'course-alpha','文档0.md');await post('kb/delete',{id:'course-alpha'});check('removing KB archives resources and preserves original files',fs.existsSync(original)&&(await state()).map===null&&(await state()).resources.length===0);await post('course/kb/restore',{kbId:'course-alpha',confirmed:true});check('knowledge base and historical map can be restored',(await state()).map!==null&&(await state()).archiveCount>=4);
   core.kill();await sleep(700);start(false);await until(()=>fs.existsSync(pf));base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();check('relationships and archived files survive process restart',(await state()).map!==null&&(await state()).archiveCount>=4);
   check('no browser exceptions',errors.filter(e=>!e.startsWith('core:')).length===0);
   console.log('RESULT=OK '+passed+' checks; data='+dir+'; shots='+shots);
 }catch(e){if(page){fs.mkdirSync(path.join(root,'tmp/course-shots'),{recursive:true});await page.screenshot({path:path.join(root,'tmp/course-shots/failure.png')}).catch(()=>{});console.error('PAGE:',(await page.locator('#view').innerText().catch(()=>'' )).slice(-1000));}throw e;}
 finally{if(browser)await browser.close();if(core)core.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
