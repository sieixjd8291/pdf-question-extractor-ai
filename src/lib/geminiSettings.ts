/**
 * Client-side Gemini API key management.
 *
 * The user pastes their own Gemini API key in Settings; it is stored only in
 * this browser's localStorage and sent per-request to the AI endpoints via the
 * X-Gemini-API-Key header. The server never persists it.
 */

export const GEMINI_KEY_STORAGE_KEY = 'pdf-studio-gemini-key';
export const GEMINI_KEY_EVENT = 'pdf-studio-gemini-key-change';
export const GEMINI_KEY_HEADER = 'X-Gemini-API-Key';

export function getGeminiApiKey(): string {
  try {
    return (localStorage.getItem(GEMINI_KEY_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function hasGeminiApiKey(): boolean {
  return getGeminiApiKey().length > 0;
}

export function setGeminiApiKey(key: string): boolean {
  const trimmed = key.trim();
  try {
    if (trimmed) {
      localStorage.setItem(GEMINI_KEY_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(GEMINI_KEY_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable; the key applies for this session only.
    return false;
  }
  window.dispatchEvent(new CustomEvent<boolean>(GEMINI_KEY_EVENT, { detail: Boolean(trimmed) }));
  return true;
}

export function clearGeminiApiKey(): void {
  setGeminiApiKey('');
}

/** Headers to attach to every AI request so the backend can use the user key. */
export function geminiAuthHeaders(): Record<string, string> {
  const key = getGeminiApiKey();
  return key ? { [GEMINI_KEY_HEADER]: key } : {};
}

const DIRECT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const VALIDATION_TIMEOUT_MS = 12000;

export async function validateGeminiApiKey(key: string): Promise<{ valid: boolean }> {
  if (!key.trim()) return { valid: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    // Listing models verifies credentials without generating content or consuming generation quota.
    const response = await fetch(`${DIRECT_GEMINI_BASE}/models?pageSize=1`, {
      headers: { 'x-goog-api-key': key.trim() },
      signal: controller.signal,
    });
    if (!response.ok) return { valid: false };
    const data = await response.json();
    return { valid: Array.isArray(data.models) };
  } catch {
    return { valid: false };
  } finally {
    clearTimeout(timer);
  }
}
