/**
 * Device capability hints used to size image work. Phones and low-memory
 * devices get smaller working bitmaps: a 50 MP camera photo held at full
 * resolution costs ~200 MB per decoded copy and every synchronous pixel
 * pass / JPEG encode over it freezes the main thread for seconds.
 */

let cachedLowPower: boolean | null = null;

export function isLowPowerDevice(): boolean {
  if (cachedLowPower !== null) return cachedLowPower;
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const lowMemory = typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4;
  const fewCores = typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 4;
  cachedLowPower = coarse || lowMemory || fewCores;
  return cachedLowPower;
}

/**
 * Longest edge imported photos are normalized to. 2560 px still gives
 * ~300 DPI on an A4 page, so scans stay sharp while phones avoid handling
 * 4000–8000 px bitmaps through every later step.
 */
export function importMaxEdge(): number {
  return isLowPowerDevice() ? 2560 : 3072;
}

/** How many pictures to analyze at once during a batch import. */
export function imageImportConcurrency(): number {
  return isLowPowerDevice() ? 1 : 2;
}
