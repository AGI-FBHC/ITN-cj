import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import RootErrorBoundary from '@/components/RootErrorBoundary';
import BootGate from '@/components/BootGate';
import { ensureStorageSchema } from '@/lib/storageGuard';
import { installChunkRecovery } from '@/lib/chunkRecovery';
import { AuthProvider } from '@/context/AuthContext';
import { ProfileProvider } from '@/context/ProfileContext';
import { AgentProvider } from '@/context/AgentContext';
import { NotesProvider } from '@/context/NotesContext';
import { GrowthProvider } from '@/context/GrowthContext';
import { ReviewProvider } from '@/context/ReviewContext';
import { WrongBookProvider } from '@/context/WrongBookContext';

/* 同源旧项目的 lf.* 脏数据会让 Provider 初始化即崩——渲染前先做一次版本校验清理 */
ensureStorageSchema();
installChunkRecovery();

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
