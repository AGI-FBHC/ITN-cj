/**
 * KpDetailPanel — 知识点详情侧栏（图谱选中即见进度 + 资源 + 跳转）
 * 选中任一知识点后：掌握度环（对目标差）、AI 把握、路径位置、
 * 管理员母版资源形态（讲义/实操/分阶题/课件），存在则打开，不存在则显示暂无资源。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, BookOpen, Wrench, ListChecks, Sparkles, Route, Loader2, Wand2 } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import type { PresentationTask, PresentationTaskSummary } from '@/lib/presentationApi';
import { reportForLearner } from '@/data/reportBuilder';
import type { PathNodeStatus } from '@/data/reportData';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import type { GeneratedResource } from '@/data/resources';
import type { ResourceForm } from '@/data/resources';
import { Succulent, LeafSmall } from '@/components/heal/Flora';
import type { PathNode } from '@/data/reportData';
import type { GraphNode } from '@/data/knowledgeGraph';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { LearningResourceGenerationTask } from '@/lib/api';
import CustomizeChoiceModal from '@/components/learn/CustomizeChoiceModal';

const FORM_META: Record<ResourceForm, { label: string; icon: typeof BookOpen; hint: string }> = {
  lecture: { label: '领学讲义', icon: BookOpen, hint: '按你水平现写的讲义' },
  guide: { label: '实操指南', icon: Wrench, hint: '分步实操 + 开始前确认' },
  quiz: { label: '分阶测试题', icon: ListChecks, hint: '基础/进阶/挑战三阶' },
};

type GeneratedResourceLink = { id: string; title: string };
type PptResourceLink = GeneratedResourceLink & { status: PresentationTask['status'] };

const PATH_STATUS: Record<PathNodeStatus, { label: string; cls: string }> = {
  done: { label: '已完成', cls: 'border-brand/30 bg-brand-tint text-brand' },
  active: { label: '进行中 · 本周', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  todo: { label: '待学', cls: 'border-hairline bg-paper-deep text-ink-2' },
  locked: { label: '未解锁', cls: 'border-hairline bg-paper-deep text-ink-muted' },
};

/** 当前知识点整体掌握度：按完整内容范围展示，不再混入目标刻度。 */
function MasteryRing({ score }: { score: number }) {
  const R = 30;
  const C = 2 * Math.PI * R;
  const color = '#155E9A';
  return (
    <svg viewBox="0 0 80 80" className="h-[80px] w-[80px] shrink-0">
      <circle cx="40" cy="40" r={R} fill="none" stroke="#ECF1EA" strokeWidth="7" />
      <circle
        cx="40"
        cy="40"
        r={R}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - score / 100)}
        transform="rotate(-90 40 40)"
        style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.22,1,0.36,1)' }}
      />
      <text x="40" y="44" textAnchor="middle" className="font-display" fontSize="17" fontWeight="700" fill="#155E9A">
        {score}
      </text>
    </svg>
  );
}

export default function KpDetailPanel({ kpId, topicIndex, onSelectTopic, kp: kpProp, mastery: masteryProp, topicMastery, topicProgress, graphNodes, path: pathProp, resources: resourcesProp, presentations: presentationsProp, knowledgeMap }: {
  kpId: string | null;
  topicIndex?: number | null;
  onSelectTopic?: (topicIndex: number) => void;
  kp?: KnowledgePoint | null;
  mastery?: Record<string, number>;
  topicMastery?: Record<string, number>;
  topicProgress?: Record<string, number>;
  graphNodes?: GraphNode[];
  path?: PathNode[];
  resources?: Array<GeneratedResource & { id?: string; learned?: boolean; started?: boolean; progressRatio?: number; masteryRatio?: number }>;
  presentations?: PresentationTaskSummary[];
  knowledgeMap?: {
    chapters: Array<{ id: string; name: string; topics: string[] }>;
    edges: Array<{ from: string; to: string; kind: string }>;
  };
}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const report = reportForLearner(currentLearner);
  const [customizeTasks, setCustomizeTasks] = useState<LearningResourceGenerationTask[]>([]);
  const [customizeChoice, setCustomizeChoice] = useState<{
    adminResourceId: string; kpId: string; resourceType: 'lecture' | 'practice' | 'quiz' | 'ppt'; resourceLabel: string;
  } | null>(null);

  /* 拉取本知识点的定制任务，进行中时轮询刷新 */
  useEffect(() => {
    if (!kpId) return;
    let alive = true;
    const load = async () => {
      try {
        const listed = await api.listCustomizeTasks();
        if (alive) setCustomizeTasks(listed.tasks ?? []);
      } catch { /* 定制任务查询失败时保持现有状态 */ }
    };
    void load();
    const busy = (listed_tasks: LearningResourceGenerationTask[]) => listed_tasks.some((t) => !['completed', 'failed', 'cancelled'].includes(t.status));
    const timer = window.setInterval(() => { void load(); }, 2500);
    if (!busy(customizeTasks)) { /* 静止时降低频率由 busy 逻辑控制 */ }
    return () => { alive = false; window.clearInterval(timer); };
  }, [kpId]);

  if (!kpId) {
    /* 未选中章节：优先展示最近学习但未学完的资源，其次给继续学习建议。
       只展示当前知识网络真实章节下的资源（kpId 对齐地图章节），旧知识库记录不再出现。 */
    const allResources = resourcesProp ?? [];
    const realChapters = knowledgeMap?.chapters ?? [];
    const realChapterIds = new Set(realChapters.map((chapter) => chapter.id));
    const recentUnfinished = [...allResources]
      .filter((item) => item.id && !item.learned && realChapterIds.has(item.kpId ?? ''))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 6);
    return (
      <div className="lf-glass relative flex h-full min-h-[280px] flex-col gap-4 rounded-[18px] p-5">
        <Succulent className="pointer-events-none absolute -top-5 right-5 h-[52px] w-[44px]" />
        <div>
          <h3 className="font-serif text-[18px] font-semibold text-ink">最近学习</h3>
          <p className="mt-1 text-[12.5px] leading-[19px] text-ink-muted">优先继续最近没有学完的内容；点左侧章节可查看或生成该章资源。</p>
        </div>
        {recentUnfinished.length ? (
          <div className="space-y-2">
            {recentUnfinished.map((item) => {
              const meta = FORM_META[item.form] ?? { label: '学习资源', icon: BookOpen };
              const Icon = meta.icon;
              const topicName = item.levelTag || item.title.replace(/\s*·\s*(定制讲义|领学讲义|实操指南|分阶测试题)$/, '');
              const chapterName = item.kpId ? realChapters.find((chapter) => chapter.id === item.kpId)?.name : undefined;
              return (
                <button key={item.id} type="button" onClick={() => navigate(`/learn/resource/${item.id}`)} className="group flex w-full items-center gap-3 rounded-[10px] border border-hairline bg-paper px-3 py-2.5 text-left transition-all hover:border-brand/45 hover:bg-brand-tint/40">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand"><Icon size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-ink">{topicName}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-ink-muted">{chapterName ? `${chapterName} · ` : ''}{meta.label}</span>
                  </span>
                  <ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center rounded-[12px] border border-dashed border-brand/35 bg-paper px-4 py-8 text-center">
            <Route size={18} className="text-brand" />
            <p className="mt-2 text-[13px] font-medium text-ink">还没有已生成的内容</p>
            <p className="mt-1 text-[11.5px] leading-5 text-ink-muted">管理员尚未为该知识点生成资源，请联系管理员。</p>
          </div>
        )}
        <div className="mt-auto border-t border-hairline/70 pt-3">
          <p className="font-mono text-[9.5px] tracking-wide text-ink-muted">NEXT · 从知识网络继续</p>
          <p className="mt-1 text-[11.5px] leading-5 text-ink-muted">页面下方的“章节速览”可直接聚焦任意章节。</p>
        </div>
      </div>
    );
  }

  const kp = kpProp ?? getKnowledgePoint(kpId);
  const selectedTopicName = topicIndex != null ? kp.coreTopics[topicIndex] : null;
  const selectedTopicNode = topicIndex != null ? graphNodes?.find((node) => node.kind === 'topic' && node.kpId === kpId && node.topicIndex === topicIndex) : null;
  const customizationKpId = selectedTopicNode?.id ?? kpId;
  const childScores = (graphNodes ?? []).filter((node) => node.kind === 'topic' && node.kpId === kpId).map((node) => topicMastery?.[node.id] ?? 0);
  const score = selectedTopicNode ? (topicMastery?.[selectedTopicNode.id] ?? 0) : childScores.length ? Math.round(childScores.reduce((sum, value) => sum + value, 0) / childScores.length) : ((masteryProp ?? {})[kpId] ?? 0);
  const learningProgress = selectedTopicNode ? (topicProgress?.[selectedTopicNode.id] ?? 0) : (() => {
    const values = (graphNodes ?? []).filter((node) => node.kind === 'topic' && node.kpId === kpId).map((node) => topicProgress?.[node.id] ?? 0);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  })();
  const res: Array<GeneratedResource & { id?: string; learned?: boolean; started?: boolean; progressRatio?: number; masteryRatio?: number }> = resourcesProp ?? [];
  const learningStatusOf = (item?: (typeof res)[number] | null) => {
    if (item?.learned) return { label: '已学完', cls: 'text-brand' };
    if (item?.started || (item?.progressRatio ?? 0) > 0) return { label: '未学完', cls: 'text-ochre' };
    return { label: '未学习', cls: 'text-ink-muted' };
  };
  const reportPath = pathProp ?? report.path;
  const templatePpt = (presentationsProp ?? [])
    .filter((item) => item.status === 'completed')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .find((item) => {
      const topicName = String(item.request?.generationContext?.topicName ?? '');
      const templateKpId = String(item.request?.generationContext?.kpId ?? '');
      return templateKpId === kpId && (!selectedTopicName || topicName === selectedTopicName || item.title.includes(selectedTopicName));
    });
  const pptForScope: PptResourceLink | undefined = templatePpt
    ? { id: templatePpt.id, title: templatePpt.title, status: templatePpt.status }
    : undefined;
  const existingResourceFor = (form: ResourceForm) => res.find((item) => item.form === form && item.id);
  const openPptCourseware = async () => {
    const selectedTopicName = topicIndex != null ? kp.coreTopics[topicIndex] : null;
    const focus = selectedTopicName ?? kpProp?.coreTopics[0] ?? kp.name;
    if (pptForScope?.status === 'completed') {
      navigate(`/learn/${kpId}?ppt=${pptForScope.id}&topic=${encodeURIComponent(focus)}`);
      return;
    }
    toast.info('该资源暂未提供', { description: '管理员尚未设置该知识点的课件母版。' });
  };
  const pathNodes = reportPath.filter((n) => n.kpId === kpId);
  const primaryStatus = pathNodes.find((n) => n.status === 'active')?.status
    ?? pathNodes.find((n) => n.status === 'todo')?.status
    ?? pathNodes[0]?.status
    ?? null;
  /* ===== 用户定制（基于管理员母版二次创作） ===== */
  const CUSTOMIZE_FORM_TYPE: Record<ResourceForm, 'lecture' | 'practice' | 'quiz'> = { lecture: 'lecture', guide: 'practice', quiz: 'quiz' };
  const customizeTaskFor = (form: ResourceForm): LearningResourceGenerationTask | undefined => {
    const templateId = existingResourceFor(form)?.id;
    return customizeTasks.find((task) =>
      task.resourceType === CUSTOMIZE_FORM_TYPE[form] && task.request?.adminResourceId === templateId,
    );
  };
  const pptCustomizeTask = customizeTasks.find((task) =>
    task.resourceType === 'ppt' && task.request?.adminResourceId === pptForScope?.id,
  );
  const pptBusy = Boolean(pptCustomizeTask && !['completed', 'failed', 'cancelled'].includes(pptCustomizeTask.status));
  const pptCustomized = Boolean(pptCustomizeTask?.status === 'completed' && pptCustomizeTask.resourceId);
  const taskBusy = (task?: LearningResourceGenerationTask) =>
    Boolean(task && !['completed', 'failed', 'cancelled'].includes(task.status));

  const customizableForms = (Object.keys(FORM_META) as ResourceForm[]).filter((f) => {
    const hasTemplate = Boolean(existingResourceFor(f)?.id);
    const task = customizeTaskFor(f);
    const copied = task?.status === 'completed' && task.resourceId;
    return hasTemplate && !copied;
  });
  const pptCustomizable = Boolean(pptForScope?.id) && !pptBusy && !pptCustomized;
  const allBusy = customizableForms.every((f) => taskBusy(customizeTaskFor(f)));

  const customizeAll = async () => {
    if (!customizableForms.length && !pptCustomizable) { toast.info('所有资源均已定制'); return; }
    if (allBusy && (pptBusy || !pptCustomizable)) { toast.info('资源正在定制中'); return; }
    let firstTaskId: string | null = null;
    for (const form of customizableForms) {
      if (taskBusy(customizeTaskFor(form))) continue;
      const template = existingResourceFor(form);
      if (!template?.id) continue;
      try {
        const task = await api.createCustomizeTask({
          adminResourceId: template.id,
          kpId: customizationKpId,
          resourceType: CUSTOMIZE_FORM_TYPE[form],
        });
        firstTaskId ??= task.id;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '发起定制失败');
      }
    }
    if (pptCustomizable && pptForScope?.id) {
      try {
        const task = await api.createCustomizeTask({ adminResourceId: pptForScope.id, kpId: customizationKpId, resourceType: 'ppt' });
        firstTaskId ??= task.id;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '发起定制失败');
      }
    }
    if (firstTaskId) navigate(`/learn/customize/${firstTaskId}`);
  };

  /* 四个推荐：优先展示最近已学内容（我的已学路径），不足用未学完资源补位，最后用子知识点生成推荐补满。 */
  const learnedResources = [...res]
    .filter((item) => item.id && item.learned)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const unfinishedResources = [...res]
    .filter((item) => item.id && !item.learned)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 4);
  const shownLearned = learnedResources.slice(0, 4);
  const shownUnfinished = unfinishedResources.slice(0, Math.max(0, 4 - shownLearned.length));
  const recommendationCount = Math.max(0, 4 - shownLearned.length - shownUnfinished.length);
  const topicRecommendations = Array.from({ length: recommendationCount }, (_, index) => {
    const childIndex = index % Math.max(1, kp.coreTopics.length);
    const forms = Object.keys(FORM_META) as ResourceForm[];
    return { childIndex, topic: kp.coreTopics[childIndex] ?? kp.name, form: forms[index % forms.length] };
  });

  return (
    <div className="lf-glass relative flex flex-col gap-4 rounded-[18px] p-5">
      {/* 破框小叶 */}
      <LeafSmall className="pointer-events-none absolute -top-3.5 left-5 h-[28px] w-[42px]" />
      {/* 标题 */}
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-serif text-[18px] font-semibold text-ink">{selectedTopicName || kp.name}</h3>
            <div className="mt-0.5 font-mono text-[9.5px] tracking-wide text-ink-muted">{selectedTopicName ? kp.name : kp.en}</div>
            {selectedTopicName && (
              <div className="mt-1 rounded-md bg-brand-tint/60 px-2 py-1 text-[11.5px] font-medium text-brand">
                所属章节：{kp.name} · 子章节课件
              </div>
            )}
          </div>
          {primaryStatus && (
            <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium', PATH_STATUS[primaryStatus].cls)}>
              {PATH_STATUS[primaryStatus].label}
            </span>
          )}
        </div>
        <p className="mt-2 text-[12.5px] leading-[19px] text-ink-muted">{kp.description}</p>
      </div>

      {/* 掌握进度 */}
      <div className="flex items-center gap-4 rounded-[12px] border border-hairline bg-card-warm p-3">
        <div className="text-center"><MasteryRing score={Math.round(learningProgress * score) / 100} /><div className="-mt-1 text-[9px] text-ink-muted">当前知识点掌握程度</div></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between text-[12px] text-ink-2"><span>学习进度</span><span className="font-display font-semibold text-ink">{learningProgress}%</span></div>
          <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-paper-deep"><div className="absolute inset-y-0 left-0 rounded-full bg-[#55B9DC]" style={{ width: `${learningProgress}%` }} /><div className="absolute inset-y-[1px] left-0 rounded-full bg-[#155E9A]" style={{ width: `${Math.round(learningProgress * score) / 100}%` }} /></div>
          <div className="mt-1.5 flex gap-3 text-[9px] text-ink-muted"><span>浅蓝 · 已学习</span><span>深蓝 · 进度内已掌握</span></div>
        </div>
      </div>

      {!selectedTopicName && <div>
      {/* 书本级推荐：优先展示最近已学内容（我的已学路径），未学完资源自动补位。 */}
        <div className="mb-2"><div className="text-[12px] font-medium text-ink-2">已学内容 · 我的已学路径</div><p className="mt-0.5 text-[10.5px] leading-4 text-ink-muted">最近学过的资源优先展示；未学完的内容自动排在后面。</p></div>
        <div className="space-y-2">
          {shownLearned.map((item) => {
            const meta = FORM_META[item.form] ?? { label: '学习资源', icon: BookOpen };
            const Icon = meta.icon;
            const topicName = item.levelTag || item.title.replace(/\s*·\s*(定制讲义|领学讲义|实操指南|分阶测试题)$/, '');
            return <button key={item.id} type="button" onClick={() => navigate(`/learn/resource/${item.id}`)} className="group flex w-full items-center gap-3 rounded-[10px] border border-brand/45 bg-brand-tint/40 px-3 py-2.5 text-left transition-all hover:border-brand/60 hover:bg-brand-tint"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-paper"><Icon size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold text-ink">{topicName}</span><span className="mt-0.5 block truncate text-[11px] text-ink-muted">已学 · {meta.label}</span></span><ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" /></button>;
          })}
          {shownUnfinished.map((item) => {
            const meta = FORM_META[item.form] ?? { label: '学习资源', icon: BookOpen };
            const Icon = meta.icon;
            const topicName = item.levelTag || item.title.replace(/\s*·\s*(定制讲义|领学讲义|实操指南|分阶测试题)$/, '');
            return <button key={item.id} type="button" onClick={() => navigate(`/learn/resource/${item.id}`)} className="group flex w-full items-center gap-3 rounded-[10px] border border-hairline bg-paper px-3 py-2.5 text-left transition-all hover:border-brand/45 hover:bg-brand-tint/40"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand"><Icon size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold text-ink">{topicName}</span><span className="mt-0.5 block truncate text-[11px] text-ink-muted">继续学习 · {meta.label}</span></span><ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" /></button>;
          })}
          {topicRecommendations.map((item, index) => {
            const meta = FORM_META[item.form];
            const Icon = meta.icon;
            return <button key={`${item.topic}-${item.form}-${index}`} type="button" onClick={() => onSelectTopic?.(item.childIndex)} className="group flex w-full items-center gap-3 rounded-[10px] border border-dashed border-brand/35 bg-paper px-3 py-2.5 text-left transition-all hover:border-brand/60 hover:bg-brand-tint/40"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-paper-deep text-brand"><Icon size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink">暂无资源 · {meta.label}</span><span className="block truncate text-[11px] text-ink-muted">管理员尚未设置通用资源</span></span><ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" /></button>;
          })}
        </div>
      </div>}

      {/* 子知识点资源入口 */}
      {selectedTopicName && <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-ink-2">{res.length ? `已有 ${res.length} 份通用资源` : '暂无资源'}</span>
          {(() => {
            const activeTasks = [...customizeTasks.filter((t) => taskBusy(t)), ...(pptBusy && pptCustomizeTask ? [pptCustomizeTask] : [])];
            if (activeTasks.length > 0) {
              return (
                <button
                  type="button"
                  onClick={() => navigate(`/learn/customize/${activeTasks[0].id}`)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ochre/45 bg-ochre-tint/60 px-2.5 py-1.5 text-[11px] font-medium text-ochre transition-all hover:border-ochre hover:bg-ochre-tint"
                >
                  <Loader2 size={12} className="animate-spin" />查看生成过程（{activeTasks.length} 项定制中）
                </button>
              );
            }
            if (customizableForms.length > 0 || pptCustomizable) {
              return (
                <button
                  type="button"
                  onClick={() => void customizeAll()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-brand/45 bg-brand-tint/50 px-2.5 py-1.5 text-[11px] font-medium text-brand transition-all hover:border-brand hover:bg-brand-tint"
                >
                  <Wand2 size={12} />一键定制全部
                </button>
              );
            }
            return null;
          })()}
        </div>
        <div className="space-y-2">
          {/* 三态资源按钮：未定制 → 定制中 → 打开 */}
          {(Object.keys(FORM_META) as ResourceForm[]).map((f) => {
              const meta = FORM_META[f];
              const Icon = meta.icon;
              const template = existingResourceFor(f);
              const cTask = customizeTaskFor(f);
              const busy = taskBusy(cTask);
              // 只有用户自己的定制副本可以打开；未定制则点击发起定制
              const copied = cTask?.status === 'completed' && cTask.resourceId;
              const openTarget = copied ? cTask!.resourceId! : null;
              if (!template && !cTask) {
                return (
                  <div key={f} className="flex w-full cursor-not-allowed items-center gap-3 rounded-[10px] border border-dashed border-brand/35 bg-paper px-3 py-2.5 text-left">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand"><Icon size={16} strokeWidth={1.75} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">{meta.label}</span>
                      <span className="block truncate text-[11px] text-ink-muted">管理员尚未设置通用资源</span>
                    </span>
                    <span className="w-[58px] shrink-0 text-right text-[10.5px] font-medium text-ink-muted">暂无资源</span>
                  </div>
                );
              }
              return (
                <div key={f} className="relative">
                <button
                  type="button"
                  onClick={() => { if (busy || openTarget) { navigate(`/learn/slide/${cTask!.id}`); return; } if (template?.id) setCustomizeChoice({ adminResourceId: template.id, kpId: customizationKpId, resourceType: CUSTOMIZE_FORM_TYPE[f], resourceLabel: meta.label }); }}
                  title={busy ? '查看定制进度' : openTarget ? `打开${meta.label}` : `定制${meta.label}`}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-all',
                    busy ? 'border-brand/45 bg-brand-tint/40'
                      : openTarget ? 'border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/40'
                      : 'border-brand/45 bg-paper hover:border-brand/60 hover:bg-brand-tint/40',
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand">
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} strokeWidth={1.75} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">
                      {meta.label}
                    </span>
                    <span className="block truncate text-[11px] text-ink-muted">
                      {busy ? `${cTask!.stageMessage ?? '正在定制'}（点击查看进度）` : openTarget ? (template?.title ?? cTask?.title) : '基于管理员母版进行个性化定制'}
                    </span>
                  </span>
                  <span className="flex w-[76px] shrink-0 items-center justify-end gap-1.5">
                    <span className={cn('text-[10.5px] font-medium', busy ? 'text-brand' : openTarget ? learningStatusOf(existingResourceFor(f)).cls : 'text-ink-muted')}>
                      {busy ? '定制中' : openTarget ? learningStatusOf(existingResourceFor(f)).label : '未定制'}
                    </span>
                    {busy ? <span className="font-mono text-[9.5px] text-brand">{cTask!.progress ?? 0}%</span>
                      : openTarget ? <ArrowRight size={14} className="text-ink-muted transition-colors group-hover:text-brand" />
                      : <Wand2 size={13} className="text-brand/70 transition-transform group-hover:scale-110" />}
                  </span>
                </button>
                </div>
              );
            })}

          {/* 交互课件：三态（未定制 → 定制中 → 打开） */}
          <button
            type="button"
            onClick={() => {
              if (pptBusy) { navigate(`/learn/customize/${pptCustomizeTask!.id}`); return; }
              if (pptCustomized && pptCustomizeTask?.resourceId) { void openPptCourseware(); return; }
              if (pptForScope?.id) { setCustomizeChoice({ adminResourceId: pptForScope.id, kpId: customizationKpId, resourceType: 'ppt', resourceLabel: '交互课件' }); return; }
              toast.info('暂无资源');
            }}
            title={pptBusy ? '查看定制进度' : pptCustomized ? '打开交互课件' : pptForScope ? '定制交互课件' : '暂无资源'}
            className={cn(
              'group flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-all',
              pptBusy
                ? 'border-brand/45 bg-brand-tint/40'
                : pptCustomized
                  ? 'border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/40'
                  : pptForScope
                    ? 'border-brand/45 bg-paper hover:border-brand/60 hover:bg-brand-tint/40'
                    : 'cursor-not-allowed border-dashed border-brand/35 bg-paper',
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-paper">
              {pptBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-ink">
                交互课件
              </span>
              <span className="block truncate text-[11px] text-ink-muted">
                {pptBusy ? `${pptCustomizeTask!.stageMessage ?? '正在定制'}（点击查看进度）` : pptCustomized ? (pptForScope?.title ?? pptCustomizeTask?.title) : pptForScope ? '基于管理员母版进行个性化定制' : '管理员尚未设置通用资源'}
              </span>
            </span>
            <span className="flex w-[76px] shrink-0 items-center justify-end gap-1.5">
              <span className={cn('text-[10.5px] font-medium', pptBusy || pptCustomized ? 'text-brand' : 'text-ink-muted')}>
                {pptBusy ? '定制中' : pptCustomized ? '已定制' : pptForScope ? '未定制' : '暂无资源'}
              </span>
              {pptBusy ? <span className="font-mono text-[9.5px] text-brand">{pptCustomizeTask!.progress ?? 0}%</span>
                : pptCustomized ? <ArrowRight size={14} className="text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
                : pptForScope ? <Wand2 size={13} className="text-brand/70 transition-transform group-hover:scale-110" /> : null}
            </span>
          </button>
        </div>
      </div>}
      {customizeChoice && <CustomizeChoiceModal open adminResourceId={customizeChoice.adminResourceId} kpId={customizeChoice.kpId} resourceType={customizeChoice.resourceType} resourceLabel={customizeChoice.resourceLabel} onClose={() => setCustomizeChoice(null)} />}
    </div>
  );
}
