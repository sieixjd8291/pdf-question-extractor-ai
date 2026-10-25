/**
 * Helpers that keep long exports running when the tab is hidden or the phone switches apps.
 * requestAnimationFrame never fires in a hidden tab and setTimeout is throttled to ~1s,
 * so yields go through a MessageChannel, which browsers don't pause for background tabs.
 */
let channel: MessageChannel | null = null;
const queue: Array<() => void> = [];

export function yieldTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => queue.shift()?.();
  }
  return new Promise((r) => {
    queue.push(r);
    channel!.port2.postMessage(0);
  });
}

/** Lets the page paint when it's visible; never stalls when it's hidden. */
export function yieldToPaintSafe(): Promise<void> {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return yieldTask();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => yieldTask().then(finish));
    // Tab hidden between scheduling and the frame: rAF would never fire.
    setTimeout(finish, 50);
  });
}

/**
 * Holds a Web Lock while `work` runs; Chrome won't freeze or discard a tab that holds one,
 * so the export keeps rendering and the download still fires in the background.
 */
export async function runInBackground<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks?.request) return work();
  let result!: T;
  await locks.request(`pdf-studio-export-${Math.random().toString(36).slice(2)}`, async () => {
    result = await work();
  });
  return result;
}
