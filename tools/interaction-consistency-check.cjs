/**
 * 全局确认框、顶部通知中心与长操作反馈的真实 UI 回归。
 * 真实 Edge + 隔离仓颉内核；通知写入 /api/notifications/*，不使用真实用户数据。
 */
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');

const root=path.resolve(__dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise(resolve=>{
  const server=net.createServer();
  server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
});

(async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-interaction-consistency-'));
  const portFile=path.join(dataDir,'port');
  const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),[
    '--data-dir='+dataDir,
    '--port-file='+portFile,
    '--ui-dir='+path.join(root,'shell/renderer'),
    '--seed-course-fixture=1'
  ],{windowsHide:true,stdio:'ignore'});
  let browser;
  let passed=0,failed=0;
  const failures=[];
  const check=(name,ok,detail='')=>{
    if(ok){passed++;console.log('PASS '+name);return;}
    failed++;failures.push(name);console.error('FAIL '+name+(detail?' :: '+detail:''));
  };
  const until=async(fn,timeout=25000)=>{
    const started=Date.now();
    while(Date.now()-started<timeout){if(await fn())return;await sleep(100);}
    throw Error('等待条件超时');
  };
  try{
    await until(()=>fs.existsSync(portFile),10000);
    const base='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').trim();
    const post=async(route,body={})=>{
      const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const payload=await response.json();
      if(payload.code!==0)throw Error(route+': '+payload.message);
      return payload.data;
    };
    const courseJob=await post('/api/course/generate',{kbId:'course-alpha'});
    await until(async()=>{
      const state=await post('/api/course/job',{id:courseJob.id});
      return state.status!=='running';
    },30000);
    await post('/api/models/save',{id:'interaction-fixture',name:'交互夹具',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture',model:'fixture'});
    await post('/api/models/roles',{chatModelId:'interaction-fixture'});

    browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(()=>!document.getElementById('boot'));
    await page.waitForSelector('.notification-btn',{timeout:15000});
    await page.evaluate(()=>applyZoom(1.3));
    await sleep(120);

    const bell=page.locator('.notification-btn');
    check('the bell is mounted in the title bar',(await bell.count())===1&&await bell.isVisible());
    await page.evaluate(()=>window.LuminNotifications.start({id:'notice-audit-running',title:'导出学习报告',detail:'正在汇总学习记录',page:'report'}));
    await until(()=>page.evaluate(()=>document.querySelectorAll('.notification-row').length>=0));
    check('a long action creates a running notification',await page.evaluate(()=>window.LuminNotifications.list().some(n=>n.id==='notice-audit-running'&&n.status==='running')));
    await bell.click();
    await page.waitForSelector('.notification-pop:not([hidden])');
    const shots=path.join(root,'tmp/interaction-consistency');
    fs.mkdirSync(shots,{recursive:true});
    await page.screenshot({path:path.join(shots,'notifications.png')});
    const popBounds=await page.locator('.notification-pop').evaluate(element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};});
    check('the notification panel stays inside the zoomed viewport',popBounds.x>=0&&popBounds.y>=0&&popBounds.right<=1440.5&&popBounds.bottom<=960.5,JSON.stringify(popBounds));
    check('the running notification has a visible status',(await page.locator('.notification-row[data-id="notice-audit-running"]').innerText()).includes('进行中'));

    await page.evaluate(()=>window.LuminNotifications.finish('notice-audit-running','success','报告已保存到学习成果'));
    await until(()=>page.evaluate(()=>window.LuminNotifications.list().some(n=>n.id==='notice-audit-running'&&n.status==='success'&&!n.read)));
    check('completion becomes an unread success notification',(await bell.getAttribute('aria-label')).includes('未读'));
    const row=page.locator('.notification-row[data-id="notice-audit-running"]');
    await row.locator('.notification-toggle').click();
    await until(()=>page.evaluate(()=>window.LuminNotifications.list().some(n=>n.id==='notice-audit-running'&&n.read)));
    check('each notification can be marked read individually',(await row.locator('.notification-toggle').innerText())==='标为未读');
    await page.evaluate(()=>window.LuminNotifications.start({id:'notice-audit-second',title:'整理资料',detail:'正在整理章节目录',page:'kb'}));
    await page.evaluate(()=>window.LuminNotifications.finish('notice-audit-second','success','整理完成'));
    await page.getByRole('button',{name:'一键已读',exact:true}).click();
    await until(()=>page.evaluate(()=>window.LuminNotifications.list().filter(n=>n.status!=='running').every(n=>n.read)));
    check('one-click read clears every unread result',await page.locator('.notification-badge').isHidden());
    const stored=await post('/api/notifications/get');
    check('notification history is persisted by the Cangjie kernel',stored.items.length>=2&&stored.items.some(n=>n.id==='notice-audit-running'&&n.read));

    await page.reload();
    await page.waitForFunction(()=>!document.getElementById('boot'));
    await page.waitForSelector('.notification-btn');
    await until(()=>page.evaluate(()=>window.LuminNotifications.list().some(n=>n.id==='notice-audit-running')));
    check('notification history survives a page restart',await page.evaluate(()=>window.LuminNotifications.list().some(n=>n.id==='notice-audit-running'&&n.read)));
    await page.evaluate(()=>{
      for(let i=0;i<70;i++)window.LuminNotifications.push({id:'cap-'+i,title:'容量测试 '+i,detail:'临时通知',status:'success',read:true});
    });
    check('notification history is capped at 60 items',await page.evaluate(()=>window.LuminNotifications.list().length<=60),String(await page.evaluate(()=>window.LuminNotifications.list().length)));
    await page.evaluate(()=>applyZoom(1.3));
    await sleep(100);

    await page.evaluate(()=>{
      const trigger=document.createElement('button');
      trigger.id='modal-trigger';trigger.textContent='触发确认';
      document.body.appendChild(trigger);trigger.focus();
      confirmDialog('删除测试项目？','这条只用于检查全局弹窗。',async()=>{}, {confirmLabel:'继续',danger:false});
    });
    await page.waitForSelector('.app-modal-layer');
    await page.screenshot({path:path.join(shots,'confirmation.png')});
    const modalState=await page.evaluate(()=>{
      const layer=document.querySelector('.app-modal-layer'),modal=layer.querySelector('.app-modal'),r=layer.getBoundingClientRect();
      return{
        bodyChild:layer.parentElement===document.body,
        inView:!!layer.closest('#view'),
        modalRole:modal.getAttribute('role'),
        modalMode:modal.getAttribute('aria-modal'),
        focusInside:modal.contains(document.activeElement),
        layer:{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height},
        action:[...modal.querySelectorAll('.app-modal-actions button')].map(b=>b.textContent)
      };
    });
    check('confirmation is a true global modal, not an inline page card',modalState.bodyChild&&!modalState.inView&&modalState.modalRole==='dialog'&&modalState.modalMode==='true',JSON.stringify(modalState));
    check('confirmation actions use the requested wording',modalState.action.includes('继续')&&modalState.action.includes('取消'),JSON.stringify(modalState.action));
    check('keyboard focus starts inside the modal',modalState.focusInside);
    check('the modal covers the zoomed viewport',modalState.layer.x<=.5&&modalState.layer.y<=.5&&modalState.layer.right>=1439.5&&modalState.layer.bottom>=959.5,JSON.stringify(modalState.layer));
    await page.evaluate(()=>{window.__lastModalKey='';document.addEventListener('keydown',e=>{window.__lastModalKey=e.key;},true);});
    await page.keyboard.press('Escape');
    await sleep(150);
    const escapeState=await page.evaluate(()=>({count:document.querySelectorAll('.app-modal-layer').length,key:window.__lastModalKey,active:document.activeElement?.id||document.activeElement?.tagName}));
    if(escapeState.count){await page.evaluate(()=>document.querySelector('.app-modal-layer')?.remove());}
    check('Escape closes the modal and restores focus',escapeState.count===0&&escapeState.active==='modal-trigger',JSON.stringify(escapeState));

    let releaseBuild;
    const buildGate=new Promise(resolve=>releaseBuild=resolve);
    await page.route('**/api/kb/build',async route=>{await buildGate;await route.continue();});
    await page.evaluate(async()=>{state.kb='course-alpha';await go('kb','manage');});
    await page.waitForSelector('#kb-management .item [aria-label], #kb-management .item');
    const buildButton=page.getByRole('button',{name:/重建索引|建立索引/}).first();
    await buildButton.click();
    await until(()=>page.evaluate(()=>window.LuminNotifications.list().some(n=>n.title==='准备资料'&&n.status==='running')));
    check('a long index build is represented by a bell notification',true);
    check('the waiting progress card is no longer embedded in the page',await page.locator('#view .progress-card').count()===0);
    const busyButtons=await page.evaluate(()=>[...document.querySelectorAll('#view button')].filter(b=>b.getAttribute('aria-busy')==='true'||b.classList.contains('is-busy')).map(b=>({text:b.textContent,disabled:b.disabled,busy:b.getAttribute('aria-busy'),busyKey:b.dataset.busyKey||'',classes:b.className})));
    check('the clicked action still exposes its own busy state',busyButtons.some(b=>b.disabled&&b.busy==='true'),JSON.stringify(busyButtons));
    releaseBuild();
    await until(()=>page.evaluate(()=>window.LuminNotifications.list().some(n=>n.title==='准备资料'&&n.status==='success')),30000);
    await page.unroute('**/api/kb/build');
    check('the same running notification becomes a persisted result',true);
    check('no renderer exceptions during interaction audit',errors.length===0,errors.join(' | '));
    console.log('RESULT='+(!failed?'OK':'FAILED')+' '+passed+' passed, '+failed+' failed; data='+dataDir);
    if(failed)process.exitCode=1;
  }finally{
    if(browser)await browser.close();
    core.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
