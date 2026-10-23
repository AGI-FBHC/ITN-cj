/**
 * 页面切换流畅性专项：真实 Edge + 当前 renderer + 仓颉内核。
 * 默认复制用户数据库到临时目录做只读性能对照，绝不对源库写入。
 */
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');

const root=path.resolve(__dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise(resolve=>{
  const server=net.createServer();
  server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
});

(async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-navigation-fluid-'));
  const source=path.join(process.env.LOCALAPPDATA||'', 'Lumin', 'itn.db');
  if(fs.existsSync(source)){
    fs.copyFileSync(source,path.join(dataDir,'itn.db'));
    for(const suffix of ['-wal','-shm'])if(fs.existsSync(source+suffix))fs.copyFileSync(source+suffix,path.join(dataDir,'itn.db'+suffix));
  }
  const sourceStamp=fs.existsSync(source)?{bytes:fs.statSync(source).size,mtimeMs:fs.statSync(source).mtimeMs}:null;
  const portFile=path.join(dataDir,'port');
  const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),[
    '--data-dir='+dataDir,
    '--port-file='+portFile,
    '--ui-dir='+path.join(root,'shell/renderer')
  ],{windowsHide:true,stdio:'ignore'});
  let browser;
  let passed=0,failed=0;
  const failures=[];
  const check=(name,ok,detail='')=>{
    if(ok){passed++;console.log('PASS '+name);return;}
    failed++;failures.push(name);console.error('FAIL '+name+(detail?' :: '+detail:''));
  };
  const until=async(fn,timeout=30000)=>{
    const started=Date.now();
    while(Date.now()-started<timeout){if(await fn())return;await sleep(100);}
    throw Error('等待条件超时');
  };
  try{
    await until(()=>fs.existsSync(portFile),15000);
    const base='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').trim();
    browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    await page.addInitScript(()=>{
      window.__navFetch=[];
      const original=window.fetch;
      window.fetch=async function(input,...args){
        const started=performance.now(),url=String(typeof input==='string'?input:input.url);
        try{
          const response=await original.call(this,input,...args);
          window.__navFetch.push({url:new URL(url,location.href).pathname,ms:Math.round(performance.now()-started),status:response.status});
          return response;
        }catch(error){
          window.__navFetch.push({url:new URL(url,location.href).pathname,ms:Math.round(performance.now()-started),error:error.name});
          throw error;
        }
      };
    });
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(()=>!document.getElementById('boot')&&document.getElementById('view')?.getAttribute('aria-busy')==='false',null,{timeout:30000});

    const pages=['chat','home','report','resources','notes','wrong','kb','memory','settings'];
    const samples=[];
    for(const target of pages){
      await page.evaluate(()=>{window.__navFetch=[];});
      const started=Date.now();
      await page.evaluate(async target=>{await go(target);},target);
      await page.waitForFunction(target=>current===(target==='wrong'?'notes':target)&&document.getElementById('view')?.getAttribute('aria-busy')==='false',target);
      const readyMs=Date.now()-started;
      await sleep(120);
      const requests=await page.evaluate(()=>window.__navFetch.slice());
      samples.push({target,readyMs,requests});
      console.log('NAV '+target+' '+readyMs+'ms '+requests.map(r=>r.url+':'+r.ms).join(', '));
    }

    const reportSample=samples.find(x=>x.target==='report');
    check('the growth page completes its first real-data navigation',reportSample.readyMs<2500,String(reportSample.readyMs));
    for(const target of ['chat','home','resources','notes','wrong','kb','settings']){
      const sample=samples.find(x=>x.target===target);
      check(target+' navigation stays below one second',sample.readyMs<1000,String(sample.readyMs));
    }
    check('a single navigation does not issue duplicate study-report reads',samples.every(s=>s.requests.filter(r=>r.url==='/api/study/report').length<=1),JSON.stringify(samples.map(s=>({target:s.target,reports:s.requests.filter(r=>r.url==='/api/study/report').length}))));
    check('a single navigation does not issue duplicate settings reads',samples.every(s=>s.requests.filter(r=>r.url==='/api/settings').length<=1),JSON.stringify(samples.map(s=>({target:s.target,settings:s.requests.filter(r=>r.url==='/api/settings').length}))));

    const warm=[];
    for(let round=0;round<3;round++){
      for(const target of pages){
        await page.evaluate(()=>{window.__navFetch=[];});
        const started=Date.now();
        await page.evaluate(async target=>{await go(target);},target);
        await page.waitForFunction(target=>current===(target==='wrong'?'notes':target)&&document.getElementById('view')?.getAttribute('aria-busy')==='false',target);
        warm.push({round,target,ms:Date.now()-started});
      }
    }
    const warmReport=warm.filter(x=>x.target==='report');
    check('warm growth navigation remains below 1.5 seconds',warmReport.every(x=>x.ms<1500),JSON.stringify(warmReport));
    const average=warm.reduce((sum,x)=>sum+x.ms,0)/warm.length;
    check('warm page rotation averages below 700 ms',average<700,average.toFixed(1));
    check('no renderer exceptions during navigation',errors.length===0,errors.join(' | '));
    if(sourceStamp)check('the source user database was not modified',sourceStamp.bytes===fs.statSync(source).size&&sourceStamp.mtimeMs===fs.statSync(source).mtimeMs);
    console.log('RESULT='+(!failed?'OK':'FAILED')+' '+passed+' passed, '+failed+' failed; data='+dataDir);
    if(failed)process.exitCode=1;
  }finally{
    if(browser)await browser.close();
    core.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
