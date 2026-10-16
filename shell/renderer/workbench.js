/* Personal learning workspace. Data and task truth come from the Cangjie API. */
const RESOURCE_LABEL = {lecture: '定制讲义', practice: '实操指南', quiz: '分阶测试', ppt: '在线演示', legacy:'历史资料'};
const TASK_LABEL = {running: '正在执行', cancelling: '正在停止', completed: '已完成', failed: '未完成', cancelled: '已取消', interrupted: '上次任务已中断'};
const workbench = {selected: null, open: false, loadToken: 0, seenSaved: new Set(), task: null};

// Four daily destinations. Existing routes stay intact for history and deep links.
RAIL_GROUPS.splice(0, RAIL_GROUPS.length,
  [{id: 'chat', label: '对话', icon: 'chat'}],
  [{id: 'home', label: '学习', icon: 'book'}, {id: 'kb', label: '资料', icon: 'db'}, {id: 'resources', label: '成果', icon: 'layers'}]);
function navigationRoot(page) {
  if (['learn', 'report', 'calibrate'].includes(page)) return 'home';
  if (['notes', 'wrong'].includes(page)) return 'resources';
  if (['memory', 'models'].includes(page)) return 'settings';
  return page;
}
Object.assign(PAGE_META, {
  chat: {title: '对话', sub: '围绕你的资料和目标开展任务'},
  home: {title: '学习', sub: '接着学，练一练，看看进步'},
  learn: {title: '学习', sub: '按章节阅读与练习'},
  report: {title: '学习', sub: '阅读记录、练习表现与能力自评'},
  resources: {title: '学习成果', sub: '讲义、练习、笔记与错题，都在这里'},
  notes: {title: '学习成果', sub: '讲义、练习、笔记与错题，都在这里'},
  kb: {title: '资料库', sub: '找到资料、读原文，再开始学习'},
  memory: {title: '学习记忆', sub: '查看、修改或删除 Lumin 记住的内容'},
});
function decorateWorkspace() {
  const view = $('view');
  const learning = ['home', 'learn', 'report', 'calibrate'].includes(current);
  const outcomes = ['resources', 'notes', 'wrong'].includes(current);
  if (!learning && !outcomes) return;
  const nav = el('nav', 'workspace-tabs' + (learning ? ' center-links' : ''));
  nav.setAttribute('aria-label', learning ? '学习功能' : '学习成果分类');
  const selected = learning ? (current === 'calibrate' ? 'report' : current)
    : current === 'resources' ? (currentSection === 'files' ? 'files' : 'generated') : (state.resTab || 'notes');
  const tabs = learning ? [['home', '总览'], ['learn', '学 · 练'], ['report', '我的成长']]
    : [['generated', '生成成果'], ['notes', '笔记'], ['wrong', '错题'], ['files', '本地文件'], ['network', '收集资料']];
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
  view.prepend(nav);
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
    workbench.selected = resource;
    workbench.open = true;
    renderResourceDock();
    document.querySelectorAll('.outcome-grid .resource-entry').forEach(node => {
      const selected = node.dataset.resource === resource.id;
      node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected));
    });
  } catch (e) { toast('读取资源失败：' + e.message); }
}

/** 把当前这份资源导出成 Office 文件（壳里弹"另存为"，写完给一句实话）。 */
async function exportResourceAs(res, kind) {
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
    actions.appendChild(btn('导出 pptx', 'sm ghost', () => exportResourceAs(res, 'pptx')));
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
  const artifacts = btn('学习成果', 'ghost sm', () => {workbench.open = !workbench.open; renderResourceDock();}); artifacts.id = 'wb-artifacts'; bar.appendChild(artifacts);
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
  const artifacts = btn('学习成果', 'ghost sm', () => {workbench.open = !workbench.open; renderResourceDock();}); artifacts.id = 'wb-artifacts'; bar.appendChild(artifacts);
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
    if (state.chatRequest && e.turnId === state.chatRequest.turnId) openLearningResource(e.payload.id, e.payload.version);
  }
}

const originalResources = PAGES.resources.render;
PAGES.resources.render = async function() {
  if (currentSection === 'files') {
    await originalResources.call(this);
    // Local Office previews remain available even before the first generated file.
    if (!state.artifacts.length) {
      const actions = el('div', 'row');
      actions.append(btn('打开演示文稿…', '', () => openLocalOutcome('deck')), btn('打开文档…', '', () => openLocalOutcome('doc')));
      $('view').prepend(actions);
    }
    return;
  }
  const view = $('view'); view.innerHTML = '';
  const toolbar = el('div', 'outcome-toolbar');
  const search = inputOf('learning-resource-search', '搜索成果标题', state.outcomeQuery || ''); search.setAttribute('aria-label', '搜索学习资源');
  const kind = el('select'); kind.setAttribute('aria-label', '筛选成果类型');
  kind.appendChild(option('', '全部类型'));
  for (const [value, label] of Object.entries(RESOURCE_LABEL)) kind.appendChild(option(value, label));
  kind.value = state.outcomeKind || '';
  const create = el('details', 'outcome-create'); create.appendChild(el('summary', 'btn primary', '+ 新建成果'));
  const menu = el('div', 'outcome-menu');
  for (const [value, label] of Object.entries(RESOURCE_LABEL).filter(([key]) => key !== 'legacy')) {
    menu.appendChild(btn(label, 'ghost', () => {state.pendingQuestion = '请围绕我当前的学习目标生成一份' + label + '，主题：'; go('chat');}));
  }
  create.appendChild(menu); toolbar.append(search, kind, create); view.appendChild(toolbar);
  const status = el('p', 'muted sm'); status.setAttribute('role', 'status'); view.appendChild(status);
  const split = el('div', 'outcome-workspace');
  const grid = el('div', 'resource-grid outcome-grid outcome-list'); split.appendChild(grid);
  const reader = el('section', 'outcome-reader'); reader.id = 'outcome-reader'; reader.setAttribute('aria-label', '成果阅读区');
  const placeholder = el('div', 'outcome-placeholder'); placeholder.append(el('h2', null, '选择一份成果'), el('p', 'muted', '在左侧选择讲义、练习或演示，在这里阅读、作答和导出。')); reader.appendChild(placeholder);
  split.appendChild(reader); view.appendChild(split);
  let all = [];
  const paint = () => {
    state.outcomeQuery = search.value; state.outcomeKind = kind.value; grid.innerHTML = '';
    const rows = all.filter(r => (!kind.value || r.kind === kind.value) && (r.title || '').toLowerCase().includes(search.value.trim().toLowerCase()));
    status.textContent = '共 ' + all.length + ' 份成果' + (rows.length !== all.length ? ' · 显示 ' + rows.length + ' 份' : '');
    if (!rows.length) {
      grid.appendChild(emptyState({inline: true, art: 'layers', title: all.length ? '没有找到匹配的成果' : '第一份成果，从一个主题开始', text: all.length ? '换个标题关键词或类型试试。' : '生成的讲义、实操、练习和演示会保存在这里，也可以切到上方查看笔记与错题。'}));
    }
    for (const r of rows) { const card = resourceCard(r); card.classList.toggle('selected', r.id === workbench.selected?.id); card.setAttribute('aria-pressed', String(r.id === workbench.selected?.id)); grid.appendChild(card); }
  };
  search.oninput = paint; kind.onchange = paint;
  const load = async () => {
    status.textContent = '正在读取学习成果…'; grid.innerHTML = '';
    try { all = ((await api('/api/learning/resources', {})).resources || []).slice().sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||''))); paint(); if (current === 'resources' && all.length && (!workbench.open || !all.some(r=>r.id===workbench.selected?.id))) await openLearningResource(all.some(r=>r.id===workbench.selected?.id) ? workbench.selected.id : all[0].id); }
    catch(e) { status.textContent = '读取失败：' + e.message; grid.appendChild(btn('重试', '', load)); }
  };
  await load();
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
  ['资料与备份', ['kb', 'data']],
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

const studyPageBeforeWorkspace = PAGES.learn.render;
PAGES.learn.render = async function() {
  const generation = state.navigationGeneration;
  await loadCfg(); if (generation !== state.navigationGeneration) return;
  if (!hasKb() || !indexedKb()) { await studyPageBeforeWorkspace.call(this); return; }
  const tree = await api('/api/study/tree', {kbId: state.kb}); if (generation !== state.navigationGeneration) return;
  const chapters = tree.chapters || [];
  if (!chapters.length) { await studyPageBeforeWorkspace.call(this); return; }
  if (!chapters.some(c=>c.name===state.chapter)) state.chapter = (chapters.find(c=>!c.done) || chapters[0]).name;
  const chapter = state.chapter, view = $('view'); view.innerHTML = '';
  await renderChapter(view); if (generation !== state.navigationGeneration) return;
  const header = view.firstElementChild, unit = view.querySelector('.unit-steps')?.closest('.card'), extra = view.querySelector('.chapter-extra');
  if (!header || !unit) return;
  header.classList.add('reader-heading'); header.querySelector('button')?.remove();
  const originalSteps = [...unit.querySelectorAll('.unit-step')];
  const reader = el('section', 'study-reader study-mode-panel'); reader.setAttribute('aria-label', '章节原文');
  const toolbar = el('div', 'reader-tools');
  originalSteps[0]?.querySelectorAll('button').forEach(b=>toolbar.appendChild(b));
  originalSteps[2]?.querySelectorAll('button').forEach(b=>toolbar.appendChild(b));
  reader.appendChild(toolbar);
  const article = el('article', 'chapter-article');
  for (const chunk of [...view.querySelectorAll('.chunk-card')]) {
    const actions = chunk.querySelector('.chunk-actions'), buttons = actions ? [...actions.querySelectorAll('button')] : [];
    if (actions && buttons.length > 1) {
      const menu = el('details', 'reader-context'); menu.appendChild(el('summary', 'btn ghost sm', '更多操作'));
      const menuBody = el('div', 'reader-context-menu'); buttons.slice(1).forEach(b=>menuBody.appendChild(b)); menu.appendChild(menuBody); actions.appendChild(menu);
    }
    article.appendChild(chunk);
  }
  reader.appendChild(article);
  const practice = el('section', 'study-mode-panel practice-mode'); practice.setAttribute('aria-label', '本章练习');
  if (originalSteps[1]) {
    const step = originalSteps[1]; step.querySelector('.unit-idx')?.remove();
    const start = [...step.querySelectorAll('button')].find(b=>b.textContent==='出题练习');
    if (start) start.onclick = () => openQuiz(practice, chapter);
    practice.appendChild(step);
  }
  practice.appendChild(el('p', 'muted', '围绕当前章节作答，答案与解释会保存到学习记录。答错的题可在错题本复习。'));
  const generate = el('section', 'study-mode-panel generate-mode'); generate.setAttribute('aria-label', '本章生成');
  generate.append(el('h2', null, '把这一章变成学习成果'), el('p', 'muted', '选择需要的形式，生成前可以修改主题。'));
  const choices = el('div', 'generation-choices');
  const known = extra ? [...extra.querySelectorAll('button')] : [];
  const descriptions = ['整理本章概念、例子与要点', '生成带答案与解析的练习'];
  known.slice(0,2).forEach((button,i)=>{ const choice = el('div', 'generation-choice'); choice.append(button, el('p', 'muted sm', descriptions[i])); choices.appendChild(choice); });
  for (const [label,description] of [['在线演示','把章节重点整理成可播放的演示'],['实操指南','围绕章节设计可动手的任务']]) {
    const choice = el('div', 'generation-choice'); choice.append(btn(label, '', () => promptLearning('请根据资料中的《'+chapter+'》生成一份'+label+'。')), el('p', 'muted sm', description)); choices.appendChild(choice);
  }
  generate.appendChild(choices);
  const tabs = el('nav', 'study-mode-tabs'); tabs.setAttribute('aria-label', '本章任务'); tabs.setAttribute('role','tablist');
  const modes = [['read','阅读',reader], ['practice','练习',practice], ['generate','生成',generate]];
  if (state.studyModeChapter !== chapter) {state.studyModeChapter=chapter; state.studyMode='read';}
  const select = key => {state.studyMode=key; for (const [id,,panel] of modes) {panel.hidden=id!==key; const button=tabs.querySelector('[data-mode="'+id+'"]');button.setAttribute('aria-selected',String(id===key));button.tabIndex=id===key?0:-1;} };
  for (const [key,label,panel] of modes) {const button=btn(label,'',()=>select(key));button.dataset.mode=key;button.setAttribute('role','tab');button.id='study-tab-'+key;button.setAttribute('aria-controls','study-panel-'+key);panel.id='study-panel-'+key;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);tabs.appendChild(button);}
  tabs.onkeydown = event => { const keys=modes.map(m=>m[0]);let index=keys.indexOf(state.studyMode);if(event.key==='ArrowRight')index=(index+1)%keys.length;else if(event.key==='ArrowLeft')index=(index+keys.length-1)%keys.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=keys.length-1;else return;event.preventDefault();select(keys[index]);tabs.querySelector('[data-mode="'+keys[index]+'"]').focus(); };
  const complete = originalSteps[3]?.querySelector('button'); if (complete) { complete.className='btn sm ghost complete-chapter'; header.querySelector('.card-head').appendChild(complete); }
  view.replaceChildren(header,tabs,reader,practice,generate); select(state.studyMode || 'read');
  await renderPanel(true);
};
const studyPanelBeforeWorkspace = PANELS.learn;
PANELS.learn = {...studyPanelBeforeWorkspace, async render(body) {
  await studyPanelBeforeWorkspace.render(body, {foot:()=>{}});
  if (hasKb()) { const selector = kbSelector(()=>{state.chapter=null;go('learn');}); selector.setAttribute('aria-label','学习资料范围'); body.prepend(selector); }
}};

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
