import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { CheckCircle2, AlertTriangle, Download, ImagePlus, Merge, Scissors, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { Dialog } from './dialogs';
import { geminiAuthHeaders } from '../../lib/geminiSettings';
import {
  buildFontFromSamples,
  loadSampleImage,
  mergePieces,
  rowMatched,
  segmentSample,
  splitPiece,
  type InkMap,
  type SampleRow,
} from '../../lib/handwriting/sampleFont';

const DEFAULT_TEXT = 'The quick brown fox jumps over the lazy dog';
const BASIC_SET = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?!\'');
const ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg';

interface Sample {
  id: number;
  name: string;
  url: string;
  aiImage: string;
  ink: InkMap;
  text: string;
  rows: SampleRow[];
  error?: string;
  reading?: boolean;
  aiNote?: string;
}

type Selection = { row: number; index: number } | null;

async function readHandwriting(imageData: string): Promise<string> {
  const res = await fetch('/api/transcribe-handwriting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
    body: JSON.stringify({ imageData }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'AI could not read the image.');
  const lines: string[] = Array.isArray(data.lines) ? data.lines : [];
  if (!lines.length) throw new Error('AI found no handwriting in this image.');
  return lines.join('\n');
}

function SampleOverlay({ sample, selection, onSelect }: { sample: Sample; selection: Selection; onSelect: (s: Selection) => void }) {
  const { ink, rows } = sample;
  const labelSize = Math.max(14, Math.min(ink.width, ink.height * 4) * 0.012);
  return (
    <div className="am-sf-stage">
      <div className="am-sf-canvas">
        <img src={sample.url} alt={`Handwriting sample ${sample.name}`} />
        <svg viewBox={`0 0 ${ink.width} ${ink.height}`} preserveAspectRatio="none" aria-hidden="true">
          {rows.map((row, r) => {
            const ok = rowMatched(row);
            return row.pieces.map((p, i) => {
              const active = selection?.row === r && selection.index === i;
              return (
                <g key={`${r}-${i}`} className={`am-sf-piece ${ok ? 'ok' : 'off'} ${active ? 'active' : ''}`} onClick={() => onSelect(active ? null : { row: r, index: i })}>
                  <rect x={p.x0 - 2} y={p.y0 - 2} width={p.x1 - p.x0 + 5} height={p.y1 - p.y0 + 5} rx={3} />
                  <text x={(p.x0 + p.x1) / 2} y={p.y0 - 6} fontSize={labelSize} textAnchor="middle">{row.letters[i] ?? '?'}</text>
                </g>
              );
            });
          })}
        </svg>
      </div>
    </div>
  );
}

export function SampleFontDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, buffer: ArrayBuffer) => Promise<void> }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [fontName, setFontName] = useState('My handwriting');
  const [busy, setBusy] = useState<'load' | 'build' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const urls = useRef<string[]>([]);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const activeIndex = samples.findIndex((s) => s.id === activeId);
  const current = activeIndex >= 0 ? samples[activeIndex] : undefined;

  const updateSample = (id: number, patch: (s: Sample) => Sample) => {
    setSamples((prev) => prev.map((s) => (s.id === id ? patch(s) : s)));
  };

  const applyText = (s: Sample, text: string): Sample => {
    const seg = segmentSample(s.ink, text);
    return { ...s, text, rows: seg.rows, error: seg.error };
  };

  const runAi = async (id: number, aiImage: string) => {
    updateSample(id, (s) => ({ ...s, reading: true, aiNote: undefined }));
    try {
      const text = await readHandwriting(aiImage);
      updateSample(id, (s) => ({ ...applyText(s, text), reading: false, aiNote: 'Read by AI. Check every character before creating the font.' }));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'AI could not read the image.';
      updateSample(id, (s) => ({ ...s, reading: false, aiNote: `${message} Type the text yourself instead.` }));
    }
    setSelection(null);
  };

  const addFiles = async (files: File[]) => {
    const images = files.filter((f) => /^image\/(png|jpeg|webp|svg\+xml)$/.test(f.type) || /\.(png|jpe?g|webp|svg)$/i.test(f.name));
    if (!images.length) {
      setError('Use a PNG, JPG, WEBP or SVG image.');
      return;
    }
    setBusy('load');
    setError(null);
    for (const file of images) {
      try {
        const { ink, url, aiImage } = await loadSampleImage(file);
        urls.current.push(url);
        const id = nextId.current++;
        setSamples((prev) => [...prev, { id, name: file.name, url, aiImage, ink, text: '', rows: [] }]);
        setActiveId(id);
        setSelection(null);
        void runAi(id, aiImage);
      } catch {
        setError(`${file.name} could not be read. Use a PNG, JPG, WEBP or SVG file.`);
      }
    }
    setBusy(null);
  };

  const setText = (text: string) => {
    if (!current) return;
    setSelection(null);
    updateSample(current.id, (s) => applyText(s, text));
  };

  const editPieces = (fn: (pieces: SampleRow['pieces'], ink: InkMap) => SampleRow['pieces'] | null) => {
    if (!selection || !current) return;
    const row = current.rows[selection.row];
    const next = fn(row.pieces, current.ink);
    if (!next) return;
    updateSample(current.id, (s) => ({ ...s, rows: s.rows.map((r, i) => (i === selection.row ? { ...r, pieces: next } : r)) }));
    setSelection(null);
  };

  const removeSample = (id: number) => {
    const remaining = samples.filter((s) => s.id !== id);
    setSamples(remaining);
    if (activeId === id) setActiveId(remaining.length ? remaining[Math.max(0, activeIndex - 1)].id : null);
    setSelection(null);
  };

  const covered = useMemo(() => {
    const set = new Set<string>();
    for (const s of samples) for (const row of s.rows) if (rowMatched(row)) row.letters.forEach((ch) => set.add(ch));
    return set;
  }, [samples]);
  const missing = BASIC_SET.filter((ch) => !covered.has(ch));

  const build = async () => {
    setBusy('build');
    setError(null);
    try {
      return await buildFontFromSamples(fontName.trim(), samples.map((s) => ({ ink: s.ink, rows: s.rows })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The font could not be built.');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const font = await build();
    if (font) await onCreate(fontName.trim() || 'My handwriting', font.buffer);
  };

  const download = async () => {
    const font = await build();
    if (!font) return;
    const url = URL.createObjectURL(new Blob([font.buffer], { type: 'font/otf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(fontName.trim() || 'my-handwriting').replace(/[^\w-]+/g, '-')}.otf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const selectedRow = selection && current ? current.rows[selection.row] : null;
  const matchedRows = current ? current.rows.filter(rowMatched).length : 0;
  const anyReading = samples.some((s) => s.reading);

  const dropProps = {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void addFiles(Array.from(e.dataTransfer.files));
    },
  };

  return (
    <Dialog title="Make a font from your handwriting" onClose={onClose} wide>
      <div className="am-sf">
        <div className="am-sf-side">
          <p className="am-sf-intro">
            Upload a PNG, JPG or SVG of your handwriting. AI reads every character, then each letter is cut out and turned into a font.
          </p>

          <div className="am-sf-tabs" role="tablist" aria-label="Samples">
            {samples.map((s, i) => (
              <span key={s.id} className={`am-sf-tab ${s.id === activeId ? 'active' : ''}`}>
                <button type="button" role="tab" aria-selected={s.id === activeId} onClick={() => { setActiveId(s.id); setSelection(null); }}>
                  Sample {i + 1}
                </button>
                <button type="button" className="am-sf-tab-x" aria-label={`Remove sample ${i + 1}`} onClick={() => removeSample(s.id)}><X size={12} /></button>
              </span>
            ))}
            {samples.length > 0 && (
              <button type="button" className="btn secondary btn-sm" disabled={busy === 'load'} onClick={() => fileRef.current?.click()}>
                <ImagePlus size={14} />{busy === 'load' ? 'Reading…' : 'Add sample'}
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length) void addFiles(files);
              }}
            />
          </div>

          {current ? (
            <>
              <div className="am-sf-field">
                <div className="am-sf-field-head">
                  <label htmlFor="am-sf-text">What does it say?</label>
                  <button
                    type="button"
                    className="btn secondary btn-sm"
                    disabled={current.reading}
                    onClick={() => void runAi(current.id, current.aiImage)}
                  >
                    <Sparkles size={14} />{current.reading ? 'Reading…' : 'Read with AI'}
                  </button>
                </div>
                <textarea
                  id="am-sf-text"
                  className="am-textarea am-sf-text"
                  value={current.text}
                  onChange={(e) => setText(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  disabled={current.reading}
                  placeholder={current.reading ? 'AI is reading each character…' : 'Type the text exactly as written, one line per row of writing.'}
                />
                {current.aiNote && <p className="am-sf-note">{current.aiNote}</p>}
              </div>

              {!current.reading && current.text.trim() && (
                current.error ? (
                  <p className="am-sf-status off" role="alert"><AlertTriangle size={14} />{current.error}</p>
                ) : (
                  <div className="am-sf-summary" aria-live="polite">
                    <p className={`am-sf-status ${matchedRows === current.rows.length ? 'ok' : 'off'}`}>
                      {matchedRows === current.rows.length ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                      {matchedRows} of {current.rows.length} lines matched
                    </p>
                    <ul className="am-sf-rows">
                      {current.rows.map((row, r) => (
                        <li key={r} className={rowMatched(row) ? 'ok' : 'off'}>
                          <span className="am-sf-row-text">{row.text}</span>
                          <span className="am-sf-row-count">{row.pieces.length}/{row.letters.length}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              )}
            </>
          ) : (
            <div className="am-sf-empty">
              <p>Write with a dark pen on plain paper and leave a clear gap between lines. An alphabet, digits and a sentence like “{DEFAULT_TEXT}” cover most characters.</p>
            </div>
          )}
        </div>

        <div className="am-sf-main">
          {current ? (
            <>
              <SampleOverlay sample={current} selection={selection} onSelect={setSelection} />
              <div className="am-sf-actions">
                {selection && selectedRow ? (
                  <>
                    <span>Selected: <strong>{selectedRow.letters[selection.index] ?? 'extra piece'}</strong></span>
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={selection.index >= selectedRow.pieces.length - 1}
                      onClick={() => editPieces((p, ink) => [...p.slice(0, selection.index), mergePieces(ink, p[selection.index], p[selection.index + 1]), ...p.slice(selection.index + 2)])}
                    >
                      <Merge size={14} />Merge with next
                    </button>
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      onClick={() => editPieces((p, ink) => {
                        const halves = splitPiece(ink, p[selection.index]);
                        return halves ? [...p.slice(0, selection.index), ...halves, ...p.slice(selection.index + 1)] : null;
                      })}
                    >
                      <Scissors size={14} />Split
                    </button>
                    <button type="button" className="btn secondary btn-sm" onClick={() => editPieces((p) => p.filter((_, i) => i !== selection.index))}>
                      <Trash2 size={14} />Remove
                    </button>
                  </>
                ) : (
                  <span className="am-sf-hint">Blue boxes are matched. Click an orange box to merge, split or remove it.</span>
                )}
              </div>
            </>
          ) : (
            <button
              type="button"
              className={`am-sf-drop ${dragging ? 'dragging' : ''}`}
              disabled={busy === 'load'}
              onClick={() => fileRef.current?.click()}
              {...dropProps}
            >
              <Upload size={22} aria-hidden="true" />
              <strong>{busy === 'load' ? 'Reading image…' : 'Drop handwriting images here'}</strong>
              <span>or click to choose PNG, JPG, WEBP or SVG</span>
            </button>
          )}
        </div>
      </div>

      {error && <p className="am-sf-status off" role="alert"><AlertTriangle size={14} />{error}</p>}

      <footer className="am-sf-foot">
        <label className="am-text-field am-sf-name">
          <span>Font name</span>
          <input value={fontName} onChange={(e) => setFontName(e.target.value)} maxLength={40} />
        </label>
        <p className="am-sf-coverage">
          {covered.size ? `${covered.size} characters ready.` : 'No characters ready yet.'}
          {covered.size > 0 && missing.length > 0 && ` Missing (default font used): ${missing.join(' ')}`}
        </p>
        <div className="am-sf-buttons">
          <button type="button" className="btn secondary btn-sm" disabled={!covered.size || busy !== null || anyReading} onClick={() => void download()}>
            <Download size={14} />Download .otf
          </button>
          <button type="button" className="btn primary btn-sm" disabled={!covered.size || busy !== null || anyReading} onClick={() => void create()}>
            {busy === 'build' ? 'Building…' : 'Create font'}
          </button>
        </div>
      </footer>
    </Dialog>
  );
}
