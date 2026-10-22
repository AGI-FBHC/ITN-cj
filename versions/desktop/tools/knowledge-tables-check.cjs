/** Reproduce the user's real README tables through indexed snapshots and paginated UI. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-tables-')),docs=path.join(dir,'docs'),pf=path.join(dir,'port');
 let core,browser,passed=0;const failures=[],errors=[];
 const check=(label,ok)=>{if(ok){passed++;console.log('PASS '+label);}else{failures.push(label);console.error('FAIL '+label);}};
 const until=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error('condition timed out');};
 try{
  fs.mkdirSync(path.join(docs,'chapter4'),{recursive:true});
  const original=fs.readFileSync('D:/Desktop/Projects/resource/hello-agents/docs/README.md','utf8');
  fs.writeFileSync(path.join(docs,'README.md'),original);
  const target='chapter4/第四章 智能体经典范式构建.md';fs.writeFileSync(path.join(docs,target),'# 智能体经典范式\n\nReAct、Plan-and-Solve、Reflection 的章节原文。');
  const expected=original.slice(original.indexOf('| 章节'),original.indexOf('### 社区贡献')).split('\n').filter(l=>l.trim().startsWith('|')).length-2;
  const code=Array.from({length:35},(_,i)=>'<img src="invalid-'+i+'.png" onerror="window.__tableXss=1">').join('\n');
  const longRows=Array.from({length:65},(_,i)=>'| 项目 '+i+' | 一个表格不能因为用于检索的分片而被拆散。 |').join('\n');
  fs.writeFileSync(path.join(docs,'stress.md'),'# 分页样张\n\n## 代码\n\n```html\n'+code+'\n```\n\n## 完整表格\n\n| 名称 | 说明 |\n|---|---|\n'+longRows+'\n\n## 转义竖线\n\n| 名称 | 内容 |\n|---|---|\n| A | 左\\|右 |\n');
  core=spawn(path.join(root,'core/target/release/bin/main.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});
  await until(()=>fs.existsSync(pf));const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(name,body)=>{const r=await(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();if(r.code!==0)throw Error(r.message);return r.data;};
  await post('kb/save',{id:'tables',name:'表格验收',rootDir:docs});await post('kb/build',{id:'tables',maxChars:260});
  fs.unlinkSync(path.join(docs,'README.md')); // The preview must use the prepared snapshot, even without its source file.
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'));await page.evaluate(async()=>{state.kb='tables';await go('kb');});
  const open=async doc=>{await page.locator('.library-document').filter({hasText:doc}).getByRole('button',{name:'看内容',exact:true}).click();await until(()=>page.locator('.document-preview > button').isEnabled());};
  const allPages=async()=>{const more=page.locator('.document-preview > button');let pages=0;while(await more.isVisible()){await more.click();await until(()=>more.isEnabled());pages++;if(pages>100)throw Error('pagination failed to end');}return pages;};
  await open('README.md');const pages=await allPages();
  const table=page.locator('.document-preview table').filter({has:page.locator('th',{hasText:'章节'})});
  check('real README uses multiple preview pages',pages>0);
  check('the entire chapter table is one table',await table.count()===1);
  const count=await table.locator('tbody tr').count();console.log('CHAPTER_ROWS expected='+expected+' actual='+count);
  check('every original chapter row survives pagination exactly once',count===expected);
  check('late chapter rows stay inside the same table',await table.locator('td',{hasText:'第十六章 毕业设计'}).count()===1);
  check('table rows are not printed as pipe-delimited paragraphs',!(await page.locator('.document-preview p').allTextContents()).some(t=>/^\s*\|.*第四章/.test(t)));
  const link=table.locator('a').filter({hasText:'第四章 智能体经典范式构建'});
  check('relative chapter links render as usable links',await link.count()===1);
  fs.mkdirSync(path.join(root,'tmp/knowledge-tables-shots'),{recursive:true});
  if(await table.count()){await table.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'tmp/knowledge-tables-shots/real-readme.png')});}
  if(await link.count()){await link.click();await until(async()=> (await page.locator('.document-preview').innerText()).includes('ReAct、Plan-and-Solve'));check('clicking a Chinese relative path opens the indexed chapter',true);}
  await open('stress.md');await allPages();
  const long=page.locator('.document-preview table').filter({has:page.locator('td',{hasText:'项目 64'})});
  check('65-row table crosses pages without missing or duplicated rows',await long.locator('tbody tr').count()===65);
  check('split code fences remain one literal code block',await page.locator('.document-preview pre').count()===1&&(await page.locator('.document-preview pre').innerText()).trim()===code);
  check('HTML in split code fences never becomes live images',await page.locator('.document-preview pre img').count()===0&&await page.evaluate(()=>window.__tableXss===undefined));
  const escaped=page.locator('.document-preview table').filter({has:page.locator('td',{hasText:'左|右'})});check('escaped pipes stay in one cell',await escaped.locator('tbody td').count()===2);
  await page.evaluate(()=>go('resources','files'));await page.waitForSelector('.outcome-workspace');
  check('the local-files tab and dedicated view have been removed',await page.getByRole('button',{name:'本地文件',exact:true}).count()===0&&await page.locator('.local-file-reader').count()===0);
  check('old local-files routes lead to saved learning resources',await page.evaluate(()=>current==='resources'&&currentSection===''&&location.hash==='#/resources'));
  check('no browser runtime errors',errors.length===0);
  console.log('RESULT='+(!failures.length?'OK':'FAILED')+' '+passed+' passed, '+failures.length+' failed; data='+dir);if(failures.length)process.exitCode=1;
 }catch(e){console.error(e.stack);process.exitCode=1;}
 finally{if(browser)await browser.close();if(core&&!core.killed)core.kill();}
})();
