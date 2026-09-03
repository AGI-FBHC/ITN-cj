import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';

type CustomizeResourceType = 'lecture' | 'practice' | 'quiz' | 'ppt';

interface StartCustomizeLearningInput {
  adminResourceId: string;
  kpId?: string | null;
  /** 独立交互导学页路由用的知识章节 ID；未传时回退到 kpId */
  routeKpId?: string | null;
  resourceType: CustomizeResourceType;
  resourceLabel?: string;
  topic?: string;
}

/**
 * 未定制资源点击后的统一入口：不再弹二选一，直接发起定制。
 * 前三类资源进入幻灯学习；交互课件保留独立执行进度/导学页面，不复用通用幻灯。
 */
export function useStartCustomizeLearning() {
  const navigate = useNavigate();

  return useCallback(async (input: StartCustomizeLearningInput) => {
    try {
      const task = await api.createCustomizeTask({
        adminResourceId: input.adminResourceId,
        kpId: input.kpId,
        resourceType: input.resourceType,
      });
      window.dispatchEvent(new CustomEvent('lf:customize-started', { detail: { taskId: task.id } }));
      if (input.resourceType === 'ppt') {
        if (task.status === 'completed' && task.resourceId) {
          const routeKpId = input.routeKpId ?? input.kpId ?? '';
          const topic = encodeURIComponent(input.topic ?? input.resourceLabel ?? '');
          toast.success('交互课件已就绪', { description: '正在打开独立交互导学页面。' });
          navigate(`/learn/${encodeURIComponent(routeKpId)}?ppt=${encodeURIComponent(task.resourceId)}&topic=${topic}`);
        } else {
          toast.info('交互课件正在实时生成', {
            description: '可先查看执行进度，完成后从页面下方进入独立交互导学。',
            duration: 8000,
          });
          const returnKpId = encodeURIComponent(input.routeKpId ?? input.kpId ?? '');
          const returnTopic = encodeURIComponent(input.topic ?? input.resourceLabel ?? '');
          navigate(`/learn/customize/${encodeURIComponent(task.id)}?returnKpId=${returnKpId}&returnTopic=${returnTopic}`);
        }
        return;
      }
      toast.info(input.resourceLabel ? `${input.resourceLabel}正在实时生成` : '资源正在实时生成', {
        description: '后台正在实时生成资源，可以先学习已经生成的页面。',
        duration: 8000,
      });
      navigate(`/learn/slide/${encodeURIComponent(task.id)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '暂时无法开始定制');
    }
  }, [navigate]);
}
