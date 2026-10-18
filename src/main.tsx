import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import RootErrorBoundary from '@/components/RootErrorBoundary';
import BootGate from '@/components/BootGate';
import { ensureStorageSchema } from '@/lib/storageGuard';
import { AuthProvider } from '@/context/AuthContext';
import { ProfileProvider } from '@/context/ProfileContext';
import { AgentProvider } from '@/context/AgentContext';
import { NotesProvider } from '@/context/NotesContext';
import { GrowthProvider } from '@/context/GrowthContext';
import { ReviewProvider } from '@/context/ReviewContext';
import { WrongBookProvider } from '@/context/WrongBookContext';

/* 发版后旧 chunk 的文件名已变化，懒加载会 404；自动刷新一次拿到新 index。 */
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  try {
    const key = "lf.chunkReloadAt";
    const now = Date.now();
    const last = Number(window.sessionStorage.getItem(key) ?? 0);
    if (now - last > 10_000) {
      window.sessionStorage.setItem(key, String(now));
      window.location.reload();
    }
  } catch {
    window.location.reload();
  }
});

/* 同源旧项目的 lf.* 脏数据会让 Provider 初始化即崩——渲染前先做一次版本校验清理 */
ensureStorageSchema();

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
