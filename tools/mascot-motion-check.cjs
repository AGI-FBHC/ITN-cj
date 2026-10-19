/** Real renderer + Edge + isolated Cangjie core. No model calls or Python fixtures. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-mascot-motion-')),pf=path.join(dir,'port');
  let core,browser,page,passed=0;const failures=[],errors=[];
  const check=(label,ok)=>{if(ok){passed++;console.log('PASS '+label);}else{failures.push(label);console.error('FAIL '+label);}};
  const until=async fn=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(await fn())return;await sleep(100);}throw Error('condition timed out');};
  try{
    core=spawn(process.env.MASCOT_CORE||path.join(root,'core/target/release/bin/main.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+(process.env.MASCOT_UI||path.join(root,'shell/renderer'))],{windowsHide:true,stdio:'ignore'});
    await until(()=>fs.existsSync(pf));const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
    browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:960}});
    page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>!document.getElementById('boot'));
    const actor=page.locator('.lumin-mascot-actor'),pet=page.locator('.lumin-mascot-root'),menu=page.locator('.lumin-mascot-menu');
    const inBounds=async locator=>locator.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+.5&&r.bottom<=innerHeight+.5;});
    const drag=async(x,y)=>{const b=await actor.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(x,y,{steps:8});await page.mouse.up();};
    for(const [name,x,y] of [['top left',-300,-300],['top right',1800,-300],['bottom right',1800,1200],['bottom left',-300,1200]]){
      await drag(x,y);check('drag cannot leave '+name+' boundary',await inBounds(pet));
      await actor.click();await sleep(250);check('menu fits at '+name+' boundary',await inBounds(menu));await actor.click();
    }
    await drag(1800,1200);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lumin:mascot-visibility',{detail:{visible:false}})));
    await page.setViewportSize({width:900,height:600});
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lumin:mascot-visibility',{detail:{visible:true}})));
    check('hidden mascot stays entirely visible after window shrink and restore',await inBounds(pet));
    await page.evaluate(()=>{document.getElementById('player').hidden=false;});await page.waitForFunction(()=>document.querySelector('.lumin-mascot-root').hidden);
    await page.setViewportSize({width:1200,height:850});await page.setViewportSize({width:900,height:600});
    await page.evaluate(()=>{document.getElementById('player').hidden=true;});await page.waitForFunction(()=>!document.querySelector('.lumin-mascot-root').hidden);
    check('closing the player after resize restores the whole mascot',await inBounds(pet));
    await page.evaluate(()=>localStorage.setItem('lumin.mascot.position',JSON.stringify({x:8000,y:8000})));
    await page.reload();await page.waitForFunction(()=>!document.getElementById('boot'));
    check('offscreen saved position is recovered on startup',await inBounds(pet));
    check('recovered position is also saved within the window',await page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('lumin.mascot.position'));return p.x<innerWidth-100&&p.y<innerHeight-110;}));
    // Record real frame changes under frequent activity notifications, like streaming output.
    const motion=await page.evaluate(async()=>{
      const img=document.querySelector('.lumin-mascot-image'),changes=[];
      const observer=new MutationObserver(()=>{const src=img.getAttribute('src');if(src!==changes.at(-1)?.src)changes.push({src,at:performance.now()});});
      observer.observe(img,{attributes:true,attributeFilter:['src']});
      const activity=()=>window.dispatchEvent(new CustomEvent('lumin:activity',{detail:{state:'speaking',busyCount:1}}));activity();
      const repeat=setInterval(activity,80);await new Promise(r=>setTimeout(r,2300));clearInterval(repeat);observer.disconnect();
      return {changes,duration:parseFloat(getComputedStyle(document.querySelector('.lumin-mascot-float')).animationDuration)};
    });
    check('streaming activity does not keep restarting the same frame',new Set(motion.changes.map(c=>c.src)).size>=2);
    const intervals=motion.changes.slice(1).map((c,i)=>c.at-motion.changes[i].at);
    check('real speaking frames change slowly (at least 450ms apart)',intervals.length>=2&&intervals.every(ms=>ms>=450));
    check('floating motion takes at least eight seconds per cycle',motion.duration>=8);
    console.log('MOTION '+JSON.stringify({frameChanges:motion.changes.length,intervals,floatCycleSeconds:motion.duration}));
    await page.emulateMedia({reducedMotion:'reduce'});
    check('reduced motion still disables floating',await page.locator('.lumin-mascot-float').evaluate(e=>getComputedStyle(e).animationName==='none'));
    await page.emulateMedia({reducedMotion:'no-preference'});
    await drag(-300,-300);await actor.click();await sleep(250);
    fs.mkdirSync(path.join(root,'tmp/mascot-motion-shots'),{recursive:true});await page.screenshot({path:path.join(root,'tmp/mascot-motion-shots/top-left-menu.png')});
    check('no browser runtime errors',errors.length===0);
    console.log('RESULT='+(!failures.length?'OK':'FAILED')+' '+passed+' passed, '+failures.length+' failed; data='+dir);
    if(failures.length)process.exitCode=1;
  }catch(e){console.error(e.stack);process.exitCode=1;}
  finally{if(browser)await browser.close();if(core&&!core.killed)core.kill();}
})();
