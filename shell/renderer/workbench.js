/* Personal learning workspace. Data and task truth come from the Cangjie API. */
const RESOURCE_LABEL = {lecture: '定制讲义', practice: '实操指南', quiz: '分阶测试', ppt: '在线演示', legacy:'历史资料'};
const TASK_LABEL = {running: '正在执行', cancelling: '正在停止', completed: '已完成', failed: '未完成', cancelled: '已取消', interrupted: '上次任务已中断'};
const workbench = {selected: null, open: false, loadToken: 0, seenSaved: new Set(), task: null};

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
  if (['learn', 'report', 'calibrate'].includes(page)) return 'home';
  if (['notes', 'wrong'].includes(page)) return 'resources';
  if (['memory', 'models'].includes(page)) return 'settings';
  return page;
}
Object.assign(PAGE_META, {
  chat: {title: '对话', sub: '围绕你的资料和目标开展任务'},
  home: {title: '学习', sub: '接着学，练一练，看看进步'},
  learn: {title: '学习', sub: '按节学讲义，练习并留下进度'},
  report: {title: '学习', sub: '阅读记录、练习表现与能力自评'},
  resources: {title: '学习成果', sub: '讲义、练习、笔记与错题，都在这里'},
  notes: {title: '学习成果', sub: '讲义、练习、笔记与错题，都在这里'},
  kb: {title: '知识库', sub: '找到资料、读原文，再开始学习'},
  memory: {title: '学习记忆', sub: '查看、修改或删除 Lumin 记住的内容'},
});
function decorateWorkspace() {
  const view = $('view');
  document.querySelector('.topbar .workspace-tabs')?.remove();
  const learning = ['home', 'learn', 'report', 'calibrate'].includes(current);
  const outcomes = ['resources', 'notes', 'wrong'].includes(current);
  if (!learning && !outcomes) return;
  const nav = el('nav', 'workspace-tabs' + (learning ? ' center-links' : ''));
  nav.setAttribute('aria-label', learning ? '学习功能' : '学习成果分类');
  const selected = learning ? (current === 'calibrate' ? 'report' : current)
    : current === 'resources' ? (currentSection === 'files' ? 'files' : 'generated') : (state.resTab || 'notes');
  const tabs = learning ? [['home', '总览'], ['learn', '学 · 练'], ['report', '我的成长']]
    : [['generated', '个性资源'], ['notes', '笔记'], ['wrong', '错题'], ['files', '本地文件'], ['network', '收集资料']];
  for (const [key, label] of tabs) {
    const button = btn(label, 'workspace-tab' + (key === selected ? ' active' : ''), () => {
      if (learning) go(key);
      else if (key === 'generated' || key === 'files') go('resources', key === 'files' ? 'files' : '');
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
for (const name of ['generate_learning_resource', 'revise_learning_resource', 'read_learning_resource', 'get_learning_context', 'remember_learning_fact', 'forget_learning_fact']) TOOL_GROUP[name] = '学习资源';
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
  let dock = $('resource-dock');
  if (!dock) {
    dock = el('aside', 'resource-dock');
    dock.id = 'resource-dock';
    dock.setAttribute('aria-label', '学习成果预览');
    document.querySelector('.app').appendChild(dock);
    // 成果面板的宽度也要能拖：面板是动态创建的，拖动条得在这时候挂
    if (typeof installSplitters === 'function') installSplitters();
  }
  const reader = current === 'resources' ? $('outcome-reader') : null;
  const embedded = !!reader;
  if (embedded && dock.parentElement !== reader) reader.appendChild(dock);
  if (!embedded && dock.parentElement !== document.querySelector('.app')) document.querySelector('.app').appendChild(dock);
  dock.classList.toggle('embedded-resource', embedded);
  dock.hidden = !workbench.open || (!embedded && current !== 'chat');
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
  workbench.open = false;
  ensureResourceDock();
  (current === 'resources' ? document.querySelector('.outcome-grid .resource-entry.selected') : $('wb-artifacts'))?.focus();
}

async function openLearningResource(id, version) {
  try {
    const token = ++workbench.loadToken;
    const resource = await api('/api/learning/resource', {id, version: version || 0});
    if (token !== workbench.loadToken) return;
    if (current !== 'chat' && !(current === 'resources' && $('outcome-reader'))) await go('chat');
    workbench.file=null;workbench.selected = resource;
    workbench.open = true;
    renderResourceDock();
    document.querySelectorAll('.outcome-grid .resource-entry').forEach(node => {
      const selected = node.dataset.resource === resource.id;
      node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected));
    });
  } catch (e) { toast('读取资源失败：' + e.message); }
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
  dialog.append(el('h2',null,'这份 PPT 要讲给谁？'),el('p','muted','Lumin会根据确认的需求重新设计页面，制作可编辑的PowerPoint文件。'));
  const audience=inputOf('ppt-audience','例如：初学者、项目评审','初学者'),purpose=inputOf('ppt-purpose','例如：课堂讲解、项目汇报','清楚讲解核心概念与应用'),pages=inputOf('ppt-pages','页数','8'),style=inputOf('ppt-style','配色、版式或参考风格','简洁，墨绿与暖金，图文结合');
  pages.type='number';pages.min='1';pages.max='60';
  dialog.append(fieldOf('受众',audience),fieldOf('用途',purpose),fieldOf('页数',pages),fieldOf('风格',style));
  const source=res?.id?'请先读取学习资源 '+res.id+' 的第'+res.version+'版，依据其内容重新设计。':'请依据当前主题与资料设计。';
  const submit=async waive=>{
    if(!waive&&(!audience.value.trim()||!purpose.value.trim()||!style.value.trim()||Number(pages.value)<1||Number(pages.value)>60)){toast('请填写完整需求，页数1至60');return;}
    const details=waive?'无需确认PPT细节，受众、页数和风格由你决定，直接制作。':'已确认PPT细节：受众='+audience.value+'；用途='+purpose.value+'；页数='+pages.value+'；风格='+style.value+'。';
    overlay.remove();try{await startAgentTask(details+source+'请使用create_presentation逐页设计并制作真实.pptx文件，包括合适的版式与讲者备注。先提供候选产物让我看，不要自动存入个性资源。');}catch(e){toast(e.message);}
  };
  const actions=el('div','row');actions.append(btn('按这些要求制作','primary',()=>submit(false)),btn('无需确认，直接制作','ghost',()=>submit(true)),btn('取消','ghost',()=>overlay.remove()));dialog.appendChild(actions);overlay.appendChild(dialog);document.body.appendChild(overlay);audience.focus();
  overlay.onkeydown=e=>{if(e.key==='Escape')overlay.remove();};overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
}
const PERSONAL_FORMAT={pptx:'PowerPoint',ppt:'PowerPoint',md:'Markdown',markdown:'Markdown',html:'网页',htm:'网页',docx:'Word',pdf:'PDF',png:'图片',jpg:'图片',jpeg:'图片',svg:'SVG',txt:'文本'};
async function offerPersonalSave(file) {
  document.querySelector('.personal-save-confirm')?.remove();
  const settings=await api('/api/personal/settings',{}),overlay=el('div','task-modal personal-save-confirm'),dialog=el('section','task-modal-card');
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','确认存入个性资源');
  dialog.append(el('h2',null,'满意这版，再存入个性资源'),el('p','muted','确认后会创建这一版的独立副本；后续修改候选稿不会覆盖它。'));
  const title=inputOf('personal-save-title','资源名称',file.title || file.name || '个性资源');dialog.appendChild(fieldOf('资源名称',title));
  dialog.append(el('p','path-line muted sm','来源：'+file.path),el('p','path-line muted sm','副本存放：'+settings.directory));
  const actions=el('div','row'),confirm=btn('确认存入','primary',async()=>{
    confirm.disabled=true;
    try{
      const saved=await api('/api/personal/save',{path:file.path,title:title.value.trim() || file.name,text:file.indexText || file.text || '',learningId:file.learningId || '',learningVersion:file.learningVersion || 0,sessionId:file.sessionId || state.chatSessionId || '',turnId:file.turnId || '',confirmed:true});
      overlay.remove();toast('已存入个性资源 · 确认版本 '+saved.version);if(current==='resources')await go('resources');
    }catch(e){toast('保存失败：'+e.message);confirm.disabled=false;}
  });
  actions.append(confirm,btn('这版先不存','ghost',()=>overlay.remove()));dialog.appendChild(actions);overlay.appendChild(dialog);document.body.appendChild(overlay);title.focus();
  overlay.onkeydown=e=>{if(e.key==='Escape')overlay.remove();};overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
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
  button.append(el('span','resource-entry-type',(RESOURCE_LABEL[item.learningKind] || PERSONAL_FORMAT[item.kind] || item.kind.toUpperCase())+' · 确认版本 '+item.version),el('strong',null,item.title),el('span','muted sm',fmtStamp(item.createdAt)),el('span','resource-entry-open','打开预览'));
  return button;
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
  const token=++workbench.loadToken,data=await window.itnWindow.readResourceFile(file);if(token!==workbench.loadToken)return;
  if(!data.ok){workbench.file={kind:'file',path:file,name:String(file).replace(/\\/g,'/').split('/').pop(),error:data.error,...metadata};workbench.selected=null;workbench.open=true;renderResourceDock();return;}
  workbench.file={...data,...metadata,path:data.path};workbench.selected=null;workbench.open=true;renderResourceDock();
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
    body.appendChild(el('p','muted sm','文字预览；完整排版可用PowerPoint打开。'));
    for(const slide of file.slides || []){const section=el('article','deck-text-slide');section.append(el('span','muted sm','第'+slide.index+'页'),el('pre',null,slide.text || '此页没有可提取文字'));body.appendChild(section);}
  }else{const article=el('article',file.kind==='markdown'?'md':'plain-document');if(file.kind==='markdown')article.innerHTML=md(file.text || '');else article.textContent=file.text || file.error || '';body.appendChild(article);}
}

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
  actions.appendChild(btn('让 Lumin 修改', 'sm', () => {
    promptLearning('请先读取学习资源 ' + res.id + ' 的最新版本，再按以下要求修改并保存新版本：');
  }));
  actions.appendChild(copyButton(() => res.markdown || '', '复制 Markdown'));
  /* 学习成果是 Markdown，但要交给别人 / 自己接着改的时候，得有 Office 文件。
     导出在壳里做（离线、零依赖，见 shell/deck-export.js），这里只负责给入口与结果提示。 */
  if (window.itnWindow && typeof window.itnWindow.exportResource === 'function') {
    actions.appendChild(btn('让 Lumin 制作 PPTX', 'sm ghost', () => exportResourceAs(res, 'pptx')));
    actions.appendChild(btn('导出 docx', 'sm ghost', () => exportResourceAs(res, 'docx')));
  }
  if (res.kind === 'ppt') actions.appendChild(btn('开始演示', 'primary sm', () => openResourcePresentation(res)));
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
  actions.appendChild(btn('存入个性资源','sm',()=>offerPersonalSave({path:res.artifactPath,title:res.title,text:res.markdown,learningId:res.id,learningVersion:res.version,sessionId:res.sessionId,turnId:res.turnId})));
  body.appendChild(actions);
  if ((res.warnings || []).length) body.appendChild(el('p', 'resource-notice', res.warnings.join('；')));
  const content = el('div', 'resource-content');
  if (res.kind === 'quiz') renderResourceQuiz(content, res);
  else if (res.kind === 'practice') renderResourcePractice(content, res);
  else {
    const article = el('article', 'md'); article.innerHTML = md(res.markdown || '');
    if (article.querySelector('h1')?.textContent === res.title) article.querySelector('h1').remove();
    content.appendChild(article);
  }
  body.appendChild(content);
  if (res.kind !== 'quiz') {
    const done = btn(res.progress?.done ? '已标记完成 · 撤销' : '标记本次学习完成', 'sm ghost', async () => {
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
    source.appendChild(el('p', 'muted sm', (c.docPath || '') + ' · 生成时的资料切片'));
    const article = el('article', 'md'); article.innerHTML = md(c.text || '此历史资源没有保存切片快照，请回到知识库核实原文。');
    source.appendChild(article); provenance.appendChild(source);
  }
  if (!(res.citations || []).length) provenance.appendChild(el('p', 'muted sm', '这份资源没有本地资料依据，请结合原文核实。'));
  provenance.appendChild(el('p', 'muted sm', '画像快照保留生成时的目标、偏好和作答依据，不会随后续档案编辑而改变。'));
  if (res.sessionId) provenance.appendChild(btn('回到生成会话', 'ghost sm', () => openChatSession(res.sessionId)));
  body.appendChild(provenance);
}

async function openResourcePresentation(res) {
  playerState.resourceForPpt=res;
  const slides = res.content?.slides || [];
  if (!slides.length) {toast('这份资源没有演示页面'); return;}
  playerState.slides = slides.map(s => ({title: s.title || '', body: (s.bullets || []).map(t => '- ' + t).join('\n') + (s.speakerNote ? '\n\n> 讲稿：' + s.speakerNote : '')}));
  playerState.name = res.title;
  playerState.key = 'resource:' + res.id + ':v' + res.version;
  playerState.tocOpen = false;
  let resume = 0;
  try {resume = Number((await api('/api/artifacts/progress', {name: playerState.key})).page || 0);} catch(e) { /* First play has no progress. */ }
  playerState.index = Math.max(0, Math.min(slides.length - 1, resume - 1));
  $('player').hidden = false; document.body.classList.add('player-open'); applyPlayerFont(); renderPlayer();
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
  const sid = state.chatSessionId;
  if (!sid || current !== 'chat') return;
  try {
    const task = await api('/api/sessions/state', {sessionId: sid});
    if (state.chatSessionId !== sid) return;
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
    if (current==='chat' && state.chatRequest && e.turnId === state.chatRequest.turnId) openLearningResource(e.payload.id, e.payload.version);
  }
}

const originalResources = PAGES.resources.render;
PAGES.resources.render = async function() {
  const generation=state.navigationGeneration,view=$('view');view.replaceChildren();
  if(currentSection==='files') {
    const toolbar=el('div','outcome-toolbar');
    const open=async kind=>{
      const api=window.itnWindow;if(!api){toast('请在桌面窗口选择文件');return;}
      const file=kind==='deck'?await api.pickDeck():kind==='doc'?await api.pickDoc():await api.pickFile();if(file)await openFilePreview(file);
    };
    toolbar.append(btn('打开本地文件…','primary',()=>open('any')),btn('打开演示文稿…','',()=>open('deck')),btn('打开文档…','',()=>open('doc')));view.appendChild(toolbar);
    view.appendChild(el('p','muted','本地文件先预览；满意后可选择存入个性资源。'));
    const reader=el('section','local-file-reader');reader.id='outcome-reader';reader.appendChild(el('p','muted','选择要预览的网页、演示文稿、文档、PDF或图片。'));view.appendChild(reader);return;
  }
  const toolbar=el('div','outcome-toolbar'),search=inputOf('learning-resource-search','搜索个性资源标题或正文',state.outcomeQuery || ''),kind=el('select');
  search.setAttribute('aria-label','搜索个性资源');kind.setAttribute('aria-label','筛选成果类型');kind.appendChild(option('','全部格式'));
  for(const [value,label] of [['pptx','PowerPoint'],['html','网页'],['md','Markdown / 讲义'],['quiz','测验'],['docx','Word'],['pdf','PDF'],['png','图片']])kind.appendChild(option(value,label));kind.value=state.outcomeKind || '';
  const create=el('details','outcome-create');create.appendChild(el('summary','btn primary','+ 添加资源'));
  const menu=el('div','outcome-menu');menu.append(btn('让 Lumin 制作 PPTX','ghost',()=>openPresentationBrief()),btn('打开文件并确认存入','ghost',async()=>{if(!window.itnWindow?.pickFile)return toast('请在桌面窗口选择文件');const file=await window.itnWindow.pickFile();if(file){const data=await window.itnWindow.readResourceFile(file);if(data.ok)offerPersonalSave(data);else toast(data.error);}}),btn('设置存放目录','ghost',async()=>{const directory=await window.itnWindow?.pickDirectory?.();if(directory){await api('/api/personal/settings',{directory});await go('resources');}}));create.appendChild(menu);
  toolbar.append(search,kind,create);view.appendChild(toolbar);
  const status=el('p','muted sm');status.setAttribute('role','status');view.appendChild(status);
  const split=el('div','outcome-workspace'),grid=el('div','resource-grid outcome-grid outcome-list'),reader=el('section','outcome-reader');reader.id='outcome-reader';reader.setAttribute('aria-label','个性资源阅读区');
  reader.append(el('h2',null,'选择一份个性资源'),el('p','muted','只有确认后存入目录的副本会出现在这里。'));split.append(grid,reader);view.appendChild(split);
  const data=await api('/api/personal/list',{});if(generation!==state.navigationGeneration)return;let all=data.resources || [],timer,seq=0;
  status.title=data.directory;
  const paint=async()=>{
    const token=++seq,q=search.value.trim();state.outcomeQuery=search.value;state.outcomeKind=kind.value;
    let ids;
    if(q){const found=await api('/api/personal/search',{query:q});if(token!==seq||generation!==state.navigationGeneration)return;ids=new Set(found.hits.filter(h=>h.type==='resource').map(h=>h.id));}
    const rows=all.filter(r=>(!kind.value||r.kind===kind.value||r.learningKind===kind.value)&&(!ids||ids.has(r.id)));
    grid.replaceChildren();status.textContent=rows.length+' 份个性资源 · '+data.directory;
    if(!rows.length)grid.appendChild(emptyState({inline:true,art:'layers',title:all.length?'没有匹配的资源':'先看看候选稿，满意再存入',text:'生成或打开文件后，在预览区选择“存入个性资源”。未确认的版本会留在会话中。'}));
    rows.forEach(r=>grid.appendChild(personalResourceCard(r)));
  };
  search.oninput=()=>{clearTimeout(timer);seq++;timer=setTimeout(()=>paint().catch(e=>toast(e.message)),220);};kind.onchange=()=>paint();await paint();
};
async function openLocalOutcome(kind) {
  const a = window.itnWindow;
  if (!a) { toast('只在桌面应用窗口里可用'); return; }
  const file = kind === 'deck' ? await a.pickDeck?.() : await a.pickDoc?.();
  if (!file) return;
  const name = String(file).replace(/\\/g, '/').split('/').pop();
  openSlidePlayer(name, undefined, undefined, file);
}
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
    auto.onchange=async()=>{try{await api('/api/learning/memory/policy',{autoRemember:auto.checked});toast(auto.checked?'已开启自动积累':'已关闭自动积累，仍可手动添加或明确要求记住');}catch(e){auto.checked=!auto.checked;toast('设置失败：'+e.message);}};
    overview.appendChild(autoLabel);
    const form = cardOf({title: '记住一件事', sub: '仅存本机，可随时更改或删除'});
    const kind = el('select'); kind.id = 'memory-kind';
    for (const [value, label] of [['preference', '学习偏好'], ['goal', '学习目标'], ['fact', '个人学习事实']]) {const option = el('option', null, label); option.value = value; kind.appendChild(option);}
    const text = el('textarea'); text.id = 'memory-text'; text.rows = 3;
    form.appendChild(fieldOf('类型', kind)); form.appendChild(fieldOf('内容', text));
    const scope = el('select'); scope.id = 'memory-scope';
    const global = el('option', null, '全部学习场景'); global.value = ''; scope.appendChild(global);
    for (const kb of state.cfg.knowledgeBases || []) {const option=el('option',null,kb.name);option.value=kb.id;scope.appendChild(option);}
    form.appendChild(fieldOf('适用范围', scope));
    let editId = '';
    form.appendChild(btn('保存记忆', 'primary sm', async () => {
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
      actions.appendChild(btn('忘记','sm ghost',async()=>{try{await api('/api/learning/memory/forget',{id:m.id});await go('memory');toast('已忘记');}catch(e){toast('删除失败：'+e.message);}}));
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
  const article = el('article','md'); article.innerHTML=md(hit.text || hit.caption || '此处没有可显示的原文。');
  card.appendChild(article);
  card.querySelector('.card-head').appendChild(btn('收起原文','ghost sm',()=>host.replaceChildren()));
  host.replaceChildren(card); card.scrollIntoView({block:'nearest'});
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
  documents.appendChild(btn('返回文档列表', 'ghost sm search-reset', () => { results.innerHTML = ''; view.querySelector('[aria-label="搜索资料内容"]').value = ''; }));
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
  management.open=currentSection==='manage'||!hasKb();
  if(!hasKb())view.replaceChildren(management);else view.appendChild(management);
  const toolbar=view.querySelector('.library-toolbar');if(toolbar)toolbar.appendChild(btn('管理知识库','ghost sm',()=>{management.open=true;management.scrollIntoView({block:'start'});}));
  if(currentSection==='manage')management.scrollIntoView({block:'start'});
  if(currentSection==='harvest'){const harvest=view.querySelector('.harvest-entry');if(harvest){harvest.open=true;harvest.scrollIntoView({block:'start'});}}
};

/* A course is read one lecture section at a time; source material stays in citations. */
const studyJobs = new Map();
const studyQuizCache = new Map();
function openStudyCitation(source, index, origin) {
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

const homePageBeforeWorkspace = PAGES.home.render;
PAGES.home.render = async function() {
  const generation=state.navigationGeneration;await homePageBeforeWorkspace.call(this);if(generation!==state.navigationGeneration)return;
  const view=$('view'),hero=view.querySelector('.study-continue');if(!hero)return;
  const sections=[...view.children],recent=sections.find(n=>n.querySelector('h2')?.textContent==='最近成果'),advice=sections.find(n=>n.querySelector('h2')?.textContent==='今日建议');
  const layout=el('div','home-workspace'),main=el('div','home-primary'),aside=el('aside','home-recent');
  main.appendChild(hero);if(advice)main.appendChild(advice);if(recent)aside.appendChild(recent);layout.append(main,aside);view.prepend(layout);
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

/* Main-node knowledge network: visual language adapted from the existing web KnowledgeGraph3D.
   The desktop projection keeps its soft purple orbs and spatial orbit, with no inferred edges. */
const knowledgeNet={data:{nodes:[],links:[]},selected:'',yaw:.28,pitch:.12,zoom:1,canvas:null,draw:null,projected:[],visible:null};
function knowledgeDialog(title,build){
  const overlay=el('div','task-modal knowledge-dialog'),panel=el('section','task-modal-card');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label',title);panel.appendChild(el('h2',null,title));overlay.appendChild(panel);document.body.appendChild(overlay);
  const close=()=>overlay.remove();overlay.onkeydown=e=>{if(e.key==='Escape')close();};overlay.onclick=e=>{if(e.target===overlay)close();};build(panel,close);return overlay;
}
async function refreshKnowledgeNetwork(){
  knowledgeNet.data=await api('/api/knowledge/graph',{});knowledgeNet.visible=null;
  if(current==='home'&&knowledgeNet.canvas?.isConnected){paintKnowledgeNodeList();knowledgeNet.draw?.();}
}
function editKnowledgePoint(node){
  knowledgeDialog(node?'编辑知识点':'添加知识点',(panel,close)=>{
    const title=inputOf('knowledge-title','概念名称',node?.title || ''),definition=el('textarea'),aliases=inputOf('knowledge-aliases','用顿号或逗号分隔',node?.aliases?.join('、') || '');definition.id='knowledge-definition';definition.rows=5;definition.value=node?.definition || '';
    panel.append(fieldOf('名称',title),fieldOf('简明定义',definition),fieldOf('确切别名',aliases));
    panel.appendChild(btn('保存知识点','primary',async()=>{try{const saved=await api('/api/knowledge/save',{id:node?.id || '',title:title.value,definition:definition.value,aliases:aliases.value.split(/[、,，]/).map(t=>t.trim()).filter(Boolean)});close();await refreshKnowledgeNetwork();await openKnowledgePoint(saved.id);}catch(e){toast(e.message);}}));panel.appendChild(btn('取消','ghost',close));title.focus();
  });
}
function writeKnowledgeNote(node){
  knowledgeDialog('给「'+node.title+'」写笔记',(panel,close)=>{
    const text=el('textarea');text.id='knowledge-note';text.rows=7;text.placeholder='你的理解、例子、疑问或下一次要追问的内容';panel.appendChild(fieldOf('我的笔记',text));
    panel.append(btn('保存笔记','primary',async()=>{try{await api('/api/knowledge/note',{id:node.id,text:text.value});close();await refreshKnowledgeNetwork();await openKnowledgePoint(node.id);}catch(e){toast(e.message);}}),btn('取消','ghost',close));text.focus();
  });
}
function linkKnowledgePoint(node){
  knowledgeDialog('手动连接知识点',(panel,close)=>{
    const other=el('select');other.id='knowledge-link-target';other.appendChild(option('','选择另一个知识点'));
    knowledgeNet.data.nodes.filter(n=>n.id!==node.id).forEach(n=>other.appendChild(option(n.id,n.title)));
    const label=inputOf('knowledge-link-label','例如：对比、应用、先学','关联');panel.append(fieldOf('从「'+node.title+'」连接到',other),fieldOf('关系说明',label));
    panel.append(btn('添加连线','primary',async()=>{try{await api('/api/knowledge/link',{from:node.id,to:other.value,label:label.value});close();await refreshKnowledgeNetwork();await openKnowledgePoint(node.id);}catch(e){toast(e.message);}}),btn('取消','ghost',close));other.focus();
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
async function openKnowledgePoint(id){
  if(current!=='home')await go('home');
  const generation=state.navigationGeneration,node=await api('/api/knowledge/node',{id});if(generation!==state.navigationGeneration||current!=='home')return;
  knowledgeNet.selected=id;const workspace=$('knowledge-workspace'),aside=$('knowledge-detail');if(!workspace||!aside)return;
  workspace.classList.add('has-detail');aside.hidden=false;aside.replaceChildren();
  const head=el('div','row');head.append(el('strong','grow',node.title),btn('收起','ghost sm',()=>{aside.hidden=true;workspace.classList.remove('has-detail');knowledgeNet.selected='';knowledgeNet.draw?.();paintKnowledgeNodeList();}));aside.appendChild(head);
  aside.append(el('p','knowledge-definition',node.definition || '还没有定义，可以补充你的理解。'),el('p','muted sm',(node.userEdited?'含本人编辑':'AI记录')+' · '+node.recordCount+' 次相关讨论'));
  if(node.aliases?.length)aside.appendChild(el('p','muted sm','也称：'+node.aliases.join('、')));
  const actions=el('div','knowledge-actions');actions.append(btn('提问','primary sm',()=>askKnowledgePoint(node)),btn('写笔记','sm',()=>writeKnowledgeNote(node)),btn('手动连线','sm ghost',()=>linkKnowledgePoint(node)),btn('编辑','sm ghost',()=>editKnowledgePoint(node)));aside.appendChild(actions);
  aside.appendChild(el('h3',null,'对话中的记录'));
  if(!node.records?.length)aside.appendChild(el('p','muted sm','这个知识点由你添加，还没有关联对话。'));
  for(const record of node.records || []){
    const item=el('article','knowledge-record');item.dataset.record=record.id;item.append(el('p','muted sm',fmtStamp(record.at)+' · '+record.workspaceName),el('strong',null,record.question),el('p',null,record.note));
    if(record.workspaceRoot)item.appendChild(el('p','path-line muted sm',record.workspaceRoot));
    item.appendChild(btn('回到这次对话','ghost sm',()=>revealChatHit({sessionId:record.sessionId,turnId:record.turnId}).catch(e=>toast('无法打开来源：'+e.message))));aside.appendChild(item);
  }
  aside.appendChild(el('h3',null,'我的笔记'));
  if(!node.notes?.length)aside.appendChild(el('p','muted sm','写下你的理解，笔记也可以在全局搜索里找到。'));
  for(const note of node.notes || []){const item=el('article','knowledge-record');item.append(el('p','muted sm',fmtStamp(note.at)),el('p',null,note.text),btn('打开笔记','ghost sm',()=>{state.resTab='notes';go('notes','',{focus:note.id});}));aside.appendChild(item);}
  const links=(knowledgeNet.data.links || []).filter(l=>l.from===id||l.to===id);if(links.length)aside.appendChild(el('h3',null,'手动连接'));
  for(const link of links){const other=knowledgeNet.data.nodes.find(n=>n.id===(link.from===id?link.to:link.from)),row=el('div','row knowledge-link-row');row.append(btn((other?.title || '知识点')+' · '+link.label,'ghost sm grow',()=>openKnowledgePoint(other.id)),btn('移除','ghost sm',async()=>{await api('/api/knowledge/link',{from:link.from,to:link.to,remove:true});await refreshKnowledgeNetwork();await openKnowledgePoint(id);}));aside.appendChild(row);}
  aside.appendChild(btn('删除知识点','ghost sm knowledge-delete',()=>confirmDialog('删除这个知识点？','将删除节点、关联的AI记录和连线；本人笔记会保留在笔记页。',async()=>{await api('/api/knowledge/delete',{id});aside.hidden=true;workspace.classList.remove('has-detail');knowledgeNet.selected='';await refreshKnowledgeNetwork();})));
  paintKnowledgeNodeList();knowledgeNet.draw?.();
}
function paintKnowledgeNodeList(){
  const list=$('knowledge-node-list');if(!list)return;list.replaceChildren();
  const nodes=knowledgeNet.visible || knowledgeNet.data.nodes;
  for(const node of nodes){const button=btn('','knowledge-node-button'+(node.id===knowledgeNet.selected?' active':''),()=>openKnowledgePoint(node.id));button.dataset.knowledgeId=node.id;button.append(el('span','grow',node.title),el('span','muted sm',node.recordCount+' 次记录'));list.appendChild(button);}
  const count=$('knowledge-count');if(count)count.textContent=knowledgeNet.visible?nodes.length+' / '+knowledgeNet.data.nodes.length+' 个知识点':nodes.length+' 个知识点 · '+knowledgeNet.data.links.length+' 条手动连接';
}
function installKnowledgeCanvas(canvas){
  const ctx=canvas.getContext('2d'),host=canvas.parentElement;knowledgeNet.canvas=canvas;let hovered='',drag=null;
  const project=()=>{
    const nodes=knowledgeNet.visible || knowledgeNet.data.nodes,n=Math.max(1,nodes.length),w=host.clientWidth,h=host.clientHeight,scale=Math.min(w*.34,h*.36)*knowledgeNet.zoom;
    return nodes.map((node,i)=>{
      const y=n===1?0:1-2*(i+.5)/n,r=Math.sqrt(Math.max(0,1-y*y)),angle=i*Math.PI*(3-Math.sqrt(5));let x=Math.cos(angle)*r,z=Math.sin(angle)*r;
      const cy=Math.cos(knowledgeNet.yaw),sy=Math.sin(knowledgeNet.yaw),cp=Math.cos(knowledgeNet.pitch),sp=Math.sin(knowledgeNet.pitch),xx=x*cy+z*sy,zz=z*cy-x*sy,yy=y*cp-zz*sp,depth=y*sp+zz*cp,perspective=3.4/(3.4-depth*.45);
      return {...node,x:w/2+xx*scale*perspective,y:h/2+yy*scale*perspective,z:depth,r:(23+Math.min(7,node.recordCount||0))*perspective};
    }).sort((a,b)=>a.z-b.z);
  };
  const draw=()=>{
    if(!canvas.isConnected)return;const w=host.clientWidth,h=host.clientHeight,dpr=Math.min(2,devicePixelRatio || 1);if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const ink=getComputedStyle(document.body).getPropertyValue('--ink').trim() || '#203C35',points=project();knowledgeNet.projected=points;
    for(const link of knowledgeNet.data.links){const a=points.find(n=>n.id===link.from),b=points.find(n=>n.id===link.to);if(!a||!b)continue;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle='rgba(139,125,168,.4)';ctx.lineWidth=1.2;ctx.stroke();}
    for(const p of points){const selected=p.id===knowledgeNet.selected,hover=p.id===hovered,r=p.r*(selected||hover?1.16:1),gradient=ctx.createRadialGradient(p.x-r*.2,p.y-r*.2,0,p.x,p.y,r);
      // Old web plush texture: opaque center, .55/.72/.88 soft falloff, lavender domain color.
      gradient.addColorStop(0,'rgba(181,170,205,.9)');gradient.addColorStop(.35,'rgba(169,155,196,.78)');gradient.addColorStop(.55,'rgba(155,141,184,.56)');gradient.addColorStop(.72,'rgba(155,141,184,.3)');gradient.addColorStop(.88,'rgba(155,141,184,.12)');gradient.addColorStop(1,'rgba(155,141,184,0)');ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();
      if(selected){ctx.beginPath();ctx.arc(p.x,p.y,r*.65,0,Math.PI*2);ctx.strokeStyle='rgba(184,146,70,.8)';ctx.lineWidth=1.5;ctx.stroke();}
      if(points.length<80||selected||hover){ctx.fillStyle=ink;ctx.font=(selected||hover?'600 ':'500 ')+(selected?15:13)+'px "Microsoft YaHei",sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';let label=p.title;while(ctx.measureText(label).width>160&&label.length>3)label=label.slice(0,-2)+'…';ctx.fillText(label,p.x,p.y);}
    }
  };
  const hit=e=>{const rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;return [...knowledgeNet.projected].reverse().find(p=>Math.hypot(p.x-x,p.y-y)<Math.max(24,p.r));};
  canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,moved:false};canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{if(drag){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>2)drag.moved=true;knowledgeNet.yaw+=dx*.006;knowledgeNet.pitch=Math.max(-1.25,Math.min(1.25,knowledgeNet.pitch+dy*.006));drag.x=e.clientX;drag.y=e.clientY;draw();}else{const p=hit(e);if((p?.id || '')!==hovered){hovered=p?.id || '';canvas.style.cursor=p?'pointer':'grab';canvas.title=p?.title || '拖动旋转，滚轮缩放';draw();}}};
  canvas.onpointerup=e=>{const moved=drag?.moved;drag=null;if(!moved){const node=hit(e);if(node)openKnowledgePoint(node.id).catch(err=>toast(err.message));}};canvas.onpointercancel=()=>{drag=null;};
  canvas.addEventListener('wheel',e=>{e.preventDefault();knowledgeNet.zoom=Math.max(.55,Math.min(1.8,knowledgeNet.zoom*Math.exp(-e.deltaY*.001)));draw();},{passive:false});
  state.knowledgeObserver?.disconnect();state.knowledgeObserver=new ResizeObserver(draw);state.knowledgeObserver.observe(host);knowledgeNet.draw=draw;draw();
}
const homeBeforeKnowledgeNetwork=PAGES.home.render;
PAGES.home.render=async function(){
  const generation=state.navigationGeneration;await homeBeforeKnowledgeNetwork.call(this);if(generation!==state.navigationGeneration)return;
  const view=$('view');knowledgeNet.data=await api('/api/knowledge/graph',{});if(generation!==state.navigationGeneration)return;knowledgeNet.visible=null;
  const card=el('section','card knowledge-network'),head=el('header','knowledge-network-head'),intro=el('div');intro.append(el('h2',null,'我的知识网络'),el('p','muted sm','对话中积累概念与记录；关系由你自己连接。'));
  const search=inputOf('knowledge-search','搜索知识点、问题或笔记');search.setAttribute('aria-label','搜索知识网络');
  const actions=el('div','row');actions.append(btn('添加知识点','sm',()=>editKnowledgePoint()),btn('重置视角','ghost sm',()=>{knowledgeNet.yaw=.28;knowledgeNet.pitch=.12;knowledgeNet.zoom=1;knowledgeNet.draw?.();}));head.append(intro,search,actions);card.appendChild(head);
  const workspace=el('div','knowledge-workspace');workspace.id='knowledge-workspace';const scene=el('div','knowledge-scene'),canvas=el('canvas','knowledge-canvas');canvas.setAttribute('aria-hidden','true');scene.appendChild(canvas);
  if(!knowledgeNet.data.nodes.length){const empty=el('div','knowledge-empty');empty.append(el('h3',null,'从一次知识讨论开始'),el('p','muted','解释概念或讨论方法时，Lumin会留下带来源的知识点；也可以自己添加。'),btn('开始讨论','primary sm',()=>startAgentTask('请用一个具体例子解释输入与输出的约定。','')));scene.appendChild(empty);}
  const detail=el('aside','knowledge-detail');detail.id='knowledge-detail';detail.hidden=true;detail.setAttribute('aria-label','知识点记录');workspace.append(scene,detail);card.appendChild(workspace);
  const foot=el('div','knowledge-network-foot'),count=el('span','muted sm');count.id='knowledge-count';foot.append(count,el('span','muted sm','拖动旋转 · 滚轮缩放 · 点击查看记录'));card.appendChild(foot);
  const list=el('div','knowledge-node-list');list.id='knowledge-node-list';list.setAttribute('aria-label','知识点清单');card.appendChild(list);view.prepend(card);paintKnowledgeNodeList();installKnowledgeCanvas(canvas);
  let timer,sequence=0;search.oninput=()=>{clearTimeout(timer);const mine=++sequence;timer=setTimeout(async()=>{try{const q=search.value.trim();if(!q)knowledgeNet.visible=null;else{const hits=(await api('/api/personal/search',{query:q,limit:50})).hits || [];if(mine!==sequence||generation!==state.navigationGeneration)return;const ids=new Set(hits.filter(h=>h.type==='knowledge').map(h=>h.id));knowledgeNet.visible=knowledgeNet.data.nodes.filter(n=>ids.has(n.id));}paintKnowledgeNodeList();knowledgeNet.draw?.();}catch(e){toast(e.message);}},220);};
};
