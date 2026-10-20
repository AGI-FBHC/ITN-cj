import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, StatCard, useLoad } from './admin-ui.jsx';

const STATUS_TEXT = {
  ready: { label: '已索引', kind: 'live' },
  indexing: { label: '索引中', kind: 'draft' },
  pending: { label: '待索引', kind: 'draft' },
  failed: { label: '索引失败', kind: 'draft' },
};

function statusOf(status) {
  return STATUS_TEXT[status] || { label: status, kind: 'draft' };
}

export default function AdminKnowledge() {
  const state = useLoad(() => adminApi.kb(), []);
  const [upload, setUpload] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [courseForm, setCourseForm] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState(null);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState('');

  const settings = state.data?.settings;
  const stats = state.data?.stats;
  const documents = state.data?.documents || [];

  async function run(key, task, okMessage) {
    setBusy(key);
    setError('');
    setMessage('');
    try {
      await task();
      if (okMessage) setMessage(okMessage);
      state.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  function pickFile(file) {
    if (!file) return;
    if (file.size > 500 * 1024) {
      setError('文件超过 500KB，请拆分成多份再上传。');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      setUpload({
        title: file.name.replace(/\.(md|markdown|txt)$/i, ''),
        sourceName: file.name,
        content: text,
      });
      setError('');
    };
    reader.onerror = () => setError('读取文件失败，请改用粘贴正文。');
    reader.readAsText(file, 'utf-8');
  }

  if (state.loading && !state.data) return <Loading label="正在读取知识库…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;

  return (
    <div className="zx-admin-page">
      <PageHead
        title="知识库"
        description="上传 Markdown 或纯文本，系统按标题切块并建立检索索引；AI 导师回答时会引用这里的片段。"
        actions={
          <>
            <button type="button" className="zx-btn zx-btn-ghost" onClick={state.reload}>刷新</button>
            <button
              type="button"
              className="zx-btn zx-btn-primary"
              onClick={() => { setUpload(upload ? null : { title: '', sourceName: '', content: '' }); setError(''); }}
            >
              {upload ? '取消上传' : '上传文档'}
            </button>
          </>
        }
      />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      <div className="zx-stats" style={{ marginBottom: 16 }}>
        <StatCard label="文档" value={stats?.documents ?? 0} hint="Markdown / 纯文本" />
        <StatCard label="切片" value={stats?.chunks ?? 0} hint="按标题与段落切分" />
        <StatCard
          label="已向量化"
          value={stats?.embedded ?? 0}
          hint={settings?.keyConfigured ? `模型 ${settings.embeddingModel || '未填写'}` : '未配置模型，当前仅关键词检索'}
        />
      </div>

      {upload ? (
        <form
          className="zx-card"
          style={{ marginBottom: 16 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!upload.title.trim() || !upload.content.trim()) {
              setError('请填写标题并粘贴或选择文档内容。');
              return;
            }
            run('upload', async () => {
              const created = await adminApi.createKbDocument({
                title: upload.title.trim(),
                sourceName: upload.sourceName.trim(),
                sourceType: upload.sourceName ? 'upload' : 'paste',
                content: upload.content,
              });
              setUpload(null);
              setMessage(
                created.note
                  ? `《${created.document.title}》已入库：${created.chunkCount} 个切片。${created.note}`
                  : `《${created.document.title}》已入库：${created.chunkCount} 个切片，${created.embeddedCount} 个已向量化。`,
              );
            }, '');
          }}
        >
          <h2 className="zx-card-title">上传文档</h2>
          <div className="zx-form">
            <div className="zx-field">
              <label htmlFor="kb-title">文档标题</label>
              <input
                id="kb-title"
                value={upload.title}
                onChange={(event) => setUpload({ ...upload, title: event.target.value })}
                placeholder="例如 数据结构精讲"
                required
              />
            </div>
            <div className="zx-field">
              <label htmlFor="kb-file">从文件读取（.md / .txt）</label>
              <input
                id="kb-file"
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                onChange={(event) => pickFile(event.target.files?.[0])}
              />
              <small>文件只在浏览器里读成文本，不会上传到别的地方。</small>
            </div>
            <div className="zx-field zx-field-full">
              <label htmlFor="kb-content">正文（也可直接粘贴）</label>
              <textarea
                id="kb-content"
                className="zx-mono"
                style={{ minHeight: 220 }}
                value={upload.content}
                onChange={(event) => setUpload({ ...upload, content: event.target.value })}
                placeholder={'# 一级标题\n\n## 二级标题\n\n正文内容…'}
              />
              <small>{upload.content.length} 字 · 标题会进入切片路径，建议保留 Markdown 层级。</small>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <button type="submit" className="zx-btn zx-btn-primary" disabled={busy === 'upload'}>
              {busy === 'upload' ? '正在切片与建索引…' : '入库并建立索引'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="zx-card" style={{ marginBottom: 16 }}>
        <h2 className="zx-card-title">检索测试</h2>
        <div className="zx-card-hint">
          {settings?.keyConfigured && settings.embeddingModel
            ? `当前走向量 + 关键词融合检索（${settings.embeddingModel}）。`
            : '还没配置向量模型，现在只能用关键词检索；配好模型并重建索引后会自动升级为融合检索。'}
        </div>
        <form
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!query.trim()) return;
            run('search', async () => {
              const result = await adminApi.kbSearch(query.trim(), settings?.topK || 6);
              setResults(result);
            }, '');
          }}
        >
          <input
            className="zx-field"
            style={{ flex: '1 1 320px', border: '1px solid rgba(80,51,130,.1)', borderRadius: 10, padding: '9px 11px', font: 'inherit' }}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如 循环队列怎么判断队满"
            aria-label="检索内容"
          />
          <button type="submit" className="zx-btn zx-btn-primary" disabled={busy === 'search'}>
            {busy === 'search' ? '检索中…' : '检索'}
          </button>
        </form>
        {results ? (
          <div style={{ marginTop: 14 }}>
            <div className="zx-card-hint" style={{ margin: '0 0 10px' }}>
              模式：{results.mode}
              {results.note ? ` · ${results.note}` : ''}
            </div>
            {results.hits.length === 0 ? (
              <Notice kind="info">没有命中任何切片。换一个更具体的说法，或者先补充知识库。</Notice>
            ) : (
              results.hits.map((hit, position) => (
                <div className="zx-lesson-block" key={hit.chunkId}>
                  <div className="zx-lesson-block-head">
                    <span>{position + 1}. {hit.documentTitle}{hit.headingPath ? ` · ${hit.headingPath}` : ''}</span>
                    <span style={{ fontWeight: 700, color: '#6038ef' }}>{hit.score.toFixed(4)}</span>
                  </div>
                  <div style={{ fontSize: 13, color: '#4b4560', whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>{hit.text}</div>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      <div className="zx-card">
        <h2 className="zx-card-title">文档</h2>
        <div className="zx-card-hint">
          上传文档 → 建索引 → 发布课程 就是完整的上架流程。发布后学习者能在课程列表里看到它，
          每个顶层章节变成一节课；重新发布会重置这门课的学习记录。
        </div>
        <table className="zx-table">
          <thead>
            <tr>
              <th>文档</th>
              <th>切片</th>
              <th>索引</th>
              <th>课程</th>
              <th>更新时间</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => {
              const status = statusOf(doc.status);
              const published = doc.courseStatus === 'published';
              return (
                <tr key={doc.id}>
                  <td>
                    <div className="zx-cell-title">{doc.title}</div>
                    <div className="zx-cell-sub">
                      {doc.sourceName || '直接粘贴'} · {doc.charCount} 字
                      {doc.errorMessage ? ` · ${doc.errorMessage}` : ''}
                    </div>
                  </td>
                  <td className="zx-num">{doc.chunkCount}</td>
                  <td><span className={`zx-pill zx-pill-${status.kind}`}>{status.label}</span></td>
                  <td>
                    {doc.courseId
                      ? <span className={`zx-pill ${published ? 'zx-pill-live' : 'zx-pill-draft'}`}>{published ? '已上架' : '已下架'}</span>
                      : <span className="zx-cell-sub">未发布</span>}
                  </td>
                  <td className="zx-num">{doc.updatedAt || '—'}</td>
                  <td className="zx-actions">
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-ghost"
                      onClick={() => run(`detail-${doc.id}`, async () => {
                        const body = await adminApi.kbDocument(doc.id);
                        setDetail(detail?.document?.id === doc.id ? null : body);
                      }, '')}
                    >
                      {detail?.document?.id === doc.id ? '收起切片' : '看切片'}
                    </button>
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-ghost"
                      disabled={busy === `reindex-${doc.id}`}
                      onClick={() => run(`reindex-${doc.id}`, async () => {
                        const result = await adminApi.reindexKbDocument(doc.id);
                        setMessage(`已重建索引：${result.chunkCount} 个切片，${result.embeddedCount} 个已向量化。${result.note || ''}`);
                      }, '')}
                    >
                      重建索引
                    </button>
                    {published ? (
                      <button
                        type="button"
                        className="zx-btn zx-btn-sm"
                        disabled={busy === `unpublish-${doc.id}`}
                        onClick={() => run(`unpublish-${doc.id}`, async () => {
                          await adminApi.unpublishKbDocument(doc.id);
                          setMessage(`《${doc.title}》已下架，学习者看不到这门课。`);
                        }, '')}
                      >
                        下架
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="zx-btn zx-btn-sm zx-btn-primary"
                        disabled={busy === `publish-${doc.id}` || doc.chunkCount === 0}
                        onClick={() => run(`publish-${doc.id}`, async () => {
                          const result = await adminApi.publishKbDocument(doc.id, {});
                          setMessage(`《${doc.title}》已发布为课程，共 ${result.lessonCount} 节课。`);
                        }, '')}
                      >
                        {doc.courseId ? '重新发布' : '发布为课程'}
                      </button>
                    )}
                    {doc.courseId ? (
                      <button
                        type="button"
                        className="zx-btn zx-btn-sm"
                        onClick={() => run(`course-${doc.id}`, async () => {
                          const body = await adminApi.course(doc.courseId);
                          setCourseForm({
                            docId: doc.id,
                            id: body.course.id,
                            name: body.course.name,
                            level: body.course.level,
                            duration: body.course.duration,
                            description: body.course.description,
                          });
                        }, '')}
                      >
                        课程设置
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="zx-btn zx-btn-sm zx-btn-danger"
                      disabled={busy === `delete-${doc.id}`}
                      onClick={() => {
                        if (!window.confirm(`删除《${doc.title}》及其全部切片？由它生成的课程也会一并下架。`)) return;
                        run(`delete-${doc.id}`, async () => {
                          const result = await adminApi.deleteKbDocument(doc.id);
                          if (detail?.document?.id === doc.id) setDetail(null);
                          setCourseForm(null);
                          setMessage(result.courseNote ? `已删除文档。${result.courseNote}。` : '已删除文档。');
                        }, '');
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
            {documents.length === 0 ? (
              <tr><td colSpan={6}><div className="zx-empty">还没有文档，先上传一份 Markdown。</div></td></tr>
            ) : null}
          </tbody>
        </table>

        {courseForm ? (
          <form
            className="zx-lesson-block"
            style={{ marginTop: 16 }}
            onSubmit={(event) => {
              event.preventDefault();
              run('save-course', async () => {
                await adminApi.updateCourse(courseForm.id, {
                  name: courseForm.name,
                  level: courseForm.level,
                  duration: Number(courseForm.duration) || 0,
                  description: courseForm.description,
                  sourceLabel: '知识库',
                });
                setCourseForm(null);
                setMessage('课程信息已更新。');
              }, '');
            }}
          >
            <div className="zx-lesson-block-head">
              <span>课程设置 · {courseForm.id}</span>
              <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" onClick={() => setCourseForm(null)}>收起</button>
            </div>
            <div className="zx-form">
              <div className="zx-field">
                <label htmlFor="kb-course-name">课程名称</label>
                <input id="kb-course-name" value={courseForm.name} onChange={(event) => setCourseForm({ ...courseForm, name: event.target.value })} required />
              </div>
              <div className="zx-field">
                <label htmlFor="kb-course-level">难度</label>
                <input id="kb-course-level" value={courseForm.level} onChange={(event) => setCourseForm({ ...courseForm, level: event.target.value })} />
              </div>
              <div className="zx-field">
                <label htmlFor="kb-course-duration">建议时长（分钟）</label>
                <input id="kb-course-duration" type="number" min="0" value={courseForm.duration} onChange={(event) => setCourseForm({ ...courseForm, duration: event.target.value })} />
              </div>
              <div className="zx-field zx-field-full">
                <label htmlFor="kb-course-description">课程简介</label>
                <textarea id="kb-course-description" value={courseForm.description} onChange={(event) => setCourseForm({ ...courseForm, description: event.target.value })} />
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <button type="submit" className="zx-btn zx-btn-primary" disabled={busy === 'save-course'}>
                {busy === 'save-course' ? '保存中…' : '保存课程信息'}
              </button>
            </div>
          </form>
        ) : null}

        {detail ? (
          <div style={{ marginTop: 18 }}>
            <h3 style={{ fontSize: 14, fontWeight: 800, margin: '0 0 10px' }}>
              《{detail.document.title}》的切片（{detail.chunks.length}）
            </h3>
            {detail.chunks.map((chunk) => (
              <div className="zx-lesson-block" key={`${chunk.index}`}>
                <div className="zx-lesson-block-head">
                  <span>#{chunk.index + 1} {chunk.headingPath}</span>
                  <span style={{ color: chunk.hasVector ? '#0f7b52' : '#8a5a13', fontWeight: 700 }}>
                    {chunk.charCount} 字 · {chunk.hasVector ? '已向量化' : '仅关键词'}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: '#4b4560', whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>{chunk.text}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
