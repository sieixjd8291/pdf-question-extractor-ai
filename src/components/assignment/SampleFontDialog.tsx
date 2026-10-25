import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ImagePlus, Merge, Scissors, Trash2, X } from 'lucide-react';
import { Dialog } from './dialogs';
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

interface Sample {
  id: number;
  name: string;
  url: string;
  ink: InkMap;
  text: string;
  rows: SampleRow[];
  error?: string;
}

type Selection = { row: number; index: number } | null;

function SampleOverlay({ sample, selection, onSelect }: { sample: Sample; selection: Selection; onSelect: (s: Selection) => void }) {
  const { ink, rows } = sample;
  const labelSize = Math.max(14, ink.height * 0.035);
  return (
    <div className="am-sf-stage">
      <img src={sample.url} alt={`Handwriting sample ${sample.name}`} />
      <svg viewBox={`0 0 ${ink.width} ${ink.height}`} preserveAspectRatio="none" aria-hidden="true">
        {rows.map((row, r) => {
          const ok = rowMatched(row);
          return row.pieces.map((p, i) => {
            const active = selection?.row === r && selection.index === i;
            return (
              <g key={`${r}-${i}`} className={`am-sf-piece ${ok ? 'ok' : 'off'} ${active ? 'active' : ''}`} onClick={() => onSelect(active ? null : { row: r, index: i })}>
                <rect x={p.x0 - 2} y={p.y0 - 2} width={p.x1 - p.x0 + 5} height={p.y1 - p.y0 + 5} rx={3} />
                <text x={(p.x0 + p.x1) / 2} y={p.y0 - 8} fontSize={labelSize} textAnchor="middle">{row.letters[i] ?? '?'}</text>
              </g>
            );
          });
        })}
      </svg>
    </div>
  );
}

export function SampleFontDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, buffer: ArrayBuffer) => Promise<void> }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [active, setActive] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const [fontName, setFontName] = useState('My handwriting');
  const [busy, setBusy] = useState<'load' | 'build' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const urls = useRef<string[]>([]);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const current = samples[active];

  const updateCurrent = (patch: (s: Sample) => Sample) => {
    setSamples((prev) => prev.map((s, i) => (i === active ? patch(s) : s)));
  };

  const addSample = async (file: File) => {
    setBusy('load');
    setError(null);
    try {
      const { ink, url } = await loadSampleImage(file);
      urls.current.push(url);
      const text = samples.length ? '' : DEFAULT_TEXT;
      const seg = segmentSample(ink, text);
      const sample: Sample = { id: nextId.current++, name: file.name, url, ink, text, rows: seg.rows, error: seg.error };
      setSamples((prev) => [...prev, sample]);
      setActive(samples.length);
      setSelection(null);
    } catch {
      setError('That image could not be read. Use a PNG, JPG or SVG file.');
    } finally {
      setBusy(null);
    }
  };

  const setText = (text: string) => {
    setSelection(null);
    updateCurrent((s) => {
      const seg = segmentSample(s.ink, text);
      return { ...s, text, rows: seg.rows, error: seg.error };
    });
  };

  const editPieces = (fn: (pieces: SampleRow['pieces'], ink: InkMap) => SampleRow['pieces'] | null) => {
    if (!selection || !current) return;
    const row = current.rows[selection.row];
    const next = fn(row.pieces, current.ink);
    if (!next) return;
    updateCurrent((s) => ({ ...s, rows: s.rows.map((r, i) => (i === selection.row ? { ...r, pieces: next } : r)) }));
    setSelection(null);
  };

  const removeSample = (index: number) => {
    setSamples((prev) => prev.filter((_, i) => i !== index));
    setActive((a) => Math.max(0, a >= index ? a - 1 : a));
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

  return (
    <Dialog title="Make a font from a handwriting sample" onClose={onClose} wide>
      <p className="am-sf-intro">
        Upload a photo or SVG of handwriting and type exactly what it says. Each letter is cut out automatically and turned into a font. Add more samples to cover capitals, numbers and punctuation.
      </p>

      <div className="am-sf-tabs" role="tablist" aria-label="Samples">
        {samples.map((s, i) => (
          <span key={s.id} className={`am-sf-tab ${i === active ? 'active' : ''}`}>
            <button type="button" role="tab" aria-selected={i === active} onClick={() => { setActive(i); setSelection(null); }}>
              Sample {i + 1}
            </button>
            <button type="button" className="am-sf-tab-x" aria-label={`Remove sample ${i + 1}`} onClick={() => removeSample(i)}><X size={12} /></button>
          </span>
        ))}
        <button type="button" className="btn secondary btn-sm" disabled={busy === 'load'} onClick={() => fileRef.current?.click()}>
          <ImagePlus size={14} />{busy === 'load' ? 'Reading…' : samples.length ? 'Add sample' : 'Choose image or SVG'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void addSample(f);
          }}
        />
      </div>

      {current ? (
        <>
          <label className="am-sf-field">
            <span>What does it say? Lines of writing are detected automatically.</span>
            <textarea className="am-textarea am-sf-text" value={current.text} onChange={(e) => setText(e.target.value)} rows={2} spellCheck={false} />
          </label>

          {current.error ? (
            <p className="am-sf-status off" role="alert">{current.error}</p>
          ) : (
            <ul className="am-sf-rows" aria-live="polite">
              {current.rows.map((row, r) => (
                <li key={r} className={`am-sf-status ${rowMatched(row) ? 'ok' : 'off'}`}>
                  Line {r + 1} “{row.text}”: {row.pieces.length} pieces found for {row.letters.length} letters
                  {rowMatched(row) ? ' — matched' : ' — click a box to merge, split or remove it'}
                </li>
              ))}
            </ul>
          )}

          <SampleOverlay sample={current} selection={selection} onSelect={setSelection} />

          {selection && selectedRow && (
            <div className="am-sf-actions">
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
                <Scissors size={14} />Split in two
              </button>
              <button type="button" className="btn secondary btn-sm" onClick={() => editPieces((p) => p.filter((_, i) => i !== selection.index))}>
                <Trash2 size={14} />Remove
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="am-sf-empty">
          <p>Write a sentence that uses many letters, such as “{DEFAULT_TEXT}”, with a dark pen on plain paper. Leave a clear gap between words and between lines.</p>
          <p>An SVG downloaded from a handwriting generator works too, if its terms allow you to reuse the output.</p>
        </div>
      )}

      {error && <p className="am-sf-status off" role="alert">{error}</p>}

      <footer className="am-sf-foot">
        <label className="am-text-field am-sf-name">
          <span>Font name</span>
          <input value={fontName} onChange={(e) => setFontName(e.target.value)} maxLength={40} />
        </label>
        <p className="am-sf-coverage">
          {covered.size ? `${covered.size} characters ready.` : 'No characters ready yet.'}
          {covered.size > 0 && missing.length > 0 && ` Missing letters use the default font: ${missing.join(' ')}`}
        </p>
        <div className="am-sf-buttons">
          <button type="button" className="btn secondary btn-sm" disabled={!covered.size || busy !== null} onClick={() => void download()}>
            <Download size={14} />Download .otf
          </button>
          <button type="button" className="btn primary btn-sm" disabled={!covered.size || busy !== null} onClick={() => void create()}>
            {busy === 'build' ? 'Building…' : 'Create font'}
          </button>
        </div>
      </footer>
    </Dialog>
  );
}
