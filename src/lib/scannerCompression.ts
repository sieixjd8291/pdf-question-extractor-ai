export function sampleSizeWeight(weight: number, fullScale: number, sampleScale: number): number {
  return weight * (fullScale / sampleScale) ** 2;
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
