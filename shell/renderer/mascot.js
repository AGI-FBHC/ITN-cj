(() => {
  "use strict";

  const POSITION_KEY = "lumin.mascot.position";
  const HIDDEN_KEY = "lumin.mascot.hidden";
  const FRAMES = {
    idle: ["idle", "idle", "breathe", "breathe", "idle", "blink", "idle", "idle"],
    wake: ["wake", "wake", "breathe", "idle"],
    thinking: ["listen-2", "think-1", "think-1", "think-2", "think-2", "think-1"],
    speaking: ["speak-1", "speak-2", "speak-1", "speak-2"],
    working: ["think-2", "working", "working", "think-1", "working"],
    success: ["working", "wake", "success", "success", "wake"],
    listening: ["wake", "listen-1", "listen-1", "listen-2", "listen-2"]
  };
  const SPEED = { idle: 1100, wake: 440, thinking: 660, speaking: 520, working: 700, success: 520, listening: 560 };
  const LABELS = { idle: "待机", wake: "唤醒", thinking: "思考", speaking: "回答", working: "执行中", success: "完成", listening: "倾听" };
  const ACTIVITY_STATES = new Set(["idle", "wake", "thinking", "speaking", "working", "success", "listening"]);

  const root = document.createElement("div");
  root.className = "lumin-mascot-root";
  root.dataset.state = "idle";
  root.innerHTML = `
    <section id="lumin-mascot-menu" class="lumin-mascot-menu" role="dialog" aria-label="小鼋龙快捷菜单" hidden>
      <div class="lumin-mascot-menu-head">
        <span class="lumin-mascot-title">小鼋龙</span>
        <span class="lumin-mascot-state">待机</span>
      </div>
      <div class="lumin-mascot-actions">
        <button type="button" data-page="chat">对话</button>
        <button type="button" data-page="home">知识网络</button>
        <button type="button" data-page="notes">学习资源</button>
      </div>
      <button type="button" class="lumin-mascot-hide">隐藏小鼋龙</button>
    </section>
    <button class="lumin-mascot-actor" type="button" aria-label="小鼋龙，待机" aria-haspopup="dialog" aria-controls="lumin-mascot-menu" aria-expanded="false" title="小鼋龙 · 可拖动">
      <span class="lumin-mascot-float">
        <img class="lumin-mascot-image" src="/mascot/xiaoyuanlong-idle.png" alt="" draggable="false">
      </span>
      <span class="lumin-mascot-dot" aria-hidden="true"></span>
    </button>
  `;
  document.body.appendChild(root);

  const actor = root.querySelector(".lumin-mascot-actor");
  const image = root.querySelector(".lumin-mascot-image");
  const menu = root.querySelector(".lumin-mascot-menu");
  const stateText = root.querySelector(".lumin-mascot-state");

  let petState = "idle";
  let frameTimer = 0;
  let stateTimer = 0;
  let busyCount = 0;
  let dragged = false;
  let pointerStart = null;
  let position = readPosition();

  for (const list of Object.values(FRAMES)) {
    for (const frame of list) {
      const img = new Image();
      img.src = frameUrl(frame);
    }
  }

  function frameUrl(frame) {
    return "/mascot/xiaoyuanlong-" + frame + ".png";
  }

  function readPosition() {
    try {
      const raw = JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
      if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) return { x: raw.x, y: raw.y };
    } catch (e) { /* 界面偏好损坏时回到默认位置 */ }
    return null;
  }

  function savePosition() {
    try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch (e) { /* ignore */ }
  }

  function clampPosition(next) {
    // offsetWidth/Height become zero while hidden; CSS dimensions remain stable.
    const style = getComputedStyle(root);
    const width = parseFloat(style.width), height = parseFloat(style.height);
    const maxX = Math.max(8, window.innerWidth - width - 10);
    const maxY = Math.max(64, window.innerHeight - height - 14);
    return {
      x: Math.min(Math.max(8, next.x), maxX),
      y: Math.min(Math.max(64, next.y), maxY)
    };
  }

  function place(next) {
    position = clampPosition(next);
    root.style.left = Math.round(position.x) + "px";
    root.style.top = Math.round(position.y) + "px";
    placeMenu();
  }

  function placeMenu() {
    if (menu.hidden || root.hidden) return;
    const bounds = root.getBoundingClientRect();
    const scale = bounds.width / root.offsetWidth;
    const width = menu.offsetWidth * scale, height = menu.offsetHeight * scale;
    const topEdge = Math.max(8, (document.getElementById("titlebar")?.getBoundingClientRect().bottom || 0) + 8);
    const x = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8));
    const above = bounds.top - height - 4;
    const y = Math.max(topEdge, Math.min(above >= topEdge ? above : bounds.bottom + 4, window.innerHeight - height - 8));
    menu.style.left = (x - bounds.left) / scale + "px";
    menu.style.top = (y - bounds.top) / scale + "px";
    menu.style.right = "auto";
    menu.style.bottom = "auto";
    menu.classList.toggle("below", y >= bounds.bottom);
  }

  function defaultPosition() {
    return { x: window.innerWidth - 130, y: window.innerHeight - 210 };
  }

  function setState(next, autoReturnMs) {
    const normalized = ACTIVITY_STATES.has(next) ? next : "idle";
    if (normalized === petState && frameTimer) return;
    petState = normalized;
    root.dataset.state = normalized;
    stateText.textContent = LABELS[normalized];
    actor.setAttribute("aria-label", "小鼋龙，" + LABELS[normalized]);
    clearTimeout(frameTimer);
    clearTimeout(stateTimer);
    const frames = FRAMES[normalized] || FRAMES.idle;
    let index = 0;
    const tick = () => {
      image.src = frameUrl(frames[index % frames.length]);
      index += 1;
      frameTimer = setTimeout(tick, SPEED[normalized] || 500);
    };
    tick();
    if (autoReturnMs) {
      stateTimer = setTimeout(() => setState(busyCount > 0 ? "working" : "idle"), autoReturnMs);
    }
  }

  function openMenu(open) {
    menu.hidden = !open;
    actor.setAttribute("aria-expanded", String(open));
    root.classList.toggle("menu-open", open);
    if (open) {
      setState("wake", SPEED.wake * FRAMES.wake.length);
      placeMenu();
    }
  }

  function setHidden(hidden) {
    try { localStorage.setItem(HIDDEN_KEY, hidden ? "1" : "0"); } catch (e) { /* ignore */ }
    root.hidden = !!hidden || playerVisible();
    if (hidden) openMenu(false);
    else { place(position || defaultPosition()); savePosition(); }
  }

  function playerVisible() {
    const player = document.getElementById("player");
    return !!document.fullscreenElement || !!(player && !player.hidden);
  }

  function syncVisibility() {
    let hidden = false;
    try { hidden = localStorage.getItem(HIDDEN_KEY) === "1"; } catch (e) { /* ignore */ }
    root.hidden = hidden || playerVisible();
    place(position || defaultPosition());
    savePosition();
  }

  function navigate(page) {
    openMenu(false);
    if (typeof window.go === "function") window.go(page);
    else location.hash = "#/" + page;
  }

  function dispatchPetState(state) {
    window.dispatchEvent(new CustomEvent("lumin:pet-state", { detail: { state } }));
  }

  const initial = position || defaultPosition();
  place(initial);
  savePosition();

  actor.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, left: position.x, top: position.y };
    dragged = false;
    actor.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  actor.addEventListener("pointermove", (event) => {
    if (!pointerStart || event.pointerId !== pointerStart.id) return;
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    if (!dragged && Math.abs(dx) + Math.abs(dy) < 5) return;
    dragged = true;
    root.classList.add("dragging");
    openMenu(false);
    place({ x: pointerStart.left + dx, y: pointerStart.top + dy });
  });

  const finishPointer = (event) => {
    if (!pointerStart || event.pointerId !== pointerStart.id) return;
    pointerStart = null;
    if (actor.hasPointerCapture?.(event.pointerId)) actor.releasePointerCapture(event.pointerId);
    root.classList.remove("dragging");
    if (dragged) savePosition();
    else if (event.type === "pointerup") openMenu(menu.hidden);
    if (dragged) dragged = false;
  };
  actor.addEventListener("pointerup", finishPointer);
  actor.addEventListener("pointercancel", finishPointer);
  actor.addEventListener("lostpointercapture", finishPointer);

  actor.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const open = menu.hidden;
    openMenu(open);
    if (open) menu.querySelector("button")?.focus();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(false);
    actor.focus();
  });

  menu.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.page));
  });
  root.querySelector(".lumin-mascot-hide").addEventListener("click", () => setHidden(true));

  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !root.contains(event.target)) openMenu(false);
  });

  window.addEventListener("resize", () => { place(position || defaultPosition()); savePosition(); });
  window.addEventListener("dblclick", (event) => {
    if (!root.contains(event.target)) return;
    place(defaultPosition());
    savePosition();
  });
  window.addEventListener("lumin:activity", (event) => {
    const detail = event.detail || {};
    busyCount = Math.max(0, Number(detail.busyCount || 0));
    const next = ACTIVITY_STATES.has(detail.state) ? detail.state : (busyCount > 0 ? "working" : "idle");
    if (next === "success" && busyCount === 0) setState("success", SPEED.success * FRAMES.success.length);
    else setState(next);
    dispatchPetState(next);
  });
  window.addEventListener("lumin:mascot-visibility", (event) => {
    setHidden(!(event.detail && event.detail.visible));
  });
  window.addEventListener("lumin:mascot-reset", () => {
    place(defaultPosition());
    savePosition();
    setHidden(false);
  });
  window.addEventListener("lumin:pet-wake", () => {
    if (root.hidden) return;
    setState("wake", SPEED.wake * FRAMES.wake.length);
  });
  document.addEventListener("fullscreenchange", syncVisibility);
  const player = document.getElementById("player");
  if (player) new MutationObserver(syncVisibility).observe(player, { attributes: true, attributeFilter: ["hidden"] });

  syncVisibility();
  setState("idle");
})();
