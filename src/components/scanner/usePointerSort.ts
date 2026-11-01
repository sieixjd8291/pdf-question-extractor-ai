import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

interface SortGhost {
  x: number;
  y: number;
  src: string;
  width: number;
  height: number;
}

interface SortSession {
  index: number;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  active: boolean;
  over: number;
  src: string;
  width: number;
  height: number;
  timer: number | null;
  scrollEl: HTMLElement | null;
}

const MOUSE_DRAG_THRESHOLD = 5;
const TOUCH_SLOP = 9;
const EDGE_ZONE = 48;

/**
 * Pointer-based reordering that works identically for mouse, pen and touch.
 * Mouse drags start after a few pixels of movement; touch/pen require a short
 * press-and-hold so normal swipes still scroll the strip/page.
 */
export function usePointerSort(onMove: (from: number, to: number) => void, holdMs = 230) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [ghost, setGhost] = useState<SortGhost | null>(null);
  const sessionRef = useRef<SortSession | null>(null);
  const suppressClickRef = useRef(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const teardownRef = useRef<() => void>(() => {});

  const finish = useCallback((commit: boolean) => {
    const s = sessionRef.current;
    if (!s) return;
    if (s.timer !== null) window.clearTimeout(s.timer);
    sessionRef.current = null;
    teardownRef.current();
    if (s.active) {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      if (commit && s.over !== s.index) onMoveRef.current(s.index, s.over);
    }
    setDragIndex(null);
    setOverIndex(null);
    setGhost(null);
  }, []);

  useEffect(() => () => finish(false), [finish]);

  const activate = useCallback((x: number, y: number) => {
    const s = sessionRef.current;
    if (!s || s.active) return;
    s.active = true;
    s.over = s.index;
    setDragIndex(s.index);
    setOverIndex(s.index);
    setGhost({ x, y, src: s.src, width: s.width, height: s.height });
    try { navigator.vibrate?.(10); } catch { /* optional haptic */ }
  }, []);

  const bind = useCallback((index: number, src: string) => ({
    'data-sort-index': index,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || sessionRef.current) return;
      if ((e.target as HTMLElement).closest('button')) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const scrollEl = e.currentTarget.closest<HTMLElement>('[data-sort-scroll]');
      const session: SortSession = {
        index,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        over: index,
        src,
        width: Math.min(rect.width, 180),
        height: Math.min(rect.height, 220),
        timer: null,
        scrollEl,
      };
      sessionRef.current = session;
      if (e.pointerType !== 'mouse') {
        session.timer = window.setTimeout(() => activate(session.startX, session.startY), holdMs);
      }

      const onPointerMove = (ev: PointerEvent) => {
        const s = sessionRef.current;
        if (!s || ev.pointerId !== s.pointerId) return;
        const dist = Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY);
        if (!s.active) {
          if (s.pointerType === 'mouse') {
            if (dist < MOUSE_DRAG_THRESHOLD) return;
            activate(ev.clientX, ev.clientY);
          } else {
            if (dist > TOUCH_SLOP) finish(false);
            return;
          }
        }
        ev.preventDefault();
        setGhost((g) => (g ? { ...g, x: ev.clientX, y: ev.clientY } : g));
        const hit = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>('[data-sort-index]');
        if (hit && hit.dataset.sortIndex !== undefined) {
          const over = Number(hit.dataset.sortIndex);
          if (Number.isFinite(over) && over !== s.over) {
            s.over = over;
            setOverIndex(over);
          }
        }
        const sc = s.scrollEl;
        if (sc && sc.scrollWidth > sc.clientWidth) {
          const r = sc.getBoundingClientRect();
          if (ev.clientX < r.left + EDGE_ZONE) sc.scrollLeft -= 14;
          else if (ev.clientX > r.right - EDGE_ZONE) sc.scrollLeft += 14;
        }
        if (ev.clientY < EDGE_ZONE) window.scrollBy(0, -14);
        else if (ev.clientY > window.innerHeight - EDGE_ZONE) window.scrollBy(0, 14);
      };
      const onPointerUp = (ev: PointerEvent) => {
        if (sessionRef.current && ev.pointerId === sessionRef.current.pointerId) finish(true);
      };
      const onPointerCancel = (ev: PointerEvent) => {
        if (sessionRef.current && ev.pointerId === sessionRef.current.pointerId) finish(false);
      };
      // Once a touch drag is active the page must not scroll under the finger.
      const onTouchMove = (ev: TouchEvent) => {
        if (sessionRef.current?.active && ev.cancelable) ev.preventDefault();
      };
      const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(false); };

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('keydown', onKeyDown);
      teardownRef.current = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('keydown', onKeyDown);
      };
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (suppressClickRef.current) {
        e.preventDefault();
        e.stopPropagation();
        suppressClickRef.current = false;
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      if (sessionRef.current) e.preventDefault();
    },
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
  }), [activate, finish, holdMs]);

  return { dragIndex, overIndex, ghost, bind };
}
