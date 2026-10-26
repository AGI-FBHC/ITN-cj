/* 铃铛仅呈现未读任务；历史仍按原契约持久化，任务中心保持独立。 */
(() => {
  "use strict";

  const MAX_ITEMS = 60;
  const ICONS = {
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 10v6M12 7h.01"/>',
    running: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M21 3v6h-6"/>',
    success: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.3 2.3 4.9-5"/>',
    failed: '<circle cx="12" cy="12" r="8"/><path d="m9 9 6 6m0-6-6 6"/>',
  };
  const STATUS_LABEL = { info: "通知", running: "进行中", success: "已完成", failed: "失败" };
  const state = {
    items: [],
    ready: false,
    open: false,
    box: null,
    button: null,
    badge: null,
    pop: null,
    list: null,
    readAll: null,
    saveChain: Promise.resolve(),
    sequence: 0,
    dirtyBeforeReady: false,
    context: {page: "", sessionId: "", guidedSessionId: ""},
    startedAt: Date.now(),
    pendingTasks: [],
    navigator: null,
    navigating: new Set(),
    batch: false,
    storageAvailable: true,
  };

  const mk = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function icon(status) {
    const body = ICONS[status] || ICONS.info;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }

  function normalize(item) {
    if (!item || typeof item !== "object") return null;
    const status = ["info", "running", "success", "failed"].includes(item.status) ? item.status : "info";
    const createdAt = String(item.createdAt || new Date().toISOString());
    const id = String(item.id || ("notice-" + Date.now() + "-" + (++state.sequence)));
    const source = item.source === "task" || /^task:.+/.test(id) ? "task" : "system";
    const action = item.action && typeof item.action === "object" ? {...item.action} : null;
    const sessionId = String(action?.sessionId || item.sessionId || id.match(/^task:turn:([^:]+):/)?.[1] || "");
    return {
      ...item,
      id,
      title: String(item.title || "通知").slice(0, 120),
      detail: String(item.detail || "").slice(0, 600),
      status,
      read: !!item.read,
      readReason: item.read ? (["view", "manual", "open"].includes(item.readReason) ? item.readReason : "manual") : "",
      createdAt,
      updatedAt: String(item.updatedAt || createdAt),
      page: String(item.page || ""),
      action: action || (sessionId ? {page: "chat", sessionId} : null),
      source,
      sessionId,
      taskStartedAt: String(item.taskStartedAt || ""),
      taskStatus: String(item.taskStatus || status),
    };
  }

  function stamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const now = Date.now(), diff = Math.max(0, now - date.getTime());
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前";
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前";
    if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + " 天前";
    return (date.getMonth() + 1) + " 月 " + date.getDate() + " 日";
  }

  function persist() {
    if (!state.ready || state.batch) {
      state.dirtyBeforeReady = true;
      return Promise.resolve();
    }
    // A failed load must never overwrite unknown stored history with a partial list.
    if (!state.storageAvailable) return Promise.resolve();
    const payload = state.items.map(item => ({...item, action: item.action ? {...item.action} : null}));
    const run = async () => {
      try {
        await api("/api/notifications/save", { items: payload });
      } catch (error) {
        console.warn("notification save failed", error);
      }
    };
    state.saveChain = state.saveChain.then(run, run);
    return state.saveChain;
  }

  function ensureDom() {
    if (state.box) return;
    const box = mk("div", "notification-center");
    const button = mk("button", "notification-btn");
    button.type = "button";
    button.title = "任务消息";
    button.setAttribute("aria-label", "任务消息");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.8 9.2a5.2 5.2 0 0 1 10.4 0c0 6 2.2 6.2 2.2 7.4H4.6c0-1.2 2.2-1.4 2.2-7.4Z"/><path d="M9.7 19a2.5 2.5 0 0 0 4.6 0"/></svg><span class="notification-badge" hidden>0</span>';

    const pop = mk("section", "notification-pop");
    pop.hidden = true;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "未读任务消息");
    const head = mk("header", "notification-head");
    const title = mk("strong", null, "任务消息");
    const actions = mk("div", "notification-head-actions");
    const readAll = mk("button", "notification-read-all", "全部已读");
    readAll.type = "button";
    actions.appendChild(readAll);
    head.append(title, actions);
    const list = mk("div", "notification-list");
    pop.append(head, list);
    box.append(button, pop);

    state.box = box;
    state.button = button;
    state.badge = button.querySelector(".notification-badge");
    state.pop = pop;
    state.list = list;
    state.readAll = readAll;

    button.addEventListener("click", event => {
      event.stopPropagation();
      toggle(!state.open);
    });
    readAll.addEventListener("click", event => {
      event.stopPropagation();
      markAllRead();
    });
    document.addEventListener("click", event => {
      if (state.pop && !state.pop.hidden && !state.box.contains(event.target)) toggle(false);
    });
    document.addEventListener("lumin:top-popover-open", event => {
      if (event.detail?.source !== "notifications" && state.open) toggle(false);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && state.open) {
        event.preventDefault();
        toggle(false);
        state.button.focus();
      }
    });
  }

  function mount() {
    ensureDom();
    const target = document.getElementById("titlebar-notifications");
    if (target && state.box.parentElement !== target) target.appendChild(state.box);
  }

  function visibleItems() {
    return state.items.filter(item => item.source === "task" && !item.read && !isForeground(item));
  }

  function isForeground(item) {
    const sid = item.action?.sessionId || item.sessionId;
    return !document.hidden && !!sid && (
      (state.context.page === "chat" && sid === state.context.sessionId) || sid === state.context.guidedSessionId
    );
  }

  function applyContext(item) {
    if (item.source !== "task") return;
    if (isForeground(item)) {
      if (!item.read) {item.read = true; item.readReason = "view";}
    } else if (item.status === "running" && item.read && item.readReason === "view") {
      item.read = false;
      item.readReason = "";
    }
  }

  function reconcileContext() {
    let changed = false;
    for (const item of state.items) {
      const before = item.read + ":" + item.readReason;
      applyContext(item);
      if (before !== item.read + ":" + item.readReason) changed = true;
    }
    if (changed) {paint(); persist();}
  }

  function setContext(context) {
    const next = {page: String(context?.page || ""), sessionId: String(context?.sessionId || ""), guidedSessionId: String(context?.guidedSessionId || "")};
    if (Object.keys(next).every(key => state.context[key] === next[key])) return;
    state.context = next;
    reconcileContext();
  }

  function paint() {
    if (!state.button) return;
    const items = visibleItems();
    const unread = items.length;
    const running = items.some(item => item.status === "running");
    state.badge.hidden = unread === 0;
    state.badge.textContent = unread > 99 ? "99+" : String(unread);
    state.button.classList.toggle("has-running", running);
    state.button.setAttribute("aria-label", unread ? "任务消息，" + unread + " 条未读" : "任务消息");
    state.readAll.disabled = unread === 0;
    const active = document.activeElement;
    const focusedId = active?.closest(".notification-row")?.dataset.id;
    const focusedClass = active?.classList.contains("notification-toggle") ? "notification-toggle" : "notification-main";
    const scrollTop = state.pop.scrollTop;
    state.list.replaceChildren();

    if (!items.length) state.list.appendChild(mk("p", "notification-empty", "暂无未读任务"));

    for (const item of items) {
      const row = mk("article", "notification-row " + item.status + (item.read ? "" : " unread"));
      row.dataset.id = item.id;
      const status = mk("span", "notification-status");
      status.innerHTML = icon(item.status);
      const main = mk("button", "notification-main");
      main.type = "button";
      main.disabled = state.navigating.has(item.id);
      main.title = item.title;
      main.append(
        mk("span", "notification-title", item.title),
        mk("span", "notification-detail", item.detail),
      );
      const meta = mk("span", "notification-meta");
      meta.append(
        mk("span", "notification-state", STATUS_LABEL[item.status] || "通知"),
        mk("span", null, stamp(item.updatedAt || item.createdAt)),
      );
      main.appendChild(meta);
      main.addEventListener("click", async event => {
        event.stopPropagation();
        if (state.navigating.has(item.id)) return;
        state.navigating.add(item.id);
        main.disabled = true;
        main.setAttribute("aria-busy", "true");
        try {
          const action = item.action || {page: item.page};
          if (action.sessionId && typeof window.openChatSession === "function") await window.openChatSession(action.sessionId);
          else if (state.navigator) await state.navigator({...action});
          else if (action.page && typeof window.go === "function") await window.go(action.page);
          else throw Error("任务入口暂不可用");
          markRead(item.id, true, "open");
          toggle(false);
        } catch (error) {
          if (typeof window.toast === "function") window.toast("打开任务失败：" + error.message);
        } finally {
          state.navigating.delete(item.id);
          main.disabled = false;
          main.removeAttribute("aria-busy");
        }
      });
      const readButton = mk("button", "notification-toggle", "已读");
      readButton.type = "button";
      readButton.setAttribute("aria-label", "已读：" + item.title);
      readButton.addEventListener("click", event => {
        event.stopPropagation();
        markRead(item.id, true);
      });
      row.append(status, main, readButton);
      state.list.appendChild(row);
    }
    state.pop.scrollTop = scrollTop;
    if (focusedId) {
      const row = [...state.list.children].find(node => node.dataset.id === focusedId);
      (row?.querySelector("." + focusedClass) || state.list.querySelector(".notification-main") || state.button).focus({preventScroll: true});
    }
  }

  function toggle(open) {
    ensureDom();
    state.open = !!open;
    state.pop.hidden = !state.open;
    state.button.setAttribute("aria-expanded", String(state.open));
    if (state.open) {
      document.dispatchEvent(new CustomEvent("lumin:top-popover-open", {detail: {source: "notifications"}}));
      paint();
    }
  }

  function put(input) {
    const previous = state.items.find(entry => entry.id === input?.id);
    const item = normalize(previous ? {...previous, ...input} : input);
    if (!item) return "";
    const existing = state.items.findIndex(entry => entry.id === item.id);
    if (previous && item.source === "task") {
      const phaseChanged = previous.status !== item.status || (
        previous.taskStartedAt && item.taskStartedAt && previous.taskStartedAt !== item.taskStartedAt
      ) || (item.status === "info" && previous.taskStatus !== item.taskStatus);
      if (phaseChanged) {
        item.read = !!input.read;
        item.readReason = item.read ? "manual" : "";
      } else {
        item.read = previous.read;
        item.readReason = previous.readReason;
      }
    }
    applyContext(item);
    if (previous && JSON.stringify({...previous, updatedAt: ""}) === JSON.stringify({...item, updatedAt: ""})) return "";
    if (previous && !Object.prototype.hasOwnProperty.call(input, "updatedAt")) item.updatedAt = new Date().toISOString();
    if (existing >= 0) state.items[existing] = {...state.items[existing], ...item};
    else state.items.unshift(item);
    state.items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    state.items = state.items.slice(0, MAX_ITEMS);
    return item.id;
  }

  function push(input) {
    mount();
    const id = put(input);
    if (id) {paint(); persist();}
    return id || String(input?.id || "");
  }

  function update(id, patch) {
    const item = state.items.find(entry => entry.id === id);
    if (!item) return false;
    push({...patch, id});
    return true;
  }

  function start(options) {
    const opts = options || {};
    return push({
      ...opts,
      id: opts.id || ("notice-" + Date.now() + "-" + (++state.sequence)),
      title: opts.title || "正在处理",
      detail: opts.detail || "",
      status: "running",
      read: false,
      page: opts.page || "",
      action: opts.action || null,
    });
  }

  function finish(id, status, detail) {
    return update(id, {status: status === "failed" ? "failed" : "success", detail, read: false});
  }

  function markRead(id, read = true, reason = "manual") {
    const item = state.items.find(entry => entry.id === id);
    if (!item) return;
    // Opening a live session is a view acknowledgment; leaving it must notify again.
    if (reason === "open" && read && item.status === "running" && isForeground(item)) reason = "view";
    if (item.read === !!read && item.readReason === reason) return;
    item.read = !!read;
    item.readReason = item.read ? reason : "";
    paint();
    persist();
  }

  function markAllRead() {
    const items = visibleItems();
    if (!items.length) return;
    for (const item of items) {
      item.read = true;
      item.readReason = "manual";
    }
    paint();
    persist();
  }

  function syncTasks(data) {
    if (!data || typeof data !== "object") return;
    if (!state.ready) {
      state.pendingTasks.push({running: Array.isArray(data.running) ? [...data.running] : [], recent: Array.isArray(data.recent) ? [...data.recent] : []});
      return;
    }
    let changed = false;
    const runningIds = new Set();
    function sync(task, running) {
      if (!task?.id) return;
      const id = "task:" + task.id;
      const old = state.items.find(item => item.id === id);
      if (!running && !old && !(Date.parse(task.updatedAt || "") >= state.startedAt)) return;
      const status = running ? "running" : task.status === "completed" ? "success" : task.status === "failed" ? "failed" : "info";
      const bits = [];
      if (task.stage) bits.push(task.stage);
      if (task.progress?.percent != null && Number.isFinite(Number(task.progress.percent))) bits.push(Math.round(Math.max(0, Math.min(100, Number(task.progress.percent)))) + "%");
      if (Number(task.tokens?.total) > 0) bits.push("tokens " + Number(task.tokens.total).toLocaleString());
      const action = task.link && typeof task.link === "object" ? {...task.link} : old?.action || null;
      const result = put({id, source: "task", title: task.title || "后台任务", detail: bits.join(" · ") || old?.detail || "", status,
        read: false, page: action?.page || old?.page || "", action,
        taskStartedAt: task.startedAt || old?.taskStartedAt || "", taskStatus: task.status || status});
      if (result) changed = true;
    }
    for (const task of Array.isArray(data.running) ? data.running : []) {runningIds.add(String(task?.id || "")); sync(task, true);}
    for (const task of Array.isArray(data.recent) ? data.recent : []) if (!runningIds.has(String(task?.id || ""))) sync(task, false);
    if (changed) {paint(); persist();}
  }

  async function load() {
    mount();
    let stored = [];
    try {
      const data = await api("/api/notifications/get", {});
      stored = (Array.isArray(data.items) ? data.items : []).map(normalize).filter(Boolean);
    } catch (error) {
      console.warn("notification load failed", error);
      state.storageAvailable = false;
    }
    const pending = state.items.slice();
    state.items = stored.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_ITEMS);
    state.batch = true;
    for (const item of pending) put(item);
    state.ready = true;
    reconcileContext();
    for (const snapshot of state.pendingTasks.splice(0)) syncTasks(snapshot);
    state.batch = false;
    paint();
    if (state.dirtyBeforeReady || pending.length) {
      state.dirtyBeforeReady = false;
      persist();
    }
  }

  window.LuminNotifications = {
    push,
    start,
    finish,
    update,
    syncTasks,
    setContext,
    setNavigator: navigate => {state.navigator = typeof navigate === "function" ? navigate : null;},
    markRead,
    markAllRead,
    open: () => toggle(true),
    close: () => toggle(false),
    list: () => state.items.map(item => ({...item, action: item.action ? {...item.action} : null})),
  };

  document.addEventListener("visibilitychange", reconcileContext);

  const boot = () => {
    mount();
    load();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
