/**
 * 知识点四类功能叶子（定制讲义/实操指南/分阶测试题/交互课件）的统一动作。
 * 与 2D 侧栏一致：同知识点同类型已有资源 → 直接打开；没有 → 生成。
 */
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import { presentationApi } from '@/lib/presentationApi';
import { refreshLearningMapResourceCache } from './useLearningMap';
import type { GeneratedResource, ResourceForm } from '@/data/resources';

export const FUNCTION_META: Array<{ form: ResourceForm | 'ppt'; label: string; color: string }> = [
  { form: 'lecture', label: '定制讲义', color: '#6366F1' },
  { form: 'guide', label: '实操指南', color: '#6366F1' },
  { form: 'quiz', label: '分阶测试题', color: '#6366F1' },
  { form: 'ppt', label: '交互课件', color: '#6366F1' },
];

const FORM_LABEL: Record<ResourceForm, string> = {
  lecture: '定制讲义',
  guide: '实操指南',
  quiz: '分阶测试题',
};

export function useTopicResourceActions({
  kpId,
  label,
  goalId,
  existing = [],
}: {
  kpId: string;
  label: string;
  goalId?: string | null;
  existing?: Array<GeneratedResource & { id?: string; learned?: boolean }>;
}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const [generating, setGenerating] = useState<Set<ResourceForm>>(() => new Set());
  const [checkingPpt, setCheckingPpt] = useState(false);
  const topicName = label;

  const existingFor = useCallback(
    (form: ResourceForm) => existing.find(
      (item) => item.id && item.form === form && (item.levelTag === topicName || item.title.includes(topicName)),
    ),
    [existing, topicName],
  );

  const openOrGenerate = useCallback(async (form: ResourceForm) => {
    const found = existingFor(form);
    if (found?.id) {
      navigate(`/learn/resource/${found.id}`);
      return;
    }
    if (generating.has(form)) return;
    setGenerating((prev) => new Set(prev).add(form));
    try {
      const meta = FORM_LABEL[form];
      const body = {
        topic: topicName,
        title: `${topicName} · ${meta}`,
        learnerId: currentLearner.id,
        kpId,
        goalDriven: true,
        learningGoalId: goalId,
        detailLevel: 'detailed' as const,
      };
      const resourceType = form === 'guide' ? 'practice' : form;
      const listed = await api.listLearningResourceTasks(50).catch(() => ({ tasks: [] }));
      let task = listed.tasks.find(
        (item) => item.resourceType === resourceType && item.title === body.title && !['completed', 'failed', 'cancelled'].includes(item.status),
      ) ?? await api.startLearningResourceTask(resourceType, body);
      toast.success(`${meta}已加入后台教研组`, { description: '可在顶部“正在执行”查看生成进度。' });
      while (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
        task = await api.getLearningResourceTask(task.id);
      }
      if (task.status === 'completed' && task.resourceId) {
        void refreshLearningMapResourceCache(currentLearner.id);
        toast.success(`${meta}已生成，可以打开`);
        navigate(`/learn/resource/${task.resourceId}`);
      } else {
        throw new Error(task.errorMessage || `${meta}生成失败`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '资源生成失败');
    } finally {
      setGenerating((prev) => { const next = new Set(prev); next.delete(form); return next; });
    }
  }, [existingFor, generating, navigate, currentLearner.id, kpId, topicName, goalId]);

  const openOrCreatePpt = useCallback(async () => {
    if (checkingPpt) return;
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
        } else {
          toast.info('交互课件正在生成中');
        }
        return;
      }
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '课件操作失败');
    } finally {
      setCheckingPpt(false);
    }
  }, [checkingPpt, navigate, kpId, topicName, goalId]);

  return { existingFor, openOrGenerate, openOrCreatePpt, generating, checkingPpt };
}
