const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.ITN_PLAYWRIGHT_DIR?path.join(process.env.ITN_PLAYWRIGHT_DIR,'playwright'):'D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-attachments-')),work=path.join(dir,'project');fs.mkdirSync(work);const csv=path.join(work,'sample.csv');fs.writeFileSync(csv,'time,load\n0,12');
 const mockPort=await freePort(),mock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(mockPort)],{windowsHide:true,stdio:'ignore',env:{...process.env,ITN_MOCK_CHUNK_DELAY_MS:'0'}});
 const portFile=path.join(dir,'port'),core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+portFile,'--ui-dir='+path.join(root,'shell/renderer')],{windowsHide:true,stdio:'ignore'});let browser,passed=0;
 const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 try{for(let i=0;i<100&&!fs.existsSync(portFile);i++)await sleep(100);const base='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').trim();
  const raw=async(u,b)=>fetch(base+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
  const post=async(u,b)=>{const j=await raw(u,b);if(j.code!==0)throw Error(u+': '+j.message);return j.data;};
  await post('/api/models/save',{id:'mock',name:'图片测试模型',baseUrl:'http://127.0.0.1:'+mockPort+'/v1',apiKey:'test-only',model:'mock'});await post('/api/models/roles',{chatModelId:'mock'});
  const probe=await post('/api/models/vision-test',{});check('image capability is tested against current model',probe.supported&&probe.model==='mock');
  const target=(await post('/api/sessions/new',{})).sessionId;await post('/api/agent/ask-pi',{sessionId:target,question:'会话证据 X42-note',web:'off'});
  const project=await post('/api/projects/save',{name:'测试项目',root:work});
  for(const projectId of ['',project.id]){const sid=(await post('/api/sessions/new',{projectId})).sessionId;await post('/api/agent/ask-pi',{sessionId:sid,question:'读一下这个会话lumin://thread/'+target,web:'off',exec:'0'});const events=(await post('/api/sessions/events',{sessionId:sid})).events;
   check((projectId?'Work':'ordinary')+' reads app session without filesystem searching',events.some(e=>e.type==='tool/result'&&e.payload.tool==='read_session'&&e.payload.ok&&JSON.stringify(e.payload.details).includes('X42-note'))&&!events.some(e=>e.type==='tool/call'&&['find','grep','read','powershell'].includes(e.payload.tool)));}
  const image={kind:'image',name:'fixture.png',dataUrl:'data:image/png;base64,'+fs.readFileSync(path.join(root,'tmp/vision-fixture.png')).toString('base64')};
  const sid=(await post('/api/sessions/new',{})).sessionId;const answer=await post('/api/agent/ask-pi',{sessionId:sid,question:'识别图片验证码',attachments:[image],web:'off'});check('image reaches actual agent model content',answer.answer.includes('K7-P4'));
  const history=(await post('/api/sessions/events',{sessionId:sid})).events;const user=history.find(e=>e.type==='user/message').payload;check('history text stays separate and does not duplicate image bytes',user.text==='识别图片验证码'&&user.attachments[0].name==='fixture.png'&&!JSON.stringify(user).includes('base64'));
  check('image remains available on next round',(await post('/api/agent/ask-pi',{sessionId:sid,question:'再读一次验证码',web:'off'})).answer.includes('K7-P4'));
  check('remote image URLs are rejected',(await raw('/api/agent/ask-pi',{question:'看图',attachments:[{...image,dataUrl:'https://example.com/a.png'}]})).code!==0);
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#chat-input');await page.evaluate(({csv,work,image})=>{window.itnWindow={pickFile:async()=>csv,pickDirectory:async()=>work,pickImage:async()=>({ok:true,images:[image]})};},{csv,work,image});
  await page.locator('#chat-input').fill('分析输入数据');await page.locator('.composer-icon').first().click();await page.getByText('选文件…',{exact:true}).click();
  check('file attachment does not rewrite the input',await page.locator('#chat-input').inputValue()==='分析输入数据'&&await page.locator('.attachment-strip .attachment-chip').count()===1);
  await page.locator('.composer-icon').first().click();await page.getByText('选文件夹…',{exact:true}).click();check('folder is a separate removable attachment',await page.locator('.attachment-strip .attachment-chip').count()===2);
  await page.getByRole('button',{name:'移除附件 sample.csv',exact:true}).click();check('removing attachment preserves the user text',await page.locator('.attachment-strip .attachment-chip').count()===1&&await page.locator('#chat-input').inputValue()==='分析输入数据');
  const sent=page.waitForRequest(r=>r.url().endsWith('/api/agent/ask-pi'));await page.locator('.composer-send').click();const payload=(await sent).postDataJSON();check('attachment path is structured, not concatenated into the question',payload.question==='分析输入数据'&&payload.attachments[0].kind==='directory'&&payload.attachments[0].path===work);
  await page.waitForFunction(()=>!state.busyTurn);check('sent attachments remain visible in history',await page.locator('.message-attachments .attachment-chip').count()===1&&await page.locator('.attachment-strip .attachment-chip').count()===0);
  await page.locator('.composer-icon').first().click();await page.getByText('添加图片…',{exact:true}).click();await page.waitForSelector('.attachment-strip img');check('image preview appears as an attachment',await page.locator('.attachment-strip img').count()===1&&await page.locator('#chat-input').inputValue()==='');
  await page.locator('#chat-input').fill('识别图片验证码');await page.locator('.composer-send').click();await page.waitForFunction(()=>!state.busyTurn);await page.waitForFunction(()=>document.querySelector('#chat-thread')?.textContent.includes('K7-P4'),null,{timeout:10000}).catch(async e=>{console.log('UI_STATE '+JSON.stringify(await page.evaluate(()=>({turns:state.chatTurns,busy:state.busyTurn}))).slice(0,3000));throw e;});check('image reply completes in UI',(await page.locator('#chat-thread').innerText()).includes('K7-P4'));
  await post('/api/models/save',{id:'text',name:'纯文本',baseUrl:'http://127.0.0.1:'+mockPort+'/v1',apiKey:'test-only',model:'text-only'});await post('/api/models/roles',{chatModelId:'text'});await page.evaluate(()=>loadCfg());
  await page.locator('.composer-icon').first().click();await page.getByText('添加图片…',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('未通过'));check('model that fails vision test cannot add an image',await page.locator('.attachment-strip img').count()===0);
  check('no JavaScript errors',errors.length===0);console.log('RESULT '+passed+' passed; '+dir);
 }finally{if(browser)await browser.close();core.kill();mock.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
