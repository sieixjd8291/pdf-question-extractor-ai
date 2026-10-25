import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { ArrangeMode, PageBlocks, PageLayout, TextBlock, TextOffset, TextOffsets } from '../../lib/handwriting/catalog';

export interface MarginBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function blocksForMode(blocks: PageBlocks | undefined, mode: ArrangeMode): TextBlock[] {
  if (!blocks) return [];
  if (mode === 'page') return blocks.page ? [blocks.page] : [];
  return mode === 'line' ? blocks.lines : blocks.words;
}

export function selectionBounds(blocks: TextBlock[], ids: string[]): MarginBox | null {
  const wanted = new Set(ids);
  let b: MarginBox | null = null;
  for (const blk of blocks) {
    if (!wanted.has(blk.id)) continue;
    if (!b) b = { left: blk.x0, top: blk.y0, right: blk.x1, bottom: blk.y1 };
    else {
      b.left = Math.min(b.left, blk.x0);
      b.top = Math.min(b.top, blk.y0);
      b.right = Math.max(b.right, blk.x1);
      b.bottom = Math.max(b.bottom, blk.y1);
    }
  }
  return b;
}

/**
 * Limits a drag so the selection stays inside the page margins. Text that already
 * pokes past a margin (descenders, jitter) is never pushed back; it just can't go further out.
 */
export function clampDelta(bounds: MarginBox, box: MarginBox, dx: number, dy: number, lineStep?: number | null): [number, number] {
  const minX = Math.min(0, box.left - bounds.left);
  const maxX = Math.max(0, box.right - bounds.right);
  const minY = Math.min(0, box.top - bounds.top);
  const maxY = Math.max(0, box.bottom - bounds.bottom);
  const x = Math.min(maxX, Math.max(minX, dx));
  if (!lineStep) return [x, Math.min(maxY, Math.max(minY, dy))];
  // "Write within the lines": vertical moves jump whole ruled lines so text always sits on a rule.
  const firstStep = Math.ceil(minY / lineStep);
  const lastStep = Math.floor(maxY / lineStep);
  const steps = Math.min(lastStep, Math.max(firstStep, Math.round(dy / lineStep)));
  return [x, steps * lineStep];
}

/** Rounds a stored vertical offset onto whole line steps. */
export function snapOffsetY(y: number, lineStep: number): number {
  return Math.round(Math.round(y / lineStep) * lineStep * 10) / 10;
}

export function shiftedOffsets(ids: string[], base: TextOffsets, dx: number, dy: number): Record<string, TextOffset> {
  const patch: Record<string, TextOffset> = {};
  for (const id of ids) {
    const o = base[id];
    patch[id] = { x: Math.round(((o?.x ?? 0) + dx) * 10) / 10, y: Math.round(((o?.y ?? 0) + dy) * 10) / 10 };
  }
  return patch;
}

/** Inverse of the page-look tilt/zoom so screen drags map back to page directions. */
function lookInverse(el: HTMLElement): { host: HTMLElement; m: DOMMatrix | null } {
  const look = el.closest<HTMLElement>('.am-page-look');
  const t = look ? getComputedStyle(look).transform : 'none';
  const host = look?.parentElement ?? el;
  const own = getComputedStyle(el).transform;
  if ((!t || t === 'none') && own === 'none') return { host, m: null };
  const m = new DOMMatrix(t && t !== 'none' ? t : undefined)
    .multiply(new DOMMatrix(own !== 'none' ? own : undefined)).inverse();
  m.e = 0;
  m.f = 0;
  return { host, m };
}

interface Props {
  mode: ArrangeMode;
  layout: PageLayout;
  blocks: PageBlocks | undefined;
  pageW: number;
  pageH: number;
  marginBox: MarginBox;
  selection: string[];
  offsets: TextOffsets;
  onSelect: (ids: string[]) => void;
  onMove: (patch: Record<string, TextOffset>) => void;
  /** Line height to snap vertical moves to when writing within the lines. */
  lineStep?: number | null;
}

const MODE_LABEL: Record<ArrangeMode, string> = { line: 'line', word: 'word', page: 'page text' };

export function TextArrangeLayer(p: Props) {
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  const list = blocksForMode(p.blocks, p.mode);
  const selected = new Set(p.selection);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, block: TextBlock) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const wasSelected = selected.has(block.id);
    let ids: string[];
    if (additive) {
      ids = wasSelected ? p.selection.filter((id) => id !== block.id) : [...p.selection, block.id];
      p.onSelect(ids);
      if (wasSelected) return;
    } else {
      ids = wasSelected ? p.selection : [block.id];
      if (!wasSelected) p.onSelect(ids);
    }
    // On touch, the first tap selects so the page can still be scrolled over text.
    if (e.pointerType === 'touch' && !wasSelected) return;

    const frame = e.currentTarget.parentElement;
    const bounds = selectionBounds(list, ids);
    if (!frame || !bounds) return;
    e.preventDefault();
    const { host, m: inv } = lookInverse(frame);
    const rect = host.getBoundingClientRect();
    const k = p.pageW / rect.width;
    const lineStep = p.lineStep;
    const startX = e.clientX;
    const startY = e.clientY;
    const base = p.offsets;
    const box = p.marginBox;
    cancelDrag.current?.();
    const pointerId = e.pointerId;
    let previousX = 0;
    let previousY = 0;
    let moved = false;
    let raf = 0;
    let last: PointerEvent | null = null;

    const apply = () => {
      raf = 0;
      if (!last) return;
      let sx = last.clientX - startX;
      let sy = last.clientY - startY;
      if (inv) {
        const pt = inv.transformPoint(new DOMPoint(sx, sy));
        sx = pt.x;
        sy = pt.y;
      }
      const rawX = sx * k;
      const rawY = sy * k;
      if (!moved && Math.hypot(rawX, rawY) < 3 * k) return;
      moved = true;
      const [dx, dy] = clampDelta(bounds, box, rawX, rawY, lineStep);
      const x = Math.round(dx * 10);
      const y = Math.round(dy * 10);
      if (x === previousX && y === previousY) return;
      previousX = x;
      previousY = y;
      p.onMove(shiftedOffsets(ids, base, dx, dy));
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      last = ev;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const cleanup = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      cancelDrag.current = null;
      document.body.classList.remove('am-arranging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (raf) cancelAnimationFrame(raf);
      if (ev.type === 'pointerup') last = ev;
      apply();
      cleanup();
    };
    cancelDrag.current = cleanup;
    document.body.classList.add('am-arranging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const pad = 4;

  return (
    <div className="am-arrange" data-mode={p.mode}
      style={{ transform: `rotate(${p.layout.angle ?? 0}deg)`, transformOrigin: `${pct(p.layout.marginLeft, p.pageW)} ${pct(p.layout.marginTop, p.pageH)}` }}
      role="group" aria-label={`Movable text by ${MODE_LABEL[p.mode]}. Drag to move, Shift+click to group, arrow keys to nudge.`}>
      {list.map((b) => {
        const isSel = selected.has(b.id);
        return (
          <div
            key={b.id}
            className={`am-arrange-block${isSel ? ' selected' : ''}`}
            style={{
              left: pct(b.x0 - pad, p.pageW),
              top: pct(b.y0 - pad, p.pageH),
              width: pct(b.x1 - b.x0 + pad * 2, p.pageW),
              height: pct(b.y1 - b.y0 + pad * 2, p.pageH),
            }}
            onPointerDown={(e) => startDrag(e, b)}
            aria-hidden="true"
          />
        );
      })}
    </div>
  );
}
