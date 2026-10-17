/* Knowledge-base course maps. All ownership, versions and lifecycle decisions are authoritative in Cangjie. */
const courseUi={data:null,kb:'',selected:'',views:new Map(),jobs:new Map(),targets:new Map()};
const COURSE_KINDS=[['lecture','定制讲义','file'],['practice','实操指南','code'],['quiz','分阶测试','check'],['ppt','在线演示','play']];
const courseApi=(name,body={})=>api('/api/course/'+name,body);

function courseDialog(title,subtitle=''){
  document.querySelector('.course-modal-overlay')?.remove();
  const trigger=document.activeElement,overlay=el('div','course-modal-overlay'),card=el('section','course-modal');
  card.setAttribute('role','dialog');card.setAttribute('aria-modal','true');card.setAttribute('aria-label',title);
  const head=el('header','course-modal-head'),text=el('div','grow');if(subtitle)text.appendChild(el('p','muted sm',subtitle));text.appendChild(el('h2',null,title));
  const close=()=>{overlay.remove();if(trigger?.isConnected)trigger.focus();};
  const x=btn('×','ghost course-close',close);x.setAttribute('aria-label','关闭弹窗');head.append(text,x);card.appendChild(head);
  const body=el('div','course-modal-body');card.appendChild(body);overlay.appendChild(card);document.body.appendChild(overlay);
  const zoom=Number(getComputedStyle(document.body).zoom)||1;card.style.maxHeight=Math.max(240,innerHeight/zoom-40)+'px';card.style.maxWidth=Math.max(260,innerWidth/zoom-32)+'px';
  overlay.onclick=e=>{if(e.target===overlay)close();};overlay.onkeydown=e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}
    if(e.key==='Tab'){const controls=[...card.querySelectorAll('button:not(:disabled),input,select,textarea,a[href]')];const first=controls[0],last=controls[controls.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  };
  x.focus();return{overlay,card,body,close};
}
async function courseConfirm(title,message,action){
  const d=courseDialog(title);d.body.appendChild(el('p',null,message));const row=el('div','course-dialog-actions');const yes=btn('确认','primary',async()=>{yes.disabled=true;try{await action();d.close();}catch(e){toast(e.message);yes.disabled=false;}});row.append(btn('取消','ghost',d.close),yes);d.body.appendChild(row);
}
async function courseRefresh(){courseUi.data=await courseApi('state',{kbId:courseUi.kb});if(current==='learn'&&document.querySelector('.course-workspace'))await renderCourseWorkspace();}
function courseCurrent(nodeId,kind){return(courseUi.data?.resources||[]).find(a=>a.nodeId===nodeId&&a.kind===kind);}
function courseNodePath(node,map=courseUi.data?.map){const names=[];const seen=new Set();while(node&&!seen.has(node.id)){seen.add(node.id);names.unshift(node.title);node=map.nodes.find(n=>n.id===node.parentId);}return names.join(' / ');}

async function courseStartResource(node,kind,regenerate=false){
  const target=await courseApi('start',{kbId:courseUi.kb,nodeId:node.id,kind,projectId:state.chatProject||'',regenerate});courseUi.targets.set(target.sessionId,target);
  document.querySelector('.course-modal-overlay')?.remove();
  if(target.existing){state.chatSessionId=target.sessionId;state.chatProject=target.projectId||'';state.chatMode=state.chatProject?'work':'chat';await go('chat');return;}
  state.chatSessionId=target.sessionId;state.chatProject=target.projectId||'';state.chatMode=state.chatProject?'work':'chat';await go('chat');
  const label=RESOURCE_LABEL[kind];const question='我想围绕思维导图节点「'+node.title+'」制作一份'+label+'。请先结合所选知识库和节点范围，问清必要的学习程度、用途、篇幅或题量等要求，再开始制作；已有要求不重复问。生成后先给我预览，满意并确认后再加入我的学习资源。';
  const input=$('chat-input');input.value=question;input.dispatchEvent(new Event('input'));document.querySelector('.composer-send[aria-label="发送"]')?.click();
}
async function openCourseAsset(asset){
  const full=await courseApi('resource',{id:asset.id,includeTrash:asset.status==='trash'});
  if(full.missing){const d=courseDialog('文件暂时找不到',full.title);d.body.appendChild(el('p',null,'关联与学习记录仍保留。选择原文件后会验证内容，并恢复副本；不会把不同内容冒充这一版。'));const locate=btn('找回文件…','primary',async()=>{const chosen=await window.itnWindow?.pickFile?.();if(!chosen)return;try{await courseApi('resource/relocate',{id:full.id,path:chosen,confirmed:true});d.close();await courseRefresh();toast('已恢复原确认副本，节点与学习记录保持不变。');}catch(e){toast(e.message);}});locate.disabled=!window.itnWindow?.pickFile;d.body.appendChild(locate);const text=full.learning?.markdown||full.text;if(text){const details=el('details','course-archive-preview');details.appendChild(el('summary',null,'仍可查看保存的文本内容'));const article=el('article','md');article.innerHTML=md(text);details.appendChild(article);d.body.appendChild(details);}return;}
  if(asset.status==='current'){
    document.querySelector('.course-modal-overlay')?.remove();
    if(full.learningId){courseUi.focusNode=asset.nodeId||'';await go('study',full.learningId+'@'+full.learningVersion);}
    else{await go('chat');await openFilePreview(full.path,{title:full.title,sessionId:full.sessionId,courseAssetId:full.id});}
    return;
  }
  const d=courseDialog(full.title,full.nodeTitle+' · '+(full.status==='trash'?'回收站预览':'归档预览'));
  if(full.learning){const article=el('article','md course-archive-preview');article.innerHTML=md(full.learning.markdown||'');d.body.appendChild(article);}
  else if(window.itnWindow?.readResourceFile){const data=await window.itnWindow.readResourceFile(full.path);if(data.ok&&(data.html||data.kind==='pdf')){const frame=el('iframe','course-preview-frame');frame.setAttribute('sandbox',data.kind==='pdf'?'':'allow-scripts');frame.title=full.title;if(data.kind==='pdf')frame.src=data.dataUrl;else frame.srcdoc='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\'">'+data.html;d.body.appendChild(frame);}else d.body.appendChild(el('pre','course-archive-preview',data.text||full.text||'此格式可通过系统程序预览。'));}
  else{const article=el('article','md');article.innerHTML=md(full.text||'该格式请在桌面应用中预览。');d.body.appendChild(article);}
  d.body.appendChild(el('p','muted sm','预览不改变当前资源，也不重复计入学习记录。'));
}
async function courseRestore(asset,attach=false){
  const fresh=await courseApi('state',{kbId:courseUi.kb});courseUi.data=fresh;
  const nodes=fresh.map?.nodes||[];if(!nodes.length){toast('先恢复知识库并生成或恢复一张当前导图，再关联资源。');return;}
  const d=courseDialog(attach?'把旧资源接到新节点':'恢复这份资源',asset.title);
  const select=el('select');select.setAttribute('aria-label','选择目标节点');for(const n of nodes)select.appendChild(option(n.id,courseNodePath(n,fresh.map)));
  select.value=nodes.some(n=>n.id===asset.nodeId)?asset.nodeId:nodes[0].id;
  d.body.appendChild(fieldOf('目标节点',select));const note=el('p','course-replace-note');d.body.appendChild(note);let expected='';
  const update=()=>{const old=(fresh.resources||[]).find(a=>a.nodeId===select.value&&a.kind===asset.kind);expected=old?.id||'';note.textContent=old?'当前位置是「'+old.title+'」，确认后它会转入归档。':'这个位置是空的，确认后将关联这份资源。';};select.onchange=update;update();
  const row=el('div','course-dialog-actions');row.append(btn('取消','ghost',d.close),btn('确认关联','primary',async()=>{try{await courseApi('resource/action',{id:asset.id,action:attach?'attach':'restore',kbId:courseUi.kb,nodeId:select.value,expectedResourceId:expected,confirmed:true});d.close();await courseRefresh();toast('已关联确认资源，原当前版本如有已归档。');}catch(e){toast(e.message);}}));d.body.appendChild(row);
}
async function openCourseCollection(status){
  const d=courseDialog(status==='archive'?'归档资源':'回收站',state.cfg.knowledgeBases.find(k=>k.id===courseUi.kb)?.name||'全部知识库');
  const data=await courseApi('resources',{kbId:courseUi.kb,status});
  if(!data.resources.length)d.body.appendChild(el('p','muted','这里暂时没有资源。'));
  for(const a of data.resources){const item=el('article','course-collection-item');item.append(el('strong',null,a.title),el('p','muted sm',a.nodeTitle+' · '+RESOURCE_LABEL[a.kind]+' · '+(a.archiveReason||'')));const row=el('div','row');row.append(btn('预览','ghost sm',()=>openCourseAsset(a)),btn(status==='archive'?'关联 / 恢复':'恢复','sm',()=>courseRestore(a,status==='archive')));
    if(status==='archive')row.append(btn('移入回收站','ghost sm',()=>courseConfirm('移入回收站？','只移走这份资源，不删除导图、节点或学习记录。',async()=>{await courseApi('resource/action',{id:a.id,action:'trash',confirmed:true});d.close();await courseRefresh();await openCourseCollection('archive');})));
    else row.append(btn('永久删除','ghost sm course-danger',()=>courseConfirm('永久删除这份副本？','会删除应用管理的副本、伴随预览和搜索索引；不会删除原始资料、原会话里的文字或外部备份。此操作不能撤销。',async()=>{await courseApi('resource/action',{id:a.id,action:'purge',confirmed:true});d.close();await courseRefresh();await openCourseCollection('trash');})));
    item.appendChild(row);d.body.appendChild(item);
  }
  if(status==='trash'){
    const removed=await courseApi('deleted-kbs');for(const kb of removed.libraries||[]){const row=el('article','course-collection-item');row.append(el('strong',null,kb.name+' · 已移除知识库'),el('p','muted sm','原始资料未删除，恢复后可重新关联旧资源。'),btn('恢复知识库','sm',()=>courseConfirm('恢复知识库？','恢复库和历史导图；已归档资源仍由你选择恢复位置。',async()=>{await courseApi('kb/restore',{kbId:kb.id,confirmed:true});await loadCfg();state.kb=kb.id;courseUi.kb=kb.id;d.close();await go('learn');})));d.body.appendChild(row);}
  }
}
async function courseLinkExisting(node){
  const fresh=await courseApi('state',{kbId:courseUi.kb}),data=await courseApi('unlinked');const d=courseDialog('关联已有学习资源',node.title);
  if(!data.resources.length){d.body.appendChild(el('p','muted','还没有未关联的已保存资源。可以先从对话预览确认存入。'));return;}
  const files=el('select');files.setAttribute('aria-label','选择已有资源');for(const a of data.resources)files.appendChild(option(a.id,a.title));const kind=el('select');kind.setAttribute('aria-label','资源类型');for(const[k,label]of COURSE_KINDS)kind.appendChild(option(k,label));const note=el('p','course-replace-note');let expected='';
  const update=()=>{const a=data.resources.find(a=>a.id===files.value);if(a.learningKind&&COURSE_KINDS.some(([k])=>k===a.learningKind)){kind.value=a.learningKind;kind.disabled=true;}else kind.disabled=false;const old=(fresh.resources||[]).find(r=>r.nodeId===node.id&&r.kind===kind.value);expected=old?.id||'';note.textContent=(old?'将替换「'+old.title+'」，旧版归档。':'关联后成为该类的当前资源。')+(!a.learningId?' 普通文件支持预览与本人标记，不生成自动评分。':'');};files.onchange=update;kind.onchange=update;update();
  d.body.append(fieldOf('已有资源',files),fieldOf('资源类型',kind),note);const actions=el('div','course-dialog-actions');actions.append(btn('取消','ghost',d.close),btn('确认关联','primary',async()=>{try{await courseApi('attach-existing',{personalId:files.value,kbId:courseUi.kb,nodeId:node.id,kind:kind.value,expectedResourceId:expected,confirmed:true});d.close();await courseRefresh();await openCourseNode(node.id);}catch(e){toast(e.message);}}));d.body.appendChild(actions);
}
async function openCourseNode(id){
  courseUi.selected=id;const node=courseUi.data?.map?.nodes.find(n=>n.id===id);if(!node)return;
  document.querySelectorAll('.course-node').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.node===id)));
  const d=courseDialog(node.title,courseNodePath(node));const grid=el('div','course-resource-grid');
  for(const[kind,label,ic]of COURSE_KINDS){const asset=courseCurrent(id,kind),card=el('section','course-resource-tile');card.dataset.kind=kind;
    const title=el('div','course-resource-title');const glyph=el('span','course-resource-icon');glyph.innerHTML=icon(ic);title.append(glyph,el('strong',null,label));
    const text=asset?(asset.missing?'文件暂时找不到':asset.learningVersion?'已收录 · v'+asset.learningVersion:'已收录 · '+asset.title):'还没有'+label;
    card.append(title,el('p','course-resource-status',text));const row=el('div','course-resource-actions');const primary=asset?({lecture:'打开学习',practice:'打开学习',quiz:'开始作答',ppt:'开始导学'}[kind]||'打开学习'):'去对话生成';
    row.append(btn(primary,'primary sm',()=>asset?openCourseAsset(asset):courseStartResource(node,kind)));
    if(asset)row.append(btn('更多','ghost sm',()=>{const more=courseDialog(label+'的更多操作',asset.title),actions=el('div','course-manage-actions');actions.append(btn('继续修改','',()=>courseStartResource(node,kind,false)),btn('重新生成','',()=>courseStartResource(node,kind,true)),btn('查看历史归档','ghost',()=>openCourseCollection('archive')),btn('移入回收站','ghost course-danger',()=>courseConfirm('移入回收站？','只清空这个节点的'+label+'位置，导图、其他资源和学习记录都保留。',async()=>{await courseApi('resource/action',{id:asset.id,action:'trash',confirmed:true});more.close();await courseRefresh();await openCourseNode(id);})));more.body.appendChild(actions);}));
    card.appendChild(row);grid.appendChild(card);
  }
  d.body.appendChild(grid);const bottom=el('div','course-node-bottom');bottom.append(btn('资料出处','ghost sm',()=>{const source=courseDialog('这个节点依据哪些资料',node.title);source.body.appendChild(el('p',null,node.description||'知识库中的对应主题'));for(const ref of node.sources||[])source.body.appendChild(el('p','course-source',ref.title+' · '+ref.docPath));}),btn('编辑节点','ghost sm',()=>editCourseNode(node)),btn('标记这个节点学完','ghost sm',()=>courseConfirm('标记这个节点学完？','这是本人完成标记，不换算成掌握度。',async()=>{await courseApi('node',{kbId:courseUi.kb,nodeId:id,done:true});toast('已记下本人完成标记。');})));
  bottom.appendChild(btn('关联已有资源','ghost sm',()=>courseLinkExisting(node)));
  d.body.append(bottom,el('p','course-modal-hint','每类只保留一份当前资源；新版本确认收录后，旧版本才归档。'));
  if(courseUi.data.map.excludedSummary)d.body.appendChild(el('p','course-replace-note','建库时未纳入的资料：'+courseUi.data.map.excludedSummary));
}
function editCourseNode(node){
  const d=courseDialog('编辑节点',node.title),title=inputOf('course-node-title','节点名称',node.title),desc=el('textarea');desc.rows=3;desc.value=node.description||'';
  const parent=el('select');for(const n of courseUi.data.map.nodes)if(n.id!==node.id)parent.appendChild(option(n.id,courseNodePath(n)));parent.value=node.parentId;parent.disabled=!node.parentId;
  d.body.append(fieldOf('名称',title),fieldOf('学习范围',desc));if(node.parentId)d.body.appendChild(fieldOf('上级节点',parent));
  const actions=el('div','course-dialog-actions');if(node.parentId)actions.append(btn('删除节点','ghost course-danger',()=>{const remove=courseDialog('删除这个节点？',node.title);const mode=el('select');mode.append(option('single','只删这个节点，子节点上移'),option('subtree','删除整条分支'));remove.body.append(fieldOf('删除范围',mode),el('p',null,'被移除节点的资源会进入归档，导图剩余部分和学习历史保留。'));remove.body.appendChild(btn('确认删除','primary',async()=>{try{await courseApi('node',{kbId:courseUi.kb,nodeId:node.id,remove:true,subtree:mode.value==='subtree',confirmed:true});remove.close();await courseRefresh();}catch(e){toast(e.message);}}));}));
  actions.append(btn('取消','ghost',d.close),btn('保存','primary',async()=>{try{const b={kbId:courseUi.kb,nodeId:node.id,title:title.value,description:desc.value};if(node.parentId)b.parentId=parent.value;await courseApi('node',b);d.close();await courseRefresh();}catch(e){toast(e.message);}}));d.body.appendChild(actions);
}

async function offerCourseSave(file){
  const sid=file.sessionId||state.chatSessionId;if(!sid)return false;const target=await courseApi('target',{sessionId:sid});if(!target.nodeId)return false;
  const snapshot=await courseApi('state',{kbId:target.kbId}),nodes=snapshot.map?.nodes||[];const d=courseDialog('满意这版，再加入我的学习资源',target.title+' · '+RESOURCE_LABEL[target.kind]);
  const title=inputOf('course-save-title','资源名称',file.title||file.name||target.title);d.body.appendChild(fieldOf('资源名称',title));
  const selector=el('select');selector.setAttribute('aria-label','收录到哪个节点');if(!target.valid)selector.appendChild(option('','请选择新导图中的节点'));for(const n of nodes)selector.appendChild(option(n.id,courseNodePath(n,snapshot.map)));selector.value=target.valid?target.nodeId:'';
  d.body.appendChild(fieldOf('所属节点',selector));if(!target.valid)d.body.appendChild(el('p','course-replace-note','原导图或节点已变化，请明确选择新节点后收录。'));
  const note=el('p','course-replace-note');d.body.appendChild(note);const row=el('div','course-dialog-actions');let expected='';
  const yes=btn('确认加入','primary',async()=>{yes.disabled=true;try{await courseApi('commit',{sessionId:sid,path:file.path,title:title.value,learningId:file.learningId||'',learningVersion:file.learningVersion||0,expectedResourceId:expected,targetNodeId:selector.value,confirmed:true});d.close();toast('已加入该节点的学习资源，旧正式版本如有已归档。');}catch(e){toast(e.message);yes.disabled=false;}});
  const update=()=>{const old=(snapshot.resources||[]).find(a=>a.nodeId===selector.value&&a.kind===target.kind);expected=old?.id||'';note.textContent=old?'当前是「'+old.title+'」，确认后旧版将进入归档。':'确认后保存这一版副本，并关联到选定节点。';yes.textContent=old?'确认替换，旧版归档':'确认加入';yes.disabled=!selector.value;};selector.onchange=update;update();row.append(btn('这版先不存','ghost',d.close),yes);d.body.appendChild(row);return true;
}

async function watchCourseJob(job,host){
  courseUi.jobs.set(courseUi.kb,job.id);const kb=courseUi.kb;
  const old=host.querySelector('.course-job');old?.remove();
  const box=el('div','course-job'),head=el('div','course-job-head'),stage=el('span','course-job-stage'),tokens=el('span','course-job-tokens'),pct=el('span','course-job-pct','0%');
  const bar=el('div','course-job-bar'),fill=el('span','course-job-fill');bar.appendChild(fill);
  const foot=el('div','course-job-foot');foot.appendChild(btn('取消生成','ghost sm',()=>courseApi('cancel',{id:job.id})));
  head.append(stage,tokens,pct);box.append(head,bar,foot);host.appendChild(box);
  const fmtTok=n=>{n=Number(n)||0;if(n>=1000000)return (n/1000000).toFixed(1)+'M';if(n>=1000)return (n/1000).toFixed(1)+'k';return String(n);};
  const paint=result=>{
    const p=result.progress||{};const text=result.stage||result.message||'正在生成…';
    stage.textContent=text;
    const t=result.tokens||{};const total=Number(t.total)||0;
    tokens.textContent=total>0?('tokens '+fmtTok(total)+'（入 '+fmtTok(t.in)+' / 出 '+fmtTok(t.out)+'）'):'';
    tokens.title=total>0?('累计 '+Number(t.calls||0)+' 次模型调用'):'';
    const raw=Number(p.percent);const percent=Number.isFinite(raw)?Math.max(0,Math.min(100,raw)):0;
    pct.textContent=Math.round(percent)+'%';fill.style.width=percent+'%';
  };
  paint(job);
  try{
    while(host.isConnected&&current==='learn'&&courseUi.kb===kb){const result=await courseApi('job',{id:job.id});paint(result);
      if(result.status!=='running'){
        courseUi.jobs.delete(kb);box.remove();
        if(result.status==='completed'){await courseRefresh();const candidate=await courseApi('map',{id:result.mapId});if(candidate.baseMapId)await previewCourseCandidate(candidate);else toast('思维导图已生成。');}
        else toast(result.message||result.stage||'生成已停止，旧导图保留');break;
      }await new Promise(r=>setTimeout(r,700));
    }
  }catch(e){if(host.isConnected)stage.textContent=e.message;}
}
async function previewCourseCandidate(map){
  const d=courseDialog('新版思维导图已准备好',map.title+' · '+map.nodes.length+' 个节点');
  const tree=el('div','course-candidate-tree');for(const n of map.nodes){const row=el('p',null,n.title);row.style.paddingLeft=(n.depth-1)*20+'px';tree.appendChild(row);}d.body.appendChild(tree);
  const count=(courseUi.data?.resources||[]).length;d.body.appendChild(el('p','course-replace-note','确认切换后，旧图上的 '+count+' 份当前资源将进入归档；你可以再把它们接到新节点。'));
  const actions=el('div','course-dialog-actions');actions.append(btn('旧图先继续用','ghost',d.close),btn('确认切换新版','primary',async()=>{try{await courseApi('publish',{mapId:map.id,expectedMapId:map.baseMapId,confirmed:true});courseUi.views.delete(courseUi.kb);d.close();await courseRefresh();}catch(e){toast(e.message);}}));d.body.appendChild(actions);
}

function mountCourseTree(stage,map){
  const kb=map.kbId||courseUi.kb;
  const world=el('div','course-world'),svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('course-edges');svg.setAttribute('aria-hidden','true');world.appendChild(svg);stage.appendChild(world);
  const children=new Map();for(const n of map.nodes){if(!children.has(n.parentId))children.set(n.parentId,[]);children.get(n.parentId).push(n);}
  const positions=new Map();let leaf=0;const place=node=>{const cs=children.get(node.id)||[];const ys=cs.map(place);const y=ys.length?ys.reduce((a,b)=>a+b,0)/ys.length:60+leaf++*84;positions.set(node.id,{x:100+(node.depth-1)*240,y});return y;};(children.get('')||[]).forEach(place);
  const width=Math.max(...map.nodes.map(n=>n.depth))*240+40,height=Math.max(180,leaf*84+40);world.style.width=width+'px';world.style.height=height+'px';svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  for(const n of map.nodes){const p=positions.get(n.id);if(n.parentId){const a=positions.get(n.parentId),line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d',`M${a.x+75},${a.y} C${(a.x+p.x)/2},${a.y} ${(a.x+p.x)/2},${p.y} ${p.x-75},${p.y}`);svg.appendChild(line);}
    const button=btn('','course-node'+(!n.parentId?' course-root':''),()=>{if(!dragged)openCourseNode(n.id).catch(e=>toast(e.message));});button.dataset.node=n.id;button.setAttribute('aria-pressed',String(n.id===courseUi.selected));button.appendChild(el('span',null,n.title));const own=(courseUi.data.resources||[]).filter(a=>a.nodeId===n.id).length;if(own)button.appendChild(el('small',null,own+' / 4 份资源'));button.style.left=p.x+'px';button.style.top=p.y+'px';world.appendChild(button);
  }
  let view=courseUi.views.get(courseUi.kb);if(view?.mapId!==map.id)view=null;let zoom=view?.zoom||1,x=view?.x||0,y=view?.y||0,drag=null,dragged=false;
  const apply=()=>{if(!stage.isConnected||stage.clientWidth<=0||stage.clientHeight<=0)return;world.style.transform=`translate(${x}px,${y}px) scale(${zoom})`;courseUi.views.set(kb,{mapId:map.id,zoom,x,y});reset.textContent=Math.round(zoom*100)+'%';};
  const fit=()=>{if(!stage.isConnected||stage.clientWidth<=0||stage.clientHeight<=0)return;zoom=Math.max(.75,Math.min(1.15,(stage.clientWidth-50)/width,(stage.clientHeight-60)/height));x=Math.max(20,(stage.clientWidth-width*zoom)/2);y=Math.max(20,(stage.clientHeight-height*zoom)/2);apply();};
  const controls=el('div','course-map-controls'),reset=btn('100%','ghost sm',fit);reset.setAttribute('aria-label','重置导图视角');const change=z=>{const next=Math.max(.45,Math.min(2.5,z));x=stage.clientWidth/2-(stage.clientWidth/2-x)*next/zoom;y=stage.clientHeight/2-(stage.clientHeight/2-y)*next/zoom;zoom=next;apply();};controls.append(btn('−','ghost sm',()=>change(zoom/1.15)),reset,btn('＋','ghost sm',()=>change(zoom*1.15)));stage.appendChild(controls);
  stage.onpointerdown=e=>{if(e.target.closest('.course-map-controls'))return;dragged=false;drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY};};
  stage.onpointermove=e=>{if(!drag)return;const rect=stage.getBoundingClientRect(),factor=stage.clientWidth/rect.width;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>5){dragged=true;stage.setPointerCapture(e.pointerId);x+=dx*factor;y+=dy*factor;apply();}drag.x=e.clientX;drag.y=e.clientY;};stage.onpointerup=()=>{drag=null;setTimeout(()=>dragged=false,0);};stage.onpointercancel=()=>{drag=null;};stage.addEventListener('wheel',e=>{if(e.target.closest('.course-job'))return;e.preventDefault();change(zoom*Math.exp(-e.deltaY*.001));},{passive:false});
  const observer=new ResizeObserver(()=>{if(!stage.isConnected){observer.disconnect();return;}if(!view)fit();});observer.observe(stage);stage._courseObserver=observer;if(view)apply();else requestAnimationFrame(fit);
  return{focusNode:id=>{const p=positions.get(id);if(p){zoom=1;x=stage.clientWidth/2-p.x;y=stage.clientHeight/2-p.y;apply();}},filter:q=>world.querySelectorAll('.course-node').forEach(b=>b.classList.toggle('course-muted',!!q&&!b.textContent.toLowerCase().includes(q.toLowerCase())))};
}
async function renderCourseWorkspace(){
  const generation=state.navigationGeneration,view=$('view');view.querySelector('.course-stage')?._courseObserver?.disconnect();view.replaceChildren();
  const workspace=el('div','course-workspace'),toolbar=el('div','course-toolbar'),stage=el('section','course-stage');stage.setAttribute('aria-label','知识库学习思维导图');workspace.append(toolbar,stage);view.appendChild(workspace);
  const label=el('label','course-library-label','知识库'),selector=kbSelector(async()=>{courseUi.kb=state.kb;courseUi.data=await courseApi('state',{kbId:state.kb});if(generation===state.navigationGeneration)await renderCourseWorkspace();});selector.id='course-kb';selector.setAttribute('aria-label','选择学习知识库');label.appendChild(selector);toolbar.appendChild(label);
  const search=inputOf('course-search','搜索节点…','');toolbar.appendChild(search);const actions=el('div','course-toolbar-actions');toolbar.appendChild(actions);
  const build=btn(courseUi.data?.map?'重建导图':'生成思维导图','sm',async()=>{build.disabled=true;try{const job=await courseApi('generate',{kbId:courseUi.kb});await watchCourseJob(job,stage);}catch(e){toast(e.message);}finally{build.disabled=false;}});build.id='course-generate';build.disabled=!state.kb;
  actions.append(build,btn('归档 '+(courseUi.data?.archiveCount||0),'ghost sm',()=>openCourseCollection('archive')),btn('回收站 '+(courseUi.data?.trashCount||0),'ghost sm',()=>openCourseCollection('trash')),btn('历史导图','ghost sm',async()=>{const data=await courseApi('history',{kbId:courseUi.kb});const d=courseDialog('历史思维导图');for(const m of data.maps){const row=el('article','course-collection-item');row.append(el('strong',null,m.title+' · '+m.status),el('p','muted sm',m.createdAt),btn(m.status==='draft'?'预览并切换':'查看旧结构','ghost sm',()=>m.status==='draft'?previewCourseCandidate(m):showCourseHistory(m)));d.body.appendChild(row);}}));
  if(!state.kb){stage.appendChild(emptyState({art:'db',title:'先选择一个知识库',text:'导入资料后，可以整理成思维导图并制作学习资源。',actions:[btn('去知识库','primary',()=>go('kb'))]}));return;}
  if(courseUi.data?.map){const map=courseUi.data.map,tree=mountCourseTree(stage,map);search.oninput=()=>{tree.filter(search.value.trim());const match=map.nodes.find(n=>n.title.includes(search.value.trim()));if(search.value.trim()&&match)tree.focusNode(match.id);};stage.appendChild(el('p','course-map-caption',courseUi.data.sourceChanged?'资料有更新，可重建导图；旧资源继续保留。':'点选节点打开学习资源 · 拖动查看 · 滚轮缩放'));
    if(courseUi.focusNode){const fid=courseUi.focusNode;courseUi.focusNode='';stage.querySelector('.course-node[data-node="'+fid+'"]')?.classList.add('course-node-focus');requestAnimationFrame(()=>tree.focusNode(fid));}
  }
  else{const empty=el('div','course-map-empty');empty.append(el('h2',null,'从这个知识库生成思维导图'),el('p','muted','Lumin会阅读资料并整理出树形学习大纲，通常两到三级。'),btn('生成思维导图','primary',()=>build.click()));stage.appendChild(empty);}
  const job=courseUi.data?.job;if(job?.status==='running')watchCourseJob(job,stage);else if(job?.status==='completed'&&job.mapId&&job.baseMapId&&job.mapId!==courseUi.data.map?.id){const pending=el('div','course-job');pending.append(el('span',null,'有一张新版导图待确认'),btn('预览新版','sm',async()=>previewCourseCandidate(await courseApi('map',{id:job.mapId}))));stage.appendChild(pending);}
}
PAGES.learn.render=async function(){await loadCfg();courseUi.kb=state.kb;courseUi.data=await courseApi('state',{kbId:state.kb});await renderCourseWorkspace();};
PAGE_META.learn.title='学 · 练';PAGE_META.learn.sub='从知识库的思维导图开始学习';

PAGES.report.render=async function(){
  const generation=state.navigationGeneration;await loadCfg();courseUi.kb=state.kb;const view=$('view');view.replaceChildren();const root=el('div','course-growth');view.appendChild(root);
  const toolbar=el('div','course-toolbar'),label=el('label','course-library-label','知识库'),selector=kbSelector(()=>go('report'));selector.setAttribute('aria-label','选择成长知识库');label.appendChild(selector);toolbar.appendChild(label);root.appendChild(toolbar);
  if(!state.kb){root.appendChild(emptyState({art:'db',title:'还没有学习记录',text:'先选择知识库、生成思维导图，再开始学习。',actions:[btn('去学 · 练','primary',()=>go('learn'))]}));return;}
  const data=await courseApi('report',{kbId:state.kb});if(generation!==state.navigationGeneration)return;
  const next=(data.nodes||[]).find(n=>n.depth>1&&!n.done&&(n.resources||[]).length)||(data.nodes||[]).find(n=>n.depth>1&&!n.done);
  const hero=el('section','course-growth-hero');hero.append(el('h2',null,next?'接着学「'+next.title+'」':data.totalNodes?'这一张导图的节点已全部标记学完':'从思维导图开始自己的学习路径'),el('p','muted',data.completedNodes+' / '+data.totalNodes+' 个节点本人标记学完 · '+data.quizAttempts+' 次首次作答，答对 '+data.quizCorrect+' 次'));
  hero.appendChild(btn(next?'继续这个节点':'去学 · 练','primary',async()=>{await go('learn');if(next)await openCourseNode(next.id);}));root.appendChild(hero);
  const sections=el('div','course-growth-columns'),progress=el('section','course-growth-panel'),history=el('section','course-growth-panel');progress.appendChild(el('h3',null,'各节点学到哪里了'));history.appendChild(el('h3',null,'真实学习记录'));
  for(const n of (data.nodes||[]).filter(n=>n.depth>1)){const row=btn('','course-growth-node',async()=>{await go('learn');await openCourseNode(n.id);});row.append(el('strong',null,n.title),el('span','muted sm',(n.done?'本人标记学完':'还没标记学完')+' · '+(n.resources||[]).length+' / 4 份资源'),el('span','sm',n.quizAttempts?'本节点当前资源首次作答 '+n.quizCorrect+' / '+n.quizAttempts:'还没有当前资源的测验依据'));progress.appendChild(row);}
  if(!data.nodes?.length)progress.appendChild(el('p','muted','先在学·练生成思维导图。'));
  const days=el('select');days.setAttribute('aria-label','学习记录时间范围');for(const[n,label]of[[7,'近7天'],[30,'近30天'],[0,'全部时间']])days.appendChild(option(String(n),label));history.appendChild(days);const list=el('div');history.appendChild(list);
  const paint=()=>{list.replaceChildren();const limit=Number(days.value),cutoff=Date.now()-limit*86400000;const events=(data.history||[]).filter(e=>!limit||Date.parse(e.at)>=cutoff).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,100);for(const e of events){const row=el('article','course-history-row');const text=e.kind==='quiz'?(e.correct?'答对':'答错')+(e.firstAttempt?' · 首次作答':' · 复习作答'):(e.done?'本人标记完成':'本人撤销完成标记');row.append(el('strong',null,e.title||'学习记录'),el('span','muted sm',e.at),el('p',null,text));list.appendChild(row);}if(!events.length)list.appendChild(el('p','muted','这个时间范围还没有记录，归档与恢复不会凭空增加作答次数。'));};days.onchange=paint;paint();sections.append(progress,history);root.append(sections,el('p','course-growth-basis',data.basis));
  const memories=el('details','course-growth-memories');memories.append(el('summary',null,'我的目标与学习记忆'));const context=await api('/api/learning/context',{kbId:state.kb});for(const memory of context.memories||[])memories.appendChild(el('p',null,memory.text));memories.appendChild(btn('管理学习记忆','ghost sm',()=>go('settings','memory')));root.appendChild(memories);
};
PAGE_META.report.title='我的成长';PAGE_META.report.sub='看真实学习记录，决定接下来学什么';
