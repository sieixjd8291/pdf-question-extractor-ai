-- PDF Studio — dashboard activity history schema
-- Paste this into Supabase Dashboard → SQL Editor → New query → Run (once).
--
-- Stores one row per tool run (chapter mapping, question extraction, LaTeX
-- compile) so signed-in users see their usage history on the dashboard across
-- devices. The full entry is kept in `payload`; `created_ms` mirrors
-- payload.timestamp for cheap ordering. Row contents never include document
-- contents — just file names, counts and timings.

create table if not exists public.activity_events (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_ms bigint not null default 0,
  payload jsonb not null
);

create index if not exists activity_events_owner_created_idx
  on public.activity_events (owner_id, created_ms desc);

alter table public.activity_events enable row level security;

-- Every operation is restricted to the signed-in owner (auth.uid() comes from
-- the Supabase JWT — same pattern as the workspace manifest policy).
drop policy if exists "Users manage their own activity events" on public.activity_events;
create policy "Users manage their own activity events"
  on public.activity_events
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
