/**
 * KpDetailPanel — 知识点详情侧栏（图谱选中即见进度 + 资源 + 跳转）
 * 选中任一知识点后：掌握度环（对目标差）、AI 把握、路径位置、
 * 已生成资源形态（讲义/实操/分阶题，点击深链资源页），以及"进入交互课件（现场生成）"。
 */
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Wrench, ListChecks, Sparkles, Target, Gauge, Route } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import { presentationApi } from '@/lib/presentationApi';
import { readResourceCache, removeResourceCache, upsertResourceCache } from '@/lib/resourceCache';
import type { PresentationTask } from '@/lib/presentationApi';
import { reportForLearner } from '@/data/reportBuilder';
import type { PathNodeStatus } from '@/data/reportData';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import { resourcesForKp } from '@/data/resources';
import type { GeneratedResource } from '@/data/resources';
import type { ResourceForm } from '@/data/resources';
import { Succulent, LeafSmall } from '@/components/heal/Flora';
import type { PathNode } from '@/data/reportData';
import type { GraphNode } from '@/data/knowledgeGraph';
import { cn } from '@/lib/utils';

const FORM_META: Record<ResourceForm, { label: string; icon: typeof BookOpen; hint: string }> = {
  lecture: { label: '定制讲义', icon: BookOpen, hint: '按你水平现写的讲义' },
  guide: { label: '实操指南', icon: Wrench, hint: '分步实操 + 安全门控' },
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

/** 掌握度环：当前分数填充 + 目标刻度 */
function MasteryRing({ score, target }: { score: number; target: number }) {
  const R = 30;
  const C = 2 * Math.PI * R;
  const passed = score >= target;
  const color = passed ? '#E7B45A' : '#4E7860';
  const targetAngle = (target / 100) * 360 - 90;
  const tx = 40 + R * Math.cos((targetAngle * Math.PI) / 180);
  const ty = 40 + R * Math.sin((targetAngle * Math.PI) / 180);
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
      {/* 目标刻度 */}
      <circle cx={tx} cy={ty} r="3" fill="#B0483B" />
      <text x="40" y="38" textAnchor="middle" className="font-display" fontSize="20" fontWeight="700" fill="#3D4A3A">
        {score}
      </text>
      <text x="40" y="52" textAnchor="middle" fontSize="8.5" fill="#99A78F" fontFamily="monospace">
        /目标 {target}
      </text>
    </svg>
  );
}

export default function KpDetailPanel({ kpId, topicIndex, onSelectTopic, kp: kpProp, mastery: masteryProp, topicMastery, topicProgress, graphNodes, path: pathProp, resources: resourcesProp, goalId, knowledgeMap }: {
  kpId: string | null;
  topicIndex?: number | null;
  onSelectTopic?: (topicIndex: number) => void;
  kp?: KnowledgePoint | null;
  mastery?: Record<string, number>;
  topicMastery?: Record<string, number>;
  topicProgress?: Record<string, number>;
  graphNodes?: GraphNode[];
  path?: PathNode[];
  resources?: Array<GeneratedResource & { id?: string; learned?: boolean }>;
  goalId?: string | null;
  knowledgeMap?: {
    chapters: Array<{ id: string; name: string; topics: string[] }>;
    edges: Array<{ from: string; to: string; kind: string }>;
  };
}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const dataId = dataIdOf(currentLearner);
  const report = reportForLearner(currentLearner);
  const [generating, setGenerating] = useState<Set<string>>(() => new Set());
  const [generatedResources, setGeneratedResources] = useState<Record<string, Partial<Record<ResourceForm, GeneratedResourceLink>>>>({});
  const inFlightResources = useRef(new Set<string>());
  const [pptResources, setPptResources] = useState<Record<string, PptResourceLink>>({});
  const [checkingPpt, setCheckingPpt] = useState(false);
  const [startingPpts, setStartingPpts] = useState<Set<string>>(() => new Set());
  const startingPptRefs = useRef(new Set<string>());
  const inFlightPpts = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /* 进入子知识点时从真实 PPT 任务表恢复状态，不能只依赖本次页面会话里的 setState。 */
  useEffect(() => {
    if (!kpId) return undefined;
    const selectedKp = kpProp ?? getKnowledgePoint(kpId);
    const focus = topicIndex != null
      ? selectedKp.coreTopics[topicIndex]
      : selectedKp.coreTopics[0] ?? selectedKp.name;
    const scope = `${currentLearner.id}:${kpId}:${topicIndex != null ? focus : ''}`;
    const wantedTitle = `${focus} · 交互课件`;
    let cancelled = false;
    let timer = 0;

    const restorePptStatus = async () => {
      const cachedPpt = readResourceCache(scope)?.ppt;
      if (cachedPpt?.id && cachedPpt.status === 'completed') {
        setPptResources((current) => (current[scope]?.id === cachedPpt.id ? current : { ...current, [scope]: { id: cachedPpt.id, title: cachedPpt.title, status: 'completed' as const } }));
        if (!cancelled) setCheckingPpt(false);
        return;
      }
      setCheckingPpt(true);
      try {
        const listed = await presentationApi.listPresentationSummaries(50);
        if (cancelled) return;
        const match = (listed.tasks ?? [])
          .filter((item) => item.title === wantedTitle || item.title.includes(focus))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .find((item) => !['failed', 'cancelled'].includes(item.status));
        setPptResources((current) => {
          if (!match) {
            if (!current[scope]) return current;
            const next = { ...current };
            delete next[scope];
            return next;
          }
          const previous = current[scope];
          if (previous?.id === match.id && previous.status === match.status && previous.title === match.title) return current;
          return { ...current, [scope]: { id: match.id, title: match.title, status: match.status } };
        });
        if (match) {
          upsertResourceCache(scope, 'ppt', { id: match.id, title: match.title, status: match.status, updatedAt: new Date().toISOString() });
          if (!['completed', 'failed', 'cancelled'].includes(match.status)) {
            timer = window.setTimeout(restorePptStatus, 2500);
          }
        } else {
          removeResourceCache(scope, 'ppt');
        }
      } catch {
        /* 状态恢复失败不覆盖当前按钮；用户点击时仍会再次查询，避免误创建。 */
      } finally {
        if (!cancelled) setCheckingPpt(false);
      }
    };

    void restorePptStatus();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [currentLearner.id, kpId, kpProp, topicIndex]);

  /* 同步后台个性资源任务：刷新或切回页面后，按钮仍显示真实生成状态。 */
  useEffect(() => {
    if (!kpId) return undefined;
    const selectedKp = kpProp ?? getKnowledgePoint(kpId);
    const focus = topicIndex != null ? selectedKp.coreTopics[topicIndex] : selectedKp.coreTopics[0] ?? selectedKp.name;
    const scope = `${currentLearner.id}:${kpId}:${topicIndex != null ? focus : ''}`;
    let cancelled = false;
    let timer = 0;
    const syncTasks = async () => {
      const resourceForms = Object.keys(FORM_META) as ResourceForm[];
      const cached = readResourceCache(scope);
      const cachedForms = resourceForms.filter((form) => Boolean(cached?.[form]?.id));
      if (cachedForms.length === resourceForms.length) {
        setGeneratedResources((current) => {
          const links: Partial<Record<ResourceForm, GeneratedResourceLink>> = {};
          cachedForms.forEach((form) => {
            const entry = cached?.[form];
            if (entry) links[form] = { id: entry.id, title: entry.title };
          });
          const next = { ...current };
          if (!next[scope]) next[scope] = {};
          Object.assign(next[scope], links);
          return next;
        });
        return;
      }
      try {
        const { tasks } = await api.listLearningResourceTasks(50);
        if (cancelled) return;
        const nextGenerating = new Set<string>();
        for (const task of tasks.filter((item) => item.title.startsWith(`${focus} · `))) {
          const form: ResourceForm = task.resourceType === 'practice' ? 'guide' : task.resourceType;
          const key = `${scope}:${form}`;
          if (!['completed', 'failed', 'cancelled'].includes(task.status)) nextGenerating.add(key);
          if (task.status === 'completed' && task.resourceId) {
            setGeneratedResources((current) => ({ ...current, [scope]: { ...current[scope], [form]: { id: task.resourceId!, title: task.title } } }));
            upsertResourceCache(scope, form, { id: task.resourceId!, title: task.title, updatedAt: new Date().toISOString() });
          }
        }
        setGenerating((current) => {
          const next = new Set([...current].filter((key) => !key.startsWith(`${scope}:`)));
          nextGenerating.forEach((key) => next.add(key));
          return next;
        });
        if (nextGenerating.size) timer = window.setTimeout(syncTasks, 1800);
      } catch { /* 顶部任务中心仍会继续展示；这里不伪造状态。 */ }
    };
    void syncTasks();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [currentLearner.id, kpId, kpProp, topicIndex]);

  if (!kpId) {
    /* 未选中章节：优先展示最近学习但未学完的资源，其次给继续学习建议。 */
    const allResources = resourcesProp ?? [];
    const recentUnfinished = [...allResources]
      .filter((item) => item.id && !item.learned)
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
              const topicName = item.levelTag || item.title.replace(/\s*·\s*(定制讲义|实操指南|分阶测试题)$/, '');
              const chapterName = item.kpId ? getKnowledgePoint(item.kpId)?.name : undefined;
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
            <p className="mt-2 text-[13px] font-medium text-ink">还没有未学完的内容</p>
            <p className="mt-1 text-[11.5px] leading-5 text-ink-muted">点击左侧任一章节，就能开始生成并学习第一份资源。</p>
          </div>
        )}
        <div className="mt-auto border-t border-hairline/70 pt-3">
          <p className="font-mono text-[9.5px] tracking-wide text-ink-muted">NEXT · 从知识地图继续</p>
          <p className="mt-1 text-[11.5px] leading-5 text-ink-muted">页面下方的“章节速览”可直接聚焦任意章节。</p>
        </div>
      </div>
    );
  }

  const kp = kpProp ?? getKnowledgePoint(kpId);
  const selectedTopicName = topicIndex != null ? kp.coreTopics[topicIndex] : null;
  const selectedTopicNode = topicIndex != null ? graphNodes?.find((node) => node.kind === 'topic' && node.kpId === kpId && node.topicIndex === topicIndex) : null;
  const childScores = (graphNodes ?? []).filter((node) => node.kind === 'topic' && node.kpId === kpId).map((node) => topicMastery?.[node.id] ?? 0);
  const score = selectedTopicNode ? (topicMastery?.[selectedTopicNode.id] ?? 0) : childScores.length ? Math.round(childScores.reduce((sum, value) => sum + value, 0) / childScores.length) : ((masteryProp ?? {})[kpId] ?? 0);
  const learningProgress = selectedTopicNode ? (topicProgress?.[selectedTopicNode.id] ?? 0) : (() => {
    const values = (graphNodes ?? []).filter((node) => node.kind === 'topic' && node.kpId === kpId).map((node) => topicProgress?.[node.id] ?? 0);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  })();
  const res: Array<GeneratedResource & { id?: string; learned?: boolean }> = resourcesProp ?? resourcesForKp(dataId, kpId);
  const reportPath = pathProp ?? report.path;
  const resourceScope = `${currentLearner.id}:${kpId}:${selectedTopicName ?? ''}`;
  const generatedForScope = generatedResources[resourceScope] ?? {};
  const pptForScope = pptResources[resourceScope];
  const pptChecking = checkingPpt && !pptForScope;
  const pptGenerating = startingPpts.has(resourceScope) || Boolean(pptForScope && ['queued', 'analyzing', 'outline_review', 'generating', 'reviewing'].includes(pptForScope.status));
  const existingResourceFor = (form: ResourceForm) => res.find((item) => (
    item.form === form
    && item.id
    && (!selectedTopicName || item.levelTag === selectedTopicName || item.title.includes(selectedTopicName))
  ));
  const generateResource = async (form: ResourceForm) => {
    const meta = FORM_META[form];
    const taskKey = `${resourceScope}:${form}`;
    const existing = generatedForScope[form] ?? existingResourceFor(form);
    if (existing?.id) {
      navigate(`/learn/resource/${existing.id}`);
      return;
    }
    if (inFlightResources.current.has(taskKey)) {
      toast.info(`${meta.label}正在生成中`);
      return;
    }
    inFlightResources.current.add(taskKey);
    setGenerating((current) => new Set(current).add(taskKey));
    try {
      const selectedTopicName = topicIndex != null ? kp.coreTopics[topicIndex] : null;
      const body = {
        topic: selectedTopicName ?? kpProp?.coreTopics[0] ?? kp.name,
        title: `${selectedTopicName ?? kpProp?.coreTopics[0] ?? kp.name} · ${FORM_META[form].label}`,
        learnerId: currentLearner.id,
        kpId,
        goalDriven: true,
        learningGoalId: goalId,
        detailLevel: 'detailed' as const,
      };
      const resourceType = form === 'guide' ? 'practice' : form;
      const listed = await api.listLearningResourceTasks(50).catch(() => ({ tasks: [] }));
      let task = listed.tasks.find((item) => item.resourceType === resourceType && item.title === body.title && !['completed', 'failed', 'cancelled'].includes(item.status))
        ?? await api.startLearningResourceTask(resourceType, body);
      toast.success(`${meta.label}已加入后台教研组`, { description: '可在顶部“正在执行”查看多智能体生成与引用核验过程。' });
      while (mounted.current && !['completed', 'failed', 'cancelled'].includes(task.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
        task = await api.getLearningResourceTask(task.id);
      }
      if (task.status !== 'completed' || !task.resourceId) {
        throw new Error(task.errorMessage || `${meta.label}未通过质量审查，请稍后重试`);
      }
      const resource = await api.getLearningResource(task.resourceId);
      setGeneratedResources((current) => ({
        ...current,
        [resourceScope]: {
          ...current[resourceScope],
          [form]: { id: resource.id, title: resource.title },
        },
      }));
      upsertResourceCache(resourceScope, form, { id: resource.id, title: resource.title, updatedAt: new Date().toISOString() });
      toast.success(`${meta.label}已通过多智能体审查，可以打开`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '资源生成失败');
    } finally {
      inFlightResources.current.delete(taskKey);
      setGenerating((current) => {
        const next = new Set(current);
        next.delete(taskKey);
        return next;
      });
    }
  };
  const watchPpt = async (scope: string, taskId: string, focus: string) => {
    const watchKey = `${scope}:${taskId}`;
    if (inFlightPpts.current.has(watchKey)) return;
    inFlightPpts.current.add(watchKey);
    try {
      while (mounted.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
        const task = await presentationApi.getPresentation(taskId);
        if (!mounted.current) return;
        if (task.status === 'failed' || task.status === 'cancelled') {
          removeResourceCache(scope, 'ppt');
          setPptResources((current) => {
            const next = { ...current };
            delete next[scope];
            return next;
          });
          toast.error(task.errorMessage || '交互课件生成失败，请重试');
          return;
        }
        setPptResources((current) => ({ ...current, [scope]: { id: task.id, title: task.title, status: task.status } }));
        upsertResourceCache(scope, 'ppt', { id: task.id, title: task.title, status: task.status, updatedAt: new Date().toISOString() });
        if (task.status === 'completed') {
          toast.success('交互课件已生成，可以打开', { description: focus });
          return;
        }
      }
    } catch (error) {
      if (mounted.current) toast.error(error instanceof Error ? error.message : '课件状态更新失败');
    } finally {
      inFlightPpts.current.delete(watchKey);
    }
  };
  const openPptCourseware = async () => {
    const selectedTopicName = topicIndex != null ? kp.coreTopics[topicIndex] : null;
    const focus = selectedTopicName ?? kpProp?.coreTopics[0] ?? kp.name;
    if (pptChecking) {
      toast.info('正在检查已有交互课件');
      return;
    }
    if (pptForScope?.status === 'completed') {
      navigate(`/learn/${kpId}?ppt=${pptForScope.id}&topic=${encodeURIComponent(focus)}`);
      return;
    }
    if (pptGenerating) {
      toast.info('交互课件正在生成中');
      return;
    }
    if (startingPptRefs.current.has(resourceScope)) {
      toast.info('交互课件正在生成中');
      return;
    }
    startingPptRefs.current.add(resourceScope);
    setStartingPpts((current) => new Set(current).add(resourceScope));
    try {
      const wantedTitle = `${focus} · 交互课件`;
      // 复用已有任务，并把进行中的任务留在当前页面后台轮询。
      try {
        const listed = await presentationApi.listPresentationSummaries(50);
        const match = (listed.tasks ?? [])
          .filter((item) => item.title === wantedTitle || item.title.includes(focus))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .find((item) => !['failed', 'cancelled'].includes(item.status));
        if (match) {
          upsertResourceCache(resourceScope, 'ppt', { id: match.id, title: match.title, status: match.status, updatedAt: new Date().toISOString() });
          if (match.status === 'completed') {
            setPptResources((current) => ({ ...current, [resourceScope]: { id: match.id, title: match.title, status: 'completed' } }));
            navigate(`/learn/${kpId}?ppt=${match.id}&topic=${encodeURIComponent(focus)}`);
          } else {
            setPptResources((current) => ({ ...current, [resourceScope]: { id: match.id, title: match.title, status: match.status } }));
            toast.info('交互课件正在后台生成，可继续生成其他内容');
            void watchPpt(resourceScope, match.id, focus);
          }
          return;
        }
      } catch { /* 列表查询失败时允许直接创建 */ }
      const chapters = knowledgeMap?.chapters ?? [{ id: kpId, name: kp.name, topics: kp.coreTopics }];
      const chapterIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === kpId));
      const currentChapter = chapters[chapterIndex] ?? chapters[0];
      const currentTopicIndex = topicIndex ?? Math.max(0, currentChapter.topics.indexOf(focus));
      const previousTopic = currentTopicIndex > 0
        ? currentChapter.topics[currentTopicIndex - 1]
        : chapters[chapterIndex - 1]?.topics.at(-1) ?? null;
      const nextTopic = currentTopicIndex + 1 < currentChapter.topics.length
        ? currentChapter.topics[currentTopicIndex + 1]
        : chapters[chapterIndex + 1]?.topics[0] ?? null;
      const mapPosition = {
        chapterIndex,
        chapterNumber: chapterIndex + 1,
        chapterCount: chapters.length,
        chapterId: currentChapter.id,
        chapterName: currentChapter.name,
        topicIndex: currentTopicIndex,
        topicNumber: currentTopicIndex + 1,
        topicCount: currentChapter.topics.length,
        topicName: focus,
        previousTopic,
        nextTopic,
      };
      const requirement = `面向${currentLearner.tag}（${currentLearner.education}）制作《${focus}》交互课件PPT，目标是${currentLearner.targetJob}。本课件只深入当前最小知识点，不扩写成整章；内容要覆盖核心概念、原理、方法、典型应用、练习检查与回顾。讲解要自然承接知识地图中的前序内容，并为后续知识点留下必要接口，但不要机械复述地图或频繁预告下一页。`;
      const task = await presentationApi.createPresentation({
        requirement,
        title: wantedTitle,
        audience: 'students',
        purpose: 'courseware',
        style: 'academic',
        backgroundStyle: 'blue-white-minimal',
        language: 'zh-CN',
        slideCount: 0,
        aspectRatio: '16:9',
        detailLevel: 'detailed',
        includeSpeakerNotes: true,
        modelProvider: 'mimo',
        generationMode: 'template',
        learningGoalId: goalId ?? undefined,
        generationContext: {
          contextType: 'knowledge-map-position',
          instruction: '把知识地图作为课程上下文：默认学习者已经接触前序知识点；当前PPT只讲当前知识点；必要时自然引用前序概念，并说明它与后续知识的关系。不要把章节名称逐条念成目录，也不要把用户目标或写作要求当成知识章节。',
          current: mapPosition,
          chapters: chapters.map((chapter, index) => ({
            order: index + 1,
            id: chapter.id,
            name: chapter.name,
            topics: chapter.topics,
          })),
          prerequisiteEdges: (knowledgeMap?.edges ?? []).filter((edge) => edge.kind === 'prereq'),
        },
      });
      setPptResources((current) => ({ ...current, [resourceScope]: { id: task.id, title: task.title, status: task.status } }));
      upsertResourceCache(resourceScope, 'ppt', { id: task.id, title: task.title, status: task.status, updatedAt: new Date().toISOString() });
      toast.success('交互课件已加入后台生成', { description: '可以继续生成讲义、实操指南或分阶测试题。' });
      void watchPpt(resourceScope, task.id, focus);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'PPT 创建失败');
    } finally {
      startingPptRefs.current.delete(resourceScope);
      if (mounted.current) setStartingPpts((current) => {
        const next = new Set(current);
        next.delete(resourceScope);
        return next;
      });
    }
  };
  const pathNodes = reportPath.filter((n) => n.kpId === kpId);
  const primaryStatus = pathNodes.find((n) => n.status === 'active')?.status
    ?? pathNodes.find((n) => n.status === 'todo')?.status
    ?? pathNodes[0]?.status
    ?? null;
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
        <MasteryRing score={score} target={kp.targetLevel} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
            <Target size={12} className="text-brand-danger" />
            学习进度 <span className="font-display font-semibold text-ink">{learningProgress}%</span>
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
            <Gauge size={12} className="text-brand" />
            实际掌握程度 <span className="font-display font-semibold text-ink">{score}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper-deep">
            <div className="h-full rounded-full bg-brand" style={{ width: `${score}%` }} />
          </div>
        </div>
      </div>

      {!selectedTopicName && <div>
      {/* 书本级推荐：优先展示最近已学内容（我的已学路径），未学完资源自动补位。 */}
        <div className="mb-2"><div className="text-[12px] font-medium text-ink-2">已学内容 · 我的已学路径</div><p className="mt-0.5 text-[10.5px] leading-4 text-ink-muted">最近学过的资源优先展示；未学完的内容自动排在后面。</p></div>
        <div className="space-y-2">
          {shownLearned.map((item) => {
            const meta = FORM_META[item.form] ?? { label: '学习资源', icon: BookOpen };
            const Icon = meta.icon;
            const topicName = item.levelTag || item.title.replace(/\s*·\s*(定制讲义|实操指南|分阶测试题)$/, '');
            return <button key={item.id} type="button" onClick={() => navigate(`/learn/resource/${item.id}`)} className="group flex w-full items-center gap-3 rounded-[10px] border border-brand/45 bg-brand-tint/40 px-3 py-2.5 text-left transition-all hover:border-brand/60 hover:bg-brand-tint"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-paper"><Icon size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold text-ink">{topicName}</span><span className="mt-0.5 block truncate text-[11px] text-ink-muted">已学 · {meta.label}</span></span><ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" /></button>;
          })}
          {shownUnfinished.map((item) => {
            const meta = FORM_META[item.form] ?? { label: '学习资源', icon: BookOpen };
            const Icon = meta.icon;
            const topicName = item.levelTag || item.title.replace(/\s*·\s*(定制讲义|实操指南|分阶测试题)$/, '');
            return <button key={item.id} type="button" onClick={() => navigate(`/learn/resource/${item.id}`)} className="group flex w-full items-center gap-3 rounded-[10px] border border-hairline bg-paper px-3 py-2.5 text-left transition-all hover:border-brand/45 hover:bg-brand-tint/40"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand"><Icon size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold text-ink">{topicName}</span><span className="mt-0.5 block truncate text-[11px] text-ink-muted">继续学习 · {meta.label}</span></span><ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" /></button>;
          })}
          {topicRecommendations.map((item, index) => {
            const meta = FORM_META[item.form];
            const Icon = meta.icon;
            return <button key={`${item.topic}-${item.form}-${index}`} type="button" onClick={() => onSelectTopic?.(item.childIndex)} className="group flex w-full items-center gap-3 rounded-[10px] border border-dashed border-brand/35 bg-paper px-3 py-2.5 text-left transition-all hover:border-brand/60 hover:bg-brand-tint/40"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-paper-deep text-brand"><Icon size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink">推荐生成{meta.label}</span><span className="block truncate text-[11px] text-ink-muted">先进入子知识点「{item.topic}」</span></span><ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" /></button>;
          })}
        </div>
      </div>}

      {/* 子知识点资源入口 */}
      {selectedTopicName && <div>
        <div className="mb-2 text-[12px] font-medium text-ink-2">
          {res.length ? `已经做好 ${res.length} 份，挑一个开始` : 'AI 可以现做，挑一种：'}
        </div>
        <div className="space-y-2">
          {/* 三类资源彼此独立：可同时后台生成，完成后原位切换为打开入口。 */}
          {(Object.keys(FORM_META) as ResourceForm[]).map((f) => {
              const meta = FORM_META[f];
              const Icon = meta.icon;
              const completed = generatedForScope[f] ?? existingResourceFor(f);
              const isGenerating = generating.has(`${resourceScope}:${f}`);
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => void generateResource(f)}
                  aria-busy={isGenerating}
                  title={isGenerating ? '内容正在生成中' : completed ? `打开${meta.label}` : `生成${meta.label}`}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-all',
                    completed
                      ? 'border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/40'
                      : isGenerating
                        ? 'cursor-wait border-brand/45 bg-brand-tint/40'
                        : 'border-dashed border-brand/35 bg-paper hover:border-brand/60 hover:bg-brand-tint/40',
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand">
                    {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} strokeWidth={1.75} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">
                      {completed ? `打开${meta.label}` : isGenerating ? `正在生成${meta.label}` : `生成${meta.label}`}
                    </span>
                    <span className="block truncate text-[11px] text-ink-muted">
                      {completed?.title ?? (isGenerating ? '正在后台生成，可继续生成其他内容' : meta.hint)}
                    </span>
                  </span>
                  {isGenerating
                    ? <Loader2 size={13} className="shrink-0 animate-spin text-brand" />
                    : completed
                      ? <ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
                      : <Sparkles size={13} className="shrink-0 text-brand/70 transition-transform group-hover:scale-110" />}
                </button>
              );
            })}

          {/* 交互课件与其他资源一致：后台独立生成，完成后原位切换为打开入口。 */}
          <button
            type="button"
            onClick={() => void openPptCourseware()}
            aria-busy={pptGenerating || pptChecking}
            title={pptChecking ? '正在检查已有课件' : pptGenerating ? '内容正在生成中' : pptForScope ? '打开交互课件' : '生成交互课件'}
            className={cn(
              'group flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-all',
              pptForScope?.status === 'completed'
                ? 'border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/40'
                : pptGenerating
                  ? 'cursor-wait border-brand/45 bg-brand-tint/40'
                  : res.length
                    ? 'border-dashed border-brand/35 bg-paper hover:border-brand/60 hover:bg-brand-tint/40'
                    : 'border-brand/35 bg-brand-tint/50 hover:border-brand/60',
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-paper">
              {pptGenerating || pptChecking ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-ink">{pptForScope?.status === 'completed' ? '打开交互课件' : pptGenerating ? '正在生成交互课件' : pptChecking ? '正在检查交互课件' : '生成交互课件'}</span>
              <span className="block truncate text-[11px] text-ink-muted">{pptGenerating ? '正在后台生成，可继续生成其他内容' : pptChecking ? '正在查询已有生成记录' : pptForScope?.title ?? `PPT 形式 · 按《${selectedTopicName || kp.name}》生成`}</span>
            </span>
            {pptGenerating || pptChecking ? <Loader2 size={13} className="shrink-0 animate-spin text-brand" /> : pptForScope?.status === 'completed' ? <ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" /> : <Sparkles size={13} className="shrink-0 text-brand/70 transition-transform group-hover:scale-110" />}
          </button>
        </div>
      </div>}
    </div>
  );
}
