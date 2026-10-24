/* Personal learning workspace. Data and task truth come from the Cangjie API. */
const RESOURCE_LABEL = {lecture: '定制讲义', practice: '实操指南', quiz: '分阶测试', ppt: 'PPT 演示', legacy:'历史资料'};
const TASK_LABEL = {running: '正在执行', cancelling: '正在停止', completed: '已完成', failed: '未完成', cancelled: '已取消', interrupted: '上次任务已中断'};
const workbench = {selected: null, open: false, loadToken: 0, seenSaved: new Set(), task: null, reference: null};

// Keep the lock outside any particular dialog so reopening it cannot repeat a write.
function workbenchRequestButton(label,cls,key,busyLabel,task,options) {
  const button=btn(label,cls,null);
  button.onclick=()=>runGuarded(typeof key==='function'?key():key,button,busyLabel,task,options).catch(e=>toast(e.message));
  return button;
}

function refreshLiveTimers() {
  for(const node of document.querySelectorAll('.live-elapsed[data-started-at]')) {
    const start=Date.parse(node.dataset.startedAt);
    if(!Number.isFinite(start))continue;
    const text=' · 已用 '+Math.max(0,Math.floor((Date.now()-start)/1000))+' 秒';
    if(node.textContent!==text)node.textContent=text;
  }
}
setInterval(refreshLiveTimers,250);
document.addEventListener('visibilitychange',refreshLiveTimers);

// Four daily destinations. Existing routes stay intact for history and deep links.
RAIL_GROUPS.splice(0, RAIL_GROUPS.length,
  [{id: 'chat', label: '对话', icon: 'chat'}],
  [{id: 'home', label: '学习', icon: 'book'}, {id: 'kb', label: '知识库', icon: 'db'}, {id: 'resources', label: '成果', icon: 'layers'}]);
function navigationRoot(page) {
  if (['learn', 'report', 'calibrate', 'study'].includes(page)) return 'home';
  if (['notes', 'wrong'].includes(page)) return 'resources';
  if (['memory', 'models'].includes(page)) return 'settings';
  return page;
}
Object.assign(PAGE_META, {
  chat: {title: '对话', sub: '围绕你的资料和目标开展任务'},
  home: {title: '知识网络', sub: '对话里沉淀的概念与记录，都在这张网里'},
  learn: {title: '学习', sub: '按节学讲义，练习并留下进度'},
  report: {title: '学习', sub: '阅读记录、练习表现与能力自评'},
  resources: {title: '学习成果', sub: '讲义、练习、笔记与错题，都在这里'},
  notes: {title: '学习成果', sub: '讲义、练习、笔记与错题，都在这里'},
  kb: {title: '知识库', sub: '找到资料、读原文，再开始学习'},
  memory: {title: '学习记忆', sub: '查看、修改或删除 Lumin 记住的内容'},
});
function decorateWorkspace() {
  const view = $('view');
  document.querySelector(current === 'kb' ? '.topbar .workspace-tabs:not(.kb-workspace-tabs)' : '.topbar .workspace-tabs')?.remove();
  const learning = ['home', 'learn', 'report', 'calibrate'].includes(current);
  const outcomes = ['resources', 'notes', 'wrong'].includes(current);
  if (!learning && !outcomes) return;
  const nav = el('nav', 'workspace-tabs' + (learning ? ' center-links' : ''));
  nav.setAttribute('aria-label', learning ? '学习功能' : '学习成果分类');
  const selected = learning ? (current === 'calibrate' ? 'report' : current)
    : current === 'resources' ? 'generated' : (state.resTab || 'notes');
  const tabs = learning ? [['home', '知识网络'], ['learn', '学 · 练'], ['report', '我的成长']]
    : [['generated', '个性资源'], ['notes', '笔记'], ['wrong', '错题'], ['network', '收集资料']];
  for (const [key, label] of tabs) {
    const button = btn(label, 'workspace-tab' + (key === selected ? ' active' : ''), () => {
      if (learning) go(key);
      else if (key === 'generated') go('resources');
      else { state.resTab = key; go('notes'); }
    });
    button.dataset.page = key;
    if (key === selected) button.setAttribute('aria-current', 'page');
    nav.appendChild(button);
  }
  view.querySelector(':scope > .res-tabs')?.remove();
  document.querySelector('.topbar').insertBefore(nav, $('top-actions'));
}
Object.assign(TOOL_LABEL, {
  generate_learning_resource: '生成学习资源', revise_learning_resource: '修改学习资源',
  read_learning_resource: '读取学习资源', get_learning_context: '读取学习上下文',
  remember_learning_fact: '记录学习偏好', forget_learning_fact: '忘记学习记忆',
});
for (const name of ['generate_learning_resource', 'revise_learning_resource', 'read_learning_resource', 'get_learning_context', 'remember_learning_fact', 'forget_learning_fact', 'set_mbti_preference']) TOOL_GROUP[name] = '学习资源';
if (!TOOL_GROUP_ORDER.includes('学习资源')) TOOL_GROUP_ORDER.push('学习资源');

function promptLearning(text) {
  const input = $('chat-input');
  if (!input) { state.pendingQuestion = text; go('chat'); return; }
  input.value = text;
  input.dispatchEvent(new Event('input'));
  input.focus();
}

function resourceCard(resource, compact) {
  const card = el('button', 'resource-entry' + (compact ? ' compact' : ''));
  card.type = 'button';
  card.dataset.resource = resource.id;
  card.innerHTML = '<span class="resource-entry-type">' + esc(RESOURCE_LABEL[resource.kind] || resource.kind) + ' · v' + Number(resource.version || 1) + '</span>' +
    '<strong>' + esc(resource.title || '学习资源') + '</strong>' +
    (compact ? '' : '<span class="muted sm">' + esc(resource.kbId ? kbName(resource.kbId) : '通用主题') + ' · ' + esc(fmtStamp(resource.updatedAt || resource.createdAt)) + '</span>') +
    '<span class="resource-entry-open">' + (resource.kind === 'quiz' ? '开始作答' : resource.kind === 'ppt' ? '预览与播放' : '打开阅读') + ' ↗</span>';
  card.onclick = () => openLearningResource(resource.id, resource.version);
  return card;
}

function ensureResourceDock() {
  window.LuminTeamPanel?.close({immediate:true});
  let dock = $('resource-dock');
  if (!dock) {
    dock = el('aside', 'resource-dock');
    dock.id = 'resource-dock';
    dock.setAttribute('aria-label', '学习成果预览');
    document.querySelector('.app').appendChild(dock);
    // 成果面板的宽度也要能拖：面板是动态创建的，拖动条得在这时候挂
    if (typeof installSplitters === 'function') installSplitters();
  }
  const referenceMode = !!workbench.reference;
  const reader = !referenceMode && current === 'resources' ? $('outcome-reader') : null;
  const embedded = !!reader;
  if (embedded && dock.parentElement !== reader) reader.appendChild(dock);
  if (!embedded && dock.parentElement !== document.querySelector('.app')) document.querySelector('.app').appendChild(dock);
  dock.classList.toggle('embedded-resource', embedded);
  dock.classList.toggle('reference-dock', referenceMode);
  dock.hidden = !workbench.open || (!embedded && !referenceMode && current !== 'chat');
  if (reader) reader.classList.toggle('has-selection', !dock.hidden);
  document.body.classList.toggle('resource-open', !embedded && !dock.hidden);
  return dock;
}

const renderResourceDockInner = renderResourceDock;
renderResourceDock = function () {
  const r = renderResourceDockInner.apply(this, arguments);
  if (typeof installSplitters === 'function') installSplitters();
  return r;
};

function closeResourceDock() {
  const origin = workbench.reference?.origin;
  ++workbench.loadToken;
  workbench.open = false;
  workbench.reference = null;
  ensureResourceDock();
  document.body.classList.remove('reference-compact');
  origin?.isConnected && origin.focus({preventScroll: true});
  (current === 'resources' ? document.querySelector('.outcome-grid .resource-entry.selected') : $('wb-artifacts'))?.focus();
}

async function openLearningResource(id, version) {
  let generation = state.navigationGeneration;
  try {
    const token = ++workbench.loadToken;
    const resource = await api('/api/learning/resource', {id, version: version || 0});
    if (token !== workbench.loadToken || generation !== state.navigationGeneration) return;
    if (current !== 'chat' && !(current === 'resources' && $('outcome-reader'))) {
      const navigation = go('chat'); generation = state.navigationGeneration;
      await navigation;
      if (generation !== state.navigationGeneration) return;
    }
    workbench.file=null;workbench.reference=null;workbench.selected = resource;
    workbench.open = true;
    renderResourceDock();
    document.querySelectorAll('.outcome-grid .resource-entry').forEach(node => {
      const selected = node.dataset.resource === resource.id;
      node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected));
    });
  } catch (e) { if (generation === state.navigationGeneration) toast('读取资源失败：' + e.message); }
}

/** 把当前这份资源导出成 Office 文件（壳里弹"另存为"，写完给一句实话）。 */
async function startAgentTask(question,projectId) {
  const fresh=await api('/api/sessions/new',{projectId:projectId===undefined?(state.chatProject || ''):projectId});
  state.chatSessionId=fresh.sessionId;state.chatProject=fresh.projectId || '';state.chatMode=state.chatProject?'work':'chat';
  await go('chat');const input=$('chat-input');if(!input)throw Error('对话输入区未就绪');
  input.value=question;input.dispatchEvent(new Event('input'));document.querySelector('.composer-send[aria-label="发送"]')?.click();
}
function openPresentationBrief(res) {
  document.querySelector('.presentation-brief')?.remove();
  const overlay=el('div','task-modal presentation-brief'),dialog=el('section','task-modal-card');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','确认PPT制作需求');
  let unbindEscape=()=>{};
  const close=()=>{unbindEscape();overlay.remove();};
  dialog.append(el('h2',null,'这份 PPT 要讲给谁？'),el('p','muted','Lumin 会按确认的需求重新设计页面，制作可编辑的 PowerPoint 文件。'));
  const audience=inputOf('ppt-audience','例如：初学者、项目评审','初学者'),purpose=inputOf('ppt-purpose','例如：课堂讲解、项目汇报','清楚讲解核心概念与应用'),pages=inputOf('ppt-pages','页数','8'),style=inputOf('ppt-style','配色、版式或参考风格','简洁，墨绿与暖金，图文结合');
  pages.type='number';pages.min='1';pages.max='60';
  const background=el('select'),detail=el('select');background.id='ppt-background';detail.id='ppt-detail';
  for(const [value,label] of [['clean-minimal','极致简约'],['abstract-gradient','抽象渐变'],['blue-white-minimal','蓝白极简'],['business-gray','商务灰'],['watercolor','水彩'],['none','纯色排版']])background.appendChild(option(value,label));
  for(const [value,label] of [['concise','精简'],['balanced','均衡'],['detailed','详细']])detail.appendChild(option(value,label));
  background.value='clean-minimal';detail.value='balanced';
  dialog.append(fieldOf('受众',audience),fieldOf('用途',purpose),fieldOf('页数',pages),fieldOf('风格',style),fieldOf('背景样式',background),fieldOf('内容密度',detail));
  const source=res?.id?'请先读取学习资源 '+res.id+' 的第'+res.version+'版，依据其内容重新设计。':'请依据当前主题与资料设计。';
  const submit=async waive=>{
    if(!waive&&(!audience.value.trim()||!purpose.value.trim()||!style.value.trim()||Number(pages.value)<1||Number(pages.value)>60)){toast('请填写完整需求，页数1至60');return;}
    const details=waive?'无需确认PPT细节，受众、页数和风格由你决定，直接制作。':'已确认PPT细节：受众='+audience.value+'；用途='+purpose.value+'；页数='+pages.value+'；风格='+style.value+'；背景样式='+background.value+'；内容密度='+detail.value+'。';
    close();try{await startAgentTask(details+source+'请使用create_presentation逐页设计并制作真实.pptx文件，包括合适的版式与讲者备注。先提供候选产物让我看，不要自动存入个性资源。');}catch(e){toast(e.message);}
  };
  const actions=el('div','row');actions.append(btn('按要求制作','primary',()=>submit(false)),btn('直接制作','ghost',()=>submit(true)),btn('取消','ghost',close));dialog.appendChild(actions);overlay.appendChild(dialog);document.body.appendChild(overlay);unbindEscape=bindModalEscape(overlay,close);audience.focus();
  overlay.onclick=e=>{if(e.target===overlay)close();};
}
const PERSONAL_FORMAT={pptx:'PowerPoint',ppt:'PowerPoint',md:'Markdown',markdown:'Markdown',html:'网页',htm:'网页',docx:'Word',pdf:'PDF',png:'图片',jpg:'图片',jpeg:'图片',svg:'SVG',txt:'文本'};
async function offerPersonalSave(file) {
  if(typeof offerCourseSave==='function'&&await offerCourseSave(file))return;
  document.querySelector('.personal-save-confirm')?.remove();
  const settings=await api('/api/personal/settings',{}),overlay=el('div','task-modal personal-save-confirm'),dialog=el('section','task-modal-card');
  let unbindEscape=()=>{};
  const close=()=>{unbindEscape();overlay.remove();};
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','确认存入个性资源');
  dialog.append(el('h2',null,'满意这版，再存入个性资源'),el('p','muted','确认后会创建这一版的独立副本；后续修改候选稿不会覆盖它。'));
  const title=inputOf('personal-save-title','资源名称',file.title || file.name || '个性资源');dialog.appendChild(fieldOf('资源名称',title));
  dialog.append(el('p','path-line muted sm','来源：'+file.path),el('p','path-line muted sm','副本存放：'+settings.directory));
  const actions=el('div','row'),confirm=workbenchRequestButton('确认存入','primary','personal:save:'+file.path,'正在存入…',async()=>{
    try{
      const saved=await api('/api/personal/save',{path:file.path,title:title.value.trim() || file.name,text:file.indexText || file.text || '',learningId:file.learningId || '',learningVersion:file.learningVersion || 0,sessionId:file.sessionId || state.chatSessionId || '',turnId:file.turnId || '',confirmed:true});
      close();toast('已存入个性资源 · 确认版本 '+saved.version);if(current==='resources')await go('resources');
    }catch(e){toast('保存失败：'+e.message);}
  });
  actions.append(confirm,btn('这版先不存','ghost',close));dialog.appendChild(actions);overlay.appendChild(dialog);document.body.appendChild(overlay);unbindEscape=bindModalEscape(overlay,close);title.focus();
  overlay.onclick=e=>{if(e.target===overlay)close();};
}
async function openPersonalEntry(item) {
  if(!['chat','resources'].includes(current))await go('resources');
  workbench.personalId=item.id;
  if(item.learningId)await openLearningResource(item.learningId,item.learningVersion || 0);
  else await openFilePreview(item.path,{...item,title:item.title});
  document.querySelectorAll('[data-personal-id]').forEach(n=>n.classList.toggle('selected',n.dataset.personalId===item.id));
}
function personalResourceCard(item) {
  const button=btn('','resource-entry personal-entry',()=>openPersonalEntry(item));button.dataset.personalId=item.id;
  if(item.learningId)button.dataset.resource=item.learningId;
  button.title=String(item.title || '');
  button.append(el('span','resource-entry-type',(RESOURCE_LABEL[item.learningKind] || PERSONAL_FORMAT[item.kind] || item.kind.toUpperCase())+' · v'+item.version),el('strong',null,personalResourceTitle(item)),el('span','muted sm',fmtStamp(item.createdAt)),el('span','resource-entry-open','打开预览'));
  return button;
}

function personalResourceTitle(item) {
  let title = String(item.title || item.name || '未命名资源').trim()
    .replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim();
  const firstLine = title.split(/\r?\n/).map(part => part.trim()).find(Boolean) || title;
  const sentence = firstLine.match(/^(.{8,54}?[。！？；：:])/);
  title = sentence ? sentence[1] : firstLine;
  if (title.length > 58) title = title.slice(0, 56).replace(/[，、；：:\s]+$/, '') + '…';
  return title || '未命名资源';
}
async function openPersonalSearchHit(hit) {
  if(hit.type==='note' || hit.type==='wrong'){state.resTab=hit.type==='note'?'notes':'wrong';await go('notes','',{focus:hit.id});return;}
  if(hit.type==='knowledge' && typeof openKnowledgePoint==='function'){await go('home');await openKnowledgePoint(hit.id);return;}
  await openPersonalEntry(await api('/api/personal/read',{id:hit.id}));
}

function fileArtifactCard(artifact) {
  const button=btn('','resource-entry compact file-artifact',()=>openFilePreview(artifact.path,artifact));
  button.dataset.artifactPath=artifact.path;button.append(el('span','resource-entry-type',(artifact.kind || String(artifact.path || '').split('.').pop()).toUpperCase()+' · 候选产物'),el('strong',null,artifact.title || String(artifact.path || '').replace(/\\/g,'/').split('/').pop()),el('span','resource-entry-open','打开预览'));
  return button;
}
async function openFilePreview(file,metadata={}) {
  if(!window.itnWindow?.readResourceFile){toast('文件预览只在桌面窗口中可用');return;}
  const generation=state.navigationGeneration,token=++workbench.loadToken,data=await window.itnWindow.readResourceFile(file);if(token!==workbench.loadToken||generation!==state.navigationGeneration)return;
  if(!data.ok){workbench.file={kind:'file',path:file,name:String(file).replace(/\\/g,'/').split('/').pop(),error:data.error,...metadata};workbench.selected=null;workbench.reference=null;workbench.open=true;renderResourceDock();return;}
  workbench.file={...data,...metadata,path:data.path};workbench.selected=null;workbench.reference=null;workbench.open=true;renderResourceDock();
}
function renderFilePreview(dock,file) {
  const head=el('header','resource-dock-head');head.append(el('strong','grow',file.title || file.name),btn('关闭','ghost sm',closeResourceDock));dock.appendChild(head);
  const tools=el('div','file-preview-tools');tools.append(el('span','muted sm',String(file.kind).toUpperCase()),btn('系统打开','ghost sm',()=>window.itnWindow.openPath(file.path)));
  if(typeof offerPersonalSave==='function')tools.appendChild(btn('存入个性资源','sm',()=>offerPersonalSave(file)));
  dock.appendChild(tools);const body=el('section','file-preview-body');body.setAttribute('aria-label','文件预览');dock.appendChild(body);
  if(file.kind==='html' || file.html || file.kind==='pdf'){
    const frame=el('iframe','artifact-frame');frame.title=file.title || file.name;frame.setAttribute('sandbox',file.kind==='html'?'allow-scripts':'');
    if(file.kind==='pdf')frame.src=file.dataUrl;else frame.srcdoc="<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'\">"+(file.html || file.text);body.appendChild(frame);
  }else if(file.kind==='image' || file.kind==='svg'){
    const img=el('img','artifact-image');img.alt=file.title || file.name;img.src=file.dataUrl || 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(file.text);body.appendChild(img);
  }else if(file.kind==='pptx'){
    const box=el('div','ppt-preview-unavailable');
    box.append(el('strong',null,'这份 PPT 没有版面预览'),el('p',null,'不再用文字提纲冒充幻灯片。用 PowerPoint 打开可查看完整排版。'));
    if(window.itnWindow?.openPath)box.appendChild(btn('用 PowerPoint 打开','primary sm',async()=>{const result=await window.itnWindow.openPath(file.path);if(result&&result.ok===false)toast(result.error||'无法打开 PPT');}));
    body.appendChild(box);
  }else{const article=el('article',file.kind==='markdown'?'md':'plain-document');if(file.kind==='markdown')article.innerHTML=md(file.text || '',{baseDir:String(file.path || '').replace(/[\\/][^\\/]+$/, '')});else article.textContent=file.text || file.error || '';body.appendChild(article);}
}

function referenceKb(citation) {
  const list = state.cfg?.knowledgeBases || [];
  return list.find(k => k.id === citation?.kbId) || null;
}

function referencePath(citation) {
  const raw = String(citation?.docPath || "").trim();
  if (!raw) return "";
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw) || /^\//.test(raw)) return raw;
  return citation.absolutePath || '';
}

function openReferencePath(path) {
  if (!path) { toast("没有可打开的原文件"); return; }
  if (!window.itnWindow?.openPath) { toast("打开原文件只在桌面窗口中可用"); return; }
  window.itnWindow.openPath(path).then(result => {
    if (result?.ok === false) toast(result.error || "无法打开原文件");
  }).catch(() => toast("无法打开原文件"));
}

function renderReferenceDock(dock, ref) {
  const citation = ref?.citation || ref || {};
  const isWeb = citation.kind === "web" || /^https?:\/\//i.test(citation.docPath || citation.url || "");
  const token = workbench.loadToken;
  const alive = () => workbench.open && workbench.reference === ref && token === workbench.loadToken && dock.isConnected;
  const title = citation.docTitle || citation.title || citation.url || citation.docPath || "资料引用";
  const head = el("header", "resource-dock-head reference-dock-head");
  const heading = el("div", "grow reference-heading");
  const titleNode = el('strong', 'reference-title', title);
  heading.append(el("span", "reference-kicker", ref.kind === 'knowledge' ? '知识点' : isWeb ? "网页引用" : "知识库引用"), titleNode);
  head.append(heading, btn("关闭", "ghost sm", closeResourceDock));
  dock.appendChild(head);

  const body = el("div", "resource-dock-body reference-body");
  dock.appendChild(body);
  const meta = el("div", "reference-meta");
  if (citation.headingPath) meta.appendChild(el("span", null, citation.headingPath));
  if (citation.docPath) meta.appendChild(el("span", "reference-path-text", citation.docPath));
  if (meta.childElementCount) body.appendChild(meta);

  const actions = el("div", "reference-actions");
  const openOriginal = btn('打开原文件', 'primary sm', () => openReferencePath(referencePath(citation)));
  openOriginal.disabled = !referencePath(citation);
  if (isWeb) {
    const href = citation.docPath || citation.url || "";
    actions.appendChild(btn("用浏览器打开", "primary sm", () => {
      if (!window.itnWindow?.openUrl) { window.open(href, '_blank', 'noopener,noreferrer'); return; }
      window.itnWindow.openUrl(href).then(result => {
        if (result?.ok === false) toast(result.error || "无法打开网页");
      }).catch(() => toast("无法打开网页"));
    }));
  } else {
    if (ref.kind !== 'knowledge') actions.appendChild(openOriginal);
    actions.appendChild(btn(ref.kind === 'knowledge' ? '查看知识网络' : '打开资料库', 'ghost sm', async () => {
      if (ref.kind === 'knowledge') { await go('home'); await openKnowledgePoint(citation.id); }
      else { if (citation.kbId) state.kb = citation.kbId; await go('kb'); }
    }));
  }
  if (citation.chunkId) actions.appendChild(btn("复制引用位置", "ghost sm", () => navigator.clipboard.writeText(citation.chunkId).then(() => toast("已复制引用位置")).catch(() => toast("复制失败"))));
  if (actions.childElementCount) body.appendChild(actions);

  const content = el("div", "reference-content");
  body.appendChild(content);
  if (citation.text) {
    const saved = el('section', 'reference-snapshot');
    saved.appendChild(el('h3', '', '引用片段'));
    const article = el('article', 'md');
    article.innerHTML = md(citation.text, {document: !!citation.kbId && !isWeb, kbId: citation.kbId, docPath: citation.docPath});
    saved.appendChild(article); content.appendChild(saved); hydrateKnowledgeImages(article);
  }
  const status = el('p', 'muted reference-status', isWeb ? (citation.text ? '' : '在浏览器中查看来源全文。') : '正在读取资料…');
  content.appendChild(status);

  if (ref?.kind === "knowledge" && citation.id) {
    api("/api/knowledge/node", {id: citation.id}).then(node => {
      if (!alive()) return;
      content.replaceChildren();
      titleNode.textContent = node.title || '知识点';
      content.append(el("h3", null, node.title || "知识点"), el("p", null, node.definition || "还没有定义。"));
      for (const record of node.records || []) {
        const row = el("section", "reference-chunk");
        row.appendChild(el("h4", null, record.question || "对话记录"));
        if (record.note) row.appendChild(el("p", null, record.note));
        if (record.workspaceRoot) row.appendChild(btn(record.workspaceRoot, "reference-path-button", () => openReferencePath(record.workspaceRoot)));
        content.appendChild(row);
      }
    }).catch(error => toast("读取知识点失败：" + error.message));
    return;
  }
  if (isWeb) return;
  const load = async () => {
    if (citation.kbId && !citation.docPath && !citation.chunkId) {
      const kb = await api('/api/kb/stats', {id: citation.kbId});
      if (!alive()) return;
      titleNode.textContent = kb.name || title; status.textContent = '';
      for (const doc of kb.docs || []) content.appendChild(btn(doc.title || doc.path, 'reference-document', () => openReference({kind: 'citation', citation: {kbId: citation.kbId, docPath: doc.path, docTitle: doc.title}})));
      if (!kb.docs?.length) status.textContent = '这个知识库还没有资料。';
      return;
    }
    const result = await api('/api/kb/reference', {kbId: citation.kbId || '', docPath: citation.docPath || '', chunkId: citation.chunkId || '', headingPath: citation.headingPath || ''});
    if (!alive()) return;
    if (result.status === 'ambiguous') {
      status.textContent = '找到多份同名资料，选择要查看的来源。';
      for (const item of result.candidates || []) content.appendChild(btn((item.kbName || item.kbId) + ' · ' + (item.docTitle || item.docPath), 'reference-document', () => openReference({kind: 'citation', citation: {...citation, ...item, text: citation.text || ''}})));
      return;
    }
    if (result.status !== 'found') { status.textContent = citation.text ? '原资料暂不可用，引用片段仍保留。' : '没有找到这份资料，可以检查知识库来源。'; return; }
    Object.assign(citation, {kbId: result.kbId, docPath: result.docPath, absolutePath: result.absolutePath || ''});
    titleNode.textContent = result.docTitle || title;
    openOriginal.disabled = !referencePath(citation);
    status.textContent = '';
    const original = el('section', 'reference-original'); original.appendChild(el('h3', '', '资料原文')); content.appendChild(original);
    const chunks = el('div', 'reference-chunks'); original.appendChild(chunks);
    let offset = Number(result.pageOffset || 0), loading = false;
    const more = btn('加载更多', 'ghost sm reference-more', () => read());
    original.appendChild(more);
    async function read() {
      if (loading || offset < 0) return;
      loading = true; more.disabled = true; more.textContent = '读取中…';
      try {
        const page = await api('/api/kb/document', {id: result.kbId, path: result.docPath, offset, limit: 24});
        if (!alive()) return;
        for (const chunk of page.chunks || []) {
          const section = el('section', 'reference-chunk' + (chunk.id === (citation.chunkId || result.chunkId) ? ' cited' : ''));
          section.dataset.chunkId = chunk.id;
          if (chunk.headingPath) section.appendChild(el('h4', '', chunk.headingPath));
          const article = el('article', 'md'); article.innerHTML = md(chunk.text || '', {document: true, kbId: result.kbId, docPath: result.docPath});
          section.appendChild(article); chunks.appendChild(section); hydrateKnowledgeImages(article);
        }
        offset = Number(page.nextOffset); more.hidden = offset < 0; more.textContent = '加载更多';
      } catch (error) { if (alive()) { more.textContent = '重试'; toast('读取原文失败：' + error.message); } }
      finally { loading = false; more.disabled = false; }
    }
    if (offset > 0) original.insertBefore(btn('从文档开头阅读', 'ghost sm', () => { chunks.replaceChildren(); offset = 0; more.hidden = false; read(); }), chunks);
    await read();
  };
  load().catch(error => { if (alive()) status.textContent = '读取原文失败：' + error.message; });
}

function openReference(ref) {
  ref = {...ref, citation: {...(ref.citation || ref)}};
  ++workbench.loadToken;
  ref.origin = document.activeElement;
  workbench.file = null;
  workbench.selected = null;
  workbench.reference = ref;
  workbench.open = true;
  renderResourceDock();
  updateReferenceLayout();
}

window.LuminReferencePanel = {
  open: openReference,
  close: closeResourceDock,
  isOpen: () => !!workbench.reference && !!workbench.open,
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && workbench.open && workbench.reference && !document.querySelector('.app-modal-layer,.task-modal')) {
    event.preventDefault(); event.stopImmediatePropagation(); closeResourceDock();
  }
}, true);
function updateReferenceLayout() {
  const app = document.querySelector('.app'), rail = document.getElementById('rail'), panel = document.getElementById('panel');
  if (!app) return;
  const panelWidth = panel?.hidden ? 0 : parseFloat(getComputedStyle(panel).width) || 0;
  document.body.classList.toggle('reference-compact', !!workbench.reference && workbench.open && app.clientWidth - (rail?.offsetWidth || 0) - panelWidth < 660);
}
window.addEventListener('resize', updateReferenceLayout);
window.addEventListener('lumin:ui-zoom', updateReferenceLayout);

async function exportResourceAs(res, kind) {
  if(kind==='pptx'){openPresentationBrief(res);return;}
  const a = window.itnWindow;
  if (!a || typeof a.exportResource !== 'function') { toast('导出只在桌面应用窗口里可用'); return; }
  try {
    const r = await a.exportResource({ markdown: res.markdown || '', kind: kind, name: res.title || '学习资源' });
    if (r && r.ok) toast('已导出：' + String(r.path || '').replace(/\\/g, '/').split('/').pop());
    else if (r && r.canceled) { /* 用户自己取消的，不打扰 */ }
    else toast('导出失败：' + ((r && r.error) || '未知错误'));
  } catch (e) {
    toast('导出失败：' + e.message);
  }
}

function renderResourceDock() {
  const dock = ensureResourceDock();
  // innerHTML 一清，挂在面板边缘的拖动条也没了：刷完内容再挂一次（installSplitters 是幂等的）
  dock.innerHTML = '';
  if(workbench.reference){renderReferenceDock(dock,workbench.reference);return;}
  if(workbench.file){renderFilePreview(dock,workbench.file);return;}
  const res = workbench.selected;
  const head = el('header', 'resource-dock-head');
  head.appendChild(el('div', 'grow', res ? (RESOURCE_LABEL[res.kind] || res.kind) : '学习成果'));
  head.appendChild(btn('关闭', 'ghost sm', closeResourceDock));
  dock.appendChild(head);
  const body = el('div', 'resource-dock-body');
  dock.appendChild(body);
  if (!res) {
    body.appendChild(el('h2', null, '学习成果在这里展开'));
    body.appendChild(el('p', 'muted', '告诉 Lumin 你的学习目标。需要讲义、实操、测试或演示时，它会调用工具生成，结果会自动出现在这里。'));
    body.appendChild(btn('查看全部资源', '', () => go('resources')));
    return;
  }
  body.appendChild(el('h2', 'resource-title', res.title));
  const meta = el('div', 'row resource-meta');
  const versions = el('select');
  versions.setAttribute('aria-label', '资源版本');
  for (const n of res.versions || [res.version]) {
    const option = el('option', null, '版本 ' + n + (n === (res.versions || [res.version])[0] ? ' · 最新' : ''));
    option.value = n; option.selected = n === res.version; versions.appendChild(option);
  }
  versions.onchange = () => openLearningResource(res.id, Number(versions.value));
  meta.appendChild(versions);
  const issues = (res.quality || {}).issues || [];
  meta.appendChild(tag(issues.length ? '需检查' : '结构质检通过', issues.length ? 'warn' : 'ok'));
  body.appendChild(meta);
  const actions = el('div', 'row resource-actions');
  if (res.kind === 'ppt') {
    actions.appendChild(btn('播放', 'primary sm', () => openResourcePresentation(res)));
    if (res.artifactPath && window.itnWindow?.openPath) actions.appendChild(btn('打开 PPT', 'ghost sm', async () => {
      const result = await window.itnWindow.openPath(res.artifactPath);
      if (result && result.ok === false) toast(result.error || '无法打开 PPT');
    }));
    actions.appendChild(btn('修改', 'ghost sm', () => {
      promptLearning('请先读取学习资源 ' + res.id + ' 的最新版本，再按以下要求修改并保存新版本：');
    }));
  } else {
    actions.appendChild(btn('修改', 'sm', () => {
      promptLearning('请先读取学习资源 ' + res.id + ' 的最新版本，再按以下要求修改并保存新版本：');
    }));
    actions.appendChild(copyButton(() => res.markdown || '', '复制 Markdown'));
    /* 学习成果是 Markdown，但要交给别人 / 自己接着改的时候，得有 Office 文件。
       导出在壳里做（离线、零依赖，见 shell/deck-export.js），这里只负责给入口与结果提示。 */
    if (window.itnWindow && typeof window.itnWindow.exportResource === 'function') {
      actions.appendChild(btn('制作 PPT', 'sm ghost', () => exportResourceAs(res, 'pptx')));
      actions.appendChild(btn('导出 docx', 'sm ghost', () => exportResourceAs(res, 'docx')));
    }
  }
  if (res.version > 1) actions.appendChild(btn('查看修改差异', 'sm ghost', async () => {
    try {
      const previous = await api('/api/learning/resource', {id: res.id, version: res.version - 1});
      body.querySelector('.resource-diff')?.remove();
      const diff = el('details', 'resource-diff'); diff.open = true;
      diff.appendChild(el('summary', null, '版本 ' + previous.version + ' → ' + res.version + ' · 修改差异'));
      const pre = el('pre', 'resource-diff-lines');
      for (const [kind, text] of diffResourceLines(previous.markdown || '', res.markdown || '')) {
        const line = el('div', 'diff-' + kind, (kind === 'add' ? '+ ' : kind === 'remove' ? '− ' : '  ') + text); pre.appendChild(line);
      }
      diff.appendChild(pre); body.insertBefore(diff, body.querySelector('.resource-content')); diff.scrollIntoView({block: 'nearest'});
    } catch(e) {toast('比较失败：' + e.message);}
  }));
  if(res.id && res.kind !== 'ppt')actions.appendChild(btn('全屏打开','ghost sm',()=>go('study',res.id+'@'+res.version)));
  actions.appendChild(btn(res.courseTarget?.nodeId?'加入我的学习资源':'存入个性资源','sm',()=>offerPersonalSave({path:res.artifactPath,title:res.title,text:res.markdown,learningId:res.id,learningVersion:res.version,sessionId:res.sessionId,turnId:res.turnId})));
  body.appendChild(actions);
  if ((res.warnings || []).length) body.appendChild(el('p', 'resource-notice', res.warnings.join('；')));
  const content = el('div', 'resource-content');
  if (res.kind === 'quiz') renderResourceQuiz(content, res);
  else if (res.kind === 'practice') renderResourcePractice(content, res);
  else if (res.kind === 'ppt') renderPptResourcePreview(content, res);
  else {
    const article = el('article', 'md'); article.innerHTML = md(res.markdown || '', {citations: res.citations || []});
    if (article.querySelector('h1')?.textContent === res.title) article.querySelector('h1').remove();
    content.appendChild(article);
  }
  body.appendChild(content);
  linkInlineCitations(content, res.citations || []);
  if (res.kind !== 'quiz') {
    const done = workbenchRequestButton(res.progress?.done ? '已标记完成 · 撤销' : '标记本次学习完成', 'sm ghost', 'resource:progress:'+res.id+':'+res.version, '正在记录…', async () => {
      try {
        res.progress = await api('/api/learning/progress', {id: res.id, version: res.version, done: !res.progress?.done});
        renderResourceDock();
      } catch (e) { toast('记录失败：' + e.message); }
    });
    body.appendChild(done);
    body.appendChild(el('p', 'muted sm', '完成标记记录学习活动，不换算为掌握度。'));
  }
  const provenance = el('details', 'resource-provenance');
  provenance.appendChild(el('summary', null, '资料依据与生成记录'));
  provenance.appendChild(el('p', 'muted sm', '资源 ' + res.id + ' · 版本 ' + res.version + ' · ' + fmtStamp(res.createdAt)));
  for (const c of res.citations || []) {
    const source = el('details', 'resource-source');
    source.appendChild(el('summary', null, '[' + c.index + '] ' + (c.docTitle || '') + ' · ' + (c.headingPath || '')));
    source.appendChild(btn('打开引用', 'ghost sm reference-open-citation', () => openReference({kind: 'citation', citation: c})));
    source.appendChild(el('p', 'muted sm', (c.docPath || '') + ' · 生成时的资料切片'));
    const article = el('article', 'md'); article.innerHTML = md(c.text || '此历史资源没有保存切片快照，请回到知识库核实原文。');
    source.appendChild(article); provenance.appendChild(source);
  }
  if (!(res.citations || []).length) provenance.appendChild(el('p', 'muted sm', '这份资源没有本地资料依据，请结合原文核实。'));
  provenance.appendChild(el('p', 'muted sm', '画像快照保留生成时的目标、偏好和作答依据，不会随后续档案编辑而改变。'));
  if (res.sessionId) provenance.appendChild(btn('回到生成会话', 'ghost sm', () => openChatSession(res.sessionId)));
  body.appendChild(provenance);
}

function renderPptResourcePreview(container, res) {
  container.classList.add('resource-ppt-preview');
  const stage = el('div', 'resource-ppt-stage');
  const loading = el('div', 'resource-ppt-loading', '正在载入幻灯片…');
  stage.appendChild(loading);
  const pager = el('div', 'resource-ppt-pager');
  container.append(stage, pager);
  const unavailable = message => {
    stage.replaceChildren();
    const box = el('div', 'ppt-preview-unavailable');
    box.append(el('strong', null, '幻灯片预览暂不可用'), el('p', null, message));
    if (res.artifactPath && window.itnWindow?.openPath) box.appendChild(btn('用 PowerPoint 打开', 'primary sm', async () => {
      const result = await window.itnWindow.openPath(res.artifactPath);
      if (result && result.ok === false) toast(result.error || '无法打开 PPT');
    }));
    stage.appendChild(box);
    pager.replaceChildren();
  };
  if (!res.artifactPath || !window.itnWindow?.readResourceFile) {
    unavailable('这份资源没有可读取的 PPT 文件，请从生成记录重新打开。');
    return;
  }
  const token = workbench.loadToken;
  window.itnWindow.readResourceFile(res.artifactPath).then(data => {
    if (token !== workbench.loadToken || !container.isConnected) return;
    if (!data?.ok || !data.html) { unavailable(data?.error || '文件里没有版面预览，不会再用文字提纲冒充 PPT。'); return; }
    const doc = new DOMParser().parseFromString(data.html, 'text/html');
    const sections = Array.from(doc.querySelectorAll('.slide'));
    if (!sections.length) { unavailable('这份 PPT 缺少页级预览，请用 PowerPoint 查看完整版式。'); return; }
    const css = Array.from(doc.querySelectorAll('style')).map(node => node.textContent || '').join('\n');
    const override = 'html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}body{padding:0!important;display:grid;place-items:center}.slide{width:100%!important;max-width:none!important;height:100%!important;margin:0!important;border-radius:0!important;box-shadow:none!important;box-sizing:border-box}.slide img{width:100%!important;height:100%!important;object-fit:contain!important}';
    const docs = sections.map(section => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>' + css + '\n' + override + '</style></head><body>' + section.outerHTML + '</body></html>');
    let index = 0;
    const pos = el('span', 'resource-ppt-pos');
    const prev = btn('上一页', 'ghost sm', () => paint(index - 1));
    const next = btn('下一页', 'ghost sm', () => paint(index + 1));
    const paint = target => {
      if (target === index && stage.querySelector('.resource-ppt-frame')) return;
      index = Math.max(0, Math.min(docs.length - 1, target));
      const title = (sections[index].querySelector('h2')?.textContent || sections[index].dataset.title || '幻灯片') + ' · 第 ' + (index + 1) + ' 页';
      const image = sections[index].querySelector('img')?.getAttribute('src');
      let surface;
      if (image) {
        surface = el('img', 'resource-ppt-frame');
        surface.src = image; surface.alt = title;
      } else {
        surface = el('iframe', 'resource-ppt-frame');
        surface.title = title; surface.setAttribute('sandbox', ''); surface.srcdoc = docs[index];
      }
      stage.replaceChildren(surface);
      pos.textContent = (index + 1) + ' / ' + docs.length;
      prev.disabled = index <= 0; next.disabled = index >= docs.length - 1;
    };
    pager.replaceChildren(prev, pos, next);
    paint(0);
  }).catch(error => {
    if (token === workbench.loadToken && container.isConnected) unavailable(error.message || '读取 PPT 预览失败');
  });
}

function openResourcePresentation(res) {
  return go('study', res.id + '@' + res.version);
}

/** Line LCS; very long documents use a truthful coarse replacement block. */
function diffResourceLines(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 2000000) {
    let start = 0, end = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
    return [...a.slice(0,start).map(s=>['same',s]), ...a.slice(start,a.length-end).map(s=>['remove',s]), ...b.slice(start,b.length-end).map(s=>['add',s]), ...a.slice(a.length-end).map(s=>['same',s])];
  }
  const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
  for (let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--) table[i*width+j] = a[i]===b[j] ? 1+table[(i+1)*width+j+1] : Math.max(table[(i+1)*width+j],table[i*width+j+1]);
  const rows=[];let i=0,j=0;
  while(i<a.length||j<b.length) {
    if(i<a.length&&j<b.length&&a[i]===b[j]) {rows.push(['same',a[i++]]);j++;}
    else if(j<b.length&&(i===a.length||table[i*width+j+1]>=table[(i+1)*width+j])) rows.push(['add',b[j++]]);
    else rows.push(['remove',a[i++]]);
  }
  return rows;
}

function renderResourceQuiz(container, res) {
  const qs = res.content?.questions || [];
  container.appendChild(el('p', 'muted sm', qs.length + ' 道题 · 提交后显示答案与解析。首次作答进入学习证据，重复提交不会增加样本。'));
  for (const [index, q] of qs.entries()) {
    const card = el('section', 'resource-question');
    card.dataset.question = q.id;
    card.appendChild(el('h3', null, (index + 1) + '. ' + q.stem));
    const level = {easy: '基础', medium: '应用', hard: '进阶'}[q.difficulty] || q.difficulty;
    card.appendChild(el('span', 'muted sm', level || ''));
    const options = el('fieldset', 'quiz-options');
    const legend = el('legend', 'sr-only', '第 ' + (index + 1) + ' 题选项'); options.appendChild(legend);
    for (const [i, text] of (q.options || []).entries()) {
      const label = el('label', 'quiz-choice');
      const input = el('input'); input.type = 'radio'; input.name = res.id + '-' + res.version + '-' + q.id; input.value = i;
      label.appendChild(input); label.appendChild(el('span', null, String.fromCharCode(65 + i) + '. ' + text)); options.appendChild(label);
    }
    card.appendChild(options);
    const result = el('div', 'quiz-feedback'); result.setAttribute('aria-live', 'polite');
    let pendingAttempt = null;
    const submit = btn('提交答案', 'sm primary', async () => {
      const selected = options.querySelector('input:checked');
      if (!selected) { result.textContent = '请先选择一个答案'; return; }
      const choice = Number(selected.value);
      if (!pendingAttempt || pendingAttempt.choice !== choice) pendingAttempt = {id: crypto.randomUUID(), choice};
      submit.disabled = true;
      try {
        const r = await api('/api/learning/answer', {id: res.id, version: res.version, questionId: q.id, choice, attemptId: pendingAttempt.id});
        result.textContent = (r.correct ? '回答正确。' : '本题答错，正确答案是 ' + String.fromCharCode(65 + r.correctIndex) + '。') + r.explanation;
        result.classList.toggle('correct', r.correct);
        options.disabled = true;
        submit.textContent = '已记录';
      } catch (e) { result.textContent = '提交失败：' + e.message; submit.disabled = false; }
    });
    card.appendChild(submit); card.appendChild(result); container.appendChild(card);
    const saved = res.answers?.[q.id];
    if (saved) {
      const input = options.querySelector('input[value="' + saved.choice + '"]');
      if (input) input.checked = true;
      options.disabled = true; submit.disabled = true; submit.textContent = '已记录';
      result.textContent = (saved.correct ? '回答正确。' : '正确答案是 ' + String.fromCharCode(65 + saved.correctIndex) + '。') + saved.explanation;
      result.classList.toggle('correct', !!saved.correct);
    }
    const retry = btn('再练一次', 'sm ghost', () => {
      options.disabled = false; submit.disabled = false; submit.textContent = '提交答案'; result.textContent = ''; pendingAttempt = null;
      for (const input of options.querySelectorAll('input')) input.checked = false;
    });
    card.appendChild(retry);
  }
}

function renderResourcePractice(container, res) {
  const c = res.content || {};
  if (c.objective) container.appendChild(el('p', null, c.objective));
  for (const [i, step] of (c.steps || []).entries()) {
    const detail = el('details', 'practice-step'); detail.open = i === 0;
    detail.appendChild(el('summary', null, (i + 1) + '. ' + step.title));
    const text = el('div', 'md');
    text.innerHTML = md(step.instruction || ''); detail.appendChild(text);
    if (step.code) detail.appendChild(el('pre', null, step.code));
    detail.appendChild(el('p', 'practice-output', '预期结果：' + (step.expectedOutput || '')));
    if (step.warning) detail.appendChild(el('p', 'resource-notice', step.warning));
    container.appendChild(detail);
  }
  container.appendChild(el('h3', null, '验收标准'));
  for (const text of c.acceptanceCriteria || []) container.appendChild(el('p', null, '· ' + text));
  const rest = el('details', 'resource-provenance'); rest.appendChild(el('summary', null, '完整指南与故障排查'));
  const article = el('article', 'md'); article.innerHTML = md(res.markdown || ''); rest.appendChild(article); container.appendChild(rest);
}

async function workbenchAfterPage() {
  const generation = state.navigationGeneration;
  if (workbench.stateTimer) clearInterval(workbench.stateTimer);
  decorateWorkspace();
  const dock = ensureResourceDock();
  document.querySelector('.wb-toolbar')?.remove();
  if (current === 'resources' && $('outcome-reader')) { if (workbench.open) renderResourceDock(); return; }
  if (current !== 'chat' || currentSection === 'overview') { dock.hidden = true; return; }
  const bar = el('div', 'wb-toolbar');
  /* 左边是这段对话的身份：📁 工作区 | 会话名（会话名由第一次提问自动生成，也能手动改） */
  bar.appendChild(typeof sessionCrumb === 'function' ? sessionCrumb()
    : el('span', 'wb-scope', scopeNow() ? kbName(scopeNow()) : '全部本地知识库'));
  const status = el('span', 'wb-task', ''); status.id = 'wb-task-state'; status.setAttribute('role', 'status'); bar.appendChild(status);
  bar.appendChild(spacer());
  bar.appendChild(typeof sessionMoreBtn === 'function' ? sessionMoreBtn() : spacer());
  // The right pane opens explicit conversation artifacts; it has no random-resource toggle.
  document.querySelector('.main').insertBefore(bar, $('view'));
  if (workbench.open) renderResourceDock();
  await refreshWorkbenchState();
  if (generation !== state.navigationGeneration) return;
  workbench.stateTimer = setInterval(async () => {
    if (current !== 'chat') return;
    await refreshWorkbenchState();
    if (!state.chatRequest?.external) return;
    try {
      const sid = state.chatRequest.sessionId;
      const d = await api('/api/sessions/events', {sessionId: sid});
      if (state.chatSessionId !== sid) return;
      state.chatEvents = d.events || [];
      state.lastEventId = d.lastId || state.lastEventId || 0;   // 增量轮询的游标
      state.chatTurns = turnsFromEvents(state.chatEvents);
      syncWorkbenchEvents(state.chatEvents);
      if (!['running', 'cancelling'].includes(workbench.task?.status)) {
        state.chatRequest = null; state.busyTurn = false; state.cancelRequested = null;
      }
      state.chatPaint?.();
    } catch (e) { /* Preserve the last confirmed state while disconnected. */ }
  }, 1500);
}

/**
 * 只刷新对话页顶栏（面包屑 + 会话菜单）。
 * 标题是异步生成的、切换会话也会改名字，这两处都不该重建整个工作台，所以单独留一个入口。
 */
function refreshChatHeader() {
  if (current !== 'chat' || currentSection === 'overview') return;
  const main = document.querySelector('.main');
  const old = document.querySelector('.wb-toolbar');
  if (!main || typeof sessionCrumb !== 'function') return;
  const bar = el('div', 'wb-toolbar');
  bar.appendChild(sessionCrumb());
  const status = el('span', 'wb-task', ''); status.id = 'wb-task-state'; status.setAttribute('role', 'status'); bar.appendChild(status);
  bar.appendChild(spacer());
  bar.appendChild(sessionMoreBtn());
  // The right pane opens explicit conversation artifacts; it has no random-resource toggle.
  if (old && old.parentElement) old.replaceWith(bar); else main.insertBefore(bar, $('view'));
  refreshWorkbenchState().catch(() => {});
}

async function refreshWorkbenchState() {
  const generation = state.navigationGeneration;
  const sid = state.chatSessionId;
  if (!sid || current !== 'chat') return;
  try {
    const task = await api('/api/sessions/state', {sessionId: sid});
    if (state.chatSessionId !== sid || generation !== state.navigationGeneration || current !== 'chat') return;
    workbench.task = task;
    if (['running', 'cancelling'].includes(task.status) && !state.chatRequest) {
      state.chatRequest = {sessionId: sid, turnId: task.turnId, external: true};
      state.busyTurn = true;
      state.chatPaint?.();
    }
    const badge = $('wb-task-state');
    if (badge) { badge.textContent = TASK_LABEL[task.status] || ''; badge.dataset.status = task.status || ''; }
    if (task.status === 'interrupted') {
      const pending = state.chatTurns.find(t => t.id === task.turnId && t.ok == null);
      if (pending) { pending.ok = false; pending.message = '上次任务因应用退出而中断，已有成果保留。可以继续任务。'; }
      if (pending) state.chatPaint?.();
      if (!$('wb-interrupted')) {
        const notice = el('div', 'wb-interrupted'); notice.id = 'wb-interrupted';
        notice.appendChild(el('span', null, '上次任务已中断。记录和已保存资源都在。'));
        notice.appendChild(btn('继续任务', 'sm', () => promptLearning('继续上次未完成的任务。先检查已经完成的工具结果和已保存资源，避免重复执行。')));
        $('view').prepend(notice);
      }
    }
  } catch (e) { if ($('wb-task-state')) $('wb-task-state').textContent = '状态读取失败'; }
}

function syncWorkbenchEvents(events) {
  const saves = events.filter(e => e.type === 'resource/saved');
  for (const e of saves) {
    const key = e.payload.id + ':' + e.payload.version;
    if (workbench.seenSaved.has(key)) continue;
    workbench.seenSaved.add(key);
    // Only newly produced resources open automatically; historic cards remain clickable.
    if (current==='chat' && state.chatRequest && !workbench.reference && e.turnId === state.chatRequest.turnId) openLearningResource(e.payload.id, e.payload.version);
  }
}

PAGES.resources.render = async function() {
  const generation=state.navigationGeneration,view=$('view');view.replaceChildren();
  const pageShell=el('section','outcome-page');
  const toolbar=el('div','outcome-toolbar outcome-toolbar-clean'),search=inputOf('learning-resource-search','搜索个性资源标题或正文',state.outcomeQuery || ''),kind=el('select');
  const toolbarText=el('div','outcome-toolbar-title');
  toolbarText.append(el('h2',null,'个性资源'),el('p','muted','保存过的讲义、练习、课件和文件都在这里。'));
  search.setAttribute('aria-label','搜索个性资源');kind.setAttribute('aria-label','筛选成果类型');kind.appendChild(option('','全部格式'));
  for(const [value,label] of [['pptx','PowerPoint'],['html','网页'],['md','Markdown / 讲义'],['quiz','测验'],['docx','Word'],['pdf','PDF'],['png','图片']])kind.appendChild(option(value,label));kind.value=state.outcomeKind || '';
  const create=el('details','outcome-create');create.appendChild(el('summary','btn primary','+ 添加资源'));
  const menu=el('div','outcome-menu');menu.append(btn('制作 PPT','ghost',()=>openPresentationBrief()),btn('导入文件','ghost',async()=>{if(!window.itnWindow?.pickFile)return toast('请在桌面窗口选择文件');const file=await window.itnWindow.pickFile();if(file){const data=await window.itnWindow.readResourceFile(file);if(data.ok)offerPersonalSave(data);else toast(data.error);}}),btn('设置目录','ghost',async()=>{const directory=await window.itnWindow?.pickDirectory?.();if(directory){await api('/api/personal/settings',{directory});await go('resources');}}));create.appendChild(menu);
  toolbar.append(toolbarText,search,kind,create);pageShell.appendChild(toolbar);
  const split=el('div','outcome-workspace'),listPanel=el('aside','outcome-list-panel'),listHead=el('div','outcome-list-head'),grid=el('div','resource-grid outcome-grid outcome-list'),reader=el('section','outcome-reader');reader.id='outcome-reader';reader.setAttribute('aria-label','个性资源阅读区');
  const status=el('span','outcome-count');status.setAttribute('role','status');listHead.append(el('strong',null,'资源列表'),status);listPanel.append(listHead,grid);
  const placeholder=el('div','outcome-placeholder');
  placeholder.append(el('div','outcome-placeholder-mark','◌'),el('h2',null,'从左侧选择一份资源'),el('p','muted','确认保存的副本会显示在这里，并保留对应的学习上下文。'));
  const placeholderActions=el('div','outcome-placeholder-actions');placeholderActions.append(btn('制作 PPT','sm',()=>openPresentationBrief()),btn('导入文件','ghost sm',async()=>{if(!window.itnWindow?.pickFile)return toast('请在桌面窗口选择文件');const file=await window.itnWindow.pickFile();if(file){const data=await window.itnWindow.readResourceFile(file);if(data.ok)offerPersonalSave(data);else toast(data.error);}}));placeholder.appendChild(placeholderActions);
  reader.appendChild(placeholder);split.append(listPanel,reader);pageShell.appendChild(split);view.appendChild(pageShell);
  const data=await api('/api/personal/list',{});if(generation!==state.navigationGeneration)return;let all=data.resources || [],timer,seq=0;
  status.title=data.directory;
  const paint=async()=>{
    const token=++seq,q=search.value.trim();state.outcomeQuery=search.value;state.outcomeKind=kind.value;
    let ids;
    if(q){const found=await api('/api/personal/search',{query:q});if(token!==seq||generation!==state.navigationGeneration)return;ids=new Set(found.hits.filter(h=>h.type==='resource').map(h=>h.id));}
    const rows=all.filter(r=>(!kind.value||r.kind===kind.value||r.learningKind===kind.value)&&(!ids||ids.has(r.id)));
    grid.replaceChildren();status.textContent=rows.length+' 份';status.title=data.directory;
    if(!rows.length)grid.appendChild(emptyState({inline:true,art:'layers',title:all.length?'没有匹配的资源':'还没有个性资源',text:all.length?'换个关键词或格式再试。':'生成或导入文件后，确认保存即可在这里查看。'}));
    rows.forEach(r=>grid.appendChild(personalResourceCard(r)));
    reader.classList.toggle('has-selection', !!workbench.open);
  };
  search.oninput=()=>{clearTimeout(timer);seq++;timer=setTimeout(()=>paint().catch(e=>toast(e.message)),220);};kind.onchange=()=>paint();await paint();
};
const originalResourcesPanel = PANELS.resources;
PANELS.resources = {
  title: '学习成果',
  async render(body) {
    const rows = (await api('/api/learning/resources', {})).resources || [];
    if (!rows.length) body.appendChild(panelEmpty('新资源会保留结构、版本与学习记录。历史文件在主区下方。'));
    for (const r of rows) body.appendChild(resourceCard(r, true));
  }
};

PAGES.memory = {
  async render() {
    const renderingGeneration = state.navigationGeneration;
    const view = $('view'); view.innerHTML = '';
    const context = await api('/api/learning/context', {kbId: state.kb || ''});
    if (renderingGeneration !== state.navigationGeneration) return;
    const overview = cardOf({title: '当前学习上下文', sub: '自述目标与偏好，和真实作答证据分别记录'});
    overview.appendChild(el('p', null, '目标：' + (context.profile?.goal || '尚未设置')));
    overview.appendChild(el('p', null, context.quizAttempts ? '资源测验首次作答 ' + context.quizAttempts + ' 题，答对 ' + context.quizCorrect + ' 题。' : '还没有资源测验作答证据，掌握度未知。'));
    overview.appendChild(el('p', 'muted sm', context.basis));
    for (const t of context.quizTopics || []) overview.appendChild(el('p', 'sm', t.topic + '：首次作答 ' + t.attempts + '，答对 ' + t.correct));
    overview.appendChild(btn('编辑学习档案', 'sm', () => go('settings', 'general'))); view.appendChild(overview);
    const auto = el('input'); auto.type='checkbox'; auto.checked=context.autoRemember!==false; auto.id='memory-auto';
    const autoLabel=el('label','quiz-choice');autoLabel.appendChild(auto);autoLabel.appendChild(el('span',null,'自动积累明确的学习偏好与目标'));
    auto.onchange=()=>runGuarded('memory:policy',auto,null,async()=>{const checked=auto.checked;try{await api('/api/learning/memory/policy',{autoRemember:checked});toast(checked?'已开启自动积累':'已关闭自动积累，仍可手动添加或明确要求记住');}catch(e){auto.checked=!checked;toast('设置失败：'+e.message);}});
    overview.appendChild(autoLabel);
    const form = cardOf({title: '记住一件事', sub: '仅存本机，可随时更改或删除'});
    const kind = el('select'); kind.id = 'memory-kind';
    for (const [value, label] of [['preference', '学习偏好'], ['goal', '学习目标'], ['status', '学习状态'], ['fact', '个人学习事实']]) {const option = el('option', null, label); option.value = value; kind.appendChild(option);}
    const text = el('textarea'); text.id = 'memory-text'; text.rows = 3;
    form.appendChild(fieldOf('类型', kind)); form.appendChild(fieldOf('内容', text));
    const scope = el('select'); scope.id = 'memory-scope';
    const global = el('option', null, '全部学习场景'); global.value = ''; scope.appendChild(global);
    for (const kb of state.cfg.knowledgeBases || []) {const option=el('option',null,kb.name);option.value=kb.id;scope.appendChild(option);}
    form.appendChild(fieldOf('适用范围', scope));
    let editId = '';
    form.appendChild(workbenchRequestButton('保存记忆', 'primary sm', 'memory:save', '正在保存…', async () => {
      try {await api('/api/learning/memory/save', {id: editId, kbId: scope.value, kind: kind.value, text: text.value.trim()}); toast('记忆已保存'); await go('memory');}
      catch(e) {toast('保存失败：' + e.message);}
    })); view.appendChild(form);
    const saved = cardOf({title: '已保存的记忆', sub: '自动记录附带用户原话与来源'});
    const memories = (await api('/api/learning/memories', {})).memories || [];
    if (renderingGeneration !== state.navigationGeneration) return;
    if (!memories.length) saved.appendChild(el('p', 'muted', '还没有保存的记忆。你也可以在对话中说“记住我的学习偏好……”。'));
    for (const m of memories) {
      const row=el('div','memory-entry');row.dataset.memory=m.id;
      row.appendChild(el('p',null,m.text));
      row.appendChild(el('p','muted sm',(m.origin==='agent'?'对话中记录':'本人编辑')+' · '+(kbName(m.kbId)||'全部学习场景')+' · '+fmtStamp(m.updatedAt)));
      if(m.quote)row.appendChild(el('blockquote','muted sm','原话：'+m.quote));
      const actions=el('div','row');
      actions.appendChild(btn('编辑','sm ghost',()=>{editId=m.id;kind.value=m.kind;text.value=m.text;scope.value=m.kbId||'';text.focus();form.scrollIntoView({block:'center'});}));
      actions.appendChild(workbenchRequestButton('忘记','sm ghost','memory:forget:'+m.id,'正在删除…',async()=>{try{await api('/api/learning/memory/forget',{id:m.id});await go('memory');toast('已忘记');}catch(e){toast('删除失败：'+e.message);}}));
      if(m.sessionId)actions.appendChild(btn('查看来源会话','sm ghost',()=>openChatSession(m.sessionId)));
      row.appendChild(actions);saved.appendChild(row);
    }
    view.appendChild(saved);
  }
};
const SETTINGS_GROUPS = [
  ['我的档案', ['general', 'memory']],
  ['模型与接口', ['models']],
  ['外观', ['appearance']],
  ['数据与备份', ['data']],
  ['高级与关于', ['agent', 'skills', 'about']],
];
PANELS.settings = {
  title: '设置',
  async render(body) {
    const search = inputOf('settings-search', '搜索设置', state.settingsQuery || ''); search.classList.add('panel-search'); search.setAttribute('aria-label', '搜索设置'); body.appendChild(search);
    const list = el('nav', 'settings-nav grouped-settings'); list.setAttribute('aria-label', '设置分区'); body.appendChild(list);
    const sections = SETTINGS_SECTIONS.concat([{id:'memory', label:'学习记忆', icon:'note'}]).map(x=>({...x,label:x.id==='general'?'学习档案':x.id==='kb'?'资料来源':x.label}));
    const active = current === 'memory' ? 'memory' : currentSection || 'general';
    const paint = () => {
      state.settingsQuery = search.value; list.innerHTML = ''; const query = search.value.trim().toLowerCase(); let matches = 0;
      for (const [title, ids] of SETTINGS_GROUPS) {
        const items = sections.filter(x => ids.includes(x.id) && (!query || (title + x.label + (x.title || '')).toLowerCase().includes(query)));
        if (!items.length) continue;
        const group = el('section', 'settings-group'); group.appendChild(el('h3', 'settings-group-label', title));
        for (const x of items) {
          const button = el('button', x.id === active ? 'active' : ''); button.type = 'button'; button.dataset.section = x.id;
          button.innerHTML = icon(x.icon) + '<span>' + esc(x.id === 'general' ? '学习档案' : x.id === 'kb' ? '资料来源' : x.label) + '</span>';
          if (x.id === active) button.setAttribute('aria-current', 'page');
          button.onclick = () => x.id === 'memory' ? go('memory') : go('settings', x.id);
          group.appendChild(button); matches++;
        }
        list.appendChild(group);
      }
      if (!matches) list.appendChild(el('p', 'panel-empty', '没有匹配的设置。'));
    };
    search.oninput = paint; paint();
  },
};
PANELS.memory = PANELS.settings;

// List and reader stay together; the existing document and learning actions remain live.
const libraryPageBeforeWorkspace = PAGES.kb.render;
async function revealLibrarySearchHit(hit) {
  const host = document.querySelector('.library-preview');
  if (!host || current !== 'kb') return;
  const card = cardOf({title:hit.docTitle || '资料原文',cls:'document-preview search-focus'});
  card.appendChild(el('p','muted sm',hit.headingPath || '正文'));
  const article = el('article','md'); article.innerHTML=md(hit.text || hit.caption || '此处没有可显示的原文。',{document:true,kbId:hit.kbId||state.kb,docPath:hit.docPath});
  card.appendChild(article);
  card.querySelector('.card-head').appendChild(btn('收起原文','ghost sm',()=>host.replaceChildren()));
  host.replaceChildren(card); hydrateKnowledgeImages(article); card.scrollIntoView({block:'nearest'});
}
PAGES.kb.render = async function() {
  const generation = state.navigationGeneration;
  await libraryPageBeforeWorkspace.call(this);
  if (generation !== state.navigationGeneration || current !== 'kb') return;
  const view = $('view'), documents = view.querySelector('.library-documents'), preview = view.querySelector('.library-preview');
  if (!documents || !preview) return;
  const toolbar = view.querySelector('.library-toolbar');
  toolbar.querySelector('h2')?.remove();
  const libraries = kbSelector(()=>go('kb')); libraries.setAttribute('aria-label', '当前资料库'); toolbar.prepend(libraries);
  const browser = el('div', 'document-browser'); browser.append(documents, preview); view.insertBefore(browser, view.querySelector('.harvest-entry'));
  preview.setAttribute('aria-label', '资料阅读区');
  const results = view.querySelector('.library-results'); documents.appendChild(results);
  // 返回按钮放在结果上方：长结果列表时它仍第一眼可见，而不是沉到卡片底部。
  documents.insertBefore(btn('返回文档列表', 'ghost sm search-reset', () => { results.innerHTML = ''; view.querySelector('[aria-label="搜索资料内容"]').value = ''; }), results);
  const first = documents.querySelector('.library-document[data-status="ready"] button:not([disabled])') || documents.querySelector('.library-document button:not([disabled])');
  if (first) { first.dataset.autoPreview='true'; first.click(); delete first.dataset.autoPreview; }
};

const knowledgeLibraryBeforeManagement=PAGES.kb.render;
PAGES.kb.render=async function(){
  const generation=state.navigationGeneration;
  await knowledgeLibraryBeforeManagement.call(this);if(generation!==state.navigationGeneration||current!=='kb')return;
  const view=$('view'),management=el('details','card kb-management');management.id='kb-management';
  management.appendChild(el('summary','item-title','添加与管理知识库'));
  const content=el('section','kb-management-content');content.appendChild(settingsKb());management.appendChild(content);
  const section=(currentSection==='harvest'||currentSection==='manage')?currentSection:'view';
  management.open=section==='manage';
  if(!hasKb())view.replaceChildren(management);else view.appendChild(management);
  const topbar=document.querySelector('.topbar');
  topbar?.querySelector('.kb-workspace-tabs')?.remove();
  const tabs=el('nav','workspace-tabs kb-workspace-tabs');tabs.setAttribute('aria-label','知识库功能区');
  for(const [key,label] of [['view','查看知识库'],['harvest','收集资料'],['manage','资料管理']]){
    const tab=btn(label,'workspace-tab'+(section===key?' active':''),()=>go('kb',key==='view'?'':key));
    tab.dataset.kbTab=key;if(section===key)tab.setAttribute('aria-current','page');tabs.appendChild(tab);
  }
  if(topbar)topbar.insertBefore(tabs,$('top-actions'));
  const browser=view.querySelector('.document-browser'),search=view.querySelector('.library-search'),toolbar=view.querySelector('.library-toolbar'),harvest=view.querySelector('.harvest-entry'),info=view.querySelector('.library-info');
  const showLibrary=section==='view';
  if(browser)browser.hidden=!showLibrary;if(search)search.hidden=!showLibrary;if(toolbar)toolbar.hidden=!showLibrary;if(info)info.hidden=true;
  if(harvest){harvest.hidden=section!=='harvest';if(section==='harvest')harvest.open=true;}
  management.hidden=hasKb()&&section!=='manage';
  if(toolbar)toolbar.appendChild(btn('管理知识库','ghost sm',()=>{management.open=true;management.scrollIntoView({block:'start'});}));
  if(section==='manage')management.scrollIntoView({block:'start'});
  if(section==='harvest'&&harvest)harvest.scrollIntoView({block:'start'});
};

/* A course is read one lecture section at a time; source material stays in citations. */
const studyJobs = new Map();
const studyQuizCache = new Map();
function openStudyCitation(source, index, origin) {
  if (window.LuminReferencePanel?.open) {
    window.LuminReferencePanel.open({kind: "citation", citation: source, label: String(index)});
    return;
  }
  document.querySelector('.study-citation')?.remove();
  const drawer=el('aside','study-citation'); drawer.setAttribute('aria-label','引用原文'); drawer.setAttribute('role','dialog');
  const head=el('div','row'); head.append(el('strong','grow','['+index+'] '+(source.docTitle || '资料原文')));
  const close=btn('关闭','ghost sm',()=>{drawer.remove();origin?.focus();}); head.appendChild(close);
  drawer.append(head,el('p','muted sm',source.headingPath || ''),el('p','muted sm path-line',source.docPath || ''));
  const body=el('article','md'); body.innerHTML=md(source.text || source.caption || '生成时未保存原文，请在资料库核对。'); drawer.appendChild(body);
  drawer.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();close.click();}};
  document.querySelector('.main').appendChild(drawer); close.focus();
}
function linkStudyCitations(article, citations) {
  const walker=document.createTreeWalker(article,NodeFilter.SHOW_TEXT),nodes=[];
  while(walker.nextNode()) if(!walker.currentNode.parentElement.closest('a,button,pre,code')) nodes.push(walker.currentNode);
  for(const node of nodes) {
    const text=node.textContent,re=/\[(\d+)\]/g;let match,last=0;const fragment=document.createDocumentFragment();let linked=false;
    while((match=re.exec(text))) {
      const index=Number(match[1]),source=citations.find((c,i)=>Number(c.index || i+1)===index);
      if(!source)continue;
      fragment.appendChild(document.createTextNode(text.slice(last,match.index)));
      const button=btn('['+index+']','citation-link',()=>openStudyCitation(source,index,button));button.setAttribute('aria-label','查看引用 '+index+' 原文');
      fragment.appendChild(button);last=match.index+match[0].length;linked=true;
    }
    if(linked){fragment.appendChild(document.createTextNode(text.slice(last)));node.replaceWith(fragment);}
  }
}
async function getStudyLecture(kb, chapter, progress, existingSid) {
  const key=kb+'\n'+chapter;
  if(studyJobs.has(key)) { const job=studyJobs.get(key);job.listeners.add(progress);progress(job.message);return job.promise.finally(()=>job.listeners.delete(progress)); }
  const job={listeners:new Set([progress]),message:'正在准备讲义…',sid:existingSid || ''};studyJobs.set(key,job);
  const notify=message=>{job.message=message;for(const listener of job.listeners)listener(message);};
  job.promise=(async()=>{
    if(!job.sid)job.sid=(await api('/api/sessions/new',{})).sessionId;
    let finished=false,lastId=0,polling=false;
    const poll=async()=>{
      if(polling)return;polling=true;
      try {
        const data=await api('/api/sessions/events',{sessionId:job.sid,sinceId:lastId});lastId=data.lastId || lastId;
        for(const event of data.events || []) {
          if(event.type==='resource/progress') {
            const p=event.payload || {};if(p.event==='step/start')notify(({retrieve:'正在查找本章资料…',plan:'正在组织章节与小节…',write_section:'正在编写讲义正文…',repair:'正在校对和修订讲义…'})[p.name] || '正在编写讲义…');
            else if(p.event==='validation')notify('正在核对内容与引用…');
          }
          if(event.type==='turn/end'){finished=true;if(event.payload?.ok===false)throw Error(event.payload.message || '生成未完成');}
        }
      } finally {polling=false;}
    };
    let pollError;
    const timer=setInterval(()=>poll().catch(e=>{pollError=e;}),400);
    try {
      notify('正在依据本章资料编写讲义…');
      if(existingSid){
        // A second visit attaches to the already running generation instead of starting another.
        while(!finished){await new Promise(r=>setTimeout(r,450));await poll();if(pollError)throw pollError;}
      } else {
        const result=await api('/api/study/lecture',{kbId:kb,chapter,sessionId:job.sid});
        if(result.busy){job.sid=result.sessionId;lastId=0;while(!finished){await new Promise(r=>setTimeout(r,450));await poll();}}
      }
      await poll(); if(pollError)throw pollError;
      notify('讲义已准备好，正在打开…');
    } finally {clearInterval(timer);studyJobs.delete(key);}
  })();
  return job.promise;
}
async function renderSectionQuiz(host, kb, chapter, section) {
  const key=kb+'\n'+section.id;
  host.replaceChildren(el('h3',null,'练一练'),el('p','muted sm','围绕这一节做 3 道题，作答会保存在学习记录中。'));
  const start=btn('出 3 道练习题','sm',async()=>{
    start.disabled=true;start.textContent='正在出题…';
    try {
      const data=await api('/api/study/quiz/generate',{kbId:kb,chapter,sectionId:section.id,count:3});
      const questions=data.questions || [];
      if(questions.length<3 || questions.length>5)throw Error('题量不符合要求，请重试');
      studyQuizCache.set(key,questions);paint(questions);
    } catch(e){start.disabled=false;start.textContent='重试出题';host.querySelector('.quiz-error')?.remove();host.appendChild(el('p','quiz-error muted',e.message));}
  });
  host.appendChild(start);
  function paint(questions) {
    start.remove();host.querySelector('.quiz-error')?.remove();
    for(const [i,q] of questions.entries()) {
      const box=el('div','quiz-q');box.appendChild(el('p','item-title',(i+1)+'. '+q.question));
      const feedback=el('p','quiz-explain');
      for(const [choice,option] of (q.options || []).entries()) {
        const button=btn(option,'choice',async()=>{
          if(box.dataset.saving || q.savedChoice!==undefined)return;box.dataset.saving='1';
          try {
            const correct=choice===q.answerIndex;
            await api('/api/study/quiz/submit',{kbId:kb,chapter,sectionId:section.id,question:q.question,myAnswer:option,reference:q.options[q.answerIndex],correct,options:q.options,answerIndex:q.answerIndex,explain:q.explain || '',source:q.source || ''});
            q.savedChoice=choice;box.querySelectorAll('button').forEach(b=>b.disabled=true);button.classList.add(correct?'right':'wrong');
            feedback.textContent=(correct?'答对了。':'参考答案：'+q.options[q.answerIndex]+'。')+' '+(q.explain || '');
          }catch(e){feedback.textContent='保存失败：'+e.message+'，可重新提交';}finally{delete box.dataset.saving;}
        });
        if(q.savedChoice!==undefined)button.disabled=true;box.appendChild(button);
      }
      if(q.savedChoice!==undefined)feedback.textContent=(q.savedChoice===q.answerIndex?'答对了。':'参考答案：'+q.options[q.answerIndex]+'。')+' '+(q.explain || '');
      box.appendChild(feedback);host.appendChild(box);
    }
  }
  if(studyQuizCache.has(key))paint(studyQuizCache.get(key));
}
PAGES.learn.render = async function() {
  const generation=state.navigationGeneration;
  await loadCfg();if(generation!==state.navigationGeneration)return;
  const kb=state.kb,view=$('view');view.replaceChildren();
  const workspace=el('div','study-workspace'),side=el('nav','study-side'),detail=el('section','study-detail');
  side.setAttribute('aria-label','章与节目录');detail.setAttribute('aria-label','讲义内容');workspace.append(side,detail);view.appendChild(workspace);
  const selector=kbSelector(()=>{state.studySection=null;go('learn');});selector.setAttribute('aria-label','学习资料范围');side.appendChild(selector);
  if(!hasKb() || !indexedKb()) {
    detail.appendChild(emptyState({art:'db',title:hasKb()?'先准备学习资料':'先添加学习资料',text:'准备好资料后，这里会把资料编成可以逐节学习的讲义。',actions:[btn('去资料库','primary',()=>go('kb'))]}));return;
  }
  let course,detailToken=0;
  const valid=()=>generation===state.navigationGeneration && current==='learn';
  async function loadCourse(){course=await api('/api/study/course',{kbId:kb});}
  await loadCourse();if(!valid())return;
  if(!(course.chapters || []).length){detail.appendChild(el('p','muted','还没有可学习的章节，请在资料库检查内容。'));return;}
  function selectDefault(){
    let c=course.chapters.find(c=>c.name===state.chapter) || course.chapters.find(c=>c.sourceChapter===state.chapter);
    if(!c)c=course.chapters.find(c=>c.doneCount<c.sectionCount) || course.chapters[0];
    state.chapter=c.name;
    const section=c.sections.find(s=>s.id===state.studySection) || c.sections.find(s=>!s.done) || c.sections[0];
    state.studySection=section?.id;return [c,section];
  }
  function paintSide(){
    side.querySelectorAll('.study-chapter-group,.study-side-label').forEach(n=>n.remove());
    side.appendChild(el('p','study-side-label',course.chapters.length+' 章 · 学完 '+course.doneCount+' / '+course.sectionCount+' 节'));
    for(const c of course.chapters) {
      const group=el('div','study-chapter-group');
      const head=btn('','study-chapter'+(c.name===state.chapter?' active':''),()=>{state.chapter=c.name;state.studySection=null;selectDefault();paintSide();paintDetail();});head.dataset.id=c.name;
      const main=el('span','study-chapter-main');
      if(c.title)main.appendChild(el('span','study-chapter-meta',c.sourceChapter));
      main.append(el('span','study-chapter-title',c.title || c.name),el('span','study-chapter-meta','本章 '+c.sectionCount+' 节，学完 '+c.doneCount+' 节'));head.appendChild(main);group.appendChild(head);
      for(const section of c.sections) {
        const button=btn('','study-section'+(section.id===state.studySection?' active':''),()=>{state.chapter=c.name;state.studySection=section.id;paintSide();paintDetail();});
        button.dataset.section=section.id;button.append(el('span','grow',section.title),el('span','section-status',section.done?'学完':'未学'));
        if(section.id===state.studySection)button.setAttribute('aria-current','page');group.appendChild(button);
      }
      side.appendChild(group);
    }
    const active=side.querySelector('.study-section.active');
    if(active)side.scrollTop+=active.getBoundingClientRect().top-side.getBoundingClientRect().top-90;
  }
  async function paintDetail(){
    const token=++detailToken,[chapter,section]=selectDefault();if(!section)return;
    view.scrollTop=0;
    const alive=()=>valid()&&token===detailToken;
    detail.replaceChildren();
    const heading=el('header','reader-heading');heading.append(el('p','muted sm',chapter.name),el('h2',null,section.title));detail.appendChild(heading);
    if(!section.markdown) {
      const status=el('div','study-generation');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      status.append(el('span','spinner'),el('p',null,'正在准备这一章的讲义…'));detail.appendChild(status);
      try {
        await getStudyLecture(kb,chapter.name,message=>{if(alive())status.querySelector('p').textContent=message;},chapter.generationSessionId);
        if(!alive())return;
        const title=section.title;await loadCourse();if(!alive())return;
        const updated=course.chapters.find(c=>c.sourceChapter===chapter.name) || course.chapters.find(c=>c.name===chapter.name);
        state.chapter=updated?.name || chapter.name;
        state.studySection=updated?.sections.find(s=>s.title===title)?.id || updated?.sections[0]?.id;
        paintSide();await paintDetail();
      }catch(e){if(alive()){status.replaceChildren(el('p',null,'讲义还没生成成功：'+e.message),btn('重新生成','primary sm',()=>paintDetail()),btn('检查模型','ghost sm',()=>go('models')));}}
      return;
    }
    const article=el('article','md lecture-article');article.innerHTML=md(section.markdown);linkStudyCitations(article,chapter.citations || []);detail.appendChild(article);
    const practice=el('section','section-practice');practice.setAttribute('aria-label','本节练习');detail.appendChild(practice);renderSectionQuiz(practice,kb,chapter.name,section);
    const complete=btn(section.done?'这节已学完':'学完这节','primary complete-section',async()=>{
      if(section.done)return;complete.disabled=true;
      try {
        course=await api('/api/study/section/complete',{kbId:kb,chapter:chapter.name,sectionId:section.id});
        if(!alive())return;section.done=true;complete.textContent='这节已学完';paintSide();
        const next=(course.chapters.find(c=>c.name===chapter.name)?.sections || []).find(s=>!s.done);
        if(next){const button=btn('下一节：'+next.title,'sm ghost',()=>{state.studySection=next.id;paintSide();paintDetail();});complete.after(button);}
      }catch(e){toast('保存失败：'+e.message);complete.disabled=false;}
    });complete.disabled=!!section.done;detail.appendChild(complete);
    const footer=el('footer','section-generation');footer.appendChild(el('span','muted sm','更多学习方式'));
    for(const [kind,label] of [['ppt','生成演示'],['practice','生成实操'],['quiz','生成练习册']]) {
      footer.appendChild(btn(label,'sm ghost',()=>promptLearning('请依据资料中的《'+chapter.name+'》，围绕「'+section.title+'」生成一份'+(RESOURCE_LABEL[kind] || label)+'。')));
    }
    detail.appendChild(footer);
  }
  selectDefault();paintSide();await paintDetail();
};

const growthPageBeforeWorkspace = PAGES.report.render;
PAGES.report.render = async function() {
  const generation=state.navigationGeneration;await growthPageBeforeWorkspace.call(this);if(generation!==state.navigationGeneration)return;
  const view=$('view'),calendar=[...view.children].find(n=>n.querySelector('h2')?.textContent==='学习日历');if(!calendar)return;
  const layout=el('div','growth-workspace'),aside=el('aside','growth-aside');
  const nudge=view.querySelector('.review-nudge');if(nudge)aside.appendChild(nudge);
  for(const details of [...view.querySelectorAll(':scope > .growth-details')])aside.appendChild(details);
  layout.append(calendar,aside);view.appendChild(layout);
};
const memoryPageBeforeWorkspace = PAGES.memory.render;
PAGES.memory.render = async function() {
  const generation=state.navigationGeneration;await memoryPageBeforeWorkspace.call(this);if(generation!==state.navigationGeneration)return;
  const view=$('view'),sections=[...view.children];if(sections.length<3)return;
  const [overview,form,saved]=sections,layout=el('div','memory-workspace');layout.append(saved,form);
  const explanation=el('details','memory-explanation');explanation.appendChild(el('summary',null,'学习记忆如何使用'));
  const auto=overview.querySelector('label');if(auto)view.prepend(auto);explanation.appendChild(overview);
  view.append(layout,explanation);overview.classList.add('memory-context');
};

const notesPageBeforeWorkspace = PAGES.notes.render;
PAGES.notes.render = async function() {
  const generation=state.navigationGeneration;
  await notesPageBeforeWorkspace.call(this);
  if(generation!==state.navigationGeneration || state.resTab==='network')return;
  const view=$('view'),card=[...view.querySelectorAll(':scope > .card')].find(n=>!n.classList.contains('res-tabs'));
  const source=card?.querySelector('.list');
  if(!source || !source.querySelector('.item[data-id]'))return;
  const browser=el('div','outcome-workspace object-browser'),list=el('nav','object-list'),reader=el('section','object-reader');
  list.setAttribute('aria-label',state.resTab==='wrong'?'错题列表':'笔记列表');reader.setAttribute('aria-label',state.resTab==='wrong'?'错题详情':'笔记正文');
  source.classList.add('object-source');source.hidden=true;browser.append(list,reader);card.appendChild(browser);
  const observer=new MutationObserver(()=>sync());
  function sync(){
    observer.disconnect();
    const items=[...source.querySelectorAll(':scope > .item[data-id]')];list.innerHTML='';
    if(!items.length){reader.replaceChildren(source.firstElementChild || el('p','muted','这个条件下没有记录。'));observer.observe(source,{childList:true});return;}
    const key=state.resTab==='wrong'?'selectedWrong':'selectedNote';
    const selected=items.find(n=>n.dataset.id===(state.objectFocus || state[key])) || items[0];state.objectFocus=null;
    function select(item){
      observer.disconnect();
      state[key]=item.dataset.id;reader.replaceChildren(item);
      list.querySelectorAll('button').forEach(b=>{const active=b.dataset.id===item.dataset.id;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
      observer.observe(source,{childList:true});
    }
    for(const item of items){
      const button=el('button','object-row');button.type='button';button.dataset.id=item.dataset.id;
      button.append(el('strong',null,item.querySelector('.item-title')?.textContent || '无标题'),el('span','muted sm',item.querySelector('.meta')?.textContent || '本机记录'));
      button.onclick=()=>select(item);list.appendChild(button);
    }
    select(selected);observer.observe(source,{childList:true});
  }
  sync();state.notesListObserver=observer;
};

boot();

/* Main-node knowledge network.
   视觉和交互参考 Obsidian Graph view 的克制关系图语言：小型节点、低对比连线、
   标签渐隐、力导向布局、悬停突出关联；不复制品牌外观，也不自动推断业务连线。
   网络图 / 时间线两种视图仍共用右侧检查器与编辑弹层。 */
const knowledgeNet={data:{nodes:[],links:[]},selected:'',hover:'',camera:{x:0,y:0,zoom:1},layout:new Map(),canvas:null,draw:null,fit:null,rebuild:null,projected:[],visible:null,showLinkLabels:true,linkLabels:[],view:'graph',range:0,timeline:null,timelineQuery:'',introMotionRequested:false,introMotionStart:0,introMotionUntil:0,userInteracted:false,alpha:0,reducedMotion:false,pan:null,dragNode:null};
const KNOWLEDGE_SWATCHES=['#8B7DA8','#5A8DEE','#2FB8A6','#E4B363','#E07A5F','#C77DFF','#7BC96F','#E5679B'];
function normalizeKnowledgeColor(v){const m=/^#?([0-9a-f]{6})$/i.exec(String(v||'').trim());return m?('#'+m[1].toUpperCase()):'';}
function knowledgeRgb(node){const c=normalizeKnowledgeColor(node?.color);if(!c)return null;const n=parseInt(c.slice(1),16);return[(n>>16)&255,(n>>8)&255,n&255];}
function knowledgePhase(id){let h=0;const s=String(id||'');for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return (h%1000)/1000*Math.PI*2;}
function knowledgeHash(value){let h=2166136261;const s=String(value||'');for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function knowledgeParseCssColor(value,fallback){
  const text=String(value||'').trim(),hex=/^#([0-9a-f]{6})$/i.exec(text);
  if(hex){const n=parseInt(hex[1],16);return[(n>>16)&255,(n>>8)&255,n&255];}
  const rgb=/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
  return rgb?[Number(rgb[1]),Number(rgb[2]),Number(rgb[3])]:fallback;
}
function knowledgeRgba(rgb,alpha){return 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+alpha+')';}
function knowledgeScaleRgb(rgb,scale){return rgb.map(v=>Math.max(0,Math.min(255,Math.round(v*scale))));}
function knowledgeMixRgb(a,b,t){return a.map((v,i)=>Math.round(v+(b[i]-v)*t));}
function knowledgeQuestion(q){const t=String(q||'');const i=t.indexOf('\n\n知识点背景');return i>0?t.slice(0,i):t;}
function knowledgeHM(at){const d=new Date(at);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function knowledgeDay(at){const d=new Date(at),t=new Date(),y=new Date(Date.now()-864e5);const same=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();if(same(d,t))return '今天';if(same(d,y))return '昨天';return (d.getMonth()+1)+' 月 '+d.getDate()+' 日';}
function knowledgeDialog(title,build,wide){
  const overlay=el('div','task-modal knowledge-dialog'),panel=el('section','task-modal-card'+(wide?' wide':''));panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label',title);panel.appendChild(el('h2',null,title));overlay.appendChild(panel);document.body.appendChild(overlay);
  let unbindEscape=()=>{};
  const close=()=>{unbindEscape();overlay.remove();};unbindEscape=bindModalEscape(overlay,close);overlay.onclick=e=>{if(e.target===overlay)close();};build(panel,close);return overlay;
}
async function openKnowledgeLinkSuggestions(button){
  return runGuarded('knowledge:suggest-links',button,'分析中…',async()=>{
  const generation=state.navigationGeneration;
  try{
    const data=await api('/api/knowledge/suggest-links',{});
    if(generation!==state.navigationGeneration)return;
    const nodes=new Map((data.nodes||[]).map(n=>[n.id,n.title]));
    knowledgeDialog('连线建议',(panel,close)=>{
      panel.appendChild(el('p','muted','模型只提出可解释的关系建议。勾选后才会写入知识网络，已有连线会被标出。'));
      const list=el('div','knowledge-link-suggestions');
      (data.suggestions||[]).forEach((s,index)=>{
        const row=el('label','knowledge-link-suggestion');
        const input=el('input');input.type='checkbox';input.value=String(index);input.disabled=!!s.exists;
        const body=el('span','knowledge-link-suggestion-body');
        body.append(el('strong',null,(nodes.get(s.from)||s.from)+' → '+(nodes.get(s.to)||s.to)),el('span','muted sm',s.label+' · '+(s.reason||'可建立关联')));
        row.append(input,body,el('span','knowledge-link-suggestion-status'+(s.exists?' exists':''),s.exists?'已存在连线':'可采纳'));
        list.appendChild(row);
      });
      if(!data.suggestions?.length)list.appendChild(el('p','muted','这次没有发现新的连线建议。'));
      panel.appendChild(list);
      const actions=el('div','row');
      const accept=btn('采纳选中项','primary',null);
      accept.onclick=()=>runGuarded('knowledge:accept-links',accept,'正在建立…',async()=>{
        const selected=[...list.querySelectorAll('input:checked')].map((input)=>data.suggestions[Number(input.value)]).filter(Boolean);
        if(!selected.length){toast('请先勾选至少一条建议');return;}
        try{
          for(const s of selected)await api('/api/knowledge/link',{from:s.from,to:s.to,label:s.label});
          close();await refreshKnowledgeNetwork();toast('已采纳 '+selected.length+' 条连线建议');
        }catch(e){toast('建立连线失败：'+e.message);}
      });
      actions.append(btn('关闭','ghost',close),accept);
      panel.appendChild(actions);
    },true);
  }catch(e){toast('生成连线建议失败：'+e.message);}
  });
}
async function refreshKnowledgeNetwork(){
  knowledgeNet.data=await api('/api/knowledge/graph',{});knowledgeNet.visible=null;
  if(current==='home'){knowledgeNet.rebuild?.();knowledgeNet.fit?.(true);knowledgeNet.draw?.();paintKnowledgePill();}
}
function knowledgeSwatchRow(picked,onPick){
  const row=el('div','knowledge-color-row'),swatches=[],mark=()=>swatches.forEach(b=>b.classList.toggle('active',b.dataset.color===picked()));
  for(const color of ['',...KNOWLEDGE_SWATCHES]){const swatch=btn('','knowledge-swatch'+(color?'':' default'));swatch.dataset.color=color;if(color)swatch.style.background=color;swatch.title=color||'默认颜色';swatch.setAttribute('aria-label',color?'节点颜色 '+color:'默认颜色');
    swatch.onclick=()=>{onPick(color);mark();};swatches.push(swatch);row.appendChild(swatch);}
  mark();return row;
}
function knowledgeQuickColor(node,anchor){
  const menu=popoverAt(anchor,(box)=>{
    box.appendChild(el('div','knowledge-pop-title','节点颜色'));
    const native=el('input');native.type='color';native.className='knowledge-pop-picker';native.value=normalizeKnowledgeColor(node.color)||'#6F877E';
    const save=(color)=>runGuarded('knowledge:save:'+node.id,null,null,async()=>{const controls=[...box.querySelectorAll('button,input')];controls.forEach(b=>b.disabled=true);box.setAttribute('aria-busy','true');try{await api('/api/knowledge/save',{id:node.id,title:node.title,definition:node.definition,aliases:node.aliases||[],color});closePopover();await refreshKnowledgeNetwork();await openKnowledgePoint(node.id);toast(color?'已换色 '+color:'已恢复默认色');}catch(e){toast(e.message);}finally{controls.forEach(b=>b.disabled=false);box.removeAttribute('aria-busy');}});
    const row=knowledgeSwatchRow(()=>normalizeKnowledgeColor(node.color),(color)=>{save(color);});
    box.appendChild(row);
    box.appendChild(fieldOf('调色盘',native));
    native.onchange=()=>save(native.value.toUpperCase());
  },{side:'panel',cls:'knowledge-pop'});
  return menu;
}
function editKnowledgePoint(node){
  knowledgeDialog(node?'编辑知识点':'添加知识点',(panel,close)=>{
    const title=inputOf('knowledge-title','概念名称',node?.title || ''),definition=el('textarea'),aliases=inputOf('knowledge-aliases','用顿号或逗号分隔',node?.aliases?.join('、') || '');definition.id='knowledge-definition';definition.rows=6;definition.value=node?.definition || '';
    let picked=normalizeKnowledgeColor(node?.color);
    const cols=el('div','knowledge-edit-cols'),left=el('div','knowledge-edit-col'),right=el('div','knowledge-edit-col');
    left.append(fieldOf('名称',title),fieldOf('简明定义',definition),fieldOf('确切别名',aliases));
    const orb=el('div','knowledge-preview-orb'),orbName=el('span',null,node?.title || '知识点'),preview=el('div','knowledge-preview');orb.appendChild(orbName);preview.appendChild(orb);
    const paintOrb=()=>{orb.style.background=picked||'#6F877E';orbName.textContent=title.value.trim()||'知识点';};
    const native=el('input');native.type='color';native.id='knowledge-color-picker';native.value=picked||'#6F877E';native.title='调色盘：选一个自定义颜色';native.setAttribute('aria-label','自定义节点颜色');
    const row=knowledgeSwatchRow(()=>picked,(color)=>{picked=color;native.value=color||'#6F877E';paintOrb();});
    right.append(fieldOf('节点颜色',row),preview,fieldOf('调色盘',native));
    native.oninput=()=>{picked=native.value.toUpperCase();row.querySelectorAll('.knowledge-swatch').forEach(b=>b.classList.toggle('active',b.dataset.color===picked));paintOrb();};
    title.oninput=paintOrb;paintOrb();
    cols.append(left,right);panel.appendChild(cols);
    const foot=el('div','knowledge-edit-foot');foot.appendChild(btn('取消','ghost',close));foot.appendChild(workbenchRequestButton('保存知识点','primary','knowledge:save:'+(node?.id||'new'),'正在保存…',async()=>{try{const saved=await api('/api/knowledge/save',{id:node?.id || '',title:title.value,definition:definition.value,color:picked,aliases:aliases.value.split(/[、,，]/).map(t=>t.trim()).filter(Boolean)});close();await refreshKnowledgeNetwork();await openKnowledgePoint(saved.id);}catch(e){toast(e.message);}}));
    panel.appendChild(foot);title.focus();
  },true);
}
function writeKnowledgeNote(node){
  knowledgeDialog('给「'+node.title+'」写笔记',(panel,close)=>{
    const text=el('textarea');text.id='knowledge-note';text.rows=8;text.placeholder='你的理解、例子、疑问或下一次要追问的内容';panel.appendChild(fieldOf('我的笔记',text));
    panel.append(workbenchRequestButton('保存笔记','primary','knowledge:note:'+node.id,'正在保存…',async()=>{try{await api('/api/knowledge/note',{id:node.id,text:text.value});close();await refreshKnowledgeNetwork();await openKnowledgePoint(node.id);}catch(e){toast(e.message);}}),btn('取消','ghost',close));text.focus();
  });
}
function linkKnowledgePoint(node){
  knowledgeDialog('手动连接知识点',(panel,close)=>{
    const other=el('select');other.id='knowledge-link-target';other.appendChild(option('','选择另一个知识点'));
    knowledgeNet.data.nodes.filter(n=>n.id!==node.id).forEach(n=>other.appendChild(option(n.id,n.title)));
    const label=inputOf('knowledge-link-label','例如：对比、应用、先学','关联');panel.append(fieldOf('从「'+node.title+'」连接到',other),fieldOf('关系说明',label));
    panel.append(workbenchRequestButton('添加连线','primary',()=> 'knowledge:link:'+node.id+':'+other.value,'正在连接…',async()=>{try{await api('/api/knowledge/link',{from:node.id,to:other.value,label:label.value});close();await refreshKnowledgeNetwork();await openKnowledgePoint(node.id);}catch(e){toast(e.message);}}),btn('取消','ghost',close));other.focus();
  });
}
async function askKnowledgePoint(node){
  const projects=(await api('/api/projects/list',{})).projects || [];
  knowledgeDialog('围绕「'+node.title+'」新建会话',(panel,close)=>{
    const source=el('select');source.id='knowledge-question-project';const seen=new Set();
    for(const record of node.records || []){
      const pid=record.projectId || '';if(seen.has(pid))continue;seen.add(pid);const project=projects.find(p=>p.id===pid);
      const opt=option(pid,pid?(project?.name || '已删除工作区：'+record.workspaceName):'普通对话');if(pid&&!project)opt.disabled=true;source.appendChild(opt);
    }
    if(!seen.has(''))source.appendChild(option('','普通对话'));
    for(const project of projects)if(!seen.has(project.id))source.appendChild(option(project.id,project.name+'（选择新的去向）'));
    const origin=node.records?.[0];source.value=origin?.projectId || '';
    const question=el('textarea');question.id='knowledge-question';question.rows=4;question.value='请进一步讲解「'+node.title+'」，结合一个具体例子。';
    panel.append(fieldOf('会话工作区',source),fieldOf('你想问什么',question));
    const info=el('p','muted sm');panel.appendChild(info);
    const start=btn('新建会话并提问','primary',async()=>{
      try{
        if(source.selectedOptions[0]?.disabled || !question.value.trim())return;
        const record=(node.records || []).find(r=>(r.projectId || '')===source.value);
        const context='\n\n知识点背景（历史记录，仅供参考）：'+node.definition+(record?'\n之前的问题：'+record.question+'\n当时的记录：'+record.note:'');
        close();await startAgentTask(question.value.trim()+context,source.value);
      }catch(e){toast(e.message);}
    });
    const validate=()=>{const deleted=!!source.selectedOptions[0]?.disabled;start.disabled=deleted;info.textContent=deleted?'原工作区已删除，请明确选择新的去向。':origin?.workspaceRoot?'来源记录中的目录：'+origin.workspaceRoot:'会建立一段新会话，原对话保持原样。';};source.onchange=validate;validate();panel.append(start,btn('取消','ghost',close));question.focus();
  });
}
function refitKnowledgeNetworkSoon(){
  const fit=()=>{knowledgeNet.fit?.(true);knowledgeNet.draw?.();};
  requestAnimationFrame(fit);setTimeout(fit,240);
}
async function openKnowledgePoint(id){
  if(current!=='home')await go('home');
  const generation=state.navigationGeneration,node=await api('/api/knowledge/node',{id});if(generation!==state.navigationGeneration||current!=='home')return;
  knowledgeNet.selected=id;const drawer=$('knowledge-detail');if(!drawer)return;
  const selectedLayout=knowledgeNet.layout.get(id);if(selectedLayout){selectedLayout.vx=0;selectedLayout.vy=0;}
  drawer.hidden=false;const workspace=$('knowledge-workspace');workspace?.classList.add('has-detail');drawer.replaceChildren();
  refitKnowledgeNetworkSoon();
  // 节点色作为抽屉的主题色：头部柔光、色点光环、主操作按钮都跟着它走
  drawer.style.setProperty('--k-aura',node.color || '#6F877E');
  const head=el('div','knowledge-detail-head'),dot=el('button','knowledge-color-dot'+(node.color?'':' hollow'));dot.type='button';dot.title=node.color?('节点颜色 '+node.color+'（点击换色）'):'未设颜色（点击换色）';dot.setAttribute('aria-label','换节点颜色');if(node.color)dot.style.background=node.color;dot.onclick=()=>knowledgeQuickColor(node,dot);
  const h2=el('h2',null,node.title);const closeBtn=btn('','ghost sm knowledge-close',()=>{drawer.hidden=true;$('knowledge-workspace')?.classList.remove('has-detail');knowledgeNet.selected='';refitKnowledgeNetworkSoon();});closeBtn.innerHTML=icon('close');closeBtn.title='收起';closeBtn.setAttribute('aria-label','收起');
  head.append(dot,h2,closeBtn);drawer.appendChild(head);
  const sub=el('div','knowledge-detail-sub');sub.appendChild(el('span',null,(node.userEdited?'含本人编辑':'AI 记录')+' · '+node.recordCount+' 次相关讨论'));
  for(const a of (node.aliases || []))sub.appendChild(el('span','knowledge-alias',a));drawer.appendChild(sub);
  const acts=el('div','knowledge-acts');
  acts.append(
    knowledgeAct('ask','提问','primary',()=>askKnowledgePoint(node)),
    knowledgeAct('note','写笔记','',()=>writeKnowledgeNote(node)),
    knowledgeAct('link','手动连线','',()=>linkKnowledgePoint(node)),
    knowledgeAct('edit','编辑','',()=>editKnowledgePoint(node)));
  drawer.appendChild(acts);
  const body=el('div','knowledge-detail-body');
  const defSec=el('section','knowledge-sec');defSec.appendChild(el('h3','knowledge-sec-title','概念'));defSec.appendChild(el('p','knowledge-definition',node.definition || '还没有定义，可以补充你的理解。'));body.appendChild(defSec);
  const recSec=el('section','knowledge-sec');recSec.appendChild(el('h3','knowledge-sec-title','对话中的记录'));
  if(!node.records?.length)recSec.appendChild(el('p','muted sm','这个知识点由你添加，还没有关联对话。'));
  for(const record of node.records || []){
    const item=el('article','knowledge-record');item.dataset.record=record.id;
    const rh=el('div','knowledge-record-head');if(record.color||true){const rd=el('span','knowledge-record-dot');rd.style.background=node.color||'#6F877E';rh.appendChild(rd);}
    rh.append(el('strong','grow',knowledgeQuestion(record.question)),el('span','muted sm',knowledgeHM(record.at)));item.appendChild(rh);
    item.appendChild(el('p',null,record.note));
    const rf=el('div','knowledge-record-foot');rf.append(el('span','muted sm',record.workspaceName || '普通对话'),el('span','muted grow',record.workspaceRoot || ''));
    rf.appendChild(btn('回到这次对话','ghost sm',()=>revealChatHit({sessionId:record.sessionId,turnId:record.turnId}).catch(e=>toast('无法打开来源：'+e.message))));item.appendChild(rf);recSec.appendChild(item);
  }
  body.appendChild(recSec);
  const noteSec=el('section','knowledge-sec');
  const noteHead=el('h3','knowledge-sec-title');noteHead.appendChild(document.createTextNode('我的笔记'));
  const pencil=btn('','ghost sm knowledge-note-add',()=>writeKnowledgeNote(node));pencil.innerHTML=icon('pencil');pencil.title='记一条笔记';pencil.setAttribute('aria-label','记笔记');noteHead.appendChild(pencil);noteSec.appendChild(noteHead);
  if(!node.notes?.length)noteSec.appendChild(el('p','muted sm','点铅笔写一条笔记；笔记也会进入全局搜索。'));
  for(const note of node.notes || []){const item=el('article','knowledge-record');item.append(el('p','muted sm',fmtStamp(note.at)),el('p',null,note.text),btn('打开笔记','ghost sm',()=>{state.resTab='notes';go('notes','',{focus:note.id});}));noteSec.appendChild(item);}
  body.appendChild(noteSec);
  const links=(knowledgeNet.data.links || []).filter(l=>l.from===id||l.to===id);
  if(links.length){
    const linkSec=el('section','knowledge-sec');linkSec.appendChild(el('h3','knowledge-sec-title','手动连接'));
    for(const link of links){const other=knowledgeNet.data.nodes.find(n=>n.id===(link.from===id?link.to:link.from)),row=el('div','row knowledge-link-row');row.append(btn((other?.title || '知识点')+' · '+link.label,'ghost sm grow',()=>openKnowledgePoint(other.id)),btn('移除','ghost sm',async()=>{await api('/api/knowledge/link',{from:link.from,to:link.to,remove:true});await refreshKnowledgeNetwork();await openKnowledgePoint(id);}));linkSec.appendChild(row);}
    body.appendChild(linkSec);
  }
  drawer.appendChild(body);
  drawer.appendChild(btn('删除知识点','ghost sm knowledge-delete',()=>confirmDialog('删除这个知识点？','将删除节点、关联的AI记录和连线；本人笔记会保留在笔记页。',async()=>{await api('/api/knowledge/delete',{id});drawer.hidden=true;$('knowledge-workspace')?.classList.remove('has-detail');knowledgeNet.selected='';await refreshKnowledgeNetwork();refitKnowledgeNetworkSoon();},{confirmLabel:'删除',busyLabel:'正在删除…',errorPrefix:'删除失败：'})));
  knowledgeNet.draw?.();paintKnowledgePill();
}
function knowledgeAct(act,label,cls,fn){
  const b=btn('','knowledge-act'+(cls?' '+cls:''),fn);b.dataset.act=act;b.type='button';
  const ic=el('span','knowledge-act-ic');ic.innerHTML=icon(act==='ask'?'chat':act==='note'?'pencil':act==='link'?'label':'gear');
  b.append(ic,el('span','knowledge-act-label',label));return b;
}
function paintKnowledgePill(){
  const pill=$('knowledge-count');if(!pill)return;
  const matched=knowledgeNet.visible?knowledgeNet.visible.length:0;
  const base=knowledgeNet.data.nodes.length+' 个知识点 · '+knowledgeNet.data.links.length+' 条手动连接';
  const hint=knowledgeNet.view==='graph'?' · 拖动空白处移动 · 滚轮缩放':'';
  pill.textContent=(knowledgeNet.visible?matched+' / '+base:base)+hint;
}
function installKnowledgeCanvas(canvas){
  const ctx=canvas.getContext('2d'),host=canvas.parentElement;knowledgeNet.canvas=canvas;

  const physicsTick=()=>{
    const nodes=[...knowledgeNet.layout.values()],alpha=knowledgeNet.alpha;
    if(alpha<.004)return;
    const n=nodes.length,repel=n>160?620:920;
    for(let i=0;i<n;i++){
      const a=nodes[i];
      for(let j=i+1;j<n;j++){
        const b=nodes[j];let dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy;
        if(d2<.01){dx=.1+((knowledgeHash(a.id+b.id)%17)/100);dy=.1;d2=dx*dx+dy*dy;}
        if(d2>260000)continue;
        const d=Math.sqrt(d2),force=repel/d2;
        const fx=dx/d*force,fy=dy/d*force;
        a.vx-=fx;a.vy-=fy;b.vx+=fx;b.vy+=fy;
      }
    }
    for(const link of knowledgeNet.data.links){
      const a=knowledgeNet.layout.get(link.from),b=knowledgeNet.layout.get(link.to);if(!a||!b)continue;
      const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,target=92+Math.min(26,(a.degree+b.degree)*2),force=(d-target)*.00125*alpha;
      const fx=dx/d*force,fy=dy/d*force;
      a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;
    }
    for(const node of nodes){
      node.vx-=node.x*.00075*alpha;node.vy-=node.y*.00075*alpha;
      if(node.id===knowledgeNet.selected||node.id===knowledgeNet.dragNode?.id){node.vx=0;node.vy=0;continue;}
      node.vx=Math.max(-6,Math.min(6,node.vx*.88));node.vy=Math.max(-6,Math.min(6,node.vy*.88));
      node.x=Math.max(-2200,Math.min(2200,node.x+node.vx));node.y=Math.max(-2200,Math.min(2200,node.y+node.vy));
    }
    knowledgeNet.alpha*=.975;
  };

  const rebuild=()=>{
    const old=knowledgeNet.layout instanceof Map?knowledgeNet.layout:new Map(),nodes=knowledgeNet.data.nodes;
    const degree=new Map(nodes.map(node=>[node.id,0]));
    for(const link of knowledgeNet.data.links){if(degree.has(link.from))degree.set(link.from,degree.get(link.from)+1);if(degree.has(link.to))degree.set(link.to,degree.get(link.to)+1);}
    const next=new Map();
    nodes.forEach((node,index)=>{
      let item=old.get(node.id);
      if(!item){
        const neighbours=knowledgeNet.data.links.flatMap(link=>{
          if(link.from===node.id&&old.has(link.to))return [old.get(link.to)];
          if(link.to===node.id&&old.has(link.from))return [old.get(link.from)];
          return [];
        });
        let x,y;
        if(neighbours.length){x=neighbours.reduce((sum,p)=>sum+p.x,0)/neighbours.length;y=neighbours.reduce((sum,p)=>sum+p.y,0)/neighbours.length;}
        else{const angle=index*2.399963229728653,radius=34*Math.sqrt(index+1);x=Math.cos(angle)*radius;y=Math.sin(angle)*radius;}
        const phase=knowledgePhase(node.id);x+=Math.cos(phase)*8;y+=Math.sin(phase)*8;
        item={id:node.id,x,y,vx:0,vy:0};
      }
      item.degree=degree.get(node.id)||0;
      item.radius=4.6+Math.min(7.5,Math.sqrt(item.degree)*2.45)+Math.min(2.8,Number(node.recordCount||0)*.32);
      if(node.id===knowledgeNet.selected){item.vx=0;item.vy=0;}
      next.set(node.id,item);
    });
    knowledgeNet.layout=next;knowledgeNet.alpha=1;
    const settleIterations=nodes.length>160?42:nodes.length>80?68:110;
    for(let i=0;i<settleIterations;i++)physicsTick();
    if(knowledgeNet.introMotionRequested){
      const now=performance.now();knowledgeNet.introMotionRequested=false;knowledgeNet.introMotionStart=now;knowledgeNet.introMotionUntil=now+1700;knowledgeNet.alpha=.72;
      for(const node of next.values()){const phase=knowledgePhase(node.id);node.vx+=Math.cos(phase)*.42;node.vy+=Math.sin(phase)*.42;}
    }
  };

  const fit=(force=false)=>{
    if(knowledgeNet.userInteracted&&!force)return;
    const nodes=[...knowledgeNet.layout.values()],w=host.clientWidth,h=host.clientHeight;
    if(!nodes.length||w<2||h<2)return;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const node of nodes){minX=Math.min(minX,node.x-node.radius);minY=Math.min(minY,node.y-node.radius);maxX=Math.max(maxX,node.x+node.radius);maxY=Math.max(maxY,node.y+node.radius);}
    const spanX=Math.max(80,maxX-minX),spanY=Math.max(80,maxY-minY),padX=Math.min(96,Math.max(48,w*.075)),padY=Math.min(84,Math.max(46,h*.08));
    const zoom=Math.max(.32,Math.min(1.55,(w-padX*2)/spanX,(h-padY*2)/spanY));
    knowledgeNet.camera.zoom=zoom;
    knowledgeNet.camera.x=-((minX+maxX)/2)*zoom;
    knowledgeNet.camera.y=-((minY+maxY)/2)*zoom;
  };

  const project=()=>{
    const nodes=knowledgeNet.visible||knowledgeNet.data.nodes,n=Math.max(1,nodes.length),w=host.clientWidth,h=host.clientHeight,now=performance.now(),zoom=knowledgeNet.camera.zoom;
    const idle=!knowledgeNet.reducedMotion&&(knowledgeNet.alpha<.9||now>knowledgeNet.introMotionStart+450);
    return nodes.flatMap(node=>{
      const item=knowledgeNet.layout.get(node.id);if(!item)return [];
      const phase=knowledgePhase(node.id),frozen=node.id===knowledgeNet.selected||node.id===knowledgeNet.dragNode?.id;
      const driftX=idle&&!frozen?Math.sin(now*.00023+phase)*2+Math.sin(now*.00009+phase*2.3)*.6:0;
      const driftY=idle&&!frozen?Math.cos(now*.0002+phase*1.7)*1.75+Math.cos(now*.000075+phase*3.1)*.5:0;
      return [{...node,x:w/2+knowledgeNet.camera.x+item.x*zoom+driftX,y:h/2+knowledgeNet.camera.y+item.y*zoom+driftY,r:Math.max(3.8,item.radius*Math.pow(zoom,.34)),degree:item.degree,labelAlpha:0,labelW:0,labelRect:null}];
    }).sort((a,b)=>a.y-b.y||a.x-b.x);
  };

  const draw=()=>{
    if(!canvas.isConnected)return;
    const w=host.clientWidth,h=host.clientHeight,dpr=Math.min(2,devicePixelRatio||1);
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const css=getComputedStyle(document.body),ink=knowledgeParseCssColor(css.getPropertyValue('--ink'),[35,57,51]),panel=knowledgeParseCssColor(css.getPropertyValue('--panel'),[255,255,255]),line=knowledgeParseCssColor(css.getPropertyValue('--line'),[214,222,218]),brand=knowledgeParseCssColor(css.getPropertyValue('--brand'),[64,111,93]);
    const points=project(),byId=new Map(points.map(point=>[point.id,point])),activeId=knowledgeNet.hover||knowledgeNet.selected,nodes=knowledgeNet.data.nodes.length,visibleSet=knowledgeNet.visible?new Set(knowledgeNet.visible.map(node=>node.id)):null;
    const neighbours=new Set();if(activeId){neighbours.add(activeId);for(const link of knowledgeNet.data.links){if(link.from===activeId)neighbours.add(link.to);if(link.to===activeId)neighbours.add(link.from);}}
    knowledgeNet.linkLabels=[];
    for(const link of knowledgeNet.data.links){
      const a=byId.get(link.from),b=byId.get(link.to);if(!a||!b)continue;
      const dx=b.x-a.x,dy=b.y-a.y,distance=Math.hypot(dx,dy)||1,bend=(knowledgeHash(link.from+':'+link.to)%2?1:-1)*(9+Math.min(34,distance*.075));
      const cx=(a.x+b.x)/2+(-dy/distance)*bend,cy=(a.y+b.y)/2+(dx/distance)*bend;
      const active=!!activeId&&(link.from===activeId||link.to===activeId),searchMuted=visibleSet&&!visibleSet.has(link.from)&&!visibleSet.has(link.to),focusMuted=!!activeId&&!active;
      const aColor=knowledgeRgb(a)||knowledgeRgb(b)||brand,bColor=knowledgeRgb(b)||aColor,edgeColor=knowledgeMixRgb(aColor,bColor,.45);
      ctx.save();ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo(cx,cy,b.x,b.y);
      const passiveEdge=knowledgeMixRgb(line,ink,.18);
      ctx.strokeStyle=knowledgeRgba(active?edgeColor:passiveEdge,searchMuted?.035:active?.78:focusMuted?.075:.24);
      ctx.lineWidth=active?1.9:.95;ctx.stroke();
      if(active){ctx.beginPath();ctx.arc((a.x+2*cx+b.x)/4,(a.y+2*cy+b.y)/4,1.65,0,Math.PI*2);ctx.fillStyle=knowledgeRgba(edgeColor,.9);ctx.fill();}
      ctx.restore();
      const labelAllowed=knowledgeNet.showLinkLabels&&!searchMuted&&(active||(knowledgeNet.camera.zoom>=1.24&&nodes<=60));
      if(labelAllowed){
        const text=String(link.label||'关联')||'关联',tx=(a.x+2*cx+b.x)/4,ty=(a.y+2*cy+b.y)/4-8;
        ctx.save();ctx.font='500 11px "Microsoft YaHei",sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
        const width=ctx.measureText(text).width;
        ctx.lineJoin='round';ctx.lineWidth=4;ctx.strokeStyle=knowledgeRgba(panel,.94);ctx.strokeText(text,tx,ty);
        ctx.fillStyle=active?knowledgeRgba(edgeColor,.96):knowledgeRgba(ink,.62);ctx.fillText(text,tx,ty);ctx.restore();
        knowledgeNet.linkLabels.push({text,from:link.from,to:link.to,x:Math.round(tx),y:Math.round(ty),active});
      }
    }
    const threshold=nodes<=24?.5:nodes<=60?.82:nodes<=120?1.06:1.3;
    const fade=Math.max(0,Math.min(1,(knowledgeNet.camera.zoom-threshold)/.22+.28));
    const importantDegree=Math.max(3,Math.ceil(Math.sqrt(Math.max(1,nodes))));
    for(const p of points){
      const selected=p.id===knowledgeNet.selected,hover=p.id===knowledgeNet.hover,searchHit=visibleSet?.has(p.id)||false;
      const dim=!!activeId&&!neighbours.has(p.id)||!!visibleSet&&!searchHit;
      const custom=knowledgeRgb(p),base=custom||brand,scale=selected?.8:hover?.9:1,color=knowledgeScaleRgb(base,scale),radius=p.r*(selected?1.38:hover?1.18:1);
      ctx.save();ctx.globalAlpha=dim?.14:1;
      if(selected){ctx.beginPath();ctx.arc(p.x,p.y,radius+5,0,Math.PI*2);ctx.strokeStyle=knowledgeRgba(color,.25);ctx.lineWidth=2;ctx.stroke();}
      ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.fillStyle=knowledgeRgba(color,selected?.98:hover?.96:.9);ctx.fill();
      ctx.strokeStyle=knowledgeRgba(panel,.82);ctx.lineWidth=1.25;ctx.stroke();
      if(selected||hover){ctx.beginPath();ctx.arc(p.x,p.y,radius+2.2,0,Math.PI*2);ctx.strokeStyle=knowledgeRgba(color,.68);ctx.lineWidth=1.2;ctx.stroke();}
      const labelAlpha=selected||hover||searchHit?1:dim?0:Math.max(fade,p.degree>=importantDegree?.72:0);
      if(labelAlpha>.04){
        let label=String(p.title||'知识点');ctx.font=(selected?'600 13px':'500 12px')+' "Microsoft YaHei",sans-serif';
        while(ctx.measureText(label).width>170&&label.length>3)label=label.slice(0,-2)+'…';
        const labelW=ctx.measureText(label).width,toLeft=p.x+radius+9+labelW>w-10,lx=toLeft?p.x-radius-9-labelW:p.x+radius+9,ly=p.y;
        ctx.globalAlpha=(dim?.1:1)*labelAlpha;ctx.textAlign='left';ctx.textBaseline='middle';ctx.lineJoin='round';ctx.lineWidth=4;
        ctx.strokeStyle=knowledgeRgba(panel,.92);ctx.strokeText(label,lx,ly);ctx.fillStyle=knowledgeRgba(ink,selected?.98:hover?.94:.78);ctx.fillText(label,lx,ly);
        p.labelW=labelW;p.labelAlpha=labelAlpha;p.labelRect={x:lx-3,y:ly-9,w:labelW+6,h:18};
      }
      ctx.restore();
    }
    knowledgeNet.projected=points.slice().sort((a,b)=>{
      const order=p=>(p.id===knowledgeNet.selected?2:p.id===knowledgeNet.hover?1:0);
      return order(a)-order(b)||a.y-b.y;
    });
  };

  const hit=e=>{
    const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
    const x=(e.clientX-rect.left)*canvas.clientWidth/rect.width,y=(e.clientY-rect.top)*canvas.clientHeight/rect.height;
    return [...knowledgeNet.projected].reverse().find(p=>{
      const r=Math.max(13,p.r+5);
      if((p.x-x)**2+(p.y-y)**2<r*r)return true;
      const label=p.labelRect;
      return !!label&&x>=label.x&&x<=label.x+label.w&&y>=label.y&&y<=label.y+label.h;
    });
  };

  canvas.onpointerdown=e=>{
    if(e.button!==0)return;
    knowledgeNet.userInteracted=true;knowledgeNet.introMotionUntil=0;
    const node=hit(e);canvas.setPointerCapture(e.pointerId);
    if(node){
      const item=knowledgeNet.layout.get(node.id);
      knowledgeNet.dragNode={id:node.id,startX:e.clientX,startY:e.clientY,x:item?.x||0,y:item?.y||0,moved:false};
      canvas.style.cursor='grabbing';
    }else{
      knowledgeNet.pan={x:e.clientX,y:e.clientY,cameraX:knowledgeNet.camera.x,cameraY:knowledgeNet.camera.y,moved:false};
      canvas.style.cursor='grabbing';
    }
  };
  canvas.onpointermove=e=>{
    if(knowledgeNet.dragNode){
      const drag=knowledgeNet.dragNode,dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;
      if(Math.hypot(dx,dy)>5){drag.moved=true;const item=knowledgeNet.layout.get(drag.id);if(item){item.x=drag.x+dx/knowledgeNet.camera.zoom;item.y=drag.y+dy/knowledgeNet.camera.zoom;item.vx=0;item.vy=0;}draw();}
      return;
    }
    if(knowledgeNet.pan){
      const pan=knowledgeNet.pan,dx=e.clientX-pan.x,dy=e.clientY-pan.y;
      if(Math.abs(dx)+Math.abs(dy)>3)pan.moved=true;
      knowledgeNet.camera.x=pan.cameraX+dx;knowledgeNet.camera.y=pan.cameraY+dy;draw();return;
    }
    const node=hit(e),next=node?.id||'';
    if(next!==knowledgeNet.hover){knowledgeNet.hover=next;canvas.style.cursor=next?'pointer':'grab';canvas.title=next?.title||'拖动空白处移动，滚轮缩放';draw();}
  };
  canvas.onpointerup=e=>{
    const drag=knowledgeNet.dragNode;
    knowledgeNet.dragNode=null;knowledgeNet.pan=null;canvas.style.cursor=hit(e)?'pointer':'grab';
    if(drag&&!drag.moved)openKnowledgePoint(drag.id).catch(err=>toast(err.message));
  };
  canvas.onpointercancel=()=>{knowledgeNet.dragNode=null;knowledgeNet.pan=null;canvas.style.cursor='grab';};
  canvas.onpointerleave=()=>{if(!knowledgeNet.dragNode&&!knowledgeNet.pan&&knowledgeNet.hover){knowledgeNet.hover='';canvas.style.cursor='grab';draw();}};
  canvas.oncontextmenu=e=>e.preventDefault();
  canvas.addEventListener('wheel',e=>{
    e.preventDefault();knowledgeNet.userInteracted=true;knowledgeNet.introMotionUntil=0;
    const rect=canvas.getBoundingClientRect(),sx=(e.clientX-rect.left)*canvas.clientWidth/rect.width,sy=(e.clientY-rect.top)*canvas.clientHeight/rect.height;
    const oldZoom=knowledgeNet.camera.zoom,newZoom=Math.max(.28,Math.min(2.8,oldZoom*Math.exp(-e.deltaY*.0012)));
    const worldX=(sx-host.clientWidth/2-knowledgeNet.camera.x)/oldZoom,worldY=(sy-host.clientHeight/2-knowledgeNet.camera.y)/oldZoom;
    knowledgeNet.camera.zoom=newZoom;knowledgeNet.camera.x=sx-host.clientWidth/2-worldX*newZoom;knowledgeNet.camera.y=sy-host.clientHeight/2-worldY*newZoom;draw();
  },{passive:false});
  canvas.ondblclick=e=>{if(!hit(e)){knowledgeNet.userInteracted=false;fit(true);draw();}};

  knowledgeNet.stop?.();state.knowledgeObserver?.disconnect();
  knowledgeNet.rebuild=rebuild;knowledgeNet.fit=fit;knowledgeNet.draw=draw;
  knowledgeNet.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
  rebuild();fit(true);draw();
  state.knowledgeObserver=new ResizeObserver(()=>{fit(false);draw();});state.knowledgeObserver.observe(host);
  if(!knowledgeNet.reducedMotion){
    let raf=0,last=performance.now(),physicsAccumulator=0;
    const frame=now=>{
      if(!canvas.isConnected)return;
      const elapsed=Math.min(50,now-last);last=now;physicsAccumulator+=elapsed;
      if(physicsAccumulator>=32){physicsTick();physicsAccumulator=0;}
      draw();raf=requestAnimationFrame(frame);
    };
    raf=requestAnimationFrame(frame);knowledgeNet.stop=()=>{if(raf)cancelAnimationFrame(raf);raf=0;};
  }
}
function renderKnowledgeGraphStage(stage){
  const scene=el('div','knowledge-scene'),canvas=el('canvas','knowledge-canvas');canvas.setAttribute('aria-hidden','true');scene.appendChild(canvas);
  if(!knowledgeNet.data.nodes.length){
    const empty=el('div','knowledge-empty');
    empty.append(el('div','knowledge-empty-orb'),el('h3',null,'从一次知识讨论开始'),el('p','muted','解释概念或讨论方法时，Lumin 会留下带来源的知识点；也可以自己添加。'));
    const acts=el('div','row');acts.append(btn('开始讨论','primary sm',()=>startAgentTask('请用一个具体例子解释输入与输出的约定。','')),btn('添加知识点','sm',()=>editKnowledgePoint()));
    empty.appendChild(acts);scene.appendChild(empty);
  }
  stage.appendChild(scene);installKnowledgeCanvas(canvas);
  knowledgeNet.draw?.();paintKnowledgePill();
}
async function loadKnowledgeTimeline(force){
  if(knowledgeNet.timeline&&!force)return knowledgeNet.timeline;
  const d=await api('/api/knowledge/timeline',{limit:300});knowledgeNet.timeline=d.items || [];return knowledgeNet.timeline;
}
function knowledgeTimelineItems(){
  const now=Date.now(),days=knowledgeNet.range;
  const cutoff=days>0?now-days*864e5:0;
  const q=String(knowledgeNet.timelineQuery||'').trim().toLowerCase();
  return (knowledgeNet.timeline || []).filter(it=>{
    const t=Date.parse(it.at || '');if(cutoff&&(!Number.isFinite(t)||t<cutoff))return false;
    if(!q)return true;
    const hay=((it.title || '')+'\n'+(it.question || '')+'\n'+(it.note || '')).toLowerCase();
    return hay.includes(q);
  }).sort((a,b)=>String(b.at || '').localeCompare(String(a.at || '')));
}
function renderKnowledgeTimelineStage(stage){
  const wrap=el('div','knowledge-timeline');stage.appendChild(wrap);
  const paint=()=>{
    wrap.replaceChildren();
    const items=knowledgeTimelineItems();
    if(!items.length){
      const empty=el('div','knowledge-empty timeline-empty');
      empty.append(el('div','knowledge-empty-orb'),el('h3',null,'时间线还是空的'),el('p','muted','去对话里问几个"为什么"，或者手动添加一个知识点。'));
      const acts=el('div','row');acts.append(btn('去对话','primary sm',()=>go('chat')),btn('添加知识点','sm',()=>editKnowledgePoint()));
      empty.appendChild(acts);wrap.appendChild(empty);return;
    }
    let lastDay='';
    for(const it of items){
      const day=knowledgeDay(it.at);if(day!==lastDay){lastDay=day;const h=el('div','knowledge-day');h.append(el('span','knowledge-day-title',day),el('span','knowledge-day-line'));wrap.appendChild(h);}
      const ev=el('div','knowledge-ev'+(it.type==='created'?' mini':''));
      const axis=el('div','knowledge-ev-axis'),dot=el('span','knowledge-ev-dot'+(it.type==='created'?' plain':''));if(it.color)dot.style.background=it.color;axis.append(dot,el('span','knowledge-ev-bar'));ev.appendChild(axis);
      const card=el('div','knowledge-ev-card');
      const hd=el('div','knowledge-ev-head');hd.append(el('strong','grow',it.title),el('span','muted sm',knowledgeHM(it.at)));card.appendChild(hd);
      if(it.type==='record'){
        card.appendChild(el('p','knowledge-ev-q',knowledgeQuestion(it.question)));
        if(it.note)card.appendChild(el('p','knowledge-ev-n',it.note));
        const ft=el('div','knowledge-ev-foot');
        if(it.workspaceName)ft.appendChild(el('span','knowledge-ev-chip',it.workspaceName));
        ft.appendChild(btn('回到这次对话','ghost sm',()=>revealChatHit({sessionId:it.sessionId,turnId:it.turnId}).catch(e=>toast('无法打开来源：'+e.message))));
        ft.appendChild(btn('在图里看','ghost sm',()=>showKnowledgeInGraph(it.nodeId)));
        card.appendChild(ft);
      }else{
        card.appendChild(el('p','knowledge-ev-n muted','手动添加了这个知识点（还没有对话记录）。'));
        const ft=el('div','knowledge-ev-foot');ft.appendChild(btn('在图里看','ghost sm',()=>showKnowledgeInGraph(it.nodeId)));card.appendChild(ft);
      }
      card.onclick=e=>{if(e.target.closest('button'))return;openKnowledgePoint(it.nodeId).catch(err=>toast(err.message));};
      ev.appendChild(card);wrap.appendChild(ev);
    }
  };
  wrap._paint=paint;paint();
  return paint;
}
function showKnowledgeInGraph(nodeId){
  knowledgeNet.pendingOpen=nodeId;
  setKnowledgeView('graph');
}
async function setKnowledgeView(view){
  const v=view==='timeline'?'timeline':'graph';
  knowledgeNet.view=v;state.knowledgeView=v;savePrefs({knowledgeView:v});
  await go('home');
  if(knowledgeNet.pendingOpen){const id=knowledgeNet.pendingOpen;knowledgeNet.pendingOpen='';openKnowledgePoint(id).catch(e=>toast(e.message));}
}
const homeBeforeKnowledgeNetwork=PAGES.home.render;
PAGES.home.render=async function(){
  const generation=state.navigationGeneration;await homeBeforeKnowledgeNetwork.call(this);if(generation!==state.navigationGeneration)return;
  if(knowledgeNet.introMotionRequested){
    state.knowledgeView='graph';knowledgeNet.introMotionRequested=false;knowledgeNet.userInteracted=false;knowledgeNet.hover='';
  }
  knowledgeNet.view=state.knowledgeView==='timeline'?'timeline':'graph';
  knowledgeNet.showLinkLabels=state.knowledgeLinkLabels!==false;knowledgeNet.linkLabels=[];
  knowledgeNet.data=await api('/api/knowledge/graph',{});if(generation!==state.navigationGeneration)return;knowledgeNet.visible=null;knowledgeNet.timelineQuery='';
  const page=el('section','card knowledge-network');page.id='knowledge-page';page.dataset.view=knowledgeNet.view;
  const toolbar=el('div','knowledge-toolbar');
  const seg=el('div','knowledge-view-seg');
  for(const [key,label] of [['graph','网络图'],['timeline','时间线']]){const b=btn(label,'knowledge-seg'+(knowledgeNet.view===key?' on':''),()=>{if(knowledgeNet.view!==key)setKnowledgeView(key);});b.dataset.view=key;seg.appendChild(b);}
  const search=inputOf('knowledge-search','搜索知识点、问题或笔记');search.setAttribute('aria-label','搜索知识网络');
  const range=el('select');range.id='knowledge-range';range.setAttribute('aria-label','时间范围');
  for(const [v,label] of [[0,'全部'],[7,'近 7 天'],[30,'近 30 天']])range.appendChild(option(String(v),label));
  range.value=String(knowledgeNet.range);
  toolbar.append(seg,search,range);
  const actions=el('div','knowledge-toolbar-actions');
  if(knowledgeNet.view==='graph'){
    const labelToggle=btn('','ghost sm knowledge-labels-toggle',()=>{const next=!knowledgeNet.showLinkLabels;knowledgeNet.showLinkLabels=next;state.knowledgeLinkLabels=next;savePrefs({knowledgeLinkLabels:next?'1':'0'});syncLabelToggle();knowledgeNet.draw?.();});
    const syncLabelToggle=()=>{const on=knowledgeNet.showLinkLabels;labelToggle.setAttribute('aria-pressed',on?'true':'false');const tip=on?'关系说明：按需显示，点击隐藏':'关系说明：已隐藏，点击显示';labelToggle.title=tip;labelToggle.setAttribute('aria-label',tip);};
    labelToggle.innerHTML=icon('label');syncLabelToggle();
    const reset=btn('','ghost sm knowledge-reset',()=>{knowledgeNet.userInteracted=false;knowledgeNet.fit?.(true);knowledgeNet.draw?.();});reset.innerHTML=icon('refresh');reset.title='适配画布';reset.setAttribute('aria-label','适配画布');
    actions.append(labelToggle,reset);
  }
  const suggestLinks=btn('连线建议','ghost sm',()=>openKnowledgeLinkSuggestions(suggestLinks));
  actions.appendChild(suggestLinks);
  actions.appendChild(btn('＋ 添加知识点','primary sm',()=>editKnowledgePoint()));
  toolbar.appendChild(actions);page.appendChild(toolbar);
  const workspace=el('div','knowledge-workspace');workspace.id='knowledge-workspace';
  const stage=el('div','knowledge-stage');
  const drawer=el('aside','knowledge-detail');drawer.id='knowledge-detail';drawer.hidden=true;drawer.setAttribute('aria-label','知识点记录');
  workspace.append(stage,drawer);page.appendChild(workspace);
  const foot=el('div','knowledge-network-foot');const count=el('span','knowledge-count-pill');count.id='knowledge-count';foot.appendChild(count);page.appendChild(foot);
  $('view').prepend(page);
  let repaintTimeline=null;
  if(knowledgeNet.view==='graph'){range.hidden=true;renderKnowledgeGraphStage(stage);}
  else{
    await loadKnowledgeTimeline(true);if(generation!==state.navigationGeneration)return;
    repaintTimeline=renderKnowledgeTimelineStage(stage);
  }
  range.onchange=()=>{knowledgeNet.range=Number(range.value)||0;repaintTimeline?.();};
  let timer,sequence=0;
  search.oninput=()=>{clearTimeout(timer);const mine=++sequence;timer=setTimeout(async()=>{try{
    const q=search.value.trim();
    if(knowledgeNet.view==='timeline'){knowledgeNet.timelineQuery=q;repaintTimeline?.();return;}
    if(!q)knowledgeNet.visible=null;else{const hits=(await api('/api/personal/search',{query:q,limit:50})).hits || [];if(mine!==sequence||generation!==state.navigationGeneration)return;const ids=new Set(hits.filter(h=>h.type==='knowledge').map(h=>h.id));knowledgeNet.visible=knowledgeNet.data.nodes.filter(n=>ids.has(n.id));}
    knowledgeNet.draw?.();paintKnowledgePill();
  }catch(e){toast(e.message);}},220);};
  if(knowledgeNet.pendingOpen){const id=knowledgeNet.pendingOpen;knowledgeNet.pendingOpen='';openKnowledgePoint(id).catch(e=>toast(e.message));}
};
