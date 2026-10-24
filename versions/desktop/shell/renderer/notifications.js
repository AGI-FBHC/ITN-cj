/* 顶部通知中心：历史结果、未读状态与长操作进度。
   数据由仓颉内核持久化；本文件不复制任务中心的可停止任务状态。 */
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
    return {
      id: String(item.id || ("notice-" + Date.now() + "-" + (++state.sequence))),
      title: String(item.title || "通知").slice(0, 120),
      detail: String(item.detail || "").slice(0, 600),
      status,
      read: status === "running" ? false : !!item.read,
      createdAt,
      updatedAt: String(item.updatedAt || createdAt),
      page: String(item.page || ""),
      action: item.action && typeof item.action === "object" ? item.action : null,
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
    if (!state.ready) {
      state.dirtyBeforeReady = true;
      return Promise.resolve();
    }
    const payload = state.items.map(item => ({
      id: item.id,
      title: item.title,
      detail: item.detail,
      status: item.status,
      read: item.read,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      page: item.page,
      action: item.action,
    }));
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
    button.title = "通知";
    button.setAttribute("aria-label", "通知");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.8 9.2a5.2 5.2 0 0 1 10.4 0c0 6 2.2 6.2 2.2 7.4H4.6c0-1.2 2.2-1.4 2.2-7.4Z"/><path d="M9.7 19a2.5 2.5 0 0 0 4.6 0"/></svg><span class="notification-badge" hidden>0</span>';

    const pop = mk("section", "notification-pop");
    pop.hidden = true;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "通知历史");
    const head = mk("header", "notification-head");
    const title = mk("strong", null, "通知");
    const actions = mk("div", "notification-head-actions");
    const readAll = mk("button", "notification-read-all", "一键已读");
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

  function unreadCount() {
    return state.items.filter(item => !item.read && item.status !== "running").length;
  }

  function paint() {
    if (!state.button) return;
    const unread = unreadCount();
    const running = state.items.some(item => item.status === "running");
    state.badge.hidden = unread === 0;
    state.badge.textContent = unread > 99 ? "99+" : String(unread);
    state.button.classList.toggle("has-running", running);
    state.button.setAttribute("aria-label", running ? "通知，有任务进行中" : unread ? "通知，" + unread + " 条未读" : "通知");
    state.readAll.disabled = unread === 0;
    state.list.replaceChildren();

    if (!state.items.length) {
      state.list.appendChild(mk("p", "notification-empty", "暂时没有通知"));
      return;
    }

    for (const item of state.items) {
      const row = mk("article", "notification-row " + item.status + (item.read ? "" : " unread"));
      row.dataset.id = item.id;
      const status = mk("span", "notification-status");
      status.innerHTML = icon(item.status);
      const main = mk("button", "notification-main");
      main.type = "button";
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
      main.addEventListener("click", event => {
        event.stopPropagation();
        markRead(item.id, true);
        if (item.page && typeof window.go === "function") window.go(item.page).catch(() => {});
      });
      const toggle = mk("button", "notification-toggle", item.read ? "标为未读" : "标为已读");
      toggle.type = "button";
      toggle.disabled = item.status === "running";
      toggle.setAttribute("aria-label", (item.read ? "标为未读：" : "标为已读：") + item.title);
      toggle.addEventListener("click", event => {
        event.stopPropagation();
        markRead(item.id, !item.read);
      });
      row.append(status, main, toggle);
      state.list.appendChild(row);
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

  function push(input) {
    mount();
    const item = normalize(input);
    if (!item) return "";
    const existing = state.items.findIndex(entry => entry.id === item.id);
    if (existing >= 0) state.items[existing] = {...state.items[existing], ...item};
    else state.items.unshift(item);
    state.items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    state.items = state.items.slice(0, MAX_ITEMS);
    paint();
    persist();
    return item.id;
  }

  function update(id, patch) {
    const item = state.items.find(entry => entry.id === id);
    if (!item) return false;
    Object.assign(item, patch || {}, {
      updatedAt: new Date().toISOString(),
      read: patch && Object.prototype.hasOwnProperty.call(patch, "read") ? !!patch.read : item.read,
      status: patch && patch.status ? patch.status : item.status,
    });
    state.items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    paint();
    persist();
    return true;
  }

  function start(options) {
    const opts = options || {};
    return push({
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

  function markRead(id, read) {
    const item = state.items.find(entry => entry.id === id);
    if (!item) return;
    item.read = !!read;
    item.updatedAt = new Date().toISOString();
    paint();
    persist();
  }

  function markAllRead() {
    const now = new Date().toISOString();
    for (const item of state.items) {
      if (item.status !== "running") item.read = true;
      item.updatedAt = now;
    }
    paint();
    persist();
  }

  async function load() {
    mount();
    const pending = state.items.slice();
    try {
      const data = await api("/api/notifications/get", {});
      const stored = (Array.isArray(data.items) ? data.items : []).map(normalize).filter(Boolean);
      const merged = new Map(stored.map(item => [item.id, item]));
      for (const item of pending) merged.set(item.id, item);
      state.items = [...merged.values()]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, MAX_ITEMS);
    } catch (error) {
      console.warn("notification load failed", error);
      state.items = pending.slice(0, MAX_ITEMS);
    }
    state.ready = true;
    paint();
    if (state.dirtyBeforeReady) {
      state.dirtyBeforeReady = false;
      persist();
    }
  }

  window.LuminNotifications = {
    push,
    start,
    finish,
    update,
    markRead,
    markAllRead,
    open: () => toggle(true),
    close: () => toggle(false),
    list: () => state.items.map(item => ({...item})),
  };

  const boot = () => {
    mount();
    load();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
