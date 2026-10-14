import { supabase } from './supabase';
import {
  LatexWorkspaceState,
  LatexRootNode,
  LatexFileNode,
  LatexProjectNode,
  LatexFolderNode,
  freshWorkspace,
  isDefaultFreshWorkspace,
} from './latexProjects';

/**
 * Cloud workspace storage — Overleaf-style split:
 *
 *   Supabase Storage (1 GB free, separate quota)  → file CONTENTS, gzipped in
 *   the browser before upload (LaTeX text shrinks ~70%), one object per file
 *   at `workspaces/{uid}/{fileId}`. Storage RLS restricts every user to their
 *   own folder.
 *
 *   Supabase Postgres (500 MB free)               → light metadata only: the
 *   manifest (project/folder tree, file names/sizes, delete tombstones).
 *
 * With gzip, the effective free capacity is several GB of LaTeX text, and the
 * database barely grows. A per-user quota keeps one account from hoarding the
 * shared space. The legacy `workspace_files` table is still read as a fallback
 * (and migrated to Storage on load) so no existing data is lost.
 */

export interface ManifestFileNode {
  id: string;
  kind: 'file';
  name: string;
  updatedAt: number;
  size: number;
}

export interface ManifestProjectNode {
  id: string;
  kind: 'project';
  name: string;
  createdAt: number;
  updatedAt: number;
  files: ManifestFileNode[];
}

export interface ManifestFolderNode {
  id: string;
  kind: 'folder';
  name: string;
  projects: ManifestProjectNode[];
}

export type ManifestRootNode = ManifestProjectNode | ManifestFolderNode;

export interface CloudManifestDoc {
  ownerId: string;
  email?: string;
  schemaVersion: 2;
  tree: ManifestRootNode[];
  activeFileId: string | null;
  /** fileId → deletion timestamp; keeps deletes from resurrecting on other devices. */
  tombstones: Record<string, number>;
  projectCount: number;
  fileCount: number;
  updatedAt: number;
}

interface ManifestRow {
  owner_id: string;
  manifest: CloudManifestDoc;
  updated_ms: number;
}

const BUCKET = 'workspace-files';
/** ~10 MB of uncompressed LaTeX text per user — generous for .tex sources. */
const USER_QUOTA_CHARS = 10 * 1024 * 1024;
/** Conservative char budget per file (fits comfortably in one storage object). */
const MAX_FILE_CHARS = 800_000;
const MAX_TOMBSTONES = 500;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Session state so syncs are incremental and deletes propagate across devices.
let manifestCache: { uid: string; tombstones: Record<string, number> } | null = null;
const pushedFiles = new Map<string, Map<string, { content: string; updatedAt: number; name: string }>>();

function pushedMapFor(uid: string) {
  let m = pushedFiles.get(uid);
  if (!m) {
    m = new Map();
    pushedFiles.set(uid, m);
  }
  return m;
}

export function countTreeStats(tree: LatexRootNode[]) {
  let projectCount = 0;
  let fileCount = 0;
  for (const node of tree) {
    if (node.kind === 'project') {
      projectCount++;
      fileCount += node.files.length;
    } else if (node.kind === 'folder') {
      for (const proj of node.projects) {
        projectCount++;
        fileCount += proj.files.length;
      }
    }
  }
  return { projectCount, fileCount };
}

function collectFileNodes(tree: LatexRootNode[]): LatexFileNode[] {
  const out: LatexFileNode[] = [];
  for (const node of tree) {
    if (node.kind === 'project') out.push(...node.files);
    else for (const project of node.projects) out.push(...project.files);
  }
  return out;
}

function stripFileContents(tree: LatexRootNode[]): ManifestRootNode[] {
  return tree.map((node) => {
    if (node.kind === 'project') {
      return {
        id: node.id,
        kind: 'project' as const,
        name: node.name,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        files: node.files.map((f) => ({
          id: f.id, kind: 'file' as const, name: f.name, updatedAt: f.updatedAt, size: f.content.length,
        })),
      };
    }
    return {
      id: node.id,
      kind: 'folder' as const,
      name: node.name,
      projects: node.projects.map((p) => ({
        id: p.id,
        kind: 'project' as const,
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        files: p.files.map((f) => ({
          id: f.id, kind: 'file' as const, name: f.name, updatedAt: f.updatedAt, size: f.content.length,
        })),
      })),
    };
  });
}

function rebuildTree(manifestTree: ManifestRootNode[], contents: Map<string, string>): LatexRootNode[] {
  return manifestTree.map((node) => {
    if (node.kind === 'project') {
      return {
        ...node,
        files: node.files.map((f) => ({
          id: f.id, kind: 'file' as const, name: f.name,
          updatedAt: f.updatedAt, content: contents.get(f.id) ?? '',
        })),
      };
    }
    return {
      ...node,
      projects: node.projects.map((p) => ({
        ...p,
        files: p.files.map((f) => ({
          id: f.id, kind: 'file' as const, name: f.name,
          updatedAt: f.updatedAt, content: contents.get(f.id) ?? '',
        })),
      })),
    };
  });
}

function pruneTombstones(tombstones: Record<string, number>): Record<string, number> {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const entries = Object.entries(tombstones)
    .filter(([, ts]) => ts >= cutoff)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOMBSTONES);
  return Object.fromEntries(entries);
}

function isTombstoned(fileId: string, fileUpdatedAt: number, tombstones: Record<string, number>): boolean {
  const deletedAt = tombstones[fileId];
  return deletedAt !== undefined && deletedAt >= fileUpdatedAt;
}

function localBackupKey(uid: string) {
  return `pdf_studio_cloud_backup_${uid}`;
}

function readLocalBackup(uid: string): LatexWorkspaceState | null {
  try {
    const backup = localStorage.getItem(localBackupKey(uid));
    return backup ? (JSON.parse(backup) as LatexWorkspaceState) : null;
  } catch {
    return null;
  }
}

function pgError(err: { message?: string } | null, fallback: string): Error {
  return new Error(err?.message || fallback);
}

/* ------------------------------------------------------------------ */
/* Storage helpers (gzip in the browser, one object per file)          */
/* ------------------------------------------------------------------ */

function storagePath(uid: string, fileId: string): string {
  return `workspaces/${uid}/${fileId}`;
}

/** Compress text with gzip when the browser supports it; raw text otherwise. */
async function textToBlob(text: string): Promise<Blob> {
  const CompressionStreamCtor = (globalThis as unknown as { CompressionStream?: new (format: string) => unknown }).CompressionStream;
  if (typeof CompressionStreamCtor === 'function') {
    try {
      const stream = new Blob([text]).stream().pipeThrough(new CompressionStreamCtor('gzip') as unknown as TransformStream);
      return await new Response(stream).blob();
    } catch { /* fall back to raw text */ }
  }
  return new Blob([text]);
}

/** Decode a downloaded object: gzip magic bytes → decompress, else plain text. */
async function blobToText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const DecompressionStreamCtor = (globalThis as unknown as { DecompressionStream?: new (format: string) => unknown }).DecompressionStream;
    if (typeof DecompressionStreamCtor === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStreamCtor('gzip') as unknown as TransformStream);
      return await new Response(stream).text();
    }
    return '';
  }
  return new TextDecoder().decode(bytes);
}

async function uploadFileContent(uid: string, fileId: string, content: string): Promise<void> {
  const blob = await textToBlob(content);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath(uid, fileId), blob, { upsert: true, contentType: 'application/gzip' });
  if (error) throw pgError(error, 'Could not save workspace files.');
}

/**
 * Downloads one file's content: primary source is the Storage object; if it is
 * missing (pre-migration data) the legacy database row is used and lazily
 * copied into Storage so old workspaces upgrade themselves on load.
 */
async function fetchFileContent(uid: string, fileId: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath(uid, fileId));
  if (!error && data) return await blobToText(data);

  try {
    const { data: row, error: dbError } = await supabase
      .from('workspace_files')
      .select('content')
      .eq('owner_id', uid)
      .eq('file_id', fileId)
      .maybeSingle();
    if (!dbError && row) {
      const content = (row as { content: string }).content ?? '';
      try { await uploadFileContent(uid, fileId, content); } catch { /* migrate on next save */ }
      return content;
    }
  } catch { /* fall through */ }
  return null;
}

/** Fetches every file referenced by the manifest in parallel. */
async function fetchFileContents(uid: string, tree: ManifestRootNode[]): Promise<Map<string, string>> {
  const ids = collectFileNodes(tree as unknown as LatexRootNode[]).map((f) => f.id);
  const contents = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const content = await fetchFileContent(uid, id);
      if (content !== null) contents.set(id, content);
    })
  );
  return contents;
}

function seedPushedCache(uid: string, tree: ManifestRootNode[], contents: Map<string, string>) {
  const cache = pushedMapFor(uid);
  cache.clear();
  for (const node of tree) {
    const projects = node.kind === 'project' ? [node] : node.projects;
    for (const p of projects) {
      for (const f of p.files) {
        cache.set(f.id, { content: contents.get(f.id) ?? '', updatedAt: f.updatedAt, name: f.name });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Loads the user's workspace from Supabase (manifest row + Storage objects).
 * Returns null if the user has no cloud workspace saved yet.
 */
export async function loadCloudWorkspace(userId: string): Promise<LatexWorkspaceState | null> {
  try {
    const { data, error } = await supabase
      .from('workspace_manifests')
      .select('manifest')
      .eq('owner_id', userId)
      .maybeSingle();
    if (error) throw pgError(error, 'Could not fetch workspace manifest.');
    if (!data) return readLocalBackup(userId);

    const manifest = (data as { manifest: CloudManifestDoc }).manifest;
    if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.tree)) {
      return readLocalBackup(userId);
    }

    manifestCache = { uid: userId, tombstones: manifest.tombstones ?? {} };
    const contents = await fetchFileContents(userId, manifest.tree);
    seedPushedCache(userId, manifest.tree, contents);
    return { tree: rebuildTree(manifest.tree, contents), activeFileId: manifest.activeFileId ?? null };
  } catch (err) {
    console.warn('Could not load cloud workspace from Supabase, checking local cache:', err);
    return readLocalBackup(userId);
  }
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

async function writePerFileSnapshot(uid: string, state: LatexWorkspaceState, email?: string): Promise<void> {
  const files = collectFileNodes(state.tree);
  const now = Date.now();

  await Promise.all(files.map((f) => uploadFileContent(uid, f.id, f.content)));

  const { projectCount, fileCount } = countTreeStats(state.tree);
  const manifest: CloudManifestDoc = {
    ownerId: uid,
    ...(email ? { email } : {}),
    schemaVersion: 2,
    tree: stripFileContents(state.tree),
    activeFileId: state.activeFileId,
    tombstones: {},
    projectCount,
    fileCount,
    updatedAt: now,
  };
  const { error } = await supabase
    .from('workspace_manifests')
    .upsert({ owner_id: uid, manifest, updated_ms: now } satisfies ManifestRow);
  if (error) throw pgError(error, 'Could not save workspace manifest.');

  manifestCache = { uid, tombstones: {} };
  seedPushedCache(
    uid,
    stripFileContents(state.tree),
    new Map(files.map((f) => [f.id, f.content]))
  );
}

/**
 * Provisioning: called right after account creation (or first login).
 * Idempotent — if a cloud workspace already exists it does nothing, so it is
 * always safe to call. Gives every new account an initialized cloud space
 * seeded with the current local workspace (or a fresh default project).
 */
export async function provisionCloudWorkspace(
  userId: string,
  email?: string,
  localState?: LatexWorkspaceState
): Promise<void> {
  const { data, error } = await supabase
    .from('workspace_manifests')
    .select('manifest')
    .eq('owner_id', userId)
    .maybeSingle();
  if (error) throw pgError(error, 'Could not check for an existing workspace.');

  const existing = data ? (data as { manifest: CloudManifestDoc }).manifest : null;
  if (existing && existing.schemaVersion === 2) {
    // Already provisioned (possibly on another device) — just refresh caches.
    manifestCache = { uid: userId, tombstones: existing.tombstones ?? {} };
    return;
  }

  let seed = localState;
  if (!seed || !Array.isArray(seed.tree)) seed = freshWorkspace();
  try {
    const backup = localStorage.getItem(localBackupKey(userId));
    if (backup) {
      const parsed = JSON.parse(backup) as LatexWorkspaceState;
      if (parsed && Array.isArray(parsed.tree) && parsed.tree.length > 0) seed = parsed;
    }
  } catch { /* keep seed */ }
  await writePerFileSnapshot(userId, seed, email);
}

// Save queue & concurrency lock so overlapping saves (e.g. typing + renaming) never race or clobber
let isSaving = false;
let pendingSave: {
  userId: string;
  state: LatexWorkspaceState;
  email?: string;
  resolvers: Array<() => void>;
  rejecters: Array<(err: any) => void>;
} | null = null;

/**
 * Saves the workspace incrementally: changed file contents are gzipped and
 * uploaded to Storage, deleted files are tombstoned (and their objects and
 * legacy database rows removed), and the manifest is updated last.
 * Concurrency is serialized so rapid keystrokes and file renames never clash.
 */
export async function saveCloudWorkspace(
  userId: string,
  state: LatexWorkspaceState,
  email?: string
): Promise<void> {
  if (isSaving) {
    return new Promise<void>((resolve, reject) => {
      if (pendingSave && pendingSave.userId === userId) {
        pendingSave.state = state;
        if (email) pendingSave.email = email;
        pendingSave.resolvers.push(resolve);
        pendingSave.rejecters.push(reject);
      } else {
        pendingSave = {
          userId,
          state,
          email,
          resolvers: [resolve],
          rejecters: [reject],
        };
      }
    });
  }

  isSaving = true;
  try {
    await executeSaveCloudWorkspace(userId, state, email);
  } finally {
    isSaving = false;
    if (pendingSave) {
      const next = pendingSave;
      pendingSave = null;
      saveCloudWorkspace(next.userId, next.state, next.email)
        .then(() => {
          next.resolvers.forEach((r) => r());
        })
        .catch((err) => {
          next.rejecters.forEach((rej) => rej(err));
        });
    }
  }
}

async function executeSaveCloudWorkspace(
  userId: string,
  state: LatexWorkspaceState,
  email?: string
): Promise<void> {
  const now = Date.now();

  // Always save local backup first.
  try {
    localStorage.setItem(localBackupKey(userId), JSON.stringify(state));
  } catch { /* quota exceeded — cloud save still proceeds */ }

  const currentFiles = collectFileNodes(state.tree);
  const currentIds = new Set(currentFiles.map((f) => f.id));
  const cache = pushedMapFor(userId);

  // Per-user quota: one account cannot hoard the shared Storage/DB space.
  const totalChars = currentFiles.reduce((sum, f) => sum + f.content.length, 0);
  if (totalChars > USER_QUOTA_CHARS) {
    const mb = (totalChars / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Cloud workspace is over the per-user limit (~10 MB of LaTeX text; this workspace is ${mb} MB). ` +
      'Delete or shorten some files — everything is still saved locally.'
    );
  }

  // Refresh tombstones from the manifest if this session hasn't loaded them yet.
  if (!manifestCache || manifestCache.uid !== userId) {
    const { data, error } = await supabase
      .from('workspace_manifests')
      .select('manifest')
      .eq('owner_id', userId)
      .maybeSingle();
    if (error) throw pgError(error, 'Could not fetch workspace manifest.');
    const manifest = data ? (data as { manifest: CloudManifestDoc }).manifest : null;
    manifestCache = { uid: userId, tombstones: manifest?.tombstones ?? {} };
  }

  // Files deleted since the last push become tombstones so other devices
  // drop their local copies instead of re-uploading them on merge.
  const deletedIds = [...cache.keys()].filter((id) => !currentIds.has(id));
  const tombstones: Record<string, number> = { ...manifestCache.tombstones };
  for (const id of deletedIds) {
    tombstones[id] = now;
    cache.delete(id); // Remove from memory cache so it is not processed repeatedly
  }

  // Upload only dirty files (content modified, timestamp advanced, or file renamed).
  const oversized: string[] = [];
  const skippedIds = new Set<string>();
  const dirty = currentFiles.filter((f) => {
    const prev = cache.get(f.id);
    if (!prev || prev.content !== f.content || prev.updatedAt !== f.updatedAt || prev.name !== f.name) {
      if (f.content.length > MAX_FILE_CHARS) {
        skippedIds.add(f.id);
        oversized.push(f.name);
        return false;
      }
      return true;
    }
    return false;
  });

  await Promise.all(dirty.map((f) => uploadFileContent(userId, f.id, f.content)));

  if (deletedIds.length > 0) {
    const { error } = await supabase.storage
      .from(BUCKET)
      .remove(deletedIds.map((id) => storagePath(userId, id)));
    if (error) console.warn('Notice deleting removed workspace files:', error.message);
  }

  // Purge legacy database rows for anything now living in Storage (or deleted),
  // so the old per-row storage format frees its space after migration.
  const migratedIds = [...new Set([...dirty.map((f) => f.id), ...deletedIds])];
  if (migratedIds.length > 0) {
    try {
      await supabase.from('workspace_files').delete().eq('owner_id', userId).in('file_id', migratedIds);
    } catch { /* legacy table may not exist on fresh installs — ignore */ }
  }

  const { projectCount, fileCount } = countTreeStats(state.tree);
  const manifest: CloudManifestDoc = {
    ownerId: userId,
    ...(email ? { email } : {}),
    schemaVersion: 2,
    tree: stripFileContents(state.tree),
    activeFileId: state.activeFileId,
    tombstones: pruneTombstones(tombstones),
    projectCount,
    fileCount,
    updatedAt: now,
  };
  if (JSON.stringify(manifest).length > 1_000_000) {
    throw new Error('Workspace structure is too large for the cloud manifest (too many files).');
  }

  const { error: manifestError } = await supabase
    .from('workspace_manifests')
    .upsert({ owner_id: userId, manifest, updated_ms: now } satisfies ManifestRow);
  if (manifestError) throw pgError(manifestError, 'Could not save workspace manifest.');

  manifestCache = { uid: userId, tombstones: manifest.tombstones };

  // Update the pushed cache (oversized files stay unpushed so they retry after edits).
  for (const f of currentFiles) {
    if (!skippedIds.has(f.id)) {
      cache.set(f.id, { content: f.content, updatedAt: f.updatedAt, name: f.name });
    }
  }

  // Notify other tabs on this device immediately
  broadcastWorkspaceChange(userId, state, now);

  if (oversized.length > 0) {
    throw new Error(
      `Not saved to cloud (too large, over ~800k characters): ${oversized.join(', ')}. ` +
      'Split or shorten these files — they are safe locally.'
    );
  }
}

/* ------------------------------------------------------------------ */
/* Merging (per-file conflict resolution)                              */
/* ------------------------------------------------------------------ */

function cloneProject(p: LatexProjectNode): LatexProjectNode {
  return { ...p, files: p.files.map((f) => ({ ...f })) };
}

/**
 * Combines cloud and local workspaces intelligently:
 * - If local is just the default blank template, cloud replaces it.
 * - Per file/project/folder: newer updatedAt wins.
 * - Tombstones drop deleted files cleanly across devices.
 * - Renames on either side are preserved and synced.
 */
export function mergeWorkspaces(
  cloudState: LatexWorkspaceState,
  localState: LatexWorkspaceState
): LatexWorkspaceState {
  if (isDefaultFreshWorkspace(localState) && cloudState.tree && cloudState.tree.length > 0) {
    return cloudState;
  }
  if (isDefaultFreshWorkspace(cloudState) && localState.tree && localState.tree.length > 0) {
    return localState;
  }

  const tombstones = manifestCache?.tombstones ?? {};
  const result: LatexRootNode[] = (cloudState.tree || []).map((node) =>
    node.kind === 'folder'
      ? { ...node, projects: node.projects.map(cloneProject) }
      : cloneProject(node)
  );

  const findProject = (id: string): LatexProjectNode | undefined => {
    for (const node of result) {
      const projects = node.kind === 'project' ? [node] : node.projects;
      const found = projects.find((p) => p.id === id);
      if (found) return found;
    }
    return undefined;
  };

  const findFolder = (id: string): LatexFolderNode | undefined => {
    return result.find((n): n is LatexFolderNode => n.kind === 'folder' && n.id === id);
  };

  for (const localNode of (localState.tree || [])) {
    if (localNode.kind === 'folder') {
      const targetFolder = findFolder(localNode.id);
      if (targetFolder) {
        if ((localNode.updatedAt || 0) > (targetFolder.updatedAt || 0)) {
          targetFolder.name = localNode.name;
          targetFolder.updatedAt = localNode.updatedAt;
        }
      } else {
        result.push({
          ...localNode,
          projects: [],
        });
      }
    }

    const localProjects = localNode.kind === 'project' ? [localNode] : localNode.projects;
    for (const lp of localProjects) {
      const target = findProject(lp.id);

      if (!target) {
        const survivingFiles = lp.files.filter((f) => !isTombstoned(f.id, f.updatedAt, tombstones));
        if (lp.files.length > 0 && survivingFiles.length === 0) continue; // deleted elsewhere
        const clone: LatexProjectNode = { ...lp, files: survivingFiles.map((f) => ({ ...f })) };
        if (localNode.kind === 'folder') {
          let folder = findFolder(localNode.id);
          if (!folder) {
            folder = { ...localNode, projects: [] };
            result.push(folder);
          }
          folder.projects.push(clone);
        } else {
          result.push(clone);
        }
        continue;
      }

      // Project metadata merge (rename propagation)
      if ((lp.updatedAt || 0) > (target.updatedAt || 0)) {
        target.name = lp.name;
        target.updatedAt = lp.updatedAt;
      }

      for (const lf of lp.files) {
        if (isTombstoned(lf.id, lf.updatedAt, tombstones)) {
          const idx = target.files.findIndex((f) => f.id === lf.id);
          if (idx !== -1) target.files.splice(idx, 1);
          continue;
        }
        const idx = target.files.findIndex((f) => f.id === lf.id);
        if (idx === -1) {
          target.files.push({ ...lf });
        } else {
          const cf = target.files[idx];
          if (lf.updatedAt > cf.updatedAt) {
            // Local file is newer: local content & name wins
            target.files[idx] = { ...lf };
          } else if (cf.updatedAt > lf.updatedAt) {
            // Cloud file is newer: cloud content & name wins
            target.files[idx] = { ...cf };
          } else {
            // Same timestamp: prefer non-empty content and latest name
            target.files[idx] = {
              ...cf,
              name: cf.name || lf.name,
              content: lf.content && !cf.content ? lf.content : cf.content,
            };
          }
        }
      }
    }
  }

  return {
    tree: result,
    activeFileId: cloudState.activeFileId || localState.activeFileId,
  };
}

/* ------------------------------------------------------------------ */
/* Real-time Cross-Device Sync & Multi-Tab Broadcast Helpers          */
/* ------------------------------------------------------------------ */

/**
 * Lightweight metadata fetch (~1 DB query, negligible bandwidth) to check if
 * the cloud manifest has been updated by another device.
 */
export async function fetchCloudManifestMeta(
  userId: string
): Promise<{ updatedMs: number; fileCount: number; projectCount: number } | null> {
  try {
    const { data, error } = await supabase
      .from('workspace_manifests')
      .select('updated_ms, manifest')
      .eq('owner_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    const manifest = (data as any).manifest as CloudManifestDoc | undefined;
    return {
      updatedMs: Number(data.updated_ms || manifest?.updatedAt || 0),
      fileCount: manifest?.fileCount ?? 0,
      projectCount: manifest?.projectCount ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Supabase Realtime channel subscription: fires immediately when any device
 * saves to workspace_manifests for this user.
 */
export function subscribeToWorkspaceSync(
  userId: string,
  onCloudUpdate: (updatedMs: number) => void
): () => void {
  try {
    const channel = supabase
      .channel(`workspace-sync-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'workspace_manifests',
          filter: `owner_id=eq.${userId}`,
        },
        (payload) => {
          const newMs = Number((payload.new as any)?.updated_ms || Date.now());
          onCloudUpdate(newMs);
        }
      )
      .subscribe();

    return () => {
      try {
        supabase.removeChannel(channel);
      } catch { /* ignore */ }
    };
  } catch {
    return () => {};
  }
}

const BROADCAST_NAME = 'pdf_studio_workspace_channel';
let broadcastChannel: BroadcastChannel | null = null;
try {
  if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
    broadcastChannel = new BroadcastChannel(BROADCAST_NAME);
  }
} catch { /* BroadcastChannel not available in environment */ }

export function broadcastWorkspaceChange(userId: string, state: LatexWorkspaceState, updatedMs: number) {
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage({ type: 'WORKSPACE_UPDATE', userId, state, updatedMs });
    } catch { /* ignore */ }
  }
}

export function subscribeToBroadcastWorkspace(
  userId: string,
  onUpdate: (state: LatexWorkspaceState, updatedMs: number) => void
): () => void {
  if (!broadcastChannel) return () => {};
  const handler = (e: MessageEvent) => {
    if (e.data && e.data.type === 'WORKSPACE_UPDATE' && e.data.userId === userId && e.data.state) {
      onUpdate(e.data.state, e.data.updatedMs || Date.now());
    }
  };
  broadcastChannel.addEventListener('message', handler);
  return () => {
    broadcastChannel?.removeEventListener('message', handler);
  };
}

/* ------------------------------------------------------------------ */
/* Deletion                                                            */
/* ------------------------------------------------------------------ */

/**
 * Permanently deletes the user's cloud workspace (all Storage objects, legacy
 * database rows, manifest row) and the local backup cache. RLS guarantees
 * only the owner's data is touched.
 */
export async function deleteCloudWorkspace(userId: string): Promise<void> {
  try {
    localStorage.removeItem(localBackupKey(userId));
  } catch { /* ignore */ }

  try {
    const { data: objects } = await supabase.storage
      .from(BUCKET)
      .list(`workspaces/${userId}`, { limit: 1000 });
    if (objects && objects.length > 0) {
      const paths = objects.map((o) => `workspaces/${userId}/${o.name}`);
      const { error } = await supabase.storage.from(BUCKET).remove(paths);
      if (error) console.warn('Notice deleting cloud storage objects:', error.message);
    }
  } catch (err) {
    console.warn('Notice deleting cloud storage objects:', err);
  }

  try {
    await supabase.from('workspace_files').delete().eq('owner_id', userId);
  } catch (err) {
    console.warn('Notice deleting legacy cloud file rows:', err);
  }

  try {
    const { error } = await supabase.from('workspace_manifests').delete().eq('owner_id', userId);
    if (error) console.warn('Notice deleting cloud manifest row from Supabase:', error.message);
  } catch (err) {
    console.warn('Notice deleting cloud manifest row from Supabase:', err);
  }

  manifestCache = null;
  pushedFiles.delete(userId);
}
