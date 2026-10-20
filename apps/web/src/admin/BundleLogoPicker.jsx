import * as React from 'react';
import { adminApi } from './admin-api.js';
import { Notice, useLoad } from './admin-ui.jsx';
import { useProcessingPoll } from './BundlePipeline.jsx';

const WORKING = new Set(['pending', 'queued', 'running']);
const STYLES = { line: '线条', flat: '扁平', geometric: '几何' };

export default function BundleLogoPicker({ bundle, onChanged }) {
  const [createdId, setCreatedId] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const generationId = createdId || bundle.logo?.generationId;
  const state = useLoad(() => generationId ? adminApi.logoGeneration(generationId) : Promise.resolve(null), [generationId]);
  const result = state.data?.id === generationId ? state.data : null;
  const working = !state.error && WORKING.has(result?.status || (createdId && !result ? 'queued' : bundle.logo?.status));
  useProcessingPoll(state, working);
  const variants = result?.variants || (bundle.logo?.generationId === generationId ? bundle.logo.variants : []) || [];
  const selected = result?.selectedVariantId || bundle.logo?.selectedVariantId;
  const changed = React.useRef(onChanged);
  changed.current = onChanged;
  React.useEffect(() => {
    if (result && ['done', 'ready', 'completed'].includes(result.status)) changed.current?.();
  }, [generationId, result?.status]);
  React.useEffect(() => { setCreatedId(''); setError(''); }, [bundle.id]);

  async function generate() {
    setBusy('generate');
    setError('');
    try {
      const data = await adminApi.generateLogos(bundle.title || bundle.name, bundle.id);
      setCreatedId(data.generationId);
    } catch (failure) {
      setError(failure.message);
    } finally { setBusy(''); }
  }

  async function select(variantId) {
    setBusy(variantId);
    setError('');
    try {
      await adminApi.selectLogo(generationId, variantId);
      state.reload();
      onChanged?.();
    } catch (failure) {
      setError(failure.message);
    } finally { setBusy(''); }
  }

  return (
    <section className="zx-logo-picker">
      <div className="zx-logo-picker-head">
        <div><h2>课程 Logo</h2><p>按资料标题生成三种风格，选择喜欢的一张作为课程图标。</p></div>
        <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={Boolean(busy) || working} onClick={generate}>
          {busy === 'generate' || working ? '生成中…' : generationId || bundle.logo?.svg ? '重新生成三种' : '生成三种 Logo'}
        </button>
      </div>
      {working ? <p className="zx-cell-sub" role="status">正在生成三种 Logo，原文预览和课程操作可继续使用。</p> : null}
      {error || state.error || result?.errorMessage ? <Notice kind="error">{error || state.error || result?.errorMessage}</Notice> : null}
      {state.error ? <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" onClick={state.reload}>重新读取 Logo</button> : null}
      {variants.length > 0 ? <div className="zx-logo-variants">
        {variants.map((variant, index) => (
          <button type="button" key={variant.id} className={`zx-logo-variant ${selected === variant.id ? 'selected' : ''}`} aria-pressed={selected === variant.id}
            disabled={Boolean(busy)} onClick={() => select(variant.id)}>
            <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(variant.svg)}`} width="76" height="76" alt={`${STYLES[variant.style] || variant.style || `风格 ${index + 1}`} Logo`} />
            <span>{STYLES[variant.style] || variant.style || `风格 ${index + 1}`}</span><small>{busy === variant.id ? '替换中…' : selected === variant.id ? '当前使用' : '使用此图'}</small>
          </button>
        ))}
      </div> : null}
    </section>
  );
}
