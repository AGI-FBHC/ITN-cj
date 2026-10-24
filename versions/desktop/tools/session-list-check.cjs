const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
/* 会话列表的性能与正确性回归。
   背景：/api/sessions/list 曾在真实库（1.8 万条事件）上要 2 秒/次、页面切换一次打 1–3 个重复请求，
   是"切页面卡住 0.5 秒+"的元凶；纯仓颉 SQL 引擎对 JOIN 形态更要 65 秒（已改掉，见 core/src/session/session.cj）。
   数据由内核自带夹具灌入（--seed-fixture，全仓颉，不依赖外部脚本直写库）：
   60 段会话 × 250 条事件 + 1 条分叉会话（末端在第 100 条）。断言：
     - 冷启动一次 < 2500ms（旧实现 ~2s+、JOIN 版 65s，都会挂）
     - 连续调用走进程内缓存 < 300ms（去掉缓存立刻挂）
     - 标题/kind/eventCount/最后事件与夹具契约完全一致（含分叉会话按分支计数）
     - 重命名与一轮对话都会让缓存立刻失效
     - UI 切页 < 1500ms（旧实现 report 页 ~4s，因为它一次切换打两个 2s 的列表请求）
   用法：node tools/session-list-check.cjs [--core=path\to\core.exe] */
(async()=>{
 const arg=process.argv.find(a=>a.startsWith('--core='));
 const coreExe=arg?arg.slice(7):path.join(root,'dist/core/itn-desktop-core.exe');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-sesslist-')),pf=path.join(dir,'port');
 const core=spawn(coreExe,['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),'--seed-fixture=15000'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let coreOut='';core.stdout.on('data',d=>coreOut+=d);core.stderr.on('data',d=>coreOut+=d);
 let browser,passed=0;
 const check=(n,b)=>{if(!b)throw Error(n);passed++;console.log('PASS '+n);};
 try{
  for(let i=0;i<300&&!fs.existsSync(pf);i++)await sleep(100);
  if(!fs.existsSync(pf))throw Error('core 未在限时内就绪（可能夹具灌数失败）：'+coreOut.slice(-500));
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(u,b)=>{const r=await fetch(base+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});const j=await r.json();if(j.code!==0)throw Error(u+': '+j.message);return j.data;};
  const timed=async()=>{const t0=performance.now();const d=await post('/api/sessions/list',{});return {ms:Math.round(performance.now()-t0),d};};

  const cold=await timed();
  check('cold build under 2500ms (was 2s+ before, 65s with the JOIN variant)',cold.ms<2500);
  const warm1=await timed(),warm2=await timed();
  check('warm reads come from the cache under 300ms',warm1.ms<300&&warm2.ms<300);
  const byId={};
  for(const s of cold.d.sessions)byId[s.sessionId]=s;
  check('fixture sessions all present',Object.keys(byId).length>=61);
  let bad=0;
  for(let i=0;i<60;i++){
    const want={title:'第 '+i+' 号会话的第一个问题',kind:(i%3===0?'quiz':'ask'),eventCount:250,lastType:'assistant/delta'};
    const got=byId['seed-'+i]||{};
    if(got.title!==want.title||got.kind!==want.kind||got.eventCount!==want.eventCount||got.lastType!==want.lastType){bad++;if(bad<4)console.log('MISMATCH seed-'+i,JSON.stringify(got),JSON.stringify(want));}
  }
  const branch=byId['seed-branch']||{};
  if(branch.title!=='分叉会话的第一个问题'||branch.kind!=='ask'||branch.eventCount!==100||branch.lastType!=='assistant/delta'){bad++;console.log('MISMATCH seed-branch',JSON.stringify(branch));}
  check('every session matches the fixture contract (title/kind/eventCount/lastType, branch counts 100)',bad===0);
  check('warm result is stable across calls',JSON.stringify(warm1.d.sessions)===JSON.stringify(warm2.d.sessions));

  // 缓存失效：重命名（写 sessions_meta）与一轮对话（写 session_events）都要让列表立刻跟上。
  // 注意 epoch 是进程内的：只有内核自己写库才算数（单实例架构下成立）。
  await post('/api/sessions/rename',{sessionId:'seed-0',title:'重命名验证标题'});
  const afterRename=await post('/api/sessions/list',{force:true});
  const sRenamed=afterRename.sessions.find(s=>s.sessionId==='seed-0');
  check('a rename invalidates the cache right away',sRenamed.title==='重命名验证标题');

  const mockPort=await freePort();
  const mock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(mockPort)],{windowsHide:true,stdio:'ignore'});
  await post('/api/models/save',{id:'mock',name:'test',baseUrl:'http://127.0.0.1:'+mockPort+'/v1',apiKey:'test',model:'mock'});
  await post('/api/models/roles',{chatModelId:'mock'});
  const sNew=(await post('/api/sessions/new',{})).sessionId;
  await post('/api/agent/ask-pi',{sessionId:sNew,question:'缓存失效测试',web:'off'});
  const afterTurn=await post('/api/sessions/list',{force:true});
  const sTurn=afterTurn.sessions.find(s=>s.sessionId===sNew);
  check('a finished turn appears in the list with its events counted',!!sTurn&&sTurn.eventCount>=2);

  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:30000}).catch(()=>{});
  await sleep(400);
  const tReport=await page.evaluate(async()=>{const t=performance.now();await go('report');return Math.round(performance.now()-t);});
  const tChat=await page.evaluate(async()=>{const t=performance.now();await go('chat');return Math.round(performance.now()-t);});
  const tHome=await page.evaluate(async()=>{const t=performance.now();await go('home');return Math.round(performance.now()-t);});
  console.log('  ui switches:',{report:tReport,chat:tChat,home:tHome});
  check('report page switch under 1500ms (was ~4s before: two 2s session-list calls)',tReport<1500);
  check('chat page switch under 1500ms',tChat<1500);
  check('knowledge page switch under 1500ms',tHome<1500);
  mock.kill();
  console.log('RESULT=OK '+passed+' checks; data '+dir);
 }finally{if(browser)await browser.close();core.kill();}
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
