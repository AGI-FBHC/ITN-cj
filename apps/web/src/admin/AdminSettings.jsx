import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';

const SLOTS = [
  {
    key: 'embedding',
    title: '向量模型',
    hint: '把讲义切片转成向量，用于语义检索。留空则只做关键词检索。',
    modelLabel: '模型名',
    modelPlaceholder: '例如 text-embedding-3-small',
  },
  {
    key: 'chat',
    title: '对话模型',
    hint: 'AI 导师用它在检索结果上组织回答。',
    modelLabel: '模型名',
    modelPlaceholder: '例如 gpt-4o-mini 或 qwen-plus',
  },
  {
    key: 'tts',
    title: '语音合成',
    hint: '朗读讲义与导师回答；留空时回退到浏览器自带语音。',
    modelLabel: '模型名',
    modelPlaceholder: '例如 gpt-4o-mini-tts 或 tts-1',
    withVoice: true,
  },
];

function initialForm(settings) {
  const slot = (key) => ({
    baseUrl: settings[key]?.baseUrl || '',
    model: settings[key]?.model || '',
    apiKey: '',
    clearKey: false,
  });
  return {
    embedding: slot('embedding'),
    chat: slot('chat'),
    tts: { ...slot('tts'), voice: settings.ttsVoice || '' },
    chunkSize: settings.chunkSize || 800,
    chunkOverlap: settings.chunkOverlap || 120,
    batchSize: settings.batchSize || 16,
    topK: settings.topK || 6,
    embeddingDim: settings.embeddingDim || 0,
  };
}

export default function AdminSettings() {
  const state = useLoad(() => adminApi.kb(), []);
  const [form, setForm] = React.useState(null);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState('');

  const settings = state.data?.settings;

  React.useEffect(() => {
    if (settings) setForm(initialForm(settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data?.settings]);

  if (state.loading && !state.data) return <Loading label="正在读取配置…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!form) return <ErrorBlock message="配置读取失败" onRetry={state.reload} />;

  const editSlot = (key, patch) => setForm({ ...form, [key]: { ...form[key], ...patch } });
  const number = (value) => Number(value) || 0;

  async function testSlot(key) {
    setBusy(`test-${key}`);
    setError('');
    setMessage('');
    try {
      const result = await adminApi.testKbModel(key);
      const detail = key === 'embedding'
        ? `返回 ${result.dim} 维向量`
        : key === 'chat'
          ? `模型回复 ${result.replyLength} 字`
          : `音色 ${result.voice || '默认'} 可用`;
      setMessage(`${SLOTS.find((slot) => slot.key === key).title}连接成功：${result.model}，${detail}。`);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  function save(event) {
    event.preventDefault();
    setBusy('save');
    setError('');
    setMessage('');
    adminApi
      .saveKbSettings({
        embeddingBaseUrl: form.embedding.baseUrl.trim(),
        embeddingModel: form.embedding.model.trim(),
        embeddingApiKey: form.embedding.apiKey.trim(),
        embeddingClearKey: form.embedding.clearKey,
        chatBaseUrl: form.chat.baseUrl.trim(),
        chatModel: form.chat.model.trim(),
        chatApiKey: form.chat.apiKey.trim(),
        chatClearKey: form.chat.clearKey,
        ttsBaseUrl: form.tts.baseUrl.trim(),
        ttsModel: form.tts.model.trim(),
        ttsVoice: form.tts.voice.trim(),
        ttsApiKey: form.tts.apiKey.trim(),
        ttsClearKey: form.tts.clearKey,
        embeddingDim: form.embeddingDim,
        batchSize: form.batchSize,
        chunkSize: form.chunkSize,
        chunkOverlap: form.chunkOverlap,
        topK: form.topK,
      })
      .then(() => {
        setMessage('配置已保存。已入库的文档需要「重建索引」才会用新的向量模型。');
        state.reload();
      })
      .catch((failure) => setError(failure.message))
      .finally(() => setBusy(''));
  }

  return (
    <div className="zx-admin-page">
      <PageHead
        title="设置"
        description="向量、对话、语音三类模型各自独立配置地址、模型和密钥，保存后立即生效。"
      />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      <form onSubmit={save}>
        {SLOTS.map((slot) => {
          const value = form[slot.key];
          const current = settings[slot.key] || {};
          return (
            <div className="zx-card" key={slot.key} style={{ marginBottom: 16 }}>
              <h2 className="zx-card-title">
                {slot.title}
                {current.keyConfigured
                  ? <span className="zx-pill zx-pill-live">已配置{current.keyHint ? ` · ${current.keyHint}` : ''}</span>
                  : <span className="zx-pill zx-pill-draft">未配置密钥</span>}
              </h2>
              <div className="zx-card-hint">{slot.hint}</div>
              <div className="zx-form">
                <div className="zx-field zx-field-full">
                  <label htmlFor={`${slot.key}-base`}>接口地址</label>
                  <input
                    id={`${slot.key}-base`}
                    value={value.baseUrl}
                    onChange={(event) => editSlot(slot.key, { baseUrl: event.target.value })}
                    placeholder="https://api.openai.com/v1 或 http://127.0.0.1:11434/v1"
                  />
                  <small>填到 /v1 这一层即可。</small>
                </div>
                <div className="zx-field">
                  <label htmlFor={`${slot.key}-model`}>{slot.modelLabel}</label>
                  <input
                    id={`${slot.key}-model`}
                    value={value.model}
                    onChange={(event) => editSlot(slot.key, { model: event.target.value })}
                    placeholder={slot.modelPlaceholder}
                  />
                </div>
                {slot.withVoice ? (
                  <div className="zx-field">
                    <label htmlFor="tts-voice">默认音色</label>
                    <input
                      id="tts-voice"
                      value={value.voice}
                      onChange={(event) => editSlot(slot.key, { voice: event.target.value })}
                      placeholder="例如 alloy / nova"
                    />
                  </div>
                ) : null}
                <div className="zx-field zx-field-full">
                  <label htmlFor={`${slot.key}-key`}>密钥</label>
                  <input
                    id={`${slot.key}-key`}
                    type="password"
                    autoComplete="new-password"
                    value={value.apiKey}
                    onChange={(event) => editSlot(slot.key, { apiKey: event.target.value, clearKey: false })}
                    placeholder={current.keyConfigured ? '已保存，留空表示不修改' : '粘贴密钥，保存后不再显示'}
                  />
                  <small>提交即加密入库，任何接口都不会再返回明文。</small>
                </div>
                {current.keyConfigured ? (
                  <label htmlFor={`${slot.key}-clear`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, fontWeight: 600, color: '#4b4560' }}>
                    <input
                      id={`${slot.key}-clear`}
                      type="checkbox"
                      checked={value.clearKey}
                      onChange={(event) => editSlot(slot.key, { clearKey: event.target.checked, apiKey: event.target.checked ? '' : value.apiKey })}
                      style={{ accentColor: '#6038ef', width: 15, height: 15 }}
                    />
                    清除已保存的密钥
                  </label>
                ) : null}
              </div>
              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="zx-btn zx-btn-ghost"
                  disabled={busy === `test-${slot.key}`}
                  onClick={() => testSlot(slot.key)}
                >
                  {busy === `test-${slot.key}` ? '测试中…' : '测试连接'}
                </button>
              </div>
            </div>
          );
        })}

        <div className="zx-card" style={{ marginBottom: 16 }}>
          <h2 className="zx-card-title">切片与检索</h2>
          <div className="zx-card-hint">这些参数对所有文档生效，改完后需要「重建索引」。</div>
          <div className="zx-form">
            <div className="zx-field">
              <label htmlFor="chunk-size">切片长度（字）</label>
              <input id="chunk-size" type="number" min="200" max="4000" value={form.chunkSize} onChange={(event) => setForm({ ...form, chunkSize: number(event.target.value) })} />
            </div>
            <div className="zx-field">
              <label htmlFor="chunk-overlap">切片重叠（字）</label>
              <input id="chunk-overlap" type="number" min="0" value={form.chunkOverlap} onChange={(event) => setForm({ ...form, chunkOverlap: number(event.target.value) })} />
              <small>要小于切片长度的一半。</small>
            </div>
            <div className="zx-field">
              <label htmlFor="batch-size">向量化批大小</label>
              <input id="batch-size" type="number" min="1" max="64" value={form.batchSize} onChange={(event) => setForm({ ...form, batchSize: number(event.target.value) })} />
            </div>
            <div className="zx-field">
              <label htmlFor="top-k">默认召回条数</label>
              <input id="top-k" type="number" min="1" max="20" value={form.topK} onChange={(event) => setForm({ ...form, topK: number(event.target.value) })} />
            </div>
            <div className="zx-field">
              <label htmlFor="embedding-dim">向量维度</label>
              <input id="embedding-dim" type="number" min="0" value={form.embeddingDim} onChange={(event) => setForm({ ...form, embeddingDim: number(event.target.value) })} />
              <small>仅用于展示，真实维度以接口返回为准。</small>
            </div>
          </div>
        </div>

        <button type="submit" className="zx-btn zx-btn-primary" disabled={busy === 'save'}>
          {busy === 'save' ? '保存中…' : '保存全部配置'}
        </button>
      </form>
    </div>
  );
}
