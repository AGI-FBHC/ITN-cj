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

  await post('/api/knowledge/save',{id:nodeId,title:'输入与输出（本人修订）',definition:'本人修订：先定输入输出约定，再执行并留验证依据。',color:'#e07a5f',aliases:['I/O 约定']});
  node=await post('/api/knowledge/node',{id:nodeId});
  check('a manual edit is marked as user-edited',node.userEdited===true&&node.title==='输入与输出（本人修订）');
  check('the node color is stored as #RRGGBB',node.color==='#E07A5F');
  check('invalid node colors are rejected',(await raw('/api/knowledge/save',{id:nodeId,title:'输入与输出（本人修订）',definition:'不该写进去',color:'red'})).code!==0);
  check('the rejected save left the color untouched',(await post('/api/knowledge/node',{id:nodeId})).color==='#E07A5F');

  const sC=(await post('/api/sessions/new',{})).sessionId;
  await post('/api/agent/ask-pi',{sessionId:sC,question:qA,web:'off'});
  node=await post('/api/knowledge/node',{id:nodeId});
  check('later model records keep the user-edited definition and title',node.definition.startsWith('本人修订')&&node.title==='输入与输出（本人修订）'&&node.recordCount===3);
  check('model records never overwrite the user-picked color',node.color==='#E07A5F');
  g=await post('/api/knowledge/graph',{});
  check('records alone never infer edges or child nodes',g.links.length===0&&g.nodes.length===1);

  // —— Lumin 能否"看见"知识网络：空 query 检索必须返回总览而不是空数组（2026-10-17 修复回归）
  const sD=(await post('/api/sessions/new',{})).sessionId;
  const rD=await post('/api/agent/ask-pi',{sessionId:sD,question:'知识网络可见性测试：你能看到我的知识网络吗',web:'off'});
  check('the visibility turn completes',rD.ok===true);
  const evsD=(await post('/api/sessions/events',{sessionId:sD})).events;
  const vis=(evsD.find(e=>e.type==='tool/result'&&e.payload.tool==='search_personal_resources')||{}).payload||{};
  check('an empty-query search returns counts and hits, not a blank list',vis.ok===true&&vis.details&&vis.details.counts&&vis.details.counts.knowledge>=1&&Array.isArray(vis.details.hits)&&vis.details.hits.length>=1);
  check('the overview names the existing knowledge node',JSON.stringify(vis.details&&vis.details.hits||[]).includes('输入与输出'));
  const lc=(evsD.find(e=>e.type==='tool/result'&&e.payload.tool==='get_learning_context')||{}).payload||{};
  check('get_learning_context also reports the knowledge total',!!(lc.details&&lc.details.knowledge)&&lc.details.knowledge.total>=1&&lc.details.knowledge.recent.length>=1);

  check('self links are rejected',(await raw('/api/knowledge/link',{from:nodeId,to:nodeId,label:'自连'})).code!==0);
  check('links to missing nodes are rejected',(await raw('/api/knowledge/link',{from:nodeId,to:'kp-missing'})).code!==0);

  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');
  await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:15000}).catch(()=>{});
  const shots=path.join(root,'tmp/knowledge-shots');fs.mkdirSync(shots,{recursive:true});
  const openNode=async(id)=>{await page.evaluate(async nid=>{await go('home');await openKnowledgePoint(nid);},id);await page.waitForSelector('#knowledge-detail:not([hidden])');};

  // —— 页面框架：旧总览内容全部不在；tab 已改名；默认网络图
  await page.evaluate(()=>go('home'));await page.waitForSelector('.knowledge-network');
  check('the old overview content is gone from this page',await page.locator('.study-continue').count()===0&&await page.locator('.setup-banner').count()===0&&await page.locator('.home-network').count()===0);
  check('the tab is renamed to the knowledge network',(await page.locator('.workspace-tabs [data-page="home"]').innerText()).includes('知识网络'));
  check('the page defaults to the graph view',await page.locator('.knowledge-seg[data-view="graph"].on').count()===1&&await page.locator('.knowledge-canvas').count()===1);
  const pill=(await page.locator('#knowledge-count').innerText());
  check('counts live in a single pill',pill.includes('1 个知识点')&&pill.includes('0 条手动连接'));
  check('the graph view fills the page without a scrollbar',await page.locator('#view').evaluate(e=>e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1));
  const samplePos=async(id)=>page.evaluate(nid=>{const p=knowledgeNet.projected.find(x=>x.id===nid);return p?{x:p.x,y:p.y}:null;},id);
  const drift0=await samplePos(nodeId);await sleep(1300);const drift1=await samplePos(nodeId);
  check('nodes drift slowly while untouched',!!drift0&&!!drift1&&Math.hypot(drift1.x-drift0.x,drift1.y-drift0.y)>0.8);

  // —— 点选：抽屉打开不改变画布高度、抖动也算点击、页面无滚动条
  await post('/api/knowledge/save',{title:'点选测试节点',definition:'用于点选与抽屉稳定性回归。'});
  await page.evaluate(()=>refreshKnowledgeNetwork());
  await until(async()=>await page.evaluate(()=>knowledgeNet.data.nodes.length===2));
  const rectNow=async()=>page.evaluate(()=>{const c=document.querySelector('.knowledge-canvas').getBoundingClientRect();return{x:Math.round(c.x),y:Math.round(c.y),w:Math.round(c.width),h:Math.round(c.height)};});
  const rect0=await rectNow();
  const pickProj=async(skip)=>page.evaluate(s=>{const arr=knowledgeNet.projected.filter(q=>q.id!==(s||knowledgeNet.selected||''));const q=arr[arr.length-1];return{x:q.x,y:q.y,id:q.id};},skip||'');
  const probeA=await pickProj();
  await page.mouse.click(rect0.x+probeA.x,rect0.y+probeA.y);
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  check('clicking a node on the canvas selects it',await page.evaluate(nid=>knowledgeNet.selected===nid,probeA.id));
  const rect1=await rectNow();
  check('opening the drawer no longer resizes the canvas height',Math.abs(rect1.h-rect0.h)<=2);
  check('the drawer opening keeps the page free of scrollbars',await page.locator('#view').evaluate(e=>e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1));
  check('every node stays inside the visible canvas',await page.evaluate(()=>{const c=document.querySelector('.knowledge-canvas');return knowledgeNet.projected.every(p=>p.x>=0&&p.y>=0&&p.x<=c.clientWidth&&p.y<=c.clientHeight);}));
  const yaw0=await page.evaluate(()=>knowledgeNet.yaw);
  const probeB=await pickProj(await page.evaluate(()=>knowledgeNet.selected));
  const rect2=await rectNow();
  await page.mouse.move(rect2.x+probeB.x,rect2.y+probeB.y);await page.mouse.down();await page.mouse.move(rect2.x+probeB.x+3,rect2.y+probeB.y+1);await page.mouse.up();
  await until(async()=>await page.evaluate(nid=>knowledgeNet.selected===nid,probeB.id));
  check('a slightly shaky click still selects the node',true);
  check('tiny pointer jitter no longer nudges the camera',await page.evaluate(y=>Math.abs(knowledgeNet.yaw-y)<1e-9,yaw0));
  const gRect=await rectNow();
  const probeC=await pickProj(await page.evaluate(()=>knowledgeNet.selected));
  await page.mouse.move(gRect.x+probeC.x,gRect.y+probeC.y);await page.mouse.down();await page.mouse.move(gRect.x+probeC.x+40,gRect.y+probeC.y+20);await page.mouse.up();
  check('a real drag rotates instead of selecting',await page.evaluate(y=>Math.abs(knowledgeNet.yaw-y)>1e-6,yaw0)&&await page.evaluate(nid=>knowledgeNet.selected!==nid,probeC.id));
  await page.getByRole('button',{name:'收起',exact:true}).click();
  await until(async()=>await page.evaluate(()=>document.getElementById('knowledge-detail').hidden));

  // —— 聊天卡 → 详情抽屉
  await page.evaluate(pid=>startAgentTask('知识点测试：请解释输入与输出的约定',pid),proj.id);
  await page.waitForSelector('.knowledge-recorded',{timeout:60000});
  check('the chat turn shows a knowledge-recorded card',(await page.locator('.knowledge-recorded').innerText()).includes('输入与输出'));
  await page.locator('.knowledge-recorded').click();
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  check('the card opens the wide drawer with the user-edited definition',(await page.locator('#knowledge-detail .knowledge-definition').innerText()).includes('本人修订'));
  check('the drawer offers four icon actions',await page.locator('#knowledge-detail .knowledge-act').count()===4&&await page.locator('#knowledge-detail .knowledge-act[data-act="ask"]').count()===1);
  check('drawer sections group concept, records and notes',await page.locator('#knowledge-detail .knowledge-sec').count()>=3);
  const frozen0=await samplePos(nodeId);await sleep(1100);const frozen1=await samplePos(nodeId);
  check('the selected node stops drifting',!!frozen0&&!!frozen1&&Math.hypot(frozen1.x-frozen0.x,frozen1.y-frozen0.y)<=0.8);
  check('the drawer shows the source workspace of the newest record',(await page.locator('#knowledge-detail').innerText()).includes('知识网络测试项目'));

  // —— 快速换色：点头部色点
  check('the drawer header shows the node color dot',await page.locator('#knowledge-detail .knowledge-color-dot').count()===1);
  await page.locator('#knowledge-detail .knowledge-color-dot').click();
  await page.waitForSelector('.knowledge-pop .knowledge-swatch');
  await page.locator('.knowledge-pop .knowledge-swatch[data-color="#2FB8A6"]').click();
  await until(async()=>(await post('/api/knowledge/node',{id:nodeId})).color==='#2FB8A6');
  check('picking a swatch on the dot saves the color immediately',true);
  // 色点要等抽屉按服务端结果重渲染后才变色：这里等 DOM 条件而不是单次读取，真不更新会超时失败
  let dotFollows=false;
  try{await until(async()=>{dotFollows=await page.locator('#knowledge-detail .knowledge-color-dot').evaluate(e=>getComputedStyle(e).backgroundColor==='rgb(47, 184, 166)');return dotFollows;});}catch(e){}
  check('the drawer dot follows the new color',dotFollows);

  // —— 编辑弹层：宽版两列 + 预览球 + 调色盘
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  check('the edit sheet is wide with two columns',await page.locator('.knowledge-dialog .task-modal-card.wide').count()===1&&await page.locator('.knowledge-edit-cols').count()===1);
  check('the edit sheet previews the node orb',await page.locator('.knowledge-preview-orb').count()===1);
  check('the palette keeps the native picker and nine swatches',await page.locator('#knowledge-color-picker').count()===1&&await page.locator('.knowledge-dialog .knowledge-swatch').count()===9);
  await page.locator('.knowledge-swatch[data-color="#C77DFF"]').click();
  await page.getByRole('button',{name:'保存知识点',exact:true}).click();
  await until(async()=>(await post('/api/knowledge/node',{id:nodeId})).color==='#C77DFF');
  check('saving from the palette persists through the edit sheet',true);

  // —— 笔记（铅笔）
  check('the notes section offers a pencil button',await page.locator('.knowledge-note-add').count()===1);
  await page.locator('.knowledge-note-add').click();
  await page.locator('#knowledge-note').fill('MANUAL-NOTE-9527 先写清输入再谈输出');
  await page.getByRole('button',{name:'保存笔记',exact:true}).click();
  await until(async()=>(await page.locator('#knowledge-detail').innerText()).includes('MANUAL-NOTE-9527'));
  check('the drawer lists the personal note',true);
  check('the note enters the global personal search index',(await post('/api/personal/search',{query:'MANUAL-NOTE-9527'})).hits.some(h=>h.type==='note'||h.type==='knowledge'));

  // —— 图内搜索：画布高亮 + 计数
  await page.locator('#knowledge-search').fill('MANUAL-NOTE');
  await until(async()=>await page.evaluate(()=>knowledgeNet.visible&&knowledgeNet.visible.length===1));
  check('graph search narrows to the indexed hit',true);
  await page.locator('#knowledge-search').fill('绝不存在-ZZQ-7788');
  await until(async()=>await page.evaluate(()=>knowledgeNet.visible&&knowledgeNet.visible.length===0));
  check('unmatched search shows nothing instead of everything',true);
  await page.locator('#knowledge-search').fill('');
  await until(async()=>await page.evaluate(()=>knowledgeNet.visible===null));
  check('clearing search restores the whole graph',true);

  // —— 手动新增节点 + 连线 + 关系说明开关
  await page.evaluate(()=>editKnowledgePoint());
  await page.locator('#knowledge-title').fill('验证与边界');
  await page.locator('#knowledge-definition').fill('验证要覆盖正常、最小、最大与异常样例。');
  await page.getByRole('button',{name:'保存知识点',exact:true}).click();
  await until(async()=>(await post('/api/knowledge/graph',{})).nodes.length===3);
  g=await post('/api/knowledge/graph',{});const second=g.nodes.find(n=>n.title==='验证与边界').id;
  await until(async()=>(await page.locator('#knowledge-detail').innerText()).includes('验证与边界'));
  check('manual node creation opens its own drawer',true);
  await page.getByRole('button',{name:'手动连线',exact:true}).click();
  await page.selectOption('#knowledge-link-target',nodeId);
  await page.locator('#knowledge-link-label').fill('对比');
  await page.getByRole('button',{name:'添加连线',exact:true}).click();
  await until(async()=>await page.evaluate(()=>knowledgeNet.linkLabels.some(l=>l.text==='对比')));
  check('the relation label is drawn on the connection line',true);
  check('manual linking stores one edge',(await post('/api/knowledge/graph',{})).links.length===1);
  await page.locator('#knowledge-detail').getByRole('button',{name:'移除',exact:true}).click();
  await until(async()=>(await post('/api/knowledge/graph',{})).links.length===0);
  check('removing the only manual edge returns to zero edges',true);
  await page.getByRole('button',{name:'手动连线',exact:true}).click();
  await page.selectOption('#knowledge-link-target',nodeId);await page.locator('#knowledge-link-label').fill('对比');
  await page.getByRole('button',{name:'添加连线',exact:true}).click();
  await until(async()=>await page.evaluate(()=>knowledgeNet.linkLabels.some(l=>l.text==='对比')));
  await page.locator('.knowledge-labels-toggle').click();
  await until(async()=>await page.evaluate(()=>knowledgeNet.linkLabels.length===0&&!knowledgeNet.showLinkLabels)&&(await post('/api/prefs/get',{})).knowledgeLinkLabels==='0');
  check('the icon toggle hides the relation labels and stores the preference',true);
  await page.locator('.knowledge-labels-toggle').click();
  await until(async()=>await page.evaluate(()=>knowledgeNet.linkLabels.some(l=>l.text==='对比'))&&(await post('/api/prefs/get',{})).knowledgeLinkLabels==='1');
  check('turning the labels back on restores them',true);

  // —— 时间线视图
  await page.locator('.knowledge-seg[data-view="timeline"]').click();
  await page.waitForSelector('.knowledge-timeline');
  check('the timeline replaces the canvas',await page.locator('.knowledge-canvas').count()===0&&await page.locator('.knowledge-timeline').count()===1);
  check('the timeline is not force-stretched and scrolls with the page',await page.evaluate(()=>{const pg=document.querySelector('.knowledge-network');const tl=document.querySelector('.knowledge-timeline');return pg.dataset.view==='timeline'&&getComputedStyle(tl).overflowY==='visible';}));
  check('the range selector defaults to all',await page.locator('#knowledge-range').inputValue()==='0');
  check('the timeline groups entries by day',await page.locator('.knowledge-day').count()>=1);
  const recEv=page.locator('.knowledge-ev').filter({hasText:'请解释输入与输出的约定'}).first();
  check('records appear as cards with question and workspace',(await recEv.innerText()).includes('知识网络测试项目'));
  check('a record card links back to the chat and to the graph',await recEv.getByRole('button',{name:'回到这次对话'}).count()===1&&await recEv.getByRole('button',{name:'在图里看'}).count()===1);
  check('a record-less manual node shows as a dashed created entry',await page.locator('.knowledge-ev.mini').count()>=1&&(await page.locator('.knowledge-ev.mini').first().innerText()).includes('手动添加'));
  await page.locator('#knowledge-search').fill('绝不存在-ZZQ-7788');
  await until(async()=>await page.locator('.knowledge-ev').count()===0);
  check('unmatched timeline search shows nothing',true);
  await page.locator('#knowledge-search').fill('解释输入与输出');
  await until(async()=>await page.locator('.knowledge-ev').count()>=3);
  check('timeline search matches the question text',true);
  await page.locator('#knowledge-search').fill('');
  await until(async()=>await page.locator('.knowledge-ev').count()>=5);
  await page.screenshot({path:path.join(shots,'network-timeline.png')});
  await page.locator('.knowledge-ev').filter({hasText:'请解释输入与输出的约定'}).first().getByRole('button',{name:'在图里看'}).click();
  await page.waitForSelector('.knowledge-canvas');
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  check('在图里看 returns to the graph with the node selected',await page.evaluate(nid=>knowledgeNet.selected===nid,nodeId));

  // —— 视图偏好持久化
  await page.locator('.knowledge-seg[data-view="timeline"]').click();await page.waitForSelector('.knowledge-timeline');
  await page.reload({waitUntil:'load'});
  await page.waitForFunction(()=>state.knowledgeView==='timeline',null,{timeout:15000});
  await page.evaluate(()=>go('home'));await page.waitForSelector('.knowledge-timeline');
  check('the chosen view survives a reload',true);
  await page.locator('.knowledge-seg[data-view="graph"]').click();await page.waitForSelector('.knowledge-canvas');

  // —— 提问来源工作区 / 删除项目后的去向
  await openNode(nodeId);
  await page.getByRole('button',{name:'提问',exact:true}).click();
  check('the ask dialog defaults to the record source workspace',await page.locator('#knowledge-question-project').inputValue()===proj.id);
  check('the dialog explains the source directory',(await page.locator('.knowledge-dialog').innerText()).includes('来源记录中的目录'));
  await page.getByRole('button',{name:'新建会话并提问',exact:true}).click();
  await page.waitForFunction(pid=>state.chatProject===pid&&!!state.chatSessionId,proj.id,{timeout:20000});
  await sleep(400);
  await until(async()=>(await page.locator('#chat-thread').innerText()).includes('请进一步讲解'),20000);
  check('asking from a node opens a session in its source workspace',true);
  await post('/api/projects/delete',{id:proj.id});
  await openNode(nodeId);
  await page.getByRole('button',{name:'提问',exact:true}).click();
  check('a deleted source workspace is marked and disabled',(await page.locator('#knowledge-question-project option[disabled]').first().innerText()).startsWith('已删除工作区'));
  check('the dialog refuses to silently switch directories',(await page.locator('.knowledge-dialog').innerText()).includes('原工作区已删除，请明确选择新的去向'));
  check('starting stays blocked with the deleted workspace selected',await page.getByRole('button',{name:'新建会话并提问',exact:true}).isDisabled());
  await page.selectOption('#knowledge-question-project','');
  check('choosing a new destination unblocks the start button',!(await page.getByRole('button',{name:'新建会话并提问',exact:true}).isDisabled()));
  await page.getByRole('button',{name:'取消',exact:true}).click();

  // —— 全局搜索打开知识点
  await page.locator('#rail-search-btn').click();await page.waitForSelector('.palette-box');
  await page.fill('#palette-input','本人修订');
  await page.waitForFunction(()=>palette.items.some(x=>x.group==='知识点'),null,{timeout:8000});
  await page.locator('.palette-item').filter({hasText:'本人修订'}).filter({hasText:'章节'}).first().click();
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  check('the global palette finds the knowledge point and opens the drawer',(await page.locator('#knowledge-detail .knowledge-definition').innerText()).includes('本人修订'));

  // —— 来源轮次定位
  await page.locator('#knowledge-detail .knowledge-record').first().getByRole('button',{name:'回到这次对话'}).click();
  await page.waitForSelector('.turn-block.search-focus',{timeout:20000});
  check('a source record reveals and highlights the exact chat turn',(await page.locator('.turn-block.search-focus').innerText()).includes('请解释输入与输出的约定'));
  check('revealing jumps back to the chat page',await page.evaluate(()=>current==='chat'));

  // —— 删除知识点：笔记保留、连线清掉
  await post('/api/knowledge/note',{id:second,text:'MANUAL-NOTE-2211 删除节点后仍保留'});
  await openNode(second);
  await page.getByRole('button',{name:'删除知识点',exact:true}).click();
  await page.getByRole('button',{name:'确认删除',exact:true}).click();
  await until(async()=>(await post('/api/knowledge/graph',{})).nodes.length===2);
  g=await post('/api/knowledge/graph',{});
  check('deleting a node removes it and its links in one step',g.nodes.length===2&&g.links.length===0);
  check('notes of a deleted node stay searchable',(await post('/api/personal/search',{query:'MANUAL-NOTE-2211'})).hits.some(h=>h.type==='note'));

  // —— 截图与窄屏
  await openNode(nodeId);
  check('the drawer sits beside the canvas on wide screens',(await page.locator('#knowledge-workspace').evaluate(e=>getComputedStyle(e).gridTemplateColumns)).trim().includes(' '));
  await page.screenshot({path:path.join(shots,'network-graph.png')});
  await page.setViewportSize({width:1024,height:860});
  await sleep(300);
  check('no horizontal overflow at 1024px',await page.locator('#view').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  await page.screenshot({path:path.join(shots,'network-compact.png')});
  await page.setViewportSize({width:820,height:860});
  await until(async()=>!(await page.locator('#knowledge-workspace').evaluate(e=>getComputedStyle(e).gridTemplateColumns)).trim().includes(' '));
  check('the drawer stacks below the canvas on narrow screens',true);
  await page.setViewportSize({width:1500,height:1000});
  check('no JavaScript exceptions',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; shots: '+shots+' ; data: '+dir);
 }finally{if(browser)await browser.close();core.kill();mock.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
