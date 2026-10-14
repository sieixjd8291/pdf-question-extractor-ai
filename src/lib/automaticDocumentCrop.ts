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

/**
 * Decides whether a fresh detection is good enough to be applied the moment a
 * document is uploaded. A photographed page is cropped whenever the detector
 * found a plausible outline — a slightly imperfect crop that can be nudged is
 * far more useful than silently leaving the whole desk in the picture. PDF
 * pages stay strict because printed tables inside a digital page are not page
 * boundaries.
 */
export function automaticDocumentQuad(result: DocumentDetectionResult, sourceKind: SourceKind): ScanQuad | null {
  const q = result.quad;
  if (!q || result.quality === 'none' || !isSaneQuad(q)) return null;
  const support = result.edgeSupport;
  const mean = support.reduce((sum, value) => sum + value, 0) / 4;
  const area = quadArea(q);

  if (sourceKind === 'photo') {
    if (result.quality === 'strong') return area < 0.995 ? q : null;
    const supportedEdges = support.filter(value => value >= 0.5).length;
    return area >= 0.2 && area < 0.995 && mean >= 0.55 && supportedEdges >= 3 && insetEdgeCount(q) >= 1 ? q : null;
  }

  if (result.reason.startsWith('Reduced-resolution')) return null;
  // A supported outer paper region can be reliable even when independent proposal methods disagree.
  if (result.source !== 'paper-region' || support.some(value => value < 0.7)) return null;
  return area >= 0.55 && area < 0.985 && insetEdgeCount(q) >= 2 ? q : null;
}
