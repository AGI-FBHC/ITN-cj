/** Cangjie writes the fixture; an independent, read-only native SQLite verifies format, rows and indexes.
 * Load scripts/env.ps1 and build third_party/probe before running this check.
 */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumin-freeblock-probe-'));
const file=path.join(dir,'churn.db'),out=path.join(root,process.env.SQLITE_LAYOUT_OUT||'tmp/sqlite-freeblock-check');
fs.mkdirSync(out,{recursive:true});let db,passed=0;
const check=(name,ok)=>{if(!ok)throw Error(name);passed++;console.log('PASS '+name);};
try{
 const writer=spawnSync(process.env.SQLITE_LAYOUT_PROBE||path.join(root,'third_party/probe/target/release/bin/main.exe'),['--freeblock-churn',file],{windowsHide:true,encoding:'utf8',timeout:120000});
 fs.writeFileSync(path.join(out,'writer.log'),JSON.stringify({status:writer.status,signal:writer.signal,error:writer.error?.message})+'\n'+String(writer.stdout||'')+String(writer.stderr||''));
 check('the Cangjie writer preserves rows through 240 updates and a two-byte fragment deletion case',writer.status===0&&/PASS=49 FAIL=0/.test(writer.stdout));
 db=new DatabaseSync(file,{readOnly:true});
 const integrity=db.prepare('PRAGMA integrity_check').all();
 fs.writeFileSync(path.join(out,'integrity.json'),JSON.stringify({file,integrity},null,2));
 check('independent SQLite accepts every B-tree page and index',integrity.length===1&&Object.values(integrity[0])[0]==='ok');
 const rounds=new Array(48).fill(0);for(let round=1;round<=240;round++)rounds[(round*13)%48]=round;
 const expected=key=>`记录 ${key} 第 ${rounds[key]} 轮 `+'a'.repeat(8+(rounds[key]*37+key*17)%180);
 const rows=db.prepare('SELECT k,v FROM churn ORDER BY k').all();
 check('independent SQLite reads the exact latest value of every row',rows.length===48&&rows.every(row=>row.v===expected(Number(row.k.slice(4)))));
 const lookup=db.prepare('SELECT v FROM churn WHERE k=?');
 check('all primary-key lookups match independently decoded values',rounds.every((_,key)=>lookup.get('key-'+key)?.v===expected(key)));
 check('the neighboring-deletion case preserves its surviving row and index',db.prepare('SELECT v FROM fragment_gap WHERE k=?').get('k2')?.v==='x'.repeat(80)&&db.prepare('SELECT COUNT(*) AS n FROM fragment_gap').get().n===1);
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed,file,rows:rows.length,updates:240},null,2));
 console.log('RESULT '+passed+' passed; FILE='+file);
}catch(e){console.error('FAIL '+e.message+'; FILE='+file);process.exitCode=1;}finally{if(db)db.close();}
