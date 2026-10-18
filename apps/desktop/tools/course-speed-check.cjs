/** 思维导图生成的提速与进度检查：真内核 + 仓颉夹具（带每次调用延迟）+ 真浏览器。
    断言：并行提炼（最大并发≥2）、进度条/百分比/ETA、百分比单调且收尾 100、
    内容不变的二次生成只重算树（摘要缓存命中）、图完整覆盖所有文档。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-course-speed-')),pf=path.join(dir,'port');let core,browser,passed=0;
 const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 try{
  core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),'--seed-course-fixture=1','--fixture-delay-ms=400'],{windowsHide:true,stdio:'ignore'});
  for(let i=0;i<200&&!fs.existsSync(pf);i++)await sleep(100);
  if(!fs.existsSync(pf))throw Error('core did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
  // 大知识库：8 份文档 × 约 20KB → 多个批次
  const kbDir=path.join(dir,'big-src');fs.mkdirSync(kbDir);
  for(let i=1;i<=8;i++)fs.writeFileSync(path.join(kbDir,'章节'+i+'.md'),'# 章节 '+i+'\n\n'+('这是第 '+i+' 章的有效学习资料内容，用于验证并行提炼、问题场景与验收依据。'.repeat(400)));
  await post('kb/import',{id:'course-big',name:'大知识库',path:kbDir,kind:'folder'});
  await post('kb/build',{id:'course-big'});

  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:20000}).catch(()=>{});
  await page.evaluate(()=>go('learn'));await page.waitForSelector('#course-kb');
  await page.selectOption('#course-kb','course-big');
  await page.waitForFunction(()=>courseUi.kb==='course-big'&&courseUi.data&&courseUi.data.map===null);
  await sleep(350);   // 选库后的重渲染落定，避免点到即将被替换的旧按钮（进度框会挂到废弃节点）
  await page.waitForFunction(()=>{const b=document.getElementById('course-generate');return !!b&&!b.disabled&&b.isConnected;});
  await page.locator('#course-generate').click();
  const until=async(fn,ms=15000)=>{const t=Date.now()+ms;while(Date.now()<t){if(await fn())return true;await sleep(100)}return false;};
  check('progress bar appears while generating',await until(async()=>await page.locator('.course-job-bar').count()>0));
  check('the progress bar shows a percentage',await until(async()=>/\d+%/.test(await page.locator('.course-job-pct').innerText().catch(()=>''))));
  check('token usage appears next to the progress bar',await until(async()=>/tokens /.test(await page.locator('.course-job-tokens').innerText().catch(()=>'')),15000));
  await page.screenshot({path:path.join(root,'tmp/course-shots','course-progress-bar.png')}).catch(()=>{});
  const jobId=await page.evaluate(()=>courseUi.jobs.get('course-big'));
  check('the UI tracks a concrete job id',!!jobId);
  const percents=[];let sawEta=false,status='running',job=null;
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    job=await post('course/job',{id:jobId});
    if(job.progress){const pct=Number(job.progress.percent);if(Number.isFinite(pct))percents.push(pct);if((Number(job.progress.etaSeconds)||0)>0)sawEta=true;}
    if(job.status!=='running'){status=job.status;break;}
    await sleep(120);
  }
  check('generation completes',status==='completed'&&job.status==='completed');
  check('percentage is monotonic and ends at 100',percents.length>=3&&percents.every((v,i)=>i===0||v>=percents[i-1])&&percents[percents.length-1]===100);
  check('an ETA is reported while summarizing',sawEta);
  check('the finished job reports accumulated token usage',Number(job.tokens&&job.tokens.total)>0&&Number(job.tokens&&job.tokens.calls)>=2);
  const statsPath=path.join(dir,'fixture-stats.json');
  check('fixture recorded model calls',fs.existsSync(statsPath));
  const s1=JSON.parse(fs.readFileSync(statsPath,'utf8'));
  check('batch summaries ran in parallel (max concurrency >= 2)',s1.maxConcurrent>=2);
  check('several batches were summarized',s1.summarize>=3);
  check('the tree was generated exactly once',s1.tree===1);
  const st1=await post('course/state',{kbId:'course-big'});
  check('the map covers every source document',st1.map&&st1.map.nodes.length===9);

  // 内容不变的二次生成：摘要全部命中缓存，只重算树
  const rebuild=await post('course/generate',{kbId:'course-big'});
  let rj=null;const dl2=Date.now()+120000;
  while(Date.now()<dl2){rj=await post('course/job',{id:rebuild.id});if(rj.status!=='running')break;await sleep(120)}
  check('rebuild completes',rj&&rj.status==='completed');
  const s2=JSON.parse(fs.readFileSync(statsPath,'utf8'));
  check('unchanged rebuild reuses every cached batch summary',s2.summarize===s1.summarize);
  check('unchanged rebuild only regenerates the tree',s2.tree===s1.tree+1);
  const st2=await post('course/state',{kbId:'course-big'});
  check('current map stays the same until the candidate is confirmed',st2.map.id===st1.map.id&&st2.job&&st2.job.status==='completed'&&!!st2.job.mapId);
  check('no browser exceptions',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; data='+dir);
 }finally{if(browser)await browser.close();if(core)core.kill();}
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
