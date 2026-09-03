/**
 * LectureTab — 领学讲义（resources.md TAB 1）
 * 流式生成动画（16ms tick 逐段物化 + 光标闪烁 + 跳过）· scroll-spy 目录 ·
 * 脚注引用区（定位回链）· 右侧溯源栏
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCitationMarks from '@/lib/remarkCitationMarks';
import { BadgeCheck, FastForward, ListTree, Printer, Download, CornerDownLeft, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import TraceBadge from '@/components/TraceBadge';
import type { GeneratedResource } from '@/data/resources';
import type { Learner } from '@/data/learners';
import { getKBSlice } from '@/data/kbSlices';
import { useAgent } from '@/context/AgentContext';
import TraceRail from './TraceRail';
import { extractToc, kbFirstSection, lectureMdComponents } from './lecture-markdown';
import { cn } from '@/lib/utils';

/** 学习目标看板（page-local，按画像差异化） */
const objectives: Record<string, string[]> = {
  lin: [
    '区分 LLM 与 Agent 的能力边界与职责',
    '复述智能体工具调用的标准步骤与判据',
    '解释上下文工程中提示与检索的适用边界',
  ],
  chen: [
    '说清 RAG 应用中检索、重排与生成的职责划分',
    '按步骤清单独立完成一次 Agent 工具调用',
    '用状态机类比解释多智能体协作的编排逻辑',
  ],
  zhao: [
    '把运维排障经验迁移到 Agent 异常链路诊断',
    '说清上下文溢出与检索失败的关键定位点',
    '规划一个可观测、可回滚的 Agent 部署方案',
  ],
};

function cjkCount(text: string) {
  return (text.match(/[一-龥]/g) ?? []).length;
}

export default function LectureTab({
  resource,
  learner,
  onGotoGuide,
}: {
  resource: GeneratedResource;
  learner: Learner;
  /** 读完后的下一步建议（有实操指南时才提供，闭合"学完去练"的动线） */
  onGotoGuide?: () => void;
}) {
  const full = resource.markdown ?? '';
  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  /* 组件由外层 key（画像 + streamKey）驱动重挂载，故流式状态只需挂载时初始化 */
  const [shown, setShown] = useState(() => (reduced ? full.length : 0));
  const [done, setDone] = useState(reduced);
  const [printView, setPrintView] = useState(false);
  const docRef = useRef<HTMLDivElement>(null);

  /* ---------- 伴学助手：读完信号（脚注区进入视口视为读完，一次性） ---------- */
  const { pushSignal } = useAgent();
  const [read, setRead] = useState(false);
  const footerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!done || read || !footerRef.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) {
          setRead(true);
          pushSignal({ type: 'lecture-read', kpId: resource.kpId, title: resource.title });
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(footerRef.current);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, read]);

  /* ---------- 流式生成引擎：16ms tick，每 tick 4 字符 ---------- */
  useEffect(() => {
    if (reduced || !full) return;
    const timer = setInterval(() => {
      setShown((s) => {
        const next = s + 4;
        if (next >= full.length) {
          clearInterval(timer);
          setDone(true);
          return full.length;
        }
        return next;
      });
    }, 16);
    return () => clearInterval(timer);
  }, [full, reduced]);

  const skip = () => {
    setShown(full.length);
    setDone(true);
  };

  /* ---------- 目录 + scroll-spy ---------- */
  const toc = useMemo(() => extractToc(full), [full]);
  const [active, setActive] = useState<string>(toc[0]?.id ?? '');
  useEffect(() => {
    if (!done) return;
    const els = toc
      .map((t) => document.getElementById(t.id))
      .filter((el): el is HTMLElement => Boolean(el));
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) setActive(en.target.id);
        });
      },
      { rootMargin: '-90px 0px -68% 0px', threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [done, toc]);

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /** 脚注定位：滚动到首次引用章节并闪烁高亮（WAAPI，无全局 CSS） */
  const flashSection = (id: string | null) => {
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.animate(
      [
        { backgroundColor: 'rgba(231, 180, 90,0.28)', boxShadow: '0 0 0 6px rgba(231, 180, 90,0.18)' },
        { backgroundColor: 'transparent', boxShadow: '0 0 0 0 transparent' },
      ],
      { duration: 1500, easing: 'ease-out' },
    );
  };

  const words = cjkCount(full);
  const minutes = Math.max(4, Math.ceil(words / 60));
  const kbRefs = resource.kbRefs;

  return (
    <div className="grid grid-cols-12 gap-6">
      {/* ---------- 左：sticky 目录 ---------- */}
      {!printView && (
        <aside className="col-span-3 hidden self-start lg:sticky lg:top-24 lg:block">
          <div className="lf-card p-4">
            <div className="lf-mono-label flex items-center gap-1.5">
              <ListTree size={12} /> CONTENTS · 目录
            </div>
            <ul className="mt-3 space-y-1">
              {toc.map((t, i) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => scrollToSection(t.id)}
                    className={cn(
                      'relative w-full rounded-lg px-3 py-2 text-left text-[13px] leading-[19px] transition-all duration-200 ease-lf',
                      active === t.id
                        ? 'bg-brand-tint font-medium text-brand'
                        : 'text-ink-2 hover:bg-paper-deep',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute left-0 top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-r-full bg-brand transition-opacity',
                        active === t.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="mr-1.5 font-mono text-[10.5px] text-ink-muted">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    {t.label}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-hairline pt-3 font-mono text-[10.5px] leading-[17px] text-ink-muted">
              约 {words.toLocaleString()} 字 · 预计 {minutes} 分钟
            </div>
          </div>
        </aside>
      )}

      {/* ---------- 中：文档 ---------- */}
      <div
        className={cn(
          'col-span-12',
          /* 目录在 lg 出现(占3)、溯源栏要到 xl 才出现(占3)。
             正文若一直是 6，则 lg~xl 之间只用掉 9 列、右侧空 3 列，正文被压成窄条。
             故 lg 区间给 9，xl 起再让位到 6。 */
          printView ? 'lg:col-span-12' : 'lg:col-span-9 xl:col-span-6',
        )}
      >
        <div ref={docRef} className="relative overflow-hidden rounded-[14px] border border-hairline bg-card-warm">
          <div className="h-1 w-full bg-brand" />
          {/* 文档头 */}
          <div className="border-b border-hairline px-7 pb-5 pt-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                                <h3 className="font-serif text-[24px] font-bold leading-[32px] text-ink">
                  {resource.title}
                </h3>
                {/* 溯源密度徽标：讲义顶部即亮出「零幻觉」证据 */}
                <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-brand/25 bg-brand-tint/50 px-2 py-0.5 font-mono text-[10.5px] text-brand">
                  <ShieldCheck size={11} />
                  {kbRefs.length} 处引用 · 每 {Math.round(words / Math.max(1, kbRefs.length))} 字一处溯源
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] text-ink-muted">
                  <span>
                    适配画像：{learner.name} · {learner.tag}
                  </span>
                  <span className="text-hairline">|</span>
                  <span>难度 {resource.levelTag}</span>
                  <span className="text-hairline">|</span>
                  <span>约 {words.toLocaleString()} 字 · 预计 {minutes} 分钟</span>
                  <span className="text-hairline">|</span>
                  <span>
                    版本 {resource.version} · {resource.updatedAt.slice(11)} 生成
                  </span>
                </div>
              </div>
              <AnimatePresence>
                {done && (
                  <motion.span
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-brand/30 bg-brand-tint px-2.5 py-1 text-[12px] font-medium text-brand"
                  >
                    <BadgeCheck size={13} /> 排版完成 ✓
                  </motion.span>
                )}
              </AnimatePresence>
            </div>

            {/* 学习目标看板 */}
            <div className="mt-4 rounded-[10px] border border-brand-amber/40 bg-brand-amber-tint px-4 py-3">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ochre">
                OBJECTIVES · 学完本讲，你将能够
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[13.5px] font-medium text-ink-2">
                {(objectives[learner.id] ?? objectives.lin).map((o, i) => (
                  <span key={o}>
                    <span className="mr-1 font-mono text-[12px] text-ochre">{['①', '②', '③'][i]}</span>
                    {o}
                  </span>
                ))}
              </div>
            </div>

            {/* 文档操作 */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {!done && (
                <button
                  type="button"
                  onClick={skip}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-brand-amber/50 bg-brand-amber-tint px-3 py-1.5 text-[12.5px] font-medium text-ochre transition-colors hover:bg-brand-amber/20"
                >
                  <FastForward size={13} /> 跳过动画
                </button>
              )}
              <button
                type="button"
                onClick={() => toast.info('演示环境 · 已生成模拟导出', { description: `${resource.title}.pdf（含 ${kbRefs.length} 条溯源脚注）` })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-brand/40 hover:text-brand"
              >
                <Download size={13} /> 导出 PDF
              </button>
              <button
                type="button"
                onClick={() => setPrintView((v) => !v)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                  printView
                    ? 'border-brand bg-brand-tint text-brand'
                    : 'border-hairline bg-paper text-ink-2 hover:border-brand/40 hover:text-brand',
                )}
              >
                <Printer size={13} /> {printView ? '退出打印视图' : '打印视图'}
              </button>
              {!done && (
                <span className="ml-auto flex items-center gap-2 font-mono text-[11px] text-brand">
                  <span className="h-1.5 w-1.5 animate-ping rounded-full bg-brand-amber" />
                  AI 正在写… {Math.round((shown / Math.max(1, full.length)) * 100)}%
                </span>
              )}
            </div>
          </div>

          {/* 正文（流式） */}
          <div className="px-7 py-6">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={lectureMdComponents}>
              {full.slice(0, shown)}
            </ReactMarkdown>
            {!done && (
              <span className="animate-caret-blink font-mono text-[15px] text-brand">▍</span>
            )}

            {/* 脚注：引用来源 */}
            {done && (
              <motion.footer
                ref={footerRef}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="mt-10 border-t-2 border-brand/20 pt-5"
              >
                <div className="lf-mono-label">REFERENCES · 引用来源</div>
                <ol className="mt-3 space-y-2.5">
                  {kbRefs.map((id, i) => {
                    const slice = getKBSlice(id);
                    if (!slice) return null;
                    const secId = kbFirstSection(full, id);
                    const secLabel = secId
                      ? `§${toc.findIndex((t) => t.id === secId) + 1}`
                      : null;
                    return (
                      <li
                        key={id}
                        className="flex items-start gap-3 rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5"
                      >
                        <span className="mt-0.5 font-mono text-[11px] text-ink-muted">
                          [{i + 1}]
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13.5px] font-medium text-ink">{slice.title}</span>
                            <TraceBadge kbId={id} rich />
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-muted">
                            <span>{slice.standardNo ?? slice.source}</span>
                            <span>可信度 {(slice.credibility * 100).toFixed(0)}</span>
                          </div>
                        </div>
                        {secLabel && (
                          <button
                            type="button"
                            onClick={() => flashSection(secId)}
                            className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-hairline bg-card-warm px-2 py-1 font-mono text-[10.5px] text-brand transition-colors hover:border-brand/50 hover:bg-brand-tint"
                            title="定位到正文引用处"
                          >
                            <CornerDownLeft size={11} /> {secLabel}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-3 font-mono text-[10.5px] text-ink-muted">
                  正文角标与脚注一一对应 · 点击角标查看切片详情，点击 § 定位回正文引用处
                </p>
              </motion.footer>
            )}

            {/* 伴学助手轻存在：读完记录 + 下一步 */}
            <AnimatePresence>
              {read && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4 flex flex-wrap items-center gap-2.5"
                >
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand-tint/60 px-3 py-1.5 text-[12px] font-medium text-brand">
                    <BadgeCheck size={13} />
                    伴学助手已记录：本讲义读完 · 画像已微调
                  </span>
                  {onGotoGuide && (
                    <button
                      type="button"
                      onClick={onGotoGuide}
                      className="inline-flex items-center gap-1 rounded-full border border-hairline bg-paper px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:border-brand/40 hover:text-brand"
                    >
                      下一步：去看实操指南
                      <CornerDownLeft size={11} className="rotate-180" />
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* ---------- 右：溯源栏 ---------- */}
      {!printView && (
        <aside className="col-span-3 hidden self-start xl:sticky xl:top-24 xl:block">
          <TraceRail
            entries={kbRefs.map((id) => {
              const secId = kbFirstSection(full, id);
              return {
                kbId: id,
                section: secId ? `§${toc.findIndex((t) => t.id === secId) + 1}` : null,
              };
            })}
          />
        </aside>
      )}
    </div>
  );
}
