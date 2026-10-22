/**
 * 知识点四类功能叶子（领学讲义/实操指南/分阶测试题/交互课件）的统一动作。
 * 与 2D 侧栏一致：同知识点同类型已有资源 → 直接打开；没有 → 生成。
 */
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import { presentationApi } from '@/lib/presentationApi';
import { refreshLearningMapResourceCache } from './useLearningMap';
import { refreshLearningMapPresentationCache } from './useLearningMap';
import type { GeneratedResource, ResourceForm } from '@/data/resources';
import type { LearningResourceGenerationTask } from '@/lib/api';

export const FUNCTION_META: Array<{ form: ResourceForm | 'ppt'; label: string; color: string }> = [
  { form: 'lecture', label: '领学讲义', color: '#6366F1' },
  { form: 'guide', label: '实操指南', color: '#6366F1' },
  { form: 'quiz', label: '分阶测试题', color: '#6366F1' },
  { form: 'ppt', label: '交互课件', color: '#6366F1' },
];

const FORM_LABEL: Record<ResourceForm, string> = {
  lecture: '领学讲义',
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
  existing?: Array<GeneratedResource & { id?: string; learned?: boolean; started?: boolean }>;
}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const [generating, setGenerating] = useState<Set<ResourceForm>>(() => new Set());
  const [checkingPpt, setCheckingPpt] = useState(false);
  /* 防抖：同一资源生成请求未返回前忽略重复点击（异步查任务阶段 generating 尚未置位） */
  const openInFlightRef = useRef<Set<ResourceForm>>(new Set());
  const topicName = label;

  const watchPresentation = useCallback(async (taskId: string) => {
    let task = await presentationApi.getPresentation(taskId);
    while (!['completed', 'failed', 'cancelled'].includes(task.status)) {
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      task = await presentationApi.getPresentation(taskId);
    }
    await refreshLearningMapPresentationCache(currentLearner.id);
    if (task.status === 'completed') toast.success('交互课件已生成，卡片状态已更新');
    else toast.error(task.errorMessage || '交互课件生成失败');
  }, [currentLearner.id]);

  /** 后台跟进资源生成：不阻塞卡片；完成后刷新缓存，卡片按钮自动变为「打开」 */
  const watchResourceTask = useCallback(async (form: ResourceForm, taskId: string) => {
    const meta = FORM_LABEL[form];
    try {
      let task = await api.getLearningResourceTask(taskId);
      while (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        task = await api.getLearningResourceTask(taskId);
      }
      await refreshLearningMapResourceCache(currentLearner.id);
      if (task.status === 'completed') toast.success(`${meta}已生成`, { description: '卡片已更新为「打开」，点击即可进入。' });
      else toast.error(task.errorMessage || `${meta}生成失败`);
    } catch {
      toast.error(`${meta}生成状态查询失败，请稍后重试`);
    } finally {
      setGenerating((prev) => { const next = new Set(prev); next.delete(form); return next; });
    }
  }, [currentLearner.id]);

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
    if (generating.has(form) || openInFlightRef.current.has(form)) return;
    openInFlightRef.current.add(form);
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
    try {
      const listed = await api.listLearningResourceTasks(50).catch(() => ({ tasks: [] }));
      const sameTitle = (item: LearningResourceGenerationTask) =>
        item.resourceType === resourceType && item.title === body.title;
      /* 已完成但本地列表未命中（缓存过期/其他页面刚生成）：直接打开，不重复生成 */
      const completed = listed.tasks.find(
        (item) => sameTitle(item) && item.status === 'completed' && item.resourceId,
      );
      if (completed?.resourceId) {
        await refreshLearningMapResourceCache(currentLearner.id);
        toast.success(`${meta}已生成`, { description: '正在打开学习资源。' });
        navigate(`/learn/resource/${completed.resourceId}`);
        return;
      }
      /* 进行中任务直接跟进；否则创建新任务。全程后台执行，不阻塞卡片 */
      const running = listed.tasks.find(
        (item) => sameTitle(item) && !['completed', 'failed', 'cancelled'].includes(item.status),
      );
      const task = running ?? await api.startLearningResourceTask(resourceType, body);
      setGenerating((prev) => new Set(prev).add(form));
      toast.success(`${meta}已加入后台生成`, { description: '完成后卡片会自动变为「打开」，点击即可进入。' });
      void watchResourceTask(form, task.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '资源生成失败');
    } finally {
      openInFlightRef.current.delete(form);
    }
  }, [existingFor, generating, navigate, currentLearner.id, kpId, topicName, goalId, watchResourceTask]);

  const openOrCreatePpt = useCallback(async () => {
    if (checkingPpt) return;
    setCheckingPpt(true);
    try {
      const wantedTitle = topicName;
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
          void watchPresentation(match.id);
        }
        return;
      }
      const created = await presentationApi.createPresentation({
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
        generationContext: { kpId, topicName },
      });
      toast.success('交互课件已加入生成队列');
      await refreshLearningMapPresentationCache(currentLearner.id);
      void watchPresentation(created.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '课件操作失败');
    } finally {
      setCheckingPpt(false);
      void refreshLearningMapPresentationCache(currentLearner.id);
    }
  }, [checkingPpt, navigate, kpId, topicName, goalId, currentLearner.id, watchPresentation]);

  return { existingFor, openOrGenerate, openOrCreatePpt, generating, checkingPpt };
}
