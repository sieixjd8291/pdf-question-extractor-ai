export function sampleSizeWeight(weight: number, fullScale: number, sampleScale: number): number {
  return weight * (fullScale / sampleScale) ** 2;
}

export function targetCompressionSettings(level: number, baseQuality: number, png: boolean) {
  const strength = Math.min(100, Math.max(0, level)) / 100;
  return {
    level,
    quality: png ? 1 : Math.max(0.1, baseQuality * (1 - 0.88 * strength)),
    scale: 10 ** (-2 * strength),
    maxEdge: 0,
  };
}

export async function findTargetCompression(
  targetBytes: number,
  measure: (level: number) => Promise<number>,
): Promise<{ level: number; size: number; reachable: boolean }> {
  const original = await measure(0);
  if (original <= targetBytes) return { level: 0, size: original, reachable: true };
  const minimum = await measure(100);
  if (minimum > targetBytes) return { level: 100, size: minimum, reachable: false };
  let low = 1;
  let high = 100;
  let size = minimum;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const measured = await measure(mid);
    if (measured <= targetBytes) {
      high = mid;
      size = measured;
    } else {
      low = mid + 1;
    }
  }
  return { level: high, size, reachable: true };
}
