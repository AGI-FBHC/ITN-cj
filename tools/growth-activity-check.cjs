/** 学习活跃度正式检查：仓颉夹具造出跨日期、重复、撤销和超窗口事件，再走真 HTTP + Agent + 浏览器。
 *  能抓住：活跃度误算、撤销/重复被计数、时间窗口错误、网格列数/响应式错误、日筛选失效、
 *  时间轴把学习条目误标成节点完成、Lumin 工具不可调用、深色对比度或页面横向溢出。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-growth-activity-')),pf=path.join(dir,'port');let core,browser,passed=0;const errors=[];
 const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 const until=async(fn,ms=30000)=>{const end=Date.now()+ms;for(;;){if(await fn())return true;if(Date.now()>end)return false;await sleep(100);}};
 try{
  core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),'--seed-course-fixture=1','--seed-growth-activity=1'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  core.stderr.on('data',s=>{const t=String(s);if(!t.includes('SEED'))process.stderr.write('core: '+t);});
  if(!(await until(()=>fs.existsSync(pf),20000)))throw Error('core did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
  const job=await post('course/generate',{kbId:'course-alpha'});if(!(await until(async()=>(await post('course/job',{id:job.id})).status==='completed',30000)))throw Error('map generation did not complete');
  const report=await post('course/report',{kbId:'course-alpha'}),a=report.activity;
  check('activity totals exclude duplicate, undone and out-of-window events',a.total===23&&a.activeDays===7&&a.currentStreak===3&&a.longestStreak===3);
  check('activity returns only dates with effective evidence',a.days.length===7&&a.days.every(d=>d.count>0));
  const today=a.to,day=a.days.find(d=>d.date===today);
  check('today breaks down into 3 answers, 1 completion and 1 node',day&&day.count===5&&day.quiz===3&&day.completion===1&&day.node===1);

  const toolSession=(await post('sessions/new',{})).sessionId;await raw('agent/ask-pi',{sessionId:toolSession,kbId:'course-alpha',question:'看看 course-alpha 的学习活跃度',web:'off'});
  const events=(await post('sessions/events',{sessionId:toolSession})).events;
  check('Lumin calls get_learning_activity through the mock Agent loop',events.some(e=>e.type==='tool/call'&&e.payload.tool==='get_learning_activity'));
  check('get_learning_activity returns a real tool result',events.some(e=>e.type==='tool/result'&&e.payload.tool==='get_learning_activity'&&String(e.payload.summary||e.payload.text||'').length>0));

  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:20000}).catch(()=>{});await page.evaluate(()=>{state.kb='course-alpha';return go('report')});await page.waitForSelector('.course-growth-activity');
  check('V2 compact continuation replaces the old dashboard hero',await page.locator('.course-growth-hero').count()===0&&await page.locator('.course-growth-continue').count()===1);
  check('activity summary is inline text rather than stat cards',/7 天活跃/.test(await page.locator('.course-growth-activity-stats').innerText())&&/23 次证据/.test(await page.locator('.course-growth-activity-stats').innerText()));
  check('desktop renders 53 weeks of day cells',await page.locator('.course-growth-cell').count()===371);
  const todayCell=page.locator('.course-growth-cell[data-date="'+today+'"]');check('today uses the expected activity level',await todayCell.getAttribute('data-level')==='2');
  await todayCell.hover();await sleep(100);check('hover tooltip exposes the real daily breakdown',await page.locator('.course-growth-day-tip').isVisible()&&(await page.locator('.course-growth-day-tip').innerText()).includes('5 次学习证据'));
  await todayCell.click();await sleep(100);const trail=await page.locator('.course-growth-history').innerText();
  check('clicking a day filters the learning trail',await page.locator('.course-growth-day-filter').isVisible());
  const timelineKinds=trail.includes('完成学习条目')&&trail.includes('标记节点学完')&&trail.includes('答对 · 首次作答');if(!timelineKinds)console.log('TIMELINE_TEXT:',trail);check('timeline shows correct, first-attempt quiz labels and distinguishes other event kinds',timelineKinds);
  await page.locator('.course-growth-day-filter').click();
  check('clearing the day filter restores the full trail',await page.locator('.course-growth-day-filter').isHidden());
  check('desktop page has no horizontal overflow',await page.evaluate(()=>document.querySelector('#view').scrollWidth<=document.querySelector('#view').clientWidth+1));
  fs.mkdirSync(path.join(root,'tmp/course-shots'),{recursive:true});await page.screenshot({path:path.join(root,'tmp/course-shots','growth-activity-v2-light.png')});
  await page.emulateMedia({colorScheme:'dark'});await sleep(350);
  const contrast=await page.evaluate(()=>{const rgb=s=>(s.match(/\d+/g)||[]).slice(0,3).map(Number),lum=s=>{const c=rgb(s).map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*c[0]+.7152*c[1]+.0722*c[2]},fg=lum(getComputedStyle(document.querySelector('.course-growth-continue h2')).color),bg=lum(getComputedStyle(document.querySelector('.course-growth-continue')).backgroundColor);return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)});
  check('dark continuation text keeps readable contrast',contrast>=4.5);await page.screenshot({path:path.join(root,'tmp/course-shots','growth-activity-v2-dark.png')});
  await page.emulateMedia({colorScheme:'light'});await page.setViewportSize({width:390,height:844});await sleep(450);
  check('narrow layout renders 26 weeks',await page.locator('.course-growth-cell').count()===182);
  check('narrow layout has no horizontal overflow',await page.evaluate(()=>document.querySelector('#view').scrollWidth<=document.querySelector('#view').clientWidth+1));
  await page.screenshot({path:path.join(root,'tmp/course-shots','growth-activity-v2-mobile.png'),fullPage:true});
  check('no browser exceptions',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; data='+dir);
 }finally{if(browser)await browser.close();if(core)core.kill();}
})().catch(e=>{console.error('FAIL:',e);process.exit(1);});
