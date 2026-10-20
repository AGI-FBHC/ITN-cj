import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';
import { bundleReadable, BundleLogo } from './BundlePipeline.jsx';
import Markdown from './Markdown.jsx';

const RESOURCES = [
  { key: 'lecture', label: '讲义文稿', badge: '讲', desc: '把章节原文整理成可阅读的讲解稿', meta: '约 2000–3000 字' },
  { key: 'guide', label: '实操指南', badge: '操', desc: '可跟着做的步骤、命令与检查点', meta: '8–15 步' },
  { key: 'bank', label: '题库', badge: '题', desc: '随堂练习与章节测验，统一进题库', meta: '8 题' },
  { key: 'slides', label: '教学幻灯片', badge: '播', desc: '按小节拆页，可在学习端播放', meta: '10 页' },
];

const TYPE_LABEL = Object.fromEntries(RESOURCES.map((item) => [item.key, item.label]));

const STATUS = {
  generating: { label: '生成中', kind: 'draft' },
  ready: { label: '待发布', kind: 'draft' },
  published: { label: '已发布', kind: 'live' },
  failed: { label: '失败', kind: 'draft' },
};

const STEP_ORDER = ['规划', '检索', '撰写', '质检', '仲裁'];

function readJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/* ---------- 各类产物的展示 ---------- */

function LectureView({ data }) {
  return (
    <div className="zx-cw-doc">
      {Array.isArray(data.objectives) && data.objectives.length > 0 ? (
        <ul className="zx-cw-objectives">
          {data.objectives.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      ) : null}
      {(data.sections || []).map((section, index) => (
        <section key={index} className="zx-cw-section">
          <h3>{section.heading || `第 ${index + 1} 节`}</h3>
          <Markdown text={section.body || ''} />
        </section>
      ))}
    </div>
  );
}

function GuideView({ data }) {
  const steps = data.steps || [];
  return (
    <div className="zx-cw-doc">
      {data.objective ? <p className="zx-cw-lead">{data.objective}</p> : null}
      <div className="zx-cw-meta-row">
        {data.estimatedMinutes ? <span>预计 {data.estimatedMinutes} 分钟</span> : null}
        {Array.isArray(data.environment) && data.environment.length ? <span>环境：{data.environment.join('、')}</span> : null}
      </div>
      {steps.map((step, index) => (
        <article key={index} className="zx-cw-step">
          <header>
            <span className="zx-cw-step-index">{index + 1}</span>
            <strong>{step.title || `第 ${index + 1} 步`}</strong>
            {step.safety && step.safety !== 'safe' ? (
              <span className={`zx-pill ${step.safety === 'danger' ? 'zx-pill-draft' : 'zx-pill-draft'}`}>
                {step.safety === 'danger' ? '高风险' : '注意'}
              </span>
            ) : null}
          </header>
          <Markdown text={step.instruction || ''} />
          {step.code ? <pre className="zx-cw-code"><code>{step.code}</code></pre> : null}
          {step.expectedOutput ? <p className="zx-cw-expect">预期结果：{step.expectedOutput}</p> : null}
          {step.warning ? <p className="zx-cw-warn">{step.warning}</p> : null}
        </article>
      ))}
      {Array.isArray(data.acceptanceCriteria) && data.acceptanceCriteria.length ? (
        <section className="zx-cw-section">
          <h3>验收标准</h3>
          <ul>{data.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </section>
      ) : null}
      {Array.isArray(data.troubleshooting) && data.troubleshooting.length ? (
        <section className="zx-cw-section">
          <h3>常见问题</h3>
          {data.troubleshooting.map((item, index) => (
            <p key={index} className="zx-cw-trouble"><strong>{item.problem}</strong>：{item.solution}</p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function BankView({ data }) {
  const points = data.knowledgePoints || [];
  const questions = data.questions || [];
  return (
    <div className="zx-cw-doc">
      {points.length ? (
        <div className="zx-cw-points">
          {points.map((point) => (
            <span key={point.id}>{point.name || point.id}</span>
          ))}
        </div>
      ) : null}
      {questions.map((question, index) => (
        <article key={question.id || index} className="zx-cw-question">
          <div className="zx-cw-question-head">
            <span className="zx-cw-step-index">{index + 1}</span>
            <strong>{question.stem || '（缺题干）'}</strong>
            {question.difficulty ? <span className="zx-cw-difficulty">{question.difficulty}</span> : null}
          </div>
          <ol className="zx-cw-options">
            {(question.options || []).map((option, optionIndex) => (
              <li key={optionIndex} className={optionIndex === question.correctIndex ? 'correct' : ''}>
                {option}
              </li>
            ))}
          </ol>
          {question.explanation ? <p className="zx-cw-explain">解析：{question.explanation}</p> : null}
        </article>
      ))}
    </div>
  );
}

function SlidesView({ data }) {
  const slides = data.slides || [];
  return (
    <div className="zx-cw-slides">
      {data.subtitle ? <p className="zx-cw-lead">{data.subtitle}</p> : null}
      {slides.map((slide, index) => (
        <article key={index} className="zx-cw-slide">
          <header>
            <span className="zx-cw-step-index">{index + 1}</span>
            <strong>{slide.title || `第 ${index + 1} 页`}</strong>
          </header>
          <ul>{(slide.bullets || []).map((bullet, bulletIndex) => <li key={bulletIndex}>{bullet}</li>)}</ul>
          {slide.speakerNote ? <p className="zx-cw-note">讲稿：{slide.speakerNote}</p> : null}
        </article>
      ))}
    </div>
  );
}

function CoursewareContent({ kind, content }) {
  const data = typeof content === 'string' ? readJson(content) : content;
  if (!data) return <Notice kind="info">还没有产出内容。</Notice>;
  if (kind === 'guide') return <GuideView data={data} />;
  if (kind === 'bank') return <BankView data={data} />;
  if (kind === 'slides') return <SlidesView data={data} />;
  return <LectureView data={data} />;
}

function StepTimeline({ steps }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return (
    <div className="zx-cw-steps">
      {steps.map((step, index) => (
        <div key={index} className={`zx-cw-stepchip ${step.status}`}>
          <span className="zx-cw-stepchip-role">{step.role}</span>
          <span className="zx-cw-stepchip-text">{step.error || step.summary || '…'}</span>
        </div>
      ))}
      {steps.length < STEP_ORDER.length && steps.some((step) => step.status === 'running') ? (
        <div className="zx-cw-stepchip running">
          <span className="zx-cw-stepchip-role">{STEP_ORDER[steps.length] || '…'}</span>
          <span className="zx-cw-stepchip-text">进行中…</span>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- 页面 ---------- */

export default function AdminCourseware() {
  const bundlesState = useLoad(() => adminApi.kbBundles(), []);
  const listState = useLoad(() => adminApi.cwList(), []);
  const [bundleId, setBundleId] = React.useState('');
  const [activeDocId, setActiveDocId] = React.useState('');
  const [doc, setDoc] = React.useState(null);
  const [docLoading, setDocLoading] = React.useState(false);
  const [docError, setDocError] = React.useState('');
  const [view, setView] = React.useState('chapters');
  const [showPicker, setShowPicker] = React.useState(false);
  const [picked, setPicked] = React.useState([]);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const [previewId, setPreviewId] = React.useState('');
  const [preview, setPreview] = React.useState(null);
  const pollTimer = React.useRef(null);

  const bundles = (bundlesState.data?.bundles || []).filter((item) => bundleReadable(item));
  const selectedBundle = bundles.find((item) => item.id === bundleId) || null;
  const chaptersState = useLoad(
    () => (bundleId ? adminApi.kbBundle(bundleId) : Promise.resolve({ docs: [] })),
    [bundleId],
  );
  const chapters = chaptersState.data?.docs || [];
  const activeChapter = chapters.find((item) => item.id === activeDocId) || null;
  const items = listState.data?.items || [];
  const generating = items.some((item) => item.status === 'generating');

  // 有生成中的任务就轮询
  React.useEffect(() => {
    if (!generating) {
      if (pollTimer.current) { window.clearTimeout(pollTimer.current); pollTimer.current = null; }
      return undefined;
    }
    pollTimer.current = window.setTimeout(() => listState.reload(), 3000);
    return () => {
      if (pollTimer.current) { window.clearTimeout(pollTimer.current); pollTimer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generating, listState.data]);

  React.useEffect(() => {
    if (!bundleId && bundles.length > 0 && !bundlesState.loading) setBundleId(bundles[0].id);
  }, [bundles, bundleId, bundlesState.loading]);

  React.useEffect(() => {
    setActiveDocId('');
    setDoc(null);
  }, [bundleId]);

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

  // 打开预览时拉详情（含流程）
  React.useEffect(() => {
    if (!previewId) { setPreview(null); return undefined; }
    let alive = true;
    setPreview({ loading: true });
    adminApi
      .cwDetail(previewId)
      .then((result) => { if (alive) setPreview({ loading: false, ...result }); })
      .catch((failure) => { if (alive) setPreview({ loading: false, error: failure.message }); });
    return () => { alive = false; };
  }, [previewId, listState.data]);

  function togglePick(key) {
    setPicked((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
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

  if (bundlesState.loading && !bundlesState.data) return <Loading label="正在读取知识库…" />;
  if (bundlesState.error) return <ErrorBlock message={bundlesState.error} onRetry={bundlesState.reload} />;

  return (
    <div className="zx-admin-page">
      <PageHead
        title="课件管理"
        actions={
          <>
            <div className="zx-tabs" style={{ margin: 0 }}>
              <button type="button" className={`zx-tab ${view === 'chapters' ? 'active' : ''}`} onClick={() => setView('chapters')}>章节</button>
              <button type="button" className={`zx-tab ${view === 'library' ? 'active' : ''}`} onClick={() => setView('library')}>
                课件库{items.length > 0 ? ` · ${items.length}` : ''}
              </button>
            </div>
            <button type="button" className="zx-btn zx-btn-ghost" onClick={() => { bundlesState.reload(); listState.reload(); }}>刷新</button>
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
              <div className="zx-cw-placeholder">选择一个章节</div>
            ) : (
              <>
                <header className="zx-cw-main-head">
                  <div>
                    <strong>{activeChapter.title}</strong>
                    <span>{activeChapter.charCount} 字{activeChapter.sourcePath ? ` · ${activeChapter.sourcePath}` : ''}</span>
                  </div>
                  <button type="button" className="zx-btn zx-btn-primary" disabled={!doc || docLoading} onClick={() => { setPicked([]); setShowPicker(true); }}>
                    生成课件
                  </button>
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
                  <th>更新时间</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const status = item.published ? STATUS.published : (STATUS[item.status] || STATUS.draft);
                  return (
                    <tr key={item.id}>
                      <td><div className="zx-cell-title">{item.title || item.kindLabel}</div></td>
                      <td>{item.kindLabel}</td>
                      <td className="zx-cell-sub">{item.bundleTitle} · {item.docTitle}</td>
                      <td>
                        <span className={`zx-pill ${status.kind === 'live' ? 'zx-pill-live' : 'zx-pill-draft'}`}>{status.label}</span>
                        {item.status === 'failed' && item.errorMessage ? <div className="zx-cell-sub">{item.errorMessage}</div> : null}
                      </td>
                      <td className="zx-num">{item.updatedAt}</td>
                      <td className="zx-actions">
                        <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={item.status !== 'ready'} onClick={() => setPreviewId(item.id)}>预览</button>
                        {item.published ? (
                          <button type="button" className="zx-btn zx-btn-sm" onClick={() => act(() => adminApi.cwUnpublish(item.id))}>下架</button>
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

      {previewId ? (
        <div className="zx-cw-modal" role="dialog" aria-modal="true" onClick={(event) => { if (event.target === event.currentTarget) setPreviewId(''); }}>
          <div className="zx-cw-modal-body">
            <header className="zx-cw-modal-head">
              <div className="zx-cw-modal-titles">
                <strong>{preview?.item?.title || '课件预览'}</strong>
                <span>{preview?.item ? `${preview.item.kindLabel} · ${preview.item.docTitle}` : ''}</span>
              </div>
              <button type="button" className="zx-cw-modal-close" aria-label="关闭" onClick={() => setPreviewId('')}>×</button>
            </header>
            <div className="zx-cw-modal-content">
              {preview?.loading ? <Loading label="正在读取课件…" /> : null}
              {preview?.error ? <ErrorBlock message={preview.error} /> : null}
              {preview?.steps ? <StepTimeline steps={preview.steps} /> : null}
              {preview?.item && !preview.loading ? (
                <CoursewareContent kind={preview.item.kind} content={preview.content} />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
