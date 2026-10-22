/* Real renderer + isolated Cangjie core. Only transport timing is changed;
 * requests still reach the core and persistence is read back through its API. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.ITN_PLAYWRIGHT_DIR?path.join(process.env.ITN_PLAYWRIGHT_DIR,'playwright'):'D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const repo=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'itn-request-feedback-')),portFile=path.join(dir,'port');
const core=spawn(path.join(repo,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+portFile,'--ui-dir='+path.join(repo,'shell/renderer'),'--seed-course-fixture=1'],{windowsHide:true,stdio:'ignore'});
let browser,failures=0;
const check=(name,ok,detail)=>{console.log((ok?'PASS ':'FAIL ')+name+(detail?' '+JSON.stringify(detail):''));if(!ok)failures++;};
(async()=>{
  try{
    for(let i=0;i<150&&!fs.existsSync(portFile);i++)await sleep(100);
    if(!fs.existsSync(portFile))throw Error('isolated core did not start');
    const base='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').trim();
    const post=async(name,body={})=>{const response=await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await response.json();if(json.code!==0)throw Error(name+': '+json.message);return json.data;};
    browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.waitForSelector('#chat-input');
    // Hold the first outbound write until both physical click attempts have happened.
    const held=async(endpoint,action)=>{
      let calls=0,release;const gate=new Promise(resolve=>release=resolve),pending=[],requests=[];
      const route=r=>{calls++;requests.push(r.request());const task=(async()=>{await gate;await r.continue();})();pending.push(task);return task;};
      await page.route('**/api/'+endpoint,route);
      try{await action(()=>calls);}finally{release();await Promise.all(pending);await Promise.all(requests.map(async request=>{const response=await request.response();if(response)await response.finished();}));await page.unroute('**/api/'+endpoint,route);}
      await page.waitForFunction(()=>busyActions.size===0);await sleep(200);return calls;
    };
    const clickAgain=async locator=>{const box=await locator.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await sleep(100);};
    const busy=locator=>locator.evaluate(b=>({disabled:b.disabled,busy:b.getAttribute('aria-busy'),text:b.textContent}));
    const stable=async locator=>{await page.locator('[data-feedback-check]').evaluateAll(bs=>bs.forEach(b=>b.removeAttribute('data-feedback-check')));await locator.evaluate(b=>b.setAttribute('data-feedback-check','active'));return page.locator('[data-feedback-check="active"]');};
    await page.evaluate(()=>{go('home');});await page.waitForSelector('#knowledge-workspace');
    await page.evaluate(()=>editKnowledgePoint());await page.locator('#knowledge-title').fill('request feedback audit');
    let button=await stable(page.getByRole('button',{name:'保存知识点',exact:true}));
    const createCalls=await held('knowledge/save',async()=>{await button.click();await sleep(100);const state=await busy(button);check('knowledge create shows busy before response',state.disabled&&state.busy==='true',state);await clickAgain(button);});
    check('knowledge create double click sends one write',createCalls===1,{calls:createCalls});
    let graph=await post('knowledge/graph');const node=graph.nodes.find(n=>n.title==='request feedback audit');
    check('knowledge creation persisted',!!node);
    await page.evaluate(n=>writeKnowledgeNote(n),node);await page.locator('#knowledge-note').fill('delayed note audit');
    button=await stable(page.getByRole('button',{name:'保存笔记',exact:true}));
    const noteCalls=await held('knowledge/note',async()=>{await button.click();await sleep(100);const state=await busy(button);check('knowledge note shows busy',state.disabled&&state.busy==='true',state);await clickAgain(button);});
    check('knowledge note double click sends one write',noteCalls===1,{calls:noteCalls});
    const fullNode=await post('knowledge/node',{id:node.id});
    check('knowledge note persists exactly once',(fullNode.notes||[]).filter(n=>n.text==='delayed note audit').length===1,{notes:fullNode.notes});
    await page.evaluate(()=>go('memory'));await page.locator('#memory-text').fill('delayed memory audit');button=await stable(page.getByRole('button',{name:'保存记忆',exact:true}));
    const memoryCalls=await held('learning/memory/save',async()=>{await button.click();await sleep(100);const state=await busy(button);check('memory save shows busy',state.disabled&&state.busy==='true',state);await clickAgain(button);});
    check('memory save double click sends one write',memoryCalls===1,{calls:memoryCalls});
    check('memory persisted',(await post('learning/memories')).memories.some(m=>m.text==='delayed memory audit'));
    await page.evaluate(()=>go('home'));await page.waitForSelector('#knowledge-workspace');button=page.getByRole('button',{name:'连线建议',exact:true});
    const suggestCalls=await held('knowledge/suggest-links',async()=>{await button.click();await sleep(100);await page.evaluate(async()=>{await go('memory');await go('home');});button=page.getByRole('button',{name:'连线建议',exact:true});await button.click();await sleep(100);});
    check('link suggestion survives navigation without a second model request',suggestCalls===1,{calls:suggestCalls});
    await page.evaluate(()=>document.querySelectorAll('.knowledge-dialog').forEach(d=>d.remove()));
    await page.evaluate(()=>editKnowledgePoint());button=await stable(page.getByRole('button',{name:'保存知识点',exact:true}));
    await button.click();await page.waitForFunction(()=>busyActions.size===0);await sleep(150);
    check('failed knowledge save restores retry',await button.isEnabled());
    await page.locator('#knowledge-title').fill('retry feedback audit');await button.click();await page.waitForFunction(()=>!document.getElementById('knowledge-title'));
    check('corrected knowledge save persists after error',(await post('knowledge/graph')).nodes.some(n=>n.title==='retry feedback audit'));
    const job=await post('course/generate',{kbId:'course-alpha'});let finished;
    for(let i=0;i<150;i++){finished=await post('course/job',{id:job.id});if(finished.status!=='running')break;await sleep(100);}
    if(finished.status!=='completed')throw Error('course fixture generation failed: '+JSON.stringify(finished));
    await page.evaluate(async()=>{state.kb='course-alpha';await go('learn');});await page.waitForSelector('.course-node');
    await page.locator('.course-node').first().click();button=await stable(page.locator('.course-resource-tile[data-kind="lecture"]').getByRole('button',{name:'去对话生成',exact:true}));
    const startCalls=await held('course/start',async()=>{await button.click();await sleep(100);const state=await busy(button);check('resource generation shows busy before session creation',state.disabled&&state.busy==='true',state);await clickAgain(button);});
    check('resource generation double click sends one start',startCalls===1,{calls:startCalls});
    await page.waitForSelector('#chat-input');await page.waitForFunction(()=>!state.busyTurn);await sleep(300);
    const courseState=await post('course/state',{kbId:'course-alpha'}),sid=await page.evaluate(()=>state.chatSessionId);
    await post('agent/ask-pi',{sessionId:sid,kbId:'course-alpha',question:'要求已说明，面向入门者，内容简短，直接生成这类学习资源。',perm:'auto',mode:'chat',confirmFileAccess:true});
    const candidate=(await post('sessions/events',{sessionId:sid})).events.filter(e=>e.type==='resource/saved').at(-1)?.payload;
    if(!candidate)throw Error('native fixture did not create a course candidate');
    await page.evaluate(f=>offerCourseSave(f),{sessionId:sid,path:candidate.artifactPath,title:'delayed course save',learningId:candidate.id,learningVersion:candidate.version});
    button=await stable(page.locator('.course-modal').getByRole('button',{name:/确认加入|确认替换/}));
    const commitCalls=await held('course/commit',async()=>{
      await button.click();await sleep(100);const selector=page.getByRole('combobox',{name:'收录到哪个节点'});
      const other=courseState.map.nodes.find(n=>n.id!==courseState.map.nodes[0].id);
      if(await selector.isEnabled())await selector.selectOption(other.id);
      else await selector.evaluate((select,id)=>{select.value=id;select.dispatchEvent(new Event('change'));},other.id);
      const state=await busy(button);check('changing course target cannot unlock a pending save',state.disabled&&state.busy==='true',state);await clickAgain(button);
    });
    check('course save sends one commit despite target change',commitCalls===1,{calls:commitCalls});
    const persisted=await post('course/state',{kbId:'course-alpha'});
    check('course save persists one confirmed version',persisted.resources.filter(r=>r.title==='delayed course save').length===1,{resources:persisted.resources.map(r=>({id:r.id,title:r.title})),toast:await page.locator('#toast').textContent()});
    await page.evaluate(()=>go('home'));await page.waitForSelector('#knowledge-workspace');
    const otherNode=(await post('knowledge/graph')).nodes.find(n=>n.id!==node.id);
    await page.evaluate(n=>linkKnowledgePoint(n),node);await page.locator('#knowledge-link-target').selectOption(otherNode.id);
    button=await stable(page.getByRole('button',{name:'添加连线',exact:true}));
    const linkCalls=await held('knowledge/link',async()=>{await button.click();await sleep(100);const state=await busy(button);check('manual link shows busy',state.disabled&&state.busy==='true',state);await clickAgain(button);});
    check('manual link double click sends one write',linkCalls===1,{calls:linkCalls});
    check('manual undirected link persists',(await post('knowledge/graph')).links.some(l=>(l.from===node.id&&l.to===otherNode.id)||(l.to===node.id&&l.from===otherNode.id)));
    const personalPath=path.join(dir,'personal-audit.md');fs.writeFileSync(personalPath,'# Personal save audit\n\nLocal test file.\n');
    const personalFile={path:personalPath,title:'delayed personal save'};
    await page.evaluate(async file=>{state.chatSessionId='';await offerPersonalSave(file);},personalFile);
    button=await stable(page.getByRole('button',{name:'确认存入',exact:true}));
    const personalCalls=await held('personal/save',async()=>{
      await button.click();await sleep(100);const state=await busy(button);check('personal save shows busy',state.disabled&&state.busy==='true',state);await clickAgain(button);
      await page.evaluate(file=>offerPersonalSave(file),personalFile);await page.getByRole('button',{name:'确认存入',exact:true}).click();await sleep(100);
    });
    check('reopening personal confirmation cannot repeat a pending save',personalCalls===1,{calls:personalCalls});
    check('personal save persists one copy',(await post('personal/list')).resources.filter(r=>r.title==='delayed personal save').length===1);
    await page.evaluate(()=>document.querySelectorAll('.personal-save-confirm').forEach(d=>d.remove()));
    // Include import, harvest, and knowledge-base actions in the full page audit.
    if(process.argv.includes('--audit-app')){
      const importPath=path.join(dir,'import-audit');fs.mkdirSync(importPath);fs.writeFileSync(path.join(importPath,'sample.md'),'# Local import audit\n\nOnly isolated test material.\n');
      await page.evaluate(()=>go('settings','kb'));await page.locator('#kb-import-path').fill(importPath);
      const importCalls=await held('kb/import',async()=>{
        await page.getByRole('button',{name:'仅添加',exact:true}).click();await sleep(100);
        await page.evaluate(async()=>{await go('memory');await go('settings','kb');});await page.locator('#kb-import-path').fill(importPath);
        check('import recreated buttons keep loading feedback',await page.getByRole('button',{name:'正在添加…',exact:true}).first().isDisabled());
        await clickAgain(page.getByRole('button',{name:'正在添加…',exact:true}).last());await sleep(100);
      });
      check('app.js import stays locked after page recreation',importCalls===1,{calls:importCalls});
      await page.waitForLoadState('networkidle');
      const server=require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<html><title>Isolated harvest audit</title><body><h1>Local knowledge audit</h1><p>Only local fixture material; no external network.</p></body></html>');});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      try{
        await post('kb/stage',{kind:'url',url:'http://127.0.0.1:'+server.address().port+'/audit'});
        await page.evaluate(async()=>{state.kb='course-alpha';await renderHarvest($('view'),true);});
        const source=page.locator('.harvest-source').first(),select=source.getByRole('combobox'),confirmed=source.getByRole('checkbox');
        await select.selectOption('course-alpha');await confirmed.check();button=await stable(source.getByRole('button',{name:'确认并入并建索引',exact:true}));
        const ingestCalls=await held('kb/ingest',async()=>{
          await button.click();await sleep(100);
          if(await confirmed.isEnabled()){await confirmed.uncheck();await confirmed.check();}
          else await confirmed.evaluate(box=>{box.checked=false;box.dispatchEvent(new Event('change'));box.checked=true;box.dispatchEvent(new Event('change'));});
          check('app.js harvest confirmation cannot unlock an active ingest',await button.isDisabled());await clickAgain(button);
        });
        check('app.js harvest ingest sends one write after confirmation change',ingestCalls===1,{calls:ingestCalls});
      }finally{await new Promise(resolve=>server.close(resolve));}
      await page.evaluate(()=>go('settings','kb'));await page.waitForSelector('#kb-import-path');
      button=await stable(page.getByRole('button',{name:/^(建立索引|重建索引)$/}).first());
      const buildCalls=await held('kb/build',async()=>{
        await button.click();await sleep(100);check('index build shows loading feedback',await button.isDisabled());await clickAgain(button);
      });
      check('index build double click sends one request',buildCalls===1,{calls:buildCalls});
      button=await stable(page.getByRole('button',{name:'整理',exact:true}).first());
      const organizeCalls=await held('kb/organize',async()=>{
        await button.click();await sleep(100);check('knowledge-base organize shows loading feedback',await button.isDisabled());await clickAgain(button);
      });
      check('knowledge-base organize double click sends one request',organizeCalls===1,{calls:organizeCalls});
    }
    check('no renderer runtime errors',errors.length===0,errors);
    console.log('RESULT failures='+failures+' temporaryData='+dir);process.exitCode=failures?1:0;
  }finally{if(browser)await browser.close();core.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
