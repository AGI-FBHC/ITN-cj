/** Real configured gateway, fresh kernel/database, no user learning data writes.
 * Checks reasoning on/off, native tools + continuation, in-flight mode snapshots,
 * and independent concurrent sessions. Does not benchmark answer quality.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-reasoning-cred-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-reasoning-real-'));
  let core, db;
  try {
    const source = path.join(process.env.LOCALAPPDATA, 'Lumin', 'itn.db');
    for (const suffix of ['', '-wal']) if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, path.join(credDir, 'itn.db') + suffix);
    db = new DatabaseSync(path.join(credDir, 'itn.db'), {readOnly:true});
    const model = db.prepare('SELECT base_url,api_key,model FROM models WHERE id=?').get(process.env.REAL_SMOKE_MODEL_ID || 'deepseek');
    db.close(); db = null;
    if (!model?.api_key) throw new Error('No configured model in credential copy');
    const pf = path.join(dir, 'port');
    core = spawn(path.join(root, 'dist/core/itn-desktop-core.exe'), ['--data-dir=' + dir, '--port-file=' + pf, '--ui-dir=' + path.join(root, 'shell/renderer')], {windowsHide:true, stdio:'ignore', env:{...process.env, cjHeapSize:'2GB'}});
    for (let i=0; i<250 && !fs.existsSync(pf); i++) await pause(100);
    assert(fs.existsSync(pf), 'kernel startup');
    const base = 'http://127.0.0.1:' + fs.readFileSync(pf, 'utf8').trim();
    const post = async (route, body={}) => {
      const response = await fetch(base + '/api/' + route, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(240000)});
      const result = await response.json();
      if (result.code !== 0) throw new Error(route + ': ' + String(result.message).slice(0,220));
      return result.data;
    };
    await post('models/save', {id:'real-reasoning',name:'隔离思考验收',baseUrl:model.base_url,apiKey:model.api_key,model:model.model,reasoningProfile:process.env.REAL_REASONING_PROFILE || 'deepseek'});
    await post('models/roles', {chatModelId:'real-reasoning'});
    const a = (await post('sessions/new')).sessionId, b = (await post('sessions/new')).sessionId;
    await post('sessions/reasoning', {sessionId:a,mode:'low'});
    await post('sessions/reasoning', {sessionId:b,mode:'off'});
    const events = async sid => (await post('sessions/events', {sessionId:sid})).events || [];
    const time = Date.now();
    const pendingA = post('agent/ask-pi', {sessionId:a,web:'off',mode:'chat',exec:'0',question:'只调用 calc 两次，分别计算 (12+8)*3/4 与 7*8。工具返回后用一句话给出两个结果，不要使用其他工具。'});
    const pendingB = post('agent/ask-pi', {sessionId:b,web:'off',mode:'chat',exec:'0',question:'不要调用工具，只回答：并发会话正常。'});
    // Once A has dispatched, changing the saved preference must affect only the next turn.
    for (let i=0;i<100;i++) {
      if ((await events(a)).some(e=>e.type==='model/request')) break;
      await pause(150);
    }
    await post('sessions/reasoning', {sessionId:a,mode:'high'});
    const [ra, rb] = await Promise.all([pendingA,pendingB]);
    const first = await events(a), second = await events(b);
    const requestsA = first.filter(e=>e.type==='model/request').map(e=>e.payload);
    const requestsB = second.filter(e=>e.type==='model/request').map(e=>e.payload);
    if (!ra.ok || !rb.ok) throw new Error('Gateway modes: ' + JSON.stringify({model:model.model,low:{ok:ra.ok,message:ra.message},off:{ok:rb.ok,message:rb.message}}).replaceAll(model.api_key,'[redacted]').slice(0,700));
    assert(requestsA.length>=2 && requestsA.every(p=>p.reasoningMode==='low' && p.reasoning_effort==='low'), 'A snapshot across tool continuation');
    assert(requestsB.length>=1 && requestsB.every(p=>p.reasoningMode==='off' && p.thinking?.type==='disabled'), 'B independent off');
    assert(first.filter(e=>e.type==='tool/result' && e.payload?.tool==='calc' && e.payload?.ok).length>=2, 'native tool results');
    const text = first.filter(e=>e.type==='assistant/message').map(e=>e.payload?.text||'').join(' ');
    assert(/15/.test(text) && /56/.test(text), 'answers use actual tool results');
    assert.equal((await post('agent/reasoning',{sessionId:a})).mode,'high');
    assert.equal((await post('agent/reasoning',{sessionId:b})).mode,'off');
    console.log(JSON.stringify({case:'concurrent-low-off',model:model.model,elapsedMs:Date.now()-time,requestsA:requestsA.length,requestsB:requestsB.length,thinkingA:first.filter(e=>e.type==='assistant/thinking').length,thinkingB:second.filter(e=>e.type==='assistant/thinking').length,usageA:first.findLast(e=>e.type==='turn/usage')?.payload,usageB:second.findLast(e=>e.type==='turn/usage')?.payload}));
    assert(first.some(e=>e.type==='assistant/thinking'), 'low actually returned reasoning');
    assert(!second.some(e=>e.type==='assistant/thinking'), 'off actually disabled reasoning');
    const nextStarted = Date.now();
    const followup = await post('agent/ask-pi', {sessionId:a,web:'off',mode:'chat',exec:'0',question:'请调用 get_reasoning_mode 查看当前模式。然后不要调用其他工具，用一句话列出上一轮的两个计算结果和当前模式。'});
    const all = await events(a), next = all.slice(first.length);
    assert.equal(followup.ok,true);
    assert(next.filter(e=>e.type==='model/request').every(e=>e.payload?.reasoningMode==='high' && e.payload?.reasoning_effort==='high'), 'next turn saved high');
    assert(next.some(e=>e.type==='tool/result' && e.payload?.tool==='get_reasoning_mode' && e.payload?.ok), 'Agent can read mode');
    const nextText = next.filter(e=>e.type==='assistant/message').map(e=>e.payload?.text||'').join(' ');
    assert(/15/.test(nextText) && /56/.test(nextText), 'thinking/tool history survived next turn');
    console.log(JSON.stringify({case:'high-tool-followup',elapsedMs:Date.now()-nextStarted,thinking:next.filter(e=>e.type==='assistant/thinking').length,usage:next.findLast(e=>e.type==='turn/usage')?.payload,ok:true}));
    const setter = await post('agent/ask-pi', {sessionId:a,web:'off',mode:'chat',exec:'0',question:'请把本会话的思考模式设置为关闭。请调用 set_reasoning_mode，mode=off，confirmed=true，之后只简短确认。不要调用其他工具。'});
    const afterSet = (await events(a)).slice(all.length);
    assert.equal(setter.ok,true);
    assert(afterSet.some(e=>e.type==='tool/result' && e.payload?.tool==='set_reasoning_mode' && e.payload?.ok), 'Agent can set user-requested mode');
    assert.equal((await post('agent/reasoning',{sessionId:a})).mode,'off');
    assert(afterSet.filter(e=>e.type==='model/request').every(e=>e.payload?.reasoningMode==='high'), 'setter does not mutate the running tool loop');
    console.log(JSON.stringify({case:'user-requested-mode-tool',savedMode:'off',currentTurnMode:'high',ok:true}));
    console.log('REAL_REASONING=PASS');
  } finally {
    if (db) db.close();
    if (core) { core.kill(); await pause(500); }
    for (const folder of [credDir,dir]) for (const name of ['itn.db','itn.db-wal','itn.db-shm']) {
      const file=path.join(folder,name); if(fs.existsSync(file)) fs.writeFileSync(file,'');
    }
  }
})().catch(e=>{console.error('REAL_REASONING_ERROR '+String(e.message).slice(0,260));process.exitCode=1;});
