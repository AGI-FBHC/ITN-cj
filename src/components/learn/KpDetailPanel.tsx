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
import { useAgent } from '@/context/AgentContext';
import { api } from '@/lib/api';
import { presentationApi } from '@/lib/presentationApi';
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

export default function KpDetailPanel({ kpId, topicIndex, kp: kpProp, mastery: masteryProp, confidence: confidenceProp, path: pathProp, resources: resourcesProp, goalId }: {
  kpId: string | null;
  topicIndex?: number | null;
  kp?: KnowledgePoint | null;
  mastery?: Record<string, number>;
  confidence?: Record<string, number>;
  path?: PathNode[];
  resources?: Array<GeneratedResource & { id?: string }>;
  goalId?: string | null;
}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { confidence } = useAgent();
  const dataId = dataIdOf(currentLearner);
  const report = reportForLearner(currentLearner);
  const [generating, setGenerating] = useState<Set<string>>(() => new Set());
  const [generatedResources, setGeneratedResources] = useState<Record<string, Partial<Record<ResourceForm, GeneratedResourceLink>>>>({});
  const inFlightResources = useRef(new Set<string>());
  const [pptResources, setPptResources] = useState<Record<string, PptResourceLink>>({});
  const [startingPpts, setStartingPpts] = useState<Set<string>>(() => new Set());
  const startingPptRefs = useRef(new Set<string>());
  const inFlightPpts = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  if (!kpId) {
    return (
      <div className="lf-glass relative flex h-full min-h-[280px] flex-col items-center justify-center rounded-[18px] p-6 text-center">
        <Succulent className="pointer-events-none absolute -top-5 right-5 h-[52px] w-[44px]" />
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-tint text-brand">
          <Route size={20} />
        </span>
        <p className="mt-3 text-[13.5px] font-medium text-ink">点图谱上任一知识点</p>
        <p className="mt-1 text-[12px] leading-[19px] text-ink-muted">
          这里会显示它的掌握进度、路径位置，<br />以及为你生成的学习资源入口。
        </p>
      </div>
    );
  }

  const kp = kpProp ?? getKnowledgePoint(kpId);
  const selectedTopicName = topicIndex != null ? kp.coreTopics[topicIndex] : null;
  const score = (masteryProp ?? {})[kpId] ?? currentLearner.scores[kpId] ?? 50;
  const conf = (confidenceProp ?? confidence)[kpId] ?? 40;
  const gap = Math.max(0, kp.targetLevel - score);
  const res: Array<GeneratedResource & { id?: string }> = resourcesProp ?? resourcesForKp(dataId, kpId);
  const reportPath = pathProp ?? report.path;
  const resourceScope = `${currentLearner.id}:${kpId}:${selectedTopicName ?? ''}`;
  const generatedForScope = generatedResources[resourceScope] ?? {};
  const pptForScope = pptResources[resourceScope];
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
      const resource = form === 'lecture'
        ? await api.createLearningLecture(body)
        : form === 'quiz'
          ? await api.createLearningQuiz(body)
          : await api.createLearningPractice(body);
      setGeneratedResources((current) => ({
        ...current,
        [resourceScope]: {
          ...current[resourceScope],
          [form]: { id: resource.id, title: resource.title },
        },
      }));
      toast.success(`${meta.label}已生成，可以打开`);
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
          setPptResources((current) => {
            const next = { ...current };
            delete next[scope];
            return next;
          });
          toast.error(task.errorMessage || '交互课件生成失败，请重试');
          return;
        }
        setPptResources((current) => ({ ...current, [scope]: { id: task.id, title: task.title, status: task.status } }));
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
      const requirement = `面向${currentLearner.tag}（${currentLearner.education}）制作《${focus}》交互课件PPT，目标是${currentLearner.targetJob}。内容要覆盖核心概念、原理、方法、典型应用、练习检查与回顾，每一页有具体讲解，不用空泛标题；结合学习画像安排深度，适合课堂互动演示。`;
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
      });
      setPptResources((current) => ({ ...current, [resourceScope]: { id: task.id, title: task.title, status: task.status } }));
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
            距目标还差 <span className="font-display font-semibold text-ink">{gap}</span> 分
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
            <Gauge size={12} className="text-brand" />
            AI 把握 <span className="font-display font-semibold text-ink">{conf}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper-deep">
            <div className="h-full rounded-full bg-brand" style={{ width: `${conf}%` }} />
          </div>
        </div>
      </div>

      {/* 资源入口 */}
      <div>
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
            aria-busy={pptGenerating}
            title={pptGenerating ? '内容正在生成中' : pptForScope ? '打开交互课件' : '生成交互课件'}
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
              {pptGenerating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-ink">{pptForScope?.status === 'completed' ? '打开交互课件' : pptGenerating ? '正在生成交互课件' : '生成交互课件'}</span>
              <span className="block truncate text-[11px] text-ink-muted">{pptGenerating ? '正在后台生成，可继续生成其他内容' : pptForScope?.title ?? `PPT 形式 · 按《${selectedTopicName || kp.name}》生成`}</span>
            </span>
            {pptGenerating ? <Loader2 size={13} className="shrink-0 animate-spin text-brand" /> : pptForScope?.status === 'completed' ? <ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" /> : <Sparkles size={13} className="shrink-0 text-brand/70 transition-transform group-hover:scale-110" />}
          </button>
        </div>
      </div>
    </div>
  );
}
