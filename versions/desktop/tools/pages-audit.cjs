/** 对话页 + 知识网络页的审计检查：查的是交互边界（空输入/换行/输入法/发送链路/表单校验），
    用内核自带的仓颉夹具（本机 mock 模型 + 示例知识库），不碰真实数据与真实模型。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-pages-audit-')),pf=path.join(dir,'port');let core,browser,passed=0;
 const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 const until=async(fn,ms=30000)=>{const t0=Date.now();for(;;){if(await fn())return true;if(Date.now()-t0>ms)return false;await sleep(120);}};
 try{
  core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),'--seed-course-fixture=1'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  core.stderr.on('data',s=>{const t=String(s);if(!t.includes('SEED'))process.stderr.write('core: '+t);});
  if(!(await until(()=>fs.existsSync(pf),20000)))throw Error('core did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
  const sessionsCount=async()=>(await post('sessions/list',{})).sessions.length;

  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:950}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:20000}).catch(()=>{});
  await page.evaluate(()=>go('chat'));await page.waitForSelector('#chat-input');await sleep(300);

  // 1) 空输入点发送：不得创建会话/轮次
  const before=await sessionsCount();
  await page.locator('.composer-send[aria-label="发送"]').click();await sleep(400);
  check('empty send does not create a session or a turn',(await sessionsCount())===before);

  // 2) Shift+Enter 换行而不是发送
  await page.fill('#chat-input','第一行');
  await page.locator('#chat-input').press('Shift+Enter');await sleep(150);
  check('Shift+Enter inserts a newline instead of sending',(await page.inputValue('#chat-input')).includes('\n')&&(await sessionsCount())===before);

  // 3) 输入法组字中的 Enter 不触发发送
  await page.fill('#chat-input','正在输入');
  await page.evaluate(()=>{const ta=document.getElementById('chat-input');const ev=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});Object.defineProperty(ev,'isComposing',{value:true});ta.dispatchEvent(ev);});
  await sleep(300);
  check('Enter during IME composition does not send',(await page.inputValue('#chat-input'))==='正在输入'&&(await sessionsCount())===before);
  await page.fill('#chat-input','');

  // 4) Enter 发送：输入清空、会话建立、回复出现
  await page.fill('#chat-input','请先介绍一下你自己');
  await page.locator('#chat-input').press('Enter');
  await until(async()=>(await sessionsCount())===before+1,10000);
  check('Enter sends the question and a session appears',(await sessionsCount())===before+1);
  check('the composer clears right after sending',(await page.inputValue('#chat-input'))==='');
  check('the assistant reply arrives in the thread',await until(async()=>(await page.locator('#chat-thread').innerText()).includes('你希望面向什么学习程度'),30000));

  // 5) 运行中按钮变“停止”（用会走工具链的问题拉长运行窗口）
  let releaseAsk;
  const askGate=new Promise(resolve=>releaseAsk=resolve);
  await page.route('**/api/agent/ask-pi',async route=>{await askGate;await route.continue();});
  await page.fill('#chat-input','给我讲讲工具调用');
  await page.locator('#chat-input').press('Enter');
  check('the send button turns into stop while the turn runs',await until(async()=>await page.getByRole('button',{name:'停止',exact:true}).count()>0,15000));
  releaseAsk();
  await page.unroute('**/api/agent/ask-pi');
  check('the turn finishes and the button returns to send',await until(async()=>await page.locator('.composer-send[aria-label="发送"]').count()>0,90000));

  // 6) 知识网络：空标题被拒绝
  await page.evaluate(()=>go('home'));await page.waitForSelector('.knowledge-network');await sleep(200);
  const nodesBefore=(await post('knowledge/graph',{})).nodes.length;
  await page.getByRole('button',{name:/添加知识点/}).first().click();
  await page.waitForSelector('#knowledge-title');
  await page.fill('#knowledge-title','');
  await page.getByRole('button',{name:'保存知识点',exact:true}).click();
  check('saving a knowledge point with an empty title is rejected with a message',await until(async()=>((await page.locator('#toast').innerText().catch(()=>''))||'').includes('请填写知识点名称'),5000));
  check('the rejected save did not create a node',(await post('knowledge/graph',{})).nodes.length===nodesBefore);
  await page.keyboard.press('Escape');

  // 7) 知识网络：改名撞车被拒绝且原名保留
  const a=await post('knowledge/save',{title:'审计节点甲',definition:'用于审计重名。'});
  const b=await post('knowledge/save',{title:'审计节点乙',definition:'用于审计重名。'});
  await page.evaluate(id=>openKnowledgePoint(id),b.id);
  await page.waitForSelector('#knowledge-detail:not([hidden])');
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  await page.waitForSelector('#knowledge-title');
  await page.fill('#knowledge-title','审计节点甲');
  await page.getByRole('button',{name:'保存知识点',exact:true}).click();
  check('renaming onto an existing knowledge point is rejected with a message',await until(async()=>((await page.locator('#toast').innerText().catch(()=>''))||'').includes('已有同名知识点'),5000));
  check('the rejected rename keeps the original title',(await post('knowledge/node',{id:b.id})).title==='审计节点乙');
  await page.keyboard.press('Escape');

  check('no browser exceptions',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; data='+dir);
 }finally{if(browser)await browser.close();if(core)core.kill();}
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
