import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Camera,
  ChevronRight,
  FileCode2,
  Folder,
  FolderPlus,
  Pencil,
  PenLine,
  Plus,
  Scissors,
  Search,
  Trash2,
} from 'lucide-react';
import type { AppMode } from '../types';
import {
  LatexRootNode,
  LatexWorkspaceState,
  addFolder,
  addProject,
  loadWorkspace,
  renameTreeNode,
  removeTreeNode,
  sanitizeFolderName,
  saveWorkspace,
  uniqueName,
} from '../lib/latexProjects';
import { useAuth } from '../contexts/AuthContext';
import {
  loadCloudWorkspace,
  saveCloudWorkspace,
  mergeWorkspaces,
  provisionCloudWorkspace,
  fetchCloudManifestMeta,
  subscribeToWorkspaceSync,
  subscribeToBroadcastWorkspace,
} from '../lib/workspaceCloudSync';
import { ConfirmDialog } from './ConfirmDialog';
import { useDialog } from '../hooks/useDialog';
import { useToast } from './Toast';

/**
 * Dashboard = the projects browser for the LaTeX workspace. One panel lists
 * the workspace's folders (and any unfiled projects); opening a folder shows
 * the projects inside it, and opening a project launches LaTeX Studio scoped
 * to that project on a new screen. Below the browser sit the tool cards.
 */

type ProjectsView = { kind: 'home' } | { kind: 'folder'; id: string };

interface NameDialogState {
  mode: 'new-folder' | 'new-project' | 'rename';
  /** Folder id for new-project; node id for rename. */
  targetId: string | null;
  initial: string;
}

const NAME_DIALOG_COPY: Record<NameDialogState['mode'], { title: string; label: string; confirm: string }> = {
  'new-folder': { title: 'New folder', label: 'Folder name', confirm: 'Create' },
  'new-project': { title: 'New project', label: 'Project name', confirm: 'Create' },
  rename: { title: 'Rename', label: 'New name', confirm: 'Rename' },
};

function NamePromptDialog({ title, label, confirmLabel, initial, onConfirm, onClose }: {
  title: string;
  label: string;
  confirmLabel: string;
  initial: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const ref = useDialog(onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);

  useEffect(() => { inputRef.current?.select(); }, []);

  const submit = () => {
    if (!value.trim()) return;
    onConfirm(value.trim());
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="modal-panel sm latex-name-dialog" role="dialog" aria-modal="true" aria-labelledby="projects-name-title" tabIndex={-1}>
        <h2 id="projects-name-title">{title}</h2>
        <label>
          {label}
          <input
            ref={inputRef}
            type="text"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          />
        </label>
        <footer>
          <button className="btn quiet" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!value.trim()}>{confirmLabel}</button>
        </footer>
      </div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

interface FlatProject {
  id: string;
  name: string;
  fileCount: number;
  updatedAt: number;
  folderId: string | null;
  folderName: string | null;
}

/** The four tools, launched from the dashboard below the projects browser. */
const MODE_CARDS: Array<{
  mode: Exclude<AppMode, 'dashboard'>;
  icon: React.ReactNode;
  title: string;
  description: string;
  tint: number;
}> = [
  {
    mode: 'book-mapper',
    icon: <BookOpen size={20} />,
    title: 'Chapter mapper',
    description: 'Find chapters and page ranges in any book PDF, then split it into per-chapter files.',
    tint: 1,
  },
  {
    mode: 'question-extractor',
    icon: <Scissors size={20} />,
    title: 'Question extractor',
    description: 'Detect numbered questions in a PDF, crop them out, and export as JPG, PNG, PDF or ZIP.',
    tint: 3,
  },
  {
    mode: 'latex-studio',
    icon: <FileCode2 size={20} />,
    title: 'LaTeX studio',
    description: 'Open the full workspace editor, or pick a project above to open just its files.',
    tint: 8,
  },
  {
    mode: 'cam-scanner',
    icon: <Camera size={20} />,
    title: 'Cam scanner',
    description: 'Capture pages with your camera or photos, enhance them with scanner filters, and export as PDF or images.',
    tint: 4,
  },
  {
    mode: 'assignment-maker',
    icon: <PenLine size={20} />,
    title: 'Assignment maker',
    description: 'Turn typed text into realistic handwriting on notebook paper or your own photo, then export as PDF or images.',
    tint: 6,
  },
];

export function Dashboard({ onOpenProject, onChangeAppMode }: {
  onOpenProject: (projectId: string) => void;
  onChangeAppMode: (mode: AppMode) => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const userId = user ? ('uid' in user ? user.uid : (user as any).id) : null;
  const userEmail = user?.email ?? null;

  const [ws, setWs] = useState<LatexWorkspaceState>(() => loadWorkspace());
  const tree = ws.tree;
  const initialCloudFetched = useRef<string | null>(null);
  const lastKnownCloudMs = useRef<number>(0);

  const [view, setView] = useState<ProjectsView>({ kind: 'home' });
  const [query, setQuery] = useState('');
  // Mobile: the search box is collapsed to an icon in the title row and only
  // expands when tapped.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [deletePrompt, setDeletePrompt] = useState<{ kind: 'folder' | 'project'; id: string; label: string; extra?: string } | null>(null);

  const toggleSearch = () => {
    if (searchOpen) {
      setQuery('');
      setSearchOpen(false);
    } else {
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  };

  // The studio flushes its own saves on unmount; persist our mutations here.
  useEffect(() => { saveWorkspace(ws); }, [ws]);

  // Load cloud workspace automatically when user logs in
  useEffect(() => {
    if (!user || !userId) {
      initialCloudFetched.current = null;
      return;
    }
    if (initialCloudFetched.current === userId) return;

    let isSubscribed = true;

    loadCloudWorkspace(userId).then(async (cloudState) => {
      if (!isSubscribed) return;
      if (!cloudState || !Array.isArray(cloudState.tree) || cloudState.tree.length === 0) {
        await provisionCloudWorkspace(userId, userEmail || undefined, ws);
        if (!isSubscribed) return;
        cloudState = await loadCloudWorkspace(userId);
        if (!isSubscribed) return;
      }
      initialCloudFetched.current = userId;
      lastKnownCloudMs.current = Date.now();
      if (cloudState && Array.isArray(cloudState.tree) && cloudState.tree.length > 0) {
        setWs((curr) => {
          const merged = mergeWorkspaces(cloudState!, curr);
          saveWorkspace(merged);
          return merged;
        });
      }
    }).catch((err) => {
      console.warn('Dashboard loadCloudWorkspace error:', err);
    });

    return () => { isSubscribed = false; };
  }, [user, userId, userEmail]);

  // Real-time cross-device sync & cross-tab sync in Dashboard
  useEffect(() => {
    if (!userId || !user) return;
    let isSubscribed = true;

    const pullRemote = async (remoteMs: number) => {
      if (remoteMs <= lastKnownCloudMs.current) return;
      lastKnownCloudMs.current = remoteMs;
      try {
        const cloudState = await loadCloudWorkspace(userId);
        if (!isSubscribed || !cloudState) return;
        setWs((curr) => {
          const merged = mergeWorkspaces(cloudState, curr);
          saveWorkspace(merged);
          return merged;
        });
      } catch (err) {
        console.warn('Dashboard pullRemote error:', err);
      }
    };

    const unsubRealtime = subscribeToWorkspaceSync(userId, (remoteMs) => {
      pullRemote(remoteMs);
    });

    const unsubBroadcast = subscribeToBroadcastWorkspace(userId, (remoteState, remoteMs) => {
      if (remoteMs <= lastKnownCloudMs.current) return;
      lastKnownCloudMs.current = remoteMs;
      setWs((curr) => {
        const merged = mergeWorkspaces(remoteState, curr);
        saveWorkspace(merged);
        return merged;
      });
    });

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchCloudManifestMeta(userId).then((meta) => {
          if (meta && meta.updatedMs > lastKnownCloudMs.current) {
            pullRemote(meta.updatedMs);
          }
        });
      }
    };
    window.addEventListener('focus', handleVisibility);
    document.addEventListener('visibilitychange', handleVisibility);

    // Backup heartbeat only: realtime + broadcast deliver changes instantly, and
    // focus/visibility catch up after sleep. Skip while hidden/offline to save power.
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      fetchCloudManifestMeta(userId).then((meta) => {
        if (meta && meta.updatedMs > lastKnownCloudMs.current) {
          pullRemote(meta.updatedMs);
        }
      });
    }, 30000);

    return () => {
      isSubscribed = false;
      unsubRealtime();
      unsubBroadcast();
      window.removeEventListener('focus', handleVisibility);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(interval);
    };
  }, [userId, user]);

  const folders = useMemo(
    () => tree.filter((n): n is Extract<LatexRootNode, { kind: 'folder' }> => n.kind === 'folder')
      .slice().sort((a, b) => a.name.localeCompare(b.name)),
    [tree]
  );
  const rootProjects = useMemo(
    () => tree.filter((n): n is Extract<LatexRootNode, { kind: 'project' }> => n.kind === 'project'),
    [tree]
  );

  const allProjects = useMemo<FlatProject[]>(() => {
    const out: FlatProject[] = rootProjects.map((p) => ({
      id: p.id, name: p.name, fileCount: p.files.length, updatedAt: p.updatedAt, folderId: null, folderName: null,
    }));
    for (const folder of folders) {
      for (const p of folder.projects) {
        out.push({ id: p.id, name: p.name, fileCount: p.files.length, updatedAt: p.updatedAt, folderId: folder.id, folderName: folder.name });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [folders, rootProjects]);

  const searching = query.trim().length > 0;
  const normalizedQuery = query.trim().toLowerCase();

  const matchedFolders = useMemo(
    () => (searching ? folders.filter((f) => f.name.toLowerCase().includes(normalizedQuery)) : []),
    [searching, folders, normalizedQuery]
  );
  const matchedProjects = useMemo(
    () => (searching
      ? allProjects.filter((p) => p.name.toLowerCase().includes(normalizedQuery) || (p.folderName ?? '').toLowerCase().includes(normalizedQuery))
      : []),
    [searching, allProjects, normalizedQuery]
  );

  const viewedFolder = view.kind === 'folder' ? folders.find((f) => f.id === view.id) ?? null : null;
  const viewProjects = useMemo<FlatProject[]>(
    () => (view.kind === 'folder'
      ? allProjects.filter((p) => p.folderId === view.id)
      : allProjects.filter((p) => p.folderId === null)),
    [view, allProjects]
  );

  const title = searching
    ? 'Search results'
    : view.kind === 'folder'
      ? viewedFolder?.name ?? 'Your projects'
      : 'Your projects';

  // ---- Mutations -----------------------------------------------------------

  const commit = (nextTree: LatexRootNode[]) => {
    const nextWs = { ...ws, tree: nextTree };
    setWs(nextWs);
    saveWorkspace(nextWs);
    if (userId) {
      saveCloudWorkspace(userId, nextWs, userEmail || undefined)
        .then(() => {
          lastKnownCloudMs.current = Date.now();
        })
        .catch((err) => {
          console.warn('Dashboard cloud save error:', err);
        });
    }
  };

  const handleNameConfirm = (raw: string) => {
    if (!nameDialog) return;
    const { mode, targetId } = nameDialog;

    if (mode === 'new-folder') {
      const name = uniqueName(tree.filter((n) => n.kind === 'folder'), sanitizeFolderName(raw) || 'folder');
      const res = addFolder(tree, name);
      commit(res.tree);
      setView({ kind: 'folder', id: res.folder.id });
      toast.success(`Folder “${name}” created.`);
      return;
    }

    if (mode === 'new-project') {
      const folder = targetId ? tree.find((n) => n.kind === 'folder' && n.id === targetId) : null;
      const siblings = folder && folder.kind === 'folder' ? folder.projects : tree.filter((n) => n.kind === 'project');
      const name = uniqueName(siblings, sanitizeFolderName(raw) || 'Untitled project');
      const res = addProject(tree, targetId, name);
      commit(res.tree);
      setView(targetId ? { kind: 'folder', id: targetId } : { kind: 'home' });
      toast.success(`Project “${name}” created.`);
      return;
    }

    if (mode === 'rename' && targetId) {
      const clean = sanitizeFolderName(raw);
      if (clean) {
        commit(renameTreeNode(tree, targetId, clean));
        toast.success('Renamed.');
      }
    }
  };

  const executeDelete = () => {
    if (!deletePrompt) return;
    const res = removeTreeNode(tree, deletePrompt.id);
    commit(res.tree);
    if (deletePrompt.kind === 'folder' && view.kind === 'folder' && view.id === deletePrompt.id) {
      setView({ kind: 'home' });
    }
    toast.success('Deleted.');
  };

  const newProjectTarget = view.kind === 'folder' ? view.id : null;

  const renderFolderRow = (folder: { id: string; name: string; projects: unknown[] }) => (
    <div
      key={folder.id}
      className="projects-row"
      role="button"
      tabIndex={0}
      onClick={() => { setView({ kind: 'folder', id: folder.id }); setQuery(''); }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView({ kind: 'folder', id: folder.id }); setQuery(''); }
      }}
    >
      <Folder size={19} className="projects-row-icon folder" />
      <span className="projects-row-main">
        <span className="projects-row-name-line">
          <span className="projects-row-name" title={folder.name}>{folder.name}</span>
        </span>
        <span className="projects-row-meta">
          {folder.projects.length} project{folder.projects.length === 1 ? '' : 's'}
        </span>
      </span>
      <ChevronRight size={16} className="projects-row-chevron" aria-hidden="true" />
      <span className="projects-row-actions">
        <button className="projects-row-action" title="New project in this folder" aria-label={`New project in ${folder.name}`}
          onClick={(e) => { e.stopPropagation(); setNameDialog({ mode: 'new-project', targetId: folder.id, initial: 'Untitled project' }); }}>
          <Plus size={14} />
        </button>
        <button className="projects-row-action" title="Rename folder" aria-label={`Rename ${folder.name}`}
          onClick={(e) => { e.stopPropagation(); setNameDialog({ mode: 'rename', targetId: folder.id, initial: folder.name }); }}>
          <Pencil size={13} />
        </button>
        <button className="projects-row-action danger" title="Delete folder" aria-label={`Delete ${folder.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setDeletePrompt({
              kind: 'folder', id: folder.id, label: folder.name,
              extra: `${folder.projects.length} project${folder.projects.length === 1 ? '' : 's'} inside will be removed too. This cannot be undone.`,
            });
          }}>
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  );

  const handleOpenProjectWithFlush = (projectId: string) => {
    saveWorkspace(ws);
    if (userId) {
      saveCloudWorkspace(userId, ws, userEmail || undefined).catch(() => {});
    }
    onOpenProject(projectId);
  };

  const renderProjectRow = (p: FlatProject, showFolderBadge: boolean) => (
    <div
      key={p.id}
      className="projects-row"
      role="button"
      tabIndex={0}
      onClick={() => handleOpenProjectWithFlush(p.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpenProjectWithFlush(p.id); }
      }}
    >
      <BookOpen size={17} className="projects-row-icon" />
      <span className="projects-row-main">
        <span className="projects-row-name-line">
          <span className="projects-row-name" title={p.name}>{p.name}</span>
          {showFolderBadge && p.folderName && <span className="projects-row-path">{p.folderName}</span>}
        </span>
        <span className="projects-row-meta">
          {p.fileCount} file{p.fileCount === 1 ? '' : 's'} · updated {relativeTime(p.updatedAt)}
        </span>
      </span>
      <span className="projects-row-actions">
        <button className="projects-row-action" title="Open project" aria-label={`Open ${p.name}`}
          onClick={(e) => { e.stopPropagation(); handleOpenProjectWithFlush(p.id); }}>
          <ArrowRight size={14} />
        </button>
        <button className="projects-row-action" title="Rename project" aria-label={`Rename ${p.name}`}
          onClick={(e) => { e.stopPropagation(); setNameDialog({ mode: 'rename', targetId: p.id, initial: p.name }); }}>
          <Pencil size={13} />
        </button>
        <button className="projects-row-action danger" title="Delete project" aria-label={`Delete ${p.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setDeletePrompt({
              kind: 'project', id: p.id, label: p.name,
              extra: `${p.fileCount} file${p.fileCount === 1 ? '' : 's'} inside will be removed too. This cannot be undone.`,
            });
          }}>
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  );

  const nameCopy = nameDialog ? NAME_DIALOG_COPY[nameDialog.mode] : null;

  return (
    <div className="projects-page animate-fadeIn">
      <div className="projects-layout">
        <div className="projects-main">
          <header className="projects-main-head">
            <div className="projects-title-row">
              <div>
                <h1 className="projects-title">
                  {view.kind === 'folder' && !searching && (
                    <button
                      className="projects-back"
                      onClick={() => setView({ kind: 'home' })}
                      title="Back to all folders"
                      aria-label="Back to all folders"
                    >
                      <ArrowLeft size={15} />
                    </button>
                  )}
                  {title}
                </h1>
                <span className="projects-title-meta">
                  {searching
                    ? `${matchedProjects.length} project${matchedProjects.length === 1 ? '' : 's'} · ${matchedFolders.length} folder${matchedFolders.length === 1 ? '' : 's'} found`
                    : view.kind === 'folder'
                      ? `${viewProjects.length} project${viewProjects.length === 1 ? '' : 's'} in this folder`
                      : `${folders.length} folder${folders.length === 1 ? '' : 's'}${rootProjects.length ? ` · ${rootProjects.length} unfiled project${rootProjects.length === 1 ? '' : 's'}` : ''}`}
                </span>
              </div>
              <button
                className={'projects-search-toggle' + (searchOpen ? ' active' : '')}
                onClick={toggleSearch}
                aria-label={searchOpen ? 'Close search' : 'Search projects'}
                aria-expanded={searchOpen}
                title={searchOpen ? 'Close search' : 'Search projects'}
              >
                <Search size={18} />
              </button>
            </div>
            <div className="projects-head-actions">
              <div className={'projects-search' + (searchOpen ? ' open' : '')}>
                <Search size={14} />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects…"
                  aria-label="Search projects and folders"
                />
              </div>
              <button className="btn secondary btn-sm" onClick={() => setNameDialog({ mode: 'new-folder', targetId: null, initial: 'folder' })}>
                <FolderPlus size={14} />
                <span>New folder</span>
              </button>
              <button className="btn primary btn-sm" onClick={() => setNameDialog({ mode: 'new-project', targetId: newProjectTarget, initial: 'Untitled project' })}>
                <Plus size={14} />
                <span>New project</span>
              </button>
            </div>
          </header>

          <div className="projects-list">
            {searching ? (
              <>
                {matchedFolders.length > 0 && (
                  <div className="projects-group-label">Folders</div>
                )}
                {matchedFolders.map((f) => renderFolderRow(f))}
                {matchedProjects.length > 0 && (
                  <div className="projects-group-label">Projects</div>
                )}
                {matchedProjects.map((p) => renderProjectRow(p, true))}
                {matchedFolders.length === 0 && matchedProjects.length === 0 && (
                  <div className="projects-empty">
                    <Search size={28} />
                    <h2>No matches</h2>
                    <p>Nothing matches “{query.trim()}”. Try a different name.</p>
                  </div>
                )}
              </>
            ) : view.kind === 'folder' ? (
              viewedFolder ? (
                viewProjects.length > 0 ? (
                  viewProjects.map((p) => renderProjectRow(p, false))
                ) : (
                  <div className="projects-empty">
                    <Folder size={28} />
                    <h2>This folder is empty</h2>
                    <p>Create a project here to start writing.</p>
                    <button
                      className="btn primary btn-sm"
                      onClick={() => setNameDialog({ mode: 'new-project', targetId: viewedFolder.id, initial: 'Untitled project' })}
                    >
                      <Plus size={14} /><span>New project</span>
                    </button>
                  </div>
                )
              ) : (
                <div className="projects-empty">
                  <Folder size={28} />
                  <h2>Folder not found</h2>
                  <p>It may have been deleted.</p>
                </div>
              )
            ) : (
              <>
                {folders.length > 0 && <div className="projects-group-label">Folders</div>}
                {folders.map((f) => renderFolderRow(f))}
                {rootProjects.length > 0 && (
                  <div className="projects-group-label">Unfiled projects</div>
                )}
                {rootProjects.map((p) => renderProjectRow(
                  { id: p.id, name: p.name, fileCount: p.files.length, updatedAt: p.updatedAt, folderId: null, folderName: null },
                  false
                ))}
                {folders.length === 0 && rootProjects.length === 0 && (
                  <div className="projects-empty">
                    <Folder size={30} />
                    <h2>No projects yet</h2>
                    <p>Create a folder to group your work, or start a project right away — it opens in LaTeX Studio.</p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                      <button className="btn secondary btn-sm" onClick={() => setNameDialog({ mode: 'new-folder', targetId: null, initial: 'folder' })}>
                        <FolderPlus size={14} /><span>New folder</span>
                      </button>
                      <button className="btn primary btn-sm" onClick={() => setNameDialog({ mode: 'new-project', targetId: null, initial: 'Untitled project' })}>
                        <Plus size={14} /><span>New project</span>
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tools — the modes, launched from the dashboard */}
      <section className="dashboard-cards" aria-label="Tools">
        {MODE_CARDS.map((card) => (
          <button
            key={card.mode}
            className="dashboard-card"
            onClick={() => onChangeAppMode(card.mode)}
          >
            <span className={`dashboard-card-icon ch-tint-${card.tint}`}>{card.icon}</span>
            <span className="dashboard-card-body">
              <span className="dashboard-card-title">
                {card.title}
                <ArrowRight size={15} />
              </span>
              <span className="dashboard-card-desc">{card.description}</span>
            </span>
          </button>
        ))}
      </section>

      {nameDialog && nameCopy && (
        <NamePromptDialog
          title={nameCopy.title}
          label={nameCopy.label}
          confirmLabel={nameCopy.confirm}
          initial={nameDialog.initial}
          onConfirm={handleNameConfirm}
          onClose={() => setNameDialog(null)}
        />
      )}

      {deletePrompt && (
        <ConfirmDialog
          title={`Delete “${deletePrompt.label}”?`}
          message={deletePrompt.extra || 'This cannot be undone.'}
          confirmLabel="Delete"
          danger
          onConfirm={executeDelete}
          onClose={() => setDeletePrompt(null)}
        />
      )}
    </div>
  );
}
