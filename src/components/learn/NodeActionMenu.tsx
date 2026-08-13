/**
 * NodeActionMenu — 3D 图谱子节点点击弹出菜单
 * 集成：定制讲义、实操指南、分阶测试题、交互课件
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { BookOpen, Wrench, ListChecks, Sparkles, X, Loader2, Check } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { motion } from 'framer-motion';
import { api } from '@/lib/api';
import { presentationApi } from '@/lib/presentationApi';
import type { ResourceForm } from '@/data/resources';
import type { GeneratedResource } from '@/data/resources';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { cn } from '@/lib/utils';

const FORM_META: Record<ResourceForm, { label: string; icon: typeof BookOpen; hint: string }> = {
  lecture: { label: '定制讲义', icon: BookOpen, hint: '按你水平现写的讲义' },
  guide: { label: '实操指南', icon: Wrench, hint: '分步实操 + 安全门控' },
  quiz: { label: '分阶测试题', icon: ListChecks, hint: '基础/进阶/挑战三阶' },
};

interface NodeActionMenuProps {
  label: string;
  kpId: string;
  topicIndex: number;
  onClose: () => void;
  goalId: string | null;
  /** 该章节已有的资源，命中后直接打开，避免重复生成 */
  existing?: Array<GeneratedResource & { id?: string; learned?: boolean }>;
}

export default function NodeActionMenu({ kpId, topicIndex, label, onClose, goalId, existing = [] }: NodeActionMenuProps) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [checkingPpt, setCheckingPpt] = useState(false);

  const kp = getKnowledgePoint(kpId);
  const topicName = label || kp.coreTopics[topicIndex] || kp.name;
  const scope = `${currentLearner.id}:${kpId}:${topicName}`;

  /** 与 2D 侧栏一致：同知识点同类型已有资源 → 按钮显示“打开”，点击直接打开不重复生成 */
  const existingFor = (form: ResourceForm) => existing.find(
    (item) => item.id && item.form === form && (item.levelTag === topicName || item.title.includes(topicName)),
  );

  const handleResourceClick = (form: ResourceForm) => {
    const found = existingFor(form);
    if (found?.id) {
      navigate(`/learn/resource/${found.id}`);
      onClose();
      return;
    }
    void generateResource(form);
  };

  const generateResource = async (form: ResourceForm) => {
    /* 已存在同知识点同类型资源 → 直接打开，不重复生成 */
    const existingResource = existing.find((item) => item.id && item.form === form && (item.levelTag === topicName || item.title.includes(topicName)));
    if (existingResource?.id) {
      navigate(`/learn/resource/${existingResource.id}`);
      onClose();
      return;
    }
    const meta = FORM_META[form];
    const taskKey = `${scope}:${form}`;
    if (generating.has(taskKey)) {
      toast.info('正在生成中');
      return;
    }
    setGenerating((current) => new Set(current).add(taskKey));
    try {
      const body = {
        topic: topicName,
        title: `${topicName} · ${meta.label}`,
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
      toast.success(`${meta.label}已加入后台教研组`, { description: '可在顶部"正在执行"查看生成进度。' });
      
      // 轮询任务状态
      while (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
        task = await api.getLearningResourceTask(task.id);
      }
      
      if (task.status === 'completed' && task.resourceId) {
        toast.success(`${meta.label}已生成，可以打开`);
        // 可以选择跳转到资源页面
        // navigate(`/resources/${task.resourceId}`);
      } else {
        throw new Error(task.errorMessage || `${meta.label}生成失败`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '资源生成失败');
    } finally {
      setGenerating((current) => {
        const next = new Set(current);
        next.delete(taskKey);
        return next;
      });
    }
  };

  const openPptCourseware = async () => {
    if (checkingPpt) {
      toast.info('正在检查已有交互课件');
      return;
    }
    setCheckingPpt(true);
    try {
      const wantedTitle = `${topicName} · 交互课件`;
      const listed = await presentationApi.listPresentationSummaries(50);
      const match = (listed.tasks ?? [])
        .filter((item) => item.title === wantedTitle || item.title.includes(topicName))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .find((item) => !['failed', 'cancelled'].includes(item.status));
      
      if (match) {
        if (match.status === 'completed') {
          navigate(`/learn/${kpId}?ppt=${match.id}&topic=${encodeURIComponent(topicName)}`);
          onClose();
        } else {
          toast.info('交互课件正在生成中');
        }
      } else {
        // 创建新的 PPT 任务
        await presentationApi.createPresentation({
          requirement: topicName,
          title: wantedTitle,
          audience: 'students',
          purpose: 'courseware',
          style: 'education',
          backgroundStyle: 'clean-minimal',
          language: 'zh-CN',
          slideCount: 12,
          aspectRatio: '16:9',
          detailLevel: 'detailed',
          includeSpeakerNotes: true,
          modelProvider: 'mimo',
          learningGoalId: goalId ?? undefined,
        });
        toast.success('交互课件已加入生成队列');
        // 可以选择跳转到课件页面
        // navigate(`/learn/${kpId}?ppt=${task.id}&topic=${encodeURIComponent(topicName)}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '课件操作失败');
    } finally {
      setCheckingPpt(false);
    }
  };

  return (
    <div className="absolute left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 24 }}
        className="relative w-[280px] overflow-hidden rounded-[22px] border border-white/15 bg-[#0E1720]/95 p-4 shadow-[0_24px_80px_rgba(3,8,12,0.55)] backdrop-blur-xl"
      >
        {/* 顶部氛围光 */}
        <div className="pointer-events-none absolute -top-16 left-1/2 h-32 w-56 -translate-x-1/2 rounded-full bg-brand/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-14 -right-10 h-32 w-32 rounded-full bg-brand-amber/20 blur-3xl" />

        {/* 关闭按钮 */}
        <button type="button" onClick={onClose} className="absolute right-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-white/10 text-paper/70 transition-colors hover:bg-white/20 hover:text-paper">
          <X size={13} />
        </button>

        {/* 标题 */}
        <div className="relative text-center">
          <div className="font-serif text-[15px] font-semibold leading-6 text-paper">{topicName}</div>
          <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 font-mono text-[9.5px] tracking-wide text-paper/60">
            <Sparkles size={10} className="text-brand-amber" />
            {kp.name} · 学习资源
          </div>
        </div>

        {/* 资源按钮：已有 → 打开；否则 → 生成 */}
        <div className="relative mt-3.5 grid grid-cols-2 gap-2">
          {(Object.keys(FORM_META) as ResourceForm[]).map((form) => {
            const meta = FORM_META[form];
            const Icon = meta.icon;
            const taskKey = `${scope}:${form}`;
            const isGenerating = generating.has(taskKey);
            const found = existingFor(form);
            const isOpen = Boolean(found?.id);
            return (
              <button
                key={form}
                type="button"
                onClick={() => handleResourceClick(form)}
                disabled={isGenerating}
                title={meta.hint}
                className={cn(
                  'group flex flex-col items-center gap-1.5 rounded-[14px] border px-3 py-3 text-[12px] font-medium transition-all active:scale-[0.97]',
                  isOpen
                    ? 'border-brand/50 bg-brand/15 text-brand hover:bg-brand/25'
                    : isGenerating
                      ? 'cursor-wait border-white/10 bg-white/5 text-paper/70'
                      : 'border-dashed border-white/20 bg-white/5 text-paper/80 hover:border-brand-amber/50 hover:bg-white/10 hover:text-brand-amber',
                )}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-xl transition-transform group-hover:scale-105" style={{ background: isOpen ? 'rgba(78,120,96,0.28)' : 'rgba(255,255,255,0.08)' }}>
                  {isGenerating ? <Loader2 size={17} className="animate-spin text-brand-amber" /> : isOpen ? <Check size={17} className="text-brand" /> : <Icon size={17} className="text-brand-amber" />}
                </span>
                <span>{isOpen ? `打开${meta.label}` : isGenerating ? '生成中…' : `生成${meta.label}`}</span>
              </button>
            );
          })}

          {/* 交互课件 */}
          <button
            type="button"
            onClick={() => void openPptCourseware()}
            disabled={checkingPpt}
            className="col-span-2 mt-0.5 flex items-center justify-center gap-2 overflow-hidden rounded-[14px] border border-brand-amber/40 bg-gradient-to-r from-brand-amber/25 to-brand-amber/10 px-3 py-2.5 text-[12px] font-semibold text-brand-amber transition-all hover:from-brand-amber/40 hover:to-brand-amber/20 active:scale-[0.98] disabled:opacity-60"
          >
            {checkingPpt ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            进入交互课件
          </button>
        </div>
      </motion.div>
    </div>
  );
}



