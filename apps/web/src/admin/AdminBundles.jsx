import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, useLoad } from './admin-ui.jsx';

const STATUS = {
  queued: { label: '排队中', kind: 'draft' },
  running: { label: '智能体整理中', kind: 'draft' },
  ready: { label: '已整理', kind: 'live' },
  failed: { label: '失败', kind: 'draft' },
};

function statusOf(status) {
  return STATUS[status] || { label: status, kind: 'draft' };
}

export default function AdminBundles({ onNeedModel }) {
  const state = useLoad(() => adminApi.kbBundles(), []);
  const [uploading, setUploading] = React.useState('');
  const [detail, setDetail] = React.useState(null);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const pollTimer = React.useRef(null);

  const bundles = state.data?.bundles || [];
  const busyCount = bundles.filter((bundle) => bundle.status === 'queued' || bundle.status === 'running').length;

  React.useEffect(() => {
    if (busyCount === 0) {
      if (pollTimer.current) { window.clearTimeout(pollTimer.current); pollTimer.current = null; }
      return undefined;
    }
    pollTimer.current = window.setTimeout(() => state.reload(), 2500);
    return () => {
      if (pollTimer.current) { window.clearTimeout(pollTimer.current); pollTimer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyCount, state.data]);

  async function upload(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('目前只支持 zip 压缩包。');
      return;
    }
    setError('');
    setMessage('');
    setUploading(file.name);
    try {
      await adminApi.uploadKbBundle(file);
      setMessage(`《${file.name}》已上传，智能体正在整理，完成后这里会显示章节。`);
      state.reload();
    } catch (failure) {
      setError(failure.message);
      if (failure.message.includes('对话模型') && onNeedModel) onNeedModel();
    } finally {
      setUploading('');
    }
  }

  async function openDetail(bundleId) {
    setError('');
    try {
      const body = await adminApi.kbBundle(bundleId);
      setDetail(detail?.bundle?.id === bundleId ? null : body);
    } catch (failure) {
      setError(failure.message);
    }
  }

  if (state.loading && !state.data) return <Loading label="正在读取资料包…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;

  return (
    <div className="zx-card" style={{ marginBottom: 16 }}>
      <h2 className="zx-card-title">
        资料包（zip）
        <label className="zx-btn zx-btn-sm zx-btn-primary" style={{ cursor: 'pointer' }}>
          {uploading ? '上传中…' : '上传压缩包'}
          <input
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            disabled={uploading !== ''}
            onChange={(event) => {
              upload(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
      </h2>
      <div className="zx-card-hint">
        把整理好的或结构混乱的 zip 丢进来，智能体在独立工作目录里自行读取、合并、重排，
        产出有序章节；原始文件与中间产物处理完即删除，只保留结果。
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      {bundles.length === 0 ? (
        <div className="zx-empty">还没有上传过压缩包。</div>
      ) : (
        <table className="zx-table">
          <thead>
            <tr>
              <th>压缩包</th>
              <th>状态</th>
              <th>章节</th>
              <th>步数</th>
              <th>更新时间</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {bundles.map((bundle) => {
              const status = statusOf(bundle.status);
              return (
                <tr key={bundle.id}>
                  <td>
                    <div className="zx-cell-title">{bundle.title || bundle.name}</div>
                    <div className="zx-cell-sub">
                      {bundle.name} · {Math.round(bundle.bytes / 1024)} KB
                      {bundle.errorMessage ? ` · ${bundle.errorMessage}` : ''}
                    </div>
                  </td>
                  <td><span className={`zx-pill zx-pill-${status.kind}`}>{status.label}</span></td>
                  <td className="zx-num">{bundle.status === 'ready' ? bundle.docCount : '—'}</td>
                  <td className="zx-num">{bundle.steps || '—'}</td>
                  <td className="zx-num">{bundle.updatedAt || '—'}</td>
                  <td className="zx-actions">
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-ghost"
                      disabled={bundle.status !== 'ready'}
                      onClick={() => openDetail(bundle.id)}
                    >
                      {detail?.bundle?.id === bundle.id ? '收起结果' : '查看结果'}
                    </button>
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-danger"
                      onClick={async () => {
                        if (!window.confirm(`删除《${bundle.name}》的整理结果？`)) return;
                        try {
                          await adminApi.deleteKbBundle(bundle.id);
                          if (detail?.bundle?.id === bundle.id) setDetail(null);
                          setMessage('已删除资料包。');
                          state.reload();
                        } catch (failure) {
                          setError(failure.message);
                        }
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {detail ? (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 800, margin: '0 0 10px' }}>
            《{detail.bundle.title || detail.bundle.name}》整理结果（{detail.docs.length} 章，共 {detail.bundle.steps} 步）
          </h3>
          {detail.docs.map((doc) => (
            <div className="zx-lesson-block" key={doc.order}>
              <div className="zx-lesson-block-head">
                <span>{doc.order}. {doc.title}</span>
                <span style={{ color: '#8b8f99', fontWeight: 700 }}>{doc.charCount} 字</span>
              </div>
              <div style={{ fontSize: 13, color: '#4b4560', whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>
                {doc.content.length > 400 ? `${doc.content.slice(0, 400)}…` : doc.content}
              </div>
            </div>
          ))}
          {detail.log ? (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: '#6f6a80' }}>
                智能体运行日志
              </summary>
              <pre style={{ marginTop: 8, padding: 12, background: '#f7f6fb', borderRadius: 10, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>
                {detail.log}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
