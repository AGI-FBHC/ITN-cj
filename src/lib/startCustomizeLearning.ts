import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';

type CustomizeResourceType = 'lecture' | 'practice' | 'quiz' | 'ppt';

interface StartCustomizeLearningInput {
  adminResourceId: string;
  kpId?: string | null;
  resourceType: CustomizeResourceType;
  resourceLabel?: string;
}

/**
 * 未定制资源点击后的统一入口：不再弹二选一，直接发起定制并进入幻灯学习。
 * 后台继续实时生成剩余页面，用户可以先学已经生成的部分。
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
