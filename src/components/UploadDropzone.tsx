import { useState, useRef } from 'react';
import { Upload, ArrowRight, FileText, LockKeyhole, Layers, ScanLine, Download, AlertCircle } from 'lucide-react';
import { AppMode, ExtractionSettings } from '../types';

interface Props {
  appMode: AppMode;
  onFileUpload: (file: File) => void;
  settings: ExtractionSettings;
  onUpdateSettings: (s: Partial<ExtractionSettings>) => void;
  isProcessing: boolean;
}

export function UploadDropzone({ appMode, onFileUpload, settings, onUpdateSettings, isProcessing }: Props) {
  const [drag, setDrag] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), depth = useRef(0);
  const book = appMode === 'book-mapper';

  function accept(files: FileList | null) {
    if (isProcessing || !files?.length) return;
    if (files.length !== 1) { setError('Choose one document or image at a time.'); return; }
    const file = files[0];
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    const isImg = /^image\//i.test(file.type) || /\.(jpe?g|png|webp|bmp)$/i.test(file.name);
    if (!isPdf && !isImg) { setError('Please choose a .pdf document or image file.'); return; }
    if (!file.size) { setError('This file is empty. Please choose another file.'); return; }
    setError(''); onFileUpload(file);
  }

  return <div className="upload-workspace">
    <section className="welcome">
      <h1>Upload a PDF</h1>
      <p>Turn books into organized chapters or extract questions into ready-to-use files.</p>
    </section>

    <section className="upload-panel" aria-labelledby="upload-heading">
      <div className="panel-heading">
        <div>
          <h2 id="upload-heading">{book ? 'Upload your book' : 'Upload your question paper'}</h2>
          <p>{book ? 'Best with bookmarked books or a clear table of contents.' : 'Best with selectable, numbered question text.'}</p>
        </div>
        <span>Add your PDF</span>
      </div>
      <div
        id="pdf-dropzone"
        className={'dropzone ' + (drag ? 'dragging ' : '') + (error ? 'invalid' : '')}
        onDragEnter={e => { e.preventDefault(); depth.current++; setDrag(true); }}
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDragLeave={e => { e.preventDefault(); if (--depth.current <= 0) { depth.current = 0; setDrag(false); } }}
        onDrop={e => { e.preventDefault(); depth.current = 0; setDrag(false); accept(e.dataTransfer.files); }}
      >
        <span className="upload-icon"><Upload size={24} /></span>
        <h3>{drag ? 'Drop your document to get started' : 'Drag and drop your PDF or image here'}</h3>
        <p>or choose a file from your device</p>
        <button className="btn primary" disabled={isProcessing} onClick={() => input.current?.click()}><Upload size={15} />Choose File<ArrowRight size={15} /></button>
        <input ref={input} type="file" accept=".pdf,application/pdf,image/*,.png,.jpg,.jpeg,.webp" aria-label="Choose PDF or image document" hidden disabled={isProcessing} onChange={e => { accept(e.target.files); e.target.value = ''; }} />
        <small><FileText size={13} />PDF or images · Auto-detects & fixes orientation to 0° upright</small>
      </div>
      {error && <div className="notice" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
      <div className="upload-options">
        <span><LockKeyhole size={15} />{book ? 'Initial chapter mapping runs in your browser' : 'Question detection runs in your browser'}</span>
        {!book
          ? <label>Render quality
            <select aria-label="Render quality" value={settings.renderScale} onChange={e => onUpdateSettings({ renderScale: Number(e.target.value) })}>
              <option value={2}>Standard · 2×</option>
              <option value={3}>High · 3×</option>
            </select>
          </label>
          : <span>No sign-up required</span>}
      </div>
    </section>

    <section className="steps-line" aria-label="How it works">
      <span><Layers size={15} />Upload a document</span>
      <ArrowRight size={14} />
      <span><ScanLine size={15} />Review the results</span>
      <ArrowRight size={14} />
      <span><Download size={15} />Export what you need</span>
    </section>

    <footer className="workspace-footer">
      <span>PDF Studio</span>
      <span>Your documents stay on your device.</span>
    </footer>
  </div>;
}
