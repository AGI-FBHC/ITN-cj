import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';

export default function AdminSettings() {
  const state = useLoad(() => adminApi.kb(), []);
  const [form, setForm] = React.useState(null);
  const [apiKey, setApiKey] = React.useState('');
  const [clearKey, setClearKey] = React.useState(false);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState('');

  const settings = state.data?.settings;

  React.useEffect(() => {
    if (!settings) return;
    setForm({
      baseUrl: settings.baseUrl || '',
      embeddingModel: settings.embeddingModel || '',
      chatModel: settings.chatModel || '',
      ttsModel: settings.ttsModel || '',
      ttsVoice: settings.ttsVoice || '',
      embeddingDim: settings.embeddingDim || 0,
      batchSize: settings.batchSize || 16,
      chunkSize: settings.chunkSize || 800,
      chunkOverlap: settings.chunkOverlap || 120,
      topK: settings.topK || 6,
    });
  }, [settings?.baseUrl, settings?.embeddingModel, settings?.chatModel, settings?.ttsModel, settings?.ttsVoice, settings?.chunkSize, settings?.chunkOverlap, settings?.topK, settings?.batchSize, settings?.embeddingDim]);

  if (state.loading && !state.data) return <Loading label="正在读取配置…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!form) return <ErrorBlock message="配置读取失败" onRetry={state.reload} />;

  const field = (key, cast = (value) => value) => (event) => setForm({ ...form, [key]: cast(event.target.value) });
  const number = (value) => Number(value) || 0;

  return (
    <div className="zx-admin-page">
      <PageHead
        title="设置"
        description="在这里统一配置模型密钥、向量与对话模型、语音合成，保存后立即生效。"
      />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      <div className="zx-card">
        <h2 className="zx-card-title">密钥状态</h2>
        <div className="zx-card-hint" style={{ marginBottom: 10 }}>
          密钥提交后立即加密入库，页面只保留尾号提示，任何接口都不会再返回明文。
          {settings.keySource === 'env' ? ' 当前还在使用环境变量里的旧密钥，保存一次新的即可切过来。' : ''}
        </div>
        <Notice kind={settings.keyConfigured ? 'ok' : 'error'}>
          {settings.keyConfigured
            ? `已配置密钥${settings.keyHint ? `（${settings.keyHint}）` : ''}${settings.keySource === 'env' ? '（来自环境变量）' : ''}。`
            : '还没有配置模型密钥，关键词检索可用，向量检索与 AI 导师不可用。'}
        </Notice>
      </div>

      <form
        className="zx-card"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy('save');
          setError('');
          setMessage('');
          adminApi
            .saveKbSettings({
              ...form,
              baseUrl: form.baseUrl.trim(),
              embeddingModel: form.embeddingModel.trim(),
              chatModel: form.chatModel.trim(),
              ttsModel: form.ttsModel.trim(),
              ttsVoice: form.ttsVoice.trim(),
              apiKey: apiKey.trim(),
              clearApiKey: clearKey,
            })
            .then((saved) => {
              setApiKey('');
              setClearKey(false);
              setMessage(`配置已保存（切片 ${saved.settings.chunkSize} 字 / 重叠 ${saved.settings.chunkOverlap} 字）。已入库的文档需要「重建索引」才会用新参数。`);
              state.reload();
            })
            .catch((failure) => setError(failure.message))
            .finally(() => setBusy(''));
        }}
      >
        <h2 className="zx-card-title">模型接口</h2>
        <div className="zx-form">
          <div className="zx-field zx-field-full">
            <label htmlFor="api-key">模型密钥</label>
            <input
              id="api-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => { setApiKey(event.target.value); setClearKey(false); }}
              placeholder={settings.keyConfigured ? '已保存，留空表示不修改' : '粘贴 API Key，保存后不再显示'}
            />
            <small>向量、对话、语音共用这把密钥；提交即加密，服务端也只以密文落库。</small>
          </div>
          {settings.keyConfigured ? (
            <label htmlFor="clear-key" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, fontWeight: 600, color: '#4b4560' }}>
              <input
                id="clear-key"
                type="checkbox"
                checked={clearKey}
                onChange={(event) => { setClearKey(event.target.checked); if (event.target.checked) setApiKey(''); }}
                style={{ accentColor: '#6038ef', width: 15, height: 15 }}
              />
              清除已保存的密钥
            </label>
          ) : null}
          <div className="zx-field zx-field-full">
            <label htmlFor="base-url">接口地址</label>
            <input
              id="base-url"
              value={form.baseUrl}
              onChange={field('baseUrl')}
              placeholder="https://api.openai.com/v1 或 http://127.0.0.1:11434/v1"
            />
            <small>填到 /v1 这一层即可，后端会拼 <code>/embeddings</code> 与 <code>/chat/completions</code>。</small>
          </div>
          <div className="zx-field">
            <label htmlFor="embedding-model">向量模型</label>
            <input
              id="embedding-model"
              value={form.embeddingModel}
              onChange={field('embeddingModel')}
              placeholder="例如 text-embedding-3-small"
            />
            <small>留空则只做关键词检索。</small>
          </div>
          <div className="zx-field">
            <label htmlFor="chat-model">对话模型</label>
            <input
              id="chat-model"
              value={form.chatModel}
              onChange={field('chatModel')}
              placeholder="例如 gpt-4o-mini 或 qwen-plus"
            />
            <small>AI 导师用它组织回答。</small>
          </div>
          <div className="zx-field">
            <label htmlFor="tts-model">语音合成模型</label>
            <input
              id="tts-model"
              value={form.ttsModel}
              onChange={field('ttsModel')}
              placeholder="例如 gpt-4o-mini-tts 或 tts-1"
            />
            <small>朗读讲义时使用；留空则回退到浏览器自带语音。</small>
          </div>
          <div className="zx-field">
            <label htmlFor="tts-voice">默认音色</label>
            <input
              id="tts-voice"
              value={form.ttsVoice}
              onChange={field('ttsVoice')}
              placeholder="例如 alloy / nova / zh-CN-XiaoxiaoNeural"
            />
          </div>
          <div className="zx-field">
            <label htmlFor="embedding-dim">向量维度</label>
            <input id="embedding-dim" type="number" min="0" value={form.embeddingDim} onChange={field('embeddingDim', number)} />
            <small>仅用于展示，真实维度以接口返回为准。</small>
          </div>
          <div className="zx-field">
            <label htmlFor="batch-size">向量化批大小</label>
            <input id="batch-size" type="number" min="1" max="64" value={form.batchSize} onChange={field('batchSize', number)} />
          </div>
          <div className="zx-field">
            <label htmlFor="chunk-size">切片长度（字）</label>
            <input id="chunk-size" type="number" min="200" max="4000" value={form.chunkSize} onChange={field('chunkSize', number)} />
          </div>
          <div className="zx-field">
            <label htmlFor="chunk-overlap">切片重叠（字）</label>
            <input id="chunk-overlap" type="number" min="0" value={form.chunkOverlap} onChange={field('chunkOverlap', number)} />
            <small>要小于切片长度的一半。</small>
          </div>
          <div className="zx-field">
            <label htmlFor="top-k">默认召回条数</label>
            <input id="top-k" type="number" min="1" max="20" value={form.topK} onChange={field('topK', number)} />
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="submit" className="zx-btn zx-btn-primary" disabled={busy === 'save'}>
            {busy === 'save' ? '保存中…' : '保存配置'}
          </button>
          <button
            type="button"
            className="zx-btn zx-btn-ghost"
            disabled={busy === 'test'}
            onClick={() => {
              setBusy('test');
              setError('');
              setMessage('');
              adminApi
                .testKbModel()
                .then((result) => setMessage(`连接成功：${result.model} 返回 ${result.dim} 维向量。`))
                .catch((failure) => setError(failure.message))
                .finally(() => setBusy(''));
            }}
          >
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
        </div>
      </form>
    </div>
  );
}
