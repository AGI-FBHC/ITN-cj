/** Real configured model: two isolated PPT generations, never logs credentials. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http'),{spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
(async()=>{
 const sourceDb=process.env.LUMIN_DB||path.join(process.env.LOCALAPPDATA||'','Lumin','itn.db');
 if(!fs.existsSync(sourceDb))throw Error('找不到真实模型配置数据库: '+sourceDb);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-real-ppt-')),pf=path.join(dir,'port');
 fs.copyFileSync(sourceDb,path.join(dir,'itn.db'));
 const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(root,'shell/renderer'),'--skills-dir='+path.join(root,'shell/skills')],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let passed=0;const started=Date.now();
 const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
 try{
  for(let i=0;i<200&&!fs.existsSync(pf);i++)await sleep(100);
  if(!fs.existsSync(pf))throw Error('core did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const requestJson=(url,body=null,method='POST')=>new Promise((resolve,reject)=>{
    const u=new URL(base+url),payload=body===null?'':JSON.stringify(body);
    const req=http.request({hostname:u.hostname,port:u.port,path:u.pathname+u.search,method,headers:body===null?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{const j=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(j.code!==0)reject(Error(url+': '+j.message));else resolve(j.data);}catch(e){reject(e);}});});
    req.setTimeout(0);req.on('error',reject);if(payload)req.write(payload);req.end();
  });
  const post=(url,body={})=>requestJson(url,body);
  const settings=await requestJson('/api/settings',null,'GET');
  const selected=settings.models?.find(m=>m.id===settings.chatModelId)||settings.models?.[0];console.log('MODEL '+(selected?.model||selected?.name||'unknown')+'; credentials hidden; isolated data='+dir);
  const run=async(label,topic)=>{
    const sid=(await post('/api/sessions/new',{})).sessionId;
    const question='无需确认PPT细节，直接制作一份 6 页可编辑交互课件（.pptx），主题：'+topic+'。面向初学者，课堂讲解，采用简洁清新的背景和不同页面版式，每页有可逐字朗读的讲者备注。请使用 create_presentation，先提供候选产物让我预览；不要复制或移动文件，不要调用 powershell，不要自动存入个性资源。';
    console.log('STAGE '+label+' real model requesting');const response=await post('/api/agent/ask-pi',{sessionId:sid,question,web:'off'});
    const events=(await post('/api/sessions/events',{sessionId:sid})).events;const created=events.find(e=>e.type==='artifact/created')?.payload;
    if(!created){console.error(JSON.stringify(events.filter(e=>['tool/result','assistant/message','turn/end'].includes(e.type)).slice(-6).map(e=>({type:e.type,payload:e.payload})),null,2));throw Error(label+' did not create candidate: '+JSON.stringify(response));}
    const outDir=path.join(root,'tmp/real-ppt-check');fs.mkdirSync(outDir,{recursive:true});const target=path.join(outDir,label+'.pptx'),preview=path.join(outDir,label+'.preview.html');fs.copyFileSync(created.path,target);fs.copyFileSync(created.previewPath,preview);
    const parsed=JSON.parse(execFileSync(path.join(root,'shell/renderer/ppt-renderer/python/python.exe'),['-X','utf8','-c',"import sys,zipfile,json;from pptx import Presentation;from xml.dom import minidom;p=sys.argv[1];z=zipfile.ZipFile(p);assert z.testzip() is None;[minidom.parseString(z.read(n)) for n in z.namelist() if n.endswith('.xml')];r=Presentation(p);print(json.dumps({'slides':len(r.slides),'notes':sum(1 for s in r.slides if s.has_notes_slide and s.notes_slide.notes_text_frame.text.strip()),'text':''.join(s.text for slide in r.slides for s in slide.shapes if s.has_text_frame)},ensure_ascii=False))",created.path],{encoding:'utf8',windowsHide:true}));
    check(label+' honors the requested outline page count',created.slides===6);check(label+' produced a valid PPTX with content and notes',parsed.slides>=created.slides&&parsed.notes>=6&&parsed.text.length>200);check(label+' preview path matches the desktop reader convention',created.previewPath.endsWith('.pptx.preview.html')&&fs.existsSync(created.previewPath));
    check(label+' is a candidate rather than an approved resource',created.path.includes('drafts')&&!fs.existsSync(path.join(dir,'artifacts',path.basename(created.path))));
    console.log('RESULT '+label+' slides='+parsed.slides+' notes='+parsed.notes+' chars='+parsed.text.length+' elapsed='+Math.round((Date.now()-started)/1000)+'s');
    return {created,parsed,target,preview};
  };
  const a=await run('run1','输入与输出的约定'),b=await run('run2','RAG 的最小闭环');
  check('two real generations yielded distinct candidates',a.created.path!==b.created.path&&fs.existsSync(a.target)&&fs.existsSync(b.target));
  console.log('RESULT=OK '+passed+' checks; '+Math.round((Date.now()-started)/1000)+'s; data='+dir+' ; artifacts='+path.join(root,'tmp/real-ppt-check'));
 }finally{core.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
