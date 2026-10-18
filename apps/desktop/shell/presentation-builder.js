const fs=require('node:fs');
const path=require('node:path');
const PptxGenJS=require('pptxgenjs');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const themes={forest:{dark:'203C35',accent:'CBA85F',paper:'F8F7F2'},midnight:{dark:'212A3A',accent:'62C4BE',paper:'F5F6F8'},warm:{dark:'44362F',accent:'BF7257',paper:'F9F4ED'}};
function validate(spec){
  if(!spec || !String(spec.title||'').trim())throw Error('PPT缺少标题');
  if(!Array.isArray(spec.slides)||spec.slides.length<1||spec.slides.length>60)throw Error('PPT页数须为1至60页');
  for(const slide of spec.slides){
    if(!slide.title || slide.title.length>70)throw Error('每页需要不超过70字的标题');
    if(!['cover','bullets','comparison','process','metrics'].includes(slide.layout))throw Error('不支持的PPT版式');
    if((slide.bullets||[]).length>5||(slide.bullets||[]).some(t=>String(t).length>100))throw Error('每页最多5条要点，每条不超过100字；请精简后再制作');
    if((slide.columns||[]).length>3||(slide.columns||[]).some(c=>String(c.body||'').length>180))throw Error('对比列最多3列，每列正文不超过180字');
    if((slide.metrics||[]).length>4)throw Error('每页最多4项关键数字');
  }
}
function presentationHtml(spec){
  validate(spec);const t=themes[spec.theme]||themes.forest;
  const slides=spec.slides.map((s,i)=>`<section class="slide ${esc(s.layout)}"><div class="kicker">${esc(spec.title)} / ${String(i+1).padStart(2,'0')}</div><h1>${esc(s.title)}</h1>${s.layout==='cover'?`<p class="subtitle">${esc(s.subtitle||spec.purpose)}</p><div class="cover-mark">${String(i+1).padStart(2,'0')}</div>`:''}<div class="content">${(s.bullets||[]).map((b,n)=>`<div class="point"><b>${String(n+1).padStart(2,'0')}</b><p>${esc(b)}</p></div>`).join('')}${(s.columns||[]).map(c=>`<article class="column"><h2>${esc(c.title)}</h2><p>${esc(c.body)}</p></article>`).join('')}${(s.metrics||[]).map(m=>`<article class="metric"><strong>${esc(m.value)}</strong><p>${esc(m.label)}</p></article>`).join('')}</div><footer>${esc(spec.audience)} <span>${i+1} / ${spec.slides.length}</span></footer></section>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(spec.title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#e9e9e6;font-family:'Microsoft YaHei',sans-serif;padding:18px}.slide{aspect-ratio:16/9;position:relative;padding:5% 6%;margin:0 auto 20px;background:#${t.paper};color:#${t.dark};overflow:hidden;max-width:1200px;border-radius:6px}.kicker{font-size:clamp(9px,1.5vw,15px);opacity:.6}h1{font-size:clamp(20px,4vw,42px);line-height:1.25;margin:3% 0 6%;max-width:90%}p{line-height:1.6;margin:0;font-size:clamp(11px,1.9vw,22px)}.content{display:flex;flex-direction:column;gap:15px}.point{display:flex;gap:20px;align-items:center}.point b{display:grid;place-items:center;background:#${t.dark};color:#${t.accent};width:38px;height:38px;border-radius:50%;flex:none}.comparison .content,.metrics .content,.process .content{flex-direction:row;gap:3%}.column,.metric,.process .point{flex:1;padding:3%;background:white;border-radius:8px}.column h2{font-size:clamp(14px,2.3vw,27px);margin:0 0 12%}.metric strong{font-size:clamp(28px,5vw,55px);color:#${t.dark}}.process .point{flex-direction:column;align-items:start}.cover{background:#${t.dark};color:white}.cover h1{font-size:clamp(24px,5vw,58px);margin-top:9%;max-width:75%}.subtitle{color:#${t.accent};max-width:70%}.cover-mark{position:absolute;right:7%;bottom:20%;font-size:clamp(60px,14vw,180px);color:#${t.accent};opacity:.45}footer{position:absolute;bottom:5%;left:6%;right:6%;font-size:clamp(8px,1.2vw,14px);opacity:.6}footer span{float:right}@media print{body{padding:0}.slide{break-after:page;margin:0;border-radius:0}}</style>${slides}</html>`;
}
async function buildPresentation(spec,outputPath){
  validate(spec);const theme=themes[spec.theme]||themes.forest,pptx=new PptxGenJS();
  pptx.layout='LAYOUT_WIDE';pptx.author='Lumin';pptx.subject=spec.purpose||'';pptx.title=spec.title;pptx.lang='zh-CN';
  pptx.theme={headFontFace:'Microsoft YaHei',bodyFontFace:'Microsoft YaHei',lang:'zh-CN'};
  const text=(slide,value,box,extra={})=>slide.addText(String(value||''),{...box,fontFace:'Microsoft YaHei',fontSize:22,color:theme.dark,margin:0,breakLine:false,fit:'shrink',...extra});
  for(const [i,s] of spec.slides.entries()){
    const slide=pptx.addSlide(),cover=s.layout==='cover';slide.background={color:cover?theme.dark:theme.paper};
    text(slide,spec.title,{x:.65,y:.35,w:11.8,h:.3},{fontSize:11,color:cover?'C2CEC8':'6E7974'});
    text(slide,s.title,{x:.65,y:cover?1.4:1.0,w:cover?9.8:12.0,h:cover?1.5:1.0},{fontSize:cover?43:34,bold:true,color:cover?'FFFFFF':theme.dark});
    if(cover){text(slide,s.subtitle||spec.purpose,{x:.68,y:3.5,w:9.7,h:.8},{fontSize:22,color:theme.accent});text(slide,String(i+1).padStart(2,'0'),{x:10.6,y:3.4,w:2.0,h:1.7},{fontSize:88,color:theme.accent,bold:true});}
    const bullets=s.bullets||[];
    if(s.layout==='process'){
      const n=Math.max(1,bullets.length),w=(12.0-(n-1)*.22)/n;
      bullets.forEach((b,j)=>{const x=.65+j*(w+.22);slide.addShape('roundRect',{x,y:2.6,w,h:3.4,rectRadius:.15,line:{color:'E1E4DD'},fill:{color:'FFFFFF'}});text(slide,String(j+1).padStart(2,'0'),{x:x+.2,y:2.9,w:w-.4,h:.65},{fontSize:34,color:theme.dark,bold:true});text(slide,b,{x:x+.2,y:3.8,w:w-.4,h:1.8},{fontSize:19});});
    }else if(s.layout==='comparison'){
      const cols=s.columns||[],n=Math.max(1,cols.length),w=(12.0-(n-1)*.35)/n;
      cols.forEach((c,j)=>{const x=.65+j*(w+.35);slide.addShape('roundRect',{x,y:2.5,w,h:3.6,rectRadius:.12,line:{color:'E1E4DD'},fill:{color:'FFFFFF'}});text(slide,c.title,{x:x+.3,y:2.85,w:w-.6,h:.6},{fontSize:26,bold:true});text(slide,c.body,{x:x+.3,y:3.65,w:w-.6,h:2.0},{fontSize:20});});
    }else if(s.layout==='metrics'){
      const metrics=s.metrics||[],n=Math.max(1,metrics.length),w=12.0/n;
      metrics.forEach((m,j)=>{const x=.65+j*w;text(slide,m.value,{x:x+.1,y:2.9,w:w-.2,h:1.1},{fontSize:52,bold:true,color:theme.dark});text(slide,m.label,{x:x+.1,y:4.3,w:w-.35,h:1.0},{fontSize:21});});
    }else if(!cover){
      bullets.forEach((b,j)=>{const y=2.45+j*.72;slide.addShape('ellipse',{x:.75,y:y+.06,w:.38,h:.38,line:{color:theme.dark},fill:{color:theme.dark}});text(slide,String(j+1),{x:.75,y:y+.09,w:.38,h:.27},{fontSize:12,bold:true,color:theme.accent,align:'center'});text(slide,b,{x:1.4,y,w:11.0,h:.62},{fontSize:22});});
    }
    text(slide,spec.audience,{x:.65,y:6.98,w:10.6,h:.24},{fontSize:10,color:cover?'C2CEC8':'6E7974'});
    text(slide,`${i+1} / ${spec.slides.length}`,{x:11.4,y:6.98,w:1.2,h:.24},{fontSize:10,color:cover?'C2CEC8':'6E7974',align:'right'});
    if(s.notes)slide.addNotes(String(s.notes));
  }
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});await pptx.writeFile({fileName:outputPath});
  fs.writeFileSync(outputPath+'.json',JSON.stringify(spec,null,2),'utf8');fs.writeFileSync(outputPath+'.preview.html',presentationHtml(spec),'utf8');
  return {ok:true,path:outputPath,previewPath:outputPath+'.preview.html',slides:spec.slides.length,text:spec.slides.map(s=>[s.title,...(s.bullets||[]),...(s.columns||[]).map(c=>c.title+' '+c.body),...(s.metrics||[]).map(m=>m.value+' '+m.label)].join('\n')).join('\n\n')};
}
module.exports={buildPresentation,presentationHtml,validate};
