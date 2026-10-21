import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, useLoad } from './admin-ui.jsx';
import BundlePipeline, { BundleLogo, bundleBusy, bundleReadable, useProcessingPoll } from './BundlePipeline.jsx';

export default function AdminBundles({ onNeedModel }) {
  const navigate = useNavigate();
  const state = useLoad(() => adminApi.kbBundles(), []);
  const [uploading, setUploading] = React.useState('');
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [editingId, setEditingId] = React.useState('');
  const [titleDraft, setTitleDraft] = React.useState('');
  const [savingTitleId, setSavingTitleId] = React.useState('');
  const bundles = state.data?.bundles || [];
  useProcessingPoll(state, bundles.some(bundleBusy));

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
      setMessage(`《${file.name}》已上传，将自动整理原文、生成切片与摘要，原文就绪后即可预览。`);
      state.reload();
    } catch (failure) {
      setError(failure.message);
      if (failure.message.includes('对话模型') && onNeedModel) onNeedModel();
    } finally {
      setUploading('');
    }
  }

  function beginRename(bundle) {
    setError('');
    setMessage('');
    setEditingId(bundle.id);
    setTitleDraft(bundle.title || bundle.name || '');
  }

  async function saveTitle(event, bundle) {
    event.preventDefault();
    const title = titleDraft.trim();
    if (!title) {
      setError('课件名称不能为空。');
      return;
    }
    if (Array.from(title).length > 160) {
      setError('课件名称不能超过 160 个字符。');
      return;
    }
    setSavingTitleId(bundle.id);
    setError('');
    setMessage('');
    try {
      await adminApi.renameKbBundle(bundle.id, title);
      setEditingId('');
      setTitleDraft('');
      setMessage(`课件名称已更新为“${title}”，学员端课程名称已同步。`);
      state.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSavingTitleId('');
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
        上传包含文档和图片的 zip（最大 256MB），保留原文和图片，自动生成切片、摘要、关键词与课程图标。课件在「课件管理」里生成与上架。
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
              <th>处理进度</th>
              <th>章节</th>
              <th>更新时间</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {bundles.map((bundle) => {
              return (
                <tr key={bundle.id}>
                  <td>
                    <div className="zx-bundle-name">
                      <BundleLogo bundle={bundle} />
                      <div className="zx-bundle-title-area">
                        {editingId === bundle.id ? (
                          <form className="zx-bundle-title-form" onSubmit={(event) => saveTitle(event, bundle)}>
                            <input
                              autoFocus
                              maxLength={160}
                              value={titleDraft}
                              onChange={(event) => setTitleDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  event.preventDefault();
                                  setEditingId('');
                                  setTitleDraft('');
                                }
                              }}
                              aria-label="课件名称"
                              disabled={savingTitleId === bundle.id}
                            />
                            <button type="submit" className="zx-btn zx-btn-sm zx-btn-primary" disabled={savingTitleId === bundle.id}>
                              {savingTitleId === bundle.id ? '保存中…' : '保存'}
                            </button>
                            <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={savingTitleId === bundle.id} onClick={() => { setEditingId(''); setTitleDraft(''); }}>
                              取消
                            </button>
                          </form>
                        ) : (
                          <button type="button" className="zx-bundle-title-edit" onClick={() => beginRename(bundle)} title="修改课件名称">
                            <span className="zx-cell-title">{bundle.title || bundle.name}</span>
                            <span>修改名称</span>
                          </button>
                        )}
                        <div className="zx-cell-sub">
                          {bundle.name} · {Math.round(bundle.bytes / 1024)} KB
                          {bundle.errorMessage ? ` · ${bundle.errorMessage}` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td><BundlePipeline bundle={bundle} compact /></td>
                  <td className="zx-num">{bundle.docCount || '—'}</td>
                  <td className="zx-num">{bundle.updatedAt || '—'}</td>
                  <td className="zx-actions">
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-ghost"
                      disabled={!bundleReadable(bundle)}
                      onClick={() => navigate(`/admin/knowledge/bundles/${bundle.id}`)}
                    >
                      预览
                    </button>
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-danger"
                      onClick={async () => {
                        if (!window.confirm(`删除《${bundle.name}》？对应课程、课件和学习记录将一并删除，无法恢复。`)) return;
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
