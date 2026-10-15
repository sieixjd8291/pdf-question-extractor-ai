import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Settings2,
  FileText,
  RotateCcw,
  Sun,
  Moon,
  Monitor,
} from 'lucide-react';
import { AppMode } from '../types';
import { OfflineIndicator } from './OfflineBanner';
import { ThemePreference, THEME_EVENT, getStoredTheme, setThemePreference } from '../theme';

interface HeaderProps {
  fileName: string | null;
  appMode: AppMode;
  onChangeAppMode: (mode: AppMode) => void;
  isProcessing: boolean;
  hasExtracted: boolean;
  onReset: () => void;
  onOpenSettings: () => void;
}

const THEME_ORDER: ThemePreference[] = ['light', 'dark', 'system'];
const THEME_LABEL: Record<ThemePreference, string> = {
  light: 'Light theme',
  dark: 'Dark theme',
  system: 'Follow system theme',
};

export function Header(p: HeaderProps) {
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredTheme());

  useEffect(() => {
    const sync = (e: Event) => setTheme((e as CustomEvent<ThemePreference>).detail);
    window.addEventListener(THEME_EVENT, sync);
    return () => {
      window.removeEventListener(THEME_EVENT, sync);
    };
  }, []);

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setThemePreference(next);
  };

  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <header className="studio-header">
      <div className="header-inner">
        <div className="brand">
          <span className="brand-icon"><FileText size={16} /></span>
          <div>
            PDF <strong>Studio</strong>
            <small>Chapter mapper & question extractor</small>
          </div>
        </div>
        <nav className="segmented mode-nav" aria-label="Navigation">
          <button
            disabled={p.isProcessing}
            aria-current={p.appMode === 'dashboard' ? 'page' : undefined}
            onClick={() => p.onChangeAppMode('dashboard')}
          >
            <LayoutDashboard size={15} /><span className="hide-sm">Dashboard</span><span className="show-sm">Home</span>
          </button>
        </nav>
        <div className="header-actions">
          <OfflineIndicator />
          <button
            className="icon-button"
            onClick={cycleTheme}
            title={`${THEME_LABEL[theme]} — click to change`}
            aria-label={`${THEME_LABEL[theme]}. Click to switch theme.`}
          >
            <ThemeIcon size={16} />
          </button>
          <button
            id="btn-settings"
            className="icon-button"
            disabled={p.isProcessing}
            onClick={p.onOpenSettings}
            aria-label="Open settings"
          >
            <Settings2 size={16} />
          </button>
        </div>
      </div>
      {p.fileName && p.appMode !== 'dashboard' && (
        <div className="document-bar">
          <div className="document-name">
            <FileText size={15} />
            <span title={p.fileName}>{p.fileName}</span>
            <span className="chip">{p.isProcessing ? 'Processing' : p.hasExtracted ? 'Ready to review' : 'Review document'}</span>
          </div>
          <div className="document-actions">
            <button className="btn quiet btn-sm" disabled={p.isProcessing} onClick={p.onReset}>
              <RotateCcw size={14} />New document
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
