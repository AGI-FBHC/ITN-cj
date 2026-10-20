import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';

export default function AdminSettings() {
  const state = useLoad(() => adminApi.kb(), []);
  const [form, setForm] = React.useState(null);
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
      embeddingDim: settings.embeddingDim || 0,
      batchSize: settings.batchSize || 16,
      chunkSize: settings.chunkSize || 800,
      chunkOverlap: settings.chunkOverlap || 120,
      topK: settings.topK || 6,
    });
  }, [settings?.baseUrl, settings?.embeddingModel, settings?.chatModel, settings?.chunkSize, settings?.chunkOverlap, settings?.topK, settings?.batchSize, settings?.embeddingDim]);

  if (state.loading && !state.data) return <Loading label="正在读取配置…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!form) return <ErrorBlock message="配置读取失败" onRetry={state.reload} />;

  const field = (key, cast = (value) => value) => (event) => setForm({ ...form, [key]: cast(event.target.value) });
  const number = (value) => Number(value) || 0;

  return (
    <div className="zx-admin-page">
      <PageHead
        title="设置"
        description="配置 OpenAI 兼容的模型接口。密钥只放在服务端环境变量，不进数据库也不下发到浏览器。"
      />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      <div className="zx-card">
        <h2 className="zx-card-title">密钥状态</h2>
        <div className="zx-card-hint" style={{ marginBottom: 10 }}>
          向量化与 AI 导师共用同一把密钥。在项目根目录的 <code>.env.local</code> 里设置
          {' '}<code>ZHIXUN_MODEL_API_KEY</code>（也兼容 <code>OPENAI_API_KEY</code>），改完重启后端生效。
        </div>
        <Notice kind={settings.keyConfigured ? 'ok' : 'error'}>
          {settings.keyConfigured ? '已检测到模型密钥。' : '还没有检测到模型密钥，现在只能做关键词检索，AI 导师也无法回答。'}
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
            })
            .then((saved) => {
              setMessage(`配置已保存（切片 ${saved.settings.chunkSize} 字 / 重叠 ${saved.settings.chunkOverlap} 字）。已入库的文档需要点「重建索引」才会用新参数。`);
              state.reload();
            })
            .catch((failure) => setError(failure.message))
            .finally(() => setBusy(''));
        }}
      >
        <h2 className="zx-card-title">模型接口</h2>
        <div className="zx-form">
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
