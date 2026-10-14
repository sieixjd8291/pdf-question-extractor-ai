/**
 * Archive (.zip, .tar, .tar.gz, .tgz) and Folder Importer for LaTeX Studio.
 * Extracts text and code files (.tex, .bib, .sty, .cls, and programming/markup files)
 * from archives and folders to integrate directly into the workspace tree.
 */

import JSZip from 'jszip';
import {
  LatexRootNode,
  LatexProjectNode,
  LatexFolderNode,
  LatexFileNode,
  uid,
  sanitizeFolderName,
  uniqueName,
  findProject,
} from './latexProjects';

export interface ExtractedCodeFile {
  path: string;       // Original relative path, e.g. "thesis/chapters/intro.tex"
  name: string;       // File name only, e.g. "intro.tex"
  subpath: string;    // Relative path stripped of common root, e.g. "chapters/intro.tex"
  content: string;    // Decoded UTF-8 text content
  size: number;       // Size in bytes
  extension: string;  // File extension (e.g. "tex", "bib")
  isTex: boolean;     // Whether it is a LaTeX source file (.tex, .latex, .ltx)
  selected?: boolean; // Selection state in the import preview modal
}

export interface ImportAnalysis {
  files: ExtractedCodeFile[];
  suggestedProjectName: string;
  hasMainTex: boolean;
  texCount: number;
  totalCount: number;
  totalSize: number;
  topLevelFolders: string[];
}

export const CODE_EXTENSIONS = new Set([
  'tex', 'latex', 'ltx', 'bib', 'bst', 'bbl',
  'sty', 'cls', 'dtx', 'ins', 'def', 'clo', 'fd',
  'txt', 'md', 'markdown', 'rst', 'org',
  'json', 'yaml', 'yml', 'xml', 'toml', 'ini', 'cfg', 'conf',
  'py', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'java', 'kt', 'rs', 'go',
  'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'sass', 'less',
  'r', 'rmd', 'm', 'jl', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'sql', 'csv', 'tsv',
  'toc', 'aux', 'out', 'log'
]);

export function isIgnoredPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.some((p) =>
    p.startsWith('.') ||
    p === '__MACOSX' ||
    p === 'node_modules' ||
    p === 'Thumbs.db' ||
    p === 'desktop.ini'
  );
}

export function isCodeOrTextFile(filename: string, content?: string): boolean {
  if (isIgnoredPath(filename)) return false;
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (CODE_EXTENSIONS.has(ext)) return true;
  if (content !== undefined) {
    // Check if the sample contains null bytes (indicator of binary content)
    const sample = content.slice(0, 4000);
    return !sample.includes('\0');
  }
  return false;
}

/**
 * Strips common root prefix from paths if all files reside in a single top-level folder
 */
export function normalizeExtractedFiles(rawFiles: ExtractedCodeFile[]): ExtractedCodeFile[] {
  if (rawFiles.length === 0) return [];

  // Filter out any accidental empty entries or ignored paths
  const valid = rawFiles.filter((f) => !isIgnoredPath(f.path) && f.name.trim().length > 0);
  if (valid.length === 0) return [];

  // Determine if all files share a common single root folder
  const splitPaths = valid.map((f) => f.path.replace(/\\/g, '/').replace(/^\.\//, '').split('/'));
  const firstParts = splitPaths.map((parts) => parts[0]);
  const allShareFirst = splitPaths.every((parts) => parts.length > 1) &&
    firstParts.every((part) => part === firstParts[0]);

  if (allShareFirst && firstParts[0]) {
    const prefixLen = firstParts[0].length + 1;
    return valid.map((f) => {
      const cleanPath = f.path.replace(/\\/g, '/').replace(/^\.\//, '');
      const subpath = cleanPath.slice(prefixLen);
      return {
        ...f,
        subpath: subpath || f.name,
      };
    });
  }

  return valid.map((f) => ({
    ...f,
    subpath: f.path.replace(/\\/g, '/').replace(/^\.\//, ''),
  }));
}

/**
 * Analyze extracted files to suggest project names and detect structure
 */
export function analyzeExtractedFiles(files: ExtractedCodeFile[], defaultName = 'Imported Project'): ImportAnalysis {
  const norm = normalizeExtractedFiles(files);
  const texFiles = norm.filter((f) => f.isTex);
  const hasMainTex = norm.some((f) => f.name.toLowerCase() === 'main.tex');
  const totalSize = norm.reduce((acc, f) => acc + f.size, 0);

  // Detect top-level folders
  const folderSet = new Set<string>();
  for (const f of norm) {
    const parts = f.subpath.split('/');
    if (parts.length > 1) {
      folderSet.add(parts[0]);
    }
  }

  // Derive suggested project name
  let suggested = defaultName.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '');
  suggested = sanitizeFolderName(suggested) || 'Imported Project';

  return {
    files: norm.map((f) => ({ ...f, selected: true })),
    suggestedProjectName: suggested,
    hasMainTex,
    texCount: texFiles.length,
    totalCount: norm.length,
    totalSize,
    topLevelFolders: Array.from(folderSet),
  };
}

/**
 * Extract files from a ZIP archive
 */
export async function extractZipArchive(data: ArrayBuffer | Blob | File): Promise<ExtractedCodeFile[]> {
  const zip = await JSZip.loadAsync(data);
  const files: ExtractedCodeFile[] = [];
  const entries: Array<{ path: string; entry: JSZip.JSZipObject }> = [];

  zip.forEach((rawPath, entry) => {
    const path = rawPath.replace(/\\/g, '/');
    if (!entry.dir && !isIgnoredPath(path)) {
      entries.push({ path, entry });
    }
  });

  for (const { path, entry } of entries) {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const isBinaryExt = /^(png|jpg|jpeg|gif|ico|webp|pdf|zip|tar|gz|exe|dll|dylib|so|o|bin|pyc|class|woff|woff2|ttf|eot)$/i.test(ext);
    if (isBinaryExt) continue;

    try {
      const text = await entry.async('string');
      if (isCodeOrTextFile(path, text)) {
        const name = path.split('/').pop() || path;
        files.push({
          path,
          name,
          subpath: path,
          content: text,
          size: text.length,
          extension: ext,
          isTex: ext === 'tex' || ext === 'latex' || ext === 'ltx',
        });
      }
    } catch {
      // Ignore files that fail to decode as text
    }
  }

  return normalizeExtractedFiles(files);
}

/**
 * Extract files from a TAR archive (.tar, .tar.gz, .tgz)
 */
export async function extractTarArchive(data: ArrayBuffer | Blob | File): Promise<ExtractedCodeFile[]> {
  let buffer = data instanceof ArrayBuffer ? data : await (data as Blob).arrayBuffer();
  let bytes = new Uint8Array(buffer);

  // Check for gzip compression: magic bytes 0x1F, 0x8B
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const decompressed = await new Response(stream).arrayBuffer();
      bytes = new Uint8Array(decompressed);
    } else {
      throw new Error('Gzip decompression is not supported in this browser.');
    }
  }

  const files: ExtractedCodeFile[] = [];
  let offset = 0;
  const decoder = new TextDecoder('utf-8');
  let pendingLongName: string | null = null;

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) {
      offset += 512;
      continue;
    }

    // Name (0..100)
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    let name = decoder.decode(header.subarray(0, nameEnd)).trim();

    // Size (124..136)
    let sizeEnd = 124;
    while (sizeEnd < 136 && header[sizeEnd] !== 0) sizeEnd++;
    const sizeStr = decoder.decode(header.subarray(124, sizeEnd)).trim();
    const size = parseInt(sizeStr, 8) || 0;

    // Typeflag (156)
    const typeflag = String.fromCharCode(header[156] || 48);

    // Prefix (345..500)
    let prefixEnd = 345;
    while (prefixEnd < 500 && header[prefixEnd] !== 0) prefixEnd++;
    const prefix = decoder.decode(header.subarray(345, prefixEnd)).trim();
    if (prefix) name = prefix + '/' + name;

    if (pendingLongName) {
      name = pendingLongName;
      pendingLongName = null;
    }

    offset += 512;
    const dataBytes = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {
      // GNU Long filename
      pendingLongName = decoder.decode(dataBytes).replace(/\0.*$/, '').trim();
    } else if (typeflag === 'x') {
      // PAX extended header
      const paxText = decoder.decode(dataBytes);
      const match = paxText.match(/\d+ path=(.+)\n/);
      if (match) pendingLongName = match[1].trim();
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      // Normal file
      if (name && !name.endsWith('/') && !isIgnoredPath(name)) {
        const ext = name.split('.').pop()?.toLowerCase() || '';
        const isBinaryExt = /^(png|jpg|jpeg|gif|ico|webp|pdf|zip|tar|gz|exe|dll|dylib|so|o|bin|pyc|class)$/i.test(ext);
        if (!isBinaryExt) {
          const content = decoder.decode(dataBytes);
          if (isCodeOrTextFile(name, content)) {
            const fileNameOnly = name.split('/').pop() || name;
            files.push({
              path: name,
              name: fileNameOnly,
              subpath: name,
              content,
              size,
              extension: ext,
              isTex: ext === 'tex' || ext === 'latex' || ext === 'ltx',
            });
          }
        }
      }
    }
  }

  return normalizeExtractedFiles(files);
}

/**
 * Extract files from a FileList (e.g. from an <input webkitdirectory> or multi-file input)
 */
export async function extractFilesFromList(fileList: FileList | File[]): Promise<ExtractedCodeFile[]> {
  const files: ExtractedCodeFile[] = [];
  const list = Array.from(fileList);

  for (const f of list) {
    const rawPath = (f as any).webkitRelativePath || f.name;
    const relativePath = rawPath.replace(/\\/g, '/');
    if (isIgnoredPath(relativePath)) continue;

    // Check if user uploaded a .zip or .tar archive in the file list
    if (list.length === 1) {
      if (/\.zip$/i.test(f.name)) return extractZipArchive(f);
      if (/\.(tar|tar\.gz|tgz)$/i.test(f.name)) return extractTarArchive(f);
    }

    const ext = relativePath.split('.').pop()?.toLowerCase() || '';
    const isBinaryExt = /^(png|jpg|jpeg|gif|ico|webp|pdf|zip|tar|gz|exe|dll|dylib|so|o|bin|pyc|class)$/i.test(ext);
    if (isBinaryExt) continue;

    try {
      const text = await f.text();
      if (isCodeOrTextFile(relativePath, text)) {
        const name = relativePath.split('/').pop() || f.name;
        files.push({
          path: relativePath,
          name,
          subpath: relativePath,
          content: text,
          size: f.size,
          extension: ext,
          isTex: ext === 'tex' || ext === 'latex' || ext === 'ltx',
        });
      }
    } catch {
      // Ignore unreadable files
    }
  }

  return normalizeExtractedFiles(files);
}

/**
 * Recursively traverse FileSystemEntry objects from HTML5 Drag and Drop
 */
async function traverseFileSystemEntry(entry: any, basePath = ''): Promise<ExtractedCodeFile[]> {
  if (!entry) return [];
  const files: ExtractedCodeFile[] = [];
  const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

  if (isIgnoredPath(entryPath)) return [];

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file(resolve, reject);
    }).catch(() => null);

    if (file) {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const isBinaryExt = /^(png|jpg|jpeg|gif|ico|webp|pdf|zip|tar|gz|exe|dll|dylib|so|o|bin|pyc|class)$/i.test(ext);
      if (!isBinaryExt) {
        try {
          const text = await file.text();
          if (isCodeOrTextFile(entryPath, text)) {
            files.push({
              path: entryPath,
              name: file.name,
              subpath: entryPath,
              content: text,
              size: file.size,
              extension: ext,
              isTex: ext === 'tex' || ext === 'latex' || ext === 'ltx',
            });
          }
        } catch {
          // Ignore
        }
      }
    }
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    const readEntriesBatch = async (): Promise<any[]> => {
      return new Promise((resolve, reject) => {
        dirReader.readEntries(resolve, reject);
      });
    };

    let batch: any[];
    do {
      batch = await readEntriesBatch().catch(() => []);
      for (const child of batch) {
        const subFiles = await traverseFileSystemEntry(child, entryPath);
        files.push(...subFiles);
      }
    } while (batch && batch.length > 0);
  }

  return files;
}

/**
 * Extract files from Drag and Drop DataTransfer (handles folders, archives, and files)
 */
export async function extractFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<{ files: ExtractedCodeFile[]; sourceName: string }> {
  // Check if item contains webkitGetAsEntry
  const items = dataTransfer.items;
  if (items && items.length > 0 && typeof (items[0] as any).webkitGetAsEntry === 'function') {
    const entries: any[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = (items[i] as any).webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) {
      const collected: ExtractedCodeFile[] = [];
      for (const entry of entries) {
        if (entry.isFile && /\.(zip|tar|tar\.gz|tgz)$/i.test(entry.name)) {
          const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject)).catch(() => null);
          if (file) {
            if (/\.zip$/i.test(file.name)) {
              const zipFiles = await extractZipArchive(file);
              return { files: zipFiles, sourceName: file.name };
            } else {
              const tarFiles = await extractTarArchive(file);
              return { files: tarFiles, sourceName: file.name };
            }
          }
        }
        const res = await traverseFileSystemEntry(entry, '');
        collected.push(...res);
      }
      if (collected.length > 0) {
        return {
          files: normalizeExtractedFiles(collected),
          sourceName: entries[0].name,
        };
      }
    }
  }

  // Fallback to dataTransfer.files
  const rawFiles = Array.from(dataTransfer.files || []);
  if (rawFiles.length === 1) {
    const f = rawFiles[0];
    if (/\.zip$/i.test(f.name)) {
      const files = await extractZipArchive(f);
      return { files, sourceName: f.name };
    }
    if (/\.(tar|tar\.gz|tgz)$/i.test(f.name)) {
      const files = await extractTarArchive(f);
      return { files, sourceName: f.name };
    }
  }

  const files = await extractFilesFromList(rawFiles);
  return { files, sourceName: rawFiles[0]?.name || 'Imported Files' };
}

/**
 * Options for integrating files into the LaTeX workspace
 */
export interface IntegrationOptions {
  mode: 'new-project' | 'into-active' | 'multi-project';
  projectName?: string;
  targetProjectId?: string | null;
  targetFolderId?: string | null;
}

/**
 * Integrates extracted code files into the workspace tree.
 */
export function integrateFilesIntoWorkspace(
  tree: LatexRootNode[],
  files: ExtractedCodeFile[],
  options: IntegrationOptions
): {
  tree: LatexRootNode[];
  activeFileId: string | null;
  affectedProjectId: string | null;
  importedCount: number;
} {
  const selectedFiles = files.filter((f) => f.selected !== false);
  if (selectedFiles.length === 0) {
    return { tree, activeFileId: null, affectedProjectId: null, importedCount: 0 };
  }

  const now = Date.now();

  // Mode 1: Integrate into an existing active project
  if (options.mode === 'into-active' && options.targetProjectId) {
    const project = findProject(tree, options.targetProjectId);
    if (project) {
      let targetFileId: string | null = null;
      const updatedFiles = [...project.files];

      // Check if project has only an untouched default main.tex
      const isUntouchedSkeleton =
        updatedFiles.length === 1 &&
        updatedFiles[0].name === 'main.tex' &&
        updatedFiles[0].content.includes('\\documentclass');

      for (const f of selectedFiles) {
        // Choose file name: preserve subpath if meaningful (e.g. chapters/intro.tex), else use f.name
        const chosenName = f.subpath.includes('/') ? f.subpath : f.name;

        // If it's main.tex and project was just an untouched skeleton, replace that file
        if (f.name.toLowerCase() === 'main.tex' && isUntouchedSkeleton && updatedFiles.length === 1) {
          updatedFiles[0] = {
            ...updatedFiles[0],
            content: f.content,
            updatedAt: now,
          };
          targetFileId = updatedFiles[0].id;
          continue;
        }

        // Check if file with same name already exists in this project
        const existingIndex = updatedFiles.findIndex((ex) => ex.name === chosenName);
        if (existingIndex >= 0) {
          updatedFiles[existingIndex] = {
            ...updatedFiles[existingIndex],
            content: f.content,
            updatedAt: now,
          };
          if (!targetFileId || f.name.toLowerCase() === 'main.tex') {
            targetFileId = updatedFiles[existingIndex].id;
          }
        } else {
          const newFile: LatexFileNode = {
            id: uid('file'),
            kind: 'file',
            name: uniqueName(updatedFiles, chosenName),
            content: f.content,
            updatedAt: now,
          };
          updatedFiles.push(newFile);
          if (!targetFileId || f.name.toLowerCase() === 'main.tex') {
            targetFileId = newFile.id;
          }
        }
      }

      // Update tree
      const nextTree = tree.map((node) => {
        if (node.kind === 'project' && node.id === project.id) {
          return { ...node, files: updatedFiles, updatedAt: now };
        }
        if (node.kind === 'folder') {
          return {
            ...node,
            projects: node.projects.map((p) =>
              p.id === project.id ? { ...p, files: updatedFiles, updatedAt: now } : p
            ),
          };
        }
        return node;
      });

      return {
        tree: nextTree,
        activeFileId: targetFileId || updatedFiles[0]?.id || null,
        affectedProjectId: project.id,
        importedCount: selectedFiles.length,
      };
    }
  }

  // Mode 2: Multi-project integration (when archive has multiple distinct project subfolders)
  if (options.mode === 'multi-project') {
    const groups = new Map<string, ExtractedCodeFile[]>();
    const rootFiles: ExtractedCodeFile[] = [];

    for (const f of selectedFiles) {
      const parts = f.subpath.split('/');
      if (parts.length > 1) {
        const folder = parts[0];
        const subFiles = groups.get(folder) || [];
        subFiles.push({
          ...f,
          subpath: parts.slice(1).join('/'),
          name: parts.slice(1).join('/') || f.name,
        });
        groups.set(folder, subFiles);
      } else {
        rootFiles.push(f);
      }
    }

    if (groups.size > 1 || (groups.size === 1 && rootFiles.length > 0)) {
      const folderName = sanitizeFolderName(options.projectName || 'Imported Workspace') || 'Imported Workspace';
      const createdProjects: LatexProjectNode[] = [];
      let firstFileId: string | null = null;

      // Create a project for each folder
      for (const [name, gFiles] of groups.entries()) {
        const pFiles: LatexFileNode[] = gFiles.map((gf) => ({
          id: uid('file'),
          kind: 'file',
          name: gf.subpath || gf.name,
          content: gf.content,
          updatedAt: now,
        }));
        // Prioritize main.tex
        pFiles.sort((a, b) => (a.name.toLowerCase() === 'main.tex' ? -1 : b.name.toLowerCase() === 'main.tex' ? 1 : 0));
        const proj: LatexProjectNode = {
          id: uid('proj'),
          kind: 'project',
          name: sanitizeFolderName(name) || name,
          files: pFiles,
          createdAt: now,
          updatedAt: now,
        };
        if (!firstFileId && pFiles.length > 0) firstFileId = pFiles[0].id;
        createdProjects.push(proj);
      }

      if (rootFiles.length > 0) {
        const pFiles: LatexFileNode[] = rootFiles.map((rf) => ({
          id: uid('file'),
          kind: 'file',
          name: rf.name,
          content: rf.content,
          updatedAt: now,
        }));
        pFiles.sort((a, b) => (a.name.toLowerCase() === 'main.tex' ? -1 : b.name.toLowerCase() === 'main.tex' ? 1 : 0));
        const rootProj: LatexProjectNode = {
          id: uid('proj'),
          kind: 'project',
          name: 'General',
          files: pFiles,
          createdAt: now,
          updatedAt: now,
        };
        if (!firstFileId && pFiles.length > 0) firstFileId = pFiles[0].id;
        createdProjects.unshift(rootProj);
      }

      const folderNode: LatexFolderNode = {
        id: uid('folder'),
        kind: 'folder',
        name: folderName,
        projects: createdProjects,
      };

      return {
        tree: [...tree, folderNode],
        activeFileId: firstFileId,
        affectedProjectId: createdProjects[0]?.id || null,
        importedCount: selectedFiles.length,
      };
    }
  }

  // Mode 3: Create as a new single project (standard default)
  const projName = sanitizeFolderName(options.projectName || 'Imported Project') || 'Imported Project';

  const fileNodes: LatexFileNode[] = selectedFiles.map((f) => ({
    id: uid('file'),
    kind: 'file',
    name: f.subpath.includes('/') ? f.subpath : f.name,
    content: f.content,
    updatedAt: now,
  }));

  // Sort so main.tex is at the top
  fileNodes.sort((a, b) => {
    const aIsMain = a.name.toLowerCase() === 'main.tex' || a.name.toLowerCase().endsWith('/main.tex');
    const bIsMain = b.name.toLowerCase() === 'main.tex' || b.name.toLowerCase().endsWith('/main.tex');
    if (aIsMain && !bIsMain) return -1;
    if (!aIsMain && bIsMain) return 1;
    return a.name.localeCompare(b.name);
  });

  const newProject: LatexProjectNode = {
    id: uid('proj'),
    kind: 'project',
    name: projName,
    files: fileNodes,
    createdAt: now,
    updatedAt: now,
  };

  let nextTree: LatexRootNode[];
  if (options.targetFolderId) {
    nextTree = tree.map((node) =>
      node.kind === 'folder' && node.id === options.targetFolderId
        ? { ...node, projects: [...node.projects, newProject] }
        : node
    );
  } else {
    nextTree = [...tree, newProject];
  }

  return {
    tree: nextTree,
    activeFileId: fileNodes[0]?.id || null,
    affectedProjectId: newProject.id,
    importedCount: selectedFiles.length,
  };
}
