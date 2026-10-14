import { supabase } from './supabase';
import type { ActivityEntry } from '../types';
import { getActivity, recordActivity } from './activityTracker';

/**
 * Cloud copy of the dashboard activity history, for signed-in users.
 * Table: activity_events (id uuid pk, owner_id uuid, created_ms bigint,
 * payload jsonb) — RLS restricts every user to their own rows.
 *
 * Sync is idempotent (upsert by the client-generated entry id) and always
 * best-effort: any failure is logged and swallowed so the dashboard works
 * fully offline.
 */

interface ActivityRow {
  id: string;
  owner_id: string;
  created_ms: number;
  payload: ActivityEntry;
}

/** Push local entries to the cloud (idempotent upsert). Best-effort. */
export async function pushActivity(uid: string, entries: ActivityEntry[] = getActivity()): Promise<void> {
  if (!uid || entries.length === 0) return;
  const rows: ActivityRow[] = entries.map((e) => ({
    id: e.id,
    owner_id: uid,
    created_ms: e.timestamp,
    payload: e,
  }));
  try {
    const { error } = await supabase.from('activity_events').upsert(rows, { onConflict: 'id' });
    if (error) throw error;
  } catch (err) {
    console.warn('Activity cloud push skipped:', err);
  }
}

/**
 * Record a run locally and, if a Supabase session is active, sync it to the
 * cloud. The local write happens synchronously; the push is fire-and-forget.
 */
export async function recordAndSyncActivity(entry: ActivityEntry): Promise<void> {
  recordActivity(entry);
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user?.id;
    if (uid) await pushActivity(uid, [entry]);
  } catch {
    // Best-effort — offline or unconfigured Supabase never blocks recording
  }
}
