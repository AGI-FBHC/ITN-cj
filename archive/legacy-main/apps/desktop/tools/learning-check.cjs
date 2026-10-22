// Isolated real HTTP/tool integration. Mock exists only in the test process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function main() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'itn-learning-'));
  const kb=path.join(dir,'kb');fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb,'input.md'),'# 输入与输出\n\n先写清输入样例和期望输出，再执行并保留中间状态。输出记录应能复现。');
  fs.writeFileSync(path.join(kb,'check.md'),'# 输入与输出的验证与边界\n\n输入与输出要对正常、最小、最大和异常样例进行验证，记录预期与实际差异。');
  const mp=await freePort();
  const mock=spawn('python',[path.join(root,'tools/mock-openai/server.py'),String(mp)],{windowsHide:true,stdio:'ignore',env:{...process.env,ITN_MOCK_CHUNK_DELAY_MS:'0'}});
  const portFile=path.join(dir,'port');
  const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+portFile,'--ui-dir='+path.join(root,'shell/renderer'),'--skills-dir='+path.join(root,'shell/skills')],{windowsHide:true,stdio:'ignore'});
  let base;let passed=0;
  const check=(name,ok,details='')=>{if(!ok)throw Error(name+' '+details);passed++;console.log('PASS '+name);};
  try {
    for(let i=0;i<100&&!fs.existsSync(portFile);i++)await pause(100);
    base='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').trim();
    const post=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.code!==0)throw Error(url+': '+j.message);return j.data;};
    await post('/api/models/save',{id:'mock',name:'test mock',baseUrl:'http://127.0.0.1:'+mp+'/v1',apiKey:'test-only',model:'mock'});
    await post('/api/models/roles',{chatModelId:'mock'});
    await post('/api/kb/save',{id:'kb',name:'测试资料',rootDir:kb});
    await post('/api/kb/build',{id:'kb'});
    for(const kind of ['practice','ppt','quiz','lecture']){
      const sid=(await post('/api/sessions/new',{})).sessionId;
      const response=await post('/api/agent/ask-pi',{sessionId:sid,kbId:'kb',question:'make:'+kind+' 生成学习资源 count:4',web:'off'});
      check(kind+' outer Agent completes',response.ok===true,JSON.stringify(response));
      const events=(await post('/api/sessions/events',{sessionId:sid})).events;
      check(kind+' uses native generation tool',events.some(e=>e.type==='tool/call'&&e.payload.tool==='generate_learning_resource'));
      check(kind+' has exactly one outer terminal event',events.filter(e=>e.type==='turn/end').length===1);
      const saved=events.find(e=>e.type==='resource/saved');
      check(kind+' persisted resource exists',!!saved,JSON.stringify(events.filter(e=>e.type==='tool/result')));
      const res=await post('/api/learning/resource',{id:saved.payload.id});
      check(kind+' stable identity and quality',res.version===1&&res.kind===kind&&res.quality.issues.length===0);
      check(kind+' has real citations and local file',res.citations.length>0&&fs.existsSync(res.artifactPath));
      check(kind+' state completed',(await post('/api/sessions/state',{sessionId:sid})).status==='completed');
      if(kind==='quiz'){
        check('quiz preserves exactly four questions',res.content.questions.length===4);
        const q=res.content.questions[0];
        const ans=await post('/api/learning/answer',{id:res.id,version:1,questionId:q.id,choice:q.correctIndex,attemptId:'first-answer'});
        await post('/api/learning/answer',{id:res.id,version:1,questionId:q.id,choice:q.correctIndex,attemptId:'first-answer'});
        check('quiz answer updates real evidence once',ans.correct&&(await post('/api/learning/context',{kbId:'kb'})).quizAttempts===1);
      }
    }
    const sid=(await post('/api/sessions/new',{})).sessionId;
    await post('/api/agent/ask-pi',{sessionId:sid,kbId:'kb',question:'记住：我喜欢先看例子再讲概念',web:'off'});
    const memories=(await post('/api/learning/memories',{kbId:'kb'})).memories;
    check('Agent saves grounded preference',memories.length===1&&memories[0].quote==='我喜欢先看例子再讲概念');
    await post('/api/learning/memory/forget',{id:memories[0].id});
    check('memory can be forgotten',(await post('/api/learning/memories',{kbId:'kb'})).memories.length===0);
    await post('/api/agent/ask-pi',{sessionId:sid,kbId:'kb',question:'你好，今天想聊聊学习',web:'off'});
    check('ordinary chat does not generate resources',(await post('/api/learning/resources',{})).resources.length===4);
    const lecture=(await post('/api/learning/resources',{})).resources.find(r=>r.kind==='lecture');
    const before=await post('/api/learning/resource',{id:lecture.id,version:1});
    const approvedBefore=await post('/api/personal/save',{path:before.artifactPath,title:before.title,text:before.markdown,learningId:before.id,learningVersion:1,sessionId:before.sessionId,confirmed:true});
    await post('/api/agent/ask-pi',{sessionId:sid,kbId:'kb',question:'修改资源 '+lecture.id+'，请补一个具体例子',web:'off'});
    const revised=await post('/api/learning/resource',{id:lecture.id});
    check('Agent revision preserves stable resource identity',revised.id===lecture.id&&revised.version===2&&revised.versions.length===2);
    check('revision retains immutable original content',(await post('/api/learning/resource',{id:lecture.id,version:1})).markdown===before.markdown&&fs.existsSync(before.artifactPath));
    check('resource source snapshot can be inspected',!!revised.citations[0].text);
    const protectedCopy=await post('/api/personal/read',{id:approvedBefore.id});
    check('approved lecture stays bound to its immutable version after revision',protectedCopy.learningVersion===1&&(await post('/api/learning/resource',{id:protectedCopy.learningId,version:protectedCopy.learningVersion})).markdown===before.markdown);
    const course=await post('/api/study/course',{kbId:'kb'});
    const learnedChapter=course.chapters.find(c=>c.resourceId===lecture.id);
    check('course selects latest matching lecture version',learnedChapter?.version===2);
    check('course exposes lecture sections and original citation snapshots',learnedChapter.sections.length>=2&&learnedChapter.sections[0].markdown.length>0&&learnedChapter.citations[0].text.length>0);
    const section=learnedChapter.sections[0];
    const done=await post('/api/study/section/complete',{kbId:'kb',chapter:learnedChapter.name,sectionId:section.id});
    const repeated=await post('/api/study/section/complete',{kbId:'kb',chapter:learnedChapter.name,sectionId:section.id});
    check('section completion is idempotent and counts actual sections',done.doneCount===1&&repeated.doneCount===1);
    const chunks=(await post('/api/study/chapter',{kbId:'kb',chapter:learnedChapter.sourceChapter})).chunks;
    await post('/api/study/read',{kbId:'kb',chapter:learnedChapter.name,chunkId:chunks[0].id});
    const afterRead=await post('/api/study/course',{kbId:'kb'});
    check('legacy read saves preserve section progress',afterRead.doneCount===1&&afterRead.next.sectionId!==section.id);
    const fallback=course.chapters.find(c=>!c.resourceId);
    check('ungenerated chapter uses headings without raw text cards',!!fallback&&fallback.sections.every(s=>!s.markdown));
    let rejected=false;
    try{await post('/api/study/section/complete',{kbId:'kb',chapter:fallback.name,sectionId:fallback.sections[0].id});}catch(e){rejected=true;}
    check('cannot mark ungenerated lesson as learned',rejected);
    if(process.argv.includes('--ui')) {
      for(const r of (await post('/api/learning/resources',{})).resources){const body=await post('/api/learning/resource',{id:r.id});await post('/api/personal/save',{path:body.artifactPath,title:body.title,text:body.markdown,learningId:body.id,learningVersion:body.version,sessionId:body.sessionId,confirmed:true});}
      await require('./workbench-ui.cjs')({base,post,check,dir});
    }

    const finishing=await post('/api/study/course',{kbId:'kb'});
    let finishedCourse;
    for(const c of finishing.chapters.filter(c=>c.resourceId===lecture.id))for(const section of c.sections)finishedCourse=await post('/api/study/section/complete',{kbId:'kb',chapter:c.name,sectionId:section.id});
    check('whole lecture completion accumulates across its chapters',finishedCourse.chapters.filter(c=>c.resourceId===lecture.id).every(c=>c.doneCount===c.sectionCount));
    check('growth report counts learned sections',(await post('/api/study/report',{kbId:'kb'})).completedSections===finishedCourse.doneCount);
    console.log('RESULT '+passed+' passed; isolated data='+dir);
  } finally {core.kill();mock.kill();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
