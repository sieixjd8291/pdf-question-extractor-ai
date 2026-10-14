import { createClient } from '@supabase/supabase-js';

/**
 * Supabase client — the single backend for auth (email OTP + password + Google)
 * and cloud workspace storage (Postgres tables with row-level security).
 *
 * Configuration comes from Vite env vars:
 *   VITE_SUPABASE_URL      → Project URL from the Supabase dashboard
 *   VITE_SUPABASE_ANON_KEY → public anon key (safe to ship: RLS protects data)
 */

const rawUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

// Accept the bare Project URL — and tolerate common paste mistakes like
// ".../rest/v1" or a trailing slash — so auth calls always hit the right host.
const supabaseUrl = rawUrl
  .replace(/\/+(rest|auth|storage|realtime|functions|pg|pgmeta)\/v\d+.*$/i, '')
  .replace(/\/+$/, '');

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
      'in the environment (Vercel → Settings → Environment Variables, or .env locally).'
  );
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'public-anon-key-placeholder',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
