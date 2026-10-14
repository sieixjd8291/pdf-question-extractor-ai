export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'pdf-studio-theme';
export const THEME_EVENT = 'pdf-studio-theme-change';

const VALID: ThemePreference[] = ['light', 'dark', 'system'];

export function getStoredTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return VALID.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = pref;
  }
  root.style.colorScheme = resolveTheme(pref);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolveTheme(pref) === 'dark' ? '#14171c' : '#f6f7f9');
  window.dispatchEvent(new CustomEvent<ThemePreference>(THEME_EVENT, { detail: pref }));
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Storage unavailable; theme applies for this session only.
  }
  applyTheme(pref);
}

export function initTheme(): void {
  applyTheme(getStoredTheme());
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (getStoredTheme() === 'system') applyTheme('system');
    });
}
