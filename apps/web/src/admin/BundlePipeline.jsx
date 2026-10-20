import * as React from 'react';

const ACTIVE = new Set(['queued', 'running']);
const STAGES = {
  organizing: '整理原文', chunking: '生成切片', summarizing: '生成摘要与关键词',
  embedding: '建立向量索引', ready: '处理完成',
};
const STATUSES = {
  queued: '排队中', running: '处理中', ready: '已完成', partial: '部分完成',
  failed: '处理失败', pending: '等待处理',
};

export function bundleBusy(bundle) {
  return ACTIVE.has(bundle?.status) || ACTIVE.has(bundle?.pipeline?.status) || ACTIVE.has(bundle?.logo?.status)
    || (Boolean(bundle?.logo?.generationId) && bundle?.logo?.status === 'pending');
}

export function bundleReadable(bundle) {
  return (bundle?.docCount || 0) > 0 || bundle?.status === 'ready';
}

export function useProcessingPoll(state, enabled) {
  const reload = React.useRef(state.reload);
  reload.current = state.reload;
  React.useEffect(() => {
    if (!enabled || state.loading || state.error) return undefined;
    const timer = window.setTimeout(() => reload.current(), 2500);
    return () => window.clearTimeout(timer);
  }, [enabled, state.loading, state.error, state.data]);
}

export function BundleLogo({ bundle, size = 44 }) {
  const svg = bundle.logo?.svg;
  return svg ? (
    <img
      className="zx-bundle-logo"
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      width={size}
      height={size}
      alt={`${bundle.title || bundle.name}课程图标`}
      decoding="async"
    />
  ) : <span className="zx-bundle-logo zx-bundle-logo-empty" style={{ width: size, height: size }} aria-hidden="true">书</span>;
}

export default function BundlePipeline({ bundle, compact = false, busy = '', onRetry }) {
  const pipeline = bundle.pipeline;
  const logo = bundle.logo;
  const status = pipeline?.status || bundle.status;
  const working = ACTIVE.has(bundle.status) || ACTIVE.has(pipeline?.status);
  const label = pipeline
    ? status === 'running' ? STAGES[pipeline.stage] || '处理中' : STATUSES[status] || status
    : bundle.status === 'ready' ? '原文已整理' : bundle.status === 'running' ? '整理原文中' : STATUSES[status] || status;
  const total = pipeline?.totalChunks || 0;
  const logoLabel = ['ready', 'done', 'completed'].includes(logo?.status) ? 'Logo 已生成'
    : ACTIVE.has(logo?.status) ? 'Logo 生成中'
      : logo?.status === 'failed' ? 'Logo 生成失败' : 'Logo 待生成';

  return (
    <div className={compact ? 'zx-bundle-progress-compact' : 'zx-bundle-progress'}>
      <div className="zx-bundle-progress-head">
        <span className={`zx-pill ${status === 'ready' ? 'zx-pill-live' : 'zx-pill-draft'}`}>{label}</span>
        {logo ? <span className="zx-cell-sub">{logoLabel}</span> : null}
        {bundle.courseStatus === 'published' ? <span className="zx-pill zx-pill-live">课程已发布</span> : null}
      </div>
      {pipeline ? (
        <div className="zx-bundle-counts" aria-live="polite">
          <span>切片 <b>{total}</b></span>
          <span>摘要 <b>{pipeline.summarizedChunks || 0}/{total}</b></span>
          <span>向量 <b>{pipeline.embeddedChunks || 0}/{total}</b></span>
          {pipeline.failedChunks > 0 ? <span className="zx-bundle-failed">失败 <b>{pipeline.failedChunks}</b></span> : null}
          {pipeline.pendingChunks > 0 ? <span>待处理 <b>{pipeline.pendingChunks}</b></span> : null}
        </div>
      ) : null}
      {!compact && (pipeline?.errorMessage || logo?.errorMessage) ? (
        <div className="zx-bundle-errors" role="alert">
          {pipeline?.errorMessage ? <p>{pipeline.errorMessage}</p> : null}
          {logo?.errorMessage ? <p>Logo：{logo.errorMessage}</p> : null}
        </div>
      ) : null}
      {!compact && onRetry && (pipeline || logo) ? (
        <div className="zx-bundle-retries">
          <span>补全未完成内容</span>
          {[
            ['all', '全部'], ['summaries', '摘要与关键词'], ['embeddings', '向量索引'],
          ].map(([stage, title]) => (
            <button
              type="button"
              className="zx-btn zx-btn-sm zx-btn-ghost"
              key={stage}
              disabled={Boolean(busy) || working}
              onClick={() => onRetry(stage)}
            >
              {busy === `retry-${stage}` ? '提交中…' : title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
