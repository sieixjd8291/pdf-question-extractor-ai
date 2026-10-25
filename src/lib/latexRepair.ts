import { z } from 'zod';

export const LATEX_REPAIR_SOURCE_LIMIT = 400000;
export const LATEX_REPAIR_CONTEXT_LIMIT = 600000;
export const LATEX_MAX_AUTO_REPAIRS = 15;

export function isCompilerTimeout(log: string): boolean {
  return /^(?:COMPILATION_TIMEOUT|Compilation timed out\.?|Compile timeout\.?)$/i.test(log.trim());
}

export const latexRepairRequestSchema = z.object({
  source: z.string().min(1).max(LATEX_REPAIR_SOURCE_LIMIT),
  fileName: z.string().min(1).max(250),
  message: z.string().min(1).max(2000),
  log: z.string().min(1).max(16000),
  files: z.array(z.object({ name: z.string().max(250), content: z.string().max(LATEX_REPAIR_SOURCE_LIMIT) })).max(20),
  remainingRepairs: z.number().int().min(0).max(LATEX_MAX_AUTO_REPAIRS).optional(),
  modelOffset: z.number().int().min(0).max(5).optional(),
}).refine(value => value.files.reduce((size, file) => size + file.content.length, value.source.length) <= LATEX_REPAIR_CONTEXT_LIMIT, 'Project context exceeds 600,000 characters.');

export function latexRepairRequestError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue.path[0] === 'source') return 'The active document must contain 1–400,000 characters. Split larger documents into chapter files before analyzing.';
  if (issue.path[0] === 'files') return 'The assistant supports up to 20 context files, with at most 400,000 characters per file.';
  if (issue.code === 'custom') return issue.message;
  if (issue.path[0] === 'log') return 'No usable compiler log was received. Compile again to capture the error details.';
  return 'The repair request is invalid. Check the filename and compiler diagnostic, then try again.';
}

export const latexRepairResponseSchema = z.object({
  summary: z.string().min(1).max(1500),
  edits: z.array(z.object({
    before: z.string().min(1).max(8000),
    after: z.string().max(8000),
    reason: z.string().min(1).max(500),
  })).max(40),
});

export const latexAutoRepairResponseSchema = z.object({
  source: z.string().min(1).max(500000),
  success: z.boolean(),
  message: z.string(),
  log: z.string(),
  repairs: z.number().int().min(0).max(LATEX_MAX_AUTO_REPAIRS),
  pdfBase64: z.string().optional(),
  engine: z.string().optional(),
  via: z.enum(['server', 'remote']).optional(),
  durationMs: z.number().nonnegative(),
  continueRepair: z.boolean().optional(),
  modelOffset: z.number().int().min(0).max(5).optional(),
});

export type LatexAutoRepairResult = z.infer<typeof latexAutoRepairResponseSchema>;
export type LatexRepair = z.infer<typeof latexRepairResponseSchema>;
export type LatexDiagnostic = { message: string; log: string; fileId: string; signature: string; repairable: boolean };

/** True only when the log shows a real TeX failure (not warnings, overfull boxes, or infrastructure issues). */
export function hasFatalTexError(log: string): boolean {
  return /^!\s+\S/m.test(log)
    || /Fatal error occurred/i.test(log)
    || /Emergency stop/i.test(log)
    || /No pages of output/i.test(log)
    || /^.+:\d+:\s+\S.*$/m.test(log) && /-file-line-error|Undefined control sequence|Missing .* inserted|File `.*' not found/i.test(log);
}

export function repairSignature(fileId: string, files: { id: string; name: string; content: string }[]): string {
  return JSON.stringify({ fileId, files });
}

/**
 * Applies every safe, uniquely matching edit at once and skips the rest, so one bad
 * suggestion does not throw away all the other fixes in the same response.
 */
export function applyApplicableLatexEdits(source: string, edits: LatexRepair['edits']): { source: string; applied: LatexRepair['edits']; skipped: number } {
  const candidates = edits.flatMap(edit => {
    if (!edit.before || edit.before === edit.after) return [];
    const start = source.indexOf(edit.before);
    if (start < 0 || source.indexOf(edit.before, start + 1) !== -1) return [];
    const dangerous = /\\(?:(?:write18|openout|read|catcode|directlua|special)\b|(?:input|include)\s*(?:\{\s*)?["']?\|)/g;
    if ((edit.after.match(dangerous)?.length ?? 0) > (edit.before.match(dangerous)?.length ?? 0)) return [];
    return [{ start, end: start + edit.before.length, edit }];
  }).sort((a, b) => a.start - b.start);
  const accepted: typeof candidates = [];
  for (const candidate of candidates) {
    if (accepted.length && candidate.start < accepted[accepted.length - 1].end) continue;
    accepted.push(candidate);
  }
  let result = source;
  for (const { start, end, edit } of [...accepted].reverse()) result = result.slice(0, start) + edit.after + result.slice(end);
  if (!result.trim() || result.length > 500000) return { source, applied: [], skipped: edits.length };
  return { source: result, applied: accepted.map(item => item.edit), skipped: edits.length - accepted.length };
}
