import { spawn } from "child_process";
import { createHash } from "node:crypto";
import { hasFatalTexError, isCompilerTimeout } from "../src/lib/latexRepair.js";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

/**
 * Server-side LaTeX compilation for the LaTeX Studio mode:
 * 1. Tries a local TeX engine (tectonic, xelatex, pdflatex, or lualatex).
 * 2. If no engine is available locally, or if local compilation fails due to
 *    missing packages/fonts, falls back seamlessly to high-capacity remote TeX
 *    compilation service (TeX Live with full package support) right on the server.
 * 3. Supports multi-file project resources (\input, \include, macros, etc.).
 */

const ENGINES = ["tectonic", "xelatex", "pdflatex", "lualatex"] as const;
type Engine = (typeof ENGINES)[number];

const VERSION_TIMEOUT_MS = 6000;
const COMPILE_TIMEOUT_MS = 120_000;
const MAX_TEX_BYTES = 4 * 1024 * 1024;
const REMOTE_COMPILER_URL = "https://latex.ytotech.com/builds/sync";

let cachedEngine: Engine | null = null;
let lastEngineCheck = 0;

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { output += d.toString(); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, output, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output, timedOut });
    });
  });
}

async function detectEngine(): Promise<Engine | null> {
  const now = Date.now();
  if (lastEngineCheck && now - lastEngineCheck < 60_000) return cachedEngine;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "latex-probe-"));
  try {
    for (const engine of ENGINES) {
      const { code, timedOut } = await runProcess(engine, ["--version"], dir, VERSION_TIMEOUT_MS);
      if (code === 0 && !timedOut) {
        cachedEngine = engine;
        lastEngineCheck = now;
        return engine;
      }
    }
    cachedEngine = null;
    lastEngineCheck = now;
    return null;
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function tailLog(text: string, maxLines = 100): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-maxLines).join("\n");
}

export interface ResourceFile {
  name: string;
  content: string;
}

export interface CompileOutcome {
  statusCode: number;
  json?: Record<string, unknown>;
  pdf?: Buffer;
  engine?: string;
  via?: "server" | "remote";
  log?: string;
}

/**
 * Fallback to server-side remote TeX compilation. Runs in Node without browser
 * CORS / CSP / ad-blocker interference.
 */
type RemoteCompiler = 'pdflatex' | 'xelatex' | 'lualatex';

export function detectPreferredCompiler(tex: string): RemoteCompiler {
  const magic = tex.match(/^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im)?.[1]?.toLowerCase();
  if (magic === 'xelatex' || magic === 'lualatex' || magic === 'pdflatex') return magic;
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:luacode|luatextra|luacolor)\b/.test(tex) || /\\directlua\b/.test(tex)) return 'lualatex';
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math|polyglossia|xeCJK|xltxtra|xunicode|mathspec)\b/.test(tex)
    || /\\documentclass(?:\[[^\]]*\])?\{(?:ctexart|ctexrep|ctexbook)\}/.test(tex)
    || /\\set(?:main|sans|mono)font\b/.test(tex)) return 'xelatex';
  return 'pdflatex';
}

export function looksLikeTexLog(log: string): boolean {
  return /This is (?:pdfTeX|XeTeX|LuaHBTeX|LuaTeX|e-TeX)|^!\s|LaTeX (?:Error|Warning)|\.tex:\d+:|Output written on|No pages of output|Emergency stop|Fatal error occurred|latexmk|Latexmk/im.test(log);
}

const NEEDS_UNICODE_ENGINE = /requires either XeTeX or LuaTeX|fontspec error|Package fontspec Error|cannot be used with pdfTeX|Unicode character .* not set up for use with LaTeX|Invalid UTF-8 byte/i;

export async function compileRemote(tex: string, files?: ResourceFile[], compiler: RemoteCompiler = detectPreferredCompiler(tex), triedFallback = false): Promise<CompileOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(REMOTE_COMPILER_URL, {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compiler,
        resources: [{ main: true, path: 'main.tex', content: tex },
          ...(files || []).filter(file => file.name !== 'main.tex').map(file => ({ path: file.name, content: file.content }))],
        // Overleaf-style: keep going past recoverable errors and still emit the PDF.
        options: { compiler: { halt_on_error: false, force: true }, response: { log_files_on_failure: true } },
      }),
      signal: controller.signal,
    });

    if (res.ok) {
      const buf = await res.arrayBuffer();
      const pdf = Buffer.from(buf);
      if (pdf.length === 0) {
        return {
          statusCode: 502,
          json: { error: "LaTeX compiler returned an empty PDF." },
        };
      }
      return {
        statusCode: 200,
        pdf,
        engine: compiler,
        via: "remote",
      };
    }

    const detail = await res.text().catch(() => "");
    let log = detail;
    try {
      const parsed = JSON.parse(detail);
      const logFiles = parsed?.log_files;
      const captured = typeof logFiles === 'string' ? logFiles : logFiles && typeof logFiles === 'object' ? Object.values(logFiles).filter(value => typeof value === 'string').join('\n') : '';
      log = captured || parsed?.log || parsed?.error || detail;
    } catch {
      // plain text log
    }

    const timedOut = /COMPILATION_TIMEOUT|compilation timed out/i.test(log);
    // Rate limits, overloads and gateway pages are service failures, not errors in the user's LaTeX.
    if (!timedOut && !looksLikeTexLog(log)) {
      if (!triedFallback) {
        clearTimeout(timer);
        await new Promise(resolve => setTimeout(resolve, 1500));
        return compileRemote(tex, files, compiler, true);
      }
      return {
        statusCode: 503,
        json: { error: `The online LaTeX compiler is temporarily unavailable (HTTP ${res.status}). Your source was not changed.` },
      };
    }
    if (!triedFallback && (timedOut || (compiler === 'pdflatex' && NEEDS_UNICODE_ENGINE.test(log)))) {
      clearTimeout(timer);
      return compileRemote(tex, files, compiler === 'pdflatex' ? 'xelatex' : 'pdflatex', true);
    }
    return {
      statusCode: timedOut ? 504 : 422,
      json: {
        error: timedOut ? 'The online compiler timed out. No source changes were made.' : 'LaTeX compilation failed.',
        log: tailLog(log),
      },
    };
  } catch (err: any) {
    const isTimeout = err?.name === "AbortError";
    if (isTimeout && !triedFallback) {
      clearTimeout(timer);
      return compileRemote(tex, files, compiler === 'pdflatex' ? 'xelatex' : 'pdflatex', true);
    }
    if (!isTimeout && !triedFallback) {
      clearTimeout(timer);
      return compileRemote(tex, files, compiler, true);
    }
    return {
      statusCode: isTimeout ? 504 : 503,
      json: {
        error: isTimeout
          ? "LaTeX compilation service timed out."
          : `Remote compilation error: ${err?.message || String(err)}`,
        ...(isTimeout ? { log: 'COMPILATION_TIMEOUT' } : {}),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export function hasDefinitiveLocalSyntaxError(log: string): boolean {
  const missingDependency = /not found|can't find|cannot find|font.*(?:missing|unavailable)|failed to (?:download|load)|format file/i.test(log);
  return !missingDependency && /(?:Missing \$ inserted|Extra (?:\}|\$)|Runaway argument|Paragraph ended before|ended by \\end|Missing \\endcsname inserted|Illegal parameter number)/i.test(log);
}

export function createCachedLatexCompiler(
  compile: (tex: unknown, files?: ResourceFile[]) => Promise<CompileOutcome>,
  now: () => number = Date.now,
): (tex: unknown, files?: ResourceFile[]) => Promise<CompileOutcome> {
  const failures = new Map<string, { expires: number; result: CompileOutcome }>();
  const pending = new Map<string, Promise<CompileOutcome>>();
  const maxEntries = 32;
  return async (tex, files) => {
    if (typeof tex !== 'string' || tex.length > MAX_TEX_BYTES) return compile(tex, files);
    const key = createHash('sha256').update(JSON.stringify([tex, files ?? []])).digest('hex');
    for (const [cachedKey, entry] of failures) {
      if (entry.expires <= now()) failures.delete(cachedKey);
    }
    const cached = failures.get(key);
    if (cached) return cached.result;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    if (pending.size >= maxEntries) return compile(tex, files);
    const task = Promise.resolve().then(() => compile(tex, files));
    pending.set(key, task);
    try {
      const result = await task;
      const log = typeof result.json?.log === 'string' ? result.json.log : '';
      // Reuse only genuine, recent compiler failures for unchanged projects, never timeouts or service errors.
      if (result.statusCode === 422 && hasFatalTexError(log) && !isCompilerTimeout(log)) {
        if (failures.size >= maxEntries) failures.delete(failures.keys().next().value!);
        failures.set(key, { expires: now() + 30000, result });
      }
      return result;
    } finally {
      pending.delete(key);
    }
  };
}

export const compileLatex = createCachedLatexCompiler(compileLatexUncached);

async function compileLatexUncached(tex: unknown, files?: ResourceFile[]): Promise<CompileOutcome> {
  if (typeof tex !== "string" || !tex.trim()) {
    return { statusCode: 400, json: { error: "Request body must include a non-empty `tex` string." } };
  }
  if (Buffer.byteLength(tex, "utf8") > MAX_TEX_BYTES) {
    return { statusCode: 413, json: { error: "LaTeX source exceeds the 4 MB limit." } };
  }

  const engine = await detectEngine();

  // If a local engine is installed, attempt local compilation first
  if (engine) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "latex-build-"));
    try {
      await fsp.writeFile(path.join(dir, "main.tex"), tex, "utf8");

      // Write any auxiliary files into the build folder
      if (Array.isArray(files)) {
        for (const file of files) {
          if (file && typeof file.name === "string" && file.name !== "main.tex" && typeof file.content === "string") {
            const filePath = path.resolve(dir, file.name.replace(/\\/g, "/").replace(/^\/+/, ""));
            if (!filePath.startsWith(dir + path.sep)) continue;
            await fsp.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
            await fsp.writeFile(filePath, file.content, "utf8").catch(() => {});
          }
        }
      }

      const preferred = detectPreferredCompiler(tex);
      const unicodeOnly = preferred !== "pdflatex" && engine === "pdflatex";
      let output = "";
      let timedOut = false;
      for (let pass = 0; pass < 3 && !unicodeOnly; pass++) {
        const args = engine === "tectonic"
          ? ["--keep-logs", "main.tex"]
          : ["-interaction=nonstopmode", "-file-line-error", "main.tex"];
        const run = await runProcess(engine, args, dir, COMPILE_TIMEOUT_MS);
        output += run.output;
        if (run.timedOut) { timedOut = true; break; }
        const needsRerun =
          engine !== "tectonic" &&
          /rerun|labels? may have changed|no file main\.(toc|lof|lot|aux)/i.test(run.output);
        if (!needsRerun) break;
      }

      const pdfPath = path.join(dir, "main.pdf");
      const pdf = timedOut || unicodeOnly ? null : await fsp.readFile(pdfPath).catch(() => null);
      if (pdf && pdf.length > 0) {
        return { statusCode: 200, pdf, engine, via: "server" };
      }

      // A second compiler cannot fix definite syntax errors; keep remote fallback for missing dependencies.
      if (hasDefinitiveLocalSyntaxError(output)) {
        return { statusCode: 422, json: { error: 'LaTeX compilation failed.', log: tailLog(output) }, engine, via: 'server' };
      }

      // If local compilation failed (e.g. missing fmt file or missing package in minimal texlive),
      // seamlessly fall back to the remote TeX Live compiler before throwing an error.
      const remoteOutcome = await compileRemote(tex, files);
      if (remoteOutcome.statusCode === 200 && remoteOutcome.pdf) {
        return remoteOutcome;
      }

      if (remoteOutcome.statusCode !== 422) return remoteOutcome;

      // If remote also gave a compilation error, prefer the clearer log
      return {
        statusCode: 422,
        json: {
          error: (remoteOutcome.json?.error as string) || "LaTeX compilation failed.",
          log: (remoteOutcome.json?.log as string) || tailLog(output),
        },
      };
    } finally {
      fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // No local engine installed; use the robust remote compiler directly
  return compileRemote(tex, files);
}
