/* lumin 桌面端单页应用（shell/ui/app.js）
 *
 * 契约唯一事实源：docs/serve-rpc.md
 *   §2 事件（POST /api/events 长轮询）· §3 运行控制 · §4 会话
 *   §5 设置 · §7 state 形状 · §8 window.lumin（标题栏 / 目录对话框 / 终端 IPC）
 *
 * 原则：
 *   - 全部相对路径 fetch（同源）；
 *   - 界面禁止乐观渲染：发消息后等 message_start(user) 事件再画气泡；
 *   - 一个全局事件循环，界面各部分只订阅；
 *   - fetch 失败显示「等待内核」横幅，不白屏。
 */
(function () {
  'use strict';

  /* ================= 基础工具 ================= */

  function $(sel) { return document.querySelector(sel); }

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function finiteNum(v, dflt) {
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }

  /* GET 接口 */
  function apiGet(path) {
    return fetch(path).then(function (r) { return readJson(r); });
  }

  /* POST 接口（契约 §0：除标 GET 外一律 POST + JSON body，body 为空也接受） */
  function apiPost(path, body) {
    var payload = body === undefined || body === null ? '{}' : JSON.stringify(body);
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: payload
    }).then(function (r) { return readJson(r); });
  }

  function readJson(r) {
    return r.text().then(function (txt) {
      var data = null;
      if (txt) { try { data = JSON.parse(txt); } catch (e) { data = null; } }
      if (!r.ok) {
        var err = new Error((data && data.error) ? data.error : ('HTTP ' + r.status));
        err.status = r.status;
        err.data = data;
        throw err;
      }
      if (data === null) throw new Error('响应不是 JSON');
      return data;
    });
  }

  /* 轻量 DOM 引用 */
  var dom = {};

  function collectDom() {
    dom.titlebar = $('#titlebar');
    dom.tbSession = $('#tb-session');
    dom.btnMin = $('#btn-win-min');
    dom.btnMax = $('#btn-win-max');
    dom.btnClose = $('#btn-win-close');
    dom.offline = $('#offline-banner');
    dom.offlineText = $('#offline-text');
    dom.layout = $('#layout');
    dom.sessionList = $('#session-list');
    dom.btnSessionNew = $('#btn-session-new');
    dom.wsPath = $('#ws-path');
    dom.btnWsPick = $('#btn-ws-pick');
    dom.nav = $('#nav');
    dom.stModel = $('#st-model');
    dom.stMode = $('#st-mode');
    dom.stPerm = $('#st-perm');
    dom.stWs = $('#st-ws');
    dom.stUsage = $('#st-usage');
    dom.stRun = $('#st-run');
    dom.stRunText = $('#st-run-text');
    dom.messages = $('#messages');
    dom.msgEmpty = $('#msg-empty');
    dom.approval = $('#approval-card');
    dom.keyBanner = $('#key-banner');
    dom.actionErr = $('#action-err');
    dom.input = $('#input');
    dom.composerHint = $('#composer-hint');
    dom.btnSend = $('#btn-send');
    dom.btnStop = $('#btn-stop');
    dom.treeNotice = $('#tree-notice');
    dom.treeBody = $('#tree-body');
    dom.btnTreeRefresh = $('#btn-tree-refresh');
    dom.skillsBody = $('#skills-body');
    dom.btnSkillsRefresh = $('#btn-skills-refresh');
    dom.settingsBody = $('#settings-body');
    dom.btnSettingsReload = $('#btn-settings-reload');
    dom.termWrap = $('#term-wrap');
    dom.termHost = $('#term-host');
    dom.termExit = $('#term-exit');
    dom.termNoShell = $('#term-noshell');
    dom.termStatus = $('#term-status');
    dom.btnTermRestart = $('#btn-term-restart');
    dom.toast = $('#toast');

    dom.views = {
      chat: $('#view-chat'),
      tree: $('#view-tree'),
      skills: $('#view-skills'),
      settings: $('#view-settings'),
      terminal: $('#view-terminal')
    };

    // 对话块容器（居中列）
    dom.msgList = h('div', 'messages-inner');
    dom.messages.insertBefore(dom.msgList, dom.msgEmpty);
  }

  /* ================= 全局状态 ================= */

  var state = null;            // §7 state（GET /api/state）
  var sessionsData = { current: '', sessions: [] };
  var running = false;         // 由 state.running + run_start/run_end 事件驱动
  var activeView = 'chat';
  var booted = false;
  var loopStarted = false;

  /* 对话数据（事件驱动渲染；entries 重放做全量，事件只做增量） */
  var conv = [];               // block 数组 = 当前分支的展示模型
  var curAssistant = null;     // 正在流式生成的 assistant block
  var suspendTs = null;        // message_start 已在 entries 里见过 → 等它的 message_end
  var seenTs = Object.create(null);   // 已入账的 message timestamp（防重放重复画）
  var seenCalls = Object.create(null);// toolCallId -> tool block（防工具卡重复）
  var cursor = 0;              // /api/events 的 since

  /* 事件循环退避（§2：1s 起，上限 10s） */
  var backoff = 1000;
  var offline = false;

  /* ================= 横幅 / toast / 错误行 ================= */

  function setOffline(on, text) {
    offline = on;
    dom.offline.hidden = !on;
    dom.layout.classList.toggle('has-banner', on);
    if (text) dom.offlineText.textContent = text;
  }

  var toastTimer = 0;
  function toast(text, kind) {
    dom.toast.textContent = text;
    dom.toast.className = 'toast' + (kind ? ' toast-' + kind : '');
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.hidden = true; }, 5000);
  }

  var errTimer = 0;
  function showActionErr(text) {
    dom.actionErr.textContent = text;
    dom.actionErr.hidden = false;
    clearTimeout(errTimer);
    errTimer = setTimeout(function () { dom.actionErr.hidden = true; }, 8000);
  }
  function hideActionErr() {
    clearTimeout(errTimer);
    dom.actionErr.hidden = true;
  }

  /* ================= state 渲染 ================= */

  function setState(st) {
    if (!st) return;
    state = st;
    running = !!st.running;
    renderTopbar();
    renderApproval();
    renderKeyBanner();
    renderComposerMode();
    renderWorkspace();
    renderTitleSession();
    if (activeView === 'settings') renderSettings();
  }

  function renderTopbar() {
    if (!state) return;
    dom.stModel.textContent = '模型 ' + (state.model || '—');
    dom.stModel.title = (state.base || '') + '\n' + (state.model || '');
    dom.stMode.textContent = '模式 ' + (state.modeTitle || state.mode || '—');
    dom.stMode.title = state.modeDescription || '';
    dom.stPerm.textContent = '权限 ' + (state.permissionText || state.permissions || '—');
    dom.stWs.textContent = '工作区 ' + abbrevPath(state.workspace || '—');
    dom.stWs.title = state.workspace || '';
    var u = state.usageLast || { 'in': 0, out: 0 };
    dom.stUsage.textContent = '↑' + fmtTokens(u['in']) + ' ↓' + fmtTokens(u.out);
    renderRunningLight();
  }

  function renderRunningLight() {
    dom.stRun.classList.remove('st-idle', 'st-run-on', 'st-run-err');
    if (running) {
      dom.stRun.classList.add('st-run-on');
      dom.stRunText.textContent = '运行中';
    } else {
      dom.stRun.classList.add('st-idle');
      dom.stRunText.textContent = '空闲';
    }
  }

  function fmtTokens(n) {
    n = finiteNum(n, 0);
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function abbrevPath(p) {
    if (!p) return '—';
    p = String(p);
    if (p.length <= 34) return p;
    var parts = p.split(/[\\/]/).filter(Boolean);
    if (parts.length >= 3) return '…/' + parts.slice(-2).join('/');
    return '…' + p.slice(-32);
  }

  function renderWorkspace() {
    dom.wsPath.textContent = state ? (state.workspace || '—') : '—';
    dom.wsPath.title = state ? (state.workspace || '') : '';
  }

  function renderTitleSession() {
    if (!state || !state.session) { dom.tbSession.textContent = ''; return; }
    var id = state.session.id || '';
    dom.tbSession.textContent = id ? ('· ' + id) : '';
    dom.tbSession.title = state.session.path || '';
  }

  function luminRootHint() {
    var root = (window.lumin && window.lumin.paths && window.lumin.paths.luminRoot) || '';
    return root ? (root + '\\.env.local') : 'lumin 根目录的 .env.local';
  }

  function renderKeyBanner() {
    var missing = state && state.keyConfigured === false;
    dom.keyBanner.hidden = !missing;
    if (missing) {
      dom.keyBanner.textContent = '还没有配置 API Key：在 ' + luminRootHint() + ' 写一行 LUMIN_KEY=… 后重启。';
    }
  }

  /* ================= 审批卡片（§3 / §7） ================= */

  var APPROVAL_KINDS = {
    'command': '执行命令',
    'command-dangerous': '危险命令',
    'path-outside': '写工作区外',
    'web': '联网'
  };

  function renderApproval() {
    var a = state && state.approval;
    if (!a) { dom.approval.hidden = true; dom.approval.textContent = ''; return; }

    dom.approval.textContent = '';
    dom.approval.hidden = false;

    var top = h('div', 'ac-top');
    top.appendChild(h('span', 'ac-kind', APPROVAL_KINDS[a.kind] || a.kind || '审批'));
    top.appendChild(h('span', 'ac-title', '需要你批准'));
    top.appendChild(h('span', 'ac-id', '#' + String(a.id)));
    dom.approval.appendChild(top);

    if (a.value) dom.approval.appendChild(h('div', 'ac-value', String(a.value)));
    if (a.detail) dom.approval.appendChild(h('div', 'ac-detail', String(a.detail)));

    var actions = h('div', 'ac-actions');
    var opts = [
      ['y', '允许一次'],
      ['s', '本次会话都允许'],
      ['a', '总是允许（记住）'],
      ['n', '拒绝']
    ];
    opts.forEach(function (pair) {
      var b = h('button', 'btn btn-sm' + (pair[0] === 'n' ? ' btn-danger' : ''), pair[1]);
      b.addEventListener('click', function () { answerApproval(a.id, pair[0], actions); });
      actions.appendChild(b);
    });
    dom.approval.appendChild(actions);
  }

  function answerApproval(id, answer, actions) {
    // 不乐观收起：等 approval_resolved 事件
    var btns = actions.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    var pending = h('span', 'ac-pending', '已提交，等待内核…');
    actions.appendChild(pending);

    apiPost('/api/approval', { id: id, answer: answer }).then(function () {
      // 成功也不收起，等 approval_resolved
    }).catch(function (e) {
      if (e.status === 409) {
        // stale：静默忽略，重新拉 state（契约 §3）
        apiGet('/api/state').then(setState).catch(function () {});
      } else {
        toast(e.message || '审批失败', 'err');
        apiGet('/api/state').then(setState).catch(function () {});
      }
    });
  }

  /* ================= 输入区模式（§3） ================= */

  function renderComposerMode() {
    if (running) {
      dom.input.placeholder = '插话…';
      dom.btnSend.textContent = '插话';
      dom.btnStop.hidden = false;
      dom.composerHint.textContent = '运行中 · Enter 插话 · Shift+Enter 换行';
    } else {
      dom.input.placeholder = '发消息…';
      dom.btnSend.textContent = '发送';
      dom.btnStop.hidden = true;
      dom.composerHint.textContent = 'Enter 发送 · Shift+Enter 换行';
    }
  }

  function autoGrow() {
    dom.input.style.height = 'auto';
    dom.input.style.height = Math.min(dom.input.scrollHeight, 200) + 'px';
  }

  function sendCurrent() {
    var text = dom.input.value;
    if (!text.trim()) return;
    hideActionErr();

    var endpoint = running ? '/api/steer' : '/api/message';
    apiPost(endpoint, { text: text }).then(function () {
      // 禁止乐观渲染：清空输入，气泡等 message_start(user) 事件再画
      dom.input.value = '';
      autoGrow();
    }).catch(function (e) {
      // 失败保留文本，展示服务端中文原因
      showActionErr(e.message || '发送失败');
      if (e.status === 409) {
        // running/idle 不一致 → 对账
        apiGet('/api/state').then(setState).catch(function () {});
      }
    });
  }

  function stopRun() {
    apiPost('/api/stop', {}).then(function () {
      // 不本地改 running：等 run_end / notice 事件
    }).catch(function (e) {
      showActionErr(e.message || '停止失败');
    });
  }

  /* ================= 消息解析（entries / 事件共用） ================= */

  /* 消息去重键：内核 timestamp 是毫秒，同一轮里 user/assistant（甚至相邻消息）
     可能落在同一毫秒 —— 只用 ts 会把不同消息误判成同一条，所以键 = role:ts。 */
  function msgKey(m) {
    if (!m) return '';
    var ts = m.timestamp !== undefined && m.timestamp !== null ? String(m.timestamp) : '';
    return String(m.role || '') + ':' + ts;
  }

  function argsText(v) {
    if (v === undefined || v === null) return '{}';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function extractMessage(m) {
    var out = { thinking: '', text: '', toolCalls: [], stopReason: '', model: '', isError: false, toolCallId: '', toolName: '' };
    if (!m || typeof m !== 'object') return out;
    out.stopReason = m.stopReason || '';
    out.model = m.model || '';
    out.isError = !!m.isError;
    out.toolCallId = m.toolCallId || '';
    out.toolName = m.toolName || '';
    var c = m.content;
    if (typeof c === 'string') {
      out.text = c;
    } else if (Array.isArray(c)) {
      for (var i = 0; i < c.length; i++) {
        var b = c[i];
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') out.text += (b.text || '');
        else if (b.type === 'thinking') out.thinking += (b.thinking || '');
        else if (b.type === 'toolCall') {
          out.toolCalls.push({ id: b.id || '', name: b.name || '', argsJson: argsText(b.arguments) });
        }
      }
    }
    return out;
  }

  function firstLine(s, limit) {
    s = String(s === undefined || s === null ? '' : s).split(/\r?\n/)[0] || '';
    limit = limit || 120;
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  }

  /* ================= 行级 LCS diff（edit / write 卡片预览） ================= */

  function splitLines(s) {
    s = String(s === undefined || s === null ? '' : s);
    if (s === '') return [];
    return s.split(/\r\n|\r|\n/);
  }

  /* 返回 [{t:'='|'-'|'+', s:行文本}] */
  function buildDiff(oldText, newText) {
    var a = splitLines(oldText);
    var b = splitLines(newText);
    var start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    var endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    var rows = [];
    var i;
    for (i = 0; i < start; i++) rows.push({ t: '=', s: a[i] });

    var midA = a.slice(start, endA);
    var midB = b.slice(start, endB);
    var n = midA.length, m = midB.length;

    if (n > 0 && m > 0 && n * m <= 400000) {
      var w = m + 1;
      var dp = new Uint32Array((n + 1) * w);
      for (i = n - 1; i >= 0; i--) {
        for (var j = m - 1; j >= 0; j--) {
          if (midA[i] === midB[j]) {
            dp[i * w + j] = dp[(i + 1) * w + j + 1] + 1;
          } else {
            var x = dp[(i + 1) * w + j];
            var y = dp[i * w + j + 1];
            dp[i * w + j] = x >= y ? x : y;
          }
        }
      }
      var p = 0, q = 0;
      while (p < n && q < m) {
        if (midA[p] === midB[q]) { rows.push({ t: '=', s: midA[p] }); p++; q++; }
        else if (dp[(p + 1) * w + q] >= dp[p * w + q + 1]) { rows.push({ t: '-', s: midA[p] }); p++; }
        else { rows.push({ t: '+', s: midB[q] }); q++; }
      }
      while (p < n) { rows.push({ t: '-', s: midA[p] }); p++; }
      while (q < m) { rows.push({ t: '+', s: midB[q] }); q++; }
    } else {
      for (i = 0; i < n; i++) rows.push({ t: '-', s: midA[i] });
      for (i = 0; i < m; i++) rows.push({ t: '+', s: midB[i] });
    }

    for (i = endA; i < a.length; i++) rows.push({ t: '=', s: a[i] });
    return rows;
  }

  function parseArgsJson(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /* 从工具 args 提取 diff 需求：edit → edits[].oldText/newText；write → content */
  function collectDiffSpecs(toolName, argsStr) {
    var specs = [];
    var parsed = parseArgsJson(argsStr);
    if (!parsed || typeof parsed !== 'object') return specs;

    if (toolName === 'edit') {
      var edits = Array.isArray(parsed.edits) ? parsed.edits : null;
      if (!edits && (typeof parsed.oldText === 'string' || typeof parsed.newText === 'string')) {
        edits = [parsed];
      }
      if (edits) {
        for (var i = 0; i < edits.length; i++) {
          var e = edits[i] || {};
          specs.push({
            title: 'edit · ' + (parsed.path || '') + (edits.length > 1 ? ('  #' + (i + 1)) : ''),
            oldText: typeof e.oldText === 'string' ? e.oldText : '',
            newText: typeof e.newText === 'string' ? e.newText : '',
            kind: 'edit'
          });
        }
      }
    } else if (toolName === 'write') {
      if (typeof parsed.content === 'string') {
        specs.push({
          title: '写入 · ' + (parsed.path || ''),
          oldText: '',
          newText: parsed.content,
          kind: 'write'
        });
      }
    }
    return specs;
  }

  /* ================= block 渲染 ================= */

  function atBottom() {
    var m = dom.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 96;
  }

  function scrollToBottom() {
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  function updateEmpty() {
    dom.msgEmpty.hidden = conv.length > 0;
  }

  function createBlockEl(b) {
    var el;
    switch (b.kind) {
      case 'user':
        el = h('div', 'msg user');
        b._text = h('div', 'msg-text');
        el.appendChild(b._text);
        break;

      case 'assistant':
        el = h('div', 'msg assistant');
        b._thinking = h('details', 'thinking');
        b._thSummary = h('summary', null, '思考');
        b._thBody = h('div', 'thinking-body');
        b._thinking.appendChild(b._thSummary);
        b._thinking.appendChild(b._thBody);
        b._text = h('div', 'msg-text');
        b._chips = h('div', 'chips');
        b._chips.hidden = true;
        el.appendChild(b._thinking);
        el.appendChild(b._text);
        el.appendChild(b._chips);
        break;

      case 'tool':
        el = h('div', 'tool-card');
        b._head = h('div', 'tool-head');
        b._caret = h('span', 'tool-caret', '▸');
        b._icon = h('span', 'tool-icon', '⚙');
        b._name = h('span', 'tool-name', b.name || 'tool');
        b._meta = h('span', 'tool-meta');
        b._head.appendChild(b._caret);
        b._head.appendChild(b._icon);
        b._head.appendChild(b._name);
        b._head.appendChild(b._meta);
        b._body = h('div', 'tool-body');
        b._body.hidden = true;
        b._head.addEventListener('click', function () {
          var open = !el.classList.contains('tool-open');
          el.classList.toggle('tool-open', open);
          b._caret.textContent = open ? '▾' : '▸';
          b._body.hidden = !open;
        });
        el.appendChild(b._head);
        el.appendChild(b._body);
        break;

      case 'turn':
        el = h('div', 'turn-sep');
        el.appendChild(h('span', null, b.index ? ('第 ' + b.index + ' 轮') : '——'));
        break;

      case 'run':
        el = h('div', 'run-strip');
        break;

      case 'notice':
        el = h('div', 'notice-line');
        break;

      case 'sysline':
        el = h('div', 'sysline');
        b._span = h('span', 'sysline-body');
        el.appendChild(b._span);
        break;

      default:
        el = h('div');
    }
    updateBlock(b, el);
    return el;
  }

  function updateBlock(b, el) {
    el = el || b._el;
    if (!el) return;

    switch (b.kind) {
      case 'user':
        b._text.textContent = b.text || '';
        break;

      case 'assistant':
        b._text.textContent = b.text || '';
        var hasTh = !!(b.thinking && b.thinking.length);
        b._thinking.hidden = !hasTh;
        if (hasTh) {
          b._thSummary.textContent = b.streaming ? ('思考中… · ' + b.thinking.length + ' 字')
            : ('思考 · ' + b.thinking.length + ' 字');
          b._thBody.textContent = b.thinking;
        }
        var chips = b.pendingTools || [];
        b._chips.textContent = '';
        if (chips.length && b.streaming) {
          b._chips.hidden = false;
          for (var i = 0; i < chips.length; i++) {
            b._chips.appendChild(h('span', 'chip', '⚙ ' + chips[i] + ' …'));
          }
        } else {
          b._chips.hidden = true;
        }
        break;

      case 'tool':
        updateToolBlock(b, el);
        break;

      case 'run':
        updateRunBlock(b, el);
        break;

      case 'notice':
        el.textContent = b.text || '';
        break;

      case 'sysline':
        b._span.textContent = b.text || '';
        el.title = b.title || '';
        break;

      default:
        break;
    }
  }

  function updateToolBlock(b, el) {
    el.classList.toggle('tool-error', !!b.isError && b.hasResult);

    var meta = b._meta;
    meta.classList.remove('meta-run', 'meta-ok', 'meta-err');
    if (b.hasResult) {
      if (b.isError) {
        meta.classList.add('meta-err');
        meta.textContent = '✗ 失败' + (typeof b.durationMs === 'number' ? (' · ' + b.durationMs + 'ms') : '');
      } else {
        meta.classList.add('meta-ok');
        meta.textContent = '✓' + (typeof b.durationMs === 'number' ? (' ' + b.durationMs + 'ms') : '');
      }
    } else if (b.running) {
      meta.classList.add('meta-run');
      meta.textContent = b.partial ? '运行中… 有输出' : '运行中…';
    } else {
      meta.textContent = '';
    }

    // 只在展开时重建 body（流式 partial 更新也只动这里）
    if (b._body.hidden && !b._dirty) return;
    b._dirty = false;

    var body = b._body;
    body.textContent = '';

    var specs = collectDiffSpecs(b.name, b.args || '');
    if (specs.length) {
      for (var i = 0; i < specs.length; i++) {
        body.appendChild(renderDiffBlock(specs[i]));
      }
      var det = h('details');
      det.appendChild(h('summary', 'tool-section-label', 'args 原文'));
      det.appendChild(h('pre', null, prettyArgs(b.args)));
      body.appendChild(det);
    } else {
      body.appendChild(h('div', 'tool-section-label', 'args'));
      body.appendChild(h('pre', null, prettyArgs(b.args)));
    }

    if (b.partial) {
      body.appendChild(h('div', 'tool-section-label', '输出（部分）'));
      var p = h('pre', 'tool-summary-text', String(b.partial).slice(-4096));
      body.appendChild(p);
    }

    if (b.hasResult && b.summary) {
      body.appendChild(h('div', 'tool-section-label', b.isError ? '结果（错误）' : '结果'));
      body.appendChild(h('pre', 'tool-summary-text' + (b.isError ? ' err' : ''), b.summary));
    }
  }

  function prettyArgs(s) {
    var p = parseArgsJson(s);
    if (p !== null && typeof p === 'object') {
      try { return JSON.stringify(p, null, 2); } catch (e) { /* fallthrough */ }
    }
    return String(s || '{}');
  }

  function renderDiffBlock(spec) {
    var wrap = h('div', 'diff-block');
    wrap.appendChild(h('div', 'diff-title', spec.title));
    var body = h('div', 'diff-body');
    var rows = buildDiff(spec.oldText, spec.newText);
    var MAX = 4000;
    var shown = rows.length > MAX ? rows.slice(0, MAX) : rows;
    for (var i = 0; i < shown.length; i++) {
      var r = shown[i];
      var cls = r.t === '+' ? 'diff-line d-add' : (r.t === '-' ? 'diff-line d-del' : 'diff-line d-ctx');
      var prefix = r.t === '+' ? '+' : (r.t === '-' ? '-' : ' ');
      body.appendChild(h('div', cls, prefix + ' ' + r.s));
    }
    if (rows.length > MAX) {
      body.appendChild(h('div', 'diff-line d-ctx', '…（共 ' + rows.length + ' 行，仅显示前 ' + MAX + ' 行）'));
    }
    wrap.appendChild(body);
    return wrap;
  }

  function updateRunBlock(b, el) {
    el.classList.remove('run-on', 'run-ok', 'run-err');
    el.textContent = '';
    if (b.state === 'running') {
      el.classList.add('run-on');
      el.appendChild(h('span', null, '● 运行中…'));
      return;
    }
    if (b.ok) {
      el.classList.add('run-ok');
      el.appendChild(h('span', null, '✓ 完成'));
    } else {
      el.classList.add('run-err');
      el.appendChild(h('span', null, '✗ ' + (b.stopReason === 'aborted' ? '已停止' : '未完成')));
    }
    var detail = [];
    if (typeof b.turns === 'number') detail.push(b.turns + ' 轮');
    if (typeof b.usageIn === 'number' || typeof b.usageOut === 'number') {
      detail.push('tokens ↑' + fmtTokens(b.usageIn) + ' ↓' + fmtTokens(b.usageOut));
    }
    if (b.stopReason) detail.push('stopReason: ' + b.stopReason);
    if (detail.length) el.appendChild(h('span', 'rs-detail', detail.join(' · ')));
    if (b.error) el.appendChild(h('span', 'rs-warn', String(b.error)));
    if (Array.isArray(b.warnings)) {
      for (var i = 0; i < b.warnings.length && i < 6; i++) {
        el.appendChild(h('span', 'rs-warn', '⚠ ' + String(b.warnings[i])));
      }
    }
    if (b.compactNote) el.appendChild(h('span', 'rs-detail', '〔压缩〕' + String(b.compactNote)));
  }

  function pushBlock(b) {
    conv.push(b);
    b._el = createBlockEl(b);
    dom.msgList.appendChild(b._el);
    updateEmpty();
    if (atBottom()) scrollToBottom();
    return b;
  }

  function touchBlock(b) {
    var wasBottom = atBottom();
    updateBlock(b);
    if (wasBottom) scrollToBottom();
  }

  function removeBlock(b) {
    var idx = conv.indexOf(b);
    if (idx >= 0) conv.splice(idx, 1);
    if (b._el && b._el.parentNode) b._el.parentNode.removeChild(b._el);
    updateEmpty();
  }

  function renderAll() {
    dom.msgList.textContent = '';
    for (var i = 0; i < conv.length; i++) {
      conv[i]._el = createBlockEl(conv[i]);
      dom.msgList.appendChild(conv[i]._el);
    }
    updateEmpty();
    scrollToBottom();
  }

  /* ================= entries 全量重放（§4 / 分支回溯） ================= */

  function rebuildFromEntries(payload) {
    var entries = (payload && payload.entries) || [];
    var leafId = (payload && payload.leafId) || '';

    // 分支回溯：leafId 沿 parentId 到根，再反转
    var byId = Object.create(null);
    var i;
    for (i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].id) byId[entries[i].id] = entries[i];
    }
    var chain = [];
    var cur = leafId;
    var guard = 0;
    while (cur && guard < 10000) {
      guard++;
      var e = byId[cur];
      if (!e) break;
      chain.push(e);
      cur = e.parentId || '';
    }
    chain.reverse();

    // 重置展示模型与防重放账本
    conv = [];
    curAssistant = null;
    suspendTs = null;
    seenTs = Object.create(null);
    seenCalls = Object.create(null);

    for (i = 0; i < chain.length; i++) {
      appendEntryBlocks(chain[i]);
    }
    renderAll();
  }

  function appendEntryBlocks(e) {
    if (!e || typeof e !== 'object') return;

    if (e.type === 'message') {
      var m = e.message;
      if (!m) return;
      var mkey = msgKey(m);
      if (mkey && mkey.indexOf(':') > 0) seenTs[mkey] = 1;
      if (m.role === 'system') return; // 提示词快照不进对话视图

      var info = extractMessage(m);
      if (m.role === 'user') {
        pushBlock({ kind: 'user', text: info.text });
      } else if (m.role === 'assistant') {
        pushBlock({
          kind: 'assistant',
          thinking: info.thinking,
          text: info.text,
          pendingTools: [],
          streaming: false
        });
        for (var t = 0; t < info.toolCalls.length; t++) {
          var tc = info.toolCalls[t];
          var card = {
            kind: 'tool',
            callId: tc.id,
            name: tc.name,
            args: tc.argsJson,
            running: true,
            hasResult: false,
            isError: false,
            summary: '',
            _dirty: true
          };
          if (tc.id) seenCalls[tc.id] = card;
          pushBlock(card);
        }
      } else if (m.role === 'toolResult' || m.role === 'tool') {
        // 不单独画块：把结果补进对应工具卡
        if (m.toolCallId && seenCalls[m.toolCallId]) {
          var card2 = seenCalls[m.toolCallId];
          card2.running = false;
          card2.hasResult = true;
          card2.isError = !!m.isError;
          card2.summary = info.text;
          if (card2._el) updateBlock(card2);
        }
      }
      return;
    }

    if (e.type === 'compaction') {
      var sum = String(e.summary || '');
      pushBlock({
        kind: 'sysline',
        text: '已压缩为摘要：' + firstLine(sum, 90),
        title: sum
      });
      return;
    }
    if (e.type === 'model_change') {
      pushBlock({ kind: 'sysline', text: '模型切换 → ' + (e.modelId || '') });
      return;
    }
    if (e.type === 'session_info' && e.name) {
      pushBlock({ kind: 'sysline', text: '会话名：' + e.name });
      return;
    }
    // custom（审批留痕等）不进对话视图
  }

  /* ================= 事件处理（§2.1 / §2.2） ================= */

  function handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {

      case 'run_start': {
        running = true;
        renderRunningLight();
        renderComposerMode();
        var last = conv[conv.length - 1];
        if (!(last && last.kind === 'run' && last.state === 'running')) {
          pushBlock({ kind: 'run', state: 'running' });
        }
        break;
      }

      case 'run_end': {
        running = false;
        renderRunningLight();
        renderComposerMode();
        // 用量顺手更新顶栏（state.usageLast 同义）
        if (state) {
          state.usageLast = { 'in': finiteNum(ev.usageIn, 0), out: finiteNum(ev.usageOut, 0) };
          renderTopbar();
        }
        var target = null;
        for (var i = conv.length - 1; i >= 0; i--) {
          if (conv[i].kind === 'run') { target = conv[i]; break; }
        }
        if (!target) {
          target = pushBlock({ kind: 'run', state: 'done' });
        }
        target.state = 'done';
        target.ok = !!ev.ok;
        target.stopReason = ev.stopReason || '';
        target.error = ev.error || '';
        target.turns = finiteNum(ev.turns, undefined);
        target.usageIn = finiteNum(ev.usageIn, 0);
        target.usageOut = finiteNum(ev.usageOut, 0);
        target.warnings = Array.isArray(ev.warnings) ? ev.warnings : [];
        target.compactNote = ev.compactNote || '';
        touchBlock(target);
        break;
      }

      case 'notice': {
        pushBlock({ kind: 'notice', text: String(ev.text || '') });
        break;
      }

      case 'approval_request': {
        if (!state) state = {};
        state.approval = { id: ev.id, kind: ev.kind, value: ev.value, detail: ev.detail };
        renderApproval();
        break;
      }

      case 'approval_resolved': {
        if (state && state.approval && String(state.approval.id) === String(ev.id)) {
          state.approval = null;
          renderApproval();
        }
        break;
      }

      case 'agent_start':
        break;

      case 'agent_end':
        // running 的真值交给 run_end / state；这里只兜底 stopReason 展示
        break;

      case 'turn_start': {
        pushBlock({ kind: 'turn', index: finiteNum(ev.index, 0) });
        break;
      }

      case 'turn_end':
        break;

      case 'message_start': {
        var m0 = ev.message;
        if (!m0) break;
        var key0 = msgKey(m0);
        if (key0 && seenTs[key0]) {
          // 该消息已由 entries 画过：进入挂起态，等它的 message_end，跳过中间增量
          if (m0.role === 'assistant') {
            suspendTs = key0;
            curAssistant = null;
          }
          break;
        }
        if (m0.role === 'user') {
          if (key0) seenTs[key0] = 1;
          pushBlock({ kind: 'user', text: extractMessage(m0).text });
        } else if (m0.role === 'assistant') {
          if (key0) seenTs[key0] = 1;
          curAssistant = pushBlock({
            kind: 'assistant', thinking: '', text: '', pendingTools: [], streaming: true
          });
          curAssistant.msgTs = key0; // message_end 用它区分「本条流式收尾」与「entries 已有」
        } else if (m0.role === 'toolResult' || m0.role === 'tool') {
          if (key0) seenTs[key0] = 1;
        }
        break;
      }

      case 'message_update': {
        if (suspendTs) break; // 挂起消息的增量（entries 已有全量）
        var m1 = ev.message;
        if (!m1) break;
        if (m1.role !== 'assistant') break;
        var key1 = msgKey(m1);
        if (key1 && seenTs[key1]) break;

        if (!curAssistant) {
          // message_start 丢失（对账窗口）：用 partial message 兜底建块
          curAssistant = pushBlock({
            kind: 'assistant', thinking: '', text: '', pendingTools: [], streaming: true
          });
          curAssistant.msgTs = null; // 与最终 message_end 的 ts 不同；收尾走「兜底建块」分支
        }
        var info1 = extractMessage(m1);
        var names = [];
        for (var c = 0; c < info1.toolCalls.length; c++) names.push(info1.toolCalls[c].name || 'tool');
        curAssistant.thinking = info1.thinking;
        curAssistant.text = info1.text;
        curAssistant.pendingTools = names;
        touchBlock(curAssistant);
        break;
      }

      case 'message_end': {
        var m2 = ev.message;
        if (!m2) break;
        var key2 = msgKey(m2);

        if (suspendTs) {
          if (key2 === suspendTs) { suspendTs = null; curAssistant = null; }
          break;
        }

        // 本条流式消息的正常收尾（键与 message_start 一致）
        if (m2.role === 'assistant' && curAssistant && key2 === curAssistant.msgTs) {
          var infoFin = extractMessage(m2);
          if (key2) seenTs[key2] = 1;
          curAssistant.thinking = infoFin.thinking;
          curAssistant.text = infoFin.text;
          curAssistant.pendingTools = [];
          curAssistant.streaming = false;
          touchBlock(curAssistant);
          curAssistant = null;
          break;
        }

        if (key2 && seenTs[key2]) {
          // entries 已画过；若增量曾兜底建了块，撤掉防重复
          if (m2.role === 'assistant') {
            if (curAssistant && curAssistant.streaming) removeBlock(curAssistant);
            curAssistant = null;
          }
          break;
        }

        var info2 = extractMessage(m2);
        if (m2.role === 'assistant') {
          if (key2) seenTs[key2] = 1;
          if (!curAssistant) {
            // message_start 丢失（对账窗口）：按全量消息兜底建块
            curAssistant = pushBlock({
              kind: 'assistant', thinking: '', text: '', pendingTools: [], streaming: true
            });
          }
          curAssistant.thinking = info2.thinking;
          curAssistant.text = info2.text;
          curAssistant.pendingTools = [];
          curAssistant.streaming = false;
          touchBlock(curAssistant);
          curAssistant = null;
        } else if (m2.role === 'user') {
          if (key2) seenTs[key2] = 1;
          // 气泡已在 message_start 画好（禁止乐观渲染）
        } else if (m2.role === 'toolResult' || m2.role === 'tool') {
          if (key2) seenTs[key2] = 1;
          // 补工具卡结果（若 tool_execution_end 在对账窗口丢了）
          if (m2.toolCallId && seenCalls[m2.toolCallId]) {
            var card3 = seenCalls[m2.toolCallId];
            if (!card3.hasResult) {
              card3.running = false;
              card3.hasResult = true;
              card3.isError = !!m2.isError;
              card3.summary = info2.text;
              if (card3._el) updateBlock(card3);
            }
          }
        }
        break;
      }

      case 'tool_execution_start': {
        var id = ev.toolCallId || '';
        var card4 = id ? seenCalls[id] : null;
        if (card4) {
          if (!card4.hasResult) {
            card4.running = true;
            card4.args = typeof ev.args === 'string' ? ev.args : argsText(ev.args);
            card4._dirty = true;
            if (card4._el) updateBlock(card4);
          }
          break;
        }
        card4 = {
          kind: 'tool',
          callId: id,
          name: ev.toolName || 'tool',
          args: typeof ev.args === 'string' ? ev.args : argsText(ev.args),
          running: true,
          hasResult: false,
          isError: false,
          summary: '',
          _dirty: true
        };
        if (id) seenCalls[id] = card4;
        pushBlock(card4);
        break;
      }

      case 'tool_execution_update': {
        var idU = ev.toolCallId || '';
        var cardU = idU ? seenCalls[idU] : null;
        if (cardU) {
          cardU.partial = String(ev.partialResult || '');
          if (cardU._el) updateBlock(cardU);
        }
        break;
      }

      case 'tool_execution_end': {
        var idE = ev.toolCallId || '';
        var cardE = idE ? seenCalls[idE] : null;
        if (!cardE) {
          cardE = {
            kind: 'tool',
            callId: idE,
            name: ev.toolName || 'tool',
            args: '',
            running: false,
            hasResult: true,
            isError: !!ev.isError,
            summary: String(ev.summary || ''),
            durationMs: finiteNum(ev.durationMs, undefined),
            _dirty: true
          };
          if (idE) seenCalls[idE] = cardE;
          pushBlock(cardE);
          break;
        }
        cardE.running = false;
        cardE.hasResult = true;
        cardE.isError = !!ev.isError;
        cardE.summary = String(ev.summary || '');
        cardE.durationMs = finiteNum(ev.durationMs, undefined);
        cardE._dirty = true;
        if (cardE._el) updateBlock(cardE);
        break;
      }

      default:
        // 未知事件类型一律忽略（契约 §2.1）
        break;
    }
  }

  /* ================= 事件循环（§2：唯一实时通道） ================= */

  function reconcile() {
    // 恢复 / 重置后对账：state + entries
    return apiGet('/api/state').then(function (st) {
      setState(st);
      return apiGet('/api/entries');
    }).then(function (entries) {
      rebuildFromEntries(entries);
    });
  }

  function eventLoop() {
    if (loopStarted) return;
    loopStarted = true;

    function step() {
      apiPost('/api/events', { since: cursor }).then(function (resp) {
        if (offline) setOffline(false);

        if (resp.reset) {
          // 落后太多被淘汰：丢弃本地历史，改用 entries 重建，从 next 续轮
          cursor = finiteNum(resp.next, cursor);
          return reconcile().catch(function () { /* 下一轮走网络错误路径 */ });
        }

        var events = Array.isArray(resp.events) ? resp.events : [];
        for (var i = 0; i < events.length; i++) {
          var ev = events[i];
          try {
            if (ev && typeof ev.seq === 'number' && ev.seq > cursor) cursor = ev.seq;
            handleEvent(ev);
          } catch (e) {
            if (window.console) console.warn('事件处理失败', ev && ev.type, e);
          }
        }
        if (typeof resp.next === 'number' && isFinite(resp.next)) {
          cursor = resp.next;
        }
        backoff = 1000;
      }).catch(function () {
        // 网络错误：指数退避（1s 起，上限 10s），恢复后先 state + entries 对账
        if (!offline) setOffline(true, '等待内核…');
        var wait = backoff;
        backoff = Math.min(backoff * 2, 10000);
        sleep(wait).then(function () {
          return reconcile();
        }).then(function () {
          if (offline) setOffline(false);
          backoff = 1000;
        }).catch(function () {
          // 内核仍未恢复：保持横幅，继续退避
        }).then(function () {
          step();
        });
      });
    }

    step();
  }

  /* ================= 启动（内核未就绪则退避重试，不白屏） ================= */

  function boot() {
    if (booted) return;

    function attempt() {
      // 先探一次事件游标：把 serve 启动以来的历史事件丢掉（干净起点），
      // 游标取 next；失败不致命，后面 state 会再失败并进重试。
      return apiPost('/api/events', { since: 0 }).catch(function () { return null; })
        .then(function (probe) {
          if (probe && typeof probe.next === 'number' && isFinite(probe.next)) {
            cursor = probe.next;
          }
          return apiGet('/api/state');
        })
        .then(function (st) {
          setState(st);
          return apiGet('/api/entries');
        })
        .then(function (entries) {
          rebuildFromEntries(entries);
          return apiGet('/api/sessions').catch(function () {
            return { current: '', sessions: [] };
          });
        })
        .then(function (ses) {
          sessionsData = ses || { current: '', sessions: [] };
          renderSessions();
          booted = true;
          setOffline(false);
          eventLoop();
        });
    }

    function retryLoop() {
      attempt().catch(function () {
        if (!offline) setOffline(true, '等待内核…');
        var wait = backoff;
        backoff = Math.min(backoff * 2, 10000);
        sleep(wait).then(retryLoop);
      });
    }
    retryLoop();
  }

  /* ================= 会话列表（§4） ================= */

  function baseNameOf(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/);
    var last = parts[parts.length - 1] || '';
    return last.replace(/\.jsonl$/i, '');
  }

  function renderSessions() {
    var list = dom.sessionList;
    list.textContent = '';
    var items = sessionsData.sessions || [];
    if (!items.length) {
      list.appendChild(h('div', 'side-empty', booted ? '还没有会话' : '等待内核…'));
      return;
    }
    var activeId = baseNameOf(sessionsData.current);
    // 契约：新在后。倒序展示（新的在上），保持数据源语义不改。
    for (var i = items.length - 1; i >= 0; i--) {
      (function (s) {
        var b = h('button', 'session-item' + (s.id === activeId ? ' active' : ''), s.label || s.id);
        b.title = s.id;
        b.addEventListener('click', function () { resumeSession(s.id); });
        list.appendChild(b);
      })(items[i]);
    }
  }

  function refreshAfterSessionChange() {
    return apiGet('/api/state').then(function (st) {
      setState(st);
      return apiGet('/api/entries');
    }).then(function (entries) {
      rebuildFromEntries(entries);
      return apiGet('/api/sessions').catch(function () { return null; });
    }).then(function (ses) {
      if (ses) { sessionsData = ses; renderSessions(); }
    });
  }

  function resumeSession(id) {
    apiPost('/api/session/resume', { id: id }).then(function () {
      return refreshAfterSessionChange();
    }).catch(function (e) {
      if (e.status === 409) toast('运行中不能切换会话', 'err');
      else if (e.status === 404) toast('会话不存在：' + id, 'err');
      else toast(e.message || '切换会话失败', 'err');
    });
  }

  function newSession() {
    apiPost('/api/session/new', {}).then(function () {
      return refreshAfterSessionChange();
    }).catch(function (e) {
      if (e.status === 409) toast('运行中不能新建会话', 'err');
      else toast(e.message || '新建会话失败', 'err');
    });
  }

  /* ================= 工作区（§5 workspace） ================= */

  function pickWorkspace() {
    var lum = window.lumin;
    if (!lum || !lum.dlg || typeof lum.dlg.pickDirectory !== 'function') {
      toast('目录对话框需要 Electron 壳（window.lumin）', 'err');
      return;
    }
    Promise.resolve(lum.dlg.pickDirectory('选择工作区目录')).then(function (dir) {
      if (!dir) return; // 用户取消
      return apiPost('/api/workspace', { path: dir }).then(function (st) {
        setState(st);
        toast('工作区已切换', 'ok');
        // 工作区变了，会话列表通常也跟着变
        return apiGet('/api/sessions').catch(function () { return null; }).then(function (ses) {
          if (ses) { sessionsData = ses; renderSessions(); }
        });
      });
    }).catch(function (e) {
      if (e.status === 409) toast('运行中不能切换工作区', 'err');
      else toast(e.message || '切换工作区失败', 'err');
    });
  }

  /* ================= 视图切换 ================= */

  function switchView(name) {
    if (!dom.views[name]) return;
    activeView = name;
    Object.keys(dom.views).forEach(function (k) {
      dom.views[k].hidden = k !== name;
    });
    var btns = dom.nav.querySelectorAll('.nav-item');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-view') === name);
    }

    if (name === 'tree') loadTree();
    else if (name === 'skills') loadSkills();
    else if (name === 'settings') loadSettings();
    else if (name === 'terminal') ensureTerminal();
  }

  /* ================= 会话树（§4：entries 全量构树 + fork） ================= */

  var treeEntriesCache = null;

  function entryTimeText(ts) {
    if (!ts) return '';
    var s = String(ts);
    var d = new Date(s);
    if (!isNaN(d.getTime())) {
      function pad(n) { return n < 10 ? '0' + n : String(n); }
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    // Cangjie DateTime 字符串兜底：取时间部分
    var m = s.match(/\d{2}:\d{2}:\d{2}/);
    return m ? m[0] : s.slice(0, 19);
  }

  var ENTRY_BADGES = {
    user: ['用户', 'b-user'],
    assistant: ['助手', 'b-assistant'],
    toolResult: ['工具结果', 'b-tool'],
    tool: ['工具结果', 'b-tool'],
    system: ['系统', '']
  };

  function entryBadge(e) {
    if (e.type === 'message' && e.message) {
      var found = ENTRY_BADGES[e.message.role];
      if (found) return found;
      return [String(e.message.role || '消息'), ''];
    }
    if (e.type === 'compaction') return ['压缩', ''];
    if (e.type === 'model_change') return ['模型', ''];
    if (e.type === 'session_info') return ['会话名', ''];
    if (e.type === 'custom') return ['记录', ''];
    return [String(e.type || 'entry'), ''];
  }

  function entrySummary(e) {
    if (e.type === 'message' && e.message) {
      var info = extractMessage(e.message);
      if (e.message.role === 'toolResult' || e.message.role === 'tool') {
        return (e.message.toolName || 'tool') + ' → ' + firstLine(info.text, 100);
      }
      if (e.message.role === 'system') return '（提示词快照）' + (info.text ? ' ' + firstLine(info.text, 60) : '');
      var body = info.text || info.thinking || '';
      if (!body && info.toolCalls.length) {
        return info.toolCalls.map(function (t) { return t.name; }).join(', ');
      }
      return firstLine(body, 120);
    }
    if (e.type === 'compaction') return firstLine(e.summary || '', 120);
    if (e.type === 'model_change') return '切换到 ' + (e.modelId || '');
    if (e.type === 'session_info') return String(e.name || '');
    if (e.type === 'custom') return String(e.customType || '');
    return JSON.stringify(e).slice(0, 100);
  }

  function loadTree() {
    dom.treeBody.textContent = '';
    dom.treeBody.appendChild(h('div', 'side-empty', '加载中…'));
    apiGet('/api/entries').then(function (data) {
      treeEntriesCache = data;
      renderTree(data);
    }).catch(function (e) {
      dom.treeBody.textContent = '';
      dom.treeBody.appendChild(h('div', 'side-empty', '加载失败：' + (e.message || e)));
    });
  }

  function renderTree(data) {
    var entries = (data && data.entries) || [];
    var leafId = (data && data.leafId) || '';
    dom.treeBody.textContent = '';

    if (!entries.length) {
      dom.treeBody.appendChild(h('div', 'side-empty', '这个会话还没有任何条目。'));
      return;
    }

    var childrenOf = Object.create(null);
    var roots = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !e.id) continue;
      var pid = e.parentId || '';
      if (pid) {
        if (!childrenOf[pid]) childrenOf[pid] = [];
        childrenOf[pid].push(e);
      } else {
        roots.push(e);
      }
    }

    function renderNode(e, depth) {
      var row = h('div', 'tree-row');
      row.style.paddingLeft = (8 + depth * 16) + 'px';
      if (e.id === leafId) row.classList.add('is-leaf');

      var badgeInfo = entryBadge(e);
      row.appendChild(h('span', 'tree-badge ' + (badgeInfo[1] || ''), badgeInfo[0]));
      row.appendChild(h('span', 'tree-time', entryTimeText(e.timestamp)));
      row.appendChild(h('span', 'tree-summary', entrySummary(e)));

      if (e.type === 'message' && e.message && e.message.role !== 'system') {
        row.classList.add('clickable');
        row.title = '点击：回退到这条，其后开新分支';
        row.addEventListener('click', function () { forkTo(e.id, row); });
      } else {
        row.title = e.id;
      }

      dom.treeBody.appendChild(row);

      var kids = childrenOf[e.id] || [];
      for (var k = 0; k < kids.length; k++) renderNode(kids[k], depth + 1);
    }

    for (var r = 0; r < roots.length; r++) renderNode(roots[r], 0);
  }

  function showTreeNotice(text) {
    dom.treeNotice.textContent = text;
    dom.treeNotice.hidden = false;
    setTimeout(function () { dom.treeNotice.hidden = true; }, 6000);
  }

  function forkTo(entryId, row) {
    if (row) row.style.pointerEvents = 'none';
    apiPost('/api/fork', { entryId: entryId }).then(function () {
      // fork 后按新 entries 全量重画
      return apiGet('/api/entries').then(function (data) {
        treeEntriesCache = data;
        rebuildFromEntries(data);
        renderTree(data);
        showTreeNotice('已回退，其后将开新分支');
        toast('已回退，其后将开新分支', 'ok');
      });
    }).catch(function (e) {
      if (e.status === 409) toast('运行中不能回退', 'err');
      else toast(e.message || '回退失败', 'err');
    }).then(function () {
      if (row) row.style.pointerEvents = '';
    });
  }

  /* ================= 技能面板（§5 skills） ================= */

  var skillCache = Object.create(null); // name -> body

  function loadSkills() {
    dom.skillsBody.textContent = '';
    dom.skillsBody.appendChild(h('div', 'side-empty', '加载中…'));
    apiGet('/api/skills').then(function (data) {
      renderSkills((data && data.skills) || []);
    }).catch(function (e) {
      dom.skillsBody.textContent = '';
      dom.skillsBody.appendChild(h('div', 'side-empty', '加载失败：' + (e.message || e)));
    });
  }

  function renderSkills(list) {
    dom.skillsBody.textContent = '';
    if (!list.length) {
      dom.skillsBody.appendChild(h('div', 'side-empty', '没有发现技能。'));
      return;
    }
    list.forEach(function (s) {
      var item = h('div', 'skill-item');
      var head = h('div', 'skill-head');
      head.appendChild(h('span', 'skill-name', s.name || ''));
      head.appendChild(h('span', 'skill-desc', s.description || ''));
      if (s.manualOnly) head.appendChild(h('span', 'skill-tag', '仅手动'));
      item.appendChild(head);

      var body = h('div', 'skill-body');
      body.hidden = true;
      var pre = h('pre', null, '加载中…');
      body.appendChild(pre);
      item.appendChild(body);

      head.addEventListener('click', function () {
        var open = !body.hidden;
        if (open) {
          body.hidden = true;
          item.classList.remove('open');
          return;
        }
        body.hidden = false;
        item.classList.add('open');
        if (skillCache[s.name]) {
          pre.textContent = skillCache[s.name];
          return;
        }
        pre.textContent = '加载中…';
        apiPost('/api/skill', { name: s.name }).then(function (data) {
          var text = String((data && data.body) || '');
          skillCache[s.name] = text;
          pre.textContent = text;
        }).catch(function (e) {
          pre.textContent = '加载失败：' + (e.message || e);
        });
      });

      dom.skillsBody.appendChild(item);
    });
  }

  /* ================= 设置面板（§5） ================= */

  var settingsRefs = {};

  function applyStateIfState(resp) {
    // §5：多数设置接口成功时返回完整 state；compact/skill 等另行注明的除外
    if (resp && typeof resp === 'object' && typeof resp.running === 'boolean') {
      setState(resp);
      return true;
    }
    return false;
  }

  function loadSettings() {
    dom.settingsBody.textContent = '';
    dom.settingsBody.appendChild(h('div', 'side-empty', '加载中…'));
    apiGet('/api/state').then(function (st) {
      setState(st);
      return apiGet('/api/approvals').catch(function () { return null; });
    }).then(function (approvals) {
      renderSettings(approvals);
    }).catch(function (e) {
      dom.settingsBody.textContent = '';
      dom.settingsBody.appendChild(h('div', 'side-empty', '加载失败：' + (e.message || e)));
    });
  }

  function setRow(parent, label, valueEl) {
    var row = h('div', 'set-row');
    row.appendChild(h('span', 'set-label', label));
    if (typeof valueEl === 'string' || typeof valueEl === 'number') {
      row.appendChild(h('span', 'set-value', String(valueEl)));
    } else {
      row.appendChild(valueEl);
    }
    parent.appendChild(row);
    return row;
  }

  function renderSettings(approvals) {
    settingsRefs = {};
    var st = state || {};
    var body = dom.settingsBody;
    body.textContent = '';
    var inner = h('div', 'settings-inner');
    body.appendChild(inner);

    /* ---- 运行状态 ---- */
    var sec1 = h('div', 'set-section');
    sec1.appendChild(h('h3', null, '运行状态'));
    setRow(sec1, 'API Key', h('span', 'set-value ' + (st.keyConfigured ? 'v-ok' : 'v-bad'),
      st.keyConfigured ? '已配置' : '未配置'));
    setRow(sec1, 'Base URL', h('span', 'set-value', st.base || '—'));
    setRow(sec1, '模型', h('span', 'set-value', st.model || '—'));
    setRow(sec1, '模式', h('span', 'set-value',
      (st.modeTitle || st.mode || '—') + (st.modeDescription ? ('（' + st.modeDescription + '）') : '')));
    setRow(sec1, '权限档位', h('span', 'set-value', st.permissionText || st.permissions || '—'));
    setRow(sec1, '工作区', h('span', 'set-value', st.workspace || '—'));
    setRow(sec1, '当前会话', h('span', 'set-value', (st.session && st.session.id) || '—'));
    setRow(sec1, '信任', h('span', 'set-value', st.trust
      ? (st.trust.trusted ? '已信任' : (st.trust.decided ? '未信任' : '未决定'))
      : '—'));
    setRow(sec1, '联网', h('span', 'set-value', st.webSearch ? '开' : '关'));
    setRow(sec1, '技能数', h('span', 'set-value', String(finiteNum(st.skillsCount, 0))));
    setRow(sec1, '允许执行', h('span', 'set-value', st.allowExec ? '是' : '否'));
    var keyNote = h('div', 'set-note', 'Key / BaseURL 不在界面修改：编辑 ' + luminRootHint() + ' 后重启。');
    sec1.appendChild(keyNote);
    inner.appendChild(sec1);

    /* ---- 模式 ---- */
    var sec2 = h('div', 'set-section');
    sec2.appendChild(h('h3', null, '模式'));
    var modeSel = h('select', 'set-select');
    [['chat', '纯对话'], ['standard', '标准'], ['research', '研究'], ['agent', '代理']].forEach(function (p) {
      var o = h('option', null, p[0] + ' — ' + p[1]);
      o.value = p[0];
      if (p[0] === st.mode) o.selected = true;
      modeSel.appendChild(o);
    });
    modeSel.addEventListener('change', function () {
      modeSel.disabled = true;
      apiPost('/api/mode', { mode: modeSel.value }).then(function (resp) {
        if (!applyStateIfState(resp)) return apiGet('/api/state').then(setState);
      }).catch(function (e) {
        toast(e.message || '切换模式失败', 'err');
      }).then(function () {
        modeSel.disabled = false;
        if (state) modeSel.value = state.mode;
      });
    });
    setRow(sec2, '当前模式', modeSel);
    if (st.modeDescription) {
      sec2.appendChild(h('div', 'set-note', st.modeDescription));
    }
    inner.appendChild(sec2);

    /* ---- 权限 ---- */
    var sec3 = h('div', 'set-section');
    sec3.appendChild(h('h3', null, '权限档位'));
    var seg = h('div', 'seg');
    var permBtns = {};
    [['ask', '请求批准'], ['auto', '帮我批准'], ['full', '完全访问权限']].forEach(function (p) {
      var b = h('button', st.permissions === p[0] ? 'active' : '', p[1]);
      permBtns[p[0]] = b;
      b.addEventListener('click', function () {
        if (b.classList.contains('active')) return;
        Object.keys(permBtns).forEach(function (k) { permBtns[k].disabled = true; });
        apiPost('/api/permissions', { level: p[0] }).then(function (resp) {
          if (!applyStateIfState(resp)) return apiGet('/api/state').then(setState);
        }).catch(function (e) {
          toast(e.message || '设置权限失败', 'err');
        }).then(function () {
          Object.keys(permBtns).forEach(function (k) {
            permBtns[k].disabled = false;
            permBtns[k].classList.toggle('active', state && state.permissions === k);
          });
        });
      });
      seg.appendChild(b);
    });
    setRow(sec3, '权限', seg);
    inner.appendChild(sec3);

    /* ---- 模型 ---- */
    var sec4 = h('div', 'set-section');
    sec4.appendChild(h('h3', null, '模型'));
    var modelInput = h('input', 'set-input mono');
    modelInput.value = st.model || '';
    var modelBtn = h('button', 'btn btn-sm', '应用');
    modelBtn.addEventListener('click', function () {
      var v = modelInput.value.trim();
      if (!v) return;
      modelBtn.disabled = true;
      apiPost('/api/model', { model: v }).then(function (resp) {
        if (!applyStateIfState(resp)) return apiGet('/api/state').then(setState);
        toast('模型已切换', 'ok');
      }).catch(function (e) {
        toast(e.message || '切换模型失败', 'err');
      }).then(function () {
        modelBtn.disabled = false;
        if (state) modelInput.value = state.model || '';
      });
    });
    var rowM = h('div', 'set-row');
    rowM.appendChild(h('span', 'set-label', '模型名'));
    rowM.appendChild(modelInput);
    rowM.appendChild(modelBtn);
    sec4.appendChild(rowM);
    inner.appendChild(sec4);

    /* ---- 信任 ---- */
    var sec5 = h('div', 'set-section');
    sec5.appendChild(h('h3', null, '信任'));
    var trustSeg = h('div', 'seg');
    var tOn = h('button', st.trust && st.trust.trusted ? 'active' : '', '信任');
    var tOff = h('button', st.trust && st.trust.trusted ? '' : 'active', '不信任');
    function setTrust(on) {
      tOn.disabled = tOff.disabled = true;
      apiPost('/api/trust', { on: on }).then(function (resp) {
        if (!applyStateIfState(resp)) return apiGet('/api/state').then(setState);
      }).catch(function (e) {
        toast(e.message || '设置信任失败', 'err');
      }).then(function () {
        tOn.disabled = tOff.disabled = false;
        var trusted = state && state.trust && state.trust.trusted;
        tOn.classList.toggle('active', !!trusted);
        tOff.classList.toggle('active', !trusted);
      });
    }
    tOn.addEventListener('click', function () { setTrust(true); });
    tOff.addEventListener('click', function () { setTrust(false); });
    trustSeg.appendChild(tOn);
    trustSeg.appendChild(tOff);
    setRow(sec5, '工作区信任', trustSeg);
    inner.appendChild(sec5);

    /* ---- 压缩 ---- */
    var sec6 = h('div', 'set-section');
    sec6.appendChild(h('h3', null, '上下文压缩'));
    var compRow = h('div', 'set-row');
    var compBtn = h('button', 'btn btn-sm', '立即压缩');
    var compNote = h('span', 'set-value', '');
    compBtn.addEventListener('click', function () {
      compBtn.disabled = true;
      compNote.textContent = '压缩中…';
      apiPost('/api/compact', {}).then(function (data) {
        compNote.textContent = (data && data.note) || '完成';
        toast((data && data.note) || '压缩完成', 'ok');
      }).catch(function (e) {
        compNote.textContent = '';
        toast(e.message || '压缩失败', 'err');
      }).then(function () { compBtn.disabled = false; });
    });
    compRow.appendChild(compBtn);
    compRow.appendChild(compNote);
    sec6.appendChild(compRow);
    sec6.appendChild(h('div', 'set-note', '把较早的对话摘要成一段文字；原文仍在会话文件里，只是不再进模型上下文。'));
    inner.appendChild(sec6);

    /* ---- 系统提示词 ---- */
    var sec7 = h('div', 'set-section');
    sec7.appendChild(h('h3', null, '系统提示词'));
    var pRow = h('div', 'set-row');
    var pBtn = h('button', 'btn btn-sm', '载入当前提示词');
    var pPre = h('pre', 'prompt-pre', '（点击载入）');
    pPre.style.display = 'none';
    pBtn.addEventListener('click', function () {
      pBtn.disabled = true;
      pPre.style.display = '';
      pPre.textContent = '加载中…';
      apiGet('/api/prompt').then(function (data) {
        pPre.textContent = (data && data.text) || '（空）';
      }).catch(function (e) {
        pPre.textContent = '加载失败：' + (e.message || e);
      }).then(function () { pBtn.disabled = false; });
    });
    pRow.appendChild(pBtn);
    sec7.appendChild(pRow);
    sec7.appendChild(pPre);
    inner.appendChild(sec7);

    /* ---- 审批统计与规则 ---- */
    var sec8 = h('div', 'set-section');
    sec8.appendChild(h('h3', null, '审批'));
    var stats = h('div', 'approve-stats');
    function fillStats(a) {
      stats.textContent = '';
      var aa = a || {};
      [['询问', aa.ask], ['放行', aa.allow], ['拒绝', aa.deny]].forEach(function (p) {
        var chip = h('span', 'stat-chip', p[0]);
        chip.appendChild(h('b', null, String(finiteNum(p[1], 0))));
        stats.appendChild(chip);
      });
    }
    fillStats(approvals);
    sec8.appendChild(stats);

    var apBtnRow = h('div', 'set-row');
    var apReload = h('button', 'btn btn-sm', '刷新审批统计');
    var apClear = h('button', 'btn btn-sm', '清空记住的规则');
    function reloadApprovals() {
      return apiGet('/api/approvals').then(function (a) {
        renderApprovalSection(sec8, a);
      }).catch(function (e) {
        toast(e.message || '刷新审批统计失败', 'err');
      });
    }
    apReload.addEventListener('click', reloadApprovals);
    apClear.addEventListener('click', function () {
      apClear.disabled = true;
      apiPost('/api/approvals', { action: 'clear' }).then(function (resp) {
        applyStateIfState(resp);
        toast('已清空记住的规则', 'ok');
        return reloadApprovals();
      }).catch(function (e) {
        toast(e.message || '清空失败', 'err');
      }).then(function () { apClear.disabled = false; });
    });
    apBtnRow.appendChild(apReload);
    apBtnRow.appendChild(apClear);
    sec8.appendChild(apBtnRow);
    renderApprovalSection(sec8, approvals);
    inner.appendChild(sec8);
  }

  /* 审批区域里的规则表 / 会话放行（可被刷新按钮重画） */
  function renderApprovalSection(sec, a) {
    // 移除旧的动态区
    var old = sec.querySelector('.ap-dynamic');
    if (old) old.parentNode.removeChild(old);

    var wrap = h('div', 'ap-dynamic');
    var aa = a || {};
    var rules = Array.isArray(aa.rules) ? aa.rules : [];
    var allows = Array.isArray(aa.sessionAllows) ? aa.sessionAllows : [];

    if (rules.length) {
      var table = h('table', 'set-table');
      var thead = h('thead');
      var trh = h('tr');
      trh.appendChild(h('th', null, 'kind'));
      trh.appendChild(h('th', null, 'value'));
      thead.appendChild(trh);
      table.appendChild(thead);
      var tbody = h('tbody');
      rules.forEach(function (r) {
        var tr = h('tr');
        tr.appendChild(h('td', 'mono', String(r.kind || '')));
        tr.appendChild(h('td', 'mono', String(r.value || '')));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    } else {
      wrap.appendChild(h('div', 'set-note', '没有记住的规则。'));
    }

    if (allows.length) {
      var sa = h('div', 'session-allows', '本次会话已放行：');
      allows.forEach(function (s, i) {
        if (i) sa.appendChild(document.createTextNode(' · '));
        sa.appendChild(h('code', null, String(s)));
      });
      wrap.appendChild(sa);
    }
    sec.appendChild(wrap);
  }

  /* ================= 终端（§8 window.lumin.term + xterm.js） ================= */

  var xt = null;              // xterm Terminal 实例
  var termStarted = false;    // 子进程是否在跑
  var termCallbacksBound = false;
  var termLineBuf = '';       // 本地行编辑 buffer（管道非 TTY，子进程不回显）

  function hasTermShell() {
    return !!(window.lumin && window.lumin.term &&
      typeof window.lumin.term.start === 'function' &&
      typeof window.lumin.term.write === 'function');
  }

  function measureCell() {
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
    probe.style.font = '13px ui-monospace, "Cascadia Code", Consolas, monospace';
    probe.textContent = 'W'.repeat(50);
    document.body.appendChild(probe);
    var rect = probe.getBoundingClientRect();
    document.body.removeChild(probe);
    return { w: rect.width / 50, h: 18 };
  }

  function resizeTerm() {
    if (!xt) return;
    var host = dom.termHost;
    var cell = measureCell();
    var padX = 20, padY = 16; // 与 .term-wrap 内边距一致（8+8 / 10+10 近似）
    var cols = Math.max(20, Math.floor((host.clientWidth - padX) / Math.max(cell.w, 4)));
    var rows = Math.max(5, Math.floor((host.clientHeight - padY) / Math.max(cell.h, 10)));
    try { xt.resize(cols, rows); } catch (e) { /* ignore */ }
  }

  function ensureTerminal() {
    if (!hasTermShell()) {
      dom.termNoShell.hidden = false;
      dom.termExit.hidden = true;
      dom.termStatus.textContent = '缺少 window.lumin.term';
      return;
    }
    dom.termNoShell.hidden = true;

    if (!xt) {
      if (typeof window.Terminal !== 'function') {
        dom.termStatus.textContent = 'xterm.js 未加载';
        return;
      }
      xt = new window.Terminal({
        fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
        fontSize: 13,
        convertEol: false,
        cursorBlink: true,
        scrollback: 5000,
        theme: {
          background: '#0e1116',
          foreground: '#c9d1d9',
          cursor: '#2f81f7',
          selectionBackground: 'rgba(47,129,247,0.35)'
        }
      });
      xt.open(dom.termHost);
      xt.onData(function (data) { onTermUserInput(data); });
    }

    if (!termCallbacksBound) {
      termCallbacksBound = true;
      // 子进程输出 → xterm 显示
      if (typeof window.lumin.term.onData === 'function') {
        window.lumin.term.onData(function (text) {
          if (xt && text) xt.write(text);
        });
      }
      if (typeof window.lumin.term.onExit === 'function') {
        window.lumin.term.onExit(function () {
          termStarted = false;
          termLineBuf = '';
          dom.termExit.hidden = false;
          dom.termStatus.textContent = '已退出';
        });
      }
    }

    resizeTerm();
    if (!termStarted) startTerm();
    else xt.focus();
  }

  function startTerm() {
    if (!hasTermShell()) return;
    dom.termExit.hidden = true;
    dom.termStatus.textContent = '启动中…';
    // cwd 缺省 <lumin根>/chat-workspace（契约 §8）
    Promise.resolve(window.lumin.term.start()).then(function (r) {
      if (r && r.ok === false) {
        dom.termStatus.textContent = '启动失败';
        dom.termExit.hidden = false;
        var p = dom.termExit.querySelector('.term-exit-title');
        if (p) p.textContent = '启动失败' + (r.error ? ('：' + r.error) : '');
        return;
      }
      termStarted = true;
      termLineBuf = '';
      dom.termExit.hidden = true;
      dom.termStatus.textContent = '运行中';
      if (xt) {
        resizeTerm();
        xt.focus();
        xt.write('（终端已连接。本地行编辑：回车发送整行，Ctrl+C = /stop）\r\n');
      }
    }).catch(function (e) {
      dom.termStatus.textContent = '启动失败';
      dom.termExit.hidden = false;
      var p2 = dom.termExit.querySelector('.term-exit-title');
      if (p2) p2.textContent = '启动失败' + (e && e.message ? ('：' + e.message) : '');
    });
  }

  /* 本地行编辑：无 TTY 回显 —— 可打印字符/退格进本地 buffer 并回显，
     回车把整行+"\n"发给子进程并本地换行；Ctrl+C 发 "/stop\n"；粘贴按字符流处理。 */
  function onTermUserInput(data) {
    if (!xt || !termStarted || !data) return;
    var chars = Array.from(data); // 按码点迭代（粘贴/多字节安全）
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var code = ch.codePointAt(0);

      if (ch === '\r' || ch === '\n') {
        // 回车：整行发给子进程，本地换行
        xt.write('\r\n');
        window.lumin.term.write(termLineBuf + '\n');
        termLineBuf = '';
        continue;
      }
      if (code === 0x7f || code === 0x08) {
        // 退格
        if (termLineBuf.length) {
          var cp = Array.from(termLineBuf);
          cp.pop();
          termLineBuf = cp.join('');
          xt.write('\b \b');
        }
        continue;
      }
      if (code === 0x03) {
        // Ctrl+C → /stop
        termLineBuf = '';
        xt.write('^C\r\n');
        window.lumin.term.write('/stop\n');
        continue;
      }
      if (code < 0x20) {
        // 其余控制字符 / 方向键转义序列：忽略
        continue;
      }
      // 可打印字符（含中文）：本地回显 + 进 buffer
      termLineBuf += ch;
      xt.write(ch);
    }
  }

  /* ================= 标题栏（§8 window.lumin.win） ================= */

  var winMaximized = false;

  function setupTitlebar() {
    var lum = window.lumin;
    function guard(fn) {
      return function (e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        try { fn(); } catch (err) { /* 浏览器自测下无壳，静默 */ }
      };
    }
    dom.btnMin.addEventListener('click', guard(function () {
      if (lum && lum.win) lum.win.minimize();
    }));
    dom.btnMax.addEventListener('click', guard(function () {
      if (lum && lum.win) lum.win.toggleMaximize();
    }));
    dom.btnClose.addEventListener('click', guard(function () {
      if (lum && lum.win) lum.win.close();
    }));
    dom.titlebar.addEventListener('dblclick', guard(function () {
      if (lum && lum.win) lum.win.toggleMaximize();
    }));

    if (lum && lum.win && typeof lum.win.onState === 'function') {
      lum.win.onState(function (s) {
        winMaximized = !!(s && s.maximized);
        dom.btnMax.innerHTML = winMaximized ? '&#10697;' : '&#9633;';
        dom.btnMax.title = winMaximized ? '还原' : '最大化';
      });
    }
  }

  /* ================= 事件绑定 / 启动 ================= */

  function setupEvents() {
    dom.nav.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.nav-item') : null;
      if (!btn) return;
      switchView(btn.getAttribute('data-view'));
    });

    dom.btnSessionNew.addEventListener('click', newSession);
    dom.btnWsPick.addEventListener('click', pickWorkspace);

    dom.btnSend.addEventListener('click', sendCurrent);
    dom.btnStop.addEventListener('click', stopRun);

    dom.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendCurrent();
      }
    });
    dom.input.addEventListener('input', autoGrow);

    dom.btnTreeRefresh.addEventListener('click', loadTree);
    dom.btnSkillsRefresh.addEventListener('click', function () {
      skillCache = Object.create(null);
      loadSkills();
    });
    dom.btnSettingsReload.addEventListener('click', loadSettings);

    dom.btnTermRestart.addEventListener('click', startTerm);

    window.addEventListener('resize', function () {
      if (activeView === 'terminal') resizeTerm();
    });
  }

  function init() {
    collectDom();
    setupTitlebar();
    setupEvents();
    renderComposerMode();
    boot();
  }

  init();

})();
