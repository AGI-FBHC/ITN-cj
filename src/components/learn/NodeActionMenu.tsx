/**
 * NodeActionMenu — 3D 图谱子节点点击弹出菜单
 * 集成：定制讲义、实操指南、分阶测试题、交互课件
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { BookOpen, Wrench, ListChecks, Sparkles, X, Loader2 } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import { presentationApi } from '@/lib/presentationApi';
import type { ResourceForm } from '@/data/resources';
import { getKnowledgePoint } from '@/data/knowledgePoints';

const FORM_META: Record<ResourceForm, { label: string; icon: typeof BookOpen; hint: string }> = {
  lecture: { label: '定制讲义', icon: BookOpen, hint: '按你水平现写的讲义' },
  guide: { label: '实操指南', icon: Wrench, hint: '分步实操 + 安全门控' },
  quiz: { label: '分阶测试题', icon: ListChecks, hint: '基础/进阶/挑战三阶' },
};

interface NodeActionMenuProps {
  kpId: string;
  topicIndex: number;
  onClose: () => void;
  goalId: string | null;
}

export default function NodeActionMenu({ kpId, topicIndex, onClose, goalId }: NodeActionMenuProps) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [checkingPpt, setCheckingPpt] = useState(false);

  const kp = getKnowledgePoint(kpId);
  const topicName = kp.coreTopics[topicIndex] ?? kp.name;
  const scope = `${currentLearner.id}:${kpId}:${topicName}`;

  const generateResource = async (form: ResourceForm) => {
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
      <div className="relative rounded-2xl border border-hairline bg-white/95 p-4 shadow-xl backdrop-blur-sm">
        {/* 关闭按钮 */}
        <button
          type="button"
          onClick={onClose}
          className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-hairline bg-white text-ink-muted hover:text-ink"
        >
          <X size={14} />
        </button>

        {/* 标题 */}
        <div className="mb-3 text-center">
          <div className="text-[13px] font-semibold text-ink">{topicName}</div>
          <div className="mt-0.5 text-[11px] text-ink-muted">选择要生成的学习资源</div>
        </div>

        {/* 4 个按钮 */}
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(FORM_META) as ResourceForm[]).map((form) => {
            const meta = FORM_META[form];
            const Icon = meta.icon;
            const taskKey = `${scope}:${form}`;
            const isGenerating = generating.has(taskKey);
            return (
              <button
                key={form}
                type="button"
                onClick={() => generateResource(form)}
                disabled={isGenerating}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-hairline bg-paper px-3 py-2.5 text-[12px] font-medium text-ink-2 transition-all hover:border-brand hover:bg-brand-tint hover:text-brand disabled:opacity-50"
              >
                {isGenerating ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Icon size={18} />
                )}
                <span>{meta.label}</span>
              </button>
            );
          })}
          
          {/* 交互课件按钮 */}
          <button
            type="button"
            onClick={openPptCourseware}
            disabled={checkingPpt}
            className="col-span-2 flex items-center justify-center gap-2 rounded-xl border border-brand-amber/50 bg-brand-amber-tint px-3 py-2.5 text-[12px] font-medium text-ochre transition-all hover:bg-brand-amber hover:text-white disabled:opacity-50"
          >
            {checkingPpt ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Sparkles size={18} />
            )}
            <span>进入交互课件</span>
          </button>
        </div>
      </div>
    </div>
  );
}


