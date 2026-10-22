// Real-model smoke test. It copies the user's Lumin database to an isolated
// temporary directory and never prints the model key or full request payload.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sourceDb = path.join(process.env.LOCALAPPDATA || '', 'Lumin', 'itn.db');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (!fs.existsSync(sourceDb)) throw new Error('找不到 Lumin 模型配置数据库：' + sourceDb);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-real-team-'));
  fs.copyFileSync(sourceDb, path.join(dir, 'itn.db'));
  const kb = path.join(dir, 'kb');
  fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, 'mcp.md'), '# MCP\n\nMCP 是模型与外部工具之间的连接协议，强调工具发现、调用和权限边界。');
  fs.writeFileSync(path.join(kb, 'a2a.md'), '# A2A\n\nA2A 是 Agent 之间的协作协议，强调能力发现、任务委派和消息传递。');

  const portFile = path.join(dir, 'port');
  const core = spawn(path.join(root, 'dist/core/itn-desktop-core.exe'), [
    '--data-dir=' + dir,
    '--port-file=' + portFile,
    '--ui-dir=' + path.join(root, 'shell/renderer'),
    '--skills-dir=' + path.join(root, 'shell/skills'),
  ], {windowsHide: true, stdio: 'ignore'});

  try {
    for (let i = 0; i < 120 && !fs.existsSync(portFile); i += 1) await pause(100);
    if (!fs.existsSync(portFile)) throw new Error('内核没有启动');
    const base = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').trim();
    const post = async (url, body) => {
      const response = await fetch(base + url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (data.code !== 0) throw new Error(url + ': ' + data.message);
      return data.data;
    };
    const settings = await (await fetch(base + '/api/settings')).json();
    const cfg = settings.data || {};
    if (!cfg.models?.length || !cfg.chatModelId) throw new Error('当前 Lumin 没有绑定对话模型');
    await post('/api/kb/save', {id: 'real-team', name: '真实模型协作树资料', rootDir: kb});
    await post('/api/kb/build', {id: 'real-team'});
    const sessionId = (await post('/api/sessions/new', {})).sessionId;
    const response = await post('/api/agent/ask-pi', {
      sessionId,
      kbId: 'real-team',
      question: '请必须调用 research_topic_team 工具，以 max_depth=2、max_nodes=5、max_concurrency=2，研究 MCP 与 A2A 的核心区别。不要直接回答，先启动协作树。',
      web: 'off',
    });
    const events = (await post('/api/sessions/events', {sessionId})).events || [];
    const tool = events.find(event => event.type === 'tool/call' && event.payload?.tool === 'research_topic_team');
    const teamEvents = events.filter(event => String(event.type || '').startsWith('team/'));
    const completed = events.filter(event => event.type === 'team/node_completed');
    if (!response.ok) throw new Error('真实模型任务未完成：' + (response.message || ''));
    if (!tool) throw new Error('真实模型没有选择 research_topic_team');
    if (teamEvents.length < 8 || completed.length < 3) throw new Error('真实模型没有产生足够的多级协作事件');
    if (!events.some(event => event.type === 'team/run_completed')) throw new Error('协作树没有完成');
    const report = {
      ok: true,
      sessionId,
      model: cfg.models.find(model => model.id === cfg.chatModelId)?.model || 'configured-model',
      createdNodes: events.filter(event => event.type === 'team/node_created').length,
      completedNodes: completed.length,
      teamEventCount: teamEvents.length,
      answerChars: String(response.answer || '').length,
      isolatedData: dir,
    };
    fs.writeFileSync(path.join(root, 'tmp', 'real-learning-team-check.json'), JSON.stringify(report, null, 2));
    console.log('RESULT real model PASS');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    core.kill();
    // 隔离目录里是含密钥的数据库副本：结束清零，别把凭据留在 TEMP
    try { fs.writeFileSync(path.join(dir, 'itn.db'), ''); } catch (e) { /* ignore */ }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
