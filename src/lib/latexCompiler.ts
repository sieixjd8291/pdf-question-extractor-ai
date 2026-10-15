/**
 * LaTeX compilation for the LaTeX Studio mode:
 * 1. Calls the app's server (`/api/latex-compile`), which compiles with a
 *    locally installed TeX engine (pdflatex / tectonic / xelatex / lualatex),
 *    or server-side remote TeX fallback (TeX Live with full package support).
 * 2. If the server is unreachable (e.g. static preview without backend),
 *    falls back to direct in-browser compilation.
 */

import { isOnline } from './onlineStatus';

export interface LaTeXCompileResult {
  pdf: Blob;
  engine: string;
  via: 'server' | 'web';
  log: string;
  durationMs: number;
}

export class LaTeXCompileError extends Error {
  log: string;
  via: 'server' | 'web' | 'none';
  constructor(message: string, log = '', via: 'server' | 'web' | 'none' = 'none') {
    super(message);
    this.name = 'LaTeXCompileError';
    this.log = log;
    this.via = via;
  }
}

export interface ResourceFile {
  name: string;
  content: string;
}

const FALLBACK_ENDPOINT = 'https://latex.ytotech.com/builds/sync';

async function compileOnServer(
  tex: string,
  files?: ResourceFile[]
): Promise<LateXServerAttempt> {
  let res: Response;
  try {
    res = await fetch('/api/latex-compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tex, files }),
    });
  } catch (err: any) {
    return { ok: false, unavailable: true, message: err?.message || 'Server unreachable' };
  }

  if (res.ok) {
    const pdf = await res.blob();
    if (pdf.size === 0) throw new LaTeXCompileError('The server returned an empty PDF.', '', 'server');
    const viaHeader = res.headers.get('X-LaTeX-Via');
    return {
      ok: true,
      pdf,
      engine: res.headers.get('X-LaTeX-Engine') || 'pdflatex',
      via: viaHeader === 'remote' ? 'web' : 'server',
      log: res.headers.get('X-LaTeX-Log') || '',
    };
  }

  const data = await res.json().catch(() => null) as { error?: string; log?: string } | null;
  // 422 means the LaTeX document itself contains syntax or package errors
  if (res.status === 422 || res.status === 504 || res.status === 400 || res.status === 413) {
    throw new LaTeXCompileError(
      data?.error || 'LaTeX compilation failed.',
      data?.log || '',
      'server'
    );
  }

  return { ok: false, unavailable: true, message: data?.error || `Server HTTP ${res.status}` };
}

interface LateXServerAttempt {
  ok: boolean;
  pdf?: Blob;
  engine?: string;
  via?: 'server' | 'web';
  log?: string;
  unavailable?: boolean;
  message?: string;
}

async function compileOnWeb(
  tex: string,
  files?: ResourceFile[]
): Promise<{ pdf: Blob; engine: string; via: 'web'; log: string }> {
  const form = new FormData();
  form.append('resources[]', new Blob([tex], { type: 'text/x-tex' }), 'main.tex');

  if (Array.isArray(files)) {
    for (const f of files) {
      if (f && f.name && f.name !== 'main.tex' && typeof f.content === 'string') {
        form.append('resources[]', new Blob([f.content], { type: 'text/plain' }), f.name);
      }
    }
  }

  const res = await fetch(FALLBACK_ENDPOINT, { method: 'POST', body: form });

  if (res.ok) {
    const pdf = await res.blob();
    if (pdf.size === 0) throw new LaTeXCompileError('The compilation service returned an empty PDF.', '', 'web');
    return { pdf, engine: 'pdflatex', via: 'web', log: '' };
  }

  const detail = await res.text().catch(() => '');
  let log = detail;
  try {
    const parsed = JSON.parse(detail);
    log = parsed?.log || parsed?.error || detail;
  } catch {
    /* raw text */
  }
  throw new LaTeXCompileError('LaTeX compilation failed.', log, 'web');
}

export async function compileLaTeX(
  tex: string,
  files?: ResourceFile[]
): Promise<LaTeXCompileResult> {
  if (!tex.trim()) throw new LaTeXCompileError('Nothing to compile — the editor is empty.');

  const started = performance.now();

  if (!isOnline()) {
    throw new LaTeXCompileError(
      "You're offline. Compiling to PDF needs an internet connection — your edits are saved on this device and you can compile once you reconnect."
    );
  }

  let serverMessage: string | undefined;
  try {
    const attempt = await compileOnServer(tex, files);
    if (attempt.ok && attempt.pdf) {
      return {
        pdf: attempt.pdf,
        engine: attempt.engine || 'pdflatex',
        via: attempt.via || 'server',
        log: attempt.log || '',
        durationMs: Math.round(performance.now() - started),
      };
    }
    serverMessage = attempt.message;
  } catch (err) {
    if (err instanceof LaTeXCompileError) throw err;
    serverMessage = err instanceof Error ? err.message : String(err);
  }

  try {
    const web = await compileOnWeb(tex, files);
    return { ...web, durationMs: Math.round(performance.now() - started) };
  } catch (err) {
    if (err instanceof LaTeXCompileError && err.via === 'web' && err.log) throw err;
    throw new LaTeXCompileError(
      serverMessage
        ? `Compilation failed (server: ${serverMessage}).`
        : 'Could not reach any LaTeX compiler. Check your connection and try again.',
      err instanceof LaTeXCompileError ? err.log : '',
      'none'
    );
  }
}
