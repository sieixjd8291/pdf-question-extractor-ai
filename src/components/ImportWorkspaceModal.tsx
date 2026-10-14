import React, { useState, useRef, useEffect } from 'react';
import {
  FolderArchive,
  FolderUp,
  FileCode2,
  FileText,
  Upload,
  Check,
  X,
  AlertCircle,
  Loader2,
  FileUp,
} from 'lucide-react';
import { useDialog } from '../hooks/useDialog';
import {
  ExtractedCodeFile,
  ImportAnalysis,
  analyzeExtractedFiles,
  extractZipArchive,
  extractTarArchive,
  extractFilesFromList,
  extractFromDataTransfer,
  IntegrationOptions,
} from '../lib/archiveImporter';
import { LatexProjectNode } from '../lib/latexProjects';

interface ImportWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeProject: LatexProjectNode | null;
  onImport: (files: ExtractedCodeFile[], options: IntegrationOptions) => void;
  initialFiles?: ExtractedCodeFile[] | null;
  initialSource?: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function ImportWorkspaceModal({
  isOpen,
  onClose,
  activeProject,
  onImport,
  initialFiles,
  initialSource,
}: ImportWorkspaceModalProps) {
  const dialogRef = useDialog(onClose);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string>(initialSource || '');
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);

  // Form options
  const [mode, setMode] = useState<'new-project' | 'into-active' | 'multi-project'>('new-project');
  const [projectName, setProjectName] = useState('');
  const [dragActive, setDragActive] = useState(false);

  // Initialize with passed-in initial files (e.g. from drag-and-drop onto the main window)
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) {
      const a = analyzeExtractedFiles(initialFiles, initialSource || 'Imported Project');
      setAnalysis(a);
      setProjectName(a.suggestedProjectName);
      setSourceName(initialSource || 'Dropped Archive');
      if (a.topLevelFolders.length > 1) {
        setMode('multi-project');
      } else {
        setMode('new-project');
      }
    } else {
      setAnalysis(null);
      setError(null);
      setSourceName('');
    }
  }, [initialFiles, initialSource, isOpen]);

  if (!isOpen) return null;

  const handleProcessFiles = (extracted: ExtractedCodeFile[], source: string) => {
    if (extracted.length === 0) {
      setError('No code or text files found in the selected folder or archive.');
      setAnalysis(null);
      return;
    }
    setError(null);
    setSourceName(source);
    const a = analyzeExtractedFiles(extracted, source);
    setAnalysis(a);
    setProjectName(a.suggestedProjectName);
    if (a.topLevelFolders.length > 1) {
      setMode('multi-project');
    } else {
      setMode('new-project');
    }
  };

  const handleArchiveSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      let extracted: ExtractedCodeFile[];
      if (/\.zip$/i.test(file.name)) {
        extracted = await extractZipArchive(file);
      } else if (/\.(tar|tar\.gz|tgz)$/i.test(file.name)) {
        extracted = await extractTarArchive(file);
      } else {
        throw new Error('Unsupported archive format. Please choose a .zip, .tar, .tar.gz, or .tgz file.');
      }
      handleProcessFiles(extracted, file.name);
    } catch (err: any) {
      setError(err?.message || 'Failed to extract archive.');
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const extracted = await extractFilesFromList(files);
      const rootFolder = (files[0] as any).webkitRelativePath?.split('/')?.[0] || 'Imported Folder';
      handleProcessFiles(extracted, rootFolder);
    } catch (err: any) {
      setError(err?.message || 'Failed to read folder.');
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const handleDirectFilesSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const extracted = await extractFilesFromList(files);
      handleProcessFiles(extracted, files.length === 1 ? files[0].name : `${files.length} Files`);
    } catch (err: any) {
      setError(err?.message || 'Failed to read files.');
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    setLoading(true);
    setError(null);
    try {
      const res = await extractFromDataTransfer(e.dataTransfer);
      handleProcessFiles(res.files, res.sourceName);
    } catch (err: any) {
      setError(err?.message || 'Failed to read dropped items.');
    } finally {
      setLoading(false);
    }
  };

  const toggleFileSelection = (path: string) => {
    if (!analysis) return;
    setAnalysis({
      ...analysis,
      files: analysis.files.map((f) =>
        f.path === path ? { ...f, selected: f.selected === false ? true : false } : f
      ),
    });
  };

  const selectAll = (selected: boolean) => {
    if (!analysis) return;
    setAnalysis({
      ...analysis,
      files: analysis.files.map((f) => ({ ...f, selected })),
    });
  };

  const selectedCount = analysis?.files.filter((f) => f.selected !== false).length || 0;

  const handleConfirmImport = () => {
    if (!analysis) return;
    const selectedFiles = analysis.files.filter((f) => f.selected !== false);
    if (selectedFiles.length === 0) return;

    onImport(selectedFiles, {
      mode,
      projectName: projectName.trim() || analysis.suggestedProjectName,
      targetProjectId: activeProject?.id || null,
    });
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      style={{ zIndex: 75 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal-panel md import-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        tabIndex={-1}
        style={{ maxWidth: 640, width: '92%' }}
      >
        {/* Hidden inputs */}
        <input
          ref={archiveInputRef}
          type="file"
          accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/x-tar,application/gzip,application/x-gzip"
          hidden
          onChange={handleArchiveSelect}
        />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error webkitdirectory is standard in HTML5 browsers
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={handleFolderSelect}
        />
        <input
          ref={filesInputRef}
          type="file"
          multiple
          accept=".tex,.latex,.ltx,.bib,.sty,.cls,.txt,.md,.json,.py,.c,.cpp,.h,.java,.js,.ts"
          hidden
          onChange={handleDirectFilesSelect}
        />

        {/* Modal Header */}
        <header className="import-modal-head">
          <div className="import-modal-title">
            <span className="import-modal-icon">
              <FolderArchive size={18} />
            </span>
            <div>
              <h2 id="import-title" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                Import Code & Projects
              </h2>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--secondary)' }}>
                Integrate ZIP, TAR, TGZ archives, folders, or LaTeX code files
              </p>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </button>
        </header>

        {/* Body content */}
        <div className="import-modal-body" style={{ padding: '16px 20px' }}>
          {error && (
            <div className="banner error mb-3" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 13 }}>{error}</span>
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px 16px' }}>
              <Loader2 size={32} className="spinner" style={{ margin: '0 auto 12px', color: 'var(--accent)' }} />
              <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Unpacking and parsing files…</p>
              <p style={{ fontSize: 12, color: 'var(--secondary)', margin: '4px 0 0' }}>
                Scanning archive entries and extracting code files
              </p>
            </div>
          ) : !analysis ? (
            /* Initial state: Dropzone and Browse buttons */
            <div
              className={`import-dropzone ${dragActive ? 'active' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              style={{
                border: '2px dashed var(--line-strong)',
                borderRadius: 'var(--r-lg)',
                padding: '36px 20px',
                textAlign: 'center',
                background: dragActive ? 'var(--accent-soft)' : 'var(--muted)',
                transition: 'all var(--t)',
              }}
            >
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: '50%',
                  background: 'var(--surface)',
                  display: 'grid',
                  placeItems: 'center',
                  margin: '0 auto 14px',
                  boxShadow: 'var(--shadow-xs)',
                  color: 'var(--accent)',
                }}
              >
                <Upload size={24} />
              </div>

              <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>
                Drag and drop your archive or folder here
              </h3>
              <p style={{ fontSize: 12.5, color: 'var(--secondary)', maxWidth: 440, margin: '0 auto 20px', lineHeight: 1.5 }}>
                Supports <strong>.zip</strong>, <strong>.tar</strong>, <strong>.tar.gz</strong>, <strong>.tgz</strong> archives,
                or complete directories containing <strong>.tex</strong>, <strong>.bib</strong>, <strong>.sty</strong>, and code files.
              </p>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn primary btn-sm"
                  onClick={() => archiveInputRef.current?.click()}
                >
                  <FolderArchive size={14} />
                  <span>Choose Archive (.zip / .tar)</span>
                </button>
                <button
                  type="button"
                  className="btn secondary btn-sm"
                  onClick={() => folderInputRef.current?.click()}
                >
                  <FolderUp size={14} />
                  <span>Choose Folder</span>
                </button>
                <button
                  type="button"
                  className="btn quiet btn-sm"
                  onClick={() => filesInputRef.current?.click()}
                >
                  <FileUp size={14} />
                  <span>Select Files</span>
                </button>
              </div>
            </div>
          ) : (
            /* Analysis state: configure destination and preview files */
            <div className="import-configured-view">
              {/* Source Info Bar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  background: 'var(--muted)',
                  borderRadius: 'var(--r-md)',
                  marginBottom: 16,
                  border: '1px solid var(--line)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <FolderArchive size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sourceName}
                  </span>
                  <span className="chip" style={{ fontSize: 11 }}>
                    {analysis.totalCount} code file{analysis.totalCount === 1 ? '' : 's'} ({formatBytes(analysis.totalSize)})
                  </span>
                </div>
                <button
                  type="button"
                  className="btn quiet btn-sm"
                  style={{ fontSize: 11.5, height: 26 }}
                  onClick={() => {
                    setAnalysis(null);
                    setError(null);
                  }}
                >
                  Change file
                </button>
              </div>

              {/* Destination Mode Selector */}
              <div style={{ marginBottom: 18 }}>
                <label style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--secondary)', display: 'block', marginBottom: 8 }}>
                  Import Destination
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '10px 12px',
                      borderRadius: 'var(--r-md)',
                      border: `1.5px solid ${mode === 'new-project' ? 'var(--accent)' : 'var(--line)'}`,
                      background: mode === 'new-project' ? 'var(--accent-soft)' : 'var(--surface)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="import-mode"
                      checked={mode === 'new-project'}
                      onChange={() => setMode('new-project')}
                      style={{ marginTop: 2 }}
                    />
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>New Project</span>
                      <span style={{ fontSize: 11, color: 'var(--secondary)' }}>Create as a clean project</span>
                    </div>
                  </label>

                  {activeProject && (
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        padding: '10px 12px',
                        borderRadius: 'var(--r-md)',
                        border: `1.5px solid ${mode === 'into-active' ? 'var(--accent)' : 'var(--line)'}`,
                        background: mode === 'into-active' ? 'var(--accent-soft)' : 'var(--surface)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="radio"
                        name="import-mode"
                        checked={mode === 'into-active'}
                        onChange={() => setMode('into-active')}
                        style={{ marginTop: 2 }}
                      />
                      <div>
                        <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                          Into “{activeProject.name}”
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--secondary)' }}>Add into open project</span>
                      </div>
                    </label>
                  )}

                  {analysis.topLevelFolders.length > 1 && (
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        padding: '10px 12px',
                        borderRadius: 'var(--r-md)',
                        border: `1.5px solid ${mode === 'multi-project' ? 'var(--accent)' : 'var(--line)'}`,
                        background: mode === 'multi-project' ? 'var(--accent-soft)' : 'var(--surface)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="radio"
                        name="import-mode"
                        checked={mode === 'multi-project'}
                        onChange={() => setMode('multi-project')}
                        style={{ marginTop: 2 }}
                      />
                      <div>
                        <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>Folder Hierarchy</span>
                        <span style={{ fontSize: 11, color: 'var(--secondary)' }}>
                          {analysis.topLevelFolders.length} projects in a folder
                        </span>
                      </div>
                    </label>
                  )}
                </div>
              </div>

              {/* Project Name Field (when creating new project or multi-project folder) */}
              {(mode === 'new-project' || mode === 'multi-project') && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                    {mode === 'multi-project' ? 'Folder Name' : 'Project Name'}
                  </label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="Enter project name"
                    style={{ width: '100%', padding: '7px 10px', fontSize: 13 }}
                  />
                </div>
              )}

              {/* File List Header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 6,
                  padding: '0 2px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--secondary)' }}>
                    Files to Import ({selectedCount}/{analysis.totalCount})
                  </span>
                  {analysis.hasMainTex && (
                    <span className="chip accent" style={{ fontSize: 10.5, padding: '1px 6px' }}>
                      main.tex detected
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn quiet btn-sm"
                    style={{ height: 22, fontSize: 11, padding: '0 6px' }}
                    onClick={() => selectAll(true)}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="btn quiet btn-sm"
                    style={{ height: 22, fontSize: 11, padding: '0 6px' }}
                    onClick={() => selectAll(false)}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* File List */}
              <div
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-md)',
                  maxHeight: 190,
                  overflowY: 'auto',
                  background: 'var(--surface)',
                }}
              >
                {analysis.files.map((file) => {
                  const isChecked = file.selected !== false;
                  return (
                    <div
                      key={file.path}
                      onClick={() => toggleFileSelection(file.path)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        borderBottom: '1px solid var(--line)',
                        cursor: 'pointer',
                        fontSize: 12.5,
                        background: isChecked ? 'transparent' : 'var(--muted)',
                        opacity: isChecked ? 1 : 0.65,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        style={{ cursor: 'pointer' }}
                      />
                      {file.isTex ? (
                        <FileCode2 size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                      ) : (
                        <FileText size={14} style={{ color: 'var(--secondary)', flexShrink: 0 }} />
                      )}
                      <span
                        style={{
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: file.isTex ? 600 : 400,
                        }}
                        title={file.subpath}
                      >
                        {file.subpath}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--secondary)', flexShrink: 0 }}>
                        {formatBytes(file.size)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <footer className="import-modal-foot" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          {analysis && (
            <button
              type="button"
              className="btn primary"
              onClick={handleConfirmImport}
              disabled={selectedCount === 0}
            >
              <Check size={14} />
              <span>
                Integrate {selectedCount} File{selectedCount === 1 ? '' : 's'}
              </span>
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
