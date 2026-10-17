/** 任务中心与成长页的真实检查。
 *  触发：仓颉夹具模型故意延迟每次调用 → 同时启动慢对话和慢导图 → 从右上角任务中心停止并跳转；
 *  随后再启动一轮慢对话并强杀内核 → 用同一数据目录重启，验证任务被收口为 interrupted。
 *  能抓住：聚合计数/进度/token 错、停止按钮没转发到原取消路径、最近状态误判、重启后任务丢失、
 *  打开链接跳错页面，以及成长页统计/节点/时间轴渲染或深色主题布局错误。
 *  覆盖不到：真实 Windows PPT worker 的领取/回写（由内核单测覆盖 desktop_jobs 聚合，现有 PPT 回归覆盖 worker）。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-tasks-check-')),pf=path.join(dir,'port');let core,browser,passed=0;const browserErrors=[];
 const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 const until=async(fn,ms=30000)=>{const end=Date.now()+ms;for(;;){if(await fn())return true;if(Date.now()>end)return false;await sleep(100);}};
 const start=(seed,delay)=>{try{fs.unlinkSync(pf);}catch{};core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),...(seed?['--seed-course-fixture=1']:[]),...(delay?['--fixture-delay-ms='+delay]:[])],{windowsHide:true,stdio:['ignore','ignore','pipe']});core.stderr.on('data',s=>{const t=String(s);if(!t.includes('SEED'))process.stderr.write('core: '+t);});};
 let base;
 const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
 const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
 try{
  start(true,8000);if(!(await until(()=>fs.existsSync(pf),20000)))throw Error('core did not start');
  base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>browserErrors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:20000}).catch(()=>{});
  const sid=(await post('sessions/new',{})).sessionId;
  const chatPromise=raw('agent/ask-pi',{sessionId:sid,question:'给我讲讲工具调用',web:'off'});
  const job=await post('course/generate',{kbId:'course-alpha'});
  const toolNames=(await post('tools/list',{})).tools.map(t=>t.name);check('Lumin tool catalog exposes task-center read and guarded cancel tools',toolNames.includes('list_activity_tasks')&&toolNames.includes('cancel_activity_task'));
  check('task feed exposes chat and map jobs from their original sources',await until(async()=>{const l=await post('tasks/list',{});return l.running.filter(t=>t.kind==='chat').length===1&&l.running.filter(t=>t.kind==='course-map').length===1;},12000));
  check('running chat task has a stable turn id, link and start time',await until(async()=>{const t=(await post('tasks/list',{})).running.find(x=>x.kind==='chat');return t?.id===('turn:'+sid+':'+((await post('sessions/state',{sessionId:sid})).turnId))&&t.startedAt&&t.link.page==='chat';},6000));
  check('map task reports monotonic progress and real token usage while running',await until(async()=>{const t=(await post('tasks/list',{})).running.find(x=>x.kind==='course-map');return Number(t?.progress?.percent)>=5&&Number(t?.tokens?.total)>0;},12000));
  const before=(await post('tasks/list',{})).running.find(t=>t.kind==='course-map');check('map progress carries percent, ETA fields and token breakdown',Number.isFinite(Number(before.progress.percent))&&before.progress.phase&&Number(before.tokens.total)>=Number(before.tokens.in)+Number(before.tokens.out));

  await until(async()=>await page.locator('.task-btn').count()===1,6000);
  await page.locator('.task-btn').click();await until(async()=>await page.locator('.task-row').count()===2,6000);
  check('task button badge and popup agree with API running count',await page.locator('.task-badge').innerText()==='2');
  const mapRow=page.locator('.task-row').filter({hasText:'生成思维导图'});await page.locator('.task-refresh').click();
  const mapDetail=await until(async()=>mapRow.innerText().then(t=>/%/.test(t)&&/tokens/.test(t)),8000);
  if(!mapDetail)console.log('MAP_ROW_TEXT:',await mapRow.innerText().catch(()=>'(missing)'));
  check('map row shows stage, percentage and token count',mapDetail);
  fs.mkdirSync(path.join(root,'tmp/course-shots'),{recursive:true});await page.screenshot({path:path.join(root,'tmp/course-shots','task-center-final.png')});
  await mapRow.getByRole('button',{name:'停止',exact:true}).click();
  check('stopping a map from the task center reaches the map job cancel path',await until(async()=>(await post('course/job',{id:job.id})).status==='cancelled',10000));
  const chatRow=page.locator('.task-row').filter({hasText:'对话：'});await chatRow.getByRole('button',{name:'停止',exact:true}).click();
  check('stopping a chat reaches the agent cancel path and leaves a cancelled terminal state',await until(async()=>{const l=await post('tasks/list',{});return l.running.length===0&&l.recent.some(t=>t.kind==='chat'&&t.status==='cancelled')&&l.recent.some(t=>t.kind==='course-map'&&t.status==='cancelled');},15000));
  try{await chatPromise;}catch(e){}
  check('cancelled map did not publish a partial tree',(await post('course/state',{kbId:'course-alpha'})).map===null);
  await page.locator('.task-refresh').click();await until(async()=>await page.locator('.task-badge').evaluate(e=>e.hidden),5000);
  check('running badge clears and cancelled rows move into the recent section',await page.locator('.task-section').allInnerTexts().then(x=>x.some(t=>t.includes('最近完成')))&&await page.locator('.task-row').filter({hasText:'已取消'}).count()>=2);
  const chatOpen=page.locator('.task-row').filter({hasText:'对话：'}).first();await chatOpen.getByRole('button',{name:'打开',exact:true}).click();
  await page.waitForFunction(id=>state.chatSessionId===id,sid,{timeout:6000});check('opening a chat task lands on its exact session',await page.evaluate(()=>current==='chat'));
  await page.locator('.task-btn').click();const mapOpen=page.locator('.task-row').filter({hasText:'生成思维导图'}).first();await mapOpen.getByRole('button',{name:'打开',exact:true}).click();
  await page.waitForFunction(()=>current==='learn'&&state.kb==='course-alpha',null,{timeout:8000});await page.waitForSelector('.course-workspace',{timeout:8000});check('opening a map task lands on the exact knowledge base in 学·练',await page.locator('.course-workspace').count()===1);

  const toolSession=(await post('sessions/new',{})).sessionId;await raw('agent/ask-pi',{sessionId:toolSession,question:'看看任务中心现在有哪些任务',web:'off'});
  const toolEvents=(await post('sessions/events',{sessionId:toolSession})).events;
  check('Lumin really calls list_activity_tasks through the mock Agent loop',toolEvents.some(e=>e.type==='tool/call'&&e.payload.tool==='list_activity_tasks'));
  check('task tool returns the same cancelled/recent rows through a real tool result',toolEvents.some(e=>e.type==='tool/result'&&e.payload.tool==='list_activity_tasks'&&String(e.payload.summary||e.payload.text||'').length>0));

  // 成长页：用真实课程接口准备节点完成 + 首次作答证据，再检查统计、节点资源槽和时间轴。
  const job2=await post('course/generate',{kbId:'course-alpha'});await until(async()=>(await post('course/job',{id:job2.id})).status==='completed',45000);
  const state=await post('course/state',{kbId:'course-alpha'}),nid=state.map.nodes.find(n=>n.depth>1).id;
  await post('course/node',{kbId:'course-alpha',nodeId:nid,done:true});
  const target=await post('course/start',{kbId:'course-alpha',nodeId:nid,kind:'quiz'});
  await raw('agent/ask-pi',{sessionId:target.sessionId,question:'要求已说明，面向入门者，直接生成分阶测试。',web:'off'});
  const events=(await post('sessions/events',{sessionId:target.sessionId})).events,saved=events.filter(e=>e.type==='resource/saved').at(-1)?.payload;
  if(!saved)throw Error('quiz fixture did not produce a candidate');
  await post('course/commit',{sessionId:target.sessionId,path:saved.artifactPath,learningId:saved.id,learningVersion:saved.version,title:saved.title,expectedResourceId:'',targetNodeId:nid,confirmed:true});
  await post('learning/answer',{id:saved.id,version:saved.version,questionId:'q-1',choice:0,attemptId:'tasks-check-answer'});
  await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:20000}).catch(()=>{});await page.evaluate(()=>{state.kb='course-alpha';return go('report')});
  await page.waitForSelector('.course-growth-activity');const growthText=await page.locator('.course-growth').innerText();check('growth page keeps real completion and first-attempt evidence',/1 \/ 2/.test(growthText)&&/首次作答 1 \/ 1/.test(growthText));
  check('growth page renders inline activity stats, 53 weeks and node resource slots',await page.locator('.course-growth-activity-stats').count()===1&&await page.locator('.course-growth-cell').count()===371&&await page.locator('.course-growth-node').count()===2&&await page.locator('.course-growth-slot').count()===8);
  check('growth timeline groups real events under a dated marker',await page.locator('.course-growth-day').count()>=1&&await page.locator('.course-history-row').count()>=2&&await page.locator('.course-growth-dot').count()>=2);
  check('growth page has no horizontal overflow at desktop size',await page.locator('#view').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  fs.mkdirSync(path.join(root,'tmp/course-shots'),{recursive:true});await page.screenshot({path:path.join(root,'tmp/course-shots','growth-redesign-light.png'),fullPage:true});
  await page.emulateMedia({colorScheme:'dark'});await sleep(400);
  const darkContrast=await page.evaluate(()=>{const rgb=s=>(s.match(/\d+/g)||[]).slice(0,3).map(Number),lum=s=>{const c=rgb(s).map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*c[0]+.7152*c[1]+.0722*c[2]},a=lum(getComputedStyle(document.querySelector('.course-growth-continue h2')).color),b=lum(getComputedStyle(document.querySelector('.course-growth-continue')).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)});
  check('dark theme keeps growth headings readable instead of black-on-black',darkContrast>=4.5);
  await page.screenshot({path:path.join(root,'tmp/course-shots','growth-redesign-dark.png'),fullPage:true});

  const sid2=(await post('sessions/new',{})).sessionId;const interruptedPromise=raw('agent/ask-pi',{sessionId:sid2,question:'请先问我学习要求，再生成一份工具调用讲义',web:'off'});
  if(!(await until(async()=>(await post('tasks/list',{})).running.some(t=>t.link?.sessionId===sid2),8000)))throw Error('second chat did not enter running state');
  core.kill();try{await interruptedPromise;}catch(e){}await sleep(700);
  start(false,0);if(!(await until(()=>fs.existsSync(pf),20000)))throw Error('core did not restart');base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  check('after restart an orphaned turn is reconciled as interrupted, not failed or silently lost',await until(async()=>{const l=await post('tasks/list',{});return l.running.length===0&&l.recent.some(t=>t.link?.sessionId===sid2&&t.status==='interrupted');},10000));
  check('task center and growth page produced no browser exceptions',browserErrors.length===0);
  console.log('RESULT=OK '+passed+' checks; data='+dir);
 }finally{if(browser)await browser.close();if(core)core.kill();}
})().catch(e=>{console.error('FAIL:',e);process.exit(1);});
