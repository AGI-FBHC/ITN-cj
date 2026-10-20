import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';
import { bundleReadable, BundleLogo } from './BundlePipeline.jsx';
import Markdown from './Markdown.jsx';

const STORE_KEY = 'zhixun-courseware-mock';

// 四类课件资源。当前只做前端演示：生成与发布都不会调用后端。
const RESOURCES = [
  { key: 'lecture', label: '讲义文稿', desc: '把章节原文整理成可阅读的讲解稿', meta: '约 2000–3000 字' },
  { key: 'practice', label: '练习题', desc: '随堂练习，附答案与解析', meta: '6–10 题' },
  { key: 'quiz', label: '测验题', desc: '章节测验，提交后自动判分', meta: '5 题 · 单选' },
  { key: 'slides', label: '教学幻灯片', desc: '按小节拆页，可在学习端播放', meta: '10–16 页' },
];

const TYPE_LABEL = Object.fromEntries(RESOURCES.map((item) => [item.key, item.label]));

const STATUS = {
  generating: { label: '生成中', kind: 'draft' },
  draft: { label: '草稿', kind: 'draft' },
  published: { label: '已发布', kind: 'live' },
};

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveStore(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 200)));
  } catch {
    /* 演示数据，存不下就算了 */
  }
}

export default function AdminCourseware() {
  const bundlesState = useLoad(() => adminApi.kbBundles(), []);
  const [bundleId, setBundleId] = React.useState('');
  const [activeDocId, setActiveDocId] = React.useState('');
  const [doc, setDoc] = React.useState(null);
  const [docLoading, setDocLoading] = React.useState(false);
  const [docError, setDocError] = React.useState('');
  const [view, setView] = React.useState('chapters');
  const [showPicker, setShowPicker] = React.useState(false);
  const [picked, setPicked] = React.useState([]);
  const [items, setItems] = React.useState(loadStore);
  const [message, setMessage] = React.useState('');
  const [previewing, setPreviewing] = React.useState(null);

  const bundles = (bundlesState.data?.bundles || []).filter((item) => bundleReadable(item));
  const selectedBundle = bundles.find((item) => item.id === bundleId) || null;
  const chaptersState = useLoad(
    () => (bundleId ? adminApi.kbBundle(bundleId) : Promise.resolve({ docs: [] })),
    [bundleId],
  );
  const chapters = chaptersState.data?.docs || [];
  const activeChapter = chapters.find((item) => item.id === activeDocId) || null;

  React.useEffect(() => { saveStore(items); }, [items]);

  // 默认选中第一个知识库
  React.useEffect(() => {
    if (!bundleId && bundles.length > 0 && !bundlesState.loading) setBundleId(bundles[0].id);
  }, [bundles, bundleId, bundlesState.loading]);

  // 换资料包时清掉章节选择
  React.useEffect(() => {
    setActiveDocId('');
    setDoc(null);
    setShowPicker(false);
    setPicked([]);
  }, [bundleId]);

  // 选章节后按需拉正文
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

  function generate() {
    if (picked.length === 0 || !doc) return;
    const stamp = Date.now();
    const created = picked.map((key, index) => ({
      id: `${stamp}-${key}`,
      type: key,
      title: `${doc.title} · ${TYPE_LABEL[key]}`,
      bundleId,
      bundleTitle: selectedBundle?.title || selectedBundle?.name || '',
      docId: doc.id,
      docTitle: doc.title,
      status: 'generating',
      updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    }));
    setItems((current) => [...created, ...current]);
    setShowPicker(false);
    setPicked([]);
    setMessage(`已提交 ${created.length} 份课件的生成任务（演示，不会调用后端）。`);
    created.forEach((item, index) => {
      window.setTimeout(() => {
        setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, status: 'draft' } : entry)));
      }, 900 + index * 400);
    });
  }

  function setStatus(id, status) {
    setItems((current) => current.map((entry) => (entry.id === id ? { ...entry, status } : entry)));
  }

  function remove(id) {
    if (!window.confirm('删除这份课件？（演示数据）')) return;
    setItems((current) => current.filter((entry) => entry.id !== id));
  }

  if (bundlesState.loading && !bundlesState.data) return <Loading label="正在读取知识库…" />;
  if (bundlesState.error) return <ErrorBlock message={bundlesState.error} onRetry={bundlesState.reload} />;

  return (
    <div className="zx-admin-page">
      <PageHead
        title="课件管理"
        description="选知识库 → 选章节 → 看原文 → 生成课件。当前为前端演示，生成与发布不调用后端。"
        actions={
          <>
            <div className="zx-tabs" style={{ margin: 0 }}>
              <button type="button" className={`zx-tab ${view === 'chapters' ? 'active' : ''}`} onClick={() => setView('chapters')}>章节</button>
              <button type="button" className={`zx-tab ${view === 'library' ? 'active' : ''}`} onClick={() => setView('library')}>
                课件库{items.length > 0 ? ` · ${items.length}` : ''}
              </button>
            </div>
            <button type="button" className="zx-btn zx-btn-ghost" onClick={bundlesState.reload}>刷新</button>
          </>
        }
      />

      {message ? <Notice kind="ok">{message}</Notice> : null}

      {view === 'chapters' ? (
        <div className="zx-cw">
          <aside className="zx-cw-col">
            <div className="zx-cw-col-title">知识库</div>
            {bundles.length === 0 ? (
              <div className="zx-empty">还没有可用的知识库，先在「知识库」上传压缩包。</div>
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
                    <small>{item.docCount || 0} 章</small>
                  </span>
                </button>
              ))
            )}
          </aside>

          <aside className="zx-cw-col">
            <div className="zx-cw-col-title">章节</div>
            {chaptersState.loading ? <div className="zx-cw-hint">正在读取章节…</div> : null}
            {chapters.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`zx-cw-item ${item.id === activeDocId ? 'active' : ''}`}
                onClick={() => setActiveDocId(item.id)}
              >
                <span className="zx-cw-index">{item.order}</span>
                <span className="zx-cw-item-text">
                  <strong>{item.title}</strong>
                  <small>{item.charCount} 字</small>
                </span>
              </button>
            ))}
            {!chaptersState.loading && chapters.length === 0 ? <div className="zx-cw-hint">这个知识库还没有章节。</div> : null}
          </aside>

          <section className="zx-cw-main">
            {!activeChapter ? (
              <div className="zx-cw-placeholder">从左侧选一个章节，这里显示原文。</div>
            ) : (
              <>
                <header className="zx-cw-main-head">
                  <div>
                    <strong>{activeChapter.title}</strong>
                    <span>{activeChapter.charCount} 字{activeChapter.sourcePath ? ` · ${activeChapter.sourcePath}` : ''}</span>
                  </div>
                  <button type="button" className="zx-btn zx-btn-primary" disabled={!doc || docLoading} onClick={() => { setShowPicker(!showPicker); setPicked([]); }}>
                    {showPicker ? '取消生成' : '生成课件'}
                  </button>
                </header>

                {showPicker ? (
                  <div className="zx-card" style={{ marginBottom: 16 }}>
                    <h2 className="zx-card-title">选择要生成的资源</h2>
                    <div className="zx-card-hint">可多选；当前只是前端演示，不会真的调用模型。</div>
                    <div className="zx-cw-picker">
                      {RESOURCES.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          className={`zx-cw-resource ${picked.includes(item.key) ? 'picked' : ''}`}
                          onClick={() => togglePick(item.key)}
                        >
                          <strong>{item.label}</strong>
                          <span>{item.desc}</span>
                          <small>{item.meta}</small>
                        </button>
                      ))}
                    </div>
                    <div style={{ marginTop: 14 }}>
                      <button type="button" className="zx-btn zx-btn-primary" disabled={picked.length === 0} onClick={generate}>
                        生成所选（{picked.length}）
                      </button>
                    </div>
                  </div>
                ) : null}

                {docLoading ? <Loading label="正在读取原文…" /> : null}
                {docError ? <ErrorBlock message={docError} /> : null}
                {doc && !docLoading ? (
                  <article className="zx-cw-article">
                    <Markdown text={doc.content} />
                  </article>
                ) : null}
              </>
            )}
          </section>
        </div>
      ) : (
        <div className="zx-card">
          {items.length === 0 ? (
            <div className="zx-empty">还没有课件。回到「章节」选一章，点「生成课件」。</div>
          ) : (
            <table className="zx-table">
              <thead>
                <tr>
                  <th>课件</th>
                  <th>类型</th>
                  <th>来源章节</th>
                  <th>状态</th>
                  <th>更新时间</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const status = STATUS[item.status] || STATUS.draft;
                  return (
                    <tr key={item.id}>
                      <td><div className="zx-cell-title">{item.title}</div></td>
                      <td>{TYPE_LABEL[item.type] || item.type}</td>
                      <td className="zx-cell-sub">{item.bundleTitle || '—'} · {item.docTitle}</td>
                      <td><span className={`zx-pill ${status.kind === 'live' ? 'zx-pill-live' : 'zx-pill-draft'}`}>{status.label}</span></td>
                      <td className="zx-num">{item.updatedAt}</td>
                      <td className="zx-actions">
                        <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={item.status === 'generating'} onClick={() => setPreviewing(item)}>预览</button>
                        {item.status === 'published' ? (
                          <button type="button" className="zx-btn zx-btn-sm" onClick={() => setStatus(item.id, 'draft')}>下架</button>
                        ) : (
                          <button type="button" className="zx-btn zx-btn-sm" disabled={item.status === 'generating'} onClick={() => setStatus(item.id, 'published')}>发布</button>
                        )}
                        <button type="button" className="zx-btn zx-btn-sm zx-btn-danger" onClick={() => remove(item.id)}>删除</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {previewing ? (
        <div className="zx-cw-modal" role="dialog" aria-modal="true">
          <div className="zx-cw-modal-body">
            <header className="zx-cw-modal-head">
              <strong>{previewing.title}</strong>
              <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" onClick={() => setPreviewing(null)}>关闭</button>
            </header>
            <div className="zx-cw-modal-content">
              <Notice kind="info">演示数据：课件内容尚未真正生成，这里只是占位预览。</Notice>
              <Markdown text={`## ${previewing.docTitle}\n\n### ${TYPE_LABEL[previewing.type] || previewing.type}\n\n正式生成后，这里会显示产物预览：讲义正文、练习题与解析、测验题目，或幻灯片分页。\n\n- 来源知识库：${previewing.bundleTitle || '—'}\n- 来源章节：${previewing.docTitle}\n- 当前状态：${(STATUS[previewing.status] || STATUS.draft).label}`} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
