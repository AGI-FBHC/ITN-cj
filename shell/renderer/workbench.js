/* Personal learning workspace. Data and task truth come from the Cangjie API. */
const RESOURCE_LABEL = {lecture: '定制讲义', practice: '实操指南', quiz: '分阶测试', ppt: '在线演示'};
const TASK_LABEL = {running: '正在执行', cancelling: '正在停止', completed: '已完成', failed: '未完成', cancelled: '已取消', interrupted: '上次任务已中断'};
const workbench = {selected: null, open: false, loadToken: 0, seenSaved: new Set(), task: null};

RAIL_GROUPS.splice(0, RAIL_GROUPS.length,
  [{id: 'chat', label: 'Agent 工作台', icon: 'chat'}],
  [{id: 'kb', label: '知识库', icon: 'db'}, {id: 'resources', label: '学习资源', icon: 'layers'}],
  [{id: 'home', label: '学习中心', icon: 'book'}, {id: 'memory', label: '学习记忆', icon: 'note'}]);
Object.assign(PAGE_META, {
  chat: {title: 'Agent 工作台', sub: '围绕你的资料、目标和学习记录开展任务'},
  home: {title: '学习中心', sub: '阅读、练习、笔记、错题与成长记录'},
  resources: {title: '学习资源', sub: '讲义 · 实操 · 分阶测试 · 在线演示'},
  memory: {title: '学习记忆', sub: '你决定 Agent 记住什么，也能随时修改和忘记'},
});
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
    (compact ? '' : '<span class="muted sm">' + esc(kbName(resource.kbId) || '通用') + ' · ' + esc(fmtStamp(resource.updatedAt || resource.createdAt)) + '</span>') +
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
  }
  dock.hidden = current !== 'chat' || !workbench.open;
  document.body.classList.toggle('resource-open', !dock.hidden);
  return dock;
}

function closeResourceDock() {
  workbench.open = false;
  ensureResourceDock();
  $('wb-artifacts')?.focus();
}

async function openLearningResource(id, version) {
  try {
    const token = ++workbench.loadToken;
    const resource = await api('/api/learning/resource', {id, version: version || 0});
    if (token !== workbench.loadToken) return;
    if (current !== 'chat') await go('chat');
    workbench.selected = resource;
    workbench.open = true;
    renderResourceDock();
  } catch (e) { toast('读取资源失败：' + e.message); }
}

function renderResourceDock() {
  const dock = ensureResourceDock();
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
    body.appendChild(el('p', 'muted', '告诉 Agent 你的学习目标。需要讲义、实操、测试或演示时，它会调用工具生成，结果会自动出现在这里。'));
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
  actions.appendChild(btn('让 Agent 修改', 'sm', () => {
    promptLearning('请先读取学习资源 ' + res.id + ' 的最新版本，再按以下要求修改并保存新版本：');
  }));
  actions.appendChild(copyButton(() => res.markdown || '', '复制 Markdown'));
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
  const dock = ensureResourceDock();
  document.querySelector('.wb-toolbar')?.remove();
  if (current !== 'chat' || currentSection === 'overview') { dock.hidden = true; return; }
  const bar = el('div', 'wb-toolbar');
  bar.appendChild(el('span', 'wb-brand', 'lumin'));
  const scope = el('span', 'wb-scope', scopeNow() ? kbName(scopeNow()) : '全部本地知识库');
  scope.title = state.chapter ? '正在学习：' + state.chapter : '当前会话资料范围';
  bar.appendChild(scope);
  const status = el('span', 'wb-task', ''); status.id = 'wb-task-state'; status.setAttribute('role', 'status'); bar.appendChild(status);
  bar.appendChild(spacer());
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
      state.chatTurns = turnsFromEvents(state.chatEvents);
      syncWorkbenchEvents(state.chatEvents);
      if (!['running', 'cancelling'].includes(workbench.task?.status)) {
        state.chatRequest = null; state.busyTurn = false; state.cancelRequested = null;
      }
      state.chatPaint?.();
    } catch (e) { /* Preserve the last confirmed state while disconnected. */ }
  }, 1500);
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

const originalHome = PAGES.home.render;
PAGES.home.render = async function() {
  await originalHome.call(this);
  const links = el('div', 'center-links');
  for (const [page, label, text] of [['learn', '学 · 练', '按章节读资料与练习'], ['report', '我的成长', '活动记录与自评档案'], ['notes', '我的资源', '笔记、错题与收集资料']]) {
    const b = btn(label, '', () => go(page)); b.dataset.page = page; b.title = text; links.appendChild(b);
  }
  $('view').prepend(links);
};

const originalResources = PAGES.resources.render;
PAGES.resources.render = async function() {
  await originalResources.call(this);
  const view = $('view');
  const legacy = el('details', 'legacy-artifacts');
  legacy.appendChild(el('summary', null, '本地 Markdown 文件与历史产物'));
  while (view.firstChild) legacy.appendChild(view.firstChild);
  const heading = el('div', 'resource-library-head');
  heading.appendChild(el('h2', null, '你的学习资源'));
  heading.appendChild(el('p', 'muted', '由 Agent 按学习目标生成，保留资料依据、质检与历史版本。'));
  const actions = el('div', 'row');
  for (const [kind, label] of Object.entries(RESOURCE_LABEL)) actions.appendChild(btn(label, 'sm', () => {state.pendingQuestion = '请围绕我当前的学习目标生成一份' + label + '，主题：'; go('chat');}));
  heading.appendChild(actions); view.appendChild(heading);
  const all = (await api('/api/learning/resources', {})).resources || [];
  const search = inputOf('learning-resource-search', '搜索资源标题', ''); search.setAttribute('aria-label', '搜索学习资源');
  view.appendChild(search);
  const grid = el('div', 'resource-grid');
  const paint = () => {
    grid.innerHTML = '';
    const rows = all.filter(r => (r.title || '').toLowerCase().includes(search.value.toLowerCase()));
    if (!rows.length) grid.appendChild(el('p', 'muted', all.length ? '没有匹配的资源' : '还没有生成资源。描述你想学的主题，Agent 会按需调用生成工具。'));
    for (const r of rows) grid.appendChild(resourceCard(r));
  };
  search.oninput = paint; paint(); view.appendChild(grid); view.appendChild(legacy);
};
const originalResourcesPanel = PANELS.resources;
PANELS.resources = {
  title: '学习资源',
  async render(body) {
    const rows = (await api('/api/learning/resources', {})).resources || [];
    if (!rows.length) body.appendChild(panelEmpty('新资源会保留结构、版本与学习记录。历史文件在主区下方。'));
    for (const r of rows) body.appendChild(resourceCard(r, true));
  }
};

PAGES.memory = {
  async render() {
    const view = $('view'); view.innerHTML = '';
    const context = await api('/api/learning/context', {kbId: state.kb || ''});
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
PANELS.memory = {title:'学习记忆',async render(body){body.appendChild(el('p','panel-empty','目标和偏好帮助 Agent 选择解释方式与资源。能力依据来自真实作答，记录数量不当作能力分。'));}};

boot();
