import { LATEX_MAX_AUTO_REPAIRS, LATEX_REPAIR_SOURCE_LIMIT, latexAutoRepairResponseSchema, latexRepairRequestSchema, type LatexAutoRepairResult } from './latexRepair';
import type { z } from 'zod';

type RepairRequest = z.infer<typeof latexRepairRequestSchema>;

export async function runLatexRepairSession(
  initial: RepairRequest,
  send: (request: RepairRequest) => Promise<unknown>,
  signal: AbortSignal,
  onProgress: (repairs: number) => void = () => {},
): Promise<LatexAutoRepairResult> {
  const started = Date.now();
  const fingerprint = async (source: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const seen = new Set([await fingerprint(initial.source)]);
  let request = { ...initial, remainingRepairs: LATEX_MAX_AUTO_REPAIRS, modelOffset: 0 };
  let latest: LatexAutoRepairResult | undefined;
  let repairs = 0;
  const finish = (result: LatexAutoRepairResult) => ({ ...result,
    message: result.success && repairs ? 'Errors fixed. PDF compiled successfully.' : result.message,
    repairs, durationMs: Date.now() - started, continueRepair: false });

  for (;;) {
    if (signal.aborted && latest) return finish({ ...latest, success: false, message: 'Automatic repair stopped. Completed fixes are retained; compile to verify the current document.' });
    signal.throwIfAborted();
    let result: LatexAutoRepairResult;
    try {
      result = latexAutoRepairResponseSchema.parse(await send(latexRepairRequestSchema.parse(request)));
    } catch (error) {
      if (signal.aborted && latest) return finish({ ...latest, success: false, message: 'Automatic repair stopped. Completed fixes are retained; compile to verify the current document.' });
      signal.throwIfAborted();
      if (!latest) throw error;
      const message = error instanceof Error ? error.message : 'The repair service is unavailable.';
      return finish({ ...latest, success: false, message: `Targeted fixes are retained, but automatic repair stopped. ${message}` });
    }
    if (result.repairs > request.remainingRepairs) throw new Error('The repair service exceeded the request safety limit.');
    const sourceFingerprint = await fingerprint(result.source);
    if (result.source !== request.source && seen.has(sourceFingerprint)) {
      return finish({ ...(latest ?? result), source: request.source, success: false, pdfBase64: undefined,
        message: 'Automatic repair stopped because the suggested changes repeat an earlier document. Review the remaining compiler error.' });
    }
    repairs += result.repairs;
    latest = result;
    onProgress(repairs);
    if (result.success || !result.continueRepair) return finish(result);
    if (!result.repairs || result.source === request.source) {
      return finish({ ...result, message: 'Automatic repair stopped because no further safe progress was made.' });
    }
    if (result.source.length > LATEX_REPAIR_SOURCE_LIMIT) {
      return finish({ ...result, message: 'Automatic repair paused because the document exceeds the supported size. Completed fixes are retained; split the document into chapter files.' });
    }
    seen.add(sourceFingerprint);
    request = { ...request, source: result.source, log: result.log.slice(-16000),
      message: 'Continue fixing every remaining compilation error. Recompile the updated source for fresh diagnostics.',
      remainingRepairs: LATEX_MAX_AUTO_REPAIRS, modelOffset: result.modelOffset ?? request.modelOffset };
  }
}
