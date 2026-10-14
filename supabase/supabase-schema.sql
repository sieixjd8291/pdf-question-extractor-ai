-- LaTeX Studio — Supabase cloud workspace schema
-- Paste this into Supabase Dashboard → SQL Editor → New query → Run (once).
--
-- ALSO run supabase-storage-schema.sql (creates the Storage bucket where the
-- actual file contents now live, gzipped in the browser). This file creates
-- the manifest table. workspace_files below is LEGACY-ONLY: it is kept so
-- pre-Storage data can still be read (and auto-migrated to Storage on load).
-- New data never touches it — rows are purged automatically after migration.

-- One row per owner: project/folder structure, file metadata (no content),
-- delete tombstones — stored as a single JSON document.
create table if not exists public.workspace_manifests (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  manifest jsonb not null,
  updated_ms bigint not null default 0
);

-- LEGACY: per-file content rows from before the Storage move. Kept only as a
-- read fallback; rows are purged automatically once migrated to Storage.
create table if not exists public.workspace_files (
  owner_id uuid not null references auth.users (id) on delete cascade,
  file_id text not null check (char_length(file_id) <= 128),
  content text not null check (char_length(content) <= 1000000),
  updated_ms bigint not null default 0,
  primary key (owner_id, file_id)
);

alter table public.workspace_manifests enable row level security;
alter table public.workspace_files enable row level security;

-- Every operation is restricted to the signed-in owner (auth.uid() comes from
-- the Supabase JWT — equivalent to the old Firestore "isOwner" rules).
drop policy if exists "Users manage their own workspace manifest" on public.workspace_manifests;
create policy "Users manage their own workspace manifest"
  on public.workspace_manifests
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Users manage their own workspace files" on public.workspace_files;
create policy "Users manage their own workspace files"
  on public.workspace_files
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- Per-user storage quota: no single account may occupy more than 25 MB of
-- legacy file content, so one user can never exhaust the shared free-tier DB.
-- (New Storage-based contents are quota-capped in the app: ~10 MB per user.)
create or replace function public.enforce_workspace_quota()
returns trigger as $$
declare
  used bigint;
  quota constant bigint := 25000000; -- 25,000,000 chars ≈ 25 MB of text
begin
  select coalesce(sum(char_length(content)), 0) into used
    from public.workspace_files where owner_id = new.owner_id;

  if TG_OP = 'UPDATE' then
    used := used - char_length(OLD.content);
  end if;

  if used + char_length(NEW.content) > quota then
    raise exception 'Cloud storage quota exceeded: each account may store up to 25 MB of files. Delete old files or projects to free space — your local copies are not affected.';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists workspace_quota on public.workspace_files;
create trigger workspace_quota
  before insert or update on public.workspace_files
  for each row execute function public.enforce_workspace_quota();
