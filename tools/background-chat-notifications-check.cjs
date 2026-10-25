/** Real chat/task/notification integration, isolated Cangjie fixture runtime. No paid model. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {chromium}=require(require.resolve('playwright',{paths:[path.resolve(__dirname,'..'),'D:/Desktop/ITN/ITN/src/frontend/agent-demo']}));
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-background-chat-')),pf=path.join(dir,'port');
const report={dir,scope:'Real Edge + isolated Cangjie task and persistence APIs; built-in delayed model fixture, no external model or user data.',checks:[],errors:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let core,browser,base;
function check(name,value){assert(value,name);report.checks.push(name);console.log('PASS '+name);}
async function until(fn,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error('Timeout: '+label);}
async function post(route,body={}){const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();assert.equal(j.code,0,route+': '+j.message);return j.data;}
(async()=>{try{
 core=spawn(process.env.MBTI_CORE||path.join(root,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+(process.env.ITN_UI_DIR||path.join(root,'shell/renderer')),'--seed-course-fixture=1','--fixture-delay-ms=8000'],{windowsHide:true,stdio:'ignore',env:{...process.env,cjHeapSize:'2GB'}});
 await until(()=>fs.existsSync(pf),'kernel startup');
 base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
 const a=(await post('sessions/new')).sessionId,b=(await post('sessions/new')).sessionId;
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'));
 await page.evaluate(id=>openChatSession(id),a);await page.waitForSelector('#chat-input');
 await page.locator('#chat-input').fill('给我讲讲工具调用');await page.locator('.composer-send').click();
 let task;
 await until(async()=>{task=(await post('tasks/list')).running.find(t=>t.link?.sessionId===a);return !!task;},'actual chat task running');
 const id='task:'+task.id;report.taskId=id;report.sessionId=a;
 const refresh=async()=>{
   if(!await page.locator('.task-pop').isVisible())await page.locator('.task-btn').click();
   await page.locator('.task-refresh').click();
   await page.locator('.notification-btn').click();
 };
 await refresh();
 await until(()=>page.evaluate(id=>window.LuminNotifications.list().some(n=>n.id===id),id),'foreground task synchronized');
 check('the actual foreground chat task does not produce a bell row',await page.locator('.notification-row[data-id="'+id+'"]').count()===0&&await page.evaluate(id=>window.LuminNotifications.list().some(n=>n.id===id&&n.read),id));
 await page.evaluate(id=>openChatSession(id),b);
 await refresh();
 await page.waitForSelector('.notification-row[data-id="'+id+'"]');
 check('switching away surfaces the same task as unread',await page.locator('.notification-row[data-id="'+id+'"] .notification-state').innerText()==='进行中');
 await page.locator('.notification-row[data-id="'+id+'"] .notification-main').click();
 await page.waitForFunction(sid=>current==='chat'&&state.chatSessionId===sid&&state.notificationViewReady,a);
 check('clicking an unread task opens its exact real session and removes it',await page.locator('.notification-row[data-id="'+id+'"]').count()===0);
 await page.evaluate(id=>openChatSession(id),b);await refresh();
 await page.waitForSelector('.notification-row[data-id="'+id+'"]');
 await page.locator('.notification-row[data-id="'+id+'"] .notification-toggle').click();
 await refresh();
 check('same running task polls do not undo manual read state',await page.locator('.notification-row[data-id="'+id+'"]').count()===0);
 await until(async()=>(await post('tasks/list')).recent.some(t=>t.id===task.id&&t.status==='completed'),'actual chat completion',65000);
 await refresh();
 await page.waitForSelector('.notification-row[data-id="'+id+'"]');
 check('a real background completion is a new unread result',await page.locator('.notification-row[data-id="'+id+'"] .notification-state').innerText()==='已完成');
 await page.locator('.notification-row[data-id="'+id+'"] .notification-main').click();
 await page.waitForFunction(sid=>current==='chat'&&state.chatSessionId===sid&&state.notificationViewReady,a);
 await until(async()=>{const data=await post('notifications/get');return data.items.some(n=>n.id===id&&n.read);},'read state persisted');
 check('read state is persisted by the real notification API',true);
 await page.evaluate(()=>window.LuminNotifications.push({id:'plain-tip',status:'success',title:'普通提示',read:false}));
 await page.locator('.notification-btn').click();
 check('ordinary tips are excluded and the bell has no unread rows',await page.locator('.notification-row').count()===0);
 await page.reload();await page.waitForFunction(()=>!document.getElementById('boot'));
 await until(()=>page.evaluate(id=>window.LuminNotifications?.list().some(n=>n.id===id&&n.read),id),'persisted read state reloaded');
 await page.locator('.notification-btn').click();
 check('read task history does not return after a real page reload',await page.locator('.notification-row').count()===0);
 await page.locator('.task-btn').click();
 const row=page.locator('.task-row').filter({hasText:task.title}).first();
 await row.waitFor({state:'visible'});
 check('task center still retains the actual completed task',await row.innerText().then(t=>t.includes('已完成')));
 check('no renderer errors during actual task navigation',report.errors.length===0);
 await page.screenshot({path:path.join(dir,'task-center.png')});
 console.log('RESULT=OK '+report.checks.length+' checks; '+dir);
}finally{
 fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
 if(browser)await browser.close();if(core)core.kill();
}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
