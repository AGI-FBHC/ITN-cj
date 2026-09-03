import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type LearningResourceGenerationTask } from '@/lib/api';

const ACTIVE_STATUSES = new Set([
  'queued',
  'retrieving',
  'planning',
  'generating',
  'verifying',
  'reviewing',
  'revising',
  'judging',
]);

interface CustomizeActivityValue {
  activeTasks: LearningResourceGenerationTask[];
  refresh: () => void;
}

const CustomizeActivityContext = createContext<CustomizeActivityValue | null>(null);

export function CustomizeActivityProvider({ children }: { children: ReactNode }) {
  const [activeTasks, setActiveTasks] = useState<LearningResourceGenerationTask[]>([]);

  const refresh = useCallback(async () => {
    try {
      const listed = await api.listCustomizeTasks();
      setActiveTasks((listed.tasks ?? []).filter((task) => ACTIVE_STATUSES.has(task.status)));
    } catch {
      /* 拉取失败时保留上一轮状态，避免顶栏按钮闪烁 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const onStarted = () => void refresh();
    window.addEventListener('lf:customize-started', onStarted);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('lf:customize-started', onStarted);
    };
  }, [refresh]);

  const value = useMemo<CustomizeActivityValue>(() => ({ activeTasks, refresh }), [activeTasks, refresh]);
  return <CustomizeActivityContext.Provider value={value}>{children}</CustomizeActivityContext.Provider>;
}

export function useCustomizeActivity(): CustomizeActivityValue {
  const context = useContext(CustomizeActivityContext);
  if (!context) throw new Error('useCustomizeActivity must be used within CustomizeActivityProvider');
  return context;
}
