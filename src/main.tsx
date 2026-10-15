import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { AuthProvider } from './contexts/AuthContext.tsx';
import { initTheme } from './theme.ts';
import { registerOfflineServiceWorker } from './lib/onlineStatus.ts';
import './index.css';

initTheme();
registerOfflineServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
);
