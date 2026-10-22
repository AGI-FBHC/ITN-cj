import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import RootErrorBoundary from '@/components/RootErrorBoundary';
import BootGate from '@/components/BootGate';
import { ensureStorageSchema } from '@/lib/storageGuard';
import { clearChunkRecovery, installChunkRecovery } from '@/lib/chunkRecovery';
import { applyStoredBackground } from '@/lib/theme';
import { AuthProvider, consumeGuestWipe } from '@/context/AuthContext';
import { ProfileProvider } from '@/context/ProfileContext';
import { AgentProvider } from '@/context/AgentContext';
import { NotesProvider } from '@/context/NotesContext';
import { GrowthProvider } from '@/context/GrowthContext';
import { ReviewProvider } from '@/context/ReviewContext';
import { WrongBookProvider } from '@/context/WrongBookContext';

/* 上次是游客退出：先清掉体验数据（书架/对话/缓存），再让 Provider 初始化 */
consumeGuestWipe();
/* 同源旧项目的 lf.* 脏数据会让 Provider 初始化即崩——渲染前先做一次版本校验清理 */
ensureStorageSchema();
installChunkRecovery();
applyStoredBackground();
/* 正常渲染后清空自动恢复计数（3 秒后页面已稳定） */
window.setTimeout(clearChunkRecovery, 3000);

createRoot(document.getElementById('root')!).render(
  <RootErrorBoundary>
  <BootGate>
  <AuthProvider>
  <ProfileProvider>
    <AgentProvider>
      <NotesProvider>
        <GrowthProvider>
          <ReviewProvider>
            <WrongBookProvider>
              <App />
            </WrongBookProvider>
          </ReviewProvider>
        </GrowthProvider>
      </NotesProvider>
    </AgentProvider>
  </ProfileProvider>
  </AuthProvider>
  </BootGate>
  </RootErrorBoundary>,
);
