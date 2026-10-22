import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';
import { loadOrgBrand } from '../org-brand.js';
import './org-invites.css';
import './org-onboarding.css';

const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 12;
const emptyOrg = () => ({ name: '', shortName: '', inviteCode: '' });
let onboardingSequence = 0;

function nextKey(prefix) {
  onboardingSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${onboardingSequence.toString(36)}`;
}

function emptyOption() {
  return { value: '', label: '', emoji: '', feedback: '' };
}

function emptyQuestion() {
  return {
    id: nextKey('question'),
    title: '',
    subtitle: '',
    type: 'single',
    required: false,
    options: [emptyOption()],
  };
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    id: `${item?.id || ''}`,
    title: `${item?.title || ''}`,
    subtitle: `${item?.subtitle || ''}`,
    type: item?.type === 'multi' ? 'multi' : 'single',
    required: Boolean(item?.required),
    options: Array.isArray(item?.options) && item.options.length
      ? item.options.map((option) => ({
        value: `${option?.value || ''}`,
        label: `${option?.label || ''}`,
        emoji: `${option?.emoji || ''}`,
        feedback: `${option?.feedback || ''}`,
      }))
      : [emptyOption()],
  }));
}

function submitQuestions(questions) {
  return questions.map((question) => ({
    id: question.id.trim(),
    title: question.title.trim(),
    subtitle: question.subtitle.trim(),
    type: question.type === 'multi' ? 'multi' : 'single',
    required: Boolean(question.required),
    options: question.options.map((option) => ({
      value: option.value.trim(),
      label: option.label.trim(),
      ...(option.emoji.trim() ? { emoji: option.emoji.trim() } : {}),
      ...(option.feedback.trim() ? { feedback: option.feedback.trim() } : {}),
    })),
  }));
}

function websiteProblem(value) {
  const clean = value.trim();
  if (!clean) return '';
  if (clean.length > 512) return '官网链接不能超过 512 个字符。';
  try {
    const parsed = new URL(clean);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '官网链接只支持 http:// 或 https://。';
    if (!parsed.hostname || parsed.username || parsed.password) return '请输入有效的官网地址。';
  } catch {
    return '请输入完整的 http:// 或 https:// 官网地址。';
  }
  return '';
}

function questionsProblem(questions) {
  if (!Array.isArray(questions) || questions.length > MAX_QUESTIONS) {
    return `注册问题最多 ${MAX_QUESTIONS} 道。`;
  }
  const ids = new Set();
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const label = `第 ${index + 1} 道问题`;
    if (!question.id.trim()) return `${label}缺少 ID。`;
    if (!question.title.trim()) return `${label}缺少标题。`;
    if (ids.has(question.id.trim())) return `${label}的 ID 与其他问题重复。`;
    ids.add(question.id.trim());
    if (!['single', 'multi'].includes(question.type)) return `${label}的题型无效。`;
    if (!question.options.length || question.options.length > MAX_OPTIONS) {
      return `${label}需要 1-${MAX_OPTIONS} 个选项。`;
    }
    const values = new Set();
    for (const option of question.options) {
      if (!option.value.trim() || !option.label.trim()) return `${label}存在空白选项值或名称。`;
      if (values.has(option.value.trim())) return `${label}内的选项值不能重复。`;
      values.add(option.value.trim());
    }
  }
  return '';
}

export default function AdminOrg() {
  const organizations = useLoad(() => adminApi.orgs(), []);
  const [selectedId, setSelectedId] = React.useState('');
  const state = useLoad(() => adminApi.orgInfo(selectedId), [selectedId]);
  const [form, setForm] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [newOrg, setNewOrg] = React.useState(emptyOrg);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const org = state.data && (!selectedId || state.data.id === selectedId) ? state.data : null;
  const list = organizations.data?.organizations || [];
  const options = org && !list.some((item) => item.id === org.id) ? [org, ...list] : list;

  React.useEffect(() => {
    if (org) {
      setForm({
        orgId: org.id,
        name: org.name || '',
        shortName: org.shortName || '',
        inviteCode: org.inviteCode || '',
        websiteUrl: org.websiteUrl || '',
        onboardingQuestions: normalizeQuestions(org.onboardingQuestions),
      });
    }
  }, [org?.id, org?.name, org?.shortName, org?.inviteCode, org?.websiteUrl, org?.onboardingQuestions]);

  const begin = (action) => { setBusy(action); setError(''); setMessage(''); };
  const reload = () => { state.reload(); organizations.reload(); };

  async function save(event) {
    event?.preventDefault();
    if (busy || !org || !form) return;
    const websiteIssue = websiteProblem(form.websiteUrl);
    if (websiteIssue) { setError(websiteIssue); return; }
    const questionIssue = questionsProblem(form.onboardingQuestions);
    if (questionIssue) { setError(questionIssue); return; }
    begin('save');
    try {
      await adminApi.updateOrg({
        name: form.name.trim(),
        shortName: form.shortName.trim(),
        inviteCode: form.inviteCode.trim(),
        websiteUrl: form.websiteUrl.trim(),
        onboardingQuestions: submitQuestions(form.onboardingQuestions),
      }, org.id);
      setMessage('机构基础信息、官网链接和注册问题预设已保存。切换邀请码不影响已有账号。');
      reload();
      await loadOrgBrand({ force: true });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  async function create(event) {
    event.preventDefault();
    if (busy) return;
    begin('create');
    try {
      const created = await adminApi.createOrg({ name: newOrg.name.trim(), shortName: newOrg.shortName.trim(), inviteCode: newOrg.inviteCode.trim() });
      setSelectedId(created.id);
      setNewOrg(emptyOrg());
      setCreating(false);
      organizations.reload();
      setMessage('机构已创建，可继续设置 Logo、官网链接和注册问题。');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  async function generateQuestions() {
    if (busy || !org || !form) return;
    begin('generate');
    try {
      const result = await adminApi.generateOrgOnboarding(org.id);
      const generated = normalizeQuestions(result.questions);
      if (generated.length < 5) throw new Error('服务返回的注册问题不足 5 道，请重试。');
      setForm((current) => ({ ...current, onboardingQuestions: generated }));
      setMessage(`已生成 ${generated.length} 道注册问题，尚未保存。请检查后点击保存。`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  function updateQuestion(index, patch) {
    setForm((current) => {
      const onboardingQuestions = current.onboardingQuestions.map((question, questionIndex) =>
        questionIndex === index ? { ...question, ...patch } : question);
      return { ...current, onboardingQuestions };
    });
  }

  function addQuestion() {
    if (!form || form.onboardingQuestions.length >= MAX_QUESTIONS) return;
    setForm((current) => ({
      ...current,
      onboardingQuestions: [...current.onboardingQuestions, emptyQuestion()],
    }));
  }

  function removeQuestion(index) {
    setForm((current) => ({
      ...current,
      onboardingQuestions: current.onboardingQuestions.filter((_, questionIndex) => questionIndex !== index),
    }));
  }

  function updateOption(questionIndex, optionIndex, patch) {
    setForm((current) => {
      const onboardingQuestions = current.onboardingQuestions.map((question, index) => {
        if (index !== questionIndex) return question;
        return {
          ...question,
          options: question.options.map((option, innerIndex) =>
            innerIndex === optionIndex ? { ...option, ...patch } : option),
        };
      });
      return { ...current, onboardingQuestions };
    });
  }

  function addOption(questionIndex) {
    setForm((current) => ({
      ...current,
      onboardingQuestions: current.onboardingQuestions.map((question, index) => {
        if (index !== questionIndex || question.options.length >= MAX_OPTIONS) return question;
        return { ...question, options: [...question.options, emptyOption()] };
      }),
    }));
  }

  function removeOption(questionIndex, optionIndex) {
    setForm((current) => ({
      ...current,
      onboardingQuestions: current.onboardingQuestions.map((question, index) => {
        if (index !== questionIndex || question.options.length <= 1) return question;
        return {
          ...question,
          options: question.options.filter((_, innerIndex) => innerIndex !== optionIndex),
        };
      }),
    }));
  }

  async function upload(file) {
    if (!file || busy || !org) return;
    if (file.size > 4 * 1024 * 1024) { setError('Logo 不能超过 4MB。'); return; }
    begin('logo');
    try {
      await adminApi.uploadOrgLogo(file, org.id);
      setMessage('当前机构 Logo 已更新。');
      reload();
      await loadOrgBrand({ force: true });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  async function removeLogo() {
    if (busy || !org || !window.confirm(`移除“${org.shortName}”的 Logo？`)) return;
    begin('logo');
    try {
      await adminApi.deleteOrgLogo(org.id);
      setMessage('当前机构 Logo 已移除。');
      reload();
      await loadOrgBrand({ force: true });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  async function copyInvite() {
    setError(''); setMessage('');
    try {
      await navigator.clipboard.writeText(org.inviteCode);
      setMessage('已复制当前保存的邀请码。');
    } catch { setError('暂时无法自动复制，请选中已保存的邀请码后手动复制。'); }
  }

  return <div className="zx-admin-page">
    <PageHead title="机构设置" description="管理机构品牌、官网入口、注册邀请码与注册问题预设。" actions={<button type="button" className="zx-btn zx-btn-ghost" disabled={Boolean(busy)} onClick={reload}>刷新</button>} />
    {error && <Notice kind="error">{error}</Notice>}
    {message && <Notice kind="ok">{message}</Notice>}
    <section className="zx-card">
      <div className="zx-org-select-row">
        <div className="zx-field zx-org-select-field"><label htmlFor="org-select">当前机构</label><select id="org-select" value={selectedId || org?.id || ''} disabled={Boolean(busy) || !options.length} onChange={(event) => { setSelectedId(event.target.value); setError(''); setMessage(''); }}>{!options.length && <option value="">正在读取机构…</option>}{options.map((item) => <option key={item.id} value={item.id}>{item.name || item.shortName}</option>)}</select></div>
        <button type="button" className="zx-btn zx-btn-primary" disabled={Boolean(busy)} onClick={() => { setCreating(!creating); setError(''); setMessage(''); }}>{creating ? '收起新增' : '新增机构'}</button>
      </div>
      {organizations.error && <div className="zx-org-list-error"><Notice kind="error">{organizations.error}</Notice><button type="button" className="zx-btn zx-btn-ghost" onClick={organizations.reload}>重试列表</button></div>}
      {creating && <form className="zx-org-create" onSubmit={create}>
        <h2 className="zx-card-title">新增机构</h2>
        <div className="zx-form">
          <div className="zx-field"><label htmlFor="new-org-name">机构全称</label><input id="new-org-name" required maxLength={128} value={newOrg.name} onChange={(event) => setNewOrg({ ...newOrg, name: event.target.value })} /></div>
          <div className="zx-field"><label htmlFor="new-org-short">机构简称</label><input id="new-org-short" required maxLength={64} value={newOrg.shortName} onChange={(event) => setNewOrg({ ...newOrg, shortName: event.target.value })} /></div>
          <div className="zx-field"><label htmlFor="new-org-invite">注册邀请码</label><input id="new-org-invite" required minLength={6} pattern="[A-Za-z0-9_-]{6,64}" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={64} value={newOrg.inviteCode} onChange={(event) => setNewOrg({ ...newOrg, inviteCode: event.target.value })} /><small>6–64 位字母、数字、短横线或下划线；不同机构不可重复。</small></div>
        </div>
        <div className="zx-org-save-row"><button type="submit" className="zx-btn zx-btn-primary" disabled={Boolean(busy) || !newOrg.name.trim() || !newOrg.shortName.trim() || !newOrg.inviteCode.trim()}>{busy === 'create' ? '创建中…' : '创建机构'}</button></div>
      </form>}
    </section>

    {state.error ? <ErrorBlock message={state.error} onRetry={state.reload} /> : !org || !form || form.orgId !== org.id ? <Loading label="正在读取机构信息…" /> : <>
      <form className="zx-card zx-org-basic-card" onSubmit={save}>
        <div className="zx-org-section-heading">
          <div>
            <h2 className="zx-card-title">基础信息</h2>
            <p>机构名称、品牌入口和注册邀请码统一在这里维护。</p>
          </div>
        </div>

        <div className="zx-form">
          <div className="zx-field"><label htmlFor="org-name">机构全称</label><input id="org-name" required value={form.name} maxLength={128} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
          <div className="zx-field"><label htmlFor="org-short">机构简称</label><input id="org-short" required value={form.shortName} maxLength={64} onChange={(event) => setForm({ ...form, shortName: event.target.value })} /></div>
          <div className="zx-field zx-field-full">
            <label htmlFor="org-website">机构官网</label>
            <input id="org-website" type="url" inputMode="url" maxLength={512} placeholder="https://www.example.edu.cn" value={form.websiteUrl} onChange={(event) => setForm({ ...form, websiteUrl: event.target.value })} />
            <small>可留空；仅支持 http:// 或 https:// 地址。用户端机构 Logo 和简称标签将链接到此地址。</small>
          </div>
        </div>

        <div className="zx-org-basic-block">
          <div className="zx-org-basic-block-head">
            <div><h3>机构 Logo</h3><p>学员端显示所属机构 Logo，管理端仍使用系统 Logo。</p></div>
          </div>
          <div className="zx-org-logo">
            <div className="zx-org-logo-box">{org.logoUrl ? <img key={org.logoUrl} src={org.logoUrl} alt={org.shortName} /> : <span>还没有设置</span>}</div>
            <div className="zx-org-logo-actions">
              <label className={`zx-btn zx-btn-primary${busy ? ' zx-org-upload-busy' : ''}`}>
                {busy === 'logo' ? '上传中…' : '上传 Logo'}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" className="zx-org-file" disabled={Boolean(busy)} onChange={(event) => { upload(event.target.files?.[0]); event.target.value = ''; }} />
              </label>
              {org.logoUrl && <button type="button" className="zx-btn zx-btn-danger" disabled={Boolean(busy)} onClick={removeLogo}>移除</button>}
              <small>支持 PNG / JPEG / WebP / GIF / SVG，不超过 4MB。</small>
            </div>
          </div>
        </div>

        <div className="zx-org-basic-block">
          <div className="zx-field zx-field-full">
            <label htmlFor="org-invite">注册邀请码</label>
            <input id="org-invite" required minLength={6} pattern="[A-Za-z0-9_-]{6,64}" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={form.inviteCode} maxLength={64} onChange={(event) => setForm({ ...form, inviteCode: event.target.value })} />
            <small>6–64 位字母、数字、短横线或下划线。新用户凭此码加入机构；已有账号无须填写。</small>
          </div>
          <div className="zx-org-invite-saved"><span>已保存邀请码：</span><code>{org.inviteCode || '尚未设置'}</code><button type="button" className="zx-btn zx-btn-ghost" disabled={Boolean(busy) || !org.inviteCode} onClick={copyInvite}>复制邀请码</button></div>
        </div>

        <div className="zx-org-save-row"><button type="submit" className="zx-btn zx-btn-primary" disabled={Boolean(busy) || !form.name.trim() || !form.shortName.trim() || !form.inviteCode.trim()}>{busy === 'save' ? '保存中…' : '保存基础信息'}</button></div>
      </form>

      <section className="zx-card zx-onboarding-card">
        <div className="zx-onboarding-heading">
          <div>
            <h2 className="zx-card-title">注册问题预设</h2>
            <p>管理员可维护注册表单，或让管理员已配置的对话模型根据当前已发布课程自动生成。</p>
          </div>
          <div className="zx-onboarding-heading-actions">
            <span className="zx-onboarding-count">{form.onboardingQuestions.length} / {MAX_QUESTIONS} 题</span>
            <button type="button" className="zx-btn zx-btn-ghost" disabled={Boolean(busy)} onClick={generateQuestions}>{busy === 'generate' ? '生成中…' : '自动生成'}</button>
            <button type="button" className="zx-btn" disabled={Boolean(busy) || form.onboardingQuestions.length >= MAX_QUESTIONS} onClick={addQuestion}>新增问题</button>
          </div>
        </div>

        {!form.onboardingQuestions.length && <div className="zx-onboarding-empty">
          <strong>还没有预设问题</strong>
          <span>可以自动生成 5-7 道题，也可以从空白问题开始手工配置。</span>
          <button type="button" className="zx-btn zx-btn-primary" disabled={Boolean(busy)} onClick={addQuestion}>新增第一道问题</button>
        </div>}

        <div className="zx-onboarding-list">
          {form.onboardingQuestions.map((question, questionIndex) => <article className="zx-onboarding-question" key={`question-slot-${questionIndex}`}>
            <div className="zx-onboarding-question-head">
              <div className="zx-onboarding-index">{String(questionIndex + 1).padStart(2, '0')}</div>
              <div className="zx-field zx-onboarding-id-field">
                <label htmlFor={`onboarding-id-${questionIndex}`}>问题 ID</label>
                <input id={`onboarding-id-${questionIndex}`} maxLength={64} spellCheck={false} value={question.id} onChange={(event) => updateQuestion(questionIndex, { id: event.target.value })} />
              </div>
              <button type="button" className="zx-btn zx-btn-danger zx-btn-sm" disabled={Boolean(busy)} onClick={() => removeQuestion(questionIndex)}>删除问题</button>
            </div>

            <div className="zx-onboarding-question-grid">
              <div className="zx-field zx-onboarding-title-field"><label htmlFor={`onboarding-title-${questionIndex}`}>标题</label><input id={`onboarding-title-${questionIndex}`} maxLength={200} value={question.title} onChange={(event) => updateQuestion(questionIndex, { title: event.target.value })} /></div>
              <div className="zx-field"><label htmlFor={`onboarding-type-${questionIndex}`}>题型</label><select id={`onboarding-type-${questionIndex}`} value={question.type} onChange={(event) => updateQuestion(questionIndex, { type: event.target.value })}><option value="single">单选</option><option value="multi">多选</option></select></div>
              <label className="zx-onboarding-required" htmlFor={`onboarding-required-${questionIndex}`}><input id={`onboarding-required-${questionIndex}`} type="checkbox" checked={question.required} onChange={(event) => updateQuestion(questionIndex, { required: event.target.checked })} /><span>注册时必填</span></label>
              <div className="zx-field zx-field-full"><label htmlFor={`onboarding-subtitle-${questionIndex}`}>副标题 / 说明</label><input id={`onboarding-subtitle-${questionIndex}`} maxLength={500} value={question.subtitle} onChange={(event) => updateQuestion(questionIndex, { subtitle: event.target.value })} /></div>
            </div>

            <div className="zx-onboarding-options-head"><strong>选项</strong><span>{question.options.length} / {MAX_OPTIONS}</span></div>
            <div className="zx-onboarding-options">
              {question.options.map((option, optionIndex) => <div className="zx-onboarding-option-row" key={`${questionIndex}-${optionIndex}`}>
                <div className="zx-field"><label htmlFor={`option-value-${questionIndex}-${optionIndex}`}>值</label><input id={`option-value-${questionIndex}-${optionIndex}`} maxLength={128} spellCheck={false} value={option.value} onChange={(event) => updateOption(questionIndex, optionIndex, { value: event.target.value })} /></div>
                <div className="zx-field"><label htmlFor={`option-label-${questionIndex}-${optionIndex}`}>显示名称</label><input id={`option-label-${questionIndex}-${optionIndex}`} maxLength={200} value={option.label} onChange={(event) => updateOption(questionIndex, optionIndex, { label: event.target.value })} /></div>
                <div className="zx-field zx-onboarding-emoji-field"><label htmlFor={`option-emoji-${questionIndex}-${optionIndex}`}>Emoji</label><input id={`option-emoji-${questionIndex}-${optionIndex}`} maxLength={16} value={option.emoji} onChange={(event) => updateOption(questionIndex, optionIndex, { emoji: event.target.value })} /></div>
                <div className="zx-field"><label htmlFor={`option-feedback-${questionIndex}-${optionIndex}`}>选择反馈</label><input id={`option-feedback-${questionIndex}-${optionIndex}`} maxLength={500} value={option.feedback} onChange={(event) => updateOption(questionIndex, optionIndex, { feedback: event.target.value })} /></div>
                <button type="button" className="zx-btn zx-btn-danger zx-btn-sm" disabled={Boolean(busy) || question.options.length <= 1} onClick={() => removeOption(questionIndex, optionIndex)}>删除</button>
              </div>)}
            </div>
            <button type="button" className="zx-btn zx-btn-ghost zx-btn-sm zx-onboarding-add-option" disabled={Boolean(busy) || question.options.length >= MAX_OPTIONS} onClick={() => addOption(questionIndex)}>添加选项</button>
          </article>)}
        </div>

        <div className="zx-onboarding-savebar">
          <span>问题预设与官网链接会随基础信息一起保存。</span>
          <button type="button" className="zx-btn zx-btn-primary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? '保存中…' : '保存全部设置'}</button>
        </div>
      </section>
    </>}
  </div>;
}
