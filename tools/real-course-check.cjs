/** Real configured model, copied configuration, empty isolated dataset. Never logs credentials. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const configCopy=fs.readFileSync(path.join(root,'tmp/course-model-copy-path.txt'),'utf8').trim();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-course-')),pf=path.join(dir,'port');
 const core=spawn(process.env.COURSE_CORE_EXE||path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+(process.env.COURSE_UI_DIR||path.join(root,'shell/renderer')),'--seed-course-fixture=1','--course-model-copy='+configCopy],{windowsHide:true,stdio:'ignore'});
 let browser,passed=0;const started=Date.now();
 const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 const wait=async(fn,ms=600000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(await fn())return;await sleep(500);}throw Error('real-model deadline exceeded');};
 try{
   await wait(()=>fs.existsSync(pf),20000);const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
   const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
   const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
   const cfg=(await(await fetch(base+'/api/settings')).json()).data;const selected=cfg.models.find(m=>m.id===cfg.chatModelId);console.log('MODEL '+selected.model+'; isolated KB only; credentials hidden');
   const job=await post('course/generate',{kbId:'course-alpha'});let status,lastStage='';
   await wait(async()=>{status=await post('course/job',{id:job.id});if(status.stage!==lastStage){console.log('STAGE '+status.stage);lastStage=status.stage;}return status.status!=='running';});
   check('real LLM generated and validated the knowledge-base tree',status.status==='completed');
   console.log('TOKENS '+JSON.stringify(status.tokens||{}));
   const current=await post('course/state',{kbId:'course-alpha'}),map=current.map;
   check('one current map with maximum four levels',map.nodes.length>=2&&map.nodes.every(n=>n.depth>=1&&n.depth<=4));
   const coverage=new Set(map.nodes.filter(n=>n.depth>1).flatMap(n=>n.sources.map(s=>s.id)));
   check('outline covers every prepared source document',coverage.size===map.sourceDocuments&&map.sourceDocuments===2);
   const node=map.nodes.find(n=>n.depth>1&&n.title.includes('工具'))||map.nodes.find(n=>n.depth>1);
   const target=await post('course/start',{kbId:'course-alpha',nodeId:node.id,kind:'lecture'});const sid=target.sessionId;
   let saved;
   for(let attempt=0;attempt<2&&!saved;attempt++){
     const question=(attempt?'请实际调用 generate_learning_resource 完成任务，不要只说明计划。':'')+'无需再确认，直接围绕思维导图节点「'+node.title+'」生成简明定制讲义。主题是工具调用的输入、执行和观察。面向已有一点编程基础的入门学习者，2章、每章2节，用所选知识库作依据。请生成真实候选资源供我预览，先不要存入我的学习资源。';
     console.log('STAGE real Agent generating lecture candidate');
     const result=await post('agent/ask-pi',{sessionId:sid,kbId:'course-beta',question,web:'off'});
     const events=(await post('sessions/events',{sessionId:sid})).events;saved=events.filter(e=>e.type==='resource/saved').at(-1)?.payload;
     console.log('TOOLS '+events.filter(e=>e.type==='tool/result').map(e=>e.payload.tool+':'+e.payload.ok).join(', '));
     if(!saved&&!result.ok)console.log('TURN '+result.message);
   }
   check('real Agent generated an actual lecture file',!!saved&&saved.kind==='lecture'&&saved.kbId==='course-alpha'&&fs.existsSync(saved.artifactPath));
   check('real candidate is not automatically confirmed',(await post('course/state',{kbId:'course-alpha'})).resources.length===0);
   check('missing confirmation is rejected',(await raw('course/commit',{sessionId:sid,path:saved.artifactPath,expectedResourceId:'',confirmed:false})).code!==0);
   const official=await post('course/commit',{sessionId:sid,path:saved.artifactPath,expectedResourceId:'',confirmed:true});
   check('user-confirmed real candidate binds exact version',official.learningId===saved.id&&official.learningVersion===saved.version&&fs.existsSync(official.path)&&official.path!==saved.artifactPath);
   browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1500,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base);await page.waitForSelector('#chat-input');await page.evaluate(()=>go('learn'));await page.waitForSelector('.course-node');
   const shots=path.join(root,'tmp/real-course-shots');fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,'real-mindmap.png')});await page.locator('.course-node[data-node="'+node.id+'"]').click();await page.waitForSelector('.course-resource-grid');await page.screenshot({path:path.join(shots,'real-resource-dialog.png')});
   check('real model results render without JavaScript errors',errors.length===0);
   console.log('RESULT=OK '+passed+' checks; '+Math.round((Date.now()-started)/1000)+'s; data='+dir);
 }finally{if(browser)await browser.close();core.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
