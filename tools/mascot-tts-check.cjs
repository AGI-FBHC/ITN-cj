/** 小鼋龙桌宠 + TTS 模型配置端到端检查：真实仓颉内核、SQLite、HTTP 与 Edge。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.ITN_PLAYWRIGHT_DIR?path.join(process.env.ITN_PLAYWRIGHT_DIR,'playwright'):'D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const frames=['idle','breathe','blink','wake','listen-1','listen-2','think-1','think-2','speak-1','speak-2','working','success'];

function freePort(){
  return new Promise((resolve,reject)=>{
    const server=net.createServer();
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
  });
}

function silentWav(){
  const dataSize=4800,buf=Buffer.alloc(44+dataSize);
  buf.write('RIFF',0,'ascii');buf.writeUInt32LE(36+dataSize,4);buf.write('WAVE',8,'ascii');
  buf.write('fmt ',12,'ascii');buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);
  buf.writeUInt32LE(24000,24);buf.writeUInt32LE(48000,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);
  buf.write('data',36,'ascii');buf.writeUInt32LE(dataSize,40);
  return buf;
}

async function startTtsMock(){
  const requests=[],port=await freePort();
  const server=http.createServer((req,res)=>{
    let raw='';req.setEncoding('utf8');req.on('data',chunk=>{raw+=chunk;});
    req.on('end',()=>{
      if(req.method==='POST'&&req.url==='/v1/audio/speech'){
        let body={};try{body=JSON.parse(raw);}catch{}
        requests.push({url:req.url,body});
        const wav=silentWav();res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':wav.length});res.end(wav);return;
      }
      res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"not found"}');
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,port,requests};
}

(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-mascot-tts-')),pf=path.join(dir,'port');
  const shots=path.join(root,'tmp','mascot-tts-shots');fs.mkdirSync(shots,{recursive:true});
  let browser=null,page=null,core=null,tts=null,chatMock=null,base='',passed=0;
  const pageErrors=[],consoleErrors=[],coreErrors=[];
  const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
  const until=async(fn,ms=30000,label='condition')=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error(label+' timed out');};
  const raw=async(name,body={})=>(await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  const post=async(name,body={})=>{const r=await raw(name,body);if(r.code!==0)throw Error(name+': '+r.message);return r.data;};
  const coreExe=process.env.COMPANION_CORE_EXE||path.join(root,'core','target','release','bin','main.exe');
  check('current Cangjie kernel binary exists',fs.existsSync(coreExe));

  try{
    tts=await startTtsMock();
    core=spawn(coreExe,[
      '--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell','renderer'),
      '--seed-guided-fixture=1','--fixture-delay-ms=280'
    ],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,cjHeapSize:'2GB'}});
    core.stdout.on('data',s=>{const t=s.toString();if(t.includes('[api]'))coreErrors.push(t);});
    core.stderr.on('data',s=>coreErrors.push(s.toString()));
    await until(()=>fs.existsSync(pf),30000,'core port');
    base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();

    await post('models/save',{
      id:'tts-ui',name:'MiMo 朗读 UI',baseUrl:'http://127.0.0.1:'+tts.port+'/v1',apiKey:'tts-test-only',
      model:'',visionModel:'',embeddingModel:'',ttsModel:'mimo-v2.5-tts',ttsVoice:'苏打',ttsFormat:'wav',ttsProtocol:'openai'
    });
    await post('models/roles',{ttsModelId:'tts-ui'});
    const gotSettings=await (await fetch(base+'/api/settings')).json();
    check('role patch keeps the fixture chat model while binding TTS',gotSettings.data.chatModelId==='course-fixture'&&gotSettings.data.ttsModelId==='tts-ui');
    check('TTS-only model survives a settings reload with its key',gotSettings.data.models.some(m=>m.id==='tts-ui'&&m.ttsModel==='mimo-v2.5-tts'&&m.hasApiKey===true));
    const ttsOnlyTest=await raw('models/test',{id:'tts-ui'});
    check('TTS-only configuration gives a precise chat-test error instead of calling the wrong endpoint',ttsOnlyTest.code!==0&&String(ttsOnlyTest.message).includes('没有填写对话模型'));
    const tools=(await post('tools/list')).tools;
    const speechTool=tools.find(t=>t.name==='synthesize_speech');
    check('Lumin exposes synthesize_speech when a TTS role is bound',!!speechTool&&speechTool.available===true);

    const chatPort=await freePort();
    chatMock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(chatPort)],{
      windowsHide:true,stdio:'ignore',env:{...process.env,ITN_MOCK_CHUNK_DELAY_MS:'320'}
    });
    await sleep(450);
    await post('models/save',{
      id:'chat-ui',name:'流式状态模型',baseUrl:'http://127.0.0.1:'+chatPort+'/v1',apiKey:'chat-test-only',
      model:'mock-chat',visionModel:'',embeddingModel:'',ttsModel:'',ttsVoice:'',ttsFormat:'',ttsProtocol:''
    });
    await post('models/roles',{chatModelId:'chat-ui'});
    const switched=await (await fetch(base+'/api/settings')).json();
    check('switching the chat role leaves the TTS binding untouched',switched.data.chatModelId==='chat-ui'&&switched.data.ttsModelId==='tts-ui');

    const direct=await post('tts/synthesize',{text:'直接合成检查。'});
    check('the direct TTS API returns a saved, non-empty WAV',direct.bytes>44&&direct.format==='wav'&&fs.existsSync(direct.path)&&fs.statSync(direct.path).size===direct.bytes);

    const resources=(await post('learning/resources',{kbId:'course-alpha'})).resources;
    const ppt=resources.find(x=>x.kind==='ppt');
    check('guided fixture provides a PPT resource',!!ppt&&ppt.version>0);

    browser=await chromium.launch({channel:'msedge',headless:true});
    page=await browser.newPage({viewport:{width:1500,height:1000}});
    page.on('pageerror',e=>pageErrors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
    await page.goto(base,{waitUntil:'load'});
    await page.waitForSelector('#chat-input');
    await page.waitForFunction(()=>!document.getElementById('boot'));

    const assets=await page.evaluate(async names=>Promise.all(names.map(async name=>{
      const response=await fetch('/mascot/xiaoyuanlong-'+name+'.png');
      const blob=await response.blob();
      const bitmap=await createImageBitmap(blob);
      return {name,status:response.status,type:blob.type,size:blob.size,width:bitmap.width,height:bitmap.height};
    })),frames);
    check('all 12 old-web mascot frames are served',assets.every(a=>a.status===200&&a.type==='image/png'&&a.size>90000));
    check('all mascot frames keep the original 362x362 canvas',assets.every(a=>a.width===362&&a.height===362));

    const mascot=page.locator('.lumin-mascot-root');
    check('mascot mounts visible in the desktop UI',await mascot.isVisible()&&await page.locator('.lumin-mascot-image').isVisible());
    await page.evaluate(()=>window.luminMascotActivity?.('idle',0));
    const firstFrame=await page.locator('.lumin-mascot-image').getAttribute('src');
    await sleep(1450);
    const laterFrame=await page.locator('.lumin-mascot-image').getAttribute('src');
    check('idle animation keeps changing frames',firstFrame!==laterFrame);

    const beforeBox=await page.locator('.lumin-mascot-actor').boundingBox();
    await page.mouse.move(beforeBox.x+beforeBox.width/2,beforeBox.y+beforeBox.height/2);
    await page.mouse.down();
    await page.mouse.move(beforeBox.x+beforeBox.width/2-72,beforeBox.y+beforeBox.height/2-34,{steps:6});
    await page.mouse.up();
    await sleep(180);
    const dragged=await mascot.evaluate(e=>({left:parseFloat(e.style.left),top:parseFloat(e.style.top)}));
    check('mascot can be dragged without selecting page text',Math.abs(dragged.left-(beforeBox.x-72))<2&&Math.abs(dragged.top-(beforeBox.y-34))<2);
    await page.reload({waitUntil:'load'});await page.waitForSelector('#chat-input');await page.waitForFunction(()=>!document.getElementById('boot'));
    const restored=await page.locator('.lumin-mascot-root').evaluate(e=>({left:parseFloat(e.style.left),top:parseFloat(e.style.top)}));
    check('mascot position survives a reload',Math.abs(restored.left-dragged.left)<2&&Math.abs(restored.top-dragged.top)<2);

    await page.locator('.lumin-mascot-actor').click();
    await page.locator('.lumin-mascot-menu [data-page="home"]').click();
    await until(()=>page.evaluate(()=>document.body.dataset.page==='home'),4000,'home route');
    check('mascot menu opens the knowledge network',true);
    await page.locator('.lumin-mascot-actor').click();await page.locator('.lumin-mascot-menu [data-page="notes"]').click();
    await until(()=>page.evaluate(()=>document.body.dataset.page==='notes'),4000,'notes route');
    check('mascot menu opens learning resources',true);
    await page.locator('.lumin-mascot-actor').click();await page.locator('.lumin-mascot-menu [data-page="chat"]').click();
    await until(()=>page.evaluate(()=>document.body.dataset.page==='chat'),4000,'chat route');
    check('mascot menu returns to conversations',true);

    await page.evaluate(()=>window.luminMascotActivity('thinking',1));
    check('Lumin activity feed drives thinking state',await page.locator('.lumin-mascot-root').getAttribute('data-state')==='thinking');
    await page.evaluate(()=>window.luminMascotActivity('speaking',1));
    check('Lumin activity feed drives speaking state',await page.locator('.lumin-mascot-root').getAttribute('data-state')==='speaking');
    await page.evaluate(()=>window.luminMascotActivity('working',1));
    check('Lumin activity feed drives working state',await page.locator('.lumin-mascot-root').getAttribute('data-state')==='working');
    await page.evaluate(()=>window.luminMascotActivity('idle',0));

    await page.evaluate(()=>{document.getElementById('player').hidden=false;});
    await sleep(120);
    check('mascot hides over the resource player',await page.locator('.lumin-mascot-root').isHidden());
    await page.evaluate(()=>{document.getElementById('player').hidden=true;});
    await sleep(120);
    check('mascot returns after the player closes',await page.locator('.lumin-mascot-root').isVisible());

    await page.evaluate(()=>go('settings','appearance'));
    await page.waitForFunction(()=>document.querySelector('#view')?.innerText.includes('小鼋龙'));
    await page.getByRole('button',{name:'隐藏小鼋龙',exact:true}).click();
    await sleep(150);
    check('appearance settings can hide the mascot',await page.locator('.lumin-mascot-root').isHidden()&&await page.evaluate(()=>localStorage.getItem('lumin.mascot.hidden'))==='1');
    await page.getByRole('button',{name:'显示小鼋龙',exact:true}).click();
    await sleep(150);
    check('appearance settings can restore the mascot',await page.locator('.lumin-mascot-root').isVisible()&&await page.evaluate(()=>localStorage.getItem('lumin.mascot.hidden'))==='0');

    await page.emulateMedia({reducedMotion:'reduce'});
    check('reduced-motion disables decorative mascot animation',(await page.locator('.lumin-mascot-float').evaluate(e=>getComputedStyle(e).animationName))==='none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.screenshot({path:path.join(shots,'mascot-appearance.png')});

    await page.evaluate(()=>go('settings','models'));
    await page.waitForSelector('#m-tts-model');
    await page.getByRole('button',{name:'MiMo 语音',exact:true}).click();
    check('MiMo speech preset fills all TTS fields without a runtime error',await page.inputValue('#m-tts-model')==='mimo-v2.5-tts'&&await page.inputValue('#m-tts-voice')==='苏打'&&await page.inputValue('#m-tts-format')==='wav'&&await page.inputValue('#m-tts-protocol')==='mimo');
    const ttsItem=page.locator('#view .item').filter({hasText:'MiMo 朗读 UI'});
    check('TTS-only model is listed as the speech binding',await ttsItem.count()===1&&await ttsItem.getByText('朗读',{exact:true}).count()===1);
    check('TTS-only model hides irrelevant chat connectivity controls',await ttsItem.getByRole('button',{name:'测试连通',exact:true}).count()===0&&await ttsItem.getByRole('button',{name:'诊断连接',exact:true}).count()===0);
    check('TTS-only model offers bind and preview actions',await ttsItem.getByRole('button',{name:'设为朗读模型',exact:true}).count()===1&&await ttsItem.getByRole('button',{name:'试听',exact:true}).count()===1);
    const roleOptions=await page.evaluate(()=>({
      chat:[...document.querySelectorAll('#role-chat option')].map(x=>x.value),
      tts:[...document.querySelectorAll('#role-tts option')].map(x=>x.value)
    }));
    check('role selectors filter by model capability',roleOptions.chat.includes('chat-ui')&&!roleOptions.chat.includes('tts-ui')&&roleOptions.tts.includes('tts-ui')&&!roleOptions.tts.includes('course-fixture'));

    await ttsItem.getByRole('button',{name:'填到表单',exact:true}).click();
    check('TTS values round-trip into the edit form',await page.inputValue('#m-tts-model')==='mimo-v2.5-tts'&&await page.inputValue('#m-tts-voice')==='苏打'&&await page.inputValue('#m-tts-protocol')==='openai');
    await page.fill('#m-tts-voice','茉莉');
    await page.getByRole('button',{name:'保存模型',exact:true}).click();
    let afterSave=null;
    await until(async()=>{
      afterSave=(await (await fetch(base+'/api/settings')).json()).data;
      return afterSave.models.some(m=>m.id==='tts-ui'&&m.ttsVoice==='茉莉');
    },15000,'TTS model save');
    await page.waitForSelector('#m-tts-model');
    const savedTts=afterSave.models.find(m=>m.id==='tts-ui');
    check('editing a TTS model keeps its existing secret and role binding',savedTts.ttsVoice==='茉莉'&&savedTts.hasApiKey===true&&afterSave.ttsModelId==='tts-ui'&&afterSave.chatModelId==='chat-ui');

    await page.evaluate(()=>{
      window.__ttsAudios=[];
      const NativeAudio=window.Audio;
      window.Audio=function(src){const audio=new NativeAudio(src);window.__ttsAudios.push({src:String(src),el:audio});return audio;};
      window.Audio.prototype=NativeAudio.prototype;
      HTMLMediaElement.prototype.play=function(){window.__ttsPlayCalls=(window.__ttsPlayCalls||0)+1;return Promise.resolve();};
    });
    const requestsBefore=tts.requests.length;
    const ttsItemAfter=page.locator('#view .item').filter({hasText:'MiMo 朗读 UI'});
    await ttsItemAfter.getByRole('button',{name:'试听',exact:true}).click();
    await until(()=>page.evaluate(()=>window.__ttsAudios.length===1),10000,'TTS preview audio');
    const preview=await page.evaluate(()=>({src:window.__ttsAudios[0].src,plays:window.__ttsPlayCalls}));
    check('preview calls the real desktop TTS API and creates an audio element',tts.requests.length===requestsBefore+1&&preview.src.startsWith('data:audio/wav;base64,')&&preview.plays===1);
    check('preview uses the edited voice',tts.requests.at(-1).body.voice==='茉莉');
    await page.evaluate(()=>window.__ttsAudios[0].el.onplay?.());
    check('TTS playback drives the speaking state',await page.locator('.lumin-mascot-root').getAttribute('data-state')==='speaking');
    await page.evaluate(()=>window.__ttsAudios[0].el.onended?.());
    check('TTS completion restores a finished state',await page.locator('.lumin-mascot-root').getAttribute('data-state')==='success');
    await page.screenshot({path:path.join(shots,'tts-models.png')});
    await page.evaluate(()=>window.luminMascotActivity('idle',0));

    await page.evaluate(()=>go('chat'));
    await page.waitForSelector('#chat-input');
    await page.evaluate(()=>{
      window.__petStates=[];window.__petLast='';
      const node=document.querySelector('.lumin-mascot-root');
      window.__petObserver?.disconnect();
      window.__petObserver=new MutationObserver(()=>{const s=node.dataset.state;if(s!==window.__petLast){window.__petLast=s;window.__petStates.push(s);}});
      window.__petObserver.observe(node,{attributes:true,attributeFilter:['data-state']});
    });
    await page.fill('#chat-input','请先用一句话说明小鼋龙状态测试是什么。');
    await page.locator('.composer-send').click();
    await until(()=>page.evaluate(()=>['thinking','speaking','success'].every(s=>window.__petStates.includes(s))),30000,'normal-chat mascot states');
    check('normal conversation drives thinking, speaking and success states',true);

    await page.evaluate(a=>go('study',a.id+'@'+a.version),ppt);
    await page.waitForSelector('.sp-study-layout');
    await page.waitForSelector('.sp-chat-input');
    await page.evaluate(()=>{
      window.__petStates=[];window.__petLast='';
      const node=document.querySelector('.lumin-mascot-root');
      window.__petObserver?.disconnect();
      window.__petObserver=new MutationObserver(()=>{const s=node.dataset.state;if(s!==window.__petLast){window.__petLast=s;window.__petStates.push(s);}});
      window.__petObserver.observe(node,{attributes:true,attributeFilter:['data-state']});
    });
    await page.fill('.sp-chat-input','请解释这一页最关键的判断。');
    await page.locator('.sp-chat-send').click();
    await until(()=>page.evaluate(()=>['thinking','speaking','success'].every(s=>window.__petStates.includes(s))),30000,'guided mascot states');
    check('guided study conversation drives the same mascot state chain',true);
    await page.screenshot({path:path.join(shots,'guided-mascot.png')});

    check('no browser runtime errors',pageErrors.length===0);
    check('no browser console errors',consoleErrors.length===0);
    check('no Cangjie API exceptions were logged',!coreErrors.join('').includes('[api]'));
    console.log('RESULT=OK '+passed+' checks; data='+dir+'; shots='+shots);
  }catch(e){
    if(page){await page.screenshot({path:path.join(shots,'failure.png')}).catch(()=>{});console.error('PAGE_TEXT',(await page.locator('#view').innerText().catch(()=>'' )).slice(-2000));}
    if(page){console.error('PET_STATES',await page.evaluate(()=>window.__petStates).catch(()=>[]));}console.error('CORE_ERRORS',coreErrors.join('').slice(-2000));
    throw e;
  }finally{
    if(browser)await browser.close().catch(()=>{});
    if(core)core.kill();
    if(chatMock)chatMock.kill();
    if(tts)await new Promise(r=>tts.server.close(r));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
