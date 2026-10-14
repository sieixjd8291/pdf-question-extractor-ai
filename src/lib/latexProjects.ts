/**
 * Project workspace for LaTeX Studio, Overleaf-style:
 *   optional FOLDERS → PROJECTS inside them → .tex CODE FILES inside projects.
 * The tree is drag-and-drop: projects can be moved into/out of folders and
 * files can be moved between projects. Persisted to localStorage; compiled
 * PDFs are never stored — only source text.
 */

export const DEFAULT_BLANK_LATEX = `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}

\\begin{document}

\\title{Untitled}
\\author{}
\\date{\\today}
\\maketitle

\\section{Introduction}

Start writing here.

\\end{document}
`;

export interface LatexFileNode {
  id: string;
  kind: 'file';
  name: string;
  content: string;
  updatedAt: number;
}

export interface LatexProjectNode {
  id: string;
  kind: 'project';
  name: string;
  files: LatexFileNode[];
  createdAt: number;
  updatedAt: number;
}

export interface LatexFolderNode {
  id: string;
  kind: 'folder';
  name: string;
  projects: LatexProjectNode[];
  createdAt?: number;
  updatedAt?: number;
}

export type LatexRootNode = LatexProjectNode | LatexFolderNode;

export interface LatexWorkspaceState {
  tree: LatexRootNode[];
  activeFileId: string | null;
}

export const WORKSPACE_KEY = 'pdf-studio-latex-projects-v2';
export const LEGACY_V1_KEY = 'pdf-studio-latex-projects-v1';
export const LEGACY_DRAFT_KEY = 'pdf-studio-latex-draft';

export const NEW_FILE_CONTENT = `\\documentclass{article}
\\begin{document}

\\end{document}
`;

let uidCounter = 0;
export function uid(prefix: string): string {
  uidCounter = (uidCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/* --------------------------------------------------------------------------
   Name helpers
   -------------------------------------------------------------------------- */

export function sanitizeFileName(input: string): string {
  const base = input.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ');
  if (!base) return '';
  return /\.tex$/i.test(base) ? base : `${base}.tex`;
}

export function sanitizeFolderName(input: string): string {
  return input.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ');
}

export function sanitizeZipName(input: string): string {
  return input.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 60);
}

/** Ensures a name does not collide with siblings ("notes" → "notes-2"). */
export function uniqueName(siblings: { name: string }[], name: string): string {
  const taken = new Set(siblings.map((n) => n.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now().toString(36)}${ext}`;
}

/* --------------------------------------------------------------------------
   Lookups
   -------------------------------------------------------------------------- */

export function findProject(tree: LatexRootNode[], projectId: string): LatexProjectNode | null {
  for (const node of tree) {
    if (node.kind === 'project' && node.id === projectId) return node;
    if (node.kind === 'folder') {
      const hit = node.projects.find((p) => p.id === projectId);
      if (hit) return hit;
    }
  }
  return null;
}

export interface FileLocation {
  project: LatexProjectNode;
  file: LatexFileNode;
}

export function findFileLocation(tree: LatexRootNode[], fileId: string): FileLocation | null {
  for (const node of tree) {
    const candidates = node.kind === 'project' ? [node] : node.projects;
    for (const project of candidates) {
      const file = project.files.find((f) => f.id === fileId);
      if (file) return { project, file };
    }
  }
  return null;
}

export interface FlatFile {
  id: string;
  name: string;
  /** Workspace-relative path, containers joined with "/" ("Group/Project/notes.tex"). */
  path: string;
  content: string;
}

export function allFiles(tree: LatexRootNode[]): FlatFile[] {
  const out: FlatFile[] = [];
  for (const node of tree) {
    if (node.kind === 'project') {
      node.files.forEach((f) => out.push({ id: f.id, name: f.name, path: `${node.name}/${f.name}`, content: f.content }));
    } else {
      for (const project of node.projects) {
        project.files.forEach((f) =>
          out.push({ id: f.id, name: f.name, path: `${node.name}/${project.name}/${f.name}`, content: f.content })
        );
      }
    }
  }
  return out;
}

export function firstFileId(tree: LatexRootNode[]): string | null {
  for (const node of tree) {
    const projects = node.kind === 'project' ? [node] : node.projects;
    for (const project of projects) {
      if (project.files.length > 0) return project.files[0].id;
    }
  }
  return null;
}

export function projectCount(tree: LatexRootNode[]): number {
  return tree.reduce((n, node) => n + (node.kind === 'project' ? 1 : node.projects.length), 0);
}

/* --------------------------------------------------------------------------
   Immutable tree operations (each returns a new tree)
   -------------------------------------------------------------------------- */

export function addFolder(tree: LatexRootNode[], name: string): { tree: LatexRootNode[]; folder: LatexFolderNode } {
  const now = Date.now();
  const folder: LatexFolderNode = { id: uid('dir'), kind: 'folder', name, projects: [], createdAt: now, updatedAt: now };
  return { tree: [...tree, folder], folder };
}

export function addProject(
  tree: LatexRootNode[],
  folderId: string | null,
  name: string
): { tree: LatexRootNode[]; project: LatexProjectNode } {
  const now = Date.now();
  const project: LatexProjectNode = {
    id: uid('proj'),
    kind: 'project',
    name,
    files: [{ id: uid('file'), kind: 'file', name: 'main.tex', content: DEFAULT_BLANK_LATEX, updatedAt: now }],
    createdAt: now,
    updatedAt: now,
  };
  if (folderId === null) return { tree: [...tree, project], project };
  return {
    tree: tree.map((node) =>
      node.kind === 'folder' && node.id === folderId
        ? { ...node, updatedAt: now, projects: [...node.projects, project] }
        : node
    ),
    project,
  };
}

export function addFile(
  tree: LatexRootNode[],
  projectId: string,
  name: string,
  content = NEW_FILE_CONTENT
): { tree: LatexRootNode[]; file: LatexFileNode } {
  const now = Date.now();
  const file: LatexFileNode = { id: uid('file'), kind: 'file', name, content, updatedAt: now };
  return {
    tree: tree.map((node) => {
      if (node.kind === 'project') {
        return node.id === projectId ? { ...node, files: [...node.files, file], updatedAt: now } : node;
      }
      return {
        ...node,
        projects: node.projects.map((p) =>
          p.id === projectId ? { ...p, files: [...p.files, file], updatedAt: now } : p
        ),
      };
    }),
    file,
  };
}

export function updateFileContent(tree: LatexRootNode[], fileId: string, content: string): LatexRootNode[] {
  const now = Date.now();
  return tree.map((node) => {
    if (node.kind === 'project') {
      if (!node.files.some((f) => f.id === fileId)) return node;
      return {
        ...node,
        files: node.files.map((f) => (f.id === fileId ? { ...f, content, updatedAt: now } : f)),
        updatedAt: now,
      };
    }
    return {
      ...node,
      projects: node.projects.map((p) => {
        if (!p.files.some((f) => f.id === fileId)) return p;
        return {
          ...p,
          files: p.files.map((f) => (f.id === fileId ? { ...f, content, updatedAt: now } : f)),
          updatedAt: now,
        };
      }),
    };
  });
}

export function renameTreeNode(tree: LatexRootNode[], id: string, name: string): LatexRootNode[] {
  const now = Date.now();
  return tree.map((node) => {
    if (node.id === id) {
      return { ...node, name, updatedAt: now };
    }
    if (node.kind === 'folder') {
      const hasDirectProject = node.projects.some((p) => p.id === id);
      const hasFile = node.projects.some((p) => p.files.some((f) => f.id === id));
      if (!hasDirectProject && !hasFile) return node;

      return {
        ...node,
        updatedAt: now,
        projects: node.projects.map((p) => {
          if (p.id === id) {
            return { ...p, name, updatedAt: now };
          }
          const fileMatch = p.files.some((f) => f.id === id);
          if (!fileMatch) return p;
          return {
            ...p,
            updatedAt: now,
            files: p.files.map((f) => (f.id === id ? { ...f, name, updatedAt: now } : f)),
          };
        }),
      };
    }
    // node is a root project
    const fileMatch = node.files.some((f) => f.id === id);
    if (!fileMatch) return node;
    return {
      ...node,
      updatedAt: now,
      files: node.files.map((f) => (f.id === id ? { ...f, name, updatedAt: now } : f)),
    };
  });
}

export function removeTreeNode(
  tree: LatexRootNode[],
  id: string
): { tree: LatexRootNode[]; removedFileIds: Set<string> } {
  const now = Date.now();
  const removedFileIds = new Set<string>();

  const collectProjectFiles = (project: LatexProjectNode) => project.files.forEach((f) => removedFileIds.add(f.id));

  const next: LatexRootNode[] = [];
  for (const node of tree) {
    if (node.id === id) {
      if (node.kind === 'project') collectProjectFiles(node);
      else node.projects.forEach(collectProjectFiles);
      continue; // dropped from the tree
    }
    if (node.kind === 'folder') {
      const projects = node.projects.filter((p) => {
        if (p.id === id) { collectProjectFiles(p); return false; }
        return true;
      });
      next.push({
        ...node,
        updatedAt: now,
        projects: projects.map((p) => {
          const files = p.files.filter((f) => {
            if (f.id === id) { removedFileIds.add(f.id); return false; }
            return true;
          });
          return {
            ...p,
            files,
            ...(files.length !== p.files.length ? { updatedAt: now } : {}),
          };
        }),
      });
      continue;
    }
    const files = node.files.filter((f) => {
      if (f.id === id) { removedFileIds.add(f.id); return false; }
      return true;
    });
    next.push({
      ...node,
      files,
      ...(files.length !== node.files.length ? { updatedAt: now } : {}),
    });
  }
  return { tree: next, removedFileIds };
}

/** Check if a workspace is just the default placeholder workspace created on startup */
export function isDefaultFreshWorkspace(state: LatexWorkspaceState | null | undefined): boolean {
  if (!state || !Array.isArray(state.tree) || state.tree.length !== 1) return false;
  const root = state.tree[0];
  if (root.kind !== 'project') return false;
  if (root.name !== 'My project' && root.name !== 'Untitled project') return false;
  if (!Array.isArray(root.files) || root.files.length !== 1) return false;
  const f = root.files[0];
  return f.name === 'main.tex' && (f.content.trim() === DEFAULT_BLANK_LATEX.trim() || f.content.trim() === '');
}

/** Moves a project into a folder (folderId=null puts it back at the root). */
export function moveProject(tree: LatexRootNode[], projectId: string, folderId: string | null): LatexRootNode[] {
  let moved: LatexProjectNode | null = null;
  const without: LatexRootNode[] = [];
  for (const node of tree) {
    if (node.kind === 'project' && node.id === projectId) { moved = node; continue; }
    if (node.kind === 'folder') {
      const hit = node.projects.find((p) => p.id === projectId);
      if (hit) { moved = hit; without.push({ ...node, projects: node.projects.filter((p) => p.id !== projectId) }); continue; }
    }
    without.push(node);
  }
  if (!moved) return tree;
  if (folderId === null) return [...without, moved];
  return without.map((node) =>
    node.kind === 'folder' && node.id === folderId ? { ...node, projects: [...node.projects, moved as LatexProjectNode] } : node
  );
}

/** Moves a file into another project. No-op if it is already there. */
export function moveFile(tree: LatexRootNode[], fileId: string, projectId: string): LatexRootNode[] {
  const loc = findFileLocation(tree, fileId);
  if (!loc || loc.project.id === projectId) return tree;
  const detached = removeTreeNode(tree, fileId);
  return addFile(detached.tree, projectId, uniqueName(
    (findProject(detached.tree, projectId)?.files ?? []) as { name: string }[],
    loc.file.name
  ), loc.file.content).tree;
}

/* --------------------------------------------------------------------------
   Factories
   -------------------------------------------------------------------------- */

export function createFileNode(name: string, content = NEW_FILE_CONTENT): LatexFileNode {
  return { id: uid('file'), kind: 'file', name, content, updatedAt: Date.now() };
}

/* --------------------------------------------------------------------------
   Persistence + migration from earlier formats
   -------------------------------------------------------------------------- */

function isValidState(value: any): value is LatexWorkspaceState {
  return (
    value &&
    Array.isArray(value.tree) &&
    value.tree.every(
      (node: any) =>
        node &&
        typeof node.id === 'string' &&
        typeof node.name === 'string' &&
        (node.kind === 'folder'
          ? Array.isArray(node.projects)
          : node.kind === 'project' && Array.isArray(node.files))
    )
  );
}

/** v1 stored projects that contained folders/files; those become flat projects. */
function migrateV1(raw: string): LatexWorkspaceState | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.projects) || parsed.projects.length === 0) return null;
    const tree: LatexRootNode[] = [];
    for (const old of parsed.projects) {
      if (!old || typeof old.name !== 'string' || !Array.isArray(old.root)) continue;
      const seen: { name: string }[] = [];
      const files: LatexFileNode[] = [];
      const walk = (nodes: any[]) => {
        for (const n of nodes) {
          if (!n) continue;
          if (n.kind === 'file' && typeof n.content === 'string') {
            const file = createFileNode(uniqueName(seen, sanitizeFileName(n.name) || 'untitled.tex'), n.content);
            seen.push(file);
            files.push(file);
          } else if (n.kind === 'folder' && Array.isArray(n.children)) {
            walk(n.children); // old inner folders are flattened into the project
          }
        }
      };
      walk(old.root);
      if (files.length === 0) {
        const file = createFileNode('main.tex');
        seen.push(file);
        files.push(file);
      }
      tree.push({
        id: typeof old.id === 'string' ? old.id : uid('proj'),
        kind: 'project',
        name: old.name,
        files,
        createdAt: typeof old.createdAt === 'number' ? old.createdAt : Date.now(),
        updatedAt: Date.now(),
      });
    }
    if (tree.length === 0) return null;
    const activeFileId =
      typeof parsed.activeFileId === 'string' && findFileLocation(tree, parsed.activeFileId)
        ? parsed.activeFileId
        : firstFileId(tree);
    return { tree, activeFileId };
  } catch {
    return null;
  }
}

export function freshWorkspace(): LatexWorkspaceState {
  let seed = DEFAULT_BLANK_LATEX;
  try {
    const legacy = localStorage.getItem(LEGACY_DRAFT_KEY);
    if (legacy && legacy.trim()) seed = legacy;
  } catch { /* ignore */ }
  const { tree, project } = addProject([], null, 'My project');
  project.files[0].content = seed;
  return { tree, activeFileId: project.files[0].id };
}

export function loadWorkspace(): LatexWorkspaceState {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidState(parsed)) {
        return {
          tree: parsed.tree,
          activeFileId:
            typeof parsed.activeFileId === 'string' && findFileLocation(parsed.tree, parsed.activeFileId)
              ? parsed.activeFileId
              : firstFileId(parsed.tree),
        };
      }
    }
  } catch { /* corrupted storage — fall through */ }

  try {
    const v1 = localStorage.getItem(LEGACY_V1_KEY);
    if (v1) {
      const migrated = migrateV1(v1);
      if (migrated) return migrated;
    }
  } catch { /* ignore */ }

  return freshWorkspace();
}

export function saveWorkspace(state: LatexWorkspaceState): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(state));
  } catch { /* storage full or blocked — drafts stay in memory for this session */ }
}
