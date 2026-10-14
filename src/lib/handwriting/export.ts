import type { AssignmentSettings, Diagram } from './catalog';
import { loadImage, renderPage, type LoadedDiagram, type RenderInput } from './render';

export type ExportFormat = 'pdf' | 'jpg' | 'png' | 'zip';

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function canvasBlob(c: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), type, quality));
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

function safeName(s: AssignmentSettings) {
  return (s.fileName || 'assignment').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'assignment';
}

export async function exportAssignment(
  input: RenderInput,
  sourceDiagrams: Diagram[],
  format: ExportFormat,
  pages: number[],
  onProgress?: (done: number, total: number) => void,
) {
  const s = input.settings;
  const scale = s.exportScale;
  const diagrams: LoadedDiagram[] = await Promise.all(
    sourceDiagrams.map(async (d) => ({ diagram: d, image: await loadImage(d.tint && d.tintedSrc ? d.tintedSrc : d.src) })),
  );
  const name = safeName(s);
  const render = async (page: number, i: number) => {
    await yieldFrame();
    const c = renderPage(input, page, { scale, diagrams });
    onProgress?.(i + 1, pages.length);
    return c;
  };

  if (format === 'pdf') {
    const { jsPDF } = await import('jspdf');
    const fmt: string | [number, number] = s.pageSize === 'b5' ? [176, 250] : s.pageSize;
    const pdf = new jsPDF({ unit: 'mm', format: fmt, orientation: 'portrait', compress: true });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    for (let i = 0; i < pages.length; i++) {
      const c = await render(pages[i], i);
      if (i > 0) pdf.addPage(fmt, 'portrait');
      pdf.addImage(c.toDataURL('image/jpeg', s.exportQuality), 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
    }
    downloadBlob(pdf.output('blob'), `${name}.pdf`);
    return;
  }

  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const ext = format === 'png' ? 'png' : 'jpg';
  if (format !== 'zip' && pages.length === 1) {
    const c = await render(pages[0], 0);
    downloadBlob(await canvasBlob(c, type, s.exportQuality), `${name}-page-${pages[0] + 1}.${ext}`);
    return;
  }
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const zipType = format === 'zip' ? 'image/jpeg' : type;
  const zipExt = format === 'zip' ? 'jpg' : ext;
  for (let i = 0; i < pages.length; i++) {
    const c = await render(pages[i], i);
    zip.file(`${name}-page-${String(pages[i] + 1).padStart(2, '0')}.${zipExt}`, await canvasBlob(c, zipType, s.exportQuality));
  }
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${name}-pages.zip`);
}
