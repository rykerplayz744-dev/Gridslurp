import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx';
import './index.css';

const rootEl = document.getElementById('root');

if (rootEl) {
  const showBootFallback = (reason: unknown) => {
    if (rootEl.childElementCount > 0) return;
    const msg =
      reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Unknown error';
    rootEl.innerHTML =
      '<div style="min-height:100vh;background:#080B10;color:#F1F5F9;display:flex;align-items:center;justify-content:center;padding:24px;font-family:sans-serif;">' +
      '<div style="max-width:420px;width:100%;background:#0D131F;border:1px solid rgba(244,63,94,0.5);border-radius:12px;padding:24px;">' +
      '<div style="color:#FB7185;font-size:12px;font-weight:700;margin-bottom:8px;">GRIDSLURP // BOOT RECOVERY</div>' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:8px;">Could not start arena display</div>' +
      '<div style="font-size:12px;color:#94A3B8;margin-bottom:14px;">' +
      msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] || c)) +
      '</div>' +
      '<button onclick="window.location.reload()" style="width:100%;padding:10px 14px;border:none;border-radius:8px;background:#10B981;color:#020617;font-weight:700;cursor:pointer;">Reload Arena</button>' +
      '</div></div>';
  };

  window.addEventListener('error', (ev) => showBootFallback(ev.error || ev.message));
  window.addEventListener('unhandledrejection', (ev) => showBootFallback(ev.reason));

  createRoot(rootEl).render(
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

