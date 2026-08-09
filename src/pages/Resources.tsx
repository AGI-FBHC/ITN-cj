/**
 * 个性化资源生成 `/resources`（resources.md）
 * S1 生成控制台（画像切换 / 目标知识点 / 重新生成 / 质量徽标）
 * S2 三形态 Tabs：定制讲义（流式生成）/ 实操指南（LOTO 门控）/ 分阶测试题（内联判分）
 * S3 溯源栏（讲义右侧 sticky；其余 Tab 抽屉）
 * 支持深链 ?tab=lecture|guide|quiz（知识库溯源链回跳）
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronDown, FileText, Link2, ListChecks, Loader2, PenLine, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { getResource } from '@/data/resources';
import { api } from '@/lib/api';
import type { ResourceForm } from '@/data/resources';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { getKBSlice } from '@/data/kbSlices';
import PageBack from '@/components/PageBack';
import PageTip from '@/components/heal/PageTip';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import LectureTab from '@/components/resources/LectureTab';
import GuideTab from '@/components/resources/GuideTab';
import QuizTab from '@/components/resources/QuizTab';
import TraceRail from '@/components/resources/TraceRail';
import { cn } from '@/lib/utils';

const tabs: { form: ResourceForm; label: string }[] = [
  { form: 'lecture', label: '定制讲义' },
  { form: 'guide', label: '实操指南' },
  { form: 'quiz', label: '分阶测试题' },
];

const formMeta: Record<ResourceForm, string> = {
  lecture: 'LECTURE · MARKDOWN',
  guide: 'GUIDE · CHECKLIST',
  quiz: 'QUIZ · TIERED',
};

export default function Resources() {
  const { currentLearner, learners, currentLearnerId, setCurrentLearnerId, viewMode } = useProfile();
  const isLearner = viewMode === 'learner';
  const dataId = dataIdOf(currentLearner);
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTab = searchParams.get('tab') as ResourceForm | null;
  /* 题目深链（错题本重练等场景跳转 /resources?tab=quiz&focus=q-03） */
  const focusQid = searchParams.get('focus') ?? undefined;
  const [tab, setTab] = useState<ResourceForm>(
    paramTab && tabs.some((t) => t.form === paramTab) ? paramTab : 'lecture',
  );
  const courseId = searchParams.get('courseId');
  const chapterId = searchParams.get('chapterId');
  const [realResources, setRealResources] = useState<Record<string, unknown>[]>([]);
  const [realLoading, setRealLoading] = useState(Boolean(courseId && chapterId));
  const [streamKey, setStreamKey] = useState(0);
  const [traceOpen, setTraceOpen] = useState(false);
  /* 讲义的溯源侧栏要 xl(≥1280) 才显示；窄屏时必须给一个替代入口，
     否则「可溯源」这个核心能力对用户等于不存在 */
  const railVisible = useMediaQuery('(min-width: 1280px)');

  /* 深链同步（知识库溯源链 → /resources?tab=guide 等） */
  useEffect(() => {
    if (paramTab && tabs.some((t) => t.form === paramTab) && paramTab !== tab) {
      setTab(paramTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramTab]);

  useEffect(() => {
    if (!courseId || !chapterId) return;
    let cancelled = false;
    setRealLoading(true);
    api.listLearningResources({ courseId, chapterId })
      .then((result) => {
        if (!cancelled) setRealResources(result.resources ?? []);
      })
      .catch(() => {
        if (!cancelled) setRealResources([]);
      })
      .finally(() => {
        if (!cancelled) setRealLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, chapterId]);

  const switchTab = (f: ResourceForm) => {
    setTab(f);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', f);
      return next;
    }, { replace: true });
  };

  const lecture = getResource(dataId, 'lecture');
  const guide = getResource(dataId, 'guide');
  const quiz = getResource(dataId, 'quiz');
  const active = getResource(dataId, tab);

  /* 质量徽标：跨 3 形态去重 KB 引用 */
  const totalTraces = useMemo(() => {
    const set = new Set<string>();
    [lecture, guide, quiz].forEach((r) => r?.kbRefs.forEach((id) => set.add(id)));
    return set.size;
  }, [lecture, guide, quiz]);

  /* 平均可信度：同一批去重引用对应的知识库切片可信度均值 */
  const avgCredibility = useMemo(() => {
    const set = new Set<string>();
    [lecture, guide, quiz].forEach((r) => r?.kbRefs.forEach((id) => set.add(id)));
    const creds = [...set].map((id) => getKBSlice(id)?.credibility).filter((c): c is number => typeof c === 'number');
    return creds.length ? Math.round((creds.reduce((a, b) => a + b, 0) / creds.length) * 100) : 0;
  }, [lecture, guide, quiz]);

  /** 目标知识点选项：按形态去重（选择即切换到对应形态 Tab） */
  const kpOptions = useMemo(() => {
    const seen = new Map<string, ResourceForm>();
    (['lecture', 'guide', 'quiz'] as ResourceForm[]).forEach((f) => {
      const r = getResource(dataId, f);
      if (r && !seen.has(r.kpId)) seen.set(r.kpId, f);
    });
    return [...seen.entries()].map(([kpId, form]) => ({
      kp: getKnowledgePoint(kpId),
      form,
    }));
  }, [currentLearner.id]);

  const regenerate = () => {
    setStreamKey((k) => k + 1);
    toast.success('已为你重新生成', {
      description: isLearner
        ? '按你最新的学习情况重写了一份，出处都已核对'
        : `基于 ${currentLearner.name} 的最新画像向量约束生成 · VER-04 复核通过`,
    });
  };

  const switchLearner = (id: string) => {
    if (id === currentLearnerId) return;
    setCurrentLearnerId(id);
    const l = learners.find((x) => x.id === id);
    toast.success(`已切换为 ${l?.name}`, { description: '三种形态资源已按新画像重新生成' });
  };

  const quizCount = quiz?.quizIds?.length ?? 0;

  if (courseId && chapterId) {
    const meta = {
      lecture: { label: '定制讲义', Icon: FileText }, practice: { label: '实操指南', Icon: ListChecks }, quiz: { label: '分阶测试题', Icon: PenLine },
    } as const;
    return (
      <div className="mx-auto max-w-[980px] px-5 pb-24 pt-8 md:px-6">
        <PageBack parent={{ label: '我的课程', to: '/learn' }} current="章节资源" />
        <h1 className="mt-2 font-serif text-[26px] font-semibold text-ink">章节资源</h1>
        <p className="mt-1 text-[13.5px] text-ink-muted">当前章节由目标驱动生成，资源按章节独立生成。</p>

        {realLoading && (
          <div className="mt-6 flex items-center justify-center gap-2 rounded-[14px] border border-hairline bg-card-warm py-12 text-[13.5px] text-ink-muted">
            <Loader2 size={16} className="animate-spin" />
            正在读取章节资源…
          </div>
        )}

        {!realLoading && realResources.length === 0 && (
          <div className="mt-6 rounded-[14px] border border-hairline bg-card-warm px-6 py-10 text-center text-[13.5px] text-ink-muted">
            该章节正文资源尚未生成，后续会在这里按章节生成讲义、实操和分阶题。
          </div>
        )}

        <div className="mt-6 space-y-3">
          {realResources.map((resource) => {
            const type = String(resource.type ?? '');
            const Icon = meta[type as keyof typeof meta]?.Icon ?? FileText;
            return (
              <motion.div
                key={String(resource.id)}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-3 rounded-[14px] border border-hairline bg-card-warm p-5"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-brand-tint text-brand">
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-ink">{String(resource.title ?? '未命名资源')}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-ink-muted">{String(resource.type ?? '')}</span>
                </span>
              </motion.div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={`mx-auto ${isLearner ? 'max-w-[960px] px-5 md:px-6' : 'max-w-[1320px] px-8'} py-10`}>
      {/* ---------- S1 页头 ---------- */}
      <PageBack parent={{ label: '学', to: '/learn' }} current="AI 给我做的资料" />

      {isLearner && (
        <PageTip id="resources" className="mb-4">
          这些资料是 AI 按你的水平现做的。每句话后面的 <span className="font-mono text-brand">[KB-xxx]</span> 都能
          <span className="font-medium text-ink">点开看出处</span>——不放心的地方可以自己核对。
        </PageTip>
      )}

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="lf-mono-label flex items-center gap-2">
          <span className="inline-block h-px w-6 bg-brand/40" />
          {isLearner ? '我的学习资源 · 学' : 'CONSTRAINED GENERATION'}
        </div>
        <h1 className="mt-2 font-serif text-[36px] font-bold leading-[44px] text-ink">
          {isLearner ? '为你定制的学习资源' : '个性化资源生成'}
        </h1>
        <p className="mt-2 max-w-[720px] text-[14.5px] leading-[24px] text-ink-muted">
          {isLearner ? (
            <>
              这些讲义、实操指南和分阶题，都是 AI 按你当前的水平现生成的。每个知识点旁都标了出处，可以点开核对；
              想学别的知识点、或换一份，用下面的控制台随时调整。
            </>
          ) : (
            <>
              所有资源由内容生成 Agent 基于知识库切片约束生成，经审核裁判交叉验证，逐条可溯源。
              切换全局画像，三种形态内容将随之改变 —— 这就是「个性化」的直接证据。
            </>
          )}
        </p>
      </motion.div>

      {/* ---------- S1 生成控制台 ---------- */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
        className="lf-card mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 p-4"
      >
        {/* 当前画像（学习者视角隐藏，顶栏已有切换） */}
        {!isLearner && (
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:border-brand/40 hover:text-brand">
            <Avatar className="h-6 w-6 border border-hairline">
              <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
              <AvatarFallback className="bg-brand-tint text-[10px] text-brand">
                {currentLearner.name.slice(0, 1)}
              </AvatarFallback>
            </Avatar>
            当前画像：{currentLearner.name}
            <ChevronDown size={13} className="text-ink-muted" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[220px] border-hairline bg-card-warm">
            <DropdownMenuLabel className="lf-mono-label !text-[10px]">切换学习者画像</DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-hairline" />
            {learners.map((l) => (
              <DropdownMenuItem
                key={l.id}
                onClick={() => switchLearner(l.id)}
                className="flex items-center gap-2.5 py-2"
              >
                <Avatar className="h-7 w-7 border border-hairline">
                  <AvatarImage src={l.avatar} alt={l.name} />
                  <AvatarFallback className="bg-brand-tint text-[10px] text-brand">
                    {l.name.slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1">
                  <span className="block text-[13px] font-medium text-ink">{l.name}</span>
                  <span className="block text-[11px] text-ink-muted">{l.tag}</span>
                </span>
                {l.id === currentLearnerId && <Check size={14} className="text-brand" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        )}

        {/* 目标知识点 */}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:border-brand/40 hover:text-brand">
            目标知识点：{active ? getKnowledgePoint(active.kpId).name : '—'}
            <ChevronDown size={13} className="text-ink-muted" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[240px] border-hairline bg-card-warm">
            <DropdownMenuLabel className="lf-mono-label !text-[10px]">
              {isLearner ? "AI 建议你优先学的" : "DIA-01 按画像锁定的优先知识点"}
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-hairline" />
            {kpOptions.map(({ kp, form }) => (
              <DropdownMenuItem key={kp.id} onClick={() => switchTab(form)} className="py-2">
                <span className="flex-1">
                  <span className="block text-[13px] font-medium text-ink">{kp.name}</span>
                  <span className="block font-mono text-[10px] text-ink-muted">
                    {formMeta[form]}
                  </span>
                </span>
                {active?.kpId === kp.id && <Check size={14} className="text-brand" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="hidden items-center gap-2 font-mono text-[12px] text-ink-muted md:inline-flex">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-amber" />
          生成时间 {active?.updatedAt.slice(5) ?? '—'}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* 质量徽标组 */}
          {(isLearner
            ? [{ icon: ShieldCheck, text: '已核验 · 可溯源', tone: 'border-brand/30 bg-brand-tint text-brand' }]
            : [
                { icon: Link2, text: `${totalTraces} 处溯源 · 平均可信度 ${avgCredibility}%`, tone: 'border-brand/30 bg-brand-tint text-brand' },
                { icon: Sparkles, text: '幻觉风险 0', tone: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
                { icon: ShieldCheck, text: 'VER 复核通过 ✓', tone: 'border-brand/30 bg-brand-tint text-brand' },
              ]
          ).map((b, i) => (
            <motion.span
              key={b.text}
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.25 + 0.1 * i, type: 'spring', stiffness: 300, damping: 18 }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium',
                b.tone,
              )}
            >
              <b.icon size={13} /> {b.text}
            </motion.span>
          ))}
          <button type="button" onClick={regenerate} className="lf-btn-primary !px-4 !py-2 text-[13.5px]">
            <RotateCcw size={14} /> 重新生成
          </button>
        </div>
      </motion.div>

      {/* ---------- S2 Tabs ---------- */}
      <div className="mt-8 flex flex-wrap items-end justify-between gap-3 border-b border-hairline">
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.form}
              type="button"
              onClick={() => switchTab(t.form)}
              className={cn(
                'relative px-4 pb-3 pt-2 text-[15px] font-medium transition-colors duration-200',
                tab === t.form ? 'text-brand' : 'text-ink-muted hover:text-ink',
              )}
            >
              {t.label}
              {tab === t.form && (
                <motion.span
                  layoutId="resources-tab-underline"
                  className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-brand"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 pb-2.5 font-mono text-[11.5px] text-ink-muted">
          <span>
            {tab === 'lecture' && `讲义 · ${lecture?.levelTag} · ${lecture?.version}`}
            {tab === 'guide' && `实操 · 5 步 · 预计 35 分钟`}
            {tab === 'quiz' && `分阶题 · ${quizCount} 题 · 基础${quiz?.quizSummary?.basic}/进阶${quiz?.quizSummary?.advanced}/挑战${quiz?.quizSummary?.challenge}`}
          </span>
          {/* 讲义 Tab 在宽屏有常驻溯源侧栏，此时不必重复；其余情况（含窄屏的讲义）都给按钮 */}
          {(tab !== 'lecture' || !railVisible) && (
            <button
              type="button"
              onClick={() => setTraceOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border border-brand/30 bg-brand-tint px-2 py-1 text-[11px] font-medium text-brand transition-colors hover:bg-brand hover:text-paper"
            >
              <Link2 size={11} /> 看这份资料的出处
            </button>
          )}
        </div>
      </div>

      {/* ---------- Tab 内容（交叉淡入） ---------- */}
      <div className="mt-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${currentLearner.id}-${tab}`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {tab === 'lecture' && lecture && (
              <LectureTab
                key={`${currentLearner.id}-${streamKey}`}
                resource={lecture}
                learner={currentLearner}
                onGotoGuide={guide ? () => switchTab('guide') : undefined}
              />
            )}
            {tab === 'guide' && guide && (
              <GuideTab
                key={currentLearner.id}
                resource={guide}
                learner={currentLearner}
                onGotoQuiz={() => switchTab('quiz')}
              />
            )}
            {tab === 'quiz' && quiz && (
              <QuizTab key={currentLearner.id} resource={quiz} focusQid={focusQid} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ---------- 溯源抽屉（实操/分阶题 Tab） ---------- */}
      <Sheet open={traceOpen} onOpenChange={setTraceOpen}>
        <SheetContent
          side="right"
          className="w-[380px] max-w-[92vw] overflow-y-auto border-l border-hairline bg-paper p-5 sm:max-w-[380px]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>本资源溯源</SheetTitle>
            <SheetDescription>当前资源的全部 KB 引用</SheetDescription>
          </SheetHeader>
          {active && <TraceRail entries={active.kbRefs.map((kbId) => ({ kbId }))} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
