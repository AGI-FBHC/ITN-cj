const { _electron }=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const { chromium }=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),url=require('node:url');
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-splash-'));let app,browser;let passed=0;const check=(n,b)=>{if(!b)throw Error(n);passed++;console.log('PASS '+n);};
try{
 // 第一段：冷启动动画页（内核还没起来时窗口里显示的就是它）
 browser=await chromium.launch({channel:'msedge',headless:true});
 const cold=await browser.newPage({viewport:{width:600,height:420}});
 await cold.goto(url.pathToFileURL(path.resolve('shell/renderer/splash.html')).href);
 await cold.waitForSelector('.splash-mark img');
 const coldShot=await cold.evaluate(()=>{const img=document.querySelector('.splash-mark img');const mark=document.querySelector('.splash-mark');const shine=document.querySelector('.splash-shine');return {loaded:img.naturalWidth>0&&img.naturalHeight>0,breathe:getComputedStyle(mark).animationName,shine:getComputedStyle(shine).animationName};});
 check('cold-start page animates the transparent logo (breathing + light sweep)',coldShot.loaded&&coldShot.breathe.includes('breathe')&&coldShot.shine.includes('shine'));
 // 第二段：应用内动画层（reload 一次，完整看到"出现 → 淡出 → 交接"）
 app=await _electron.launch({executablePath:path.resolve('shell/node_modules/electron/dist/electron.exe'),args:[path.resolve('shell/main.js'),'--ui-check'],env:{...process.env,APPDATA:dir,LOCALAPPDATA:dir,TEMP:dir,TMP:dir},timeout:30000});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForSelector('#view',{timeout:60000});await page.waitForTimeout(400);
 await page.reload();
 await page.waitForSelector('#boot',{timeout:15000});
 const bootShot=await page.evaluate(()=>{const img=document.querySelector('#boot .boot-mark img');const mark=document.querySelector('#boot .boot-mark');const shine=document.querySelector('#boot .boot-shine');return {loaded:img.naturalWidth>0,breathe:getComputedStyle(mark).animationName,shine:getComputedStyle(shine).animationName};});
 check('in-app splash layers the same animation over the first paint',bootShot.loaded&&bootShot.breathe.includes('boot-breathe')&&bootShot.shine.includes('boot-shine'));
 await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:15000});
 check('splash fades out and hands over to the ready UI',await page.evaluate(()=>!!document.querySelector('#view')&&document.querySelectorAll('.nav-item').length>0));
 check('no JavaScript errors during startup',errors.length===0);
 console.log('RESULT '+passed+' passed; '+dir);
}finally{if(app)await app.close();if(browser)await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
