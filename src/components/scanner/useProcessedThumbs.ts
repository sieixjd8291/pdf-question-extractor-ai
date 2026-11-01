import { useEffect, useRef, useState } from 'react';
import {
  renderScanCanvas,
  type ScanAdjustments,
  type ScanEraseStroke,
  type ScanFilterId,
  type ScanQuad,
} from '../../lib/scannerFilters';

export interface ThumbSourcePage {
  id: string;
  originalUrl: string;
  rotation: 0 | 90 | 180 | 270;
  quad: ScanQuad | null;
  filter: ScanFilterId;
  adj: ScanAdjustments;
  eraser: ScanEraseStroke[];
}

export function pageRenderSig(p: ThumbSourcePage): string {
  return [
    p.originalUrl.length,
    p.originalUrl.slice(-48),
    p.rotation,
    JSON.stringify(p.quad),
    p.filter,
    JSON.stringify(p.adj),
    p.eraser.length,
  ].join('|');
}

export async function renderPageToDataUrl(p: ThumbSourcePage, maxEdge: number): Promise<string> {
  const canvas = await renderScanCanvas(
    p.originalUrl,
    { rotation: p.rotation, quad: p.quad, filter: p.filter, adj: p.adj, eraserStrokes: p.eraser },
    maxEdge
  );
  try {
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Cropped + filtered thumbnails per page (what the export will look like),
 * rendered lazily in the background and only re-rendered when that page's
 * crop/rotation/filter/adjustments actually change.
 */
export function useProcessedThumbs(pages: ThumbSourcePage[], maxEdge = 260) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const cacheRef = useRef<Record<string, { sig: string; url: string }>>({});

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (const page of pages) {
        if (cancelled) return;
        const sig = pageRenderSig(page);
        if (cacheRef.current[page.id]?.sig === sig) continue;
        try {
          const url = await renderPageToDataUrl(page, maxEdge);
          if (cancelled) return;
          cacheRef.current[page.id] = { sig, url };
          setThumbs((prev) => ({ ...prev, [page.id]: url }));
        } catch {
          // best-effort: fall back to the raw capture thumbnail
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pages, maxEdge]);

  return thumbs;
}
