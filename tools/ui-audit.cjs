/** 全页面 UI 质量审计：真实内核 + 空数据/示例库 + Playwright。
 *  检查：<12px 可见文字、低对比、横向溢出、无标签图标按钮、整句按钮文案。
 *  每个页面至少跑桌面浅色、桌面深色和 390px 浅色；截图写入 tmp/ui-audit/。 */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const repo=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'itn-ui-audit-')),kb=path.join(dir,'kb'),pf=path.join(dir,'port');
 fs.mkdirSync(kb);fs.writeFileSync(path.join(kb,'01.md'),'# 提示词工程\n\n## 基本概念\n\n提示词是交给模型的输入指令，把约束写清楚。\n','utf8');
 const core=spawn(path.join(repo,'dist/core/itn-desktop-core.exe'),['--data-dir='+dir,'--port-file='+pf,'--ui-dir='+path.join(repo,'shell/renderer')],{windowsHide:true,stdio:'ignore'});
 let browser;
 try{
  for(let i=0;i<200&&!fs.existsSync(pf);i++)await sleep(100);if(!fs.existsSync(pf))throw Error('core did not start');
  const base='http://127.0.0.1:'+fs.readFileSync(pf,'utf8').trim();
  const post=async(name,body={})=>{const r=await fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.code!==0)throw Error(name+': '+j.message);return j.data};
  await post('kb/save',{id:'audit-kb',name:'审计示例库',rootDir:kb});await post('kb/build',{id:'audit-kb'});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});const page=await browser.newPage({viewport:{width:1440,height:950}});const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(base,{waitUntil:'load',timeout:30000});await page.waitForFunction(()=>!document.getElementById('boot'),null,{timeout:20000}).catch(()=>{});await sleep(600);
  const pages=[
   {id:'home',page:'home'},{id:'learn',page:'learn'},{id:'report',page:'report'},
   {id:'notes',page:'notes'},{id:'resources',page:'resources'},{id:'kb',page:'kb'},
   {id:'chat',page:'chat'},{id:'sessions',page:'chat',section:'overview'},{id:'models',page:'models'},
   {id:'settings',page:'settings'},{id:'memory',page:'settings',section:'memory'},{id:'wrong',page:'wrong'}
  ];
  const shotDir=path.join(repo,'tmp','ui-audit');fs.mkdirSync(shotDir,{recursive:true});const report={};
  const configs=[{theme:'light',width:1440,height:950},{theme:'dark',width:1440,height:950},{theme:'light',width:390,height:844}];
  for(const cfg of configs){
   await page.setViewportSize({width:cfg.width,height:cfg.height});await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),cfg.theme);await sleep(250);
   for(const spec of pages){
    await page.evaluate(s=>go(s.page,s.section||null),spec);await sleep(450);
    const key=cfg.theme+'/'+cfg.width+'/'+spec.id;
    await page.screenshot({path:path.join(shotDir,cfg.theme+'-'+cfg.width+'-'+spec.id+'.png')});
    report[key]=await page.evaluate(()=>{
      const parse=s=>{const t=String(s).trim();if(!/^rgba?\(/i.test(t))return null;const m=t.match(/[\d.]+/g);return m?m.slice(0,3).map(Number):null};
      const lum=c=>{const x=c.map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*x[0]+.7152*x[1]+.0722*x[2]};
      const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
      const bgOf=el=>{let n=el;while(n&&n!==document.documentElement){const cs=getComputedStyle(n),c=cs.backgroundColor,v=parse(c),nums=String(c).match(/[\d.]+/g)||[],alpha=String(c).startsWith('rgba')?Number(nums[3]):1;if(cs.backgroundImage&&cs.backgroundImage!=='none')return null;if(v&&alpha>.6)return v;n=n.parentElement}return [255,255,255]};
      const roots=Array.from(document.querySelectorAll('#view,.topbar,#panel'));
      const els=new Set();for(const r of roots)r.querySelectorAll('*').forEach(e=>els.add(e));
      const tiny=[],low=[],sentences=[];
      for(const el of els){const rect=el.getBoundingClientRect();if(!el.offsetParent||rect.width<=0||rect.height<=0||!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))continue;const cs=getComputedStyle(el),fs=parseFloat(cs.fontSize);const direct=Array.from(el.childNodes).some(n=>n.nodeType===3&&n.textContent.trim().length>1);if(!direct)continue;const text=el.textContent.trim().replace(/\s+/g,' ');if(!text)continue;if(fs<12)tiny.push(Math.round(fs*10)/10+'px · '+text.slice(0,30));const fg=parse(cs.color),bg=bgOf(el),inControl=!!el.closest('button,.btn,a,input,select,textarea');if(fg&&bg&&!inControl&&ratio(fg,bg)<4.5)low.push(Math.round(ratio(fg,bg)*100)/100+':1 · '+text.slice(0,30));}
      for(const b of document.querySelectorAll('#view button')){if(!b.offsetParent||!b.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||b.classList.contains('chip'))continue;const t=b.textContent.trim().replace(/\s+/g,' ');if(!t)continue;const sentence=/[，。！？；：]/.test(t)||t.length>8||/^(请|可以|如果|点击|根据|把|将|帮我)/.test(t);if(sentence)sentences.push(t.slice(0,50));}
      const iconBtns=Array.from(document.querySelectorAll('#view button')).filter(b=>b.offsetParent&&!b.textContent.trim());const noLabel=iconBtns.filter(b=>!b.getAttribute('aria-label')&&!b.getAttribute('title'));
      return {tiny:[...new Set(tiny)].slice(0,30),low:[...new Set(low)].slice(0,20),sentenceButtons:[...new Set(sentences)].slice(0,20),iconButtons:iconBtns.length,iconNoLabel:noLabel.length,hScroll:document.documentElement.scrollWidth>window.innerWidth+2,current: typeof current==='string'?current:''};
    });
    report[key].pageErrors=pageErrors.splice(0);
   }
  }
  fs.writeFileSync(path.join(shotDir,'report.json'),JSON.stringify(report,null,2));
  const bad=Object.entries(report).filter(([,v])=>v.tiny.length||v.low.length||v.sentenceButtons.length||v.iconNoLabel||v.hScroll||v.pageErrors.length);
  for(const [k,v] of Object.entries(report)){const flags=[];if(v.tiny.length)flags.push('小字'+v.tiny.length);if(v.low.length)flags.push('低对比'+v.low.length);if(v.sentenceButtons.length)flags.push('整句按钮'+v.sentenceButtons.length);if(v.iconNoLabel)flags.push('无标签图标'+v.iconNoLabel);if(v.hScroll)flags.push('横向溢出');if(v.pageErrors.length)flags.push('JS异常'+v.pageErrors.length);console.log((flags.length?'FAIL':'PASS')+'  '+k+(flags.length?'  '+flags.join(' / '):''));}
  console.log('\nSUMMARY combos='+Object.keys(report).length+' bad='+bad.length+' report='+path.join(shotDir,'report.json'));
  if(bad.length){const summary={};for(const [k,v] of bad)summary[k]={tiny:v.tiny,low:v.low,sentenceButtons:v.sentenceButtons,iconNoLabel:v.iconNoLabel,hScroll:v.hScroll,pageErrors:v.pageErrors};console.log(JSON.stringify(summary,null,1));process.exitCode=1;}
 }finally{if(browser)await browser.close();core.kill()}
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
