const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-markdown-')),mp=await freePort(),pf=path.join(dir,'port');
 const mock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(mp)],{windowsHide:true,stdio:'ignore',env:{...process.env,ITN_MOCK_CHUNK_DELAY_MS:'0'}});
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});
 let browser,passed=0;
 const check=(n,b)=>{if(!b)throw Error(n);passed++;console.log('PASS '+n);};
 const until=async(fn,ms=20000)=>{const t0=Date.now();for(;;){if(await fn())return;if(Date.now()-t0>ms)throw Error('等待条件超时');await sleep(150);}};
 try{
  for(let i=0;i<100&&!fs.existsSync(pf);i++)await sleep(100);
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(u,b)=>{const r=await fetch(base+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(j.code!==0)throw Error(u+': '+j.message);return j.data;};
  await post('/api/models/save',{id:'mock',name:'test',baseUrl:'http://127.0.0.1:'+mp+'/v1',apiKey:'test',model:'mock'});
  await post('/api/models/roles',{chatModelId:'mock'});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');
  await page.locator('#chat-input').fill('表格渲染测试');
  await page.locator('.composer-send').click();
  await page.waitForFunction(()=>!state.busyTurn,null,{timeout:60000});
  await until(async()=>await page.locator('#chat-thread table').count()===1,20000);
  check('a GFM table becomes a real table element',await page.locator('#chat-thread .md-table-wrap table').count()===1);
  check('header cells keep their columns',(await page.locator('#chat-thread thead th').allInnerTexts()).join('|')==='做法|优点|风险');
  check('body rows and cells are split correctly',await page.locator('#chat-thread tbody tr').count()===2&&(await page.locator('#chat-thread tbody tr').first().locator('td').allInnerTexts()).join('|')==='先定输入输出|可复现 run.sh|前期多花几分钟');
  check('alignment markers map to classes',await page.locator('#chat-thread thead th.ta-l').count()===1&&await page.locator('#chat-thread thead th.ta-c').count()===1&&await page.locator('#chat-thread thead th.ta-r').count()===1);
  check('inline code inside a cell still renders',await page.locator('#chat-thread tbody td code').count()===1);
  check('task list boxes render with done state',await page.locator('#chat-thread .md-task-box.done').count()===1&&await page.locator('#chat-thread .md-task-box:not(.done)').count()===1);
  // 表格在前面、~~删除线~~在最后一段：流式还没写完尾段时断言会误报，先等文字到齐
  await until(async()=> (await page.locator('#chat-thread').innerText()).includes('旧版本已废弃'),15000);
  check('strikethrough renders',await page.locator('#chat-thread .md s').count()===1);
  const link=page.locator('#chat-thread a.md-link');
  check('safe links render as anchors with target/rel',await link.count()===1&&await link.getAttribute('href')==='https://example.com/docs'&&await link.getAttribute('target')==='_blank'&&(await link.getAttribute('rel')||'').includes('noopener'));
  await page.setViewportSize({width:760,height:900});
  await sleep(300);
  check('narrow screens keep the page width and scroll the table instead',await page.locator('#view').evaluate(e=>e.scrollWidth<=e.clientWidth+1)&&await page.locator('.md-table-wrap').evaluate(e=>getComputedStyle(e).overflowX==='auto'));
  await page.setViewportSize({width:1440,height:960});
  const shots=path.join(root,'tmp/markdown-shots');fs.mkdirSync(shots,{recursive:true});
  await page.screenshot({path:path.join(shots,'table-light.png')});
  const edge=await page.evaluate(()=>{
    const box=document.createElement('div');
    const render=s=>{box.innerHTML=md(s);return box.innerHTML;};
    return {
      escaped: render('| a \\| b | c |\n| --- | --- |\n| x | y |'),
      noDelim: render('a | b\nnext line'),
      noOuter: render('a | b\n:-- | --:\n1 | 2'),
      inCode: render('```\n| a | b |\n| --- | --- |\n```'),
    };
  });
  check('escaped pipes stay inside one cell',edge.escaped.includes('a | b</th>'));
  check('a pipe line without a delimiter is not turned into a table',edge.noDelim.includes('<p>')&&!edge.noDelim.includes('<table>'));
  check('tables without outer pipes parse too',edge.noOuter.includes('<table>')&&edge.noOuter.includes('ta-r'));
  check('fenced code keeps pipes untouched',edge.inCode.includes('<pre><code>')&&!edge.inCode.includes('<table>'));
  check('no JavaScript exceptions',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; shots: '+shots+' ; data: '+dir);
 }finally{if(browser)await browser.close();core.kill();mock.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
