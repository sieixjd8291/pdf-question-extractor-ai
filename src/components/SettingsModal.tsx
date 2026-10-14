import { useEffect, useState } from 'react';
import { Settings2, Info, Sun, Moon, Monitor, Sparkles, ExternalLink, CheckCircle2, KeyRound, Eye, EyeOff, BookOpen, Scissors, FileCode2, Zap, Camera, Compass, RefreshCcw } from 'lucide-react';
import { ExtractionSettings } from '../types';
import { SCAN_QUALITY_PRESETS } from '../lib/scannerFilters';
import { Modal } from './Modal';
import { ThemePreference, THEME_EVENT, getStoredTheme, setThemePreference } from '../theme';
import { LATEX_AUTOCOMPILE_KEY, LATEX_AUTOCOMPILE_EVENT } from '../lib/latexPrefs';
import {
  getGeminiApiKey,
  setGeminiApiKey,
  clearGeminiApiKey,
  validateGeminiApiKey,
} from '../lib/geminiSettings';

interface Props {
  settings: ExtractionSettings;
  onUpdateSettings: (s: Partial<ExtractionSettings>) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
}

type SettingsTab = 'general' | 'chapter-mapper' | 'question-extractor' | 'latex-studio' | 'cam-scanner';

const TABS: { id: SettingsTab; label: string; Icon: typeof Sun }[] = [
  { id: 'general', label: 'General', Icon: Settings2 },
  { id: 'chapter-mapper', label: 'Chapter mapper', Icon: BookOpen },
  { id: 'question-extractor', label: 'Question extractor', Icon: Scissors },
  { id: 'latex-studio', label: 'LaTeX Studio', Icon: FileCode2 },
  { id: 'cam-scanner', label: 'Cam scanner', Icon: Camera },
];

const THEME_OPTIONS: { value: ThemePreference; title: string; Icon: typeof Sun }[] = [
  { value: 'light', title: 'Light', Icon: Sun },
  { value: 'dark', title: 'Dark', Icon: Moon },
  { value: 'system', title: 'System', Icon: Monitor },
];

export function SettingsModal({ settings, onUpdateSettings, onClose, initialTab }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab || 'general');
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredTheme());
  const [apiKeyDraft, setApiKeyDraft] = useState<string>(() => getGeminiApiKey());
  const [savedKey, setSavedKey] = useState<string>(() => getGeminiApiKey());
  const hasKey = savedKey.length > 0;
  const [revealKey, setRevealKey] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [validationKey, setValidationKey] = useState(apiKeyDraft.trim());
  const [keyValidation, setKeyValidation] = useState<{ key: string; valid: boolean } | null>(null);
  const isKeyValid =
    validationKey === apiKeyDraft.trim() && keyValidation?.key === validationKey && keyValidation.valid;

  useEffect(() => {
    if (!validationKey) return;
    let cancelled = false;
    Promise.resolve(validateGeminiApiKey(validationKey))
      .then((result) => {
        if (!cancelled) setKeyValidation({ key: validationKey, valid: result?.valid === true });
      })
      .catch(() => {
        if (!cancelled) setKeyValidation({ key: validationKey, valid: false });
      });
    return () => {
      cancelled = true;
    };
  }, [validationKey]);

  useEffect(() => {
    const timer = setTimeout(() => setValidationKey(apiKeyDraft.trim()), 600);
    return () => clearTimeout(timer);
  }, [apiKeyDraft]);
  const [autoCompile, setAutoCompile] = useState<boolean>(() => {
    try { return localStorage.getItem(LATEX_AUTOCOMPILE_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    const sync = (e: Event) => setTheme((e as CustomEvent<ThemePreference>).detail);
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);

  const setAutoCompilePref = (value: boolean) => {
    setAutoCompile(value);
    try { localStorage.setItem(LATEX_AUTOCOMPILE_KEY, value ? '1' : '0'); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent<boolean>(LATEX_AUTOCOMPILE_EVENT, { detail: value }));
  };

  const handleDone = () => {
    if (apiKeyDraft.trim() !== savedKey && !setGeminiApiKey(apiKeyDraft.trim())) {
      setStorageError('Browser storage is unavailable. The API key could not be saved.');
      return;
    }
    onClose();
  };

  const handleSaveKey = () => {
    const key = apiKeyDraft.trim();
    if (!setGeminiApiKey(key)) {
      setStorageError('Browser storage is unavailable. The API key could not be saved.');
      return;
    }
    setApiKeyDraft(key);
    setSavedKey(key);
    setStorageError(null);
  };

  const handleRemoveKey = () => {
    clearGeminiApiKey();
    setApiKeyDraft('');
    setSavedKey(getGeminiApiKey());
    setRevealKey(false);
    setStorageError(null);
  };

  return (
    <Modal
      title={<span className="inline-flex items-center gap-2"><Settings2 size={18} />Settings</span>}
      closeLabel="Close settings"
      onClose={handleDone}
      width="md"
      footer={<>
        <span>Changes apply immediately</span>
        <div><button className="btn primary" onClick={handleDone}>Done</button></div>
      </>}
    >
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="settings-body">
        {tab === 'general' && (
          <>
            <fieldset>
              <legend><span className="inline-flex items-center gap-2"><Sparkles size={14} />Gemini AI</span></legend>
              <p>
                Don&apos;t have a key?{' '}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="gemini-link"
                >
                  Get a free API key at Google AI Studio <ExternalLink size={14} style={{ verticalAlign: '-2px' }} />
                </a>
              </p>
              <div className="setting-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className={'chip ' + (hasKey ? 'accent' : '')}>
                    <KeyRound size={12} /> {hasKey ? 'API key saved' : 'No API key'}
                  </span>
                  <span className="chip">1. gemini-3.8-flash</span>
                  <span className="chip">2. gemini-3.7-flash</span>
                  <span className="chip">3. gemini-3.6-flash</span>
                  <span className="chip">4. gemini-3.5-flash-lite</span>
                  <span className="chip">5. gemini-3.1-flash-lite</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type={revealKey ? 'text' : 'password'}
                    value={apiKeyDraft}
                    onChange={(e) => {
                      setApiKeyDraft(e.target.value);
                      setStorageError(null);
                    }}
                    placeholder="Paste your Gemini API key (AIza…)"
                    aria-label="Gemini API key"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ flex: '1 1 220px', minWidth: 0 }}
                  />
                  <button
                    type="button"
                    className="btn quiet"
                    onClick={() => setRevealKey((value) => !value)}
                    aria-pressed={revealKey}
                    aria-label={revealKey ? 'Hide API key' : 'Show API key'}
                    disabled={!apiKeyDraft}
                  >
                    {revealKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                  <button
                    className="btn secondary"
                    onClick={handleSaveKey}
                    disabled={apiKeyDraft.trim() === savedKey}
                  >
                    Save key
                  </button>
                  <button
                    className="btn quiet"
                    onClick={handleRemoveKey}
                    disabled={!hasKey && !apiKeyDraft}
                  >
                    Remove
                  </button>
                </div>
                <div role="status" aria-live="polite">
                  {isKeyValid && !storageError && (
                    <p style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontSize: 13, color: 'var(--ok, #16a34a)' }}>
                      <CheckCircle2 size={14} aria-hidden="true" /> Valid API key
                    </p>
                  )}
                  {storageError && (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--danger, #dc2626)' }}>{storageError}</p>
                  )}
                </div>
              </div>
            </fieldset>
            <fieldset>
              <legend>Theme</legend>
              <p>Choose how PDF Studio looks on this device.</p>
              <div className="setting-grid three">
                {THEME_OPTIONS.map(({ value, title, Icon }) => (
                  <button
                    key={value}
                    aria-pressed={theme === value}
                    className={'setting-choice compact ' + (theme === value ? 'selected' : '')}
                    onClick={() => setThemePreference(value)}
                  >
                    <span className="inline-flex items-center gap-2"><Icon size={15} />{title}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          </>
        )}

        {tab === 'chapter-mapper' && (
          <>
            <fieldset>
              <legend>Render quality</legend>
              <p>Higher resolution keeps small text sharp while pages are analysed, but uses more memory.</p>
              <div className="setting-grid two">
                {[
                  { value: 2, title: 'Standard · 2×', text: 'Recommended for most documents' },
                  { value: 3, title: 'High · 3×', text: 'More detail for diagrams and fine text' },
                ].map(x => (
                  <button
                    className={'setting-choice ' + (settings.renderScale === x.value ? 'selected' : '')}
                    aria-pressed={settings.renderScale === x.value}
                    key={x.value}
                    onClick={() => onUpdateSettings({ renderScale: x.value })}
                  >
                    <strong>{x.title}</strong>
                    <span>{x.text}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="settings-note"><Info size={16} /><p>Split chapter PDFs keep their original quality — render quality only affects how pages are processed on your next upload.</p></div>
          </>
        )}

        {tab === 'question-extractor' && (
          <>
            <fieldset>
              <legend>Default export format</legend>
              <p>Used for question downloads and ZIP archives.</p>
              <div className="setting-grid three">
                {(['jpg', 'png', 'pdf'] as const).map(f => (
                  <button
                    key={f}
                    aria-pressed={settings.defaultExportFormat === f}
                    className={'setting-choice compact ' + (settings.defaultExportFormat === f ? 'selected' : '')}
                    onClick={() => onUpdateSettings({ defaultExportFormat: f })}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>File naming</legend>
              <p>Keep your exported questions easy to find.</p>
              <div className="setting-grid">
                {([
                  { value: 'index', title: 'Sequential', example: 'question_001.jpg' },
                  { value: 'label', title: 'Question label', example: 'Q1_001.jpg' },
                  { value: 'page_index', title: 'Page + question', example: 'page_1_question_001.jpg' },
                ] as const).map(x => (
                  <button
                    key={x.value}
                    aria-pressed={settings.namingScheme === x.value}
                    className={'setting-choice row ' + (settings.namingScheme === x.value ? 'selected' : '')}
                    onClick={() => onUpdateSettings({ namingScheme: x.value })}
                  >
                    <strong>{x.title}</strong>
                    <code>{x.example}</code>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="settings-note"><Info size={16} /><p>Applies to question extraction and downloads. Render quality (under Chapter mapper) is used on your next upload.</p></div>
          </>
        )}

        {tab === 'latex-studio' && (
          <>
            <fieldset>
              <legend><span className="inline-flex items-center gap-2"><Zap size={14} />Compilation</span></legend>
              <p>Control how the PDF preview stays up to date while you write.</p>
              <div className="setting-grid two">
                <button
                  className={'setting-choice ' + (autoCompile ? 'selected' : '')}
                  aria-pressed={autoCompile}
                  onClick={() => setAutoCompilePref(true)}
                >
                  <strong>Auto-compile on</strong>
                  <span>Preview refreshes shortly after you stop typing</span>
                </button>
                <button
                  className={'setting-choice ' + (!autoCompile ? 'selected' : '')}
                  aria-pressed={!autoCompile}
                  onClick={() => setAutoCompilePref(false)}
                >
                  <strong>Auto-compile off</strong>
                  <span>Compile manually with the Compile button</span>
                </button>
              </div>
            </fieldset>
            <fieldset>
              <legend><span className="inline-flex items-center gap-2"><Sparkles size={14} />Automatic error repair</span></legend>
              <p>Only starts after compilation fails with a real TeX error. Warnings, timeouts and unavailable compilers never trigger automatic fixes.</p>
              <div className="setting-grid two">
                <button
                  className={'setting-choice ' + (settings.latexAutoRepair !== false ? 'selected' : '')}
                  aria-pressed={settings.latexAutoRepair !== false}
                  onClick={() => onUpdateSettings({ latexAutoRepair: true })}
                >
                  <strong>Auto-repair on</strong>
                  <span>Fix errors and recompile until successful or no safe progress is possible</span>
                </button>
                <button
                  className={'setting-choice ' + (settings.latexAutoRepair === false ? 'selected' : '')}
                  aria-pressed={settings.latexAutoRepair === false}
                  onClick={() => onUpdateSettings({ latexAutoRepair: false })}
                >
                  <strong>Auto-repair off</strong>
                  <span>Keep your source unchanged; run the assistant manually when needed</span>
                </button>
              </div>
              <p>There is no fixed session repair limit. Gemini quotas and compiler availability still apply; you can stop repair at any time.</p>
            </fieldset>
            <div className="settings-note"><Info size={16} /><p>Changes apply to the open LaTeX Studio immediately.</p></div>
          </>
        )}
        {tab === 'cam-scanner' && (
          <>
            <fieldset>
              <legend>Document orientation & auto-rotation</legend>
              <p>Analyze text reading lines to automatically detect and rotate sideways (90°/270°) or upside-down (180°) pages upright.</p>
              <div className="flex flex-wrap gap-2.5 mt-3">
                <button
                  type="button"
                  className="btn primary btn-sm flex items-center gap-1.5"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('camscanner-auto-orient-active'));
                    onClose();
                  }}
                  title="Detect orientation and rotate active page"
                >
                  <Compass size={14} />
                  <span>Auto-orient active page</span>
                </button>
                <button
                  type="button"
                  className="btn secondary btn-sm flex items-center gap-1.5"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('camscanner-auto-orient-all'));
                    onClose();
                  }}
                  title="Detect orientation and rotate all pages upright"
                >
                  <RefreshCcw size={13} />
                  <span>Auto-orient all pages</span>
                </button>
              </div>
            </fieldset>

            <fieldset>
              <legend>Export quality</legend>
              <p>Default image quality for scans exported as JPG, or embedded into PDFs.</p>
              <div className="setting-grid three">
                {([
                  { value: 'small', title: 'Small file', text: '60% quality · lightest to share' },
                  { value: 'balanced', title: 'Balanced', text: '80% quality · recommended' },
                  { value: 'best', title: 'Best quality', text: '92% quality · crisp, archival' },
                ] as const).map(x => (
                  <button
                    key={x.value}
                    aria-pressed={settings.scanQualityPreset === x.value}
                    className={'setting-choice ' + (settings.scanQualityPreset === x.value ? 'selected' : '')}
                    onClick={() => onUpdateSettings({ scanQualityPreset: x.value, scanQuality: SCAN_QUALITY_PRESETS[x.value] })}
                  >
                    <strong>{x.title}</strong>
                    <span>{x.text}</span>
                  </button>
                ))}
              </div>
              <div className="settings-slider">
                <div className="settings-slider-head">
                  <span>Fine-tune quality</span>
                  <span className="settings-slider-value">
                    {settings.scanQuality ?? 80}%{settings.scanQualityPreset === 'custom' ? ' · custom' : ''}
                  </span>
                </div>
                <input
                  type="range"
                  min={40}
                  max={100}
                  step={1}
                  value={settings.scanQuality ?? 80}
                  aria-label="Export quality percentage"
                  onChange={(e) => onUpdateSettings({ scanQuality: Number(e.target.value), scanQualityPreset: 'custom' })}
                />
                <div className="settings-slider-scale">
                  <span>40%</span>
                  <span>100%</span>
                </div>
              </div>
            </fieldset>
            <fieldset>
              <legend>Page size</legend>
              <p>PDF page used when exporting scanned documents. Pages rotate to match each scan.</p>
              <div className="setting-grid three">
                {([
                  { value: 'a4', title: 'A4', text: '210 × 297 mm' },
                  { value: 'letter', title: 'Letter', text: '8.5 × 11 in' },
                  { value: 'fit', title: 'Fit to image', text: 'Page matches each scan' },
                ] as const).map(x => (
                  <button
                    key={x.value}
                    aria-pressed={settings.scanPageSize === x.value}
                    className={'setting-choice ' + (settings.scanPageSize === x.value ? 'selected' : '')}
                    onClick={() => onUpdateSettings({ scanPageSize: x.value })}
                  >
                    <strong>{x.title}</strong>
                    <span>{x.text}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Margins</legend>
              <p>White border added around each scan on the PDF page.</p>
              <div className="setting-grid three">
                {([
                  { value: 'none', title: 'None', text: 'Edge-to-edge scans' },
                  { value: 'small', title: 'Small', text: '≈ 4 mm border' },
                  { value: 'normal', title: 'Normal', text: '≈ 8.5 mm border' },
                ] as const).map(x => (
                  <button
                    key={x.value}
                    aria-pressed={settings.scanMargin === x.value}
                    className={'setting-choice ' + (settings.scanMargin === x.value ? 'selected' : '')}
                    onClick={() => onUpdateSettings({ scanMargin: x.value })}
                  >
                    <strong>{x.title}</strong>
                    <span>{x.text}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="settings-note"><Info size={16} /><p>Defaults for the Cam Scanner tool — the export menu still lets you pick a different format every time. PNG exports are always lossless.</p></div>
          </>
        )}
      </div>
    </Modal>
  );
}
