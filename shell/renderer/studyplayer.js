/*
 * 学·练资源单独打开页（#/study/<resourceId>[@<version>]）。
 *
 * 设计参照网页版 CourseResourcePlayer / SlidePlayer，按桌面壳的能力落地：
 *   定制讲义   = 章节块阅读 + 每节"已读"标记（服务端按条目保存）+ 资料出处；
 *   实操指南   = 步骤卡 + 完成勾选 + 验收清单（同一套条目标记）；
 *   分阶测试   = 逐题作答 + 即时反馈与解析 + 结束小结；作答进入服务端学习证据；
 *   PPT 演示（交互导学） = 真实 PPTX 单页预览、翻页、方向键翻页、讲稿提示、断点续播。
 * 入口：学·练节点弹窗、成长页、对话侧栏预览（全屏打开）。
 */

function spParse(section){const raw=String(section||'');const at=raw.lastIndexOf('@');if(at<0)return{id:raw,version:0};return{id:raw.slice(0,at),version:Number(raw.slice(at+1))||0};}
function spKindLabel(kind){return (typeof RESOURCE_LABEL==='object'&&RESOURCE_LABEL[kind])||kind;}
function spDifficulty(kind){return {easy:['基础','sp-diff-easy'],medium:['进阶','sp-diff-medium'],hard:['挑战','sp-diff-hard']}[kind]||['基础','sp-diff-easy'];}

/** 当前版本已完成的条目键（讲义小节 / 实操步骤 / 验收项）。 */
function spProgressSet(res){return new Set(Array.isArray(res.progressItems)?res.progressItems.map(String):[]);}
async function spMark(res,items,item,done){
  await api('/api/learning/progress',{id:res.id,version:res.version,item,done});
  if(done)items.add(item);else items.delete(item);
}

/** 找到这份资源当前绑定的学习资源槽位（节点/知识库/状态），没有就是未收录的候选。 */
async function spFindAsset(res){
  if(!res.kbId)return null;
  try{
    const data=await courseApi('resources',{kbId:res.kbId,status:'current'});
    return (data.resources||[]).find(a=>a.learningId===res.id&&a.learningVersion===res.version)||null;
  }catch(e){return null;}
}

function spReturnToMap(asset){
  if(asset&&typeof courseUi==='object')courseUi.focusNode=asset.nodeId||'';
  return go('learn');
}

function spBreadcrumb(res,asset){
  const row=el('div','sp-crumb');
  row.appendChild(btn('← 返回思维导图','ghost sm',()=>spReturnToMap(asset).catch(e=>toast(e.message))));
  const trail=el('span','sp-crumb-trail');
  const kbName=asset&&state.cfg?((state.cfg.knowledgeBases||[]).find(k=>k.id===asset.kbId)||{}).name:'';
  const parts=[kbName,(asset&&asset.nodePath)||(asset&&asset.nodeTitle)||'',spKindLabel(res.kind)];
  trail.textContent=parts.filter(Boolean).join(' / ');
  row.appendChild(trail);
  return row;
}

function spHead(res,asset,progressText,extraActions){
  const head=el('header','sp-head');
  const main=el('div','sp-head-main');
  const title=el('h1','sp-title',res.title||spKindLabel(res.kind));
  const chips=el('div','sp-chips');
  chips.appendChild(el('span','sp-chip',spKindLabel(res.kind)));
  chips.appendChild(el('span','sp-chip','v'+res.version));
  if(asset&&asset.status&&asset.status!=='current')chips.appendChild(el('span','sp-chip sp-chip-warn',asset.status==='archive'?'历史版本':'已移除'));
  main.append(title,chips);
  const side=el('div','sp-head-side');
  if(progressText)side.appendChild(el('span','sp-progress',progressText));
  const more=btn('更多','ghost sm',()=>spMoreMenu(res,asset));
  side.appendChild(more);
  (extraActions||[]).forEach(b=>side.appendChild(b));
  head.append(main,side);
  return head;
}

function spMoreMenu(res,asset){
  const d=courseDialog('资源操作',(res.title||'')+' · v'+res.version);
  const actions=el('div','course-manage-actions');
  if(res.sessionId)actions.appendChild(btn('回到生成会话','',()=>{d.close();openChatSession(res.sessionId).catch(e=>toast(e.message));}));
  if(res.kind!=='quiz')actions.appendChild(btn(res.kind==='ppt'?'导出 pptx':'导出 Markdown','',()=>{d.close();exportResourceAs(res,res.kind==='ppt'?'pptx':'markdown');}));
  if(asset){
    actions.appendChild(btn('重新生成','',()=>{d.close();courseStartResource({id:asset.nodeId,title:asset.nodeTitle},asset.kind,true);}));
    actions.appendChild(btn('归档这份资源','ghost',()=>courseConfirm('归档这份资源？','节点上的位置会空出来，导图、学习记录与其他资源都保留；归档里随时可以恢复或改挂到别的节点。',async()=>{await courseApi('resource/action',{id:asset.id,action:'archive',confirmed:true});toast('已归档，可在学·练的归档里找回。');await go('learn');})));
    actions.appendChild(btn('移入回收站','ghost course-danger',()=>courseConfirm('移入回收站？','只移走这份资源，不删除导图、节点或学习记录。',async()=>{await courseApi('resource/action',{id:asset.id,action:'trash',confirmed:true});toast('已移入回收站。');await go('learn');})));
  }else{
    d.body.appendChild(el('p','course-replace-note','这是尚未加入学习资源的候选版本；满意后可在生成会话里收录，或在这里直接加入。'));
    const add=btn('加入我的学习资源','primary',async()=>{const handled=await offerCourseSave({path:res.artifactPath,title:res.title,text:res.markdown,learningId:res.id,learningVersion:res.version,sessionId:res.sessionId,turnId:res.turnId});if(!handled)toast('这段会话没有绑定学习节点，可先在学·练里从节点发起生成。');});
    actions.appendChild(add);
  }
  d.body.appendChild(actions);
}

function spSources(res){
  const cites=Array.isArray(res.citations)?res.citations:[];
  if(!cites.length)return null;
  const box=el('section','sp-sources');
  box.appendChild(el('h3','sp-sec-title','资料出处'));
  for(const c of cites)box.appendChild(el('p','sp-source','· '+(c.docTitle||c.title||'资料')+(c.headingPath?(' · '+c.headingPath):'')));
  box.appendChild(el('p','muted sm','出处编号对应正文里的 [n]；资料原文仍在本地知识库中。'));
  return box;
}

/* ---------- 定制讲义 ---------- */

function spLectureBlocks(res){
  const c=res.content||{},blocks=[];
  for(const[ci,ch]of (c.chapters||[]).entries()){
    for(const[si,s]of (ch.sections||[]).entries()){
      blocks.push({key:'section-'+(ci+1)+'-'+(si+1),eyebrow:'第 '+(ci+1)+' 章'+(ch.title?(' · '+ch.title):''),title:s.title||('第 '+(si+1)+' 节'),body:s.content||''});
    }
  }
  if(!blocks.length&&res.markdown)blocks.push({key:'section-1-1',eyebrow:'正文',title:res.title||'讲义',body:res.markdown});
  return blocks;
}

function spRenderLecture(page,res,asset){
  const c=res.content||{},marks=spProgressSet(res),blocks=spLectureBlocks(res);
  const counter=el('span','sp-progress');
  page.appendChild(spBreadcrumb(res,asset));
  const head=spHead(res,asset,'',[]);page.appendChild(head);
  head.querySelector('.sp-head-side').insertBefore(counter,head.querySelector('.sp-head-side').firstChild);
  const introBits=[];
  if(c.objective)introBits.push(el('p','sp-objective',c.objective));
  const objectives=Array.isArray(c.objectives)?c.objectives:[];
  if(objectives.length){
    introBits.push(el('h3','sp-sec-title','学完这一份，你应该能'));
    const list=el('ul','sp-objectives');for(const o of objectives)list.appendChild(el('li',null,o));introBits.push(list);
  }
  if(introBits.length){const intro=el('section','sp-intro');intro.append(...introBits);page.appendChild(intro);}
  const paint=()=>counter.textContent='已读 '+blocks.filter(b=>marks.has(b.key)).length+' / '+blocks.length+' 节';
  paint();
  for(const[bi,b]of blocks.entries()){
    const block=el('section','sp-block');block.dataset.item=b.key;
    const line=el('div','sp-block-head');
    line.appendChild(el('span','sp-num',String(bi+1).padStart(2,'0')));
    const right=el('div','sp-block-text');right.append(el('div','sp-eyebrow',b.eyebrow),el('h2','sp-block-title',b.title));line.appendChild(right);
    const mark=btn(marks.has(b.key)?'已读 ✓':'标记已读','ghost sm sp-mark',async()=>{try{await spMark(res,marks,b.key,!marks.has(b.key));mark.textContent=marks.has(b.key)?'已读 ✓':'标记已读';mark.classList.toggle('on',marks.has(b.key));paint();}catch(e){toast(e.message);}});
    if(marks.has(b.key))mark.classList.add('on');
    line.appendChild(mark);block.appendChild(line);
    const body=el('article','md sp-body');body.innerHTML=md(b.body||'');block.appendChild(body);
    page.appendChild(block);
  }
  page.appendChild(el('p','sp-hint','读完可在学·练里「标记学完」；阅读本身不换算成掌握度。'));
  const sources=spSources(res);if(sources)page.appendChild(sources);
  return {countText:paint};
}

/* ---------- 实操指南 ---------- */

function spRenderPractice(page,res,asset){
  const c=res.content||{},marks=spProgressSet(res);
  const steps=(c.steps||[]).map((s,i)=>({key:'step-'+(i+1),s,i}));
  const acceptance=(c.acceptanceCriteria||[]).map((t,i)=>({key:'acceptance-'+(i+1),text:t,i}));
  const counter=el('span','sp-progress');
  page.appendChild(spBreadcrumb(res,asset));
  const head=spHead(res,asset,'',[]);page.appendChild(head);
  head.querySelector('.sp-head-side').insertBefore(counter,head.querySelector('.sp-head-side').firstChild);
  const paint=()=>{const done=steps.filter(x=>marks.has(x.key)).length,acc=acceptance.filter(x=>marks.has(x.key)).length;counter.textContent='步骤 '+done+' / '+steps.length+(acceptance.length?(' · 验收 '+acc+' / '+acceptance.length):'');};
  paint();
  const introBits=[];
  if(c.objective)introBits.push(el('p','sp-objective',c.objective));
  const minutes=Number(c.estimatedMinutes)||0;if(minutes>0)introBits.push(el('p','muted sm','预计用时 '+minutes+' 分钟'));
  if((c.prerequisites||[]).length)introBits.push(el('p','sp-chip-row','前置：'+(c.prerequisites||[]).join('、')));
  if((c.environment||[]).length)introBits.push(el('p','sp-chip-row','环境：'+(c.environment||[]).join('、')));
  if(introBits.length){const intro=el('section','sp-intro');intro.append(...introBits);page.appendChild(intro);}
  const safetyText={danger:'高风险',caution:'需谨慎',['']:'常规操作'};
  for(const{key,s,i}of steps){
    const block=el('section','sp-block sp-step');block.dataset.item=key;
    const line=el('div','sp-block-head');
    line.appendChild(el('span','sp-num','S'+(i+1)));
    const right=el('div','sp-block-text');right.appendChild(el('h2','sp-block-title',s.title||('步骤 '+(i+1))));
    const safety=s.safety||'';
    right.appendChild(el('span','sp-safety sp-safety-'+safety,'风险：'+(safetyText[safety]||'常规操作')));
    line.appendChild(right);
    const mark=btn(marks.has(key)?'完成 ✓':'完成步骤','ghost sm sp-mark',async()=>{try{await spMark(res,marks,key,!marks.has(key));mark.textContent=marks.has(key)?'完成 ✓':'完成步骤';mark.classList.toggle('on',marks.has(key));paint();}catch(e){toast(e.message);}});
    if(marks.has(key))mark.classList.add('on');
    line.appendChild(mark);block.appendChild(line);
    if(s.instruction){const body=el('article','md sp-body');body.innerHTML=md(s.instruction);block.appendChild(body);}
    if(s.code)block.appendChild(el('pre','sp-code',s.code));
    if(s.expectedOutput)block.appendChild(el('p','sp-expected','预期结果：'+s.expectedOutput));
    if(s.warning)block.appendChild(el('p','sp-warning','提醒：'+s.warning));
    page.appendChild(block);
  }
  if(acceptance.length){
    const box=el('section','sp-block sp-accept');box.appendChild(el('h3','sp-sec-title','验收清单'));
    for(const{key,text}of acceptance){
      const row=btn('','sp-check'+(marks.has(key)?' on':''),async()=>{try{await spMark(res,marks,key,!marks.has(key));row.classList.toggle('on',marks.has(key));row.querySelector('span').textContent=marks.has(key)?'☑':'☐';paint();}catch(e){toast(e.message);}});
      row.appendChild(el('span','sp-check-box',marks.has(key)?'☑':'☐'));row.appendChild(el('span','grow',text));box.appendChild(row);
    }
    page.appendChild(box);
  }
  const sources=spSources(res);if(sources)page.appendChild(sources);
  return {countText:paint};
}

/* ---------- 分阶测试 ---------- */

function spRenderQuiz(page,res,asset){
  const qs=res.content?.questions||[];
  const saved=res.answers||{};
  if(!qs.length){page.appendChild(spBreadcrumb(res,asset));page.appendChild(spHead(res,asset,'',[]));page.appendChild(el('p','sp-hint','这份测试里没有题目。'));return{countText:()=>0};}
  const counter=el('span','sp-progress');
  page.appendChild(spBreadcrumb(res,asset));const head=spHead(res,asset,'',[]);page.appendChild(head);
  head.querySelector('.sp-head-side').insertBefore(counter,head.querySelector('.sp-head-side').firstChild);
  const state={idx:Math.min(qs.findIndex(q=>!saved[q.id])<0?qs.length-1:qs.findIndex(q=>!saved[q.id]),qs.length-1),local:{},fresh:false};
  const prevAnswer=q=>state.local[q.id]||(state.fresh?null:saved[q.id]);
  const finished=()=>Object.keys(saved).length+Object.keys(state.local).length;
  const paint=()=>counter.textContent='已答 '+finished()+' / '+qs.length+' 题';
  paint();
  const bar=el('div','sp-qbar');const fill=el('span','sp-qbar-fill');bar.appendChild(fill);page.appendChild(bar);
  const host=el('section','sp-quiz');page.appendChild(host);
  const paintBar=()=>{fill.style.width=Math.round(finished()/qs.length*100)+'%';};
  paintBar();
  const render=()=>{
    host.replaceChildren();
    if(state.idx>=qs.length){spQuizSummary(host,res,asset,qs,paint,state,render);return;}
    const q=qs[state.idx];let prev=prevAnswer(q);
    const [diffLabel,diffCls]=spDifficulty(q.difficulty);
    const card=el('section','sp-q');
    const meta=el('div','sp-q-meta');meta.append(el('span','sp-q-index','第 '+(state.idx+1)+' / '+qs.length+' 题'),el('span','sp-chip '+diffCls,diffLabel));card.appendChild(meta);
    card.appendChild(el('h2','sp-q-stem',q.stem||q.question||''));
    const options=el('div','sp-options');card.appendChild(options);
    const feedback=el('div','sp-feedback');feedback.setAttribute('aria-live','polite');card.appendChild(feedback);
    const footer=el('div','sp-q-foot');card.appendChild(footer);
    const chosen=prev?Number(prev.choice):-1;
    for(const[i,text]of (q.options||[]).entries()){
      const o=btn('','sp-opt',async()=>{
        if(prev)return;
        const attempt=crypto.randomUUID();
        options.querySelectorAll('button').forEach(b=>b.disabled=true);
        try{
          const r=await api('/api/learning/answer',{id:res.id,version:res.version,questionId:q.id,choice:i,attemptId:attempt});
          state.local[q.id]=r;prev=r;
          paintOption(options,q,i,r);
          spFeedback(feedback,r,q);
          paint();paintBar();
          footer.appendChild(btn(state.idx>=qs.length-1?'查看小结':'下一题 →','primary',()=>{if(state.idx<qs.length-1)state.idx+=1;else state.idx=qs.length;render();}));
        }catch(e){options.querySelectorAll('button').forEach(b=>b.disabled=false);feedback.textContent='提交失败：'+e.message;}
      });
      o.appendChild(el('span','sp-opt-letter',String.fromCharCode(65+i)));
      o.appendChild(el('span','grow',text));
      options.appendChild(o);
      if(prev){
        o.disabled=true;
        if(i===chosen)o.classList.add('chosen');
      }
    }
    if(prev){paintOption(options,q,chosen,prev);spFeedback(feedback,prev,q);
      footer.appendChild(btn(state.idx>=qs.length-1?'查看小结':'下一题 →','primary',()=>{if(state.idx<qs.length-1)state.idx+=1;else state.idx=qs.length;render();}));
    }
    host.appendChild(card);
  };
  const paintOption=(options,q,choice,r)=>{
    options.querySelectorAll('button').forEach((b,i)=>{b.classList.remove('chosen','right','wrong');if(i===Number(r.choice))b.classList.add('chosen');});
    const rightIdx=Number(r.correctIndex);
    if(Number.isFinite(rightIdx)){options.querySelectorAll('button').forEach((b,i)=>{if(i===rightIdx)b.classList.add('right');else if(i===choice&&!r.correct)b.classList.add('wrong');});}
  };
  const spFeedback=(box,r,q)=>{box.classList.toggle('right',!!r.correct);box.textContent=(r.correct?'✓ 回答正确。':('✗ 答错了，正确答案是 '+String.fromCharCode(65+Number(r.correctIndex))+'。'))+(r.explanation||'');};
  render();
  return {countText:paint};
}

function spQuizSummary(host,res,asset,qs,paint,state,rerender){
  const all=qs.map(q=>state.local[q.id]).filter(Boolean);
  const right=all.filter(r=>r.correct).length;
  const box=el('section','sp-summary');
  box.appendChild(el('h2',null,'这一轮答对 '+right+' / '+qs.length+' 题'));
  box.appendChild(el('p','muted','首次作答会进入学习证据；再做一遍只用于练习，不会重复计分。'));
  const row=el('div','sp-summary-actions');
  row.appendChild(btn('再做一遍','primary',()=>{state.idx=0;state.local={};state.fresh=true;rerender();paint();}));
  row.appendChild(btn('回到思维导图','ghost',()=>spReturnToMap(asset).catch(e=>toast(e.message))));
  box.appendChild(row);
  host.appendChild(box);
}

/* ---------- PPT 演示（交互导学） ---------- */

function spGuideIconButton(label,iconName,cls,onClick){
  const b=el('button','sp-guide-icon-btn'+(cls?' '+cls:''),'');
  b.type='button';b.title=label;b.setAttribute('aria-label',label);b.innerHTML=icon(iconName);
  if(onClick)b.addEventListener('click',onClick);
  return b;
}

function spGuideTruth(value){return value===true||value==='true'||value===1||value==='1';}
function spGuideText(value){return value==null?'':String(value);}
function spGuideClip(value,max){const s=spGuideText(value).replace(/\s+/g,' ').trim();return s.length>max?s.slice(0,max).trimEnd()+'…':s;}

function spRenderPpt(page,res,asset){
  page.classList.add('sp-page-guided');
  const fallbackSlides=Array.isArray(res.content?.slides)?res.content.slides:[];
  const artifactKey='resource:'+res.id+':v'+res.version;
  const state={
    idx:0,total:fallbackSlides.length,previewDocs:[],previewTitles:[],ready:false,loadingPreview:true,
    sessionId:'',sessions:[],sessionsLoading:false,creating:false,cleaned:false,
    saveTimer:0,focusTimer:0,focusSeq:0,focusPromise:null,focusedSlide:0,userNavigated:false,
    notesOpen:false,chatOpen:innerWidth>980,wasNarrow:innerWidth<=980,noteDialog:null,entries:new Map()
  };
  if(!fallbackSlides.length){page.appendChild(el('p','sp-hint','这份演示没有可播放的页面。'));return{countText:()=>0};}

  const layout=el('div','sp-study-layout');
  const deck=el('section','sp-study-deck');
  const stage=el('div','sp-stage');
  const frameHost=el('div','sp-slide-frame');
  const loading=el('div','sp-stage-loading','正在载入 PPT…');
  const notesPanel=el('aside','sp-stage-notes');notesPanel.hidden=true;
  const top=el('div','sp-stage-top');
  const back=spGuideIconButton('返回知识网络','','',()=>spReturnToMap(asset).catch(e=>toast(e.message)));
  back.classList.add('sp-stage-icon');
  back.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  const deckTitle=el('div','sp-stage-title',res.title||'PPT 演示');
  const chatToggle=spGuideIconButton('打开对话','','',()=>setChatOpen(!state.chatOpen));
  chatToggle.classList.add('sp-stage-icon','sp-stage-chat-toggle');
  chatToggle.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>';
  top.append(back,deckTitle,chatToggle);

  const bar=el('footer','sp-stage-bar');
  const prev=btn('上一页','ghost sm',()=>jump(state.idx-1));
  const pos=el('span','sp-stage-pos','1 / '+state.total);
  const next=btn('下一页','ghost sm',()=>jump(state.idx+1));
  const notesBtn=btn('讲稿','ghost sm',()=>{state.notesOpen=!state.notesOpen;notesPanel.hidden=!state.notesOpen;notesBtn.classList.toggle('on',state.notesOpen);});
  const controls=el('div','sp-stage-controls');controls.append(prev,pos,next);
  bar.append(controls,notesBtn);
  stage.append(frameHost,loading,notesPanel,top);
  deck.append(stage,bar);

  const chat=el('aside','sp-study-chat');
  chat.setAttribute('aria-label','演示对话');
  const chatHead=el('header','sp-chat-head');
  const sessionSelect=el('select','sp-chat-session');
  sessionSelect.setAttribute('aria-label','切换导学会话');
  const newSessionBtn=spGuideIconButton('新建会话','','',()=>createSession());
  newSessionBtn.innerHTML=icon('plus');
  const noteBtn=spGuideIconButton('记笔记','','',()=>openGuidedNote());
  noteBtn.innerHTML=icon('pencil');
  chatHead.append(sessionSelect,newSessionBtn,noteBtn);
  const thread=el('div','sp-chat-thread');
  const composer=el('footer','sp-chat-composer');
  const input=el('textarea','sp-chat-input');
  input.rows=2;input.placeholder='问这一页';input.setAttribute('aria-label','问这一页');
  const composeRow=el('div','sp-chat-compose-row');
  const scope=el('span','sp-chat-scope','第 1 页');
  const send=el('button','sp-chat-send','');
  send.type='button';send.setAttribute('aria-label','发送');send.title='发送';
  const ICON_SEND='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const ICON_STOP='<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
  send.innerHTML=ICON_SEND;
  composeRow.append(scope,send);composer.append(input,composeRow);
  chat.append(chatHead,thread,composer);
  const scrim=el('div','sp-chat-scrim');scrim.hidden=true;
  layout.append(deck,chat);page.append(layout,scrim);

  const currentSlide=()=>fallbackSlides[state.idx]||{};
  const currentTitle=()=>state.previewTitles[state.idx]||currentSlide().title||('第 '+(state.idx+1)+' 页');
  const entryFor=id=>{
    if(!id)return {id:'',events:[],lastId:0,loaded:true,busy:false,stopping:false,pendingUser:'',error:'',notices:[],draft:'',controller:null,pollTimer:0,polling:false,context:null};
    let e=state.entries.get(id);
    if(!e){e={id,events:[],lastId:0,loaded:false,busy:false,stopping:false,pendingUser:'',error:'',notices:[],draft:'',controller:null,pollTimer:0,polling:false,context:null};state.entries.set(id,e);}
    return e;
  };
  const activeEntry=()=>entryFor(state.sessionId);

  const setChatOpen=open=>{
    state.chatOpen=!!open;
    chat.classList.toggle('open',state.chatOpen);
    chat.setAttribute('aria-hidden',state.chatOpen?'false':'true');
    scrim.hidden=!(state.chatOpen&&innerWidth<=980);
  };
  const syncComposer=()=>{
    const e=activeEntry(),busy=!!e.busy;
    input.value=e.draft||'';
    input.disabled=!state.sessionId||busy;
    send.disabled=!state.sessionId||(!busy&&!input.value.trim());
    send.classList.toggle('stop',busy);
    send.innerHTML=busy?ICON_STOP:ICON_SEND;
    send.setAttribute('aria-label',busy?'停止':(e.stopping?'正在停止':'发送'));
    send.title=busy?'停止':'发送';
    noteBtn.disabled=!state.sessionId;
    newSessionBtn.disabled=state.creating||!state.ready;
    sessionSelect.disabled=!state.sessions.length||state.sessionsLoading;
    scope.textContent='第 '+(state.idx+1)+' 页';
  };

  const paintSessionOptions=()=>{
    sessionSelect.replaceChildren();
    if(!state.sessions.length){
      const o=document.createElement('option');o.textContent='正在准备会话…';o.value='';sessionSelect.appendChild(o);
      return;
    }
    for(const item of state.sessions){
      const o=document.createElement('option');o.value=item.sessionId||'';
      const title=item.title||'导学会话';
      const stamp=item.lastAt?String(item.lastAt).replace('T',' ').slice(5,16):'';
      o.textContent=stamp?title+' · '+stamp:title;
      sessionSelect.appendChild(o);
    }
    if(state.sessionId&&!state.sessions.some(x=>x.sessionId===state.sessionId)){
      const o=document.createElement('option');o.value=state.sessionId;o.textContent='当前导学会话';sessionSelect.appendChild(o);
    }
    sessionSelect.value=state.sessionId;
  };

  const paintMessages=()=>{
    const e=activeEntry();
    thread.replaceChildren();
    const turns=typeof turnsFromEvents==='function'?turnsFromEvents(e.events||[]):[];
    if(!turns.length&&!e.pendingUser&&!e.busy&&!e.error&&!e.notices.length){
      const empty=el('div','sp-chat-empty');
      empty.append(el('p',null,'从当前页开始问。'));
      const quick=el('div','sp-chat-quick');
      quick.append(btn('解释本页','ghost sm',()=>submitQuestion('请解释当前页的核心内容，并指出最容易混淆的一点。')),btn('举个例子','ghost sm',()=>submitQuestion('请结合当前页内容举一个具体例子。')));
      empty.appendChild(quick);thread.appendChild(empty);
    }
    for(const t of turns){
      if(t.user){const bubble=el('article','sp-chat-msg user');bubble.textContent=t.user;thread.appendChild(bubble);}
      for(const it of t.items||[]){
        if(it.t==='a'){
          const bubble=el('article','sp-chat-msg assistant'+(it.streaming?' streaming':''));
          const body=el('div','md');body.innerHTML=md(it.text||'');bubble.appendChild(body);
          if(it.streaming)bubble.appendChild(el('span','sp-chat-caret'));
          thread.appendChild(bubble);
        }else if(it.t==='tool'){
          const d=el('details','sp-chat-tool');
          const sum=el('summary','sp-chat-tool-sum');
          sum.append(el('span','sp-chat-tool-dot'+(it.ok===false?' failed':'')),el('span','grow',it.name||'工具'),el('span','sp-chat-tool-state',it.running?'运行':(it.ok===false?'失败':'完成')));
          d.appendChild(sum);
          if(it.args&&Object.keys(it.args).length)d.appendChild(el('pre','sp-chat-tool-detail',JSON.stringify(it.args,null,2)));
          if(it.summary)d.appendChild(el('pre','sp-chat-tool-detail',spGuideClip(it.summary,1600)));
          thread.appendChild(d);
        }else if(it.t==='think'&&it.text){
          const d=el('details','sp-chat-think');d.append(el('summary',null,'思考'),el('p',null,it.text));thread.appendChild(d);
        }
      }
      if(t.ok===false&&t.message)thread.appendChild(el('p','sp-chat-error',t.message));
    }
    if(e.pendingUser)thread.appendChild(el('article','sp-chat-msg user',e.pendingUser));
    for(const n of e.notices){const box=el('article','sp-chat-note');box.append(el('strong',null,n.title||'笔记'),el('p',null,n.text));thread.appendChild(box);}
    if(e.error)thread.appendChild(el('p','sp-chat-error',e.error));
    if(e.busy&&!turns.some(t=>(t.items||[]).some(it=>it.t==='a'&&it.streaming))){
      const typing=el('div','sp-chat-typing');typing.append(el('span'),el('span'),el('span'));thread.appendChild(typing);
    }
    requestAnimationFrame(()=>{if(state.chatOpen)thread.scrollTop=thread.scrollHeight;});
  };

  const fitSlideFrame=()=>{
    const child=frameHost.firstElementChild;
    if(!child)return;
    const cs=getComputedStyle(frameHost);
    const availableWidth=Math.max(1,frameHost.clientWidth-parseFloat(cs.paddingLeft||0)-parseFloat(cs.paddingRight||0));
    const availableHeight=Math.max(1,frameHost.clientHeight-parseFloat(cs.paddingTop||0)-parseFloat(cs.paddingBottom||0));
    let width=availableWidth,height=width*9/16;
    if(height>availableHeight){height=availableHeight;width=height*16/9;}
    child.style.width=Math.floor(width)+'px';
    child.style.height=Math.floor(height)+'px';
  };

  const paintSlide=()=>{
    const doc=state.previewDocs[state.idx];
    frameHost.replaceChildren();
    if(doc){
      const frame=el('iframe','sp-ppt-frame');frame.title=currentTitle();frame.setAttribute('sandbox','');frame.srcdoc=doc;frameHost.appendChild(frame);
    }else{
      const s=currentSlide(),fallback=el('article','sp-slide-fallback');
      fallback.appendChild(el('div','sp-slide-kicker','PPT · '+(state.idx+1).toString().padStart(2,'0')));
      fallback.appendChild(el('h2',null,s.title||currentTitle()));
      const bullets=Array.isArray(s.bullets)?s.bullets:[];
      if(bullets.length){const ul=el('ul','sp-slide-bullets');for(const b of bullets)ul.appendChild(el('li',null,b));fallback.appendChild(ul);}
      if(s.body){const body=el('div','md sp-slide-body');body.innerHTML=md(s.body);fallback.appendChild(body);}
      frameHost.appendChild(fallback);
    }
    loading.hidden=true;requestAnimationFrame(fitSlideFrame);
  };

  const paintChrome=()=>{
    pos.textContent=(state.idx+1)+' / '+state.total;
    scope.textContent='第 '+(state.idx+1)+' 页';
    prev.disabled=state.idx<=0;
    next.disabled=state.idx>=state.total-1;
    const s=currentSlide();
    notesPanel.textContent=s.speakerNote?("讲稿\n"+s.speakerNote):'这一页没有讲稿。';
    notesPanel.hidden=!state.notesOpen;
    notesBtn.classList.toggle('on',state.notesOpen);
    deckTitle.textContent=res.title||currentTitle();
  };

  const paintAll=()=>{paintSlide();paintChrome();paintMessages();syncComposer();paintSessionOptions();};

  const persistProgress=immediate=>{
    if(state.saveTimer){clearTimeout(state.saveTimer);state.saveTimer=0;}
    const body={name:artifactKey,page:state.idx+1,pageCount:state.total};
    if(immediate)return api('/api/artifacts/progress/save',body).catch(()=>{});
    state.saveTimer=setTimeout(()=>{state.saveTimer=0;api('/api/artifacts/progress/save',body).catch(()=>{});},320);
    return Promise.resolve();
  };

  const focusFor=async(sessionId,slide,entry)=>{
    if(!sessionId)return null;
    if(state.focusPromise&&state.focusPromise.sessionId===sessionId&&state.focusPromise.slide===slide)return state.focusPromise.promise;
    const seq=++state.focusSeq;
    const promise=api('/api/guided/focus',{sessionId,slide}).then(context=>{
      if(seq===state.focusSeq){entry.context=context;if(state.sessionId===sessionId)paintAll();}
      return context;
    }).finally(()=>{if(state.focusPromise?.promise===promise)state.focusPromise=null;});
    state.focusPromise={sessionId,slide,promise};return promise;
  };
  const queueFocus=()=>{
    const sid=state.sessionId,slide=state.idx+1,entry=activeEntry();
    if(!sid)return;
    if(state.focusTimer)clearTimeout(state.focusTimer);
    state.focusTimer=setTimeout(()=>{state.focusTimer=0;focusFor(sid,slide,entry).catch(()=>{});},150);
  };

  const jump=i=>{
    const target=Math.max(0,Math.min(state.total-1,i));
    if(target===state.idx)return;
    state.idx=target;state.userNavigated=true;paintAll();persistProgress(false);queueFocus();
  };

  const loadEntry=async entry=>{
    if(!entry?.id)return;
    const d=await api('/api/sessions/events',{sessionId:entry.id});
    entry.events=d.events||[];entry.lastId=Number(d.lastId||0);entry.loaded=true;
    if(entry.pendingUser&&entry.events.some(e=>e.type==='user/message'&&spGuideText(e.payload?.text)===entry.pendingUser))entry.pendingUser='';
    if(state.sessionId===entry.id)paintMessages();
  };

  const pollEntry=async entry=>{
    if(!entry?.id||entry.polling)return;
    entry.polling=true;
    try{
      const d=await api('/api/sessions/events',{sessionId:entry.id,sinceId:entry.lastId||0});
      const fresh=d.events||[];
      if(fresh.length)entry.events=entry.events.concat(fresh);
      entry.lastId=Number(d.lastId||entry.lastId||0);
      if(entry.pendingUser&&entry.events.some(e=>e.type==='user/message'&&spGuideText(e.payload?.text)===entry.pendingUser))entry.pendingUser='';
      if(state.sessionId===entry.id&&!state.cleaned)paintMessages();
    }catch(e){}finally{entry.polling=false;}
  };

  const refreshSessions=async()=>{
    if(state.sessionsLoading)return;
    state.sessionsLoading=true;syncComposer();
    try{
      const d=await api('/api/guided/sessions',{resourceId:res.id,version:res.version});
      state.sessions=d.sessions||[];
      if(state.sessionId&&!state.sessions.some(x=>x.sessionId===state.sessionId))state.sessions.unshift({sessionId:state.sessionId,title:'当前导学会话',lastAt:''});
      paintSessionOptions();
    }catch(e){if(!state.cleaned)toast('会话列表读取失败：'+e.message);}
    finally{state.sessionsLoading=false;syncComposer();}
  };

  const activate=async(resolved,loadHistory)=>{
    if(!resolved?.sessionId)return;
    state.sessionId=resolved.sessionId;
    state.ready=true;
    const entry=entryFor(state.sessionId);
    entry.context=resolved.context||entry.context;
    const slide=Math.max(1,Math.min(state.total,Number(resolved.slide||entry.context?.currentSlide||1)));
    state.idx=slide-1;state.focusedSlide=slide;
    if(loadHistory&&!entry.loaded)await loadEntry(entry).catch(e=>{entry.error=e.message;});
    paintAll();
    if(typeof reloadSessions==='function')reloadSessions().catch(()=>{});
  };

  const createSession=async()=>{
    if(state.creating||!state.ready)return;
    state.creating=true;syncComposer();
    try{
      const resolved=await api('/api/guided/session/new',{resourceId:res.id,version:res.version,slide:state.idx+1});
      await activate(resolved,true);
      await refreshSessions();
      toast('已新建导学会话');
    }catch(e){toast('新建会话失败：'+e.message);}
    finally{state.creating=false;syncComposer();}
  };

  const switchSession=async sessionId=>{
    if(!sessionId||sessionId===state.sessionId)return;
    try{
      const resolved=await api('/api/guided/session/select',{resourceId:res.id,version:res.version,sessionId});
      await activate(resolved,true);
      await refreshSessions();
    }catch(e){toast('切换会话失败：'+e.message);sessionSelect.value=state.sessionId||'';}
  };

  const submitQuestion=async raw=>{
    const text=spGuideText(raw===undefined?input.value:raw).trim();
    const entry=activeEntry(),sid=state.sessionId;
    if(!text||!sid||entry.busy)return;
    const chapter=currentTitle();
    entry.draft='';entry.error='';entry.pendingUser=text;entry.busy=true;entry.stopping=false;
    input.value='';syncComposer();paintMessages();
    await focusFor(sid,state.idx+1,entry).catch(()=>{});
    entry.controller=new AbortController();
    entry.pollTimer=setInterval(()=>pollEntry(entry),280);
    try{
      const result=await api('/api/agent/ask-pi',{
        kbId:'',question:text,attachments:[],sessionId:sid,web:'auto',mode:'chat',skill:'',
        perm:state.cfg?.agentPerm||'auto',ctxChapter:chapter
      },entry.controller.signal);
      if(result?.ok===false)throw new Error(result.message||'这一轮没有完成');
    }catch(e){
      if(e.name!=='AbortError'&&!entry.stopping)entry.error=e.message||'这一轮没有完成';
    }finally{
      if(entry.pollTimer){clearInterval(entry.pollTimer);entry.pollTimer=0;}
      await pollEntry(entry).catch(()=>{});
      await loadEntry(entry).catch(()=>{});
      entry.busy=false;entry.stopping=false;entry.controller=null;entry.pendingUser='';
      if(state.sessionId===sid&&!state.cleaned){syncComposer();paintMessages();}
      if(typeof reloadSessions==='function')reloadSessions().catch(()=>{});
    }
  };

  const stopQuestion=async()=>{
    const entry=activeEntry(),sid=state.sessionId;
    if(!sid||!entry.busy||entry.stopping)return;
    entry.stopping=true;syncComposer();
    try{
      await api('/api/agent/cancel',{sessionId:sid});
      entry.controller?.abort();
    }catch(e){entry.error=e.message;entry.stopping=false;syncComposer();paintMessages();}
  };

  const openGuidedNote=async()=>{
    const sid=state.sessionId;
    if(!sid){toast('导学会话还没有准备好');return;}
    const entry=entryFor(sid);
    await focusFor(sid,state.idx+1,entry).catch(()=>{});
    const slide=currentSlide(),bullets=Array.isArray(slide.bullets)?slide.bullets:[];
    const source=spGuideText(bullets[0]||slide.speakerNote||slide.title).trim();
    const d=courseDialog('记笔记',(currentTitle())+' · 第 '+(state.idx+1)+' 页');
    state.noteDialog=d;
    const body=el('div','sp-note-form');
    if(source)body.appendChild(el('p','sp-note-source','来源：'+source));
    const area=el('textarea','sp-note-textarea');area.rows=7;area.placeholder='写下你的理解、疑问或例子…';
    const actions=el('div','sp-note-actions');
    const cancel=btn('取消','ghost',()=>d.close());
    const save=btn('保存','primary',async()=>{
      const text=area.value.trim();if(!text){area.focus();return;}
      save.disabled=true;
      try{
        const note=await api('/api/guided/note',{sessionId:sid,title:'',text,quote:source});
        entry.notices.push({title:note?.title||'笔记已保存',text});
        d.close();state.noteDialog=null;toast('笔记已保存到当前页');paintMessages();
      }catch(e){toast(e.message);save.disabled=false;}
    });
    actions.append(cancel,save);body.append(area,actions);d.body.appendChild(body);area.focus();
  };

  const hydratePptPreview=async()=>{
    try{
      if(!res.artifactPath||!window.itnWindow?.readResourceFile)return;
      const data=await window.itnWindow.readResourceFile(res.artifactPath);
      if(!data?.ok||!data.html)return;
      const doc=new DOMParser().parseFromString(data.html,'text/html');
      const css=Array.from(doc.querySelectorAll('style')).map(x=>x.textContent||'').join('\n');
      const sections=Array.from(doc.querySelectorAll('.slide'));
      if(!sections.length)return;
      const override='html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}body{padding:0!important;display:grid;place-items:center}.slide{width:100%!important;max-width:none!important;height:100%!important;margin:0!important;border-radius:0!important;box-shadow:none!important}';
      state.previewDocs=sections.map(section=>'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>'+css+'\n'+override+'</style></head><body>'+section.outerHTML+'</body></html>');
      state.previewTitles=sections.map((section,i)=>section.querySelector('h2')?.textContent?.trim()||fallbackSlides[i]?.title||('第 '+(i+1)+' 页'));
      state.total=state.previewDocs.length;
    }catch(e){}
    finally{
      state.loadingPreview=false;
      if(!state.cleaned){state.idx=Math.max(0,Math.min(state.total-1,state.idx));paintAll();}
    }
  };

  const loadGuided=async()=>{
    try{
      const resolved=await api('/api/guided/session/resolve',{resourceId:res.id,version:res.version});
      if(state.cleaned||!page.isConnected)return;
      let slide=Math.max(1,Math.min(state.total,Number(resolved.slide||1)));
      if(spGuideTruth(resolved.created)){
        const legacy=await api('/api/artifacts/progress',{name:artifactKey}).catch(()=>null);
        const pageNo=Number(legacy?.page||0);
        if(pageNo>1&&pageNo<=state.total)slide=pageNo;
      }
      // 初始化是异步的：用户在 resolve 返回前已翻页时，以本地页码为准，
      // 不能再用旧响应把页面拉回第一页。会话激活后把该页焦点补写回服务端。
      resolved.slide=state.userNavigated?(state.idx+1):slide;
      await activate(resolved,true);
      if(state.userNavigated)queueFocus();
      await refreshSessions();
    }catch(e){
      if(state.cleaned)return;
      activeEntry().error='导学会话暂不可用：'+e.message;
      paintMessages();
    }
  };

  sessionSelect.addEventListener('change',()=>switchSession(sessionSelect.value));
  newSessionBtn.addEventListener('click',event=>{event.stopPropagation();createSession();});
  noteBtn.addEventListener('click',event=>{event.stopPropagation();openGuidedNote();});
  input.addEventListener('input',()=>{activeEntry().draft=input.value;syncComposer();});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();submitQuestion();}});
  send.addEventListener('click',()=>{const entry=activeEntry();if(entry.busy)stopQuestion();else submitQuestion();});
  scrim.addEventListener('click',()=>setChatOpen(false));

  const onKey=e=>{
    if(current!=='study'||!stage.isConnected)return;
    const target=e.target;
    if(target?.closest?.('.sp-study-chat,.course-modal-overlay'))return;
    if(['INPUT','TEXTAREA','SELECT'].includes(target?.tagName)||target?.isContentEditable||target?.closest?.('button,a,[role="button"]'))return;
    if(e.key==='Escape'&&state.chatOpen&&innerWidth<=980){e.preventDefault();setChatOpen(false);return;}
    if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key===' '||e.key==='PageDown'){e.preventDefault();jump(state.idx+1);}
    else if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();jump(state.idx-1);}
    else if(e.key==='Home'){e.preventDefault();jump(0);}
    else if(e.key==='End'){e.preventDefault();jump(state.total-1);}
  };
  const onResize=()=>{
    const narrow=innerWidth<=980;
    if(narrow&&!state.wasNarrow)state.chatOpen=false;
    state.wasNarrow=narrow;setChatOpen(narrow?state.chatOpen:true);fitSlideFrame();
  };
  window.addEventListener('keydown',onKey);window.addEventListener('resize',onResize);
  const slideObserver=new ResizeObserver(()=>fitSlideFrame());slideObserver.observe(frameHost);

  const cleanup=()=>{
    if(state.cleaned)return;state.cleaned=true;
    observer.disconnect();slideObserver.disconnect();window.removeEventListener('keydown',onKey);window.removeEventListener('resize',onResize);
    if(state.saveTimer)clearTimeout(state.saveTimer);if(state.focusTimer)clearTimeout(state.focusTimer);
    for(const entry of state.entries.values())if(entry.pollTimer){clearInterval(entry.pollTimer);entry.pollTimer=0;}
    state.noteDialog?.close?.();persistProgress(true);
  };
  const observer=new MutationObserver(()=>{if(!page.isConnected)cleanup();});
  observer.observe(document.getElementById('view'),{childList:true});

  setChatOpen(innerWidth>980);paintAll();persistProgress(false);
  hydratePptPreview();
  loadGuided();
  return{countText:()=>state.total};
}
/* ---------- 页面装配 ---------- */

async function renderStudyPlayer(){
  const generation=state.navigationGeneration;
  const raw=String(currentSection||'');const{id,version}=spParse(raw);
  const view=$('view');view.replaceChildren();
  const page=el('div','sp-page');view.appendChild(page);
  if(!id){page.appendChild(el('p','sp-hint','缺少资源编号。'));return;}
  let res;
  try{res=await api('/api/learning/resource',{id,version});}
  catch(e){page.appendChild(emptyState({art:'alert',title:'这份资源暂时打不开',text:e.message,actions:[btn('回到学·练','primary',()=>go('learn'))]}));return;}
  if(generation!==state.navigationGeneration||current!=='study')return;
  const asset=await spFindAsset(res);
  if(generation!==state.navigationGeneration||current!=='study')return;
  if(res.kind==='lecture')spRenderLecture(page,res,asset);
  else if(res.kind==='practice')spRenderPractice(page,res,asset);
  else if(res.kind==='quiz')spRenderQuiz(page,res,asset);
  else if(res.kind==='ppt')await spRenderPpt(page,res,asset);
  else{
    page.appendChild(spBreadcrumb(res,asset));page.appendChild(spHead(res,asset,'',[]));
    const article=el('article','md sp-body');article.innerHTML=md(res.markdown||'');page.appendChild(article);
    const sources=spSources(res);if(sources)page.appendChild(sources);
  }
  const foot=el('footer','sp-foot');
  if(res.sessionId)foot.appendChild(btn('回到生成会话','ghost sm',()=>openChatSession(res.sessionId).catch(e=>toast(e.message))));
  foot.appendChild(el('span','muted sm','资源 v'+res.version+(res.createdAt?(' · '+String(res.createdAt).replace('T',' ').slice(0,16)):'')));
  page.appendChild(foot);
}

PAGES.study={render:renderStudyPlayer};
PAGE_META.study={title:'学习资源',sub:'阅读、实操与作答都在这一页'};
