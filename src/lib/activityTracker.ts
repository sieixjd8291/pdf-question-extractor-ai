import type { ActivityEntry, AppMode } from '../types';

/**
 * Usage history for the dashboard — one ActivityEntry per tool run.
 * Stored in localStorage only; the cloud copy (signed-in users) lives in the
 * Supabase `activity_events` table via activityCloud.ts. Never store document
 * contents here — just names and counts.
 */

export const ACTIVITY_KEY = 'pdf-studio-activity-v1';
const MAX_ENTRIES = 200;

export function getActivity(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ActivityEntry =>
        e && typeof e.id === 'string' && typeof e.timestamp === 'number' && typeof e.mode === 'string'
    );
  } catch {
    return [];
  }
}

/** Replaces the whole local list (used when cloud history is merged in). */
function overwriteActivity(entries: ActivityEntry[]) {
  try {
    const trimmed = [...entries]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_ENTRIES);
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full or unavailable — history is best-effort
  }
}

export function recordActivity(entry: ActivityEntry) {
  const all = getActivity();
  if (all.some((e) => e.id === entry.id)) return;
  overwriteActivity([entry, ...all]);
}

export function newActivityId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
