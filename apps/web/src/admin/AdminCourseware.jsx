import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';
import { bundleReadable, BundleLogo } from './BundlePipeline.jsx';
import Markdown from './Markdown.jsx';
import { useNavigate } from 'react-router-dom';
import './courseware-queue.css';

const RESOURCES = [
  { key: 'lecture', label: '讲义文稿', badge: '讲', desc: '把章节原文整理成可阅读的讲解稿', meta: '约 2000–3000 字' },
  { key: 'guide', label: '实操指南', badge: '操', desc: '可跟着做的步骤、命令与检查点', meta: '8–15 步' },
  { key: 'bank', label: '题库', badge: '题', desc: '随堂练习与章节测验，统一进题库', meta: '8 题' },
  { key: 'slides', label: '教学幻灯片', badge: '播', desc: '按小节拆页，可在学习端播放', meta: '10 页' },
];

const TYPE_LABEL = Object.fromEntries(RESOURCES.map((item) => [item.key, item.label]));

const STATUS = {
  queued: { label: '排队中', kind: 'draft' },
  generating: { label: '生成中', kind: 'draft' },
  ready: { label: '待发布', kind: 'draft' },
  published: { label: '已发布', kind: 'live' },
  failed: { label: '失败', kind: 'draft' },
};

const KIND_ORDER = Object.fromEntries(RESOURCES.map((item, index) => [item.key, index]));

function rankOf(item) {
  if (item.status === 'ready') return 3;
  if (item.status === 'generating' || item.status === 'queued') return 2;
  return 1;
}

/** 每个类型只取一份代表：能用的优先，同条件下取最新。 */
function resourceByKind(list) {
  const map = {};
  for (const item of list) {
    const current = map[item.kind];
    if (!current) { map[item.kind] = item; continue; }
    const delta = rankOf(item) - rankOf(current);
    if (delta > 0 || (delta === 0 && String(item.updatedAt) > String(current.updatedAt))) map[item.kind] = item;
  }
  return map;
}

function resourceState(item) {
  if (!item) return '未生成';
  if (item.status === 'queued') return '排队中';
  if (item.status === 'generating') return '生成中';
  if (item.status === 'failed') return '生成失败';
  return item.published ? '已发布' : '待发布';
}

function CoursewareQueueIndicator({ queue, open, onToggle }) {
  const running = Number(queue?.running || 0);
  const queued = Number(queue?.queued || 0);
  const limit = Number(queue?.maxParallel || 10);
  const active = running + queued;
  const items = queue?.items || [];
  return <div className="zx-cw-queue">
    <button type="button" className={`zx-cw-queue-trigger${active ? ' is-active' : ''}`} onClick={onToggle} aria-expanded={open} aria-label={`课件生成队列，${running} 个生成中，${queued} 个排队中`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="3" cy="6" r=".8" fill="currentColor"/><circle cx="3" cy="12" r=".8" fill="currentColor"/><circle cx="3" cy="18" r=".8" fill="currentColor"/></svg>
      {active ? <span>{active > 99 ? '99+' : active}</span> : null}
    </button>
    {open ? <section className="zx-cw-queue-popover" aria-label="课件生成任务进度">
      <header><div><strong>生成任务</strong><p>{running} 个进行中 · {queued} 个排队中</p></div><span>{running}/{limit}</span></header>
      <div className="zx-cw-queue-meter"><i style={{ width: `${limit ? Math.min(100, running / limit * 100) : 0}%` }} /></div>
      {items.length ? <div className="zx-cw-queue-list">{items.slice(0, 8).map((item) => <div key={item.id}>
        <span className={`zx-cw-queue-dot is-${item.status}`} />
        <div><strong>{item.docTitle || item.title || '未命名章节'}</strong><small>{item.bundleTitle || '知识库'} · {item.status === 'queued' ? '等待开始' : '正在生成'}</small></div>
      </div>)}</div> : <p className="zx-cw-queue-empty">当前没有生成任务</p>}
    </section> : null}
  </div>;
}

/* ---------- 页面 ---------- */

export default function AdminCourseware() {
  const navigate = useNavigate();
  const bundlesState = useLoad(() => adminApi.kbBundles(), []);
  const listState = useLoad(() => adminApi.cwList(), []);
  const queueState = useLoad(() => adminApi.cwQueue(), []);
  const [bundleId, setBundleId] = React.useState('');
  const [activeDocId, setActiveDocId] = React.useState('');
  const [doc, setDoc] = React.useState(null);
  const [docLoading, setDocLoading] = React.useState(false);
  const [docError, setDocError] = React.useState('');
  const [view, setView] = React.useState('chapters');
  const [showPicker, setShowPicker] = React.useState(false);
  const [picked, setPicked] = React.useState([]);
  const [publishDocId, setPublishDocId] = React.useState('');
  const [order, setOrder] = React.useState(1);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [queueOpen, setQueueOpen] = React.useState(false);
  const pollTimer = React.useRef(null);

  const bundles = (bundlesState.data?.bundles || []).filter((item) => bundleReadable(item));
  const selectedBundle = bundles.find((item) => item.id === bundleId) || null;
  const courseLive = selectedBundle?.courseStatus === 'published';
  const chaptersState = useLoad(
    () => (bundleId
      ? adminApi.kbBundle(bundleId).then((data) => ({ ...data, forBundle: bundleId }))
      : Promise.resolve({ docs: [], forBundle: '' })),
    [bundleId],
  );
  const liveState = useLoad(
    () => (bundleId
      ? adminApi.cwChapters(bundleId).then((data) => ({ ...data, forBundle: bundleId }))
      : Promise.resolve({ published: [], nextFree: 1, publishedCount: 0, forBundle: '' })),
    [bundleId],
  );
  // 只认当前资料包返回的章节，避免切换瞬间拿上一个包的章节去请求正文（会 404）
  const chaptersReady = chaptersState.data?.forBundle === bundleId;
  const chapters = chaptersReady ? (chaptersState.data?.docs || []) : [];
  const liveReady = liveState.data?.forBundle === bundleId;
  const liveChapters = liveReady ? (liveState.data?.published || []) : [];
  const nextFree = liveReady ? (liveState.data?.nextFree || 1) : 1;
  const liveByDoc = React.useMemo(
    () => new Map(liveChapters.map((item) => [item.docId, item])),
    [liveChapters],
  );
  const activeChapter = chapters.find((item) => item.id === activeDocId) || null;
  const activeLive = activeDocId ? liveByDoc.get(activeDocId) : null;
  const items = listState.data?.items || [];
  const generating = items.some((item) => item.status === 'generating' || item.status === 'queued')
    || Number(queueState.data?.running || 0) + Number(queueState.data?.queued || 0) > 0;

  // 有生成中的任务就轮询
  React.useEffect(() => {
    if (!generating) {
      if (pollTimer.current) { window.clearTimeout(pollTimer.current); pollTimer.current = null; }
      return undefined;
    }
    pollTimer.current = window.setTimeout(() => {
      listState.reload();
      queueState.reload();
    }, 3000);
    return () => {
      if (pollTimer.current) { window.clearTimeout(pollTimer.current); pollTimer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generating, listState.data, queueState.data]);

  React.useEffect(() => {
    if (!bundleId && bundles.length > 0 && !bundlesState.loading) setBundleId(bundles[0].id);
  }, [bundles, bundleId, bundlesState.loading]);

  React.useEffect(() => {
    setActiveDocId('');
    setDoc(null);
    setPublishDocId('');
  }, [bundleId]);

  // 章节默认落在第一项，省掉一次点击；切换资料包后同样自动选新包的第一章。
  React.useEffect(() => {
    if (chapters.length === 0) {
      if (activeDocId !== '') setActiveDocId('');
      return;
    }
    if (!chapters.some((item) => item.id === activeDocId)) setActiveDocId(chapters[0].id);
  }, [chapters, activeDocId]);

  React.useEffect(() => {
    if (!bundleId || !activeDocId) return undefined;
    let alive = true;
    setDocLoading(true);
    setDocError('');
    adminApi
      .kbBundleDocument(bundleId, activeDocId)
      .then((result) => { if (alive) setDoc(result.doc || null); })
      .catch((failure) => { if (alive) setDocError(failure.message); })
      .finally(() => { if (alive) setDocLoading(false); });
    return () => { alive = false; };
  }, [bundleId, activeDocId]);

  function togglePick(key) {
    setPicked((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  function reloadAll() {
    bundlesState.reload();
    listState.reload();
    liveState.reload();
    queueState.reload();
  }

  async function generate() {
    if (picked.length === 0 || !doc) return;
    setShowPicker(false);
    setError('');
    try {
      await adminApi.cwGenerate({ bundleId, docId: doc.id, kinds: picked });
      setMessage(`已提交 ${picked.length} 份课件的生成任务。`);
      setPicked([]);
      listState.reload();
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function act(task) {
    setError('');
    try {
      await task();
      listState.reload();
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function runGuarded(task) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await task();
      reloadAll();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  function publishCourse() {
    runGuarded(async () => {
      const result = await adminApi.publishKbBundle(bundleId);
      setMessage(result.lessonCount > 0
        ? `课程已上架，学员端可以学习 ${result.lessonCount} 个课时。`
        : '课程已上架，还没有上架课件，学员端暂时看不到内容。');
    });
  }

  function takeDownCourse() {
    if (!window.confirm('下架这门课程？已上架的课件会保留，再次上架后仍然可用。')) return;
    runGuarded(async () => {
      await adminApi.unpublishKbBundle(bundleId);
      setMessage('课程已下架，课件与章节都保留在库里。');
    });
  }

  function openPublish(docId) {
    const live = liveByDoc.get(docId);
    setPublishDocId(docId);
    setOrder(live ? live.orderNo : nextFree);
    setError('');
    setMessage('');
  }

  async function toggleResource(item) {
    await act(() => (item.published ? adminApi.cwUnpublish(item.id) : adminApi.cwPublish(item.id)));
  }

  async function confirmPublish() {
    if (!publishDocId) return;
    await runGuarded(async () => {
      await adminApi.cwPublishChapter(publishDocId, bundleId, order);
      setPublishDocId('');
      setMessage(`课件已上架，学员端第 ${order} 个章节更新完成。`);
    });
  }

  async function unpublishChapter(docId) {
    await runGuarded(async () => {
      await adminApi.cwUnpublishChapter(docId, bundleId);
      setPublishDocId('');
      setMessage('这个章节已下架，课件仍然保留。');
    });
  }

  if (bundlesState.loading && !bundlesState.data) return <Loading label="正在读取知识库…" />;
  if (bundlesState.error) return <ErrorBlock message={bundlesState.error} onRetry={bundlesState.reload} />;

  const publishDoc = chapters.find((item) => item.id === publishDocId) || null;
  const publishDocLive = publishDocId ? liveByDoc.get(publishDocId) : null;
  const publishResources = resourceByKind(items.filter((item) => item.docId === publishDocId));
  const publishedCount = RESOURCES.filter((resource) => publishResources[resource.key]?.published).length;
  const orderTaken = liveChapters.find((item) => item.orderNo === order && item.docId !== publishDocId);
  const orderSlots = Math.max(12, liveChapters.length + 6);

  return (
    <div className="zx-admin-page">
      <PageHead
        title="课件管理"
        actions={
          <>
            <CoursewareQueueIndicator queue={queueState.data} open={queueOpen} onToggle={() => setQueueOpen((value) => !value)} />
            <div className="zx-tabs" style={{ margin: 0 }}>
              <button type="button" className={`zx-tab ${view === 'chapters' ? 'active' : ''}`} onClick={() => setView('chapters')}>章节</button>
              <button type="button" className={`zx-tab ${view === 'library' ? 'active' : ''}`} onClick={() => setView('library')}>
                课件库{items.length > 0 ? ` · ${items.length}` : ''}
              </button>
            </div>
            <button type="button" className="zx-btn zx-btn-ghost" onClick={reloadAll}>刷新</button>
          </>
        }
      />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      {view === 'chapters' ? (
        <div className="zx-cw">
          <aside className="zx-cw-col">
            <div className="zx-cw-col-title">知识库</div>
            {bundles.length === 0 ? (
              <div className="zx-empty">还没有可用的知识库</div>
            ) : (
              bundles.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`zx-cw-item ${item.id === bundleId ? 'active' : ''}`}
                  onClick={() => setBundleId(item.id)}
                >
                  <BundleLogo bundle={item} size={28} />
                  <span className="zx-cw-item-text">
                    <strong>{item.title || item.name}</strong>
                    <small className="zx-cw-item-sub">
                      {item.docCount || 0} 章
                      {item.courseStatus === 'published' ? <span className="zx-cw-live-badge">已上架</span> : null}
                    </small>
                  </span>
                </button>
              ))
            )}
          </aside>

          <aside className="zx-cw-col">
            <div className="zx-cw-col-title">章节</div>
            {selectedBundle ? (
              <div className={`zx-cw-bar ${courseLive ? 'live' : ''}`}>
                <div className="zx-cw-bar-text">
                  <strong>{courseLive ? '课程已上架' : '课程未上架'}</strong>
                  <small>{courseLive
                    ? `已上架 ${liveChapters.length} 个章节`
                    : '上架后学员端才可见'}</small>
                </div>
                {courseLive ? (
                  <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={busy} onClick={takeDownCourse}>下架</button>
                ) : (
                  <button type="button" className="zx-btn zx-btn-sm zx-btn-primary" disabled={busy} onClick={publishCourse}>上架课程</button>
                )}
              </div>
            ) : null}
            {chaptersState.loading || !chaptersReady ? <div className="zx-cw-hint">正在读取章节…</div> : null}
            {chapters.map((item) => {
              const live = liveByDoc.get(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`zx-cw-item ${item.id === activeDocId ? 'active' : ''}`}
                  onClick={() => setActiveDocId(item.id)}
                >
                  <span className={`zx-cw-index ${live ? 'live' : ''}`}>{live ? `#${live.orderNo}` : item.order}</span>
                  <span className="zx-cw-item-text">
                    <strong>{item.title}</strong>
                    <small>{live ? '已上架 · ' : ''}{item.charCount} 字</small>
                  </span>
                </button>
              );
            })}
            {chaptersReady && chapters.length === 0 ? <div className="zx-cw-hint">这个知识库还没有章节。</div> : null}
          </aside>

          <section className="zx-cw-main">
            {!activeChapter ? (
              <div className="zx-cw-placeholder">选择一个章节</div>
            ) : (
              <>
                <header className="zx-cw-main-head">
                  <div>
                    <strong>{activeChapter.title}</strong>
                    <span>{activeChapter.charCount} 字{activeChapter.sourcePath ? ` · ${activeChapter.sourcePath}` : ''}</span>
                  </div>
                  <div className="zx-cw-main-actions">
                    <button type="button" className="zx-btn zx-btn-ghost" disabled={!doc || docLoading} onClick={() => { setPicked([]); setShowPicker(true); }}>
                      生成课件
                    </button>
                    <button
                      type="button"
                      className={`zx-btn ${activeLive ? 'zx-btn-ghost' : 'zx-btn-primary'}`}
                      disabled={!courseLive || busy}
                      title={courseLive ? '' : '先上架课程'}
                      onClick={() => openPublish(activeChapter.id)}
                    >
                      {activeLive ? `已上架 #${activeLive.orderNo}` : '上架课件'}
                    </button>
                  </div>
                </header>

                <div className="zx-cw-scroll">
                  {docLoading ? <Loading label="正在读取原文…" /> : null}
                  {docError ? <ErrorBlock message={docError} /> : null}
                  {doc && !docLoading ? (
                    <article className="zx-cw-article">
                      <Markdown text={doc.content} />
                    </article>
                  ) : null}
                </div>
              </>
            )}
          </section>
        </div>
      ) : (
        <div className="zx-card">
          {items.length === 0 ? (
            <div className="zx-empty">还没有课件</div>
          ) : (
            <table className="zx-table">
              <thead>
                <tr>
                  <th>课件</th>
                  <th>类型</th>
                  <th>来源章节</th>
                  <th>状态</th>
                  <th>章节上架</th>
                  <th>更新时间</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const status = item.published ? STATUS.published : (STATUS[item.status] || STATUS.ready);
                  const liveOrder = item.chapterOrder || 0;
                  return (
                    <tr key={item.id}>
                      <td><div className="zx-cell-title">{item.title || item.kindLabel}</div></td>
                      <td className="zx-nowrap">{item.kindLabel}</td>
                      <td className="zx-cell-sub">{item.bundleTitle} · {item.docTitle}</td>
                      <td>
                        <span className={`zx-pill ${status.kind === 'live' ? 'zx-pill-live' : 'zx-pill-draft'}`}>{status.label}</span>
                        {item.status === 'failed' && item.errorMessage ? <div className="zx-cell-sub">{item.errorMessage}</div> : null}
                      </td>
                      <td>{liveOrder && item.published ? <span className="zx-cw-live-badge">#{liveOrder}</span> : <span className="zx-cell-sub">—</span>}</td>
                      <td className="zx-num">{item.updatedAt}</td>
                      <td className="zx-actions">
                        <button
                          type="button"
                          className="zx-btn zx-btn-sm zx-btn-ghost zx-cw-detail-icon"
                          title="查看多智能体协作过程"
                          aria-label={`查看 ${item.title || item.kindLabel} 的多智能体协作过程`}
                          onClick={() => navigate(`/admin/courseware/${item.id}/collaboration`)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8v.01"/></svg>
                        </button>
                        <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={item.status !== 'ready'} onClick={() => navigate(`/admin/courseware/${item.id}`)}>预览</button>
                        {item.published ? (
                          <button type="button" className="zx-btn zx-btn-sm" onClick={() => act(() => adminApi.cwUnpublish(item.id))}>取消发布</button>
                        ) : (
                          <button type="button" className="zx-btn zx-btn-sm" disabled={item.status !== 'ready'} onClick={() => act(() => adminApi.cwPublish(item.id))}>发布</button>
                        )}
                        <button type="button" className="zx-btn zx-btn-sm zx-btn-danger" onClick={() => { if (window.confirm('删除这份课件？')) act(() => adminApi.cwDelete(item.id)); }}>删除</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showPicker ? (
        <div
          className="zx-cw-modal"
          role="dialog"
          aria-modal="true"
          onClick={(event) => { if (event.target === event.currentTarget) setShowPicker(false); }}
        >
          <div className="zx-cw-modal-body zx-cw-modal-gen">
            <header className="zx-cw-modal-head">
              <div className="zx-cw-modal-titles">
                <strong>生成课件</strong>
                <span>{doc ? `${doc.title} · ${doc.charCount.toLocaleString('zh-CN')} 字` : ''}</span>
              </div>
              <button type="button" className="zx-cw-modal-close" aria-label="关闭" onClick={() => setShowPicker(false)}>×</button>
            </header>
            <div className="zx-cw-modal-content">
              <div className="zx-cw-picker">
                {RESOURCES.map((item) => {
                  const active = picked.includes(item.key);
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`zx-cw-resource ${active ? 'picked' : ''}`}
                      onClick={() => togglePick(item.key)}
                      aria-pressed={active}
                    >
                      <span className="zx-cw-resource-badge">{item.badge}</span>
                      <span className="zx-cw-resource-main">
                        <strong>{item.label}</strong>
                        <span>{item.desc}</span>
                        <small>{item.meta}</small>
                      </span>
                      <span className="zx-cw-resource-check" aria-hidden="true">{active ? '✓' : ''}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <footer className="zx-cw-modal-foot">
              <span className="zx-cw-modal-meta">{picked.length === 0 ? '可多选' : `已选 ${picked.length} 项`}</span>
              <span className="zx-cw-modal-actions">
                <button type="button" className="zx-btn zx-btn-ghost" onClick={() => setShowPicker(false)}>取消</button>
                <button type="button" className="zx-btn zx-btn-primary" disabled={picked.length === 0} onClick={generate}>生成所选</button>
              </span>
            </footer>
          </div>
        </div>
      ) : null}

      {publishDocId ? (
        <div
          className="zx-cw-modal"
          role="dialog"
          aria-modal="true"
          onClick={(event) => { if (event.target === event.currentTarget) setPublishDocId(''); }}
        >
          <div className="zx-cw-modal-body zx-cw-modal-gen">
            <header className="zx-cw-modal-head">
              <div className="zx-cw-modal-titles">
                <strong>上架课件</strong>
                <span>{publishDoc ? publishDoc.title : ''}</span>
              </div>
              <button type="button" className="zx-cw-modal-close" aria-label="关闭" onClick={() => setPublishDocId('')}>×</button>
            </header>
            <div className="zx-cw-modal-content">
              <div className="zx-cw-pub-section">
                <div className="zx-cw-pub-label">这一章的课件</div>
                <div className="zx-cw-pub-list">
                  {RESOURCES.map((resource) => {
                    const item = publishResources[resource.key];
                    return (
                      <div key={resource.key} className={`zx-cw-pub-row ${item?.published ? 'live' : ''}`}>
                        <span className="zx-cw-resource-badge">{resource.badge}</span>
                        <span className="zx-cw-pub-main">
                          <strong>{resource.label}</strong>
                          <small>{resourceState(item)}</small>
                        </span>
                        {item && item.status === 'ready' ? (
                          item.published ? (
                            <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" onClick={() => toggleResource(item)}>撤回</button>
                          ) : (
                            <button type="button" className="zx-btn zx-btn-sm" onClick={() => toggleResource(item)}>发布</button>
                          )
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="zx-cw-pub-section">
                <div className="zx-cw-pub-label">
                  学员端章节序号
                  <span>{liveChapters.length > 0 ? `已占用 ${liveChapters.length} 个` : '还没有章节占用序号'}</span>
                </div>
                <div className="zx-cw-orders">
                  {Array.from({ length: orderSlots }, (_, index) => index + 1).map((slot) => {
                    const takenBy = liveChapters.find((item) => item.orderNo === slot && item.docId !== publishDocId);
                    const mine = publishDocLive && publishDocLive.orderNo === slot;
                    return (
                      <button
                        key={slot}
                        type="button"
                        className={`zx-cw-order ${order === slot ? 'selected' : ''} ${takenBy ? 'taken' : ''} ${mine && !takenBy ? 'mine' : ''}`}
                        disabled={Boolean(takenBy)}
                        title={takenBy ? `已被「${takenBy.docTitle}」占用` : `选第 ${slot} 章`}
                        onClick={() => setOrder(slot)}
                      >
                        <strong>{slot}</strong>
                        {takenBy ? <small>已占用</small> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <footer className="zx-cw-modal-foot">
              <span className="zx-cw-modal-meta">
                {publishedCount === 0
                  ? '至少发布一份课件才能上架这一章'
                  : `已发布 ${publishedCount} 份课件 · 序号 #${order}${orderTaken ? '（已被占用）' : ''}`}
              </span>
              <span className="zx-cw-modal-actions">
                {publishDocLive ? (
                  <button type="button" className="zx-btn zx-btn-sm zx-btn-danger" disabled={busy} onClick={() => unpublishChapter(publishDocId)}>下架这一章</button>
                ) : null}
                <button type="button" className="zx-btn zx-btn-ghost" onClick={() => setPublishDocId('')}>取消</button>
                <button
                  type="button"
                  className="zx-btn zx-btn-primary"
                  disabled={busy || publishedCount === 0 || Boolean(orderTaken)}
                  onClick={confirmPublish}
                >
                  {publishDocLive ? '更新上架' : '上架这一章'}
                </button>
              </span>
            </footer>
          </div>
        </div>
      ) : null}

    </div>
  );
}
