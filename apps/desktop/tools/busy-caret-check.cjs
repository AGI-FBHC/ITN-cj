const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.ITN_PLAYWRIGHT_DIR?path.join(process.env.ITN_PLAYWRIGHT_DIR,'playwright'):'D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-busy-caret-'));
 // 慢速流式：让"正在回复"的中间态有足够窗口被观察（真模型本来就是这个形状）。
 const mockPort=await freePort(),mock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(mockPort)],{windowsHide:true,stdio:'ignore',env:{...process.env,ITN_MOCK_CHUNK_DELAY_MS:'700',ITN_MOCK_SILENT_MS:'3500'}});
 const portFile=path.join(dir,'port'),core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+portFile,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});let browser,passed=0;
 const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 try{for(let i=0;i<100&&!fs.existsSync(portFile);i++)await sleep(100);const base='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').trim();
  const post=async(u,b)=>{const r=await fetch(base+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(j.code!==0)throw Error(u+': '+j.message);return j.data;};
  await post('/api/models/save',{id:'mock',name:'转圈检查模型',baseUrl:'http://127.0.0.1:'+mockPort+'/v1',apiKey:'test-only',model:'mock'});
  await post('/api/models/roles',{chatModelId:'mock'});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');
  await page.evaluate(()=>renderPanel(true));
  await page.locator('#chat-input').fill('帮我总结一下今天的学习内容，包括上午看的章节和下午练习的部分，用分点的方式写出来，最后再给一句明天的小建议');
  await page.locator('.composer-send').click();
  await page.waitForFunction(()=>!!document.querySelector('.live-elapsed')?.dataset.startedAt);
  const clockBefore=await page.locator('.live-elapsed').textContent();
  const nodeBefore=await page.locator('.live-elapsed').evaluate(n=>{n.dataset.clockProbe='original';return n.closest('.turn-block').dataset.turnId;});
  await page.waitForTimeout(1600);
  const clockAfter=await page.locator('.live-elapsed').textContent();
  check('elapsed clock advances during a silent upstream response',clockAfter!==clockBefore);
  check('clock updates text without rebuilding the turn',await page.locator('.live-elapsed').getAttribute('data-clock-probe')==='original');
  // 等：轮次在跑 + 正文光标在 + 会话行转圈在，三个同时在场再做断言（否则抓不到中间态）
  await page.waitForFunction(()=>state.busyTurn&&document.querySelector('#chat-thread .caret')&&document.querySelector('.panel-item-row.rail-session .panel-item-spin'),null,{timeout:20000});
  const live=await page.evaluate(()=>{
    const caret=document.querySelector('#chat-thread .caret');
    const caretRect=caret.getBoundingClientRect(),parent=caret.parentElement,parentRect=parent.getBoundingClientRect();
    const body=caret.closest('.msg-body');
    const sid=state.chatSessionId;
    const activeSpin=!!document.querySelector('.panel-item-row.rail-session .panel-item[data-id="'+sid+'"] .panel-item-spin');
    return {sameBlock:caretRect.top>=parentRect.top-1&&caretRect.bottom<=parentRect.bottom+1,
            inside:!!(body&&parent!==body&&body.contains(parent)),
            caretParent:parent.tagName+'/'+(parent.className||''),
            rowSpin:document.querySelectorAll('.panel-item-row.rail-session .panel-item-spin').length,
            running:isSessionRunning(sid),sid,activeSpin};
  });
  check('caret sits at the end of the current text block instead of starting a new line',live.sameBlock&&live.inside);
  check('the running session row shows a spinner ('+live.caretParent+')',live.rowSpin>=1&&live.activeSpin&&live.running===true);
  await page.waitForFunction(()=>!state.busyTurn,null,{timeout:30000});
  await page.waitForFunction(()=>!document.querySelector('#chat-thread .caret'),null,{timeout:5000});
  // 会话栏的 spinner 与运行状态由面板刷新异步收尾：等最终空闲态，避免单次读取的时序抖动
  await page.waitForFunction(()=>document.querySelectorAll('.panel-item-row.rail-session .panel-item-spin').length===0&&isSessionRunning(state.chatSessionId)===false,null,{timeout:15000});
  const idle=await page.evaluate(()=>({rowSpin:document.querySelectorAll('.panel-item-row.rail-session .panel-item-spin').length,caret:!!document.querySelector('#chat-thread .caret'),running:isSessionRunning(state.chatSessionId)}));
  check('spinner disappears and caret is removed after the turn finishes',idle.rowSpin===0&&idle.running===false&&!idle.caret);
  check('no JavaScript errors',errors.length===0);
  console.log('RESULT '+passed+' passed; '+dir);
 }finally{if(browser)await browser.close();core.kill();mock.kill();}})().catch(e=>{console.error(e);process.exitCode=1;});
