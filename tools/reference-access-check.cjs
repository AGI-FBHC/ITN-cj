/** Real Edge + isolated native kernel and real filesystem path resolution.
 * External OS launches are recorded; preload/IPC is verified by reference-desktop-check.
 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {chromium}=require(require.resolve('playwright',{paths:['D:/Desktop/ITN/ITN/src/frontend/agent-demo',path.resolve(__dirname,'..')]}));
const {resolveReferencePath}=require('../shell/reference-paths.cjs');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-reference-audit-')),pf=path.join(dir,'port');
const output=path.join(root,'tmp/reference-access-check');fs.mkdirSync(output,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],errors=[];let core,browser,page;
const check=(name,ok,detail)=>{assert(ok,name+(detail?' :: '+JSON.stringify(detail):''));checks.push(name);console.log('PASS '+name);};
(async()=>{try{
 const roots=['alpha','beta'].map(n=>path.join(dir,n));roots.forEach(p=>fs.mkdirSync(p));
 const workspace=path.join(dir,'work with spaces');fs.mkdirSync(workspace);
 const local=path.join(workspace,'notes & 100%.txt');fs.writeFileSync(local,'Local file only.');
 fs.writeFileSync(path.join(workspace,'readme.md'),'Relative file.');
 for(let i=0;i<roots.length;i++)fs.writeFileSync(path.join(roots[i],'same.md'),'# '+(i?'Beta':'Alpha')+'\n\n'+(i?'BETA_ONLY':'ALPHA_ONLY')+' source.\n\n[Other document](long.md)\n\n[Website](https://example.com/doc?a=1&b=2)');
 fs.writeFileSync(path.join(roots[0],'long.md'),Array.from({length:38},(_,i)=>'# Section '+i+'\n\n'+'Long learning passage '+i+' '.repeat(1)+(' validation '.repeat(140))+'\n\nEND_'+i).join('\n\n'));
 core=spawn(process.env.REFERENCE_CORE||path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+(process.env.ITN_UI_DIR||path.join(root,'shell/renderer'))],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
 for(let i=0;i<200&&!fs.existsSync(pf);i++)await pause(100);assert(fs.existsSync(pf),'native startup');
 const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
 const post=async(route,body={})=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();assert.equal(j.code,0,route+': '+j.message);return j.data;};
 for(let i=0;i<roots.length;i++){await post('kb/save',{id:i?'beta':'alpha',name:i?'Beta library':'Alpha library',rootDir:roots[i]});await post('kb/build',{id:i?'beta':'alpha'});}
 await post('models/save',{id:'reference-fixture',name:'Reference fixture',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture-only',model:'fixture'});await post('models/roles',{chatModelId:'reference-fixture'});
 const session=(await post('sessions/new',{})).sessionId,other=(await post('sessions/new',{})).sessionId;
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});page=await browser.newPage({viewport:{width:1440,height:960},deviceScaleFactor:1.5});page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('__resolveFile',input=>resolveReferencePath(input));
 await page.addInitScript(()=>{window.__opens=[];window.itnWindow={openPath:async value=>{window.__opens.push({kind:'path',value});return{ok:true};},openUrl:async value=>{window.__opens.push({kind:'web',value});return{ok:true};},resolveReferencePath:input=>window.__resolveFile(input),onDeepLink:()=>()=>{},onStateChange:()=>()=>{},minimize(){},toggleMaximize(){},close(){}};});
 await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'));
 await page.evaluate(async({session,workspace})=>{await openChatSession(session);state.cfg.agentWorkDir=workspace;}, {session,workspace});
 const mount=async(text,citations=[])=>page.evaluate(({text,citations})=>{state.chatTurns=[{id:'audit-turn',user:'Reference audit',items:[{t:'a',text}],citations,report:null,ok:true,message:''}];const host=document.getElementById('chat-thread')||document.getElementById('view');host.replaceChildren(renderTurnBlock(state.chatTurns[0],false));},{text,citations});
 const anchor=label=>page.locator('#view a').filter({hasText:label}).first();
 const lastOpen=()=>page.evaluate(()=>window.__opens.at(-1));
 const close=async()=>{await page.locator('#resource-dock .resource-dock-head button').click();await page.waitForSelector('#resource-dock',{state:'hidden'});};
 const cites=[{index:1,kbId:'beta',docPath:'same.md',docTitle:'Beta',text:'IMMUTABLE_SNAPSHOT',headingPath:''},{index:1,label:'W1',kind:'web',url:'https://example.com/web?a=1&b=2',docPath:'https://example.com/web?a=1&b=2',docTitle:'Web one',text:'WEB_SNAPSHOT'}];
 await mount('[Web](https://example.com/a_(b)?x=1&y=2)\nPlain https://example.com/hello,\n[Spaces](<'+local+'>)\n[URI]('+pathToFileURL(local).href+')\n[Relative](./readme.md)\n`'+local+'`\n[Mail](mailto:test@example.com)\n[Thread](lumin://thread/'+other+')\n[Source](same.md)\nSources [1] and [W1].\n```txt\nhttps://example.com/code\n'+local+'\n```',cites);
 await anchor('Web').click();check('balanced URL parentheses and query ampersands open intact',(await lastOpen()).value==='https://example.com/a_(b)?x=1&y=2',await lastOpen());
 await anchor('Spaces').click();check('Markdown path containing spaces, ampersand and percent resolves intact',path.normalize((await lastOpen()).value)===path.normalize(local),await lastOpen());
 await anchor('URI').click();check('encoded file URL resolves to the same real file',path.normalize((await lastOpen()).value)===path.normalize(local));
 await anchor('Relative').click();check('relative file opens against the conversation workspace',path.normalize((await lastOpen()).value)===path.join(workspace,'readme.md'),await lastOpen());
 await anchor('Mail').click();check('mailto reaches the default application bridge',(await lastOpen()).value==='mailto:test@example.com');
 check('fenced code stays selectable without creating clickable references',await page.locator('#view pre a').count()===0);
 await page.locator('#view .citation-link').filter({hasText:'[W1]'}).click();await page.waitForSelector('#resource-dock:not([hidden])');
 check('web W1 does not resolve to local citation 1',(await page.locator('#resource-dock .reference-title').innerText())==='Web one');
 await page.getByRole('button',{name:'用浏览器打开',exact:true}).click();check('web citation preserves its actual source URL',(await lastOpen()).value==='https://example.com/web?a=1&b=2');await close();
 await page.locator('#view .citation-link').filter({hasText:'[1]'}).click();await page.waitForFunction(()=>document.querySelector('.reference-original')?.textContent.includes('BETA_ONLY'));
 check('source reference opens its original knowledge base rather than currently selected alpha',(await page.locator('.reference-original').innerText()).includes('BETA_ONLY')&&!(await page.locator('.reference-original').innerText()).includes('ALPHA_ONLY'));
 check('saved citation snapshot remains visible beside current indexed text',(await page.locator('.reference-snapshot').innerText()).includes('IMMUTABLE_SNAPSHOT'));
 await page.locator('.reference-original a').filter({hasText:'Website'}).click();check('external links within a knowledge document remain clickable',(await lastOpen()).value==='https://example.com/doc?a=1&b=2');await close();
 await page.locator('#view .citation-link').filter({hasText:'[1]'}).click();await page.waitForSelector('#resource-dock:not([hidden])');await page.keyboard.press('Escape');check('Escape closes the reference without cancelling a chat',await page.locator('#resource-dock').isHidden());
 await page.evaluate(()=>window.LuminReferencePanel.open({kind:'citation',citation:{docPath:'same.md'}}));await page.waitForSelector('.reference-document');
 check('missing library id shows same-name candidates instead of guessing',await page.locator('.reference-document').count()===2);
 await page.locator('.reference-document').filter({hasText:'Beta library'}).click();await page.waitForFunction(()=>document.querySelector('.reference-original')?.textContent.includes('BETA_ONLY'));check('selecting a candidate opens the selected library',true);await close();
 const initial=await post('kb/document',{id:'alpha',path:'long.md',offset:0,limit:24});check('long fixture really exceeds one page',initial.total>24,initial.total);
 const later=await post('kb/document',{id:'alpha',path:'long.md',offset:24,limit:24});const chunk=later.chunks.at(-1);
 await page.evaluate(c=>window.LuminReferencePanel.open({kind:'citation',citation:c}),{kbId:'alpha',docPath:'long.md',chunkId:chunk.id});await page.waitForFunction(id=>!!document.querySelector('.reference-chunk.cited[data-chunk-id="'+CSS.escape(id)+'"]'),chunk.id);
 check('a late citation opens its exact source chunk beyond the first page',true);
 const more=page.locator('.reference-more');let reads=0;while(await more.isVisible()&&reads++<8){await more.click();await page.waitForFunction(()=>!document.querySelector('.reference-more')?.disabled);}
 check('remaining document pages can be read until the actual end',await more.isHidden());await close();
 await page.evaluate(()=>window.LuminReferencePanel.open({kind:'citation',citation:{kbId:'removed',docPath:'missing.md',text:'RETAINED_WHEN_MISSING'}}));await page.waitForFunction(()=>document.querySelector('.reference-status')?.textContent.includes('暂不可用'));
 check('removed sources retain readable original snapshots',(await page.locator('.reference-content').innerText()).includes('RETAINED_WHEN_MISSING'));await close();
 for(const config of [{w:1440,z:1.3,theme:'light'},{w:900,z:1,theme:'dark'},{w:390,z:1,theme:'light'}]){
  await page.setViewportSize({width:config.w,height:900});await page.evaluate(({z,theme})=>{applyZoom(z);document.documentElement.setAttribute('data-theme',theme);},config);
  await page.evaluate(()=>window.LuminReferencePanel.open({kind:'citation',citation:{kbId:'beta',docPath:'same.md'}}));await page.waitForFunction(()=>!!document.querySelector('.reference-original'));await pause(120);
  const geometry=await page.locator('#resource-dock').evaluate(el=>{const r=el.getBoundingClientRect(),close=el.querySelector('.resource-dock-head button'),c=close.getBoundingClientRect(),hit=document.elementFromPoint(c.x+c.width/2,c.y+c.height/2);return{left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,hit:hit===close||close.contains(hit)};});
  check('reference close remains visible and clickable '+config.w+'/'+config.z,geometry.left>=-.5&&geometry.right<=geometry.width+.5&&geometry.bottom<=geometry.height+.5&&geometry.hit,geometry);
  await page.screenshot({path:path.join(output,'reference-'+config.w+'-'+config.z+'.png')});await close();
 }
 await page.setViewportSize({width:1440,height:960});await page.evaluate(()=>applyZoom(1));
 await mount('[Thread](lumin://thread/'+other+')');await anchor('Thread').click();await page.waitForFunction(id=>state.chatSessionId===id,other);check('Lumin thread deep links open their actual local session',true);
 check('no browser exceptions during reference navigation',errors.length===0,errors);
 console.log('RESULT=OK '+checks.length+' checks; output='+output);
}finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,errors,dataDir:dir},null,2));if(browser)await browser.close();if(core)core.kill();}})().catch(async e=>{console.error('FAIL '+e.stack);process.exitCode=1;});