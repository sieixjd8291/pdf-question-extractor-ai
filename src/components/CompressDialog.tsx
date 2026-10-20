import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from './Modal';

export interface CompressionSettings {
  quality: number;
  scale: number;
  /** Longest side in pixels pages are capped to; 0 means no cap. */
  maxEdge: number;
  level: number;
}

interface CompressDialogProps {
  format: 'pdf' | 'jpg' | 'png';
  baseQuality: number;
  current: CompressionSettings | null;
  pageCount: number;
  renderPage: (index: number) => Promise<HTMLCanvasElement>;
  onApply: (settings: CompressionSettings | null) => void;
  onClose: () => void;
}

/** Level 0-100 -> encoder settings.
 *  Quality never drops below 0.76 (JPEG gets blocky under ~0.7). Past level 30 the
 *  long edge is also capped, which is where most of the saving comes from: scans are
 *  usually far sharper than any screen or printer needs, so trimming the excess
 *  pixels costs almost no visible detail, unlike cutting JPEG quality. */
export function settingsForLevel(level: number): CompressionSettings {
  const l = Math.min(100, Math.max(0, level));
  const quality = 0.92 - (0.16 * l) / 100;
  const maxEdge = l <= 30 ? 0 : Math.round(4200 - (2400 * (l - 30)) / 70);
  return { quality, scale: 1, maxEdge, level: l };
}

/** Scale to apply to a page whose longest side is `longEdge` pixels. */
export function effectiveScale(s: CompressionSettings, longEdge: number): number {
  const capScale = s.maxEdge && longEdge > s.maxEdge ? s.maxEdge / longEdge : 1;
  return Math.min(s.scale, capScale);
}

/** Downscale in halving steps; a single big drawImage aliases and softens text. */
export function resizeSmooth(src: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  if (scale >= 0.999) return src;
  const targetW = Math.max(1, Math.round(src.width * scale));
  const targetH = Math.max(1, Math.round(src.height * scale));
  let current = src;
  while (current.width / 2 > targetW && current.height / 2 > targetH) {
    const half = document.createElement('canvas');
    half.width = Math.ceil(current.width / 2);
    half.height = Math.ceil(current.height / 2);
    const hctx = half.getContext('2d');
    if (hctx) {
      hctx.imageSmoothingQuality = 'high';
      hctx.drawImage(current, 0, 0, half.width, half.height);
    }
    if (current !== src) { current.width = 0; current.height = 0; }
    current = half;
  }
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const octx = out.getContext('2d');
  if (octx) {
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(current, 0, 0, targetW, targetH);
  }
  if (current !== src) { current.width = 0; current.height = 0; }
  return out;
}

const MAX_SAMPLES = 3;
const SAMPLE_MAX_EDGE = 1800;

interface Sample {
  canvas: HTMLCanvasElement;
  /** Full-size pixels divided by sample pixels, used to scale the measured bytes back up. */
  weight: number;
  /** Longest side of the full-size page, in pixels. */
  fullEdge: number;
}

function pickSampleIndexes(count: number): number[] {
  const n = Math.min(MAX_SAMPLES, count);
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => Math.round((i * (count - 1)) / (n - 1)));
}

function releaseCanvas(c: HTMLCanvasElement) {
  c.width = 0;
  c.height = 0;
}

async function encodeSize(sample: Sample, s: CompressionSettings, png: boolean): Promise<number> {
  const canvas = sample.canvas;
  // Work out the full-size page's scale, then express it relative to this smaller sample.
  const fullScale = effectiveScale(s, sample.fullEdge);
  const sampleScale = Math.min(1, fullScale * Math.sqrt(sample.weight));
  const source = resizeSmooth(canvas, sampleScale);
  const blob = await new Promise<Blob | null>((resolve) =>
    source.toBlob(resolve, png ? 'image/png' : 'image/jpeg', s.quality)
  );
  if (source !== canvas) {
    source.width = 0;
    source.height = 0;
  }
  return blob?.size ?? 0;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function CompressDialog({ format, baseQuality, current, pageCount, renderPage, onApply, onClose }: CompressDialogProps) {
  const png = format === 'png';
  const samplesRef = useRef<Sample[]>([]);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [originalSize, setOriginalSize] = useState(0);
  const [level, setLevel] = useState(current?.level ?? 40);
  const [estimate, setEstimate] = useState(0);
  const [targetValue, setTargetValue] = useState('');
  const [unit, setUnit] = useState<'KB' | 'MB'>('KB');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const runId = useRef(0);
  const toSettings = (l: number): CompressionSettings =>
    png ? { quality: 1, scale: 1 - (0.5 * l) / 100, maxEdge: 0, level: l } : settingsForLevel(l);

  // Sizes are measured on a few downscaled sample pages and extrapolated, so a
  // 300-page document costs the same memory and time as a 3-page one.
  const totalSize = async (st: CompressionSettings) => {
    const samples = samplesRef.current;
    if (samples.length === 0) return 0;
    let sum = 0;
    for (const sample of samples) {
      sum += (await encodeSize(sample, st, png)) * sample.weight;
      await new Promise<void>((r) => window.setTimeout(r, 0));
    }
    return Math.round((sum * pageCount) / samples.length);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded: Sample[] = [];
        for (const index of pickSampleIndexes(pageCount)) {
          const full = await renderPage(index);
          if (cancelled) { releaseCanvas(full); break; }
          const fullPixels = full.width * full.height;
          const fullEdge = Math.max(full.width, full.height);
          const k = Math.min(1, SAMPLE_MAX_EDGE / Math.max(full.width, full.height));
          if (k < 1) {
            const small = document.createElement('canvas');
            small.width = Math.max(1, Math.round(full.width * k));
            small.height = Math.max(1, Math.round(full.height * k));
            const ctx = small.getContext('2d');
            ctx?.drawImage(full, 0, 0, small.width, small.height);
            releaseCanvas(full);
            loaded.push({ canvas: small, weight: fullPixels / (small.width * small.height), fullEdge });
          } else {
            loaded.push({ canvas: full, weight: 1, fullEdge });
          }
          await new Promise<void>((r) => window.setTimeout(r, 0));
        }
        if (cancelled) { loaded.forEach((x) => releaseCanvas(x.canvas)); return; }
        samplesRef.current = loaded;
        const base = await totalSize({ quality: baseQuality, scale: 1, maxEdge: 0, level: 0 });
        if (cancelled) return;
        setOriginalSize(base);
        setReady(true);
      } catch {
        if (!cancelled) setError('This device ran out of memory while analyzing the pages. You can still export without compression.');
      }
    })();
    return () => {
      cancelled = true;
      samplesRef.current.forEach((x) => releaseCanvas(x.canvas));
      samplesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = ++runId.current;
    setWorking(true);
    const t = window.setTimeout(async () => {
      const size = await totalSize(toSettings(level));
      if (id === runId.current) {
        setEstimate(size);
        setWorking(false);
      }
    }, 150);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, ready]);

  const savedPct = useMemo(
    () => (originalSize > 0 && estimate > 0 ? Math.max(0, Math.round((1 - estimate / originalSize) * 100)) : 0),
    [originalSize, estimate]
  );

  const targetBytes = useMemo(() => {
    const value = parseFloat(targetValue);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value * (unit === 'MB' ? 1024 * 1024 : 1024);
  }, [targetValue, unit]);
  const usingTarget = targetBytes > 0;

  // Finds the lightest level that reaches the target size.
  const levelForTarget = async (): Promise<{ level: number; reachable: boolean }> => {
    let lo = 0;
    let hi = 100;
    let best = 100;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      const size = await totalSize(toSettings(mid));
      if (size <= targetBytes) {
        best = mid;
        hi = mid;
      } else {
        lo = mid;
      }
    }
    const finalSize = await totalSize(toSettings(best));
    return { level: Math.round(best), reachable: finalSize <= targetBytes * 1.05 };
  };

  const handleApply = async () => {
    if (!usingTarget) {
      onApply(toSettings(level));
      return;
    }
    if (targetBytes >= originalSize) {
      setNote('Target is larger than the current size, so nothing needs compressing.');
      return;
    }
    setWorking(true);
    const result = await levelForTarget();
    setWorking(false);
    onApply(toSettings(result.level));
  };

  return (
    <Modal
      className="compress-modal"
      title="Compress"
      eyebrow="On-device"
      closeLabel="Close compression"
      width="sm"
      onClose={onClose}
      footer={
        <>
          {current && (
            <button className="btn secondary btn-sm" onClick={() => onApply(null)}>Remove compression</button>
          )}
          <button className="btn secondary btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-sm"
            disabled={!ready || working}
            onClick={() => void handleApply()}
          >
            Apply
          </button>
        </>
      }
    >
      <p className="compress-intro">
        Compression runs entirely in your browser. No AI and no uploads. Pages keep their resolution and sharpness as long as possible.
      </p>
      {error ? (
        <p role="alert" className="compress-note">{error}</p>
      ) : !ready ? (
        <div className="compress-loading">
          <Loader2 size={16} className="spinner" /> Analyzing pages…
        </div>
      ) : (
        <div className="compress-grid">
          <div className="compress-sizes">
            <span>Current: <strong>≈ {formatBytes(originalSize)}</strong></span>
            <span>
              {usingTarget ? 'Target' : 'After'}:{' '}
              <strong>{working ? '…' : usingTarget ? `≈ ${formatBytes(targetBytes)}` : `≈ ${formatBytes(estimate)}`}</strong>
              {!usingTarget && !working && savedPct > 0 && ` (−${savedPct}%)`}
            </span>
          </div>
          <label className="compress-field">
            <span className="compress-field-head">
              <span>Compression level</span>
              <span>{usingTarget ? 'Set by target size' : `${level < 25 ? 'Light' : level < 60 ? 'Balanced' : level < 85 ? 'Strong' : 'Maximum'} · ${level}%`}</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={level}
              onChange={(e) => { setNote(''); setTargetValue(''); setLevel(Number(e.target.value)); }}
              className="compress-range"
            />
          </label>
          <div className="compress-field">
            <span>Or set a custom target size</span>
            <div className="compress-target">
              <input
                type="number"
                min={1}
                inputMode="decimal"
                placeholder="e.g. 500"
                aria-label="Target size"
                value={targetValue}
                onChange={(e) => { setNote(''); setTargetValue(e.target.value); }}
                className="compress-target-input"
              />
              <select aria-label="Size unit" value={unit} onChange={(e) => setUnit(e.target.value as 'KB' | 'MB')}>
                <option value="KB">KB</option>
                <option value="MB">MB</option>
              </select>
            </div>
            {usingTarget && !note && (
              <span className="compress-hint">Applied when you tap Apply. Move the slider to switch back.</span>
            )}
            {note && <span role="status" className="compress-hint">{note}</span>}
          </div>
          {png && (
            <p className="compress-hint">
              PNG is lossless, so only resolution is reduced. Choose PDF or JPG for the best savings.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
