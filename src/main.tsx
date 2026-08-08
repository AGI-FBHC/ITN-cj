import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { AuthProvider } from '@/context/AuthContext';
import { ProfileProvider } from '@/context/ProfileContext';
import { AgentProvider } from '@/context/AgentContext';
import { NotesProvider } from '@/context/NotesContext';
import { GrowthProvider } from '@/context/GrowthContext';
import { ReviewProvider } from '@/context/ReviewContext';
import { WrongBookProvider } from '@/context/WrongBookContext';

createRoot(document.getElementById('root')!).render(
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
  </AuthProvider>,
);
