const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const norm=p=>String(p||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-knowledge-')),mp=await freePort(),pf=path.join(dir,'port');
 const projRoot=path.join(dir,'project');fs.mkdirSync(projRoot);
 const mock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(mp)],{windowsHide:true,stdio:'ignore',env:{...process.env,ITN_MOCK_CHUNK_DELAY_MS:'0'}});
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});
 let browser,passed=0;
 const check=(n,b)=>{if(!b)throw Error(n);passed++;console.log('PASS '+n);};
 const until=async(fn,ms=25000)=>{const t0=Date.now();for(;;){if(await fn())return;if(Date.now()-t0>ms)throw Error('等待条件超时');await sleep(150);}};
 try{
  for(let i=0;i<100&&!fs.existsSync(pf);i++)await sleep(100);
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const raw=async(u,b)=>{const r=await fetch(base+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json();};
  const post=async(u,b)=>{const j=await raw(u,b);if(j.code!==0)throw Error(u+': '+j.message);return j.data;};
  await post('/api/models/save',{id:'mock',name:'test',baseUrl:'http://127.0.0.1:'+mp+'/v1',apiKey:'test',model:'mock'});
  await post('/api/models/roles',{chatModelId:'mock'});

  const g0=await post('/api/knowledge/graph',{});
  check('knowledge network starts with no nodes and no edges',g0.nodes.length===0&&g0.links.length===0);

  const proj=await post('/api/projects/save',{name:'知识网络测试项目',root:projRoot});
  const sA=(await post('/api/sessions/new',{projectId:proj.id})).sessionId;
  const qA='知识点测试：请解释输入与输出的约定';
  const rA=await post('/api/agent/ask-pi',{sessionId:sA,question:qA,web:'off'});
  check('an agent turn can call record_knowledge_point',rA.ok===true);

  let g=await post('/api/knowledge/graph',{});
  check('a substantive conversation creates exactly one main node',g.nodes.length===1&&g.links.length===0);
  const nodeId=g.nodes[0].id;
  let node=await post('/api/knowledge/node',{id:nodeId});
  const rec=node.records[0]||{};
  check('the record keeps question, time, session and source workspace',node.records.length===1&&rec.question===qA&&rec.sessionId===sA&&!!rec.at&&rec.workspaceName==='知识网络测试项目'&&norm(rec.workspaceRoot)===norm(projRoot));

  const sB=(await post('/api/sessions/new',{})).sessionId;
  await post('/api/agent/ask-pi',{sessionId:sB,question:'知识点别名测试：请解释输入与输出',web:'off'});
  g=await post('/api/knowledge/graph',{});node=await post('/api/knowledge/node',{id:nodeId});
  check('an exact alias merges the record into the existing node',g.nodes.length===1&&node.recordCount===2&&node.records.some(r=>r.sessionId===sB));
  check('model records never overwrite the existing title or definition',node.title==='输入与输出'&&node.definition.includes('先写清输入样例')&&node.userEdited===false);

  await post('/api/knowledge/save',{id:nodeId,title:'输入与输出（本人修订）',definition:'本人修订：先定输入输出约定，再执行并留验证依据。',aliases:['I/O 约定']});
  node=await post('/api/knowledge/node',{id:nodeId});
  check('a manual edit is marked as user-edited',node.userEdited===true&&node.title==='输入与输出（本人修订）');

  const sC=(await post('/api/sessions/new',{})).sessionId;
  await post('/api/agent/ask-pi',{sessionId:sC,question:qA,web:'off'});
  node=await post('/api/knowledge/node',{id:nodeId});
  check('later model records keep the user-edited definition and title',node.definition.startsWith('本人修订')&&node.title==='输入与输出（本人修订）'&&node.recordCount===3);
  g=await post('/api/knowledge/graph',{});
  check('records alone never infer edges or child nodes',g.links.length===0&&g.nodes.length===1);

  check('self links are rejected',(await raw('/api/knowledge/link',{from:nodeId,to:nodeId,label:'自连'})).code!==0);
  check('links to missing nodes are rejected',(await raw('/api/knowledge/link',{from:nodeId,to:'kp-missing'})).code!==0);

  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');
  await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:15000}).catch(()=>{});

  await page.evaluate(pid=>startAgentTask('知识点测试：请解释输入与输出的约定',pid),proj.id);
  await page.waitForSelector('.knowledge-recorded',{timeout:60000});
  check('the chat turn shows a knowledge-recorded card',(await page.locator('.knowledge-recorded').innerText()).includes('输入与输出'));
  await page.locator('.knowledge-recorded').click();
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  check('the card opens the detail with the user-edited definition',(await page.locator('#knowledge-detail .knowledge-definition').innerText()).includes('本人修订'));

  const uiSession=await page.evaluate(()=>state.chatSessionId);
  const countText0=await page.locator('#knowledge-count').innerText();
  check('the overview counts one node and zero manual links',countText0.includes('1 个知识点')&&countText0.includes('0 条手动连接'));
  check('the node list shows four records for the point',(await page.locator('.knowledge-node-button').innerText()).includes('4 次记录'));
  check('the empty-state prompt is gone once a node exists',await page.locator('.knowledge-empty').count()===0);
  check('the detail shows the source workspace of the newest record',(await page.locator('#knowledge-detail').innerText()).includes('知识网络测试项目'));

  await page.locator('#knowledge-detail .knowledge-record').first().getByRole('button',{name:'回到这次对话'}).click();
  await page.waitForSelector('.turn-block.search-focus',{timeout:20000});
  check('a source record reveals and highlights the exact chat turn',(await page.locator('.turn-block.search-focus').innerText()).includes('请解释输入与输出的约定'));
  check('revealing jumps back to the chat page',await page.evaluate(()=>current==='chat'));

  await page.evaluate(()=>go('home'));await page.waitForSelector('.knowledge-network');
  await page.locator('.knowledge-node-button').first().click();
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  await page.getByRole('button',{name:'写笔记',exact:true}).click();
  await page.locator('#knowledge-note').fill('MANUAL-NOTE-9527 先写清输入再谈输出');
  await page.getByRole('button',{name:'保存笔记',exact:true}).click();
  await until(async()=>(await page.locator('#knowledge-detail').innerText()).includes('MANUAL-NOTE-9527'));
  check('the node detail lists the personal note',(await page.locator('#knowledge-detail').innerText()).includes('MANUAL-NOTE-9527'));
  const noteHits=await post('/api/personal/search',{query:'MANUAL-NOTE-9527'});
  check('the note enters the global personal search index',noteHits.hits.some(h=>h.type==='note'||h.type==='knowledge'));

  await page.locator('#knowledge-search').fill('MANUAL-NOTE');
  await until(async()=>await page.locator('.knowledge-node-button').count()===1);
  check('network search filters down to the indexed hit',await page.locator('.knowledge-node-button').count()===1);
  await page.locator('#knowledge-search').fill('绝不存在-ZZQ-7788');
  await until(async()=>await page.locator('.knowledge-node-button').count()===0);
  check('unmatched search shows nothing instead of everything',await page.locator('.knowledge-node-button').count()===0);
  await page.locator('#knowledge-search').fill('');
  await until(async()=>await page.locator('.knowledge-node-button').count()===1);

  await page.getByRole('button',{name:'添加知识点',exact:true}).click();
  await page.locator('#knowledge-title').fill('验证与边界');
  await page.locator('#knowledge-definition').fill('验证要覆盖正常、最小、最大与异常样例。');
  await page.getByRole('button',{name:'保存知识点',exact:true}).click();
  await until(async()=>await page.locator('.knowledge-node-button').count()===2);
  check('manual node creation opens its own detail',(await page.locator('#knowledge-detail').innerText()).includes('验证与边界'));
  g=await post('/api/knowledge/graph',{});
  const second=g.nodes.find(n=>n.title==='验证与边界').id;

  await page.getByRole('button',{name:'手动连线',exact:true}).click();
  await page.selectOption('#knowledge-link-target',nodeId);
  await page.locator('#knowledge-link-label').fill('对比');
  await page.getByRole('button',{name:'添加连线',exact:true}).click();
  await until(async()=>(await page.locator('#knowledge-detail').innerText()).includes('对比'));
  g=await post('/api/knowledge/graph',{});
  check('manual linking stores one edge and renders it in the detail',g.links.length===1&&(await page.locator('#knowledge-detail').innerText()).includes('对比'));
  await page.locator('#knowledge-detail').getByRole('button',{name:'移除',exact:true}).click();
  await until(async()=>(await post('/api/knowledge/graph',{})).links.length===0);
  check('removing the only manual edge returns to zero edges',true);

  await page.getByRole('button',{name:'手动连线',exact:true}).click();
  await page.selectOption('#knowledge-link-target',nodeId);
  await page.getByRole('button',{name:'添加连线',exact:true}).click();
  await until(async()=>(await post('/api/knowledge/graph',{})).links.length===1);

  await page.locator('#rail-search-btn').click();await page.waitForSelector('.palette-box');
  await page.fill('#palette-input','本人修订');
  await page.waitForFunction(()=>palette.items.some(x=>x.group==='知识点'),null,{timeout:8000});
  await page.locator('.palette-item').filter({hasText:'本人修订'}).filter({hasText:'章节'}).first().click();
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  check('the global palette finds the knowledge point and opens it',(await page.locator('#knowledge-detail .knowledge-definition').innerText()).includes('本人修订'));

  const shots=path.join(root,'tmp/knowledge-shots');fs.mkdirSync(shots,{recursive:true});
  await page.evaluate(()=>go('home'));await page.waitForSelector('.knowledge-network');
  await page.locator('.knowledge-node-button').filter({hasText:'输入与输出（本人修订）'}).click();
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  await page.waitForFunction(()=>knowledgeNet.projected.length===2);
  check('the canvas projects every node and edge',await page.evaluate(()=>knowledgeNet.projected.length===2&&knowledgeNet.data.links.length===1));
  await page.screenshot({path:path.join(shots,'network-light.png')});
  await page.evaluate(()=>applyTheme('dark'));await sleep(900);
  await page.screenshot({path:path.join(shots,'network-dark.png')});
  await page.evaluate(()=>applyTheme('light'));await sleep(700);
  await page.setViewportSize({width:1024,height:768});
  check('no horizontal overflow at 1024px',await page.locator('#view').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  check('detail sits beside the canvas on wide screens',(await page.locator('#knowledge-workspace').evaluate(e=>getComputedStyle(e).gridTemplateColumns)).trim().includes(' '));
  await page.screenshot({path:path.join(shots,'network-compact.png')});
  await page.setViewportSize({width:820,height:768});
  await until(async()=>!(await page.locator('#knowledge-workspace').evaluate(e=>getComputedStyle(e).gridTemplateColumns)).trim().includes(' '));
  check('detail stacks below the canvas on narrow screens',true);
  await page.setViewportSize({width:1440,height:960});

  await page.getByRole('button',{name:'提问',exact:true}).click();
  check('the ask dialog defaults to the record source workspace',await page.locator('#knowledge-question-project').inputValue()===proj.id);
  check('the dialog explains the source directory instead of guessing',(await page.locator('.knowledge-dialog').innerText()).includes('来源记录中的目录'));
  await page.getByRole('button',{name:'新建会话并提问',exact:true}).click();
  await page.waitForFunction(pid=>state.chatProject===pid&&!!state.chatSessionId,proj.id,{timeout:20000});
  check('asking from a node opens a new session in its source workspace',true);
  await sleep(400);
  await until(async()=>(await page.locator('#chat-thread').innerText()).includes('请进一步讲解'),20000);
  await until(async()=>(await page.locator('#chat-thread').innerText()).includes('知识点背景'),20000);
  check('the new session carries the question and the node context',true);
  await page.waitForFunction(()=>!state.busyTurn,null,{timeout:60000});

  await post('/api/projects/delete',{id:proj.id});
  await page.evaluate(()=>go('home'));await page.waitForSelector('.knowledge-network');
  await page.locator('.knowledge-node-button').filter({hasText:'输入与输出（本人修订）'}).click();
  await page.getByRole('button',{name:'提问',exact:true}).click();
  check('a deleted source workspace is marked and disabled in the dialog',(await page.locator('#knowledge-question-project option[disabled]').first().innerText()).startsWith('已删除工作区'));
  check('the dialog refuses to silently switch directories',(await page.locator('.knowledge-dialog').innerText()).includes('原工作区已删除，请明确选择新的去向'));
  check('starting stays blocked while the deleted workspace is selected',await page.getByRole('button',{name:'新建会话并提问',exact:true}).isDisabled());
  await page.selectOption('#knowledge-question-project','');
  check('choosing a new destination unblocks the start button',!(await page.getByRole('button',{name:'新建会话并提问',exact:true}).isDisabled()));
  await page.getByRole('button',{name:'取消',exact:true}).click();

  await post('/api/knowledge/note',{id:second,text:'MANUAL-NOTE-2211 删除节点后仍保留'});
  await page.evaluate(()=>go('home'));await page.waitForSelector('.knowledge-network');
  await page.locator('.knowledge-node-button').filter({hasText:'验证与边界'}).click();
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  await page.getByRole('button',{name:'删除知识点',exact:true}).click();
  await page.getByRole('button',{name:'确认删除',exact:true}).click();
  await until(async()=>await page.locator('.knowledge-node-button').count()===1);
  g=await post('/api/knowledge/graph',{});
  check('deleting a node removes it and its links in one step',g.nodes.length===1&&g.links.length===0&&g.nodes[0].id===nodeId);
  const kept=await post('/api/personal/search',{query:'MANUAL-NOTE-2211'});
  check('notes of a deleted node stay searchable in the notes page',kept.hits.some(h=>h.type==='note'));

  check('no JavaScript exceptions',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; shots: '+shots+' ; data: '+dir);
 }finally{if(browser)await browser.close();core.kill();mock.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
