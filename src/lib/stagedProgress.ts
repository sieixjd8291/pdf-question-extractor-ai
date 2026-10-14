import { useSyncExternalStore } from 'react';

export type ProgressKind = 'import' | 'export';

export interface ProgressSnapshot {
  percent: number;
  message: string;
  kind: ProgressKind;
  format?: string;
  done: boolean;
}

export type ProgressStatus = ProgressKind | `${ProgressKind}-done` | null;

const TICK_MS = 100;

/**
 * Progress tracker for long, multi-step jobs.
 *
 * Each step declares the percent range it covers (`stage(from, to)`). The
 * displayed value jumps to `from` right away and then creeps toward `to`
 * over time, so the bar keeps moving during a long step. It never goes
 * past the step's end and never goes backwards. Only 100% (from `finish`)
 * means the job is actually done.
 */
export class StagedProgress {
  private snapshot: ProgressSnapshot | null = null;
  private listeners = new Set<() => void>();
  private display = 0;
  private floor = 0;
  private ceil = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  getStatus = (): ProgressStatus => {
    const s = this.snapshot;
    if (!s) return null;
    return s.done ? `${s.kind}-done` : s.kind;
  };

  get active() {
    return this.snapshot !== null && !this.snapshot.done;
  }

  start(kind: ProgressKind, message: string, format?: string) {
    this.clearTimers();
    this.display = 0;
    this.floor = 0;
    this.ceil = 3;
    this.snapshot = { percent: 0, message, kind, format, done: false };
    this.tickTimer = setInterval(this.tick, TICK_MS);
    this.emit();
  }

  stage(from: number, to: number, message?: string) {
    const s = this.snapshot;
    if (!s || s.done) return;
    this.floor = clamp(Math.max(this.floor, from), 0, 99);
    this.ceil = clamp(Math.max(this.floor, to), 0, 99);
    if (this.display < this.floor) this.display = this.floor;
    this.publish(message);
  }

  finish(message: string, holdMs = 1300) {
    const s = this.snapshot;
    if (!s) return;
    this.clearTimers();
    this.display = 100;
    this.snapshot = { ...s, percent: 100, message, done: true };
    this.emit();
    this.hideTimer = setTimeout(() => this.cancel(), holdMs);
  }

  cancel() {
    this.clearTimers();
    if (this.snapshot === null) return;
    this.snapshot = null;
    this.emit();
  }

  private tick = () => {
    const gap = this.ceil - this.display;
    if (gap <= 0.6) return;
    this.display = Math.min(this.ceil - 0.5, this.display + Math.max(0.12, gap * 0.05));
    this.publish();
  };

  private publish(message?: string) {
    const s = this.snapshot;
    if (!s || s.done) return;
    const percent = Math.floor(this.display);
    const nextMessage = message ?? s.message;
    if (percent === s.percent && nextMessage === s.message) return;
    this.snapshot = { ...s, percent, message: nextMessage };
    this.emit();
  }

  private clearTimers() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.tickTimer = null;
    this.hideTimer = null;
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

function clamp(v: number, min: number, max: number) {
  return v < min ? min : v > max ? max : v;
}

/** Wait for the browser to paint once before the next block of heavy synchronous work. */
export function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

export function useProgressSnapshot(store: StagedProgress) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
}

/** Changes only when progress starts, finishes, or clears, not on every tick. */
export function useProgressStatus(store: StagedProgress) {
  return useSyncExternalStore(store.subscribe, store.getStatus, () => null);
}
