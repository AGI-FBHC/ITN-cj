/** Reproduces the user's Hello-Agents chapter, with real image bytes and real Cangjie APIs. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-kb-images-')),docs=path.join(dir,'docs'),pf=path.join(dir,'port');let core,browser,page,server,passed=0,base,externalRequests=0,retryReady=false;
 const check=(n,ok)=>{if(!ok)throw Error(n);passed++;console.log('PASS '+n);};
 const until=async(f,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await f())return;await sleep(100);}throw Error('condition timed out');};
 const post=async(name,body={})=>{const r=await(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
 try{
  const original=process.env.LUMIN_HELLO_DOCS||'D:/Desktop/Projects/resource/hello-agents/docs';
  const bytes=fs.readFileSync(path.join(original,'images/8-figures/8-1.png'));
  fs.mkdirSync(path.join(docs,'chapter8'),{recursive:true});fs.mkdirSync(path.join(docs,'images/8-figures'),{recursive:true});
  fs.writeFileSync(path.join(docs,'images/8-figures/8-1.png'),bytes);
  server=http.createServer((req,res)=>{if(req.url==='/retry.png'&&!retryReady){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'image/png'});res.end(bytes);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const remote='http://127.0.0.1:'+server.address().port;
  // Keep a complete real section; cutting at line 48 leaves an open code fence,
  // which correctly makes all the appended image cases literal code.
  const sample=fs.readFileSync(path.join(original,'chapter8/第八章 记忆与检索.md'),'utf8').split('### 8.1.2')[0];
  const fixture=sample+'\n\n## 图片验收\n\n![本地相对路径](../images/8-figures/8-1.png)\n\n![远程图片]('+remote+'/remote.png)\n\n![稍后可用]('+remote+'/retry.png)\n\n`<img src="missing.png" onerror="window.__xss=1">`\n\n```html\n<img src="missing.png">\n```\n\n<img src="javascript:alert(1)" onerror="window.__xss=1" alt="危险地址">\n\n<strong onclick="window.__xss=2">安全加粗</strong>\n\n<script>window.__xss=3</script>\n';
  fs.writeFileSync(path.join(docs,'chapter8/第八章.md'),fixture);
  core=spawn(path.join(root,'core/target/release/bin/main.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});
  await until(()=>fs.existsSync(pf));base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  await post('kb/save',{id:'images',name:'第八章 记忆与检索',rootDir:docs});await post('kb/build',{id:'images'});
  const mirror=await post('kb/image',{id:'images',docPath:'chapter8/第八章.md',source:'https://raw.githubusercontent.com/datawhalechina/Hello-Agents/main/docs/images/8-figures/8-1.png'});
  check('the exact repository URL resolves to the existing local illustration',mirror.kind==='local'&&mirror.bytes===bytes.length&&mirror.dataUrl.startsWith('data:image/png;base64,'));
  browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://raw.githubusercontent.com/**',r=>{externalRequests++;return r.abort();});
  await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'));
  await page.evaluate(async()=>{state.kb='images';await go('kb');});await page.waitForSelector('.document-preview .kb-document-image');
  // The real section and extra cases can span multiple indexed chunks.
  const more=page.locator('.document-preview > button');
  await until(()=>more.isEnabled());
  while(await more.isVisible()) {await more.click();await until(()=>more.isEnabled());}
  const diagram=page.locator('.document-preview img[alt="人类记忆系统结构图"]');await diagram.scrollIntoViewIfNeeded();
  await until(()=>diagram.evaluate(e=>e.complete&&e.naturalWidth>0));
  check('the user screenshot illustration is decoded and visible',await diagram.evaluate(e=>e.naturalWidth>0&&e.src.startsWith('data:image/png;')));
  check('the illustration loads with GitHub networking disabled',externalRequests===0);
  check('HTML emphasis and superscript are rendered as elements',await page.locator('.document-preview strong').count()>0&&await page.locator('.document-preview sup').count()>0);
  check('HTML image and div markup are not printed as body text',!(await page.locator('.document-preview').innerText()).includes('<div align="center">'));
  check('original percentage image width is preserved',await diagram.evaluate(e=>e.style.width==='85%'));
  for(const alt of ['本地相对路径','远程图片']){const img=page.locator('.document-preview img[alt="'+alt+'"]');await img.scrollIntoViewIfNeeded();await until(()=>img.evaluate(e=>e.complete&&e.naturalWidth>0));check(alt+' renders as an actual decoded image',true);}
  // The 404 can replace the lazy image before scrolling reaches it.
  await page.locator('.document-preview img[alt="稍后可用"],.document-preview .kb-image-unavailable').scrollIntoViewIfNeeded({timeout:5000});
  const fallback=page.locator('.kb-image-unavailable').filter({hasText:'稍后可用'});await fallback.waitFor();check('failed images have a readable retry action',await fallback.getByRole('button',{name:'重试',exact:true}).count()===1);
  retryReady=true;await fallback.getByRole('button',{name:'重试',exact:true}).click();await until(()=>page.locator('img[alt="稍后可用"]').evaluate(e=>e.complete&&e.naturalWidth>0));check('retry can recover the original image',true);
  check('HTML inside inline and fenced code stays literal',await page.locator('.document-preview code').allTextContents().then(x=>x.some(t=>t.includes('<img src="missing.png"')))&&await page.locator('.document-preview code img').count()===0);
  check('scripts, event attributes and dangerous image protocols do not execute',await page.evaluate(()=>window.__xss===undefined&&document.querySelectorAll('.document-preview script,.document-preview [onclick],.document-preview [onerror],.document-preview img[src^="javascript:"]').length===0));
  const table=await page.evaluate(()=>{const t=document.createElement('div');t.innerHTML=md('| 名称 | 内容 |\n|---|---|\n| 工具 | `read` |');return t.querySelectorAll('th').length===2&&t.querySelector('code').textContent==='read';});check('existing chat Markdown tables and code formatting still work',table);
  await diagram.scrollIntoViewIfNeeded();fs.mkdirSync(path.join(root,'tmp/knowledge-images-shots'),{recursive:true});await page.screenshot({path:path.join(root,'tmp/knowledge-images-shots/hello-agents-chapter8.png')});
  check('no browser runtime errors',errors.length===0);
  console.log('RESULT=OK '+passed+' checks; data='+dir);
 }catch(e){console.error('FAIL '+e.stack);console.error('data='+dir);if(page){console.error(await page.locator('.document-preview').innerHTML().catch(()=>''));}process.exitCode=1;}
 finally{if(browser)await browser.close();if(core&&!core.killed)core.kill();if(server)await new Promise(r=>server.close(r));}
})();
