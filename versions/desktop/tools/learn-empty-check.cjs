const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.ITN_PLAYWRIGHT_DIR?path.join(process.env.ITN_PLAYWRIGHT_DIR,'playwright'):'D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-learn-empty-')),kb=path.join(dir,'kb');fs.mkdirSync(kb);
 fs.writeFileSync(path.join(kb,'a.md'),'# 第一章\n\n内容。');
 const mp=await freePort();const mock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(mp)],{windowsHide:true,stdio:'ignore',env:{...process.env,ITN_MOCK_CHUNK_DELAY_MS:'0'}});
 const portFile=path.join(dir,'port');const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+portFile,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});
 let browser,passed=0;const check=(n,ok)=>{if(!ok)throw Error(n);passed++;console.log('PASS '+n);};
 try{for(let i=0;i<100&&!fs.existsSync(portFile);i++)await sleep(100);const base='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').trim();
  const post=async(u,b)=>{const r=await fetch(base+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(j.code!==0)throw Error(u+': '+j.message);return j.data;};
  await post('/api/models/save',{id:'mock',name:'m',baseUrl:'http://127.0.0.1:'+mp+'/v1',apiKey:'k',model:'mock'});
  await post('/api/models/roles',{chatModelId:'mock'});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');
  await page.evaluate(()=>go('learn'));
  // 学 · 练现在是思维导图工作区（旧的 study-workspace 两栏壳已被替换）
  await page.waitForSelector('.course-workspace');
  check('no-KB keeps the course workspace shell',await page.locator('.course-workspace .course-toolbar').count()===1&&await page.locator('.course-stage').count()===1);
  check('no-KB guidance stays inside the page',(await page.locator('.course-stage').innerText()).includes('先选择一个知识库')&&await page.getByRole('button',{name:'去知识库',exact:true}).count()>=1);
  await post('/api/kb/save',{id:'kb',name:'测试资料',rootDir:kb});
  await page.evaluate(()=>go('learn'));
  await page.waitForSelector('.course-workspace');
  check('unindexed KB shows the map prompt and a generate action',(await page.locator('.course-stage').innerText()).includes('生成思维导图')&&await page.locator('#course-generate').count()===1);
  check('no JavaScript errors',errors.length===0);
  console.log('RESULT '+passed+' passed');
 }finally{if(browser)await browser.close();core.kill();mock.kill();}})().catch(e=>{console.error(e);process.exitCode=1;});
