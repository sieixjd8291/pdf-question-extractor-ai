import { useSyncExternalStore } from 'react';

export const OFFLINE_READY_EVENT = 'pdf-studio:offline-ready';

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}

/**
 * Registers the offline service worker in production builds only, so the Vite
 * dev server and HMR are never intercepted. The first successful install
 * dispatches OFFLINE_READY_EVENT so the UI can confirm offline availability.
 */
export function registerOfflineServiceWorker() {
  if (!import.meta.env.PROD || typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        const worker = registration.installing;
        if (!worker || hadController) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') window.dispatchEvent(new Event(OFFLINE_READY_EVENT));
        });
      })
      .catch((err) => console.warn('Offline support unavailable:', err));
  });
}
