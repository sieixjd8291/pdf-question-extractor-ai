-- LaTeX Studio — Supabase Storage bucket for LaTeX file contents
-- Paste this into Supabase Dashboard → SQL Editor → New query → Run (once).
--
-- File CONTENTS live here (gzipped in the browser), inside the separate
-- 1 GB free Storage quota. The database keeps only light metadata (the
-- manifest), so the 500 MB DB limit stays far away.
--
-- Layout: workspaces/{auth.uid}/{fileId}  — the two-path-segment rule below
-- guarantees every user can only touch files inside their own folder.

insert into storage.buckets (id, name, public)
values ('workspace-files', 'workspace-files', false)
on conflict (id) do nothing;

drop policy if exists "Users manage their own workspace files" on storage.objects;
create policy "Users manage their own workspace files"
  on storage.objects
  for all
  using (
    bucket_id = 'workspace-files'
    and (storage.foldername(name))[1] = 'workspaces'
    and (storage.foldername(name))[2] = auth.uid()::text
  )
  with check (
    bucket_id = 'workspace-files'
    and (storage.foldername(name))[1] = 'workspaces'
    and (storage.foldername(name))[2] = auth.uid()::text
  );
