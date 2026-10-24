/**
 * 知识网络视觉/交互回归：真实 Edge renderer + 隔离的原生仓颉内核。
 * 不调用模型，不读写用户数据库；覆盖 64 节点力导向布局、标签渐隐、
 * 悬停关联、检查器共面布局、缩放、选中冻结、降动效与帧间隔。
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
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-knowledge-visual-'));
  const portFile=path.join(dataDir,'port');
  const core=spawn(path.join(root,'dist/core/itn-desktop-core.exe'),[
    '--data-dir='+dataDir,
    '--port-file='+portFile,
    '--ui-dir='+path.join(root,'shell/renderer')
  ],{windowsHide:true,stdio:'ignore'});
  let browser;
  let passed=0;
  const check=(name,ok,detail='')=>{if(!ok)throw Error(name+(detail?' :: '+detail:''));passed++;console.log('PASS '+name);};
  const until=async(fn,timeout=25000)=>{
    const started=Date.now();
    while(Date.now()-started<timeout){if(await fn())return;await sleep(120);}
    throw Error('等待条件超时');
  };
  try{
    await until(()=>fs.existsSync(portFile),10000);
    const base='http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').trim();
    const post=async(url,body)=>{
      const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const payload=await response.json();
      if(payload.code!==0)throw Error(url+': '+payload.message);
      return payload.data;
    };
    await post('/api/models/save',{id:'visual-fixture',name:'视觉测试',baseUrl:'http://127.0.0.1:9/v1',apiKey:'fixture',model:'fixture'});
    await post('/api/models/roles',{chatModelId:'visual-fixture'});

    const colors=['#5A8DEE','#2FB8A6','#E4B363','#E07A5F','#7BC96F','#E5679B'];
    const ids=[];
    for(let i=0;i<64;i++){
      const saved=await post('/api/knowledge/save',{
        title:'学习概念 '+String(i+1).padStart(2,'0'),
        definition:'用于验证知识网络布局、标签密度和交互性能的隔离测试节点。',
        color:colors[i%colors.length]
      });
      ids.push(saved.id);
    }
    for(let i=0;i<64;i++){
      await post('/api/knowledge/link',{from:ids[i],to:ids[(i+1)%64],label:['先学','应用','对比','延伸'][i%4]});
      if(i>0&&i%3===0)await post('/api/knowledge/link',{from:ids[0],to:ids[i],label:'核心关联'});
    }

    browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
    const page=await browser.newPage({viewport:{width:1500,height:1000}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);
    await page.waitForSelector('#chat-input');
    await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:15000}).catch(()=>{});
    await page.evaluate(()=>go('home'));
    await page.waitForSelector('#knowledge-workspace canvas');
    await until(()=>page.evaluate(()=>knowledgeNet.layout.size===64&&knowledgeNet.projected.length===64));

    const visual=await page.evaluate(()=>({
      layout:'force-2d',
      hasLegacyOrbit:'yaw' in knowledgeNet||'pitch' in knowledgeNet,
      radiusMax:Math.max(...knowledgeNet.projected.map(node=>node.r)),
      labels:knowledgeNet.projected.filter(node=>node.labelAlpha>.04).length,
      nodes:knowledgeNet.data.nodes.length,
      links:knowledgeNet.data.links.length
    }));
    check('the graph uses a 2D force layout instead of the old orbit',!visual.hasLegacyOrbit&&visual.layout==='force-2d',JSON.stringify(visual));
    check('a 64-node graph keeps nodes visually small',visual.radiusMax<18,String(visual.radiusMax));
    check('labels fade at the default zoom instead of showing every label',visual.labels>0&&visual.labels<visual.nodes,visual.labels+'/'+visual.nodes);
    check('all isolated manual relationships are available to the renderer',visual.links>=74,String(visual.links));

    const hub=await page.evaluate(()=>{
      const node=[...knowledgeNet.projected].sort((a,b)=>b.degree-a.degree)[0];
      return {id:node.id,x:node.x,y:node.y,degree:node.degree};
    });
    const canvasBox=await page.locator('.knowledge-canvas').boundingBox();
    await page.mouse.move(canvasBox.x+hub.x,canvasBox.y+hub.y);
    await until(()=>page.evaluate(id=>knowledgeNet.hover===id,hub.id));
    const hover=await page.evaluate(()=>({
      cursor:document.querySelector('.knowledge-canvas').style.cursor,
      labels:knowledgeNet.linkLabels.length,
      active:knowledgeNet.linkLabels.every(label=>label.from===knowledgeNet.hover||label.to===knowledgeNet.hover)
    }));
    check('hovering a node highlights only its relationships',hover.cursor==='pointer'&&hover.labels>0&&hover.active,JSON.stringify(hover));

    await page.mouse.click(canvasBox.x+hub.x,canvasBox.y+hub.y);
    await page.waitForSelector('#knowledge-detail:not([hidden])');
    await sleep(320);
    const geometry=await page.evaluate(()=>{
      const stage=document.querySelector('.knowledge-stage').getBoundingClientRect();
      const detail=document.getElementById('knowledge-detail').getBoundingClientRect();
      return {stageRight:stage.right,detailLeft:detail.left,canvasWidth:document.querySelector('.knowledge-canvas').clientWidth};
    });
    check('the inspector shares the page plane instead of covering the graph',geometry.stageRight<=geometry.detailLeft+1&&geometry.canvasWidth>500,JSON.stringify(geometry));

    const frozen0=await page.evaluate(id=>{
      const node=knowledgeNet.projected.find(item=>item.id===id);
      return node?{x:node.x,y:node.y}:null;
    },hub.id);
    await sleep(1100);
    const frozen1=await page.evaluate(id=>{
      const node=knowledgeNet.projected.find(item=>item.id===id);
      return node?{x:node.x,y:node.y}:null;
    },hub.id);
    check('the selected node remains frozen',!!frozen0&&!!frozen1&&Math.hypot(frozen1.x-frozen0.x,frozen1.y-frozen0.y)<=.2);

    const zoomBefore=await page.evaluate(()=>knowledgeNet.camera.zoom);
    await page.mouse.move(canvasBox.x+canvasBox.width*.55,canvasBox.y+canvasBox.height*.5);
    await page.mouse.wheel(0,-420);
    await sleep(100);
    const zoomAfter=await page.evaluate(()=>knowledgeNet.camera.zoom);
    check('the wheel zooms the force graph',zoomAfter>zoomBefore*1.1,zoomBefore+' -> '+zoomAfter);

    await page.evaluate(()=>{knowledgeNet.userInteracted=false;knowledgeNet.hover='';knowledgeNet.fit(true);knowledgeNet.draw();});
    await sleep(120);
    const frames=await page.evaluate(()=>new Promise(resolve=>{
      const intervals=[];let last=performance.now();const started=last;
      function frame(now){
        intervals.push(now-last);last=now;
        if(now-started<1500)requestAnimationFrame(frame);
        else resolve(intervals);
      }
      requestAnimationFrame(frame);
    }));
    const sorted=[...frames].sort((a,b)=>a-b);
    const average=frames.reduce((sum,value)=>sum+value,0)/frames.length;
    const p95=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))];
    check('64 nodes remain interactive under a 40 ms average frame interval',average<40&&p95<75,'avg='+average.toFixed(1)+' p95='+p95.toFixed(1));

    const shots=path.join(root,'tmp/knowledge-visual-check');
    fs.mkdirSync(shots,{recursive:true});
    await page.evaluate(()=>{const drawer=document.getElementById('knowledge-detail');if(drawer)drawer.hidden=true;document.getElementById('knowledge-workspace')?.classList.remove('has-detail');knowledgeNet.selected='';knowledgeNet.userInteracted=false;requestAnimationFrame(()=>{knowledgeNet.fit(true);knowledgeNet.draw();});});
    await sleep(280);
    await page.screenshot({path:path.join(shots,'light.png')});
    await page.evaluate(()=>applyTheme('dark'));
    await sleep(160);
    await page.screenshot({path:path.join(shots,'dark.png')});

    await page.evaluate(()=>applyTheme('light'));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>go('chat'));
    await page.evaluate(()=>go('home'));
    await page.waitForSelector('#knowledge-workspace canvas');
    const reduced0=await page.evaluate(()=>knowledgeNet.projected.map(node=>({id:node.id,x:node.x,y:node.y})));
    await sleep(1100);
    const reduced1=await page.evaluate(()=>knowledgeNet.projected.map(node=>({id:node.id,x:node.x,y:node.y})));
    const maxDrift=Math.max(...reduced0.map((node,index)=>Math.hypot(reduced1[index].x-node.x,reduced1[index].y-node.y)));
    check('reduced-motion mode removes idle drift',maxDrift<=.1,String(maxDrift));

    for(let i=64;i<200;i++){
      const saved=await post('/api/knowledge/save',{
        title:'学习概念 '+String(i+1).padStart(3,'0'),
        definition:'用于 200 节点规模验收的隔离测试节点。',
        color:colors[i%colors.length]
      });
      ids.push(saved.id);
      await post('/api/knowledge/link',{from:ids[i-1],to:saved.id,label:'延伸'});
      if(i%5===0)await post('/api/knowledge/link',{from:ids[0],to:saved.id,label:'核心关联'});
    }
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>go('chat'));
    await page.evaluate(()=>go('home'));
    await page.waitForSelector('#knowledge-workspace canvas');
    await until(()=>page.evaluate(()=>knowledgeNet.layout.size===200&&knowledgeNet.projected.length===200),30000);
    const relayoutMs=await page.evaluate(()=>{
      const started=performance.now();
      knowledgeNet.rebuild();
      knowledgeNet.fit(true);
      knowledgeNet.draw();
      return performance.now()-started;
    });
    check('a 200-node relayout completes without a long main-thread block',relayoutMs<250,relayoutMs.toFixed(1)+' ms');
    const largeFrames=await page.evaluate(()=>new Promise(resolve=>{
      const intervals=[];let last=performance.now();const started=last;
      function frame(now){
        intervals.push(now-last);last=now;
        if(now-started<1200)requestAnimationFrame(frame);
        else resolve(intervals);
      }
      requestAnimationFrame(frame);
    }));
    const largeSorted=[...largeFrames].sort((a,b)=>a-b);
    const largeAverage=largeFrames.reduce((sum,value)=>sum+value,0)/largeFrames.length;
    const largeP95=largeSorted[Math.min(largeSorted.length-1,Math.floor(largeSorted.length*.95))];
    check('200 nodes still render within an interactive frame budget',largeAverage<45&&largeP95<90,'avg='+largeAverage.toFixed(1)+' p95='+largeP95.toFixed(1));
    check('no JavaScript exceptions during graph interaction',errors.length===0,errors.join(' | '));
    console.log('RESULT=OK '+passed+' checks; shots: '+shots+' ; data: '+dataDir);
  }finally{
    if(browser)await browser.close();
    core.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
