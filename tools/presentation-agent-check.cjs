const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-ppt-agent-')),mp=await freePort(),pf=path.join(dir,'port');
 const mock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(mp)],{windowsHide:true,stdio:'ignore',env:{...process.env,ITN_MOCK_CHUNK_DELAY_MS:'0'}});
 const coreExe=process.env.PRESENTATION_CORE_EXE||path.join(root,'dist/core/itn-desktop-core.exe'),uiDir=process.env.PRESENTATION_UI_DIR||path.join(root,'shell/renderer');const core=spawn(coreExe,['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+uiDir],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let passed=0; const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 try{
  for(let i=0;i<100&&!fs.existsSync(pf);i++)await sleep(100);
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.code!==0)throw Error(url+': '+j.message);return j.data;};
  await post('/api/models/save',{id:'mock',name:'ppt agent mock',baseUrl:'http://127.0.0.1:'+mp+'/v1',apiKey:'test',model:'mock'});
  await post('/api/models/roles',{chatModelId:'mock'});
  const run=async(label)=>{const sid=(await post('/api/sessions/new',{})).sessionId;await post('/api/agent/ask-pi',{sessionId:sid,question:'PPTX_AGENT 无需确认PPT细节，直接制作',web:'off'});const events=(await post('/api/sessions/events',{sessionId:sid})).events;const created=events.find(e=>e.type==='artifact/created')?.payload;if(!created||!fs.existsSync(created.path)){console.error(JSON.stringify(events.filter(e=>['tool/result','assistant/message','turn/end'].includes(e.type)).slice(-6).map(e=>({type:e.type,payload:e.payload})),null,2));}check(label+' creates a candidate artifact',!!created&&fs.existsSync(created.path));check(label+' reports renderer output',created.slides===6&&created.notes===6);check(label+' keeps notes, preview and design snapshot',fs.existsSync(created.previewPath)&&fs.existsSync(created.designPath)&&created.notes===6);check(label+' stays in drafts',created.path.includes('drafts')&&!fs.existsSync(path.join(dir,'artifacts',path.basename(created.path))));return created;};
  const a=await run('fixed pipeline run 1'),b=await run('fixed pipeline run 2');
  check('two runs produce separate candidates',a.path!==b.path&&fs.existsSync(a.path)&&fs.existsSync(b.path));
  const script="import sys,zipfile,json;from pptx import Presentation;from xml.dom import minidom;p=sys.argv[1];z=zipfile.ZipFile(p);assert z.testzip() is None;[minidom.parseString(z.read(n)) for n in z.namelist() if n.endswith('.xml')];r=Presentation(p);print(json.dumps({'slides':len(r.slides),'notes':sum(1 for n in z.namelist() if n.startswith('ppt/notesSlides/notesSlide') and n.endswith('.xml')),'text':''.join(s.text for slide in r.slides for s in slide.shapes if s.has_text_frame)},ensure_ascii=False))";
  const parsed=JSON.parse(execFileSync('python',['-X','utf8','-c',script,a.path],{encoding:'utf8',windowsHide:true}));
  check('rendered PPTX is structurally valid and contains content',parsed.slides===9&&parsed.notes===9&&parsed.text.includes('输入与输出'));
  const preview=fs.readFileSync(a.previewPath,'utf8');check('preview is slide-shaped and includes normalized section pages',preview.includes('CHAPTER')&&preview.includes('09 / 09'));
  console.log('RESULT='+passed+' checks; data='+dir);
 }finally{core.kill();mock.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});