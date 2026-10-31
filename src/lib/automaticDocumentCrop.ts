import type { DocumentDetectionResult } from './precisionDetection';
import { isSaneQuad, type ScanQuad } from './scannerFilters';

type SourceKind = 'photo' | 'pdf';

function quadArea(q: ScanQuad): number {
  const corners = [q.tl, q.tr, q.br, q.bl];
  return Math.abs(corners.reduce((sum, a, i) => {
    const b = corners[(i + 1) % 4];
    return sum + a.x * b.y - b.x * a.y;
  }, 0)) / 2;
}

function insetEdgeCount(q: ScanQuad): number {
  const corners = [q.tl, q.tr, q.br, q.bl];
  return corners.filter((a, i) => {
    const b = corners[(i + 1) % 4];
    return !((a.x < 0.015 && b.x < 0.015) || (a.x > 0.985 && b.x > 0.985) ||
      (a.y < 0.015 && b.y < 0.015) || (a.y > 0.985 && b.y > 0.985));
  }).length;
}

/** Only verified page boundaries are applied without the user's review. */
export function automaticDocumentQuad(result: DocumentDetectionResult, sourceKind: SourceKind, matchManualDetect = false): ScanQuad | null {
  const q = result.quad;
  // Auto-crop setting: apply the same outline the manual "Auto detect" button would, so photos never need that extra click.
  if (matchManualDetect && sourceKind === 'photo' && q && isSaneQuad(q) &&
      Object.values(q).every(point => Number.isFinite(point.x) && Number.isFinite(point.y) &&
        point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) {
    const area = quadArea(q);
    return area >= 0.08 && area < 0.995 && insetEdgeCount(q) >= 1 ? q : null;
  }
  if (!q || result.quality !== 'strong' || !isSaneQuad(q)) return null;
  if (Object.values(q).some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return null;
  const support = result.edgeSupport;
  if (support.length !== 4 || support.some(value => !Number.isFinite(value) || value < 0.7 || value > 1)) return null;
  const area = quadArea(q);

  if (sourceKind === 'photo') {
    return area >= 0.2 && area < 0.995 && insetEdgeCount(q) >= 2 ? q : null;
  }

  if (result.reason.startsWith('Reduced-resolution')) return null;
  // A supported outer paper region can be reliable even when independent proposal methods disagree.
  if (result.source !== 'paper-region' || support.some(value => value < 0.7)) return null;
  return area >= 0.55 && area < 0.985 && insetEdgeCount(q) >= 2 ? q : null;
}
