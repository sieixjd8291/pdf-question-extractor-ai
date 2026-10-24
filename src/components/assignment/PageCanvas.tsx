import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Download, ImagePlus, SlidersHorizontal, Trash2, Droplet } from 'lucide-react';
import type { ActiveGuide, Diagram } from '../../lib/handwriting/catalog';
import type { PageNumberBox } from '../../lib/handwriting/render';

interface Props {
  canvas: HTMLCanvasElement | undefined;
  index: number;
  pageCount: number;
  pageW: number;
  pageH: number;
  diagrams: Diagram[];
  selectedDiagram: string | null;
  hasOverride: boolean;
  /** Name of this page's own paper when it differs from the document paper. */
  paperLabel?: string | null;
  active: boolean;
  pageNumberBox?: PageNumberBox | null;
  pageNumberOffsetX?: number;
  pageNumberOffsetY?: number;
  onMovePageNumber?: (offsetX: number, offsetY: number) => void;
  onActiveGuide?: (guide: ActiveGuide) => void;
  onActivate: () => void;
  onSelectDiagram: (id: string | null) => void;
  onChangeDiagram: (id: string, patch: Partial<Diagram>) => void;
  onDeleteDiagram: (id: string) => void;
  onChangePaper: () => void;
  onCustomize: () => void;
  onDownload: () => void;
}

export function PageCanvas(p: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !p.canvas) return;
    p.canvas.className = 'am-page-canvas';
    p.canvas.setAttribute('role', 'img');
    p.canvas.setAttribute('aria-label', `Handwritten page ${p.index + 1} of ${p.pageCount}`);
    host.replaceChildren(p.canvas);
  }, [p.canvas, p.index, p.pageCount]);

  const startGesture = (e: ReactPointerEvent, d: Diagram, mode: 'move' | 'resize') => {
    e.preventDefault();
    e.stopPropagation();
    p.onSelectDiagram(d.id);
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const k = p.pageW / rect.width;
    const start = { x: e.clientX, y: e.clientY, dx: d.x, dy: d.y, w: d.w, h: d.h };
    const ratio = d.h / d.w;
    let frame_ = 0;
    let last: PointerEvent | null = null;
    const move = (ev: PointerEvent) => {
      last = ev;
      if (!frame_) frame_ = requestAnimationFrame(apply);
    };
    const apply = () => {
      frame_ = 0;
      const ev = last;
      if (!ev) return;
      const mx = (ev.clientX - start.x) * k;
      const my = (ev.clientY - start.y) * k;
      if (mode === 'move') {
        p.onChangeDiagram(d.id, {
          x: Math.min(p.pageW - 20, Math.max(20 - start.w, start.dx + mx)),
          y: Math.min(p.pageH - 20, Math.max(20 - start.h, start.dy + my)),
        });
      } else {
        const w = Math.max(60, start.w + mx);
        p.onChangeDiagram(d.id, { w, h: w * ratio });
      }
    };
    const up = () => {
      if (frame_) cancelAnimationFrame(frame_);
      apply();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startPageNumberDrag = (e: ReactPointerEvent) => {
    if (!p.onMovePageNumber) return;
    e.preventDefault();
    e.stopPropagation();
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const k = p.pageW / rect.width;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseOx = p.pageNumberOffsetX ?? 0;
    const baseOy = p.pageNumberOffsetY ?? 0;
    p.onActiveGuide?.('pageNumber');

    let rafId = 0;
    let lastEv: PointerEvent | null = null;
    const apply = () => {
      rafId = 0;
      if (!lastEv) return;
      const dx = Math.round((lastEv.clientX - startX) * k);
      const dy = Math.round((lastEv.clientY - startY) * k);
      p.onMovePageNumber?.(
        Math.min(600, Math.max(-600, baseOx + dx)),
        Math.min(600, Math.max(-600, baseOy + dy)),
      );
    };
    const move = (ev: PointerEvent) => {
      lastEv = ev;
      if (!rafId) rafId = requestAnimationFrame(apply);
    };
    const up = () => {
      if (rafId) cancelAnimationFrame(rafId);
      apply();
      p.onActiveGuide?.(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const pn = p.pageNumberBox;

  return (
    <article className={`am-page${p.active ? ' active' : ''}`} onPointerDown={p.onActivate} aria-label={`Page ${p.index + 1}`}>
      <div className="am-page-bar">
        <span className="am-page-num">
          Page {p.index + 1}
          <small> / {p.pageCount}</small>
          {p.paperLabel && <span className="am-chip">{p.paperLabel}</span>}
          {p.hasOverride && !p.paperLabel && <span className="am-chip">Custom layout</span>}
        </span>
        <div className="am-page-actions">
          <button type="button" className="icon-button" onClick={p.onChangePaper} aria-label={`Change paper of page ${p.index + 1}`} title="Change this page's paper">
            <ImagePlus size={15} />
          </button>
          <button type="button" className="icon-button" onClick={p.onCustomize} aria-label={`Customize layout of page ${p.index + 1}`} title="Customize this page's layout">
            <SlidersHorizontal size={15} />
          </button>
          <button type="button" className="icon-button" onClick={p.onDownload} aria-label={`Download page ${p.index + 1} as JPG`} title="Download this page">
            <Download size={15} />
          </button>
        </div>
      </div>
      <div
        ref={frameRef}
        className="am-page-frame"
        style={{ aspectRatio: `${p.pageW} / ${p.pageH}` }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'CANVAS') p.onSelectDiagram(null);
        }}
      >
        <div ref={hostRef} className="am-canvas-host">
          {!p.canvas && <div className="am-page-skeleton" aria-hidden="true" />}
        </div>
        {pn && (
          <div
            className="am-pnum-hotspot"
            style={{
              left: pct(Math.max(0, pn.x - 10), p.pageW),
              top: pct(Math.max(0, pn.y - pn.h * 0.85 - 6), p.pageH),
              width: pct(pn.w + 20, p.pageW),
              height: pct(pn.h * 1.1 + 12, p.pageH),
            }}
            title="Drag to move page number"
            aria-label="Drag to reposition page number"
            onPointerDown={startPageNumberDrag}
          />
        )}
        {p.diagrams.map((d) => {
          const selected = p.selectedDiagram === d.id;
          return (
            <div
              key={d.id}
              className={`am-diagram${selected ? ' selected' : ''}`}
              style={{ left: pct(d.x, p.pageW), top: pct(d.y, p.pageH), width: pct(d.w, p.pageW), height: pct(d.h, p.pageH) }}
              onPointerDown={(e) => startGesture(e, d, 'move')}
            >
              <img src={d.tint && d.tintedSrc ? d.tintedSrc : d.src} alt="Diagram" draggable={false} style={{ opacity: d.opacity }} />
              {selected && (
                <>
                  <span className="am-diagram-handle" onPointerDown={(e) => startGesture(e, d, 'resize')} aria-hidden="true" />
                  <div className="am-diagram-tools" onPointerDown={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={d.tint ? 'active' : ''}
                      onClick={() => p.onChangeDiagram(d.id, { tint: !d.tint })}
                      title="Redraw in ink colour"
                      aria-pressed={d.tint}
                    >
                      <Droplet size={13} />Ink
                    </button>
                    <label title="Opacity">
                      <span className="sr-only">Diagram opacity</span>
                      <input type="range" min={0.2} max={1} step={0.05} value={d.opacity} onChange={(e) => p.onChangeDiagram(d.id, { opacity: Number(e.target.value) })} />
                    </label>
                    <button type="button" onClick={() => p.onDeleteDiagram(d.id)} aria-label="Delete diagram" title="Delete diagram">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </article>
  );
}
