const fs=require('node:fs'),path=require('node:path');
function startDesktopBridge(base,dataDir){
  let stopped=false,busy=false;
  const post=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.code!==0)throw Error(j.message);return j.data;};
  async function tick(){
    if(stopped||busy)return;busy=true;
    try{
      const {jobs=[]}=await post('/api/desktop/jobs/list',{});
      for(const job of jobs){
        if(stopped)break;const lease=await post('/api/desktop/jobs/claim',{id:job.id});if(!lease.claimed)continue;
        try{
          const body=lease.body,root=path.resolve(dataDir,'drafts'),output=path.resolve(body.outputPath||'');
          if(!output.startsWith(root+path.sep)||!/^ppt-\d+\.pptx$/.test(path.basename(output)))throw Error('PPT输出路径不属于候选产物目录');
          if(job.kind!=='presentation')throw Error('不支持的桌面任务');
          const result=await require('./presentation-builder').buildPresentation(body.spec,output);
          await post('/api/desktop/jobs/finish',{id:job.id,...result});
        }catch(e){await post('/api/desktop/jobs/finish',{id:job.id,ok:false,error:String(e.message||e)});}
      }
    }catch(e){/* Kernel can be starting or stopping. The owning tool has a bounded wait. */}
    finally{busy=false;}
  }
  const timer=setInterval(tick,350);tick();return()=>{stopped=true;clearInterval(timer);};
}
module.exports={startDesktopBridge};
if(require.main===module){const stop=startDesktopBridge(process.argv[2],process.argv[3]);process.on('SIGTERM',()=>{stop();process.exit(0);});}
