/**
 * 真实 Edge + 隔离仓颉内核的拖拽坐标回归。
 * 重点覆盖 body zoom 下“鼠标走了 A、控件实际移动 B”的偏移：
 * 桌宠、主侧栏分隔条、知识网络、思维导图、协作面板。
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
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-drag-offset-'));
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
  const near=(actual,expected,tolerance=3)=>Math.abs(actual-expected)<=tolerance;
  try{
    await until(()=>fs.existsSync(portFile),10000);
    const base='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').trim();
    const post=async(url,body={})=>{
      const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const payload=await response.json();
      if(payload.code!==0)throw Error(url+': '+payload.message);
      return payload.data;
    };
    const courseJob=await post('/api/course/generate',{kbId:'course-alpha'});
    let courseState;
    for(let i=0;i<180;i++){
      courseState=await post('/api/course/job',{id:courseJob.id});
      if(courseState.status!=='running')break;
      await sleep(100);
    }
    if(courseState.status!=='completed')throw Error('课程夹具没有生成：'+JSON.stringify(courseState));
    await post('/api/models/save',{id:'drag-fixture',name:'拖拽夹具',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture',model:'fixture'});
    await post('/api/models/roles',{chatModelId:'drag-fixture'});
    const nodes=[];
    for(let i=0;i<5;i++){
      const saved=await post('/api/knowledge/save',{title:'拖拽知识点 '+i,definition:'用于真实拖拽坐标验证。',color:['#5A8DEE','#2FB8A6','#E4B363','#E07A5F','#7BC96F'][i]});
      nodes.push(saved.id);
      if(i)await post('/api/knowledge/link',{from:nodes[i-1],to:saved.id,label:'关联'});
    }

    browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);
    await page.waitForSelector('#chat-input');
    await page.waitForFunction(()=>!document.getElementById('boot'));
    await page.evaluate(()=>go('chat'));
    await page.waitForFunction(()=>current==='chat'&&document.getElementById('view')?.getAttribute('aria-busy')==='false');
    await sleep(500);

    const dragBy=async(locator,dx,dy)=>{
      const box=await locator.boundingBox();
      if(!box)throw Error('目标不可见');
      const start=[box.x+box.width/2,box.y+box.height/2];
      await page.mouse.move(...start);
      await page.mouse.down();
      await page.mouse.move(start[0]+dx,start[1]+dy,{steps:12});
      await page.mouse.up();
      await sleep(80);
    };
    const boxDelta=async(locator,before)=>locator.evaluate((element,b)=>{const r=element.getBoundingClientRect();return{x:r.x-b.x,y:r.y-b.y,w:r.width-b.w,h:r.height-b.h};},before);
    const rect=locator=>locator.evaluate(element=>{const r=element.getBoundingClientRect(),style=getComputedStyle(element);return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom,hidden:element.hidden,display:style.display};});

    for(const zoom of [0.85,1,1.3]){
      await page.evaluate(async value=>{await setZoom(value);},zoom);
      await page.waitForFunction(value=>Math.abs(Number(document.body.style.zoom)-value)<.001,zoom);
      await sleep(220);

      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lumin:mascot-visibility',{detail:{visible:true}})));
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lumin:mascot-reset')));
      await until(()=>page.locator('.lumin-mascot-root').isVisible());
      await sleep(60);
      const pet=page.locator('.lumin-mascot-root');
      const petBefore=await rect(pet);
      const petInsideBefore=petBefore.x>=0&&petBefore.y>=0&&petBefore.right<=1440.5&&petBefore.bottom<=960.5;
      check('desktop pet remains inside viewport after zoom change '+zoom,petInsideBefore,JSON.stringify(petBefore));
      if(petInsideBefore){
        const petDragX=-120,petDragY=-80;
        await dragBy(page.locator('.lumin-mascot-actor'),petDragX,petDragY);
        const petMoved=await boxDelta(pet,petBefore);
        const petAfter=await rect(pet);
        check('desktop pet follows pointer at zoom '+zoom,near(petMoved.x,petDragX)&&near(petMoved.y,petDragY),JSON.stringify({before:petBefore,after:petAfter,moved:petMoved}));
      }else{
        check('desktop pet follows pointer at zoom '+zoom,false,'zoomed starting position is outside viewport');
      }
      if(petInsideBefore){
        await dragBy(page.locator('.lumin-mascot-actor'),-2000,-2000);
        const petAtCorner=await rect(pet);
        check('desktop pet stays inside viewport at zoom '+zoom,petAtCorner.x>=0&&petAtCorner.y>=0&&petAtCorner.right<=1440.5&&petAtCorner.bottom<=960.5,JSON.stringify(petAtCorner));
      }else{
        check('desktop pet stays inside viewport at zoom '+zoom,false,'not draggable because starting position is outside viewport');
      }

      await page.evaluate(()=>go('chat'));
      await page.waitForFunction(()=>current==='chat'&&document.getElementById('view')?.getAttribute('aria-busy')==='false');
      await page.waitForSelector('#panel .splitter-panel');
      await sleep(350);
      const panel=page.locator('#panel');
      const splitter=page.locator('#panel .splitter-panel');
      const beforePanel=await rect(panel);
      const splitDebugBefore=await page.evaluate(()=>{
        const panel=document.getElementById('panel'),handle=panel.querySelector('.splitter-panel'),root=getComputedStyle(document.documentElement);
        return{panelComputedWidth:getComputedStyle(panel).width,panelRectWidth:panel.getBoundingClientRect().width,cssVar:root.getPropertyValue('--panel-w'),zoom:getComputedStyle(document.body).zoom,handle:{x:handle.getBoundingClientRect().x,y:handle.getBoundingClientRect().y,w:handle.getBoundingClientRect().width,h:handle.getBoundingClientRect().height}};
      });
      await dragBy(splitter,90,0);
      const panelMoved=await boxDelta(panel,beforePanel);
      const panelAfter=await rect(panel);
      check('session rail splitter follows pointer at zoom '+zoom,near(panelMoved.w,90),JSON.stringify({beforePanel,afterPanel:panelAfter,moved:panelMoved,debug:splitDebugBefore}));
      await page.evaluate(()=>{layoutW.panel=null;document.documentElement.style.removeProperty('--panel-w');});
      await sleep(100);

      await page.evaluate(async()=>{state.kb='course-alpha';courseUi.kb='course-alpha';await go('learn');});
      await page.waitForSelector('.course-stage .course-node',{timeout:30000});
      const stage=page.locator('.course-stage');
      const node=page.locator('.course-stage .course-node').first();
      const nodeBeforeCourse=await rect(node);
      const stageBox=await stage.boundingBox();
      await page.mouse.move(stageBox.x+stageBox.width*.72,stageBox.y+stageBox.height*.78);
      await page.mouse.down();await page.mouse.move(stageBox.x+stageBox.width*.72+100,stageBox.y+stageBox.height*.78+60,{steps:12});await page.mouse.up();
      await sleep(80);
      const nodeMovedCourse=await boxDelta(node,nodeBeforeCourse);
      check('mind map pan follows pointer at zoom '+zoom,near(nodeMovedCourse.x,100)&&near(nodeMovedCourse.y,60),JSON.stringify(nodeMovedCourse));

      await page.evaluate(()=>go('home'));
      await page.waitForSelector('.knowledge-canvas');
      await page.evaluate(id=>{knowledgeNet.selected=id;knowledgeNet.userInteracted=false;knowledgeNet.fit(true);knowledgeNet.draw();},nodes[0]);
      await sleep(80);
      const probe=await page.evaluate(id=>{
        const node=knowledgeNet.projected.find(item=>item.id===id),canvas=document.querySelector('.knowledge-canvas').getBoundingClientRect();
        return{x:node.x,y:node.y,canvas:{x:canvas.x,y:canvas.y,w:canvas.width,h:canvas.height}};
      },nodes[0]);
      const blank=await page.evaluate(()=>{
        const canvas=document.querySelector('.knowledge-canvas'),w=canvas.clientWidth,h=canvas.clientHeight;
        for(const [x,y] of [[18,h/2],[w-18,h/2],[w/2,18],[w/2,h-18],[w*.18,h*.18],[w*.82,h*.82]]){
          const clear=knowledgeNet.projected.every(node=>{
            const r=Math.max(24,node.r+8),label=node.labelRect;
            const circle=(node.x-x)**2+(node.y-y)**2>r*r;
            const outsideLabel=!label||x<label.x-4||x>label.x+label.w+4||y<label.y-4||y>label.y+label.h+4;
            return circle&&outsideLabel;
          });
          if(clear)return{x,y};
        }
        return{x:8,y:8};
      });
      const canvasStart=[probe.canvas.x+blank.x,probe.canvas.y+blank.y];
      await page.mouse.move(...canvasStart);await page.mouse.down();await page.mouse.move(canvasStart[0]-90,canvasStart[1]-50,{steps:12});await page.mouse.up();
      await sleep(80);
      const probeAfter=await page.evaluate(id=>{const node=knowledgeNet.projected.find(item=>item.id===id);return{x:node.x,y:node.y};},nodes[0]);
      check('knowledge network pan follows pointer at zoom '+zoom,near(probeAfter.x-probe.x,-90)&&near(probeAfter.y-probe.y,-50),JSON.stringify({dx:probeAfter.x-probe.x,dy:probeAfter.y-probe.y}));

      await page.evaluate(id=>{knowledgeNet.userInteracted=false;knowledgeNet.fit(true);knowledgeNet.draw();},nodes[0]);
      await sleep(50);
      const nodeBefore=await page.evaluate(id=>{const node=knowledgeNet.projected.find(item=>item.id===id);return{x:node.x,y:node.y};},nodes[1]);
      const canvasBox=await page.locator('.knowledge-canvas').boundingBox();
      await page.mouse.move(canvasBox.x+nodeBefore.x,canvasBox.y+nodeBefore.y);await page.mouse.down();
      await page.mouse.move(canvasBox.x+nodeBefore.x+80,canvasBox.y+nodeBefore.y+40,{steps:12});await page.mouse.up();
      await sleep(80);
      const nodeAfter=await page.evaluate(id=>{const node=knowledgeNet.projected.find(item=>item.id===id);return{x:node.x,y:node.y};},nodes[1]);
      check('knowledge node drag follows pointer at zoom '+zoom,near(nodeAfter.x-nodeBefore.x,80)&&near(nodeAfter.y-nodeBefore.y,40),JSON.stringify({dx:nodeAfter.x-nodeBefore.x,dy:nodeAfter.y-nodeBefore.y}));

      await page.evaluate(()=>{
        const scrim=document.getElementById('team-panel-scrim'),panel=document.getElementById('team-panel');
        scrim.hidden=false;panel.hidden=false;scrim.style.setProperty('--team-dock-width','420px');
      });
      await sleep(80);
      const team=page.locator('#team-panel-scrim');
      const teamBefore=await rect(team);
      await dragBy(page.locator('#team-resize'),-80,0);
      const teamMoved=await boxDelta(team,teamBefore);
      check('team dock splitter follows pointer at zoom '+zoom,near(teamMoved.w,80),JSON.stringify(teamMoved));
      await page.evaluate(()=>{document.getElementById('team-panel-scrim').hidden=true;document.getElementById('team-panel').hidden=true;});
    }

    check('no renderer exceptions during drag audit',errors.length===0,errors.join(' | '));
    console.log('RESULT='+(!failed?'OK':'FAILED')+' '+passed+' passed, '+failed+' failed; data='+dataDir);
    if(failed)process.exitCode=1;
  }finally{
    if(browser)await browser.close();
    core.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
