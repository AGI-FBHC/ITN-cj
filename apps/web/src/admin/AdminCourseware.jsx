import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';
import { bundleReadable, BundleLogo } from './BundlePipeline.jsx';
import Markdown from './Markdown.jsx';
import { useNavigate } from 'react-router-dom';
import './courseware-queue.css';
import {
  DEFAULT_GENERATION_OPTIONS,
  DETAIL_LEVELS,
  PPT_BACKGROUNDS,
  generationOptionsAreDefault,
  normalizeGenerationOptions,
  resourceOptionSummary,
} from './courseware-options.js';

const RESOURCES = [
  { key: 'lecture', label: '讲义文稿', badge: '讲', desc: '把章节原文整理成可阅读的讲解稿', meta: '支持精简 / 标准 / 详细' },
  { key: 'guide', label: '实操指南', badge: '操', desc: '可跟着做的步骤、命令与检查点', meta: '支持精简 / 标准 / 详细' },
  { key: 'bank', label: '题库', badge: '题', desc: '随堂练习与章节测验，统一进题库', meta: '可选 5–20 题' },
  { key: 'slides', label: '教学幻灯片', badge: '播', desc: '旧版预设模板，按章节自动生成', meta: '可调页数、背景和讲稿' },
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
const LIBRARY_FILTER_KEY = 'zx-courseware-library-filters-v2';

function readLibraryFilters() {
  const fallback = { query: '', kinds: [], docIds: [], status: 'all', published: 'all' };
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(LIBRARY_FILTER_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      query: typeof parsed.query === 'string' ? parsed.query : '',
      kinds: Array.isArray(parsed.kinds) ? parsed.kinds.filter((kind) => TYPE_LABEL[kind]) : [],
      docIds: Array.isArray(parsed.docIds) ? parsed.docIds.filter((id) => typeof id === 'string') : [],
      status: ['all', 'queued', 'generating', 'ready', 'failed'].includes(parsed.status) ? parsed.status : 'all',
      published: ['all', 'published', 'unpublished'].includes(parsed.published) ? parsed.published : 'all',
    };
  } catch {
    return fallback;
  }
}

function toggleArrayValue(list, value) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

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

function CoursewareQueueIndicator({ queue, open, onToggle, onClose }) {
  const containerRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) onClose();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);
  const running = Number(queue?.running || 0);
  const queued = Number(queue?.queued || 0);
  const limit = Number(queue?.maxParallel || 10);
  const active = running + queued;
  const items = queue?.items || [];
  const liveItem = items.find((item) => item.status === 'generating' && item.latestMessage)
    || items.find((item) => item.status === 'generating')
    || items.find((item) => item.status === 'queued')
    || null;
  const liveMessage = liveItem?.latestMessage || (liveItem?.status === 'queued' ? '等待并发槽位' : '当前没有新的执行消息');
  return <div className="zx-cw-queue" ref={containerRef}>
    <button ref={triggerRef} type="button" className={`zx-cw-queue-trigger${active ? ' is-active' : ''}`} onClick={onToggle} aria-expanded={open} aria-label={`课件生成队列，${running} 个生成中，${queued} 个排队中`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="3" cy="6" r=".8" fill="currentColor"/><circle cx="3" cy="12" r=".8" fill="currentColor"/><circle cx="3" cy="18" r=".8" fill="currentColor"/></svg>
      <strong>任务队列</strong>
      {active ? <span>{active > 99 ? '99+' : active}</span> : null}
    </button>
    {open ? <section className="zx-cw-queue-popover" aria-label="课件生成任务进度">
      <header><div><strong>任务队列</strong><p>{running} 个进行中 · {queued} 个排队中</p></div><span>{running}/{limit}</span></header>
      <div className="zx-cw-queue-live" role="status" aria-live="polite">
        <div>
          <span>最新过程</span>
          <strong title={liveItem?.docTitle || liveItem?.title || '暂无任务'}>
            {liveItem?.docTitle || liveItem?.title || '暂无任务'}
          </strong>
        </div>
        <p title={liveMessage}>{liveMessage}</p>
      </div>
      <div className="zx-cw-queue-meter"><i style={{ width: `${limit ? Math.min(100, running / limit * 100) : 0}%` }} /></div>
      {items.length ? <div className="zx-cw-queue-list">{items.slice(0, 6).map((item) => <div key={item.id}>
        <span className={`zx-cw-queue-dot is-${item.status}`} />
        <div>
          <strong>{item.docTitle || item.title || '未命名章节'}</strong>
          <small>{item.bundleTitle || '知识库'} · {item.status === 'queued' ? '等待开始' : '正在生成'}</small>
          <em title={item.latestMessage || ''}>{item.latestMessage || (item.status === 'queued' ? '等待并发槽位' : '正在准备生成')}</em>
        </div>
      </div>)}</div> : <p className="zx-cw-queue-empty">当前没有生成任务</p>}
    </section> : null}
  </div>;
}

function GenerationSettingsPanel({ picked, active, onActive, options, onChange }) {
  if (picked.length === 0) return null;
  const activeKind = picked.includes(active) ? active : picked[0];
  const resource = RESOURCES.find((item) => item.key === activeKind);
  const detailField = activeKind === 'guide' ? 'guideDetailLevel' : 'lectureDetailLevel';
  const activeDetailLevel = activeKind === 'guide' ? options.guideDetailLevel : options.lectureDetailLevel;
  const update = (key, value) => onChange((current) => ({ ...current, [key]: value }));
  return <section className="zx-cw-gen-settings" aria-label="生成设置">
    <header>
      <div>
        <strong>生成设置</strong>
        <span>全部选填，不调整时使用当前默认值</span>
      </div>
      <button type="button" className="zx-cw-settings-reset" onClick={() => onChange({ ...DEFAULT_GENERATION_OPTIONS })}>恢复默认</button>
    </header>
    <div className="zx-cw-settings-tabs" role="tablist" aria-label="选择要设置的内容类型">
      {picked.map((kind) => {
        const item = RESOURCES.find((resourceItem) => resourceItem.key === kind);
        return <button
          key={kind}
          type="button"
          role="tab"
          aria-selected={activeKind === kind}
          className={activeKind === kind ? 'active' : ''}
          onClick={() => onActive(kind)}
        >
          <span>{item?.label || kind}</span>
          <small>{resourceOptionSummary(kind, options)}</small>
        </button>;
      })}
    </div>
    <div className="zx-cw-settings-panel" role="tabpanel" aria-label={`${resource?.label || '资源'}设置`}>
      {(activeKind === 'lecture' || activeKind === 'guide') ? <div className="zx-cw-detail-levels">
        <span className="zx-cw-settings-label">详细程度</span>
        <div role="group" aria-label="详细程度">
          {DETAIL_LEVELS.map((level) => <button
            key={level.value}
            type="button"
            className={activeDetailLevel === level.value ? 'active' : ''}
            aria-pressed={activeDetailLevel === level.value}
            onClick={() => update(detailField, level.value)}
          >
            <strong>{level.label}</strong>
            <small>{level.description}</small>
          </button>)}
        </div>
      </div> : null}

      {activeKind === 'bank' ? <div className="zx-cw-number-setting">
        <div>
          <span className="zx-cw-settings-label">题目数量</span>
          <small>默认 8 题，支持 5–20 题</small>
        </div>
        <div className="zx-cw-stepper">
          <button type="button" aria-label="减少题目" disabled={options.questionCount <= 5} onClick={() => update('questionCount', Math.max(5, options.questionCount - 1))}>−</button>
          <input type="number" min="5" max="20" value={options.questionCount} aria-label="题目数量" onChange={(event) => update('questionCount', Math.min(20, Math.max(5, Number(event.target.value) || 5)))} />
          <button type="button" aria-label="增加题目" disabled={options.questionCount >= 20} onClick={() => update('questionCount', Math.min(20, options.questionCount + 1))}>+</button>
          <span>题</span>
        </div>
      </div> : null}

      {activeKind === 'slides' ? <div className="zx-cw-slide-settings">
        <div className="zx-cw-number-setting">
          <div>
            <span className="zx-cw-settings-label">结构页数</span>
            <small>章节页会自动追加，最终 PPT 页数可能更多</small>
          </div>
          <div className="zx-cw-stepper">
            <button type="button" aria-label="减少页面" disabled={options.slideCount <= 8} onClick={() => update('slideCount', Math.max(8, options.slideCount - 1))}>−</button>
            <input type="number" min="8" max="20" value={options.slideCount} aria-label="结构页数" onChange={(event) => update('slideCount', Math.min(20, Math.max(8, Number(event.target.value) || 8)))} />
            <button type="button" aria-label="增加页面" disabled={options.slideCount >= 20} onClick={() => update('slideCount', Math.min(20, options.slideCount + 1))}>+</button>
            <span>页</span>
          </div>
        </div>
        <div className="zx-cw-background-setting">
          <span className="zx-cw-settings-label">背景模板</span>
          <div className="zx-cw-background-grid" role="radiogroup" aria-label="PPT 背景模板">
            {PPT_BACKGROUNDS.map((background) => <button
              key={background.value}
              type="button"
              role="radio"
              aria-checked={options.backgroundStyle === background.value}
              className={options.backgroundStyle === background.value ? 'active' : ''}
              onClick={() => update('backgroundStyle', background.value)}
            >
              <span className="zx-cw-background-preview">
                {background.preview
                  ? <img src={background.preview} alt="" />
                  : <i>无背景</i>}
              </span>
              <small>{background.label}</small>
            </button>)}
          </div>
        </div>
        <label className="zx-cw-toggle-setting">
          <span>
            <strong>生成讲者备注</strong>
            <small>随 PPTX 输出逐页口播稿</small>
          </span>
          <input type="checkbox" checked={options.includeSpeakerNotes} onChange={(event) => update('includeSpeakerNotes', event.target.checked)} />
        </label>
      </div> : null}
    </div>
    <label className="zx-cw-note-setting">
      <span>
        <strong>补充说明</strong>
        <small>可限定受众、范围和侧重点，不会覆盖本章原文事实</small>
      </span>
      <textarea
        maxLength="300"
        rows="2"
        value={options.note}
        onChange={(event) => update('note', event.target.value)}
        placeholder="选填，例如：面向零基础学生，侧重本章的实操案例。"
      />
      <em>{options.note.length}/300</em>
    </label>
  </section>;
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
  const [orderSlotCount, setOrderSlotCount] = React.useState(18);
  const [submittingGeneration, setSubmittingGeneration] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [queueOpen, setQueueOpen] = React.useState(false);
  const closeQueue = React.useCallback(() => setQueueOpen(false), []);
  const savedLibraryFilters = React.useMemo(() => readLibraryFilters(), []);
  const [libraryQuery, setLibraryQuery] = React.useState(savedLibraryFilters.query);
  const [libraryKinds, setLibraryKinds] = React.useState(savedLibraryFilters.kinds);
  const [libraryDocIds, setLibraryDocIds] = React.useState(savedLibraryFilters.docIds);
  const [libraryStatus, setLibraryStatus] = React.useState(savedLibraryFilters.status);
  const [libraryPublished, setLibraryPublished] = React.useState(savedLibraryFilters.published);
  const [sourcePickerOpen, setSourcePickerOpen] = React.useState(false);
  const [sourceQuery, setSourceQuery] = React.useState('');
  const [moreFiltersOpen, setMoreFiltersOpen] = React.useState(false);
  const [collapsedGroups, setCollapsedGroups] = React.useState([]);
  const [generationOptions, setGenerationOptions] = React.useState({ ...DEFAULT_GENERATION_OPTIONS });
  const [settingsTab, setSettingsTab] = React.useState('lecture');
  const sourcePickerRef = React.useRef(null);
  const pollTimer = React.useRef(null);

  const bundles = (bundlesState.data?.bundles || []).filter((item) => bundleReadable(item));
  const selectedBundle = bundles.find((item) => item.id === bundleId) || null;
  const courseLive = selectedBundle?.courseStatus === 'published';
  const chaptersState = useLoad(
    () => (bundleId
      ? adminApi.kbBundleSources(bundleId).then((data) => ({ ...data, forBundle: bundleId }))
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
  const generationResources = resourceByKind(items.filter((item) => item.docId === doc?.id));
  const sourceGroups = React.useMemo(() => {
    const bundlesById = new Map();
    for (const item of items) {
      if (!bundlesById.has(item.bundleId)) {
        bundlesById.set(item.bundleId, {
          id: item.bundleId,
          title: item.bundleTitle || '未命名知识库',
          docsById: new Map(),
        });
      }
      const bundle = bundlesById.get(item.bundleId);
      if (!bundle.docsById.has(item.docId)) {
        bundle.docsById.set(item.docId, {
          id: item.docId,
          title: item.docTitle || '未命名章节',
          order: Number(item.sourceOrder || item.chapterOrder || 0),
          bundleId: item.bundleId,
          bundleTitle: bundle.title,
        });
      }
    }
    return [...bundlesById.values()]
      .map((bundle) => ({
        ...bundle,
        docs: [...bundle.docsById.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh-CN')),
      }))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  }, [items]);
  const sourceDocs = React.useMemo(
    () => sourceGroups.flatMap((bundle) => bundle.docs),
    [sourceGroups],
  );
  const libraryItems = React.useMemo(() => {
    const keyword = libraryQuery.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (libraryKinds.length > 0 && !libraryKinds.includes(item.kind)) return false;
      if (libraryDocIds.length > 0 && !libraryDocIds.includes(item.docId)) return false;
      if (libraryStatus !== 'all' && item.status !== libraryStatus) return false;
      if (libraryPublished === 'published' && !item.published) return false;
      if (libraryPublished === 'unpublished' && item.published) return false;
      if (!keyword) return true;
      return [item.title, item.kindLabel, item.bundleTitle, item.docTitle, item.errorMessage,
        `第 ${item.sourceOrder || item.chapterOrder || 0} 章`]
        .some((value) => String(value || '').toLocaleLowerCase().includes(keyword));
    });
  }, [items, libraryDocIds, libraryKinds, libraryPublished, libraryQuery, libraryStatus]);
  const libraryGroups = React.useMemo(() => {
    const groups = new Map();
    for (const item of libraryItems) {
      const key = `${item.bundleId}:${item.docId}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          bundleId: item.bundleId,
          docId: item.docId,
          bundleTitle: item.bundleTitle || '未命名知识库',
          docTitle: item.docTitle || '未命名章节',
          sourceOrder: Number(item.sourceOrder || item.chapterOrder || 0),
          items: [],
        });
      }
      groups.get(key).items.push(item);
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        items: group.items.sort((a, b) => (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99)
          || String(b.updatedAt).localeCompare(String(a.updatedAt))),
      }))
      .sort((a, b) => a.bundleTitle.localeCompare(b.bundleTitle, 'zh-CN')
        || a.sourceOrder - b.sourceOrder
        || a.docTitle.localeCompare(b.docTitle, 'zh-CN'));
  }, [libraryItems]);
  const selectedSourceDocs = React.useMemo(
    () => sourceDocs.filter((doc) => libraryDocIds.includes(doc.id)),
    [libraryDocIds, sourceDocs],
  );
  const visibleSourceGroups = React.useMemo(() => {
    const keyword = sourceQuery.trim().toLocaleLowerCase();
    if (!keyword) return sourceGroups;
    return sourceGroups
      .map((bundle) => {
        if (bundle.title.toLocaleLowerCase().includes(keyword)) return bundle;
        return {
          ...bundle,
          docs: bundle.docs.filter((doc) => `${doc.order} ${doc.title}`.toLocaleLowerCase().includes(keyword)),
        };
      })
      .filter((bundle) => bundle.docs.length > 0);
  }, [sourceGroups, sourceQuery]);
  const libraryFiltered = Boolean(
    libraryQuery.trim()
    || libraryKinds.length > 0
    || libraryDocIds.length > 0
    || libraryStatus !== 'all'
    || libraryPublished !== 'all',
  );
  const clearLibraryFilters = () => {
    setLibraryQuery('');
    setLibraryKinds([]);
    setLibraryDocIds([]);
    setLibraryStatus('all');
    setLibraryPublished('all');
    setSourcePickerOpen(false);
  };
  const toggleLibraryKind = (kind) => {
    setLibraryKinds((current) => toggleArrayValue(current, kind));
  };
  const toggleSourceDoc = (docId) => {
    setLibraryDocIds((current) => toggleArrayValue(current, docId));
  };
  const toggleSourceBundle = (bundle) => {
    const docIds = bundle.docs.map((doc) => doc.id);
    const allSelected = docIds.every((id) => libraryDocIds.includes(id));
    setLibraryDocIds((current) => allSelected
      ? current.filter((id) => !docIds.includes(id))
      : [...new Set([...current, ...docIds])]);
  };
  const selectVisibleSources = () => {
    const ids = visibleSourceGroups.flatMap((bundle) => bundle.docs.map((doc) => doc.id));
    setLibraryDocIds((current) => [...new Set([...current, ...ids])]);
  };
  const toggleGroup = (key) => {
    setCollapsedGroups((current) => toggleArrayValue(current, key));
  };
  const generating = items.some((item) => item.status === 'generating' || item.status === 'queued')
    || Number(queueState.data?.running || 0) + Number(queueState.data?.queued || 0) > 0;

  React.useEffect(() => {
    try {
      window.sessionStorage.setItem(LIBRARY_FILTER_KEY, JSON.stringify({
        query: libraryQuery,
        kinds: libraryKinds,
        docIds: libraryDocIds,
        status: libraryStatus,
        published: libraryPublished,
      }));
    } catch {
      // Filter persistence is a convenience; the page still works without storage.
    }
  }, [libraryDocIds, libraryKinds, libraryPublished, libraryQuery, libraryStatus]);

  React.useEffect(() => {
    if (!sourcePickerOpen) return undefined;
    const closeOutside = (event) => {
      if (!sourcePickerRef.current?.contains(event.target)) setSourcePickerOpen(false);
    };
    const closeEscape = (event) => {
      if (event.key === 'Escape') setSourcePickerOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [sourcePickerOpen]);

  React.useEffect(() => {
    if (picked.length > 0 && !picked.includes(settingsTab)) setSettingsTab(picked[0]);
  }, [picked, settingsTab]);

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
    setDoc(null);
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

  function updateGenerationOptions(next) {
    setGenerationOptions((current) => (typeof next === 'function' ? next(current) : next));
  }

  function openGenerationPicker() {
    setPicked([]);
    setGenerationOptions({ ...DEFAULT_GENERATION_OPTIONS });
    setSettingsTab('lecture');
    setShowPicker(true);
  }

  function reloadAll() {
    bundlesState.reload();
    listState.reload();
    liveState.reload();
    queueState.reload();
  }

  async function generate() {
    if (picked.length === 0 || !doc || submittingGeneration) return;
    const replaced = picked.filter((kind) => generationResources[kind]);
    if (replaced.length && !window.confirm(`重新生成「${replaced.map((kind) => TYPE_LABEL[kind]).join('、')}」？\n\n确认后将立即下架这些资源并清空对应的学员学习、测验和书签记录。其他资源及章节的记录保留。\n\n生成完成后需要重新发布，学员才能继续使用。`)) return;
    setSubmittingGeneration(true);
    setError('');
    try {
      await adminApi.cwGenerate({
        bundleId,
        docId: doc.id,
        kinds: picked,
        replaceExisting: replaced.length > 0,
        expectedGenerations: Object.fromEntries(replaced.map((kind) => [kind, generationResources[kind].generation || 1])),
        options: {
          ...generationOptions,
          note: generationOptions.note.trim(),
        },
      });
      setShowPicker(false);
      setMessage(`已提交 ${picked.length} 份课件，使用了当前生成设置。`);
      setPicked([]);
      setGenerationOptions({ ...DEFAULT_GENERATION_OPTIONS });
      reloadAll();
    } catch (failure) {
      setError(failure.message);
      listState.reload();
    } finally {
      setSubmittingGeneration(false);
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
    setOrderSlotCount(Math.max(18, nextFree, ...liveChapters.map((chapter) => chapter.orderNo || 0)));
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
  const orderSlots = Math.max(18, orderSlotCount, order, ...liveChapters.map((chapter) => chapter.orderNo || 0));

  return (
    <div className="zx-admin-page">
      <PageHead
        title="课件管理"
        actions={
          <>
            <CoursewareQueueIndicator queue={queueState.data} open={queueOpen} onToggle={() => setQueueOpen((value) => !value)} onClose={closeQueue} />
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
                    <button type="button" className="zx-btn zx-btn-ghost" disabled={!doc || docLoading} onClick={openGenerationPicker}>
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
        <div className="zx-card zx-cw-library-card">
          <section className="zx-cw-library-filters" aria-label="课件库筛选">
            <label className="zx-cw-library-search">
              <span>搜索</span>
              <input
                type="search"
                aria-label="搜索课件"
                value={libraryQuery}
                onChange={(event) => setLibraryQuery(event.target.value)}
                placeholder="搜索课件、知识库、章节或错误信息"
              />
            </label>
            <div className="zx-cw-source-filter" ref={sourcePickerRef}>
              <span className="zx-cw-filter-label">来源</span>
              <button
                type="button"
                className={`zx-cw-source-trigger ${libraryDocIds.length ? 'has-value' : ''}`}
                aria-expanded={sourcePickerOpen}
                onClick={() => setSourcePickerOpen((value) => !value)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5.5h6l2 2h8v11H4z"/><path d="M4 10h16"/></svg>
                <span>{libraryDocIds.length ? `已选 ${libraryDocIds.length} 个章节` : '全部知识库与章节'}</span>
                <svg className="zx-cw-filter-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 7.5 5 5 5-5"/></svg>
              </button>
              {sourcePickerOpen ? <div className="zx-cw-source-picker" role="dialog" aria-label="选择来源知识库和章节">
                <header>
                  <div>
                    <strong>选择来源</strong>
                    <span>支持勾选整个知识库或其中章节</span>
                  </div>
                  <button type="button" aria-label="关闭来源筛选" onClick={() => setSourcePickerOpen(false)}>×</button>
                </header>
                <label className="zx-cw-source-picker-search">
                  <input
                    type="search"
                    value={sourceQuery}
                    onChange={(event) => setSourceQuery(event.target.value)}
                    placeholder="搜索知识库或章节"
                    aria-label="搜索来源知识库或章节"
                  />
                </label>
                <div className="zx-cw-source-picker-actions">
                  <span>已选 {libraryDocIds.length} 个</span>
                  <div>
                    <button type="button" onClick={() => setLibraryDocIds([])} disabled={libraryDocIds.length === 0}>清空</button>
                    <button type="button" onClick={selectVisibleSources} disabled={visibleSourceGroups.length === 0}>选择当前</button>
                  </div>
                </div>
                <div className="zx-cw-source-picker-list">
                  {visibleSourceGroups.length === 0 ? <p>没有匹配的知识库或章节</p> : visibleSourceGroups.map((bundle) => {
                    const allSelected = bundle.docs.every((doc) => libraryDocIds.includes(doc.id));
                    return <section key={bundle.id} className="zx-cw-source-group">
                      <label className="zx-cw-source-bundle">
                        <input type="checkbox" checked={allSelected} onChange={() => toggleSourceBundle(bundle)} />
                        <span>
                          <strong>{bundle.title}</strong>
                          <small>{bundle.docs.length} 个章节</small>
                        </span>
                      </label>
                      <div className="zx-cw-source-docs">
                        {bundle.docs.map((doc) => <label key={doc.id}>
                          <input type="checkbox" checked={libraryDocIds.includes(doc.id)} onChange={() => toggleSourceDoc(doc.id)} />
                          <span className="zx-cw-source-order">{doc.order > 0 ? doc.order : '·'}</span>
                          <span title={doc.title}>{doc.title}</span>
                        </label>)}
                      </div>
                    </section>;
                  })}
                </div>
                <footer>
                  <span>选择后与课件类型、状态条件同时生效</span>
                  <button type="button" className="zx-btn zx-btn-sm zx-btn-primary" onClick={() => setSourcePickerOpen(false)}>完成</button>
                </footer>
              </div> : null}
            </div>
            <div className="zx-cw-kind-filter">
              <span className="zx-cw-filter-label">课件类型</span>
              <div role="group" aria-label="课件类型（可多选）">
                <button
                  type="button"
                  className={libraryKinds.length === 0 ? 'active' : ''}
                  aria-pressed={libraryKinds.length === 0}
                  onClick={() => setLibraryKinds([])}
                >全部</button>
                {RESOURCES.map((resource) => <button
                  key={resource.key}
                  type="button"
                  className={libraryKinds.includes(resource.key) ? 'active' : ''}
                  aria-pressed={libraryKinds.includes(resource.key)}
                  onClick={() => toggleLibraryKind(resource.key)}
                >{resource.label}</button>)}
              </div>
            </div>
            <div className="zx-cw-library-filter-meta">
              <span><strong>{libraryItems.length}</strong> / {items.length} 份</span>
              <button type="button" className={moreFiltersOpen ? 'active' : ''} onClick={() => setMoreFiltersOpen((value) => !value)}>更多筛选</button>
              <button type="button" disabled={!libraryFiltered} onClick={clearLibraryFilters}>清除</button>
            </div>
          </section>
          {moreFiltersOpen ? <section className="zx-cw-library-more" aria-label="更多课件筛选">
            <label>
              <span>生成状态</span>
              <select aria-label="生成状态" value={libraryStatus} onChange={(event) => setLibraryStatus(event.target.value)}>
                <option value="all">全部状态</option>
                <option value="queued">排队中</option>
                <option value="generating">生成中</option>
                <option value="ready">已完成</option>
                <option value="failed">生成失败</option>
              </select>
            </label>
            <label>
              <span>上架状态</span>
              <select aria-label="上架状态" value={libraryPublished} onChange={(event) => setLibraryPublished(event.target.value)}>
                <option value="all">全部</option>
                <option value="published">已发布</option>
                <option value="unpublished">未发布</option>
              </select>
            </label>
          </section> : null}
          {libraryFiltered ? <div className="zx-cw-active-filters" aria-label="当前筛选条件">
            <span>当前条件</span>
            {selectedSourceDocs.map((doc) => <button key={doc.id} type="button" onClick={() => toggleSourceDoc(doc.id)}>
              {doc.bundleTitle} · 第 {doc.order} 章 {doc.title}<em>×</em>
            </button>)}
            {libraryKinds.map((kind) => <button key={kind} type="button" onClick={() => toggleLibraryKind(kind)}>
              {TYPE_LABEL[kind]}<em>×</em>
            </button>)}
            {libraryStatus !== 'all' ? <button type="button" onClick={() => setLibraryStatus('all')}>
              {STATUS[libraryStatus]?.label || libraryStatus}<em>×</em>
            </button> : null}
            {libraryPublished !== 'all' ? <button type="button" onClick={() => setLibraryPublished('all')}>
              {libraryPublished === 'published' ? '已发布' : '未发布'}<em>×</em>
            </button> : null}
            <button type="button" className="zx-cw-clear-all" onClick={clearLibraryFilters}>全部清除</button>
          </div> : null}
          {items.length === 0 ? (
            <div className="zx-empty">还没有课件</div>
          ) : libraryItems.length === 0 ? (
            <div className="zx-cw-library-no-match">
              <strong>没有符合条件的课件</strong>
              <button type="button" onClick={clearLibraryFilters}>清除筛选条件</button>
            </div>
          ) : (
            <table className="zx-table">
              <thead>
                <tr>
                  <th>课件</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>更新时间</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              {libraryGroups.map((group) => {
                const collapsed = collapsedGroups.includes(group.key);
                const sourceLabel = group.sourceOrder > 0 ? `第 ${group.sourceOrder} 章` : '章节';
                return <tbody key={group.key}>
                  <tr className="zx-cw-library-group">
                    <td colSpan={5}>
                      <div>
                        <button type="button" className="zx-cw-library-group-toggle" aria-expanded={!collapsed} onClick={() => toggleGroup(group.key)}>
                          <svg className={collapsed ? '' : 'open'} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m7 5 5 5-5 5"/></svg>
                          <span>
                            <strong>{group.bundleTitle}</strong>
                            <small>{sourceLabel} · {group.docTitle}</small>
                          </span>
                        </button>
                        <em>{group.items.length} 个资源</em>
                        <button
                          type="button"
                          className="zx-cw-source-link"
                          onClick={() => navigate(`/admin/knowledge/bundles/${group.bundleId}?docId=${encodeURIComponent(group.docId)}`)}
                        >查看原文</button>
                      </div>
                    </td>
                  </tr>
                  {!collapsed ? group.items.map((item) => {
                    const status = item.published ? STATUS.published : (STATUS[item.status] || STATUS.ready);
                    const liveOrder = item.chapterOrder || 0;
                    const itemSource = item.sourceOrder ? `第 ${item.sourceOrder} 章` : sourceLabel;
                    return (
                      <tr key={item.id}>
                        <td><div className="zx-cw-title-with-detail">
                          <div className="zx-cw-title-copy">
                            <div className="zx-cell-title">{item.title || item.kindLabel}</div>
                            <small>{item.bundleTitle} · {itemSource} · {item.docTitle}</small>
                          </div>
                          <button
                            type="button"
                            className="zx-cw-detail-icon"
                            title="查看该资源生成过程"
                            aria-label={`查看 ${item.title || item.kindLabel} 的多智能体生成过程`}
                            onClick={() => navigate(`/admin/courseware/${item.id}/collaboration`)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>
                          </button>
                        </div></td>
                        <td className="zx-nowrap"><span className="zx-cw-kind-badge">{item.kindLabel}</span></td>
                        <td>
                          <div className="zx-cw-status-stack">
                            <span className={`zx-pill ${status.kind === 'live' ? 'zx-pill-live' : 'zx-pill-draft'}`}>{status.label}</span>
                            {liveOrder && item.published ? <small>学员端第 {liveOrder} 章</small> : null}
                          </div>
                          {item.status === 'failed' && item.errorMessage ? <div className="zx-cw-error-inline" title={item.errorMessage}>{item.errorMessage}</div> : null}
                        </td>
                        <td className="zx-num">{String(item.updatedAt || '').slice(5)}</td>
                        <td className="zx-actions">
                          <button type="button" className="zx-cw-row-action" disabled={item.status !== 'ready'} onClick={() => navigate(`/admin/courseware/${item.id}`)}>预览</button>
                          {item.published ? (
                            <button type="button" className="zx-cw-row-action" onClick={() => act(() => adminApi.cwUnpublish(item.id))}>撤回</button>
                          ) : (
                            <button type="button" className="zx-cw-row-action is-primary" disabled={item.status !== 'ready'} onClick={() => act(() => adminApi.cwPublish(item.id))}>发布</button>
                          )}
                          <button type="button" className="zx-cw-row-action is-danger" onClick={() => { if (window.confirm('删除这份课件？')) act(() => adminApi.cwDelete(item.id)); }}>删除</button>
                        </td>
                      </tr>
                    );
                  }) : null}
                </tbody>;
              })}
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
                  const existing = generationResources[item.key];
                  const working = existing && ['queued', 'generating'].includes(existing.status);
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`zx-cw-resource ${active ? 'picked' : ''}`}
                      onClick={() => togglePick(item.key)}
                      aria-pressed={active}
                      disabled={Boolean(working) || submittingGeneration}
                    >
                      <span className="zx-cw-resource-badge">{item.badge}</span>
                      <span className="zx-cw-resource-main">
                        <strong>{item.label}</strong>
                        {existing ? <em className={`zx-cw-existing-resource${existing.published ? ' is-live' : ''}`}>{working ? '生成任务进行中' : existing.published ? '已发布 · 可重新生成' : existing.status === 'failed' ? '生成失败 · 可重试' : '已生成 · 可重新生成'}</em> : null}
                        <span>{item.desc}</span>
                        <small>{resourceOptionSummary(item.key, generationOptions)} · {item.meta}</small>
                      </span>
                      <span className="zx-cw-resource-check" aria-hidden="true">{active ? '✓' : ''}</span>
                    </button>
                  );
                })}
              </div>
              <GenerationSettingsPanel
                picked={picked}
                active={settingsTab}
                onActive={setSettingsTab}
                options={generationOptions}
                onChange={updateGenerationOptions}
              />
            </div>
            <footer className="zx-cw-modal-foot">
              <span className="zx-cw-modal-meta">{picked.length === 0
                ? '选择资源后可调整生成设置'
                : `已选 ${picked.length} 项 · ${generationOptionsAreDefault(generationOptions) ? '使用默认设置' : '已应用自定义设置'}`}</span>
              <span className="zx-cw-modal-actions">
                <button type="button" className="zx-btn zx-btn-ghost" onClick={() => setShowPicker(false)}>取消</button>
                <button type="button" className="zx-btn zx-btn-primary" disabled={picked.length === 0 || submittingGeneration} onClick={generate}>{submittingGeneration ? '提交中…' : picked.some((kind) => generationResources[kind]) ? '确认重新生成' : '生成所选'}</button>
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
                  {orderSlots < 999 ? <button type="button" className="zx-cw-order zx-cw-order-add" aria-label={`添加序号 ${orderSlots + 1}`} title={`添加第 ${orderSlots + 1} 个序号`} onClick={() => setOrderSlotCount(orderSlots + 1)}><strong>＋</strong><small>添加序号</small></button> : null}
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
