import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  Code2,
  Download,
  ExternalLink,
  Play,
  RefreshCw,
  Zap,
  Eraser,
  FileCode2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderPlus,
  FolderInput,
  FolderOpen,
  Eye,
  Pencil,
  Trash2,
  PanelLeft,
  Plus,
  BookOpen,
  GripVertical,
  FolderArchive,
  LogIn,
  LogOut,
  UserPlus,
  Cloud,
  Check,
  RotateCw,
  ShieldCheck,
  User,
  Sparkles,
} from 'lucide-react';
import { useToast } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { useDialog } from '../hooks/useDialog';
import { compileLaTeX, LaTeXCompileError } from '../lib/latexCompiler';
import { newActivityId } from '../lib/activityTracker';
import { recordAndSyncActivity } from '../lib/activityCloud';
import { LaTeXPdfViewer } from './LaTeXPdfViewer';
import { LaTeXRepairAssistant } from './LaTeXRepairAssistant';
import { hasFatalTexError, repairSignature, type LatexAutoRepairResult, type LatexDiagnostic } from '../lib/latexRepair';
import { ImportWorkspaceModal } from './ImportWorkspaceModal';
import { AuthModal } from './AuthModal';
import { UserProfile } from './UserProfile';
import { useAuth } from '../contexts/AuthContext';
import { validateOfficialEmail } from '../lib/emailValidation';
import {
  loadCloudWorkspace,
  saveCloudWorkspace,
  mergeWorkspaces,
  provisionCloudWorkspace,
  fetchCloudManifestMeta,
  subscribeToWorkspaceSync,
  subscribeToBroadcastWorkspace,
} from '../lib/workspaceCloudSync';
import {
  ExtractedCodeFile,
  IntegrationOptions,
  integrateFilesIntoWorkspace,
  extractFromDataTransfer,
} from '../lib/archiveImporter';

import { downloadBlob } from '../lib/zipPackager';
import {
  LatexRootNode,
  LatexWorkspaceState,
  FlatFile,
  addFile,
  addFolder,
  addProject,
  allFiles,
  DEFAULT_BLANK_LATEX,
  findFileLocation,
  findProject,
  firstFileId,
  moveFile,
  moveProject,
  loadWorkspace,
  projectCount,
  removeTreeNode,
  renameTreeNode,
  sanitizeFileName,
  sanitizeFolderName,
  sanitizeZipName,
  saveWorkspace,
  uniqueName,
  updateFileContent,
} from '../lib/latexProjects';

import { LATEX_AUTOCOMPILE_KEY, LATEX_AUTOCOMPILE_EVENT } from '../lib/latexPrefs';
const AUTOCOMPILE_DEBOUNCE_MS = 1800;
const SPLIT_KEY = 'pdf-studio-latex-split';
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;
const SPLIT_DEFAULT = 0.5;
const SIDE_W_KEY = 'pdf-studio-latex-side-w';
const SIDE_MIN = 180;
const SIDE_MAX = 420;
const SIDE_DEFAULT = 248;

const clampSplit = (ratio: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
const clampSide = (px: number) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, px));

type NameDialogMode = 'new-project' | 'new-folder' | 'new-file' | 'rename-node';

interface NameDialogState {
  mode: NameDialogMode;
  /** For new-project: the folder to create inside (null = workspace root). For new-file: the project id. */
  targetId: string | null;
  initial: string;
}

const NAME_DIALOG_COPY: Record<NameDialogMode, { title: string; label: string; confirm: string }> = {
  'new-project': { title: 'New project', label: 'Project name', confirm: 'Create' },
  'new-folder': { title: 'New folder', label: 'Folder name', confirm: 'Create' },
  'new-file': { title: 'New LaTeX file', label: 'File name (.tex added automatically)', confirm: 'Create' },
  'rename-node': { title: 'Rename', label: 'New name', confirm: 'Rename' },
};

interface BatchState {
  done: number;
  total: number;
  current: string;
}

/** Small modal prompt used for creating/renaming projects, folders and files. */
function NamePromptDialog({ title, label, confirmLabel, initial, onConfirm, onClose }: {
  title: string;
  label: string;
  confirmLabel: string;
  initial: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {  const ref = useDialog(onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);

  useEffect(() => { inputRef.current?.select(); }, []);

  const submit = () => {
    if (!value.trim()) return;
    onConfirm(value.trim());
    onClose();
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 70 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="modal-panel sm latex-name-dialog" role="dialog" aria-modal="true" aria-labelledby="latex-name-title" tabIndex={-1}>
        <h2 id="latex-name-title">{title}</h2>
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

/** Destination options for the Move dialog: { id: null } means workspace root. */
interface MoveTarget { id: string | null; label: string }

/** Modal for moving a file to another project, or a project to another folder/root.
 *  Works with taps and clicks alike — unlike HTML5 drag-and-drop, which never
 *  fires on touch devices. */
function MoveNodeDialog({ title, targets, emptyMessage, onConfirm, onClose }: {
  title: string;
  targets: MoveTarget[];
  emptyMessage: string;
  onConfirm: (targetId: string | null) => void;
  onClose: () => void;
}) {
  const ref = useDialog(onClose);
  const [selected, setSelected] = useState<string>(() => (targets[0] ? String(targets[0].id) : ''));

  const submit = () => {
    const target = targets.find((t) => String(t.id) === selected);
    if (!target) return;
    onConfirm(target.id);
    onClose();
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 70 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="modal-panel sm latex-name-dialog" role="dialog" aria-modal="true" aria-labelledby="latex-move-title" tabIndex={-1}>
        <h2 id="latex-move-title">{title}</h2>
        {targets.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--secondary)' }}>{emptyMessage}</p>
        ) : (
          <label>
            Move to
            <select value={selected} onChange={(e) => setSelected(e.target.value)} autoFocus>
              {targets.map((t) => (
                <option key={String(t.id)} value={String(t.id)}>{t.label}</option>
              ))}
            </select>
          </label>
        )}
        <footer>
          <button className="btn quiet" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={targets.length === 0}>Move</button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Overleaf-style LaTeX workspace: a draggable tree of folders → projects →
 * .tex files, a source editor, and a compiled PDF preview. Compiles via the
 * app server when a TeX engine is available, otherwise through a public web
 * compilation service.
 */
// Tracks a CSS media query reactively (used for the mobile pane switcher)
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function LaTeXStudio({ initialProjectId, autoRepair = true }: { initialProjectId?: string | null; autoRepair?: boolean }) {
  const autoRepairRef = useRef(autoRepair);
  autoRepairRef.current = autoRepair;
  const toast = useToast();
  const isNarrow = useMediaQuery('(max-width: 900px)');

  // ---- Workspace ----------------------------------------------------------
  // When opened from the dashboard on a specific project, land on that
  // project's first file (creating one if the project is somehow empty).
  const [ws, setWs] = useState<LatexWorkspaceState>(() => {
    const state = loadWorkspace();
    if (!initialProjectId) return state;
    const project = findProject(state.tree, initialProjectId);
    if (!project) return state;
    if (project.files.length > 0) {
      return { tree: state.tree, activeFileId: project.files[0].id };
    }
    const res = addFile(state.tree, project.id, 'main.tex', DEFAULT_BLANK_LATEX);
    return { tree: res.tree, activeFileId: res.file.id };
  });
  const tree = ws.tree;
  // When opened from the dashboard on a specific project, the sidebar shows
  // only that project's files — never the other folders and projects.
  const scopedProject = useMemo(
    () => (initialProjectId ? findProject(tree, initialProjectId) : null),
    [tree, initialProjectId]
  );
  const sidebarTree = useMemo<LatexRootNode[]>(
    () => (scopedProject ? [scopedProject] : tree),
    [scopedProject, tree]
  );
  const location = ws.activeFileId ? findFileLocation(tree, ws.activeFileId) : null;
  const activeFile = location?.file ?? null;
  const activeProject = location?.project ?? null;
  const activeContent = activeFile?.content ?? '';
  const docName = activeFile?.name ?? 'No file open';

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    for (const node of tree) { ids.add(node.id); if (node.kind === 'folder') node.projects.forEach((p) => ids.add(p.id)); }
    return ids;
  });
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [sideOpen, setSideOpen] = useState(true);

  // Mobile (<900px): one studio pane at a time, switched by tabs
  const [mobilePane, setMobilePane] = useState<'files' | 'editor' | 'preview'>('editor');

  // Drag-and-drop state (projects ↔ folders, files ↔ projects)
  const [dragNode, setDragNode] = useState<{ type: 'project' | 'file'; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ kind: 'folder' | 'project' | 'root'; id: string | null } | null>(null);

  // ---- Compile state -------------------------------------------------------
  const [autoCompile, setAutoCompile] = useState<boolean>(() => {
    try { return localStorage.getItem(LATEX_AUTOCOMPILE_KEY) === '1'; } catch { return false; }
  });
  // Follow auto-compile changes made in Settings while the studio is open
  useEffect(() => {
    const sync = (e: Event) => setAutoCompile(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener(LATEX_AUTOCOMPILE_EVENT, sync);
    return () => window.removeEventListener(LATEX_AUTOCOMPILE_EVENT, sync);
  }, []);
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY));
      return Number.isFinite(v) && v >= SPLIT_MIN && v <= SPLIT_MAX ? v : SPLIT_DEFAULT;
    } catch { return SPLIT_DEFAULT; }
  });
  const [sideWidth, setSideWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(SIDE_W_KEY));
      return Number.isFinite(v) && v >= SIDE_MIN && v <= SIDE_MAX ? v : SIDE_DEFAULT;
    } catch { return SIDE_DEFAULT; }
  });
  const [draggingSplit, setDraggingSplit] = useState(false);

  const [compiling, setCompiling] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfSize, setPdfSize] = useState(0);
  const [engine, setEngine] = useState<string | null>(null);
  const [via, setVia] = useState<'server' | 'web' | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [compileError, setCompileError] = useState<LatexDiagnostic | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [repairRunId, setRepairRunId] = useState(0);
  const [repairing, setRepairing] = useState(false);
  const activeSignature = repairSignature(activeFile?.id ?? '', activeProject?.files ?? []);
  const [showLog, setShowLog] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [dragImportFiles, setDragImportFiles] = useState<{ files: ExtractedCodeFile[]; source: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [moveDialog, setMoveDialog] = useState<{ type: 'file' | 'project'; id: string } | null>(null);
  const [deletePrompt, setDeletePrompt] = useState<{ kind: 'folder' | 'project' | 'file' | 'selection'; id: string; label: string; extra?: string } | null>(null);

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const pdfUrlRef = useRef<string | null>(null);
  const compileSeq = useRef(0);
  const lastActivityRecordAt = useRef(0);
  const autoTimer = useRef<number | null>(null);
  const lastCompiled = useRef<string | null>(null);
  // Track file opens and edits without retriggering after a finished compile.
  const lastSeenContent = useRef<{ fileId: string; content: string } | null>(null);
  const lastFileIdRef = useRef<string | null>(ws.activeFileId);
  const dragTarget = useRef<'side' | 'main' | null>(null);

  // ---- Authentication & Cloud Sync -----------------------------------------
  const { user, signOut } = useAuth();
  const userId = user ? ('uid' in user ? user.uid : (user as any).id) : null;
  const userEmail = user?.email ?? null;
  const userDisplayName = user ? ('displayName' in user ? user.displayName : (user as any).user_metadata?.full_name) : null;
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'signin' | 'signup'>('signin');
  const [cloudSyncStatus, setCloudSyncStatus] = useState<'synced' | 'syncing' | 'error' | 'local' | 'loading'>(user ? 'synced' : 'local');
  const [lastSyncedTime, setLastSyncedTime] = useState<Date | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  // Fixed viewport position for the account popover, computed when it opens:
  // horizontally centered on the account chip (clamped to the viewport).
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [userProfileOpen, setUserProfileOpen] = useState(false);
  const initialCloudFetched = useRef<string | null>(null);
  const lastKnownCloudMs = useRef<number>(0);
  const lastTypingTime = useRef<number>(0);
  const lastCloudSaveTime = useRef<number>(0);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const cloudSaveTimer = useRef<number | null>(null);

  const userDomainInfo = useMemo(() => {
    if (!user?.email) return null;
    return validateOfficialEmail(user.email);
  }, [user?.email]);

  // Measure the account chip and center the popover under it, clamped so it
  // never leaves the viewport. Uses position:fixed so no ancestor overflow
  // can clip it, on desktop and phones alike.
  const placeAccountMenu = useCallback(() => {
    const el = accountMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.min(270, window.innerWidth - 16);
    const targetCenter = rect.left + rect.width / 2;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, targetCenter - width / 2));
    setMenuPos({ left, top: rect.bottom + 6, width });
  }, []);

  // Close account menu on click outside
  useEffect(() => {
    if (!accountMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [accountMenuOpen]);

  // Close create menu on click outside or Escape
  useEffect(() => {
    if (!createMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCreateMenuOpen(false);
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [createMenuOpen]);

  // Load cloud workspace automatically when user logs in
  useEffect(() => {
    if (!user) {
      initialCloudFetched.current = null;
      setCloudSyncStatus('local');
      return;
    }

    if (!userId) return;
    if (initialCloudFetched.current === userId) return;

    let isSubscribed = true;
    const fetchUserWorkspace = async () => {
      setCloudSyncStatus('loading');
      try {
        let cloudState = await loadCloudWorkspace(userId);
        if (!isSubscribed) return;

        if (!cloudState || !Array.isArray(cloudState.tree) || cloudState.tree.length === 0) {
          // First login (or brand-new account): provision the user's cloud
          // workspace from whatever they have locally.
          await provisionCloudWorkspace(userId, userEmail || undefined, wsRef.current);
          if (!isSubscribed) return;
          cloudState = await loadCloudWorkspace(userId);
          if (!isSubscribed) return;
        }

        // Mark cloud ready ONLY after successful retrieval
        initialCloudFetched.current = userId;
        lastKnownCloudMs.current = Date.now();

        if (cloudState && Array.isArray(cloudState.tree) && cloudState.tree.length > 0) {
          // Intelligent merge: newer timestamps and renames win per node
          setWs((currentLocal) => {
            const merged = mergeWorkspaces(cloudState!, currentLocal);
            saveWorkspace(merged);
            return merged;
          });
          toast.success(`Retrieved projects (${userEmail || 'cloud'}).`);
        } else {
          toast.success('Workspace synchronized.');
        }

        if (isSubscribed) {
          setCloudSyncStatus('synced');
          setLastSyncedTime(new Date());
        }
      } catch (err: any) {
        console.warn('Cloud workspace load failed (working locally):', err);
        if (isSubscribed) {
          setCloudSyncStatus('error');
        }
      }
    };

    fetchUserWorkspace();

    return () => {
      isSubscribed = false;
    };
  }, [user, userId, userEmail, toast]);

  // ---- Persistence (debounced local save + debounced cloud sync) -------------
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const saveTimer = useRef<number | null>(null);

  /**
   * Pushes the current workspace to the user's cloud file documents.
   * On failure it sets an honest 'error' status and schedules automatic retries.
   */
  const cloudRetryTimer = useRef<number | null>(null);
  const cloudBackoffMs = useRef(2000);

  const persistDocumentAndWorkspaceToFirestore = useCallback(
    async (overrideWs?: LatexWorkspaceState): Promise<boolean> => {
      if (!userId) {
        setCloudSyncStatus('local');
        return false;
      }
      const targetState = overrideWs || wsRef.current;
      if (cloudRetryTimer.current) {
        window.clearTimeout(cloudRetryTimer.current);
        cloudRetryTimer.current = null;
      }
      setCloudSyncStatus('syncing');
      try {
        await saveCloudWorkspace(userId, targetState, userEmail || undefined);
        lastKnownCloudMs.current = Date.now();
        setCloudSyncStatus('synced');
        setLastSyncedTime(new Date());
        cloudBackoffMs.current = 2000;
        return true;
      } catch (err) {
        console.warn('Cloud sync failed; retrying automatically:', err);
        setCloudSyncStatus('error');
        const delay = cloudBackoffMs.current;
        cloudBackoffMs.current = Math.min(cloudBackoffMs.current * 2, 60000);
        cloudRetryTimer.current = window.setTimeout(() => {
          persistDocumentAndWorkspaceToFirestore(targetState).catch(() => {});
        }, delay);
        return false;
      }
    },
    [userId, userEmail]
  );

  // ---- Real-time cross-device sync & cross-tab sync -------------------------
  useEffect(() => {
    if (!userId || !user) return;

    let isSubscribed = true;

    const pullRemoteChanges = async (remoteMs: number, showToast = true) => {
      if (remoteMs <= lastKnownCloudMs.current) return;
      lastKnownCloudMs.current = remoteMs;

      try {
        const cloudState = await loadCloudWorkspace(userId);
        if (!isSubscribed || !cloudState) return;

        setWs((currentLocal) => {
          // If the user has typed recently in the active file, protect that file's text in memory
          const isTypingActive = Date.now() - lastTypingTime.current < 2000;
          const merged = mergeWorkspaces(cloudState, currentLocal);

          if (isTypingActive && currentLocal.activeFileId) {
            const activeLoc = findFileLocation(currentLocal.tree, currentLocal.activeFileId);
            if (activeLoc) {
              const protectedTree = updateFileContent(merged.tree, currentLocal.activeFileId, activeLoc.file.content);
              saveWorkspace({ ...merged, tree: protectedTree });
              return { ...merged, tree: protectedTree, activeFileId: currentLocal.activeFileId };
            }
          }

          saveWorkspace(merged);
          return merged;
        });

        setCloudSyncStatus('synced');
        setLastSyncedTime(new Date());
        if (showToast) {
          toast.success('Workspace updated from another device.');
        }
      } catch (err) {
        console.warn('Failed to pull remote workspace changes:', err);
      }
    };

    // 1. Supabase Postgres Realtime subscription
    const unsubRealtime = subscribeToWorkspaceSync(userId, (updatedMs) => {
      pullRemoteChanges(updatedMs, true);
    });

    // 2. BroadcastChannel for other tabs in this browser
    const unsubBroadcast = subscribeToBroadcastWorkspace(userId, (remoteState, updatedMs) => {
      if (updatedMs <= lastKnownCloudMs.current) return;
      lastKnownCloudMs.current = updatedMs;
      setWs((currentLocal) => {
        const isTypingActive = Date.now() - lastTypingTime.current < 2000;
        const merged = mergeWorkspaces(remoteState, currentLocal);
        if (isTypingActive && currentLocal.activeFileId) {
          const activeLoc = findFileLocation(currentLocal.tree, currentLocal.activeFileId);
          if (activeLoc) {
            const protectedTree = updateFileContent(merged.tree, currentLocal.activeFileId, activeLoc.file.content);
            saveWorkspace({ ...merged, tree: protectedTree });
            return { ...merged, tree: protectedTree, activeFileId: currentLocal.activeFileId };
          }
        }
        saveWorkspace(merged);
        return merged;
      });
      setCloudSyncStatus('synced');
      setLastSyncedTime(new Date());
    });

    // 3. Tab visibility / window focus check
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchCloudManifestMeta(userId).then((meta) => {
          if (meta && meta.updatedMs > lastKnownCloudMs.current) {
            pullRemoteChanges(meta.updatedMs, true);
          }
        });
      }
    };
    window.addEventListener('focus', handleVisibility);
    document.addEventListener('visibilitychange', handleVisibility);

    // 4. Polling heartbeat every 6 seconds as backup for mobile sleep/network changes
    const interval = window.setInterval(() => {
      fetchCloudManifestMeta(userId).then((meta) => {
        if (meta && meta.updatedMs > lastKnownCloudMs.current) {
          pullRemoteChanges(meta.updatedMs, true);
        }
      });
    }, 6000);

    return () => {
      isSubscribed = false;
      unsubRealtime();
      unsubBroadcast();
      window.removeEventListener('focus', handleVisibility);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(interval);
    };
  }, [userId, user, toast]);

  // Debounced auto-save with max-wait
  useEffect(() => {
    // Local persistence is always instantaneous
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveWorkspace(ws), 300);

    // If user is authenticated and cloud workspace is initialized
    if (userId && initialCloudFetched.current === userId) {
      setCloudSyncStatus('syncing');
      if (cloudSaveTimer.current) window.clearTimeout(cloudSaveTimer.current);

      const timeSinceLastPush = Date.now() - lastCloudSaveTime.current;
      // If continuous typing > 2500ms, push immediately to avoid starving cloud
      const debounceDelay = timeSinceLastPush > 2500 ? 100 : 750;

      cloudSaveTimer.current = window.setTimeout(async () => {
        lastCloudSaveTime.current = Date.now();
        await persistDocumentAndWorkspaceToFirestore(ws);
      }, debounceDelay);
    } else if (!user) {
      setCloudSyncStatus('local');
    }

    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (cloudSaveTimer.current) window.clearTimeout(cloudSaveTimer.current);
    };
  }, [ws, userId, user, persistDocumentAndWorkspaceToFirestore]);

  useEffect(() => () => {
    saveWorkspace(wsRef.current);
    if (cloudRetryTimer.current) window.clearTimeout(cloudRetryTimer.current);
    if (user) {
      persistDocumentAndWorkspaceToFirestore(wsRef.current).catch(() => {});
    }
  }, [user, persistDocumentAndWorkspaceToFirestore]);

  // Flush pending saves when the tab is hidden or closed.
  useEffect(() => {
    const flushPendingSave = () => {
      saveWorkspace(wsRef.current);
      if (user) {
        persistDocumentAndWorkspaceToFirestore(wsRef.current).catch(() => {});
      }
    };
    const onPageHide = () => flushPendingSave();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushPendingSave();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [user, persistDocumentAndWorkspaceToFirestore]);

  const handleManualCloudSync = async () => {
    if (!user) {
      setAuthModalMode('signin');
      setAuthModalOpen(true);
      return;
    }
    const ok = await persistDocumentAndWorkspaceToFirestore(ws);
    if (ok) {
      toast.success('All projects successfully synced to cloud.');
    } else {
      toast.error('Failed to sync to cloud.');
    }
  };


  useEffect(() => {
    try { localStorage.setItem(LATEX_AUTOCOMPILE_KEY, autoCompile ? '1' : '0'); } catch { /* ignore */ }
  }, [autoCompile]);

  useEffect(() => {
    try { localStorage.setItem(SPLIT_KEY, String(splitRatio)); } catch { /* ignore */ }
  }, [splitRatio]);

  useEffect(() => {
    try { localStorage.setItem(SIDE_W_KEY, String(sideWidth)); } catch { /* ignore */ }
  }, [sideWidth]);

  // Release the previous object URL whenever it is replaced or on unmount
  useEffect(() => () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); }, []);

  // ---- Workspace invariants ------------------------------------------------
  // Drop a stale activeFileId (e.g. after deleting the open file).
  useEffect(() => {
    if (ws.activeFileId && findFileLocation(tree, ws.activeFileId)) return;
    const next = firstFileId(tree);
    if (next !== ws.activeFileId) setWs((prev) => ({ ...prev, activeFileId: next }));
  }, [tree, ws.activeFileId]);

  // Drop selections that no longer exist.
  useEffect(() => {
    const ids = new Set(allFiles(tree).map((f) => f.id));
    setSelectedFileIds((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tree]);

  // Switching files invalidates the previous preview.
  useEffect(() => {
    if (lastFileIdRef.current === ws.activeFileId) return;
    lastFileIdRef.current = ws.activeFileId;
    compileSeq.current++;
    setCompiling(false);
    setCompileError(null);
    setShowLog(false);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
    setPdfUrl(null);
    setPdfBlob(null);
    setPdfSize(0);
    setEngine(null);
    setVia(null);
    setDurationMs(null);
    lastCompiled.current = null;
  }, [ws.activeFileId]);

  // ---- Content edits ---------------------------------------------------------
  const updateActiveContent = useCallback((content: string) => {
    if (!ws.activeFileId) return;
    lastTypingTime.current = Date.now();
    setWs((prev) => ({ ...prev, tree: updateFileContent(prev.tree, prev.activeFileId as string, content) }));
  }, [ws.activeFileId]);

  const completeAssistantRepair = (result: LatexAutoRepairResult, expectedSignature: string): boolean => {
    const current = wsRef.current;
    const target = current.activeFileId ? findFileLocation(current.tree, current.activeFileId) : null;
    if (!target || repairSignature(target.file.id, target.project.files) !== expectedSignature) return false;
    let pdf: Blob | null = null;
    if (result.success) {
      if (!result.pdfBase64) return false;
      const bytes = Uint8Array.from(atob(result.pdfBase64), character => character.charCodeAt(0));
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') return false;
      pdf = new Blob([bytes], { type: 'application/pdf' });
    }
    compileSeq.current++;
    const next = { ...current, tree: updateFileContent(current.tree, target.file.id, result.source) };
    wsRef.current = next;
    setWs(next);
    lastCompiled.current = result.source;
    lastSeenContent.current = { fileId: target.file.id, content: result.source };
    if (autoTimer.current) window.clearTimeout(autoTimer.current);
    setCompiling(false);
    if (pdf) {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(pdf);
      pdfUrlRef.current = url;
      setPdfUrl(url);
      setPdfBlob(pdf);
      setPdfSize(pdf.size);
      setEngine(result.engine || 'pdflatex');
      setVia(result.via === 'remote' ? 'web' : 'server');
      setDurationMs(result.durationMs);
      setCompileError(null);
      setShowLog(false);
      toast.success(result.message);
    } else {
      const updated = findFileLocation(next.tree, target.file.id);
      setCompileError({ message: result.message, log: result.log, fileId: target.file.id,
        signature: repairSignature(target.file.id, updated?.project.files ?? []), repairable: Boolean(result.log.trim()) });
    }
    return true;
  };

  // ---- Compile ------------------------------------------------------------
  const runCompile = useCallback(async () => {
    if (repairing) return;
    if (!activeFile) { toast.error('Create or select a .tex file first.'); return; }
    if (!activeContent.trim()) { toast.error('Nothing to compile — the open file is empty.'); return; }

    const seq = ++compileSeq.current;
    setRepairRunId(0);
    lastCompiled.current = activeContent;
    setCompiling(true);
    setShowLog(false);
    try {
      const otherFiles = activeProject?.files
        ? activeProject.files.filter((f) => f.id !== activeFile.id).map((f) => ({ name: f.name, content: f.content }))
        : undefined;
      const result = await compileLaTeX(activeContent, otherFiles);
      if (seq !== compileSeq.current) return; // a newer compile superseded this one
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(result.pdf);
      pdfUrlRef.current = url;
      setPdfBlob(result.pdf);
      setPdfUrl(url);
      setPdfSize(result.pdf.size);
      setEngine(result.engine);
      setVia(result.via);
      setDurationMs(result.durationMs);
      setCompileError(null);
      // Dashboard activity: auto-compile fires on every editing pause, so only
      // record at most one successful compile per file per 10 minutes.
      const now = Date.now();
      if (activeFile && now - lastActivityRecordAt.current >= 10 * 60_000) {
        lastActivityRecordAt.current = now;
        void recordAndSyncActivity({
          id: newActivityId(),
          mode: 'latex-studio',
          fileName: activeFile.name,
          timestamp: now,
          durationMs: result.durationMs,
          status: 'success',
        });
      }
    } catch (err) {
      if (seq !== compileSeq.current) return;
      const latexErr = err instanceof LaTeXCompileError ? err : null;
      const repairable = Boolean(latexErr && latexErr.via !== 'none' && latexErr.log.trim());
      setCompileError({
        message: latexErr?.message || (err instanceof Error ? err.message : 'Compilation failed.'),
        log: latexErr?.log || '',
        fileId: activeFile.id,
        signature: repairSignature(activeFile.id, activeProject?.files ?? []),
        repairable,
      });
      setShowLog(false);
      const current = wsRef.current;
      const latest = current.activeFileId ? findFileLocation(current.tree, current.activeFileId) : null;
      if (repairable && hasFatalTexError(latexErr?.log ?? '') && latest && repairSignature(latest.file.id, latest.project.files) === repairSignature(activeFile.id, activeProject?.files ?? [])) {
        setAssistantOpen(true);
        if (autoRepairRef.current) setRepairRunId(seq);
      }
      if (!repairable) toast.error(latexErr && latexErr.via === 'none'
        ? 'No LaTeX compiler available.'
        : 'Compilation is unavailable. Open Repair status for details.');
    } finally {
      if (seq === compileSeq.current) setCompiling(false);
    }
  }, [activeContent, activeFile, activeProject, toast, repairing]);

  // File opens compile immediately; edits retain the typing debounce. Busy work
  // leaves the previous observation intact so pending changes are handled later.
  useEffect(() => {
    if (!activeFile) { lastSeenContent.current = null; return; }
    const prev = lastSeenContent.current;
    if (compiling || batch || repairing) return;
    const isFileOpen = !prev || prev.fileId !== activeFile.id;
    const isEdit = !isFileOpen && prev.content !== activeContent;
    lastSeenContent.current = { fileId: activeFile.id, content: activeContent };
    if (!autoCompile || (!isFileOpen && !isEdit)) return;
    if (!activeContent.trim() || activeContent === lastCompiled.current) return;
    if (autoTimer.current) window.clearTimeout(autoTimer.current);
    if (isFileOpen) {
      void runCompile();
      return;
    }
    autoTimer.current = window.setTimeout(() => { runCompile(); }, AUTOCOMPILE_DEBOUNCE_MS);
    return () => { if (autoTimer.current) window.clearTimeout(autoTimer.current); };
  }, [activeContent, activeFile, autoCompile, compiling, batch, repairing, runCompile]);

  // ---- Name dialog actions ---------------------------------------------------
  const handleNameConfirm = (raw: string) => {
    if (!nameDialog) return;
    const { mode, targetId } = nameDialog;

    if (mode === 'new-project') {
      const folder = targetId ? tree.find((n) => n.kind === 'folder' && n.id === targetId) : null;
      const siblings = folder && folder.kind === 'folder' ? folder.projects : tree.filter((n) => n.kind === 'project');
      const name = uniqueName(siblings, sanitizeFolderName(raw) || `Project ${projectCount(tree) + 1}`);
      const res = addProject(tree, targetId, name);
      const nextWs: LatexWorkspaceState = { ...ws, tree: res.tree, activeFileId: res.project.files[0].id };
      setWs(nextWs);
      saveWorkspace(nextWs);
      persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});
      if (targetId) setExpandedIds((prev) => new Set(prev).add(targetId));
      toast.success(`Project “${name}” created.`);
      return;
    }

    if (mode === 'new-folder') {
      const name = uniqueName(tree.filter((n) => n.kind === 'folder'), sanitizeFolderName(raw) || 'folder');
      const res = addFolder(tree, name);
      const nextWs: LatexWorkspaceState = { ...ws, tree: res.tree };
      setWs(nextWs);
      saveWorkspace(nextWs);
      persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});
      setExpandedIds((prev) => new Set(prev).add(res.folder.id));
      toast.success(`Folder “${name}” created.`);
      return;
    }

    if (mode === 'new-file' && targetId) {
      const project = findProjectNode(tree, targetId);
      if (!project) return;
      const name = uniqueName(project.files, sanitizeFileName(raw) || 'untitled.tex');
      const res = addFile(tree, targetId, name);
      const nextWs: LatexWorkspaceState = { ...ws, tree: res.tree, activeFileId: res.file.id };
      setWs(nextWs);
      saveWorkspace(nextWs);
      persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});
      setExpandedIds((prev) => new Set(prev).add(targetId));
      toast.success(`${name} created.`);
      return;
    }

    if (mode === 'rename-node' && targetId) {
      const info = nodeKindAndName(tree, targetId);
      if (!info) return;
      const clean = info.kind === 'file' ? (sanitizeFileName(raw) || info.name) : (sanitizeFolderName(raw) || info.name);
      const nextWs: LatexWorkspaceState = { ...ws, tree: renameTreeNode(ws.tree, targetId, clean) };
      setWs(nextWs);
      saveWorkspace(nextWs);
      persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});
      toast.success(`Renamed to “${clean}”.`);
      return;
    }
  };

  const executeDelete = () => {
    if (!deletePrompt) return;
    if (deletePrompt.kind === 'selection') {
      // Multi-select delete: remove every checked file in one pass.
      let nextTree = tree;
      const removed = new Set<string>();
      for (const id of selectedFileIds) {
        const res = removeTreeNode(nextTree, id);
        nextTree = res.tree;
        res.removedFileIds.forEach((x) => removed.add(x));
      }
      const nextWs: LatexWorkspaceState = {
        ...ws,
        tree: nextTree,
        ...(ws.activeFileId && removed.has(ws.activeFileId) ? { activeFileId: null } : {}),
      };
      setWs(nextWs);
      saveWorkspace(nextWs);
      persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});
      setSelectedFileIds(new Set());
      toast.success(`${removed.size} file${removed.size === 1 ? '' : 's'} deleted.`);
      return;
    }
    const res = removeTreeNode(tree, deletePrompt.id);
    const nextTree = res.tree;
    const nextWs: LatexWorkspaceState = {
      ...ws,
      tree: nextTree,
      ...(ws.activeFileId && res.removedFileIds.has(ws.activeFileId) ? { activeFileId: null } : {}),
    };
    setWs(nextWs);
    saveWorkspace(nextWs);
    persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});
    setSelectedFileIds((prev) => new Set([...prev].filter((x) => !res.removedFileIds.has(x))));
    toast.success('Deleted.');
  };

  // ---- Archive, Folder & File Import ------------------------------------------
  const handleWorkspaceImport = useCallback(
    (files: ExtractedCodeFile[], options: IntegrationOptions) => {
      const res = integrateFilesIntoWorkspace(ws.tree, files, options);
      if (res.importedCount === 0) return;

      const nextWs: LatexWorkspaceState = {
        ...ws,
        tree: res.tree,
        activeFileId: res.activeFileId || ws.activeFileId,
      };
      setWs(nextWs);
      saveWorkspace(nextWs);
      persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});

      if (res.affectedProjectId) {
        setExpandedIds((prev) => new Set(prev).add(res.affectedProjectId!));
      }

      toast.success(`Imported ${res.importedCount} file${res.importedCount === 1 ? '' : 's'} into workspace.`);
    },
    [ws, toast, persistDocumentAndWorkspaceToFirestore]
  );

  const readTexFile = useCallback((file: File) => {
    if (!/\.tex$/i.test(file.name)) {
      toast.error('Please choose a .tex source file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const wanted = sanitizeFileName(file.name) || 'imported.tex';

      // Pick the active project, else the first one, else create a new one.
      let targetId: string | null = activeProject?.id ?? null;
      if (!targetId) {
        for (const node of tree) {
          const candidates = node.kind === 'project' ? [node] : node.projects;
          if (candidates.length > 0) { targetId = candidates[0].id; break; }
        }
      }

      let nextTree: LatexRootNode[];
      let fileId: string;
      let projectName: string;
      if (!targetId) {
        // New project: the imported source becomes its main.tex
        const created = addProject(tree, null, 'Imported project');
        fileId = created.project.files[0].id;
        nextTree = updateFileContent(created.tree, fileId, text);
        projectName = created.project.name;
        targetId = created.project.id;
      } else {
        const project = findProjectNode(tree, targetId);
        const name = uniqueName(project?.files ?? [], wanted);
        const res = addFile(tree, targetId, name, text);
        nextTree = res.tree;
        fileId = res.file.id;
        projectName = project?.name ?? 'project';
      }

      const nextWs: LatexWorkspaceState = { ...ws, tree: nextTree, activeFileId: fileId };
      setWs(nextWs);
      saveWorkspace(nextWs);
      persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});
      setExpandedIds((prev) => new Set(prev).add(targetId as string));
      toast.success(`Imported into “${projectName}”.`);
    };
    reader.onerror = () => toast.error('Could not read that file.');
    reader.readAsText(file);
  }, [activeProject, tree, ws, toast, persistDocumentAndWorkspaceToFirestore]);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer) return;

    try {
      const res = await extractFromDataTransfer(e.dataTransfer);
      if (res.files.length > 0) {
        setDragImportFiles({ files: res.files, source: res.sourceName });
        setImportModalOpen(true);
        return;
      }
    } catch {
      // Fallback to legacy single file
    }

    const file = e.dataTransfer.files?.[0];
    if (file && /\.tex$/i.test(file.name)) {
      readTexFile(file);
    }
  };

  // ---- Editor -----------------------------------------------------------------
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runCompile();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: t } = el;
      const next = activeContent.slice(0, s) + '  ' + activeContent.slice(t);
      updateActiveContent(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
    }
  };

  const syncGutter = () => {
    if (gutterRef.current && editorRef.current) {
      gutterRef.current.scrollTop = editorRef.current.scrollTop;
    }
  };

  // ---- Exports ------------------------------------------------------------------
  const handleDownloadPdf = () => {
    if (!pdfUrl || !activeFile) return;
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = activeFile.name.replace(/\.tex$/i, '') + '.pdf';
    a.click();
    toast.success('PDF downloaded.');
  };

  const handleDownloadTex = () => {
    if (!activeFile) return;
    const blob = new Blob([activeContent], { type: 'text/x-tex' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = activeFile.name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const handleOpenPdfTab = () => {
    if (!pdfUrl) return;
    const win = window.open(pdfUrl, '_blank', 'noopener,noreferrer');
    if (!win) toast.error('The browser blocked the new tab — allow pop-ups for this site.');
  };

  const workspaceFiles = useMemo<FlatFile[]>(() => allFiles(sidebarTree), [sidebarTree]);
  const selectedFiles = useMemo(
    () => workspaceFiles.filter((f) => selectedFileIds.has(f.id)),
    [workspaceFiles, selectedFileIds]
  );
  const zipStem = () => sanitizeZipName(activeProject?.name || '') || 'latex-workspace';

  const handleDownloadTexZip = async () => {
    if (selectedFiles.length === 0) return;
    try {
      const zip = new JSZip();
      selectedFiles.forEach((f) => zip.file(f.path, f.content));
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${zipStem()}-sources.zip`);
      toast.success(`${selectedFiles.length} source file${selectedFiles.length === 1 ? '' : 's'} exported.`);
    } catch (err: any) {
      toast.error('Could not build the source ZIP: ' + (err?.message || 'unknown error'));
    }
  };

  const handleDownloadPdfZip = async () => {
    if (selectedFiles.length === 0 || batch) return;
    const zip = new JSZip();
    let ok = 0;
    const failed: string[] = [];
    for (let i = 0; i < selectedFiles.length; i++) {
      const f = selectedFiles[i];
      setBatch({ done: i, total: selectedFiles.length, current: f.name });
      try {
        const result = await compileLaTeX(f.content);
        zip.file(f.path.replace(/\.tex$/i, '.pdf'), result.pdf);
        ok++;
      } catch {
        failed.push(f.name);
      }
    }
    setBatch(null);
    if (ok > 0) {
      try {
        const blob = await zip.generateAsync({ type: 'blob' });
        downloadBlob(blob, `${zipStem()}-pdfs.zip`);
      } catch (err: any) {
        toast.error('Could not build the PDF ZIP: ' + (err?.message || 'unknown error'));
        return;
      }
    }
    if (failed.length === 0 && ok > 0) {
      toast.success(`${ok} PDF${ok === 1 ? '' : 's'} compiled and exported.`);
    } else if (ok > 0) {
      const extra = failed.length > 3 ? ` +${failed.length - 3} more` : '';
      toast.error(`${ok} exported; failed: ${failed.slice(0, 3).join(', ')}${extra}.`);
    } else {
      toast.error('None of the selected files compiled successfully.');
    }
  };

  // ---- Split drag handling (sidebar and editor/preview dividers) -----------------
  const onDividerPointerDown = (target: 'side' | 'main') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    dragTarget.current = target;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setDraggingSplit(true);
  };

  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingSplit || !dragTarget.current) return;
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    if (dragTarget.current === 'side') {
      setSideWidth(clampSide(e.clientX - rect.left));
    } else {
      // Map the cursor to the editor/preview split, excluding the sidebar and
      // the fixed divider/gap columns so the divider tracks the cursor exactly.
      const total = rect.width;
      let offset: number;
      let span: number;
      if (sideOpen) {
        offset = sideWidth + 34; // sidebar + divider + surrounding gaps
        span = total - sideWidth - 58;
      } else {
        offset = 12;
        span = total - 34;
      }
      if (span < 60) return; // too small to resize meaningfully
      setSplitRatio(clampSplit((e.clientX - rect.left - offset) / span));
    }
  };

  const onDividerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingSplit) return;
    dragTarget.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    setDraggingSplit(false);
  };

  const renderDivider = (target: 'side' | 'main') => (
    <div
      key={target}
      className="latex-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={target === 'side' ? 'Resize project sidebar (drag or arrow keys)' : 'Resize editor and preview (drag, arrow keys, or double-click to reset)'}
      tabIndex={0}
      onPointerDown={onDividerPointerDown(target)}
      onPointerMove={onDividerPointerMove}
      onPointerUp={onDividerPointerUp}
      onPointerCancel={onDividerPointerUp}
      onKeyDown={(e) => {
        if (target === 'side') {
          if (e.key === 'ArrowLeft') { e.preventDefault(); setSideWidth((w) => clampSide(w - 24)); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); setSideWidth((w) => clampSide(w + 24)); }
        } else {
          if (e.key === 'ArrowLeft') { e.preventDefault(); setSplitRatio((r) => clampSplit(r - 0.02)); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); setSplitRatio((r) => clampSplit(r + 0.02)); }
          else if (e.key === 'Enter' || e.key === '0') { e.preventDefault(); setSplitRatio(SPLIT_DEFAULT); }
        }
      }}
      onDoubleClick={() => { if (target === 'main') setSplitRatio(SPLIT_DEFAULT); else setSideWidth(SIDE_DEFAULT); }}
      title={target === 'side' ? 'Drag to resize the sidebar — double-click to reset' : 'Drag to resize — double-click to reset'}
    />
  );

  // ---- File tree: drag & drop -------------------------------------------------
  const toggleExpanded = (id: string) => setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleSelect = (id: string) => setSelectedFileIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const openFile = (id: string) => {
    saveWorkspace(wsRef.current);
    if (user) {
      persistDocumentAndWorkspaceToFirestore(wsRef.current).catch(() => {});
    }
    setWs((prev) => ({ ...prev, activeFileId: id }));
  };

  const setDropTargetIfChanged = (next: { kind: 'folder' | 'project' | 'root'; id: string | null } | null) => {
    setDropTarget((prev) =>
      prev?.kind === next?.kind && prev?.id === next?.id ? prev : next
    );
  };

  const startDrag = (type: 'project' | 'file', id: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', id); // required for Firefox to start the drag
    e.dataTransfer.effectAllowed = 'move';
    setDragNode({ type, id });
  };

  const endDrag = () => { setDragNode(null); setDropTarget(null); };

  const handleTreeNodeDrop = (kind: 'folder' | 'project' | 'root', id: string | null) =>
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dragNode) return;
      let nextTree: LatexRootNode[] | null = null;
      if (dragNode.type === 'project') {
        if (kind === 'folder') {
          const folderId = id as string;
          const alreadyInside = tree.some((n) => n.kind === 'folder' && n.id === folderId && n.projects.some((p) => p.id === dragNode.id));
          if (!alreadyInside) {
            nextTree = moveProject(tree, dragNode.id, folderId);
            setExpandedIds((prev) => new Set(prev).add(folderId));
            toast.success('Project moved into the folder.');
          }
        } else if (kind === 'root') {
          const atRoot = tree.some((n) => n.kind === 'project' && n.id === dragNode.id);
          if (!atRoot) {
            nextTree = moveProject(tree, dragNode.id, null);
            toast.success('Project moved to the workspace root.');
          }
        }
      } else if (dragNode.type === 'file' && kind === 'project') {
        const projectId = id as string;
        const current = findFileLocation(tree, dragNode.id);
        if (current && current.project.id !== projectId) {
          nextTree = moveFile(tree, dragNode.id, projectId);
          setExpandedIds((prev) => new Set(prev).add(projectId));
          toast.success(`File moved to “${findProjectNode(tree, projectId)?.name ?? 'project'}”.`);
        }
      }
      if (nextTree) {
        const nextWs: LatexWorkspaceState = { ...ws, tree: nextTree };
        setWs(nextWs);
        saveWorkspace(nextWs);
        persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});
      }
      endDrag();
    };

  const nodeDragOver = (kind: 'folder' | 'project' | 'root', id: string | null) =>
    (e: React.DragEvent) => {
      if (!dragNode) return;
      const applicable =
        (kind === 'folder' && dragNode.type === 'project') ||
        (kind === 'root' && dragNode.type === 'project') ||
        (kind === 'project' && dragNode.type === 'file');
      if (!applicable) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDropTargetIfChanged({ kind, id });
    };

  // ---- Tree rendering ------------------------------------------------------------
  const promptDeleteNode = (kind: 'folder' | 'project' | 'file', id: string, label: string, extra?: string) =>
    setDeletePrompt({ kind, id, label, extra });

  const promptDeleteSelection = () => {
    const n = selectedFileIds.size;
    if (!n) return;
    setDeletePrompt({ kind: 'selection', id: '', label: `${n} selected file${n === 1 ? '' : 's'}` });
  };

  const renderFileRow = (file: { id: string; name: string }, depth: number) => {
    const isActive = file.id === ws.activeFileId;
    const isSelected = selectedFileIds.has(file.id);
    const isDragging = dragNode?.type === 'file' && dragNode.id === file.id;
    return (
      <div
        key={file.id}
        className={
          'latex-tree-row file' + (isActive ? ' active' : '') + (isDragging ? ' dragging' : '')
        }
        style={{ paddingLeft: 8 + depth * 16 }}
        role="button"
        tabIndex={0}
        aria-current={isActive ? 'true' : undefined}
        draggable
        onDragStart={startDrag('file', file.id)}
        onDragEnd={endDrag}
        onClick={() => openFile(file.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return; // action buttons handle their own keys
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(file.id); }
        }}
      >
        <GripVertical size={12} className="latex-tree-grip" aria-hidden="true" />
        <input
          type="checkbox"
          className="latex-tree-check"
          checked={isSelected}
          aria-label={`Select ${file.name} for batch export`}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleSelect(file.id)}
        />
        <FileCode2 size={14} className="latex-tree-icon" />
        <span className="latex-tree-name">
          {file.name}
        </span>
        <span className="latex-tree-actions">
          <button className="latex-tree-action" title="Move file to another project" aria-label={`Move ${file.name} to another project`}
            onClick={(e) => { e.stopPropagation(); setMoveDialog({ type: 'file', id: file.id }); }}>
            <FolderInput size={12} />
          </button>
          <button className="latex-tree-action" title="Rename file" aria-label={`Rename ${file.name}`}
            onClick={(e) => { e.stopPropagation(); setNameDialog({ mode: 'rename-node', targetId: file.id, initial: file.name }); }}>
            <Pencil size={12} />
          </button>
          <button className="latex-tree-action" title="Delete file" aria-label={`Delete ${file.name}`}
            onClick={(e) => { e.stopPropagation(); promptDeleteNode('file', file.id, file.name); }}>
            <Trash2 size={12} />
          </button>
        </span>
      </div>
    );
  };

  const renderProjectBlock = (project: { id: string; name: string; files: { id: string; name: string }[] }, depth: number) => {
    const expanded = expandedIds.has(project.id);
    const isDragging = dragNode?.type === 'project' && dragNode.id === project.id;
    const fileDropActive = dragNode?.type === 'file';
    return (
      <div key={project.id}>
        <div
          className={
            'latex-tree-row project' + (expanded ? ' open' : '') + (isDragging ? ' dragging' : '') +
            (fileDropActive && dropTarget?.kind === 'project' && dropTarget.id === project.id ? ' drop-target' : '')
          }
          style={{ paddingLeft: 8 + depth * 16 }}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          draggable={!scopedProject}
          onDragStart={startDrag('project', project.id)}
          onDragEnd={endDrag}
          onDragOver={nodeDragOver('project', project.id)}
          onDrop={handleTreeNodeDrop('project', project.id)}
          onClick={() => toggleExpanded(project.id)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(project.id); }
          }}
        >
          <ChevronRight size={13} className={'latex-chevron' + (expanded ? ' open' : '')} />
          <BookOpen size={14} className="latex-tree-icon" />
          <span className="latex-tree-name">
            {project.name}
          </span>
          <span className="latex-tree-count">{project.files.length}</span>
          <span className="latex-tree-actions">
            <button className="latex-tree-action" title="New file in this project" aria-label={`New file in ${project.name}`}
              onClick={(e) => { e.stopPropagation(); setNameDialog({ mode: 'new-file', targetId: project.id, initial: 'untitled.tex' }); }}>
              <Plus size={13} />
            </button>
            <button className="latex-tree-action" title="Move project to another folder or the workspace root" aria-label={`Move ${project.name}`}
              onClick={(e) => { e.stopPropagation(); setMoveDialog({ type: 'project', id: project.id }); }}>
              <FolderInput size={13} />
            </button>
            <button className="latex-tree-action" title="Rename project" aria-label={`Rename ${project.name}`}
              onClick={(e) => { e.stopPropagation(); setNameDialog({ mode: 'rename-node', targetId: project.id, initial: project.name }); }}>
              <Pencil size={12} />
            </button>
            <button className="latex-tree-action" title="Delete project" aria-label={`Delete ${project.name}`}
              onClick={(e) => { e.stopPropagation(); promptDeleteNode('project', project.id, project.name, `${project.files.length} file${project.files.length === 1 ? '' : 's'} inside will be removed too.`); }}>
              <Trash2 size={12} />
            </button>
          </span>
        </div>
        {expanded && project.files.map((f) => renderFileRow(f, depth + 1))}
        {expanded && project.files.length === 0 && (
          <p className="latex-tree-empty" style={{ paddingLeft: 24 + depth * 16 }}>No files yet — use the + on this project.</p>
        )}
      </div>
    );
  };

  const renderFolderBlock = (folder: { id: string; name: string; projects: { id: string; name: string; files: { id: string; name: string }[] }[] }) => {
    const expanded = expandedIds.has(folder.id);
    const projectDropActive = dragNode?.type === 'project';
    return (
      <div key={folder.id}>
        <div
          className={
            'latex-tree-row folder' + (expanded ? ' open' : '') +
            (projectDropActive && dropTarget?.kind === 'folder' && dropTarget.id === folder.id ? ' drop-target' : '')
          }
          style={{ paddingLeft: 8 }}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onDragOver={nodeDragOver('folder', folder.id)}
          onDrop={handleTreeNodeDrop('folder', folder.id)}
          onClick={() => toggleExpanded(folder.id)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(folder.id); }
          }}
        >
          <ChevronRight size={13} className={'latex-chevron' + (expanded ? ' open' : '')} />
          <Folder size={14} className="latex-tree-icon" />
          <span className="latex-tree-name">
            {folder.name}
          </span>
          <span className="latex-tree-count">{folder.projects.length}</span>
          <span className="latex-tree-actions">
            <button className="latex-tree-action" title="New project in this folder" aria-label={`New project in ${folder.name}`}
              onClick={(e) => { e.stopPropagation(); setNameDialog({ mode: 'new-project', targetId: folder.id, initial: `Project ${folder.projects.length + 1}` }); }}>
              <Plus size={13} />
            </button>
            <button className="latex-tree-action" title="Rename folder" aria-label={`Rename ${folder.name}`}
              onClick={(e) => { e.stopPropagation(); setNameDialog({ mode: 'rename-node', targetId: folder.id, initial: folder.name }); }}>
              <Pencil size={12} />
            </button>
            <button className="latex-tree-action" title="Delete folder" aria-label={`Delete ${folder.name}`}
              onClick={(e) => { e.stopPropagation(); promptDeleteNode('folder', folder.id, folder.name, `${folder.projects.length} project${folder.projects.length === 1 ? '' : 's'} inside will be removed too.`); }}>
              <Trash2 size={12} />
            </button>
          </span>
        </div>
        {expanded && folder.projects.map((p) => renderProjectBlock(p, 1))}
      </div>
    );
  };

  const lineCount = useMemo(() => activeContent.split('\n').length, [activeContent]);
  const fmtSize = (bytes: number) => bytes > 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  const nameCopy = nameDialog ? NAME_DIALOG_COPY[nameDialog.mode] : null;

  /** Destinations offered by the Move dialog (excludes the node's current location). */
  const moveTargets = useMemo<MoveTarget[]>(() => {
    if (!moveDialog) return [];
    if (moveDialog.type === 'file') {
      const opts: MoveTarget[] = [];
      for (const node of ws.tree) {
        if (node.kind === 'folder') {
          for (const p of node.projects) {
            if (!p.files.some((f) => f.id === moveDialog.id)) {
              opts.push({ id: p.id, label: `${node.name} / ${p.name}` });
            }
          }
        } else if (!node.files.some((f) => f.id === moveDialog.id)) {
          opts.push({ id: node.id, label: node.name });
        }
      }
      return opts;
    }
    const opts: MoveTarget[] = [];
    for (const node of ws.tree) {
      if (node.kind === 'folder' && !node.projects.some((p) => p.id === moveDialog.id)) {
        opts.push({ id: node.id, label: node.name });
      }
    }
    const atRoot = ws.tree.some((n) => n.kind === 'project' && n.id === moveDialog.id);
    if (!atRoot) opts.unshift({ id: null, label: 'Workspace root' });
    return opts;
  }, [moveDialog, ws.tree]);

  const executeMove = (targetId: string | null) => {
    if (!moveDialog) return;
    let nextTree: LatexRootNode[];
    if (moveDialog.type === 'file') {
      if (!targetId) return;
      nextTree = moveFile(ws.tree, moveDialog.id, targetId);
      toast.success(`File moved to “${findProjectNode(tree, targetId)?.name ?? 'project'}”.`);
    } else {
      nextTree = moveProject(ws.tree, moveDialog.id, targetId);
      toast.success(targetId ? 'Project moved into the folder.' : 'Project moved to the workspace root.');
    }
    const nextWs: LatexWorkspaceState = { ...ws, tree: nextTree };
    setWs(nextWs);
    saveWorkspace(nextWs);
    persistDocumentAndWorkspaceToFirestore(nextWs).catch(() => {});
  };

  const totalFiles = workspaceFiles.length;

  return (
    <div className="latex-studio animate-fadeIn">
      {/* Toolbar */}
      <div className="latex-toolbar">
        <div className="field-group latex-toolbar-files">
          <button
            className={'icon-button latex-tool-icon' + (sideOpen ? ' on' : '')}
            aria-pressed={sideOpen}
            onClick={() => setSideOpen(!sideOpen)}
            title={sideOpen ? 'Hide the project sidebar' : 'Show the project sidebar'}
            aria-label="Toggle project sidebar"
          >
            <PanelLeft size={16} />
            <span className="latex-file-caption">Sidebar</span>
          </button>
          <button
            type="button"
            className="latex-doc"
            style={{
              background: 'transparent',
              border: 'none',
              padding: '2px 6px',
              borderRadius: 'var(--r-sm)',
              cursor: activeFile ? 'pointer' : 'default',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: 'inherit',
              font: 'inherit',
            }}
            disabled={!activeFile}
            onClick={() => {
              if (activeFile) {
                setNameDialog({ mode: 'rename-node', targetId: activeFile.id, initial: activeFile.name });
              }
            }}
            title={activeFile ? `Click to rename ${activeFile.name}` : 'No file open'}
          >
            <Pencil size={15} />
            <span title={docName}><span className="latex-filename-caption">{docName}</span></span>
          </button>
          <button
            id="btn-import-workspace"
            className="btn secondary btn-sm"
            onClick={() => { setDragImportFiles(null); setImportModalOpen(true); }}
            title="Import .zip, .tar, .tgz, folders, or code files"
          >
            <FolderArchive size={14} />
            <span>Import</span>
          </button>
          <button className="btn quiet btn-sm" onClick={handleDownloadTex} disabled={!activeFile} title="Download the open source file">
            <Download size={14} /><span><span className="latex-desktop-caption">.tex</span><span className="latex-mobile-caption">Download</span></span>
          </button>
          <button className="btn quiet btn-sm" onClick={() => setConfirmClear(true)} disabled={!activeFile || !activeContent} title="Clear the open file">
            <Eraser size={14} /><span>Clear</span>
          </button>

          {/* Account & Cloud Sync Controls */}
          {user ? (
            <div ref={accountMenuRef} style={{ position: 'relative' }}>
              <button
                id="btn-account-profile"
                type="button"
                className="icon-button latex-account-profile"
                aria-label={`Open account menu for ${userDisplayName || userEmail || 'your account'}`}
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                onClick={() => {
                  if (!accountMenuOpen) placeAccountMenu();
                  setAccountMenuOpen(!accountMenuOpen);
                }}
                title={`Logged in as ${userEmail}`}
              >
  <span aria-hidden="true">
  {userEmail ? userEmail.charAt(0).toUpperCase() : 'U'}
  </span>
              </button>

              {accountMenuOpen && (
                <div
                  className="account-menu-popover"
                  role="menu"
                  /* Position is measured from the account chip and applied
                     inline (fixed + centered on it, clamped to the viewport),
                     so it always hugs the profile picture and can never be
                     clipped or drift off-screen. */
                  style={menuPos ? {
                    position: 'fixed',
                    top: menuPos.top,
                    left: menuPos.left,
                    width: menuPos.width,
                    transform: 'none',
                  } : undefined}
                >
                  <div className="account-profile-row">
                    <div className="account-avatar">
                      {userEmail ? userEmail.charAt(0).toUpperCase() : 'U'}
                    </div>
                    <div className="account-info">
                      <span className="account-email">{userEmail}</span>
                      <span className="account-provider-tag">
                        <ShieldCheck size={12} style={{ color: 'var(--accent)' }} />
                        <span>{userDomainInfo?.providerName || 'Official Account'}</span>
                      </span>
                    </div>
                  </div>

                  <div className="account-sync-status-box">
                    <div className="account-sync-row">
                      <span style={{ color: 'var(--secondary)' }}>Sync Status</span>
                      <span className={`sync-badge ${cloudSyncStatus}`}>
                        {cloudSyncStatus === 'synced' && <><Check size={12} /><span>Saved to Cloud</span></>}
                        {cloudSyncStatus === 'syncing' && <><RotateCw size={12} className="spinner" /><span>Syncing…</span></>}
                        {cloudSyncStatus === 'loading' && <><RotateCw size={12} className="spinner" /><span>Loading…</span></>}
                        {cloudSyncStatus === 'error' && <><AlertCircle size={12} /><span>Sync error</span></>}
                        {cloudSyncStatus === 'local' && <span>Local Storage</span>}
                      </span>
                    </div>
                    {lastSyncedTime && (
                      <div style={{ fontSize: 11, color: 'var(--secondary)' }}>
                        Last synced: {lastSyncedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </div>
                    )}
                  </div>

                  <div className="account-menu-actions">
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      role="menuitem"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        setUserProfileOpen(true);
                      }}
                    >
                      <User size={13} />
                      <span>Account details</span>
                    </button>
                    <div className="account-menu-secondary-actions">
                      <button
                        type="button"
                        className="btn secondary btn-sm"
                        role="menuitem"
                        onClick={handleManualCloudSync}
                        disabled={cloudSyncStatus === 'syncing' || cloudSyncStatus === 'loading'}
                      >
                        <RotateCw size={13} className={cloudSyncStatus === 'syncing' ? 'spinner' : ''} />
                        <span>Sync Now</span>
                      </button>
                      <button
                        type="button"
                        className="btn quiet btn-sm account-signout"
                        role="menuitem"
                        onClick={async () => {
                          setAccountMenuOpen(false);
                          await signOut();
                          toast.info('Signed out. Projects will now save locally in your browser.');
                        }}
                      >
                        <LogOut size={13} />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="auth-header-toggle" role="group" aria-label="LaTeX Studio account">
              <button
                type="button"
                id="btn-signin-latex"
                className="btn quiet btn-sm"
                onClick={() => {
                  setAuthModalMode('signin');
                  setAuthModalOpen(true);
                }}
                title="Log in to access your cloud LaTeX projects"
              >
                <LogIn size={13} />
                <span>Log In</span>
              </button>
              <button
                type="button"
                id="btn-signup-latex"
                className="btn secondary btn-sm"
                onClick={() => {
                  setAuthModalMode('signup');
                  setAuthModalOpen(true);
                }}
                title="Sign up with official email to sync LaTeX projects"
              >
                <UserPlus size={13} />
                <span>Sign Up</span>
              </button>
            </div>
          )}
        </div>

        <div className="field-group latex-toolbar-actions">
          <button
            className={'chip chip-btn ' + (autoCompile ? 'on' : '')}
            aria-pressed={autoCompile}
            onClick={() => setAutoCompile(!autoCompile)}
            title="Automatically recompile after you stop typing"
          >
            <Zap size={13} /><span>Auto</span>
          </button>
          <button
            id="btn-compile"
            className="btn primary btn-sm"
            onClick={() => runCompile()}
            disabled={compiling || repairing || !activeFile}
            title="Compile to PDF (Ctrl+Enter)"
          >
            {compiling ? <RefreshCw size={15} className="spinner" /> : <Play size={15} />}
            <span>{compiling ? 'Compiling…' : 'Compile'}</span>
          </button>
          <button className={'btn secondary btn-sm' + (assistantOpen ? ' on' : '')} aria-pressed={assistantOpen} onClick={() => { setAssistantOpen(!assistantOpen); if (!assistantOpen) setMobilePane('editor'); }} disabled={!activeFile} title="Fix LaTeX compilation errors only">
            <Sparkles size={14} /><span>Assistant</span>
          </button>
        </div>
      </div>

      {/* Cloud sync failure banner */}
      {user && cloudSyncStatus === 'error' && (
        <div className="cloud-sync-error" role="alert">
          <AlertCircle size={14} />
          <span>Cloud sync failed — your work is saved on this device and will retry automatically.</span>
          <button
            type="button"
            onClick={() => persistDocumentAndWorkspaceToFirestore(ws)}
            disabled={false}
          >
            Retry now
          </button>
        </div>
      )}

      {/* Mobile pane switcher (hidden >900px) */}
      {isNarrow && (
        <div className="latex-mobile-tabs" role="tablist" aria-label="Studio panes">
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === 'files'}
            className={mobilePane === 'files' ? 'active' : ''}
            onClick={() => setMobilePane('files')}
          >
            <FolderOpen size={14} />
            Files
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === 'editor'}
            className={mobilePane === 'editor' ? 'active' : ''}
            onClick={() => setMobilePane('editor')}
          >
            <FileCode2 size={14} />
            Source
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === 'preview'}
            className={mobilePane === 'preview' ? 'active' : ''}
            onClick={() => setMobilePane('preview')}
          >
            <Eye size={14} />
            Preview
          </button>
        </div>
      )}

      {/* Workspace: sidebar | divider | editor | divider | preview */}
      <div
        ref={splitRef}
        className={'latex-split'
          + ((sideOpen || (isNarrow && mobilePane === 'files')) ? '' : ' no-side')
          + (draggingSplit ? ' dragging' : '')
          + (isNarrow ? ` mobile-pane-${mobilePane}` : '')}
        style={{
          '--split-a': `${(splitRatio * 100).toFixed(2)}fr`,
          '--split-b': `${((1 - splitRatio) * 100).toFixed(2)}fr`,
          ...(sideOpen ? { '--side-w': `${sideWidth}px` } : {}),
        } as React.CSSProperties}
      >
        {(sideOpen || (isNarrow && mobilePane === 'files')) && (
          <aside className="latex-side" aria-label="Projects and files">
            <div className="latex-side-head">
              <span className="latex-side-title">{scopedProject ? scopedProject.name : 'Workspace'}</span>
              <button className="latex-tree-action" title="Import archive (.zip / .tar) or folder" aria-label="Import archive or folder"
                onClick={() => { setDragImportFiles(null); setImportModalOpen(true); }}>
                <FolderArchive size={14} />
              </button>
              {!scopedProject && (
              <div className="latex-create-wrap" ref={createMenuRef}>
                <button className="latex-tree-action" title="Create project or folder" aria-label="Create project or folder"
                  aria-haspopup="menu" aria-expanded={createMenuOpen}
                  onClick={() => setCreateMenuOpen((v) => !v)}>
                  <Plus size={14} />
                  <ChevronDown size={10} className="latex-create-caret" />
                </button>
                {createMenuOpen && (
                  <div className="latex-create-menu" role="menu" aria-label="Create">
                    <button type="button" role="menuitem"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        setNameDialog({ mode: 'new-project', targetId: null, initial: `Project ${projectCount(tree) + 1}` });
                      }}>
                      <BookOpen size={14} />
                      <span>New project</span>
                    </button>
                    <button type="button" role="menuitem"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        setNameDialog({ mode: 'new-folder', targetId: null, initial: 'folder' });
                      }}>
                      <FolderPlus size={14} />
                      <span>New folder</span>
                    </button>
                  </div>
                )}
              </div>
              )}
            </div>

            <div className="latex-side-tools" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="latex-file-count">
                {scopedProject
                  ? `${scopedProject.files.length} file${scopedProject.files.length === 1 ? '' : 's'} in this project`
                  : `${projectCount(tree)} project${projectCount(tree) === 1 ? '' : 's'} · ${totalFiles} file${totalFiles === 1 ? '' : 's'}`}
              </span>
              <span
                style={{
                  fontSize: 11,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  color: user ? 'var(--accent)' : 'var(--secondary)',
                }}
                title={user ? `Synced with cloud account (${userEmail})` : 'Projects saved locally in browser storage'}
              >
                {user ? <Cloud size={12} /> : null}
                <span>{user ? 'Cloud' : 'Local'}</span>
              </span>
            </div>

            <div
              className={'latex-tree' + (!scopedProject && dragNode?.type === 'project' && dropTarget?.kind === 'root' ? ' drop-root' : '')}
              role="tree"
              aria-label="Projects and files"
              onDragOver={nodeDragOver('root', null)}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTargetIfChanged(null); }}
              onDrop={handleTreeNodeDrop('root', null)}
            >
              {sidebarTree.length === 0 ? (
                <div className="latex-tree-empty" style={{ padding: '16px 10px', textAlign: 'center' }}>
                  <p style={{ margin: '0 0 12px', lineHeight: 1.4 }}>
                    Nothing here yet — create a <strong>project</strong> to start writing,
                    or import your existing code files.
                  </p>
                  <button
                    type="button"
                    className="btn primary btn-sm"
                    style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
                    onClick={() => { setDragImportFiles(null); setImportModalOpen(true); }}
                  >
                    <FolderArchive size={14} />
                    <span>Import Archive / Folder</span>
                  </button>
                  {!user && (
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      style={{ width: '100%', justifyContent: 'center' }}
                      onClick={() => { setAuthModalMode('signin'); setAuthModalOpen(true); }}
                    >
                      <LogIn size={14} />
                      <span>Sign In to Sync</span>
                    </button>
                  )}
                </div>

              ) : (
                sidebarTree.map((node) =>
                  node.kind === 'folder'
                    ? renderFolderBlock(node)
                    : renderProjectBlock(node, 0)
                )
              )}
            </div>

            <div className="latex-side-foot">
              {batch ? (
                <div className="latex-batch" role="status">
                  <RefreshCw size={13} className="spinner" />
                  <span>Compiling {batch.done + 1}/{batch.total} — {batch.current}</span>
                </div>
              ) : selectedFileIds.size > 0 ? (
                <>
                  <span className="chip accent">{selectedFileIds.size} selected</span>
                  <div className="field-group">
                    <button className="btn quiet btn-sm" onClick={() => setSelectedFileIds(new Set(workspaceFiles.map((f) => f.id)))}>Select all</button>
                <button className="btn quiet btn-sm latex-deselect" onClick={() => setSelectedFileIds(new Set())}>Deselect all</button>
                    <button className="btn secondary btn-sm" onClick={handleDownloadTexZip} title="Download the selected sources as a ZIP">
                      <Code2 size={13} /><span>.tex ZIP</span>
                    </button>
                    <button className="btn primary btn-sm" onClick={handleDownloadPdfZip} title="Compile every selected file and download the PDFs as a ZIP">
                      <Download size={13} /><span>PDFs ZIP</span>
                    </button>
                    <button className="btn danger btn-sm" onClick={promptDeleteSelection} title="Delete every selected file">
                      <Trash2 size={13} /><span>Delete</span>
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="latex-foot-info">Select files to batch-export</span>
                  <button className="btn quiet btn-sm" onClick={() => setSelectedFileIds(new Set(workspaceFiles.map((f) => f.id)))} disabled={totalFiles === 0}>Select all</button>
                </>
              )}
            </div>
          </aside>
        )}

        {sideOpen && renderDivider('side')}

        <section
          className="latex-pane latex-editor-pane"
          aria-label="LaTeX source editor"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="latex-pane-head">
            <span>Source</span>
            <span className="latex-pane-meta">
              {activeFile
                ? `${lineCount} lines · ${user ? (cloudSyncStatus === 'synced' ? 'synced with cloud' : cloudSyncStatus === 'syncing' ? 'syncing…' : 'saved locally') : 'saved locally'}`
                : 'no file open'}
            </span>
          </div>
          <div className="latex-editor-wrap">
            <div className="latex-gutter" ref={gutterRef} aria-hidden="true">
              {Array.from({ length: lineCount }, (_, i) => <span key={i}>{i + 1}</span>)}
            </div>
            <textarea
              ref={editorRef}
              className="latex-editor"
              value={activeContent}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              disabled={!activeFile}
              placeholder={activeFile ? '' : 'Create or select a .tex file in the sidebar to start writing…'}
              aria-label="LaTeX source code"
              onChange={(e) => updateActiveContent(e.target.value)}
              onBlur={() => {
                saveWorkspace(wsRef.current);
                if (user) {
                  persistDocumentAndWorkspaceToFirestore(wsRef.current).catch(() => {});
                }
              }}
              onScroll={syncGutter}
              onKeyDown={handleKeyDown}
            />
          </div>
          {assistantOpen && activeFile && <LaTeXRepairAssistant
            key={activeFile.id}
            fileName={activeFile.name}
            source={activeContent}
            files={(activeProject?.files ?? []).filter(f => f.id !== activeFile.id).map(f => ({ name: f.name, content: f.content }))}
            signature={activeSignature}
            diagnostic={compileError}
            compiling={compiling}
onComplete={completeAssistantRepair}
              onBusyChange={setRepairing}
              autoRunId={autoRepair && compileError?.signature === activeSignature ? repairRunId : 0}
              autoRepair={autoRepair}
              onAutoRunConsumed={() => setRepairRunId(0)}
              onClose={() => setAssistantOpen(false)}
          />}
        </section>

        {renderDivider('main')}

        <section className="latex-pane latex-preview-pane" aria-label="Compiled PDF preview">
          <div className="latex-pane-head">
            <span>Preview</span>
            <div className="field-group">
              {engine && !compileError && (
                <span className="latex-pane-meta" title={`Compiled with ${engine} via the ${via === 'server' ? 'app server' : 'online fallback'}`}>
                  {engine} · {durationMs ?? '—'} ms{pdfSize ? ` · ${fmtSize(pdfSize)}` : ''}
                </span>
              )}
              <button
                className="btn quiet btn-sm latex-icon-btn"
                onClick={handleOpenPdfTab}
                disabled={!pdfUrl || compiling}
                title="Open the PDF in a new browser tab"
                aria-label="Open the compiled PDF in a new browser tab"
              >
                <ExternalLink size={15} />
              </button>
              <button className="btn primary btn-sm" onClick={handleDownloadPdf} disabled={!pdfUrl || compiling}>
                <Download size={14} /><span>PDF</span>
              </button>
            </div>
          </div>
          <div className="latex-preview-body">
            {compileError && (
              <div className="latex-error">
                <div className="latex-error-head">
                  <AlertCircle size={16} />
                  <strong>{repairing ? 'Repairing your document' : 'PDF preview pending'}</strong>
                  <button className="btn secondary btn-sm" onClick={() => { setAssistantOpen(true); setMobilePane('editor'); }} disabled={!activeFile}><Sparkles size={13} />Repair status</button>
                  {compileError.log && (
                    <button className="btn quiet btn-sm" onClick={() => setShowLog(!showLog)}>
                      {showLog ? 'Hide log' : 'Show log'}
                    </button>
                  )}
                </div>
                <p>{repairing ? 'The assistant is fixing errors and recompiling automatically.' : 'The document has not compiled yet. Open Repair status to continue or inspect the compiler details.'}</p>
                {showLog && compileError.log && (
                  <>
                    <p>{compileError.message}</p>
                    <pre className="latex-log" aria-label="Compiler output">{compileError.log.slice(-6000)}</pre>
                  </>
                )}
              </div>
            )}
            {!compileError && compiling && !pdfUrl && (
              <div className="latex-preview-empty"><RefreshCw size={26} className="spinner" /><p>Compiling your document…</p></div>
            )}
            {!compileError && !compiling && !pdfUrl && (
              <div className="latex-preview-empty"><FileCode2 size={30} /><p>No PDF yet.</p><small>Press <strong>Compile</strong> (or Ctrl+Enter) to build the preview.</small></div>
            )}
            {pdfUrl && (
              <LaTeXPdfViewer
                key={pdfUrl}
                pdfBlob={pdfBlob}
                pdfUrl={pdfUrl}
              />
            )}
          </div>
        </section>
      </div>

      {/* Dialogs */}
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

      {moveDialog && (
        <MoveNodeDialog
          title={moveDialog.type === 'file' ? 'Move file' : 'Move project'}
          targets={moveTargets}
          emptyMessage={moveDialog.type === 'file'
            ? 'No other projects yet — create a project first.'
            : 'No other destination yet — create a folder first, or leave the project at the root.'}
          onConfirm={executeMove}
          onClose={() => setMoveDialog(null)}
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

      <ImportWorkspaceModal
        isOpen={importModalOpen}
        onClose={() => {
          setImportModalOpen(false);
          setDragImportFiles(null);
        }}
        activeProject={activeProject}
        onImport={handleWorkspaceImport}
        initialFiles={dragImportFiles?.files || null}
        initialSource={dragImportFiles?.source || null}
      />

      <AuthModal
        isOpen={authModalOpen}
        initialMode={authModalMode}
        onClose={() => setAuthModalOpen(false)}
        onSuccess={() => {
          setAuthModalOpen(false);
        }}
      />


      {confirmClear && (
        <ConfirmDialog
          title="Clear this file?"
          message={`All contents of ${docName} will be removed. This cannot be undone.`}
          confirmLabel="Clear file"
          danger
          onConfirm={() => { updateActiveContent(''); setConfirmClear(false); }}
          onClose={() => setConfirmClear(false)}
        />
      )}

      <UserProfile isOpen={userProfileOpen} onClose={() => setUserProfileOpen(false)} />
    </div>
  );
}

/* --------------------------------------------------------------------------
   Local tree helpers over the root-node union
   -------------------------------------------------------------------------- */

function findProjectNode(tree: LatexRootNode[], projectId: string) {
  for (const node of tree) {
    if (node.kind === 'project' && node.id === projectId) return node;
    if (node.kind === 'folder') {
      const hit = node.projects.find((p) => p.id === projectId);
      if (hit) return hit;
    }
  }
  return null;
}

function nodeKindAndName(tree: LatexRootNode[], id: string): { kind: 'folder' | 'project' | 'file'; name: string } | null {
  for (const node of tree) {
    if (node.id === id) return { kind: node.kind, name: node.name };
    if (node.kind === 'folder') {
      for (const p of node.projects) {
        if (p.id === id) return { kind: 'project', name: p.name };
        const f = p.files.find((x) => x.id === id);
        if (f) return { kind: 'file', name: f.name };
      }
    } else {
      const f = node.files.find((x) => x.id === id);
      if (f) return { kind: 'file', name: f.name };
    }
  }
  return null;
}
