const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-markdown-')),pf=path.join(dir,'port');
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});
 let browser,passed=0;
 const check=(n,b)=>{if(!b)throw Error(n);passed++;console.log('PASS '+n);};
 const until=async(fn,ms=20000)=>{const t0=Date.now();for(;;){if(await fn())return;if(Date.now()-t0>ms)throw Error('等待条件超时');await sleep(150);}};
 try{
  for(let i=0;i<100&&!fs.existsSync(pf);i++)await sleep(100);
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(u,b)=>{const r=await fetch(base+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(j.code!==0)throw Error(u+': '+j.message);return j.data;};
  await post('/api/models/save',{id:'renderer-only',name:'Renderer test',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture',model:'fixture'});
  await post('/api/models/roles',{chatModelId:'renderer-only'});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:960},permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');
  // Renderer contract, no fake model or streaming timing dependency.
  await page.evaluate(()=>{
    document.getElementById('chat-thread').innerHTML=md('下面是对照表：\n\n| 做法 | 优点 | 风险 |\n| :--- | :---: | ---: |\n| 先定输入输出 | 可复现 `run.sh` | 前期多花几分钟 |\n| 边做边补文档 | 上手快 | 边界容易漏 |\n\n- [x] 已写清输入\n- [ ] 补边界样例\n\n详见 [文档](https://example.com/docs)，~~旧版本已废弃~~。');
  });
  check('a GFM table becomes a real table element',await page.locator('#chat-thread .md-table-wrap table').count()===1);
  check('header cells keep their columns',(await page.locator('#chat-thread thead th').allInnerTexts()).join('|')==='做法|优点|风险');
  check('body rows and cells are split correctly',await page.locator('#chat-thread tbody tr').count()===2&&(await page.locator('#chat-thread tbody tr').first().locator('td').allInnerTexts()).join('|')==='先定输入输出|可复现 run.sh|前期多花几分钟');
  check('alignment markers map to classes',await page.locator('#chat-thread thead th.ta-l').count()===1&&await page.locator('#chat-thread thead th.ta-c').count()===1&&await page.locator('#chat-thread thead th.ta-r').count()===1);
  check('inline code inside a cell still renders',await page.locator('#chat-thread tbody td code').count()===1);
  check('task list boxes render with done state',await page.locator('#chat-thread .md-task-box.done').count()===1&&await page.locator('#chat-thread .md-task-box:not(.done)').count()===1);
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
      inlinePipe: render('| 命令 | 解释 |\n| --- | --- |\n| `a | b` | 管道 |'),
    };
  });
  check('escaped pipes stay inside one cell',edge.escaped.includes('a | b</th>'));
  check('a pipe line without a delimiter is not turned into a table',edge.noDelim.includes('<p>')&&!edge.noDelim.includes('<table>'));
  check('tables without outer pipes parse too',edge.noOuter.includes('<table>')&&edge.noOuter.includes('ta-r'));
  check('fenced code keeps pipes untouched',edge.inCode.includes('<pre><code>')&&!edge.inCode.includes('<table>'));
  check('pipes inside inline code remain in the same table cell',edge.inlinePipe.includes('<code>a | b</code></td><td'));
  const exact='const title = "学习 <测试> & 100%";\n\tconsole.log(title);  ';
  await page.evaluate(code=>document.getElementById('chat-thread').innerHTML=md('### 示例代码\n\n```javascript\n'+code+'\n```\n\n| 项目 | 内容 |\n| --- | --- |\n| 命令 | `a | b` |'),exact);
  check('code language label is visible',await page.locator('.md-code-head > span').innerText()==='javascript');
  check('code preserves Unicode, indentation, whitespace and HTML literals',await page.locator('.md-code-block code').textContent()===exact);
  check('code contains no accidental clickable references',await page.locator('.md-code-block a').count()===0);
  await page.locator('.md-copy-code').click();
  await until(async()=>await page.locator('.md-copy-code').innerText()==='已复制',5000);
  const copied=await page.evaluate(()=>navigator.clipboard.readText());
  check('copy preserves the code text (Windows CRLF normalized)',copied.replace(/\r\n/g,'\n')===exact);
  check('copy reports completion',await page.locator('.md-copy-code').innerText()==='已复制');
  const fences=await page.evaluate(()=>({tilde:md('~~~cj\nlet x = 1\n~~~'),nested:md('````md\n```js\nlet x = 1\n```\n````'),open:md('```js\nlet x = 1')}));
  check('tilde and incomplete streaming fences remain code blocks',fences.tilde.includes('<pre><code>let x = 1</code>')&&fences.open.includes('<pre><code>let x = 1</code>'));
  check('shorter nested fences do not close the outer code block',fences.nested.includes('<pre><code>```js\nlet x = 1\n```</code>'));
  for(const theme of ['light','dark']){
    await page.evaluate(t=>applyTheme(t),theme);
    await sleep(500);
    check(theme+' code uses theme foreground without inline-code decorations',await page.locator('.md-code-block code').evaluate(e=>{const c=getComputedStyle(e);return c.boxShadow==='none'&&c.color===getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().replace(/^#([0-9a-f]{6})$/i,(_,h)=>'rgb('+[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)).join(', ')+')');}));
    await page.screenshot({path:path.join(shots,'code-'+theme+'.png')});
    await page.setViewportSize({width:760,height:900});
    check(theme+' code and tables fit the narrow viewport',await page.locator('#view').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    await page.setViewportSize({width:1440,height:960});
  }
  check('no JavaScript exceptions',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; shots: '+shots+' ; data: '+dir);
 }finally{if(browser)await browser.close();core.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
