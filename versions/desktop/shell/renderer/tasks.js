/* 任务中心：右上角常驻按钮 + 浮层。
   聚合三类真实任务来源（对话轮次 / 导图生成 / 桌面任务），提供进度、停止与跳转。
   固定挂在窗口标题栏，位于连接指示灯右侧。
   不复制任何状态：列表来自 /api/tasks/list，停止走 /api/tasks/cancel（转发到原有取消路径）。 */
(function(){
  const state={box:null,button:null,badge:null,pop:null,list:null,data:null,open:false,mountedIn:'',timer:null};
  const KIND={chat:['chat','对话'],'course-map':['book','思维导图'],ppt:['file','演示文稿'],extract:['db','内容提取']};
  const STATUS={running:'进行中',cancelling:'正在停止',queued:'排队中',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
  const mk=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
  const fmtDur=s=>{s=Math.max(0,Math.floor(Number(s)||0));if(s<60)return s+' 秒';const m=Math.floor(s/60);if(m<60)return m+' 分 '+(s%60)+' 秒';return Math.floor(m/60)+' 时 '+(m%60)+' 分';};
  const fmtTok=t=>{t=Number(t)||0;if(t>=1000000)return (t/1000000).toFixed(1)+'M';if(t>=1000)return (t/1000).toFixed(1)+'k';return String(t);};
  function ensureDom(){
    if(state.box)return;
    const box=mk('div','task-center');
    const b=mk('button','task-btn');b.type='button';b.title='任务中心';b.setAttribute('aria-label','任务中心');b.setAttribute('aria-expanded','false');
    b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h2.5M11 6h9"/><path d="M4 12h2.5M11 12h9"/><path d="M4 18h2.5M11 18h6"/><circle cx="5.2" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="5.2" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="5.2" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg><span class="task-badge" hidden>0</span>';
    b.addEventListener('click',e=>{e.stopPropagation();toggle(!state.open);});
    const pop=mk('div','task-pop');pop.hidden=true;pop.setAttribute('role','dialog');pop.setAttribute('aria-label','任务中心');
    const head=mk('div','task-pop-head');head.append(mk('strong',null,'任务中心'),btnRefresh());
    const list=mk('div','task-list');pop.append(head,list);
    box.append(b,pop);
    state.box=box;state.button=b;state.badge=b.querySelector('.task-badge');state.pop=pop;state.list=list;
  }
  function btnRefresh(){const b=mk('button','task-refresh','刷新');b.type='button';b.addEventListener('click',async e=>{e.stopPropagation();await refresh(true);});return b;}
  function mount(){
    ensureDom();
    const target=document.getElementById('titlebar-tasks');if(!target)return;
    if(state.box.parentElement!==target)target.appendChild(state.box);
  }
  async function refresh(force){
    if(!state.list)return;
    try{
      const data=await api('/api/tasks/list',{});
      state.data=data;syncNotifications(data);paint();
    }catch(e){ console.warn('tasks refresh failed', e); if(force)toast('读取任务失败：'+e.message); }
  }
  function syncNotifications(data){
    window.LuminNotifications?.syncTasks?.(data);
  }
  function paint(){
    if(!state.data)return;
    const running=state.data.running||[],recent=state.data.recent||[];
    const n=running.length;
    state.badge.hidden=n===0;state.badge.textContent=String(n);
    state.button.classList.toggle('has-running',n>0);
    state.button.setAttribute('aria-label',n?'任务中心，'+n+' 个进行中':'任务中心');
    state.list.replaceChildren();
    const sec1=mk('div','task-section',n?('进行中 · '+n):'进行中');
    state.list.appendChild(sec1);
    if(!n){state.list.appendChild(mk('p','task-empty','当前没有正在运行的任务'));}
    for(const t of running)state.list.appendChild(row(t,true));
    if(recent.length){
      state.list.appendChild(mk('div','task-section','最近完成'));
      for(const t of recent.slice(0,6))state.list.appendChild(row(t,false));
    }
  }
  function row(t,running){
    const item=mk('article','task-row'+(t.status==='failed'?' task-failed':''));
    const main=mk('div','task-row-main');
    const GLYPH={chat:'<path d="M4 5h16v10H9l-5 4z"/>','course-map':'<circle cx="12" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M12 8.4v4.1M12 12.5 7.5 15.6M12 12.5l4.5 3.1"/>',ppt:'<path d="M4 4h16v12H4z"/><path d="M8 20h8"/>',extract:'<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/>'};
    const ic=mk('span','task-ic');ic.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+(GLYPH[t.kind]||GLYPH.chat)+'</svg>';
    const text=mk('div','task-row-text');
    text.appendChild(mk('strong','task-title',t.title||'任务'));
    const meta=mk('div','task-meta');
    if(running){
      const chip=mk('span','task-status '+t.status,STATUS[t.status]||t.status);meta.appendChild(chip);
      if(t.stage)meta.appendChild(mk('span',null,t.stage));
      if(Number(t.elapsedSeconds)>0)meta.appendChild(mk('span',null,'已运行 '+fmtDur(t.elapsedSeconds)));
      const p=t.progress||{};const eta=Number(p.etaSeconds)||0;if(eta>0)meta.appendChild(mk('span',null,'剩约 '+fmtDur(eta)));
      if(Number.isFinite(Number(p.percent)))meta.appendChild(mk('span','task-progress',Math.round(Math.max(0,Math.min(100,Number(p.percent))))+'%'));
      const tk=t.tokens||{};if(Number(tk.total)>0)meta.appendChild(mk('span','task-tok','tokens '+fmtTok(tk.total)+'（入 '+fmtTok(tk.in)+' / 出 '+fmtTok(tk.out)+'）'));
    }else{
      meta.appendChild(mk('span','task-status '+t.status,STATUS[t.status]||t.status));
      if(t.updatedAt)meta.appendChild(mk('span',null,String(t.updatedAt).replace('T',' ').slice(5,16)));
    }
    text.appendChild(meta);
    if(running&&t.progress&&Number.isFinite(Number(t.progress.percent))){
      const bar=mk('div','task-bar'),fill=mk('span','task-fill');fill.style.width=Math.max(0,Math.min(100,Number(t.progress.percent)))+'%';bar.appendChild(fill);text.appendChild(bar);
    }
    main.append(ic,text);
    const actions=mk('div','task-actions');
    if(running&&t.cancelable){
      const stop=mk('button','task-act','停止');stop.type='button';stop.addEventListener('click',async e=>{e.stopPropagation();stop.disabled=true;try{await api('/api/tasks/cancel',{id:t.id});toast('已请求停止');}catch(err){toast(err.message);}await refresh(true);});
      actions.appendChild(stop);
    }
    const open=mk('button','task-act primary','打开');open.type='button';open.addEventListener('click',e=>{e.stopPropagation();openTask(t);});
    actions.appendChild(open);
    item.append(main,actions);
    return item;
  }
  function openTask(t){
    toggle(false);
    const link=t.link||{};
    if(link.page==='chat'&&link.sessionId&&typeof openChatSession==='function'){openChatSession(link.sessionId).catch(e=>toast(e.message));return;}
    if(link.page==='learn'){if(link.kbId){state.kb=link.kbId;if(typeof courseUi==='object')courseUi.kb=link.kbId;}go('learn').catch(e=>toast(e.message));return;}
    if(link.page==='resources'){go('resources').catch(e=>toast(e.message));return;}
    go('chat').catch(e=>toast(e.message));
  }
  function toggle(open){
    state.open=open;state.pop.hidden=!open;state.button.classList.toggle('open',open);
    state.button.setAttribute('aria-expanded',String(open));
    if(open){document.dispatchEvent(new CustomEvent('lumin:top-popover-open',{detail:{source:'tasks'}}));refresh(true);}
  }
  const wrap=name=>{const orig=window[name];if(typeof orig!=='function'||orig.__taskWrapped)return;const w=async function(...a){const r=await orig.apply(null,a);mount();return r;};w.__taskWrapped=true;window[name]=w;};
  wrap('go');wrap('workbenchAfterPage');
  document.addEventListener('click',e=>{if(state.pop&&!state.pop.hidden&&!state.box.contains(e.target))toggle(false);});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.pop&&!state.pop.hidden)toggle(false);});
  document.addEventListener('lumin:top-popover-open',e=>{if(e.detail?.source!=='tasks'&&state.open)toggle(false);});
  async function tick(){if(!document.hidden){mount();await refresh(false);}setTimeout(tick,state.open?1500:5000);}
  const start=()=>{mount();refresh(false);setTimeout(tick,1200);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
