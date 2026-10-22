const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
async function readResourceFile(input){
  const file=path.resolve(String(input||'')),ext=path.extname(file).toLowerCase(),stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>32*1024*1024)throw Error('预览文件须小于32MiB');
  const base={ok:true,path:file,name:path.basename(file),size:stat.size};
  if(['.pptx','.pptm','.ppt'].includes(ext)){
    const deck=require('./pptx').readDeck(file),preview=file+'.preview.html';
    return {...base,kind:'pptx',slides:deck.slides||[],text:(deck.slides||[]).map(s=>s.text||'').join('\n\n'),html:fs.existsSync(preview)?fs.readFileSync(preview,'utf8'):''};
  }
  if(['.docx','.docm','.doc'].includes(ext)){const doc=require('./pptx').readDoc(file);return {...base,kind:'docx',text:doc.text||(doc.paragraphs||[]).map(p=>p.text||p).join('\n')};}
  if(['.html','.htm','.md','.markdown','.txt','.json','.csv','.js','.css','.svg'].includes(ext)){
    const text=fs.readFileSync(file,'utf8'),html=['.html','.htm'].includes(ext);
    const indexText=html?text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim():text;
    return {...base,kind:html?'html':ext==='.svg'?'svg':['.md','.markdown'].includes(ext)?'markdown':'text',text,indexText};
  }
  if(ext==='.pdf'){
    const bytes=fs.readFileSync(file),pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc=pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    const task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true,disableFontFace:true});
    const pdf=await task.promise,parts=[];let length=0;
    try{for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i),content=await page.getTextContent(),text=content.items.map(t=>t.str||'').join(' ');parts.push(text);length+=text.length;if(length>1500000)break;}}
    finally{await task.destroy();}
    return {...base,kind:'pdf',text:parts.join('\n\n'),dataUrl:'data:application/pdf;base64,'+bytes.toString('base64')};
  }
  if(['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)){
    const mime=ext==='.jpg'||ext==='.jpeg'?'image/jpeg':'image/'+ext.slice(1);return {...base,kind:'image',dataUrl:'data:'+mime+';base64,'+fs.readFileSync(file).toString('base64'),text:''};
  }
  throw Error('此格式暂不支持内嵌预览，可用系统应用打开');
}
module.exports={readResourceFile};
