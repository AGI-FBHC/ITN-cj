/** 交互导学附件与按会话审批端到端检查：真实仓颉内核 + Edge DOM。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-guided-files-')),pf=path.join(dir,'port');
  const files=path.join(dir,'guided-files'),shots=path.join(root,'tmp','guided-files-shots');fs.mkdirSync(files,{recursive:true});fs.mkdirSync(shots,{recursive:true});
  const pickedFile=path.join(files,'guided-note.md'),pickedDir=path.join(files,'materials');
  fs.writeFileSync(pickedFile,'# guided file');fs.mkdirSync(pickedDir,{recursive:true});
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZsAAAAASUVORK5CYII=';
  let core=null,browser=null,page=null,passed=0;const pageErrors=[],serverErrors=[];
  const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
  const until=async(fn,ms=15000,label='condition')=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(80);}throw Error(label+' timed out');};
  try{
    core=spawn(process.env.GUIDED_CORE_EXE||path.join(root,'dist/core/itn-desktop-core.exe'),[
      '--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),'--seed-guided-fixture=1'
    ],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    core.stderr.on('data',s=>serverErrors.push(s.toString()));
    for(let i=0;i<150&&!fs.existsSync(pf);i++)await sleep(100);
    if(!fs.existsSync(pf))throw Error('core port file not created');
    const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
    const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
    const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
    const resources=(await post('learning/resources',{kbId:'course-alpha'})).resources;
    const ppt=resources.find(x=>x.kind==='ppt');if(!ppt)throw Error('PPT fixture missing');

    browser=await chromium.launch({channel:'msedge',headless:true});
    page=await browser.newPage({viewport:{width:1500,height:1000}});
    page.on('pageerror',e=>pageErrors.push(e.message));
    await page.goto(base);await page.waitForSelector('#chat-input');await page.waitForFunction(()=>!document.getElementById('boot'));
    await page.evaluate(a=>go('study',a.id+'@'+a.version),ppt);
    await page.waitForSelector('.sp-study-layout');await page.waitForSelector('.sp-chat-session');
    await until(async()=>!!(await page.locator('.sp-chat-session').inputValue()),8000,'guided session ready');
    const firstSid=await page.locator('.sp-chat-session').inputValue();

    check('fixed title stays concise',await page.locator('.sp-chat-title').innerText()==='交互导学');
    check('full resource name is kept in the title tooltip',await page.locator('.sp-chat-title').getAttribute('title')===(ppt.title||'交互导学'));
    const optionText=await page.locator('.sp-chat-session option:checked').innerText();
    check('session selector uses a numbered short label with time',/^会话 01(?: · \d\d-\d\d \d\d:\d\d)?$/.test(optionText));
    check('resource title does not stretch the session selector',optionText.length<30&&!optionText.includes(ppt.title));

    await page.evaluate(({pickedFile,pickedDir,png})=>{
      window.ensureImageSupport=async()=>true;
      const current=window.itnWindow||{};
      window.itnWindow={...current,
        pickFile:async()=>pickedFile,
        pickDirectory:async()=>pickedDir,
        pickImage:async()=>({ok:true,images:[{kind:'image',name:'guided.png',mime:'image/png',dataUrl:png}]})
      };
    },{pickedFile,pickedDir,png});
    const addAttachment=async label=>{
      await page.getByRole('button',{name:'添加附件',exact:true}).click();
      const item=page.locator('.sp-chat-attach-menu').getByRole('button',{name:label,exact:true});
      await item.click();await sleep(120);
    };
    await addAttachment('文件');await addAttachment('文件夹');await addAttachment('图片');
    check('file, folder and image can all be attached',await page.locator('.sp-chat-attachments .attachment-chip').count()===3);
    check('image attachment renders a preview',await page.locator('.sp-chat-attachments .attachment-chip img').count()===1);
    await page.screenshot({path:path.join(shots,'attachments.png')});
    await page.getByRole('button',{name:'移除附件 guided.png',exact:true}).click();
    check('attachment can be removed from the draft',await page.locator('.sp-chat-attachments .attachment-chip').count()===2);

    await page.getByRole('button',{name:'新建会话',exact:true}).click();
    await until(async()=>await page.locator('.sp-chat-session').inputValue()!==firstSid,5000,'new guided session');
    const secondSid=await page.locator('.sp-chat-session').inputValue();
    check('a new guided session starts with an empty attachment strip',await page.locator('.sp-chat-attachments .attachment-chip').count()===0&&await page.locator('.sp-chat-attachments').evaluate(e=>e.hidden));
    await addAttachment('文件');
    check('the second session owns its own attachment',await page.locator('.sp-chat-attachments .attachment-chip').count()===1);
    await page.selectOption('.sp-chat-session',firstSid);
    await until(async()=>await page.locator('.sp-chat-attachments .attachment-chip').count()===2,3000,'first session attachments painted');
    check('switching back restores only the first session attachments',await page.locator('.sp-chat-attachments .attachment-chip').count()===2);
    await page.selectOption('.sp-chat-session',secondSid);
    await until(async()=>await page.locator('.sp-chat-attachments .attachment-chip').count()===1,3000,'second session attachments painted');
    check('the second session does not inherit the first session attachments',await page.locator('.sp-chat-attachments .attachment-chip').count()===1);
    await page.selectOption('.sp-chat-session',firstSid);
    await until(async()=>await page.locator('.sp-chat-attachments .attachment-chip').count()===2,3000,'first session ready for send');

    let capturedAsk=null;
    const okAsk=async route=>{
      capturedAsk=route.request().postDataJSON();
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{sessionId:firstSid,ok:true,answer:'收到附件'}})});
    };
    await page.route('**/api/agent/ask-pi',okAsk);
    await page.fill('.sp-chat-input','请查看这些附件');await page.locator('.sp-chat-send').click();
    await until(async()=>!!capturedAsk,5000,'ask payload captured');
    check('guided request sends structured attachments',Array.isArray(capturedAsk.attachments)&&capturedAsk.attachments.length===2&&capturedAsk.attachments.map(x=>x.kind).sort().join(',')==='directory,file');
    check('guided request requires explicit file access confirmation',capturedAsk.confirmFileAccess===true);
    check('guided request is bound to the selected session',capturedAsk.sessionId===firstSid);
    await until(async()=>await page.locator('.sp-chat-send').evaluate(e=>!e.classList.contains('stop')),5000,'successful send settles');
    check('draft attachments clear after a successful send',await page.locator('.sp-chat-attachments .attachment-chip').count()===0);
    await page.unroute('**/api/agent/ask-pi',okAsk);

    const failedAsk=async route=>{
      await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:1,message:'测试失败'})});
    };
    await page.route('**/api/agent/ask-pi',failedAsk);
    await addAttachment('文件');await page.fill('.sp-chat-input','触发失败以检查附件恢复');await page.locator('.sp-chat-send').click();
    await until(async()=>await page.locator('.sp-chat-send').evaluate(e=>!e.classList.contains('stop'))&&await page.locator('.sp-chat-attachments .attachment-chip').count()===1,5000,'failed send restores');
    check('attachments are restored after a failed request',await page.locator('.sp-chat-attachments .attachment-chip').count()===1);
    await page.unroute('**/api/agent/ask-pi',failedAsk);

    const current=await page.locator('.sp-chat-session').inputValue();
    let allowClicked=false;const approvalPolls=[],answers=[];
    const fakeRequests=()=>[
      {id:'ap-current',sessionId:current,kind:'file-read',value:pickedFile,detail:'读取当前导学会话附件',tool:'read',decision:'',at:'2026-10-19T22:00:00'},
      {id:'ap-other',sessionId:'another-session',kind:'file-write',value:'other.txt',detail:'其它会话的请求',tool:'write',decision:'',at:'2026-10-19T22:00:01'}
    ];
    const approvals=async route=>{
      approvalPolls.push(route.request().postDataJSON());
      const requests=fakeRequests().filter(x=>!allowClicked||x.id!=='ap-current');
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{requests,pending:requests.length}})});
    };
    const answerApproval=async route=>{
      const body=route.request().postDataJSON();answers.push(body);if(body.id==='ap-current')allowClicked=true;
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{ok:true,pending:0}})});
    };
    const delayedAsk=async route=>{
      await sleep(1800);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{sessionId:current,ok:true,answer:'审批已完成'}})});
    };
    await page.route('**/api/agent/approvals',approvals);
    await page.route('**/api/agent/approvals/answer',answerApproval);
    await page.route('**/api/agent/ask-pi',delayedAsk);
    await page.fill('.sp-chat-input','触发当前会话审批');await page.locator('.sp-chat-send').click();
    await page.waitForSelector('.sp-chat-approval[data-id="ap-current"]',{timeout:6000});
    check('only the current guided session approval card is visible',await page.locator('.sp-chat-approval').count()===1&&await page.locator('.sp-chat-approval[data-id="ap-other"]').count()===0);
    await page.screenshot({path:path.join(shots,'approval.png')});
    check('approval polling asks for the current session only',approvalPolls.length>=1&&approvalPolls.every(x=>x.sessionId===current));
    await page.locator('.sp-chat-approval[data-id="ap-current"]').getByRole('button',{name:'允许一次',exact:true}).click();
    await until(async()=>answers.some(x=>x.id==='ap-current'&&x.decision==='once'),3000,'approval answer captured');
    await until(async()=>await page.locator('.sp-chat-send').evaluate(e=>!e.classList.contains('stop')),6000,'approval turn settles');
    await sleep(650);const pollsAfterTurn=approvalPolls.length;await sleep(900);
    check('approval polling stops when the guided turn finishes',approvalPolls.length===pollsAfterTurn);
    await page.unroute('**/api/agent/approvals',approvals);
    await page.unroute('**/api/agent/approvals/answer',answerApproval);
    await page.unroute('**/api/agent/ask-pi',delayedAsk);

    check('no browser runtime errors',pageErrors.length===0);
    check('no core API exception was logged',!serverErrors.join('').includes('[api]'));
    console.log('RESULT=OK '+passed+' checks; data='+dir);
  }catch(e){
    if(page)await page.screenshot({path:path.join(root,'tmp/guided-files-failure.png')}).catch(()=>{});
    throw e;
  }finally{if(browser)await browser.close().catch(()=>{});if(core)core.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
