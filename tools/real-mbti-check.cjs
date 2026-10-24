/** Real Edge + configured model: eight B answers, explicit save, ENFJ/INTJ comparison.
 * Run only after the new kernel is built. No mocks, whole-suite retries or source DB writes.
 * Env: REAL_TASK_CORE, ITN_UI_DIR, REAL_SMOKE_MODEL_ID (default deepseek),
 * REAL_REASONING_PROFILE (optional override), REAL_MBTI_HEADFUL=1.
 * Reports survive in TEMP; both private credential/data directories are removed on exit.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const {chromium} = require(require.resolve('playwright', {
  paths: ['D:/Desktop/ITN/ITN/src/frontend/agent-demo', path.resolve(__dirname, '..')],
}));

const root = path.resolve(__dirname, '..');
const ROUND_MS = 180000;
const MODEL_ID = 'real-mbti-check';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const privateDirs = new Set();
const report = {
  startedAt: new Date().toISOString(), status: 'running', ok: false,
  limits: {roundMs: ROUND_MS, assessmentAnswers: 8, totalTurns: 12, suiteRetries: 0},
  checks: [], turns: [], stateSnapshots: [], profileSnapshots: [], errors: [],
  styleComparison: {status: 'pending', manualReviewRequired: true, answers: []},
  cleanup: {credentialCopyRemoved: false, kernelDataRemoved: false},
};
const knownQuestions = [
  '学到一个新概念，你通常更愿意怎样理清思路？',
  '刚接触一项陌生知识，你更希望先看到什么？',
  '两种学习方案都可行时，你通常更看重什么？',
  '开始一个持续一周的学习任务，你更喜欢哪种方式？',
  '连续学习后需要恢复状态，你通常更想做什么？',
  '复习一段内容时，哪种方式对你更自然？',
  '同伴请你评价一份作业，你更自然的第一反应是什么？',
  '离截止还有几天，任务已达到基本要求，你更倾向怎样做？',
];
const styleQuestion = '我最近学 Agent 总是容易分心，担心两周内学不完。每天只有 30 分钟，基础一般。你会怎样帮我安排下一步？请给一段具体建议，约 180 字。';
let outputDir, dataDir, credentialDir, model, copiedDb, core, coreError, browser, page, base;
let activeSession = '', cleanupPromise, mbtiStartRequests = 0;
const secrets = new Set();

function redact(value) {
  return JSON.stringify(value, (key, item) => {
    if (/api.?key|authorization|password|secret|access.?token/i.test(key)) return '[redacted]';
    if (typeof item !== 'string') return item;
    let text = item;
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]');
  }, 2);
}

function safeText(value) { return JSON.parse(redact(String(value ?? ''))); }

function summarizeTokens() {
  const known = report.turns.filter(turn => turn.tokens && Number.isFinite(turn.tokens.in) && Number.isFinite(turn.tokens.out));
  const reasoning = known.filter(turn => Number.isFinite(turn.tokens.reasoning));
  return {
    in: known.reduce((sum, turn) => sum + turn.tokens.in, 0),
    out: known.reduce((sum, turn) => sum + turn.tokens.out, 0),
    total: known.reduce((sum, turn) => sum + turn.tokens.in + turn.tokens.out, 0),
    reasoning: reasoning.length ? reasoning.reduce((sum, turn) => sum + turn.tokens.reasoning, 0) : null,
    reasoningIsOutputSubset: true, reportedTurns: known.length, totalTurns: report.turns.length,
    missingUsageRounds: report.turns.filter(turn => !known.includes(turn)).map(turn => turn.name),
  };
}

function writeArtifact(name, value) {
  if (outputDir) fs.writeFileSync(path.join(outputDir, name), typeof value === 'string' ? safeText(value) : redact(value));
}

function persist() {
  report.tokens = summarizeTokens();
  writeArtifact('report.json', report);
}

function check(name, condition) {
  assert(condition, name);
  report.checks.push(name);
  console.log('PASS ' + safeText(name));
}

async function until(predicate, label, deadline = Date.now() + 20000) {
  while (Date.now() < deadline) {
    if (coreError) throw coreError;
    if (core && (core.exitCode !== null || core.signalCode !== null)) throw Error('Isolated kernel exited unexpectedly');
    if (await predicate()) return;
    await pause(Math.min(220, Math.max(0, deadline - Date.now())));
  }
  throw Error('Timeout: ' + label);
}

async function post(route, body = {}, deadline = Date.now() + 10000) {
  const remaining = deadline - Date.now();
  assert(remaining > 0, 'API deadline expired: ' + route);
  const response = await fetch(base + '/api/' + route, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.min(10000, remaining))),
  });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw Error(route + ': ' + safeText(payload.message || 'HTTP ' + response.status));
  return payload.data;
}

async function events(sid, deadline) {
  return (await post('sessions/events', {sessionId: sid}, deadline)).events || [];
}

function normalizeText(text) { return String(text || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, ''); }

function verifyDisplayedQuestion(answer, state) {
  const text = normalizeText(answer);
  const expected = state.currentQuestion;
  const matches = knownQuestions.map((question, index) => text.includes(normalizeText(question)) ? 'q' + (index + 1) : '').filter(Boolean);
  if (!expected) {
    check('completed result does not ask another assessment question', matches.length === 0);
    return;
  }
  const options = expected.options || [];
  const showsPrompt = text.includes(normalizeText(expected.prompt));
  const showsOptions = options.length === 2 && options.every(option => text.includes(normalizeText(option.text)));
  check('response displays only current question ' + expected.id,
    (showsPrompt || showsOptions) && matches.every(id => id === expected.id));
}

async function screenshot(name) {
  if (!page || page.isClosed()) return;
  const leaked = await page.evaluate(values => {
    const visibleText = document.body?.innerText || '';
    return values.some(secret => secret && visibleText.includes(secret));
  }, [...secrets]);
  assert(!leaked, 'Credential text detected: screenshot suppressed');
  await page.screenshot({path: path.join(outputDir, name + '.png'), timeout: 10000});
}

async function observeAssessment(sid, answered, nextAllowed, expectedUser, round, deadline) {
  const state = await post('profile/mbti/state', {sessionId: sid}, deadline);
  const profile = await post('profile/get', {}, deadline);
  assert.equal(state.sessionId, sid, 'assessment belongs to the UI-created session');
  assert(state.answered === answered || state.answered === nextAllowed, 'one user round cannot advance more than one question');
  assert.equal(state.totalQuestions, 8, 'all-B path must not introduce tie-breakers');
  assert.equal(profile.mbtiType, expectedUser, 'profile must not change before explicit confirmation');
  if (state.answered < 8) {
    assert.equal(state.status, 'in_progress');
    assert.equal(state.currentQuestion?.id, 'q' + (state.answered + 1), 'current question matches server progress');
    assert.equal(state.currentQuestion.options?.length, 2, 'exactly two choices for one question');
  } else {
    assert.equal(state.currentQuestion, null);
    assert.equal(state.result?.type, 'INFP');
  }
  assert.equal(state.savedAt, '', 'assessment must not auto-save');
  assert.equal(profile.luminMbtiType, 'ENFJ', 'assessment must not change Lumin type');
  const key = [round.name, state.status, state.answered, profile.mbtiType].join('|');
  if (!round.observedStates?.includes(key)) {
    (round.observedStates ||= []).push(key);
    report.stateSnapshots.push({round: round.name, observedAt: new Date().toISOString(), state});
    report.profileSnapshots.push({round: round.name, profile});
  }
  return state;
}

async function ask(sid, name, question, observe) {
  const round = {name, sessionId: sid, startedAt: new Date().toISOString(), status: 'running', question: '', tools: []};
  report.turns.push(round);
  assert(report.turns.length <= 12, 'hard cap: twelve real model user rounds');
  activeSession = sid;
  let latest = [], before = [], started = Date.now();
  const deadline = started + ROUND_MS;
  try {
    await page.evaluate(id => openChatSession(id), sid);
    await page.locator('#chat-input').waitFor({state: 'visible', timeout: Math.min(20000, deadline - Date.now())});
    before = await events(sid, deadline);
    if (question !== undefined) await page.locator('#chat-input').fill(question);
    round.question = await page.locator('#chat-input').inputValue();
    assert(round.question.trim(), 'UI composer has a real user message');
    console.log('RUN ' + name + ' (limit 180s)');
    await page.locator('.composer-send').click({timeout: Math.min(20000, deadline - Date.now())});
    await until(async () => {
      latest = (await events(sid, deadline)).slice(before.length);
      if (observe) await observe(round, deadline);
      return latest.some(event => event.type === 'turn/end');
    }, name + ' real turn/end', deadline);
    await until(() => page.evaluate(id => !state.chatRequests?.has(id), sid), name + ' composer unlock', deadline);
    latest = (await events(sid, deadline)).slice(before.length);
    const starts = latest.filter(event => event.type === 'turn/start');
    const ends = latest.filter(event => event.type === 'turn/end');
    check(name + ': exactly one actual turn/start and successful turn/end',
      starts.length === 1 && ends.length === 1 && ends[0].payload?.ok === true && starts[0].turnId === ends[0].turnId);
    round.turnId = starts[0].turnId;
    const userMessages = latest.filter(event => event.type === 'user/message');
    check(name + ': composer message reached the real session',
      userMessages.length === 1 && userMessages[0].payload?.text === round.question);
    const toolCalls = latest.filter(event => event.type === 'tool/call');
    const toolResults = latest.filter(event => event.type === 'tool/result');
    round.tools = toolResults.map(event => ({...event.payload}));
    round.toolCalls = toolCalls.map(event => ({...event.payload}));
    check(name + ': no failed, denied or unfinished tools',
      !latest.some(event => event.type === 'tool/denied') && toolResults.every(event => event.payload?.ok === true) &&
      toolCalls.every(call => toolResults.some(result => result.payload?.callId === call.payload?.callId && result.payload?.tool === call.payload?.tool)));
    round.answer = latest.filter(event => event.type === 'assistant/message').map(event => event.payload?.text || '').join('\n');
    check(name + ': final model answer is present', round.answer.trim().length > 0);
    round.turnEnd = ends[0];
    round.status = 'passed';
    await screenshot(name);
    return round;
  } catch (error) {
    round.status = 'failed';
    round.error = safeText(error.message);
    await post('agent/cancel', {sessionId: sid}).catch(() => {});
    await screenshot(name + '-failed').catch(() => {});
    throw error;
  } finally {
    round.elapsedMs = Date.now() - started;
    round.turnEnd ||= latest.findLast(event => event.type === 'turn/end') || null;
    round.answer ||= latest.filter(event => event.type === 'assistant/message').map(event => event.payload?.text || '').join('\n');
    round.tools = latest.filter(event => event.type === 'tool/result').map(event => ({...event.payload}));
    round.toolCalls = latest.filter(event => event.type === 'tool/call').map(event => ({...event.payload}));
    round.tokens = latest.findLast(event => event.type === 'turn/usage')?.payload || null;
    round.eventCounts = Object.fromEntries([...new Set(latest.map(event => event.type))].map(type => [type, latest.filter(event => event.type === type).length]));
    writeArtifact(name + '-events.json', latest);
    writeArtifact(name + '-answer.md', round.answer || 'No completed answer.');
    persist();
    activeSession = '';
  }
}

function loadPrivateModel() {
  const source = path.join(process.env.LOCALAPPDATA || '', 'Lumin', 'itn.db');
  assert(process.env.LOCALAPPDATA && fs.existsSync(source), 'real user model DB exists');
  credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-mbti-credential-'));
  privateDirs.add(credentialDir);
  const target = path.join(credentialDir, 'itn.db');
  // The user DB is only copied. SQLite never opens it, including in read-only mode.
  for (const suffix of ['', '-wal']) if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, target + suffix);
  copiedDb = new DatabaseSync(target, {readOnly: true});
  try {
    const hasReasoning = copiedDb.prepare('PRAGMA table_info(models)').all().some(column => column.name === 'reasoning_profile');
    const wanted = process.env.REAL_SMOKE_MODEL_ID || 'deepseek';
    model = copiedDb.prepare('SELECT base_url,api_key,model' + (hasReasoning ? ',reasoning_profile' : '') + ' FROM models WHERE id=?').get(wanted);
    assert(model?.api_key && model.base_url && model.model, 'configured real model exists for the requested model id');
    for (const value of [model.api_key, encodeURIComponent(model.api_key), JSON.stringify(model.api_key).slice(1, -1)]) secrets.add(value);
    report.model = {id: wanted, model: model.model, source: 'read-only TEMP copy of configured model', mock: false};
  } finally {
    copiedDb.close(); copiedDb = null;
  }
}

async function assessmentFlow() {
  const initial = await post('profile/get');
  check('fresh profile: user MBTI unknown, Lumin ENFJ', initial.mbtiType === '' && initial.luminMbtiType === 'ENFJ');
  report.profileSnapshots.push({round: 'before-assessment', profile: initial});
  await page.evaluate(() => go('settings', 'general'));
  await page.locator('#pf-mbti').waitFor({state: 'visible'});
  check('settings UI shows unknown user and ENFJ Lumin',
    await page.locator('#pf-mbti').inputValue() === '' && await page.locator('#pf-lumin-mbti').inputValue() === 'ENFJ');
  await screenshot('00-settings-entry');
  await page.getByRole('button', {name: '偏好问答', exact: true}).click();
  await page.waitForFunction(() => current === 'chat' && state.chatSessionId && document.querySelector('#chat-input')?.value.includes('MBTI 偏好问答'));
  const sid = await page.evaluate(() => state.chatSessionId);
  report.assessmentSessionId = sid;
  const sessions = (await post('sessions/list', {force: true})).sessions || [];
  check('UI entry creates a persisted real normal session exactly once',
    mbtiStartRequests === 1 && sessions.some(session => session.sessionId === sid && !session.projectId));
  const firstState = await post('profile/mbti/state', {sessionId: sid});
  check('entry starts at q1 without recording an answer', firstState.sessionId === sid && firstState.answered === 0 && firstState.currentQuestion?.id === 'q1');
  const start = await ask(sid, '01-start', undefined,
    (round, deadline) => observeAssessment(sid, 0, 0, '', round, deadline));
  check('start does not answer a question or change preferences',
    !start.toolCalls.some(call => ['answer_mbti_assessment', 'set_mbti_preference'].includes(call.tool)));
  verifyDisplayedQuestion(start.answer, await post('profile/mbti/state', {sessionId: sid}));

  for (let index = 0; index < 8; index++) {
    const before = await post('profile/mbti/state', {sessionId: sid});
    check('before answer ' + (index + 1) + ': server current question is exact', before.answered === index && before.currentQuestion?.id === 'q' + (index + 1));
    const answer = await ask(sid, String(index + 2).padStart(2, '0') + '-answer-q' + (index + 1), 'B',
      (round, deadline) => observeAssessment(sid, index, index + 1, '', round, deadline));
    const calls = answer.toolCalls.filter(call => call.tool === 'answer_mbti_assessment');
    check('answer ' + (index + 1) + ': exactly one genuine answer tool for B and the current id',
      calls.length === 1 && calls[0].args?.questionId === before.currentQuestion.id && calls[0].args?.choice === 'B' && calls[0].args?.quote === 'B');
    check('answer ' + (index + 1) + ': no early preference save tool', !answer.toolCalls.some(call => call.tool === 'set_mbti_preference'));
    const after = await post('profile/mbti/state', {sessionId: sid});
    check('answer ' + (index + 1) + ': exactly one persisted progress increment', after.answered === index + 1 && after.totalQuestions === 8);
    verifyDisplayedQuestion(answer.answer, after);
    const profile = await post('profile/get');
    check('answer ' + (index + 1) + ': user profile still unchanged', profile.mbtiType === '' && profile.luminMbtiType === 'ENFJ');
  }

  const completed = await post('profile/mbti/state', {sessionId: sid});
  const unsaved = await post('profile/get');
  check('eight B answers yield server-scored INFP without saving',
    completed.status === 'completed' && completed.result?.type === 'INFP' && completed.savedAt === '' && unsaved.mbtiType === '');
  report.stateSnapshots.push({round: 'completed-before-confirmation', state: completed});
  check('result includes all four dimension scores and uncertainty',
    completed.result.dimensions?.length === 4 && completed.result.dimensions.every(dimension => dimension.rightScore === 2 && dimension.basis && dimension.uncertainty));
  const confirmation = '确认保存这次测评结果到我的 MBTI 档案。';
  const savedTurn = await ask(sid, '10-confirm-save', confirmation);
  const saves = savedTurn.toolCalls.filter(call => call.tool === 'set_mbti_preference');
  check('confirmation uses the genuine save tool with explicit quote',
    saves.length === 1 && saves[0].args?.confirmed === true && saves[0].args.quote && confirmation.includes(saves[0].args.quote));
  check('confirmation does not answer an extra question', !savedTurn.toolCalls.some(call => call.tool === 'answer_mbti_assessment'));
  const saved = await post('profile/mbti/state', {sessionId: sid});
  const profile = await post('profile/get');
  check('only explicit confirmation persists INFP and saved state',
    saved.status === 'saved' && saved.answered === 8 && saved.savedAt && saved.result?.type === 'INFP' && profile.mbtiType === 'INFP' && profile.luminMbtiType === 'ENFJ');
  report.stateSnapshots.push({round: 'after-confirmation', state: saved});
  report.profileSnapshots.push({round: 'after-confirmation', profile});
}

async function styleFlow() {
  report.styleComparison.question = styleQuestion;
  for (const [index, type] of ['ENFJ', 'INTJ'].entries()) {
    const before = await post('profile/get');
    // Patch only the assistant type. Never reset user MBTI between comparison cases.
    const patched = await post('profile/save', {luminMbtiType: type});
    const comparable = profile => Object.fromEntries(Object.entries(profile).filter(([key]) => !['luminMbtiType', 'updatedAt'].includes(key)));
    assert.deepEqual(comparable(patched), comparable(before), 'Lumin-only profile patch must preserve the user and all other fields');
    check(type + ': only Lumin type changed, user remains INFP', patched.luminMbtiType === type && patched.mbtiType === 'INFP');
    const sid = (await post('sessions/new', {projectId: ''})).sessionId;
    assert(sid && sid !== report.assessmentSessionId, 'comparison uses an independent ordinary conversation');
    check(type + ': ordinary conversation has no assessment context', (await post('profile/mbti/state', {sessionId: sid})).status === 'not_started');
    const answer = await ask(sid, String(index + 11) + '-style-' + type, styleQuestion);
    check(type + ': normal answer does not write MBTI or answer the assessment',
      !answer.toolCalls.some(call => ['set_mbti_preference', 'answer_mbti_assessment'].includes(call.tool)));
    const after = await post('profile/get');
    check(type + ': real conversation preserves both selected types', after.mbtiType === 'INFP' && after.luminMbtiType === type);
    report.styleComparison.answers.push({luminMbtiType: type, userMbtiType: after.mbtiType, sessionId: sid,
      answer: answer.answer, tokens: answer.tokens, screenshot: answer.name + '.png'});
  }
  report.styleComparison.status = 'ready_for_visual_comparison';
  report.styleComparison.reviewCriteria = {
    ENFJ: 'Warm acknowledgement, clear next step, invitational guidance.',
    INTJ: 'Reasoning model, conditions and tradeoffs, concise plan with little preamble.',
    limitation: 'Machine checks prove real execution and profile isolation. Personality flavor requires reading both actual answers.',
  };
  writeArtifact('style-comparison.md', '# Same question\n\n' + styleQuestion + '\n\n' +
    report.styleComparison.answers.map(item => '## Lumin ' + item.luminMbtiType + ' / user INFP\n\n' + item.answer).join('\n\n'));
  await page.evaluate(() => go('settings', 'general'));
  await page.locator('#pf-mbti').waitFor({state: 'visible'});
  check('final settings UI shows saved INFP and latest INTJ selection',
    await page.locator('#pf-mbti').inputValue() === 'INFP' && await page.locator('#pf-lumin-mbti').inputValue() === 'INTJ');
  await screenshot('13-saved-settings');
}

function removePrivateDirectory(directory) {
  if (!directory) return true;
  assert(privateDirs.has(directory) && path.dirname(directory) === path.resolve(os.tmpdir()), 'cleanup restricted to this run TEMP directories');
  fs.rmSync(directory, {recursive: true, force: true, maxRetries: 8, retryDelay: 150});
  return !fs.existsSync(directory);
}

function cleanup() {
  cleanupPromise ||= performCleanup();
  return cleanupPromise;
}

async function performCleanup() {
  const errors = [];
  if (activeSession && base) await post('agent/cancel', {sessionId: activeSession}).catch(() => {});
  if (copiedDb) { try { copiedDb.close(); } catch {} copiedDb = null; }
  if (browser) await browser.close().catch(() => {});
  if (base && core && core.exitCode === null && core.signalCode === null) {
    // Delete model rows before shutdown too; directory removal also erases WAL copies.
    await post('models/roles', {chatModelId: ''}).catch(() => {});
    await post('models/delete', {id: MODEL_ID}).catch(() => {});
  }
  if (core && core.exitCode === null && core.signalCode === null) {
    try {
      core.kill();
      await Promise.race([new Promise(resolve => core.once('exit', resolve)), pause(5000)]);
      if (core.exitCode === null && core.signalCode === null && process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(core.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        await Promise.race([new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve); }), pause(5000)]);
        await Promise.race([new Promise(resolve => core.once('exit', resolve)), pause(1000)]);
      }
      if (core.exitCode === null && core.signalCode === null) errors.push('Isolated kernel did not exit');
    } catch (error) { errors.push(safeText(error.message)); }
  }
  try { report.cleanup.kernelDataRemoved = removePrivateDirectory(dataDir); }
  catch (error) { errors.push(safeText(error.message)); }
  try { report.cleanup.credentialCopyRemoved = removePrivateDirectory(credentialDir); }
  catch (error) { errors.push(safeText(error.message)); }
  model = null;
  if (errors.length) throw Error(errors.join('; '));
}

async function main() {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-real-mbti-report-'));
  console.log('REPORT=' + outputDir);
  try {
    const executable = process.env.REAL_TASK_CORE || path.join(root, 'dist/core/itn-desktop-core.exe');
    assert(fs.existsSync(executable), 'built kernel exists; build it before running this script');
    loadPrivateModel();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-real-mbti-data-'));
    privateDirs.add(dataDir);
    const portFile = path.join(dataDir, 'port');
    core = spawn(executable, ['--data-dir=' + dataDir, '--port-file=' + portFile,
      '--ui-dir=' + (process.env.ITN_UI_DIR || path.join(root, 'shell/renderer')),
      '--skills-dir=' + path.join(root, 'shell/skills')],
    {windowsHide: true, stdio: 'ignore', env: {...process.env, cjHeapSize: '2GB'}});
    core.on('error', error => { coreError = error; });
    await until(() => fs.existsSync(portFile), 'isolated kernel startup');
    const port = fs.readFileSync(portFile, 'utf8').trim();
    assert(/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536, 'kernel port file contains a valid local port');
    base = 'http://127.0.0.1:' + port;
    await post('models/save', {id: MODEL_ID, name: 'MBTI 真实验收', baseUrl: model.base_url, apiKey: model.api_key, model: model.model,
      reasoningProfile: process.env.REAL_REASONING_PROFILE || model.reasoning_profile || 'auto'});
    await post('models/roles', {chatModelId: MODEL_ID});
    browser = await chromium.launch({channel: 'msedge', headless: process.env.REAL_MBTI_HEADFUL !== '1', args: ['--no-proxy-server']});
    page = await browser.newPage({viewport: {width: 1440, height: 960}});
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => { report.errors.push(safeText(error.message)); });
    page.on('request', request => { if (request.url().split('?')[0] === base + '/api/profile/mbti/start') mbtiStartRequests++; });
    await page.goto(base, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('boot'));
    await page.evaluate(() => applyTheme('light'));
    await assessmentFlow();
    await styleFlow();
    check('twelve real UI-submitted user rounds completed without renderer errors',
      report.turns.length === 12 && report.turns.every(turn => turn.status === 'passed') && report.errors.length === 0);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = safeText(error.message);
    console.error('REAL_MBTI_FAILED ' + report.error);
    await screenshot('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    try { await cleanup(); }
    catch (error) {
      report.status = 'failed'; report.cleanup.error = safeText(error.message);
      console.error('CLEANUP_FAILED ' + report.cleanup.error); process.exitCode = 1;
    }
    report.completedAt = new Date().toISOString();
    report.ok = report.status === 'passed' && report.cleanup.kernelDataRemoved && report.cleanup.credentialCopyRemoved;
    persist();
    const tokens = report.tokens;
    console.log('TOKENS in=' + tokens.in + ' out=' + tokens.out + ' total=' + tokens.total +
      ' reasoning=' + (tokens.reasoning ?? 'unreported') + ' reported=' + tokens.reportedTurns + '/' + tokens.totalTurns);
    console.log('REAL_MBTI=' + (report.ok ? 'PASS' : 'FAILED') + ' turns=' + report.turns.length + '/12 report=' + path.join(outputDir, 'report.json'));
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.status = 'interrupted'; process.exitCode = 130;
  cleanup().catch(error => { report.cleanup.error = safeText(error.message); }).finally(() => { persist(); process.exit(130); });
});

main().catch(error => {
  console.error('REAL_MBTI_ERROR ' + safeText(error.message)); process.exitCode = 1;
});
