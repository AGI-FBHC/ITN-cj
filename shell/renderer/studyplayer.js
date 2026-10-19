/*
 * 学·练资源单独打开页（#/study/<resourceId>[@<version>]）。
 *
 * 设计参照网页版 CourseResourcePlayer / SlidePlayer，按桌面壳的能力落地：
 *   定制讲义   = 章节块阅读 + 每节"已读"标记（服务端按条目保存）+ 资料出处；
 *   实操指南   = 步骤卡 + 完成勾选 + 验收清单（同一套条目标记）；
 *   分阶测试   = 逐题作答 + 即时反馈与解析 + 结束小结；作答进入服务端学习证据；
 *   在线演示（交互导学） = 幻灯片播放、方向键翻页、讲稿提示、断点续播。
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

/* ---------- 在线演示（交互导学） ---------- */

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
  const slides=Array.isArray(res.content?.slides)?res.content.slides:[];
  const counter=el('span','sp-progress');
  const state={
    idx:0,sessionId:'',context:null,events:[],lastId:0,busy:false,pendingUser:'',error:'',
    requests:[],answered:{},answering:'',notices:[],open:innerWidth>940,wasNarrow:innerWidth<=940,
    saveTimer:0,focusTimer:0,focusSeq:0,focusPromise:null,focusedSlide:0,userNavigated:false,requestController:null,
    pollInFlight:false,cleaned:false,noteDialog:null
  };
  const toggle=btn('收起','ghost sm');
  toggle.classList.add('sp-guide-toggle');toggle.setAttribute('aria-expanded','true');
  page.appendChild(spBreadcrumb(res,asset));
  const head=spHead(res,asset,'',[toggle]);page.appendChild(head);
  head.querySelector('.sp-head-side').insertBefore(counter,head.querySelector('.sp-head-side').firstChild);
  if(!slides.length){page.appendChild(el('p','sp-hint','这份演示没有可播放的页面。'));return{countText:()=>0};}

  const key='resource:'+res.id+':v'+res.version;
  const shell=el('div','sp-guided-layout guide-open');
  const main=el('section','sp-guided-main');
  const panel=el('aside','sp-guide-panel');
  panel.setAttribute('aria-label','交互导学侧栏');
  const scrim=el('div','sp-guide-scrim');scrim.hidden=true;
  shell.append(main,panel);page.append(shell,scrim);

  const stage=el('section','sp-slides');
  const canvas=el('div','sp-slide');
  const notes=el('aside','sp-notes');notes.hidden=true;
  const controls=el('div','sp-slide-controls');
  const prev=btn('‹ 上一页','ghost',()=>jump(state.idx-1));
  const next=btn('下一页 ›','primary',()=>jump(state.idx>=slides.length-1?0:state.idx+1));
  const pos=el('span','sp-slide-pos');
  const notesBtn=btn('讲稿','ghost sm',()=>{notes.hidden=!notes.hidden;notesBtn.classList.toggle('on',!notes.hidden);});
  const dots=el('div','sp-dots');
  controls.append(prev,pos,next,notesBtn);
  stage.append(canvas,notes,dots,controls);
  main.appendChild(stage);
  main.appendChild(el('p','sp-hint','← → 或空格翻页。右侧导学与当前页同步，打开页面不会自动调用模型。'));

  const panelHead=el('header','sp-guide-head');
  const panelTitleBox=el('div','sp-guide-title-box');
  const panelTitle=el('div','sp-guide-title-line');
  const panelMark=el('span','sp-guide-mark');panelMark.innerHTML=icon('book');
  panelTitle.append(panelMark,el('strong',null,'导学'));
  const panelMeta=el('div','sp-guide-meta');
  const pageTitle=el('h3','sp-guide-page-title');
  const pageSummary=el('p','sp-guide-page-summary');
  panelMeta.append(pageTitle,pageSummary);panelTitleBox.append(panelTitle,panelMeta);
  const noteButton=spGuideIconButton('记笔记','pencil','sp-guide-note-button',()=>openGuidedNote());
  const collapseButton=spGuideIconButton('收起导学','close','sp-guide-collapse',()=>setPanelOpen(false));
  panelHead.append(panelTitleBox,noteButton,collapseButton);

  const scroll=el('div','sp-guide-scroll');
  const contextCard=el('section','sp-guide-context');
  const contextLabel=el('div','sp-guide-context-label','本页');
  const checkHost=el('div','sp-guide-checks');
  contextCard.append(contextLabel,checkHost);
  const chatHead=el('div','sp-guide-chat-head');
  chatHead.append(el('span',null,'问答'),el('span','sp-guide-live',''));
  const thread=el('div','sp-guide-thread');
  scroll.append(contextCard,chatHead,thread);

  const composer=el('footer','sp-guide-composer');
  const input=el('textarea','sp-guide-input');
  input.rows=2;input.placeholder='问当前页的问题';
  input.setAttribute('aria-label','问当前页的问题');
  const composerRow=el('div','sp-guide-compose-row');
  const scope=el('span','sp-guide-scope','第 1 / '+slides.length+' 页');
  const send=el('button','sp-guide-send','');
  send.type='button';send.setAttribute('aria-label','发送');send.title='发送';
  send.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  composerRow.append(scope,send);composer.append(input,composerRow);
  panel.append(panelHead,scroll,composer);

  const currentSlide=()=>slides[state.idx]||{};
  const currentMoments=()=>Array.isArray(currentSlide().teachingMoments)?currentSlide().teachingMoments:[];
  const sourceQuote=(moment)=>{
    const anchor=spGuideText(moment?.anchorText).trim();if(anchor)return anchor;
    const bullets=Array.isArray(currentSlide().bullets)?currentSlide().bullets:[];
    if(bullets.length)return spGuideText(bullets[0]);
    return spGuideText(currentSlide().title);
  };
  const answeredFor=(momentId)=>{
    const all=state.context?.answeredCheckpoints;
    if(all&&typeof all==='object'&&all[momentId])return all[momentId];
    return state.answered[momentId]||null;
  };

  const setPanelOpen=open=>{
    state.open=!!open;
    shell.classList.toggle('guide-open',state.open);
    shell.classList.toggle('guide-closed',!state.open);
    panel.setAttribute('aria-hidden',state.open?'false':'true');
    toggle.textContent=state.open?'收起':'导学';
    toggle.setAttribute('aria-expanded',state.open?'true':'false');
    scrim.hidden=!(state.open&&innerWidth<=940);
    if(state.open)requestAnimationFrame(()=>scroll.scrollTop=scroll.scrollHeight);
  };

  const syncComposer=()=>{
    send.disabled=state.busy||!input.value.trim();
    send.classList.toggle('busy',state.busy);
    input.disabled=state.busy;
    noteButton.disabled=state.busy;
  };

  const guidedIntro=()=>{
    const s=currentSlide();const box=el('div','sp-guide-intro');
    box.append(el('p','sp-guide-intro-kicker','当前页'));
    box.append(el('p','sp-guide-intro-text',spGuideClip(s.speakerNote||(Array.isArray(s.bullets)?s.bullets[0]:'')||'先看这一页，遇到不懂的可以直接问。',180)));
    const actions=el('div','sp-guide-starters');
    actions.append(btn('解释本页','ghost sm',()=>submitGuideQuestion('请解释当前页的核心内容，并指出最容易混淆的一点。')),btn('举个例子','ghost sm',()=>submitGuideQuestion('请结合当前页内容举一个具体例子，并说明它为什么适用。')));
    box.appendChild(actions);return box;
  };

  const paintThread=()=>{
    thread.replaceChildren();
    const turns=typeof turnsFromEvents==='function'?turnsFromEvents(state.events||[]):[];
    if(!turns.length&&!state.notices.length&&!state.pendingUser&&!state.busy)thread.appendChild(guidedIntro());
    for(const t of turns){
      if(t.user){const bubble=el('article','sp-guide-msg user');bubble.textContent=t.user;thread.appendChild(bubble);}
      for(const it of t.items||[]){
        if(it.t==='a'){
          const bubble=el('article','sp-guide-msg assistant'+(it.streaming?' streaming':''));
          const body=el('div','md');body.innerHTML=md(it.text||'');bubble.appendChild(body);
          if(it.streaming)bubble.appendChild(el('span','sp-guide-caret'));thread.appendChild(bubble);
        }else if(it.t==='tool'){
          const d=el('details','sp-guide-tool');
          const sum=el('summary','sp-guide-tool-sum');
          sum.append(el('span','sp-guide-tool-dot'+(it.ok===false?' failed':'')),el('span','grow',it.name||'工具'),el('span','sp-guide-tool-state',it.running?'运行':(it.ok===false?'失败':'完成')));
          d.appendChild(sum);
          if(it.args&&Object.keys(it.args).length)d.appendChild(el('pre','sp-guide-tool-detail',JSON.stringify(it.args,null,2)));
          if(it.summary)d.appendChild(el('pre','sp-guide-tool-detail',spGuideClip(it.summary,1600)));
          thread.appendChild(d);
        }else if(it.t==='think'&&it.text){
          const d=el('details','sp-guide-think');d.append(el('summary',null,'思考'),el('p',null,it.text));thread.appendChild(d);
        }
      }
      if(t.ok===false&&t.message)thread.appendChild(el('p','sp-guide-error',t.message));
    }
    if(state.pendingUser)thread.appendChild(el('article','sp-guide-msg user',state.pendingUser));
    for(const n of state.notices){const box=el('article','sp-guide-note-notice');box.append(el('strong',null,n.title||'笔记'),el('p',null,n.text));thread.appendChild(box);}
    if(state.error)thread.appendChild(el('p','sp-guide-error',state.error));
    if(state.busy&&!turns.some(t=>(t.items||[]).some(it=>it.t==='a'&&it.streaming))){
      const typing=el('div','sp-guide-typing');typing.append(el('span'),el('span'),el('span'));thread.appendChild(typing);
    }
    requestAnimationFrame(()=>{if(state.open)scroll.scrollTop=scroll.scrollHeight;});
  };

  const submitAnswer=async(moment,index)=>{
    if(!state.sessionId||state.answering)return;
    await focusNow().catch(e=>toast(e.message));
    state.answering=moment.momentId;paintChecks();
    try{
      const result=await api('/api/guided/checkpoint',{sessionId:state.sessionId,momentId:moment.momentId,answerIndex:index});
      state.answered[moment.momentId]=result;
      if(!state.context)state.context={};
      if(!state.context.answeredCheckpoints||typeof state.context.answeredCheckpoints!=='object')state.context.answeredCheckpoints={};
      state.context.answeredCheckpoints[moment.momentId]=result;
    }catch(e){toast(e.message);}
    finally{state.answering='';paintChecks();}
  };

  const paintChecks=()=>{
    checkHost.replaceChildren();
    checkHost.hidden=true;
    const moments=currentMoments().filter(m=>m&&(m.type==='quiz'||m.type==='summary'));
    if(!moments.length)return;
    checkHost.hidden=false;
    for(const m of moments){
      const card=el('section','sp-guide-check '+(m.type==='quiz'?'quiz':'summary'));
      const top=el('div','sp-guide-check-top');
      top.append(el('span','sp-guide-check-kind',m.type==='quiz'?'检查':'小结'),el('strong',null,m.title||(m.type==='quiz'?'检查理解':'本页小结')));
      card.appendChild(top);
      if(m.type==='quiz'){
        if(m.prompt)card.appendChild(el('p','sp-guide-prompt',m.prompt));
        const options=el('div','sp-guide-options');
        const result=answeredFor(m.momentId);const locked=!!result||state.answering===m.momentId;
        const values=Array.isArray(m.options)?m.options:[];
        values.forEach((text,i)=>{
          const o=el('button','sp-guide-option'+(locked?' locked':''),'');
          o.type='button';o.disabled=locked;
          o.append(el('span','sp-guide-option-letter',String.fromCharCode(65+i)),el('span','grow',spGuideText(text)));
          if(result){
            if(i===Number(result.correctIndex))o.classList.add('right');
            if(!spGuideTruth(result.correct)&&i===Number(result.answerIndex))o.classList.add('wrong');
            if(i===Number(result.answerIndex))o.classList.add('chosen');
          }
          if(!result)o.addEventListener('click',()=>submitAnswer(m,i));
          options.appendChild(o);
        });
        card.appendChild(options);
        if(result){
          const ok=spGuideTruth(result.correct);const fb=el('div','sp-guide-feedback '+(ok?'right':'wrong'));
          fb.appendChild(el('strong',null,ok?'回答正确':'需要再看'));
          fb.appendChild(el('p',null,spGuideText(result.explanation)||('正确答案是 '+String.fromCharCode(65+Number(result.correctIndex))+'：'+spGuideText(result.correctText))));
          fb.appendChild(el('span','sp-guide-recorded',spGuideTruth(result.repeated)?'首次结果已保存，本次不重复计分。':'首次作答已记录。'));
          card.appendChild(fb);
        }
      }else{
        const points=Array.isArray(m.points)?m.points:[];
        if(points.length){const ul=el('ul','sp-guide-points');for(const p of points)ul.appendChild(el('li',null,p));card.appendChild(ul);}
        if(m.notePrompt)card.appendChild(el('p','sp-guide-note-prompt',m.notePrompt));
        card.appendChild(btn('记笔记','ghost sm',()=>openGuidedNote(m)));
      }
      checkHost.appendChild(card);
    }
  };

  const paint=()=>{
    const s=currentSlide();
    canvas.replaceChildren();
    if(s.eyebrow)canvas.appendChild(el('div','sp-eyebrow',s.eyebrow));
    canvas.appendChild(el('h2','sp-slide-title',s.title||('第 '+(state.idx+1)+' 页')));
    const bullets=Array.isArray(s.bullets)?s.bullets:[];
    if(bullets.length){const ul=el('ul','sp-slide-bullets');for(const b of bullets)ul.appendChild(el('li',null,b));canvas.appendChild(ul);}
    if(s.body){const body=el('article','md sp-slide-body');body.innerHTML=md(s.body);canvas.appendChild(body);}
    notes.textContent=s.speakerNote?('讲稿：'+s.speakerNote):'这一页没有讲稿。';
    pos.textContent='第 '+(state.idx+1)+' / '+slides.length+' 页';
    counter.textContent='导学 '+(state.idx+1)+' / '+slides.length+' 页';
    scope.textContent='第 '+(state.idx+1)+' / '+slides.length+' 页';
    prev.disabled=state.idx<=0;
    next.textContent=state.idx>=slides.length-1?'回到第一页':'下一页 ›';
    dots.querySelectorAll('button').forEach((b,i)=>b.classList.toggle('on',i===state.idx));
    pageTitle.textContent=s.title||('第 '+(state.idx+1)+' 页');
    pageSummary.textContent=spGuideClip(bullets[0]||s.speakerNote||'可以直接问不懂的地方。',120);
    contextLabel.textContent='第 '+(state.idx+1)+' 页 · 本页';
    paintChecks();
    persistProgress(false);
    queueFocus();
  };

  const jump=i=>{
    const next=Math.max(0,Math.min(slides.length-1,i));
    if(next!==state.idx)state.userNavigated=true;
    state.idx=next;state.answering='';paint();
  };

  const persistProgress=immediate=>{
    if(state.saveTimer){clearTimeout(state.saveTimer);state.saveTimer=0;}
    const body={name:key,page:state.idx+1,pageCount:slides.length};
    if(immediate)return api('/api/artifacts/progress/save',body).catch(()=>{});
    state.saveTimer=setTimeout(()=>{state.saveTimer=0;api('/api/artifacts/progress/save',body).catch(()=>{});},380);
    return Promise.resolve();
  };

  const focusNow=async()=>{
    if(!state.sessionId)return null;
    if(state.focusTimer){clearTimeout(state.focusTimer);state.focusTimer=0;}
    const target=state.idx+1;
    if(state.focusedSlide===target&&state.context)return state.context;
    if(state.focusPromise&&state.focusPromise.target===target)return state.focusPromise.promise;
    const seq=++state.focusSeq;
    const promise=api('/api/guided/focus',{sessionId:state.sessionId,slide:target}).then(context=>{
      if(seq===state.focusSeq&&state.idx+1===target){state.context=context;state.focusedSlide=target;paintChecks();}
      return context;
    }).finally(()=>{if(state.focusPromise?.promise===promise)state.focusPromise=null;});
    state.focusPromise={target,promise};return promise;
  };

  const queueFocus=()=>{
    if(!state.sessionId)return;
    if(state.focusTimer)clearTimeout(state.focusTimer);
    state.focusTimer=setTimeout(()=>{state.focusTimer=0;focusNow().catch(()=>{});},140);
  };

  const ensureLastEvent=async()=>{
    if(!state.sessionId)return;
    const d=await api('/api/sessions/events',{sessionId:state.sessionId});
    state.events=d.events||[];state.lastId=Number(d.lastId||0);
    state.pendingUser='';paintThread();
  };

  const pollEvents=async()=>{
    if(!state.sessionId||state.pollInFlight)return;
    state.pollInFlight=true;
    try{
      const d=await api('/api/sessions/events',{sessionId:state.sessionId,sinceId:state.lastId||0});
      const fresh=d.events||[];
      if(fresh.length)state.events=state.events.concat(fresh);
      state.lastId=Number(d.lastId||state.lastId||0);
      if(state.events.some(e=>e.type==='user/message'&&spGuideText(e.payload?.text)===state.pendingUser))state.pendingUser='';
      paintThread();
    }catch(e){}finally{state.pollInFlight=false;}
  };

  const submitGuideQuestion=async(raw)=>{
    const text=spGuideText(raw===undefined?input.value:raw).trim();
    if(!text||state.busy||!state.sessionId)return;
    input.value='';state.error='';state.busy=true;state.pendingUser=text;state.requestController=new AbortController();
    syncComposer();paintThread();await focusNow().catch(()=>{});
    let timer=setInterval(pollEvents,280);
    try{
      const result=await api('/api/agent/ask-pi',{
        kbId:'',question:text,attachments:[],sessionId:state.sessionId,web:'auto',mode:'chat',
        skill:'',perm:state.cfg?.agentPerm||'auto',ctxChapter:spGuideText(currentSlide().title)
      },state.requestController.signal);
      if(result?.ok===false)throw new Error(result.message||'这一轮没有完成');
    }catch(e){
      if(!state.cleaned)state.error=e.message||'这一轮没有完成';
    }finally{
      clearInterval(timer);timer=0;
      await pollEvents().catch(()=>{});
      await ensureLastEvent().catch(()=>{});
      state.busy=false;state.requestController=null;state.pendingUser='';syncComposer();paintThread();
    }
  };

  const openGuidedNote=async(moment)=>{
    if(!state.sessionId){toast('导学会话还没有准备好');return;}
    await focusNow().catch(e=>toast(e.message));
    const source=sourceQuote(moment);
    const d=courseDialog('记笔记',(currentSlide().title||'当前页')+' · 第 '+(state.idx+1)+' 页');
    state.noteDialog=d;
    const body=el('div','sp-guide-note-form');
    const quote=el('p','sp-guide-note-source','来源：'+(source||'当前页'));
    const area=el('textarea','sp-guide-note-textarea');
    area.rows=7;area.placeholder=spGuideText(moment?.notePrompt)||'写下你的理解、疑问或例子…';
    const actions=el('div','sp-guide-note-actions');
    const cancel=btn('取消','ghost',()=>d.close());
    const save=btn('保存笔记','primary',async()=>{
      const text=area.value.trim();if(!text){area.focus();return;}
      save.disabled=true;
      try{
        const note=await api('/api/guided/note',{sessionId:state.sessionId,title:'',text,quote:source});
        state.notices.push({title:note?.title||'笔记已保存',text});
        d.close();state.noteDialog=null;toast('笔记已保存并关联到当前页');paintThread();
      }catch(e){toast(e.message);save.disabled=false;}
    });
    actions.append(cancel,save);body.append(quote,area,actions);d.body.appendChild(body);area.focus();
  };

  for(const[i]of slides.entries()){const dot=btn('','sp-dot',()=>jump(i));dot.setAttribute('aria-label','第 '+(i+1)+' 页');dots.appendChild(dot);}
  input.addEventListener('input',syncComposer);
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();submitGuideQuestion();}});
  send.addEventListener('click',()=>submitGuideQuestion());
  toggle.addEventListener('click',()=>setPanelOpen(!state.open));
  scrim.addEventListener('click',()=>setPanelOpen(false));

  const onKey=e=>{
    if(current!=='study'||!stage.isConnected)return;
    const target=e.target;
    if(target?.closest?.('.sp-guide-panel,.course-modal-overlay'))return;
    if(['INPUT','TEXTAREA','SELECT'].includes(target?.tagName)||target?.isContentEditable||target?.closest?.('button,a,[role="button"]'))return;
    if(e.key==='Escape'&&state.open&&innerWidth<=940){e.preventDefault();setPanelOpen(false);return;}
    if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key===' '||e.key==='PageDown'){e.preventDefault();jump(state.idx+1);}
    else if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();jump(state.idx-1);}
    else if(e.key==='Home'){e.preventDefault();jump(0);}else if(e.key==='End'){e.preventDefault();jump(slides.length-1);}
  };
  const onResize=()=>{
    const narrow=innerWidth<=940;
    if(narrow&&!state.wasNarrow)state.open=false;
    state.wasNarrow=narrow;setPanelOpen(state.open);
  };
  window.addEventListener('keydown',onKey);window.addEventListener('resize',onResize);

  const cleanup=()=>{
    if(state.cleaned)return;state.cleaned=true;
    observer.disconnect();window.removeEventListener('keydown',onKey);window.removeEventListener('resize',onResize);
    if(state.saveTimer)clearTimeout(state.saveTimer);if(state.focusTimer)clearTimeout(state.focusTimer);
    state.requestController?.abort();state.noteDialog?.close?.();persistProgress(true);
  };
  const observer=new MutationObserver(()=>{if(!page.isConnected)cleanup();});
  observer.observe(document.getElementById('view'),{childList:true});

  const loadGuided=async()=>{
    try{
      const resolved=await api('/api/guided/session/resolve',{resourceId:res.id,version:res.version});
      if(state.cleaned||!page.isConnected)return;
      state.sessionId=resolved.sessionId;
      state.context=resolved.context||null;
      const resumed=Math.max(1,Math.min(slides.length,Number(resolved.slide||1)));
      // 初始化请求可能比用户第一次翻页更慢；用户操作优先，避免把第 2 页悄悄改回第 1 页。
      const keepNavigation=state.userNavigated;
      if(!keepNavigation){state.idx=resumed-1;state.focusedSlide=resumed;
        const legacy=await api('/api/artifacts/progress',{name:key}).catch(()=>null);
        if(spGuideTruth(resolved.created)&&Number(legacy?.page||0)>1&&Number(legacy.page)<=slides.length){
          state.idx=Number(legacy.page)-1;
          await focusNow().catch(()=>{});
        }
      }
      await ensureLastEvent().catch(()=>{});
      paint();setPanelOpen(state.open);
    }catch(e){
      if(state.cleaned)return;
      contextCard.hidden=false;checkHost.replaceChildren(el('p','sp-guide-error','导学会话暂不可用：'+e.message));
      thread.replaceChildren(el('p','sp-guide-empty','课件仍可正常翻页；右侧导学恢复后才能提问和记笔记。'));
    }
  };

  paint();syncComposer();setPanelOpen(state.open);
  api('/api/artifacts/progress',{name:key}).then(p=>{
    const page=Number(p?.page||0);
    if(!state.sessionId&&page>1&&page<=slides.length){state.idx=page-1;paint();toast('从上次看到的第 '+page+' 页继续');}
  }).catch(()=>{});
  loadGuided();
  return{countText:()=>{}};
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
