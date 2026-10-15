import { useEffect, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { OFFLINE_READY_EVENT, useOnlineStatus } from '../lib/onlineStatus';
import { useToast } from './Toast';
import type { AppMode } from '../types';

const MODE_OFFLINE_HINT: Partial<Record<AppMode, string>> = {
  'latex-studio':
    'Editing and saving keep working on this device. Compiling to PDF, AI repair, and cloud sync resume automatically when you reconnect.',
  'book-mapper':
    'Chapter mapping uses on-device detection (PDF outline, headings, and table of contents). Gemini AI title detection resumes when you reconnect.',
  'cam-scanner': 'Scanning, cropping, filters, and PDF export all run on this device.',
  'assignment-maker': 'Writing, styling, and exporting assignments all run on this device.',
  dashboard: 'Question Extractor, Cam Scanner, and Assignment Maker work fully offline. LaTeX Studio and Chapter Mapper work with limited features.',
};

export function OfflineBanner({ appMode }: { appMode: AppMode }) {
  const online = useOnlineStatus();
  const toast = useToast();
  const [dismissed, setDismissed] = useState(false);
  const wasOffline = useRef(!online);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setDismissed(false);
    } else if (wasOffline.current) {
      wasOffline.current = false;
      toast.success('Back online. Cloud sync and AI features are available again.');
    }
  }, [online, toast]);

  useEffect(() => {
    const onReady = () => toast.info('PDF Studio is ready to work offline on this device.');
    window.addEventListener(OFFLINE_READY_EVENT, onReady);
    return () => window.removeEventListener(OFFLINE_READY_EVENT, onReady);
  }, [toast]);

  if (online || dismissed) return null;

  const hint = MODE_OFFLINE_HINT[appMode] ?? 'Question extraction runs entirely on this device, so you can keep working.';

  return (
    <div className="notice app-notice offline-notice" role="status" aria-live="polite">
      <WifiOff size={17} aria-hidden="true" />
      <span>
        <strong>{"You're offline."}</strong> {hint}
      </span>
      <button aria-label="Dismiss offline message" onClick={() => setDismissed(true)}>×</button>
    </div>
  );
}

export function OfflineIndicator() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <span className="offline-pill" role="status" title="No internet connection. On-device features keep working.">
      <WifiOff size={13} aria-hidden="true" />
      <span>Offline</span>
    </span>
  );
}
