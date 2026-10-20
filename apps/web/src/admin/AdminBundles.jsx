import * as React from 'react';
import { useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();
  const state = useLoad(() => adminApi.kbBundles(), []);
  const [uploading, setUploading] = React.useState('');
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
                      onClick={() => navigate(`/admin/knowledge/bundles/${bundle.id}`)}
                    >
                      预览
                    </button>
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-danger"
                      onClick={async () => {
                        if (!window.confirm(`删除《${bundle.name}》的整理结果？`)) return;
                        try {
                          await adminApi.deleteKbBundle(bundle.id);
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

    </div>
  );
}
