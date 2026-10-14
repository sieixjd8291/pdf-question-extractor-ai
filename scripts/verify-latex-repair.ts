import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { applyApplicableLatexEdits, applyLatexEdits, LATEX_MAX_AUTO_REPAIRS, latexRepairRequestSchema, latexRepairResponseSchema, repairSignature } from '../src/lib/latexRepair';
import { runLatexRepairSession } from '../src/lib/latexRepairSession';
import { automaticallyRepairLatex, buildRepairPayload, LATEX_REPAIR_MODELS, MAX_AI_REPAIR_ROUNDS, MODEL_TIMEOUT_MS, nextGeminiQuotaReset, repairLatex, resetRepairCooldowns } from '../server/latexRepairHandler';

const source = '\\documentclass{article}\n\\begin{document}\nEnergy: $E=mc^2\n\\end{document}';
const edit = { before: 'Energy: $E=mc^2', after: 'Energy: $E=mc^2$', reason: 'Close the math delimiter.' };
const corrected = applyLatexEdits(source, [edit]);
assert.equal(corrected, source.replace(edit.before, edit.after));
assert.equal(applyLatexEdits(source, []), source);
assert.throws(() => applyLatexEdits('same same', [{ ...edit, before: 'same' }]));
assert.throws(() => applyLatexEdits(source, [{ ...edit, before: 'missing' }]));
assert.throws(() => applyLatexEdits('abcdef', [{ ...edit, before: 'abcd' }, { ...edit, before: 'cdef' }]));
assert.throws(() => applyLatexEdits(source, [{ ...edit, after: edit.before }]));
assert.throws(() => applyLatexEdits(source, [{ ...edit, after: '\\write18{touch /tmp/unsafe}' }]));
assert.throws(() => applyLatexEdits(source, [{ ...edit, after: '\\input{|touch /tmp/unsafe}' }]));
assert.throws(() => applyLatexEdits('entire document', [{ ...edit, before: 'entire document', after: '' }]));
assert.equal(latexRepairResponseSchema.safeParse({ summary: 'Fix', edits: [edit] }).success, true);
assert.equal(latexRepairResponseSchema.safeParse({ summary: 'Fix', edits: [{ before: '', after: 'invented', reason: 'Bad' }] }).success, false);
const request = { source, fileName: 'main.tex', message: 'Compilation failed', log: '! Missing $ inserted.', files: [] };
assert.equal(latexRepairRequestSchema.safeParse(request).success, true);
assert.equal(latexRepairRequestSchema.safeParse({ ...request, log: '' }).success, false);
assert.equal(latexRepairRequestSchema.safeParse({ ...request, source: 'x'.repeat(80001) }).success, true);
assert.equal(latexRepairRequestSchema.safeParse({ ...request, source: 'x'.repeat(400001) }).success, false);
assert.equal(latexRepairRequestSchema.safeParse({ ...request, files: Array.from({ length: 4 }, () => ({ name: 'chapter.tex', content: 'x'.repeat(160000) })) }).success, false);
const files = [{ id: 'file', name: 'main.tex', content: source }];
assert.notEqual(repairSignature('file', files), repairSignature('file', [{ ...files[0], content: corrected }]));
assert.notEqual(repairSignature('file', files), repairSignature('other-file', files));
assert.notEqual(repairSignature('file', files), repairSignature('file', [...files, { id: 'context', name: 'chapter.tex', content: 'updated' }]));
assert.equal((await repairLatex({})).status, 400);
const requestedModels: string[] = [];
const fallback = await repairLatex(request, undefined, async (model, options) => {
  requestedModels.push(model);
  assert.ok(options.system.includes('not a general assistant'));
  if (requestedModels.length === 1) throw new Error('Temporary gateway failure');
  return { summary: 'Close math.', edits: [edit] };
});
assert.equal(fallback.status, 200);
assert.equal('modelUsed' in fallback.json && fallback.json.modelUsed, 'gemini-3.1-flash-lite');
assert.deepEqual(requestedModels, LATEX_REPAIR_MODELS.slice(0, 2));
let attempts = 0;
const primary = await repairLatex(request, undefined, async (model) => {
  attempts++;
  assert.equal(model, 'gemini-3.5-flash-lite');
  return { summary: 'Close math.', edits: [edit] };
});
assert.equal(primary.status, 200);
assert.equal('modelUsed' in primary.json && primary.json.modelUsed, 'gemini-3.5-flash-lite');
assert.equal(attempts, 1);
attempts = 0;
const tried: string[] = [];
const unavailable = await repairLatex(request, undefined, async (model) => { attempts++; tried.push(model); throw new Error('Model unavailable'); });
assert.equal(unavailable.status, 502);
assert.equal(attempts, LATEX_REPAIR_MODELS.length);
assert.deepEqual(tried, [...LATEX_REPAIR_MODELS]);
attempts = 0;
const unsafe = await repairLatex(request, undefined, async () => {
  attempts++;
  return { summary: 'Unsafe.', edits: [{ ...edit, after: '\\write18{unsafe}' }] };
});
assert.equal(unsafe.status, 502);
assert.equal(attempts, LATEX_REPAIR_MODELS.length);
const keyless = await repairLatex(request, undefined, async () => ({ summary: 'Close math.', edits: [edit] }));
assert.equal(keyless.status, 200);
const pdf = Buffer.from('%PDF-1.7\nverified');
const failure = (log: string) => ({ statusCode: 422, json: { error: 'Compilation failed', log } });
const compilationSources: string[] = [];
const repairLogs: string[] = [];
const sequential = await automaticallyRepairLatex({ ...request, source: 'first-error second-error' }, 'test-key', {
  compile: async (tex) => {
    const text = String(tex);
    compilationSources.push(text);
    return text.includes('first-error') ? failure('First error') : text.includes('second-error') ? failure('Second error') : { statusCode: 200, pdf, engine: 'pdflatex', via: 'server' };
  },
  repair: async (body) => {
    const data = latexRepairRequestSchema.parse(body);
    repairLogs.push(data.log);
    const before = data.log === 'First error' ? 'first-error' : 'second-error';
    return { status: 200, json: { summary: 'Targeted fix', edits: [{ before, after: 'fixed', reason: 'Fix the current error' }], modelUsed: 'gemini-3.8-flash' } };
  },
});
assert.equal(sequential.status, 200);
assert.ok('success' in sequential.json && sequential.json.success);
assert.ok('source' in sequential.json && sequential.json.source === 'fixed fixed');
assert.ok('repairs' in sequential.json && sequential.json.repairs === 2);
assert.ok('pdfBase64' in sequential.json && sequential.json.pdfBase64 === pdf.toString('base64'));
assert.deepEqual(compilationSources, ['first-error second-error', 'fixed second-error', 'fixed fixed']);
assert.deepEqual(repairLogs, ['First error', 'Second error']);
let elapsed = 0;
const slowCompileSources: string[] = [];
const slowRepairClock = mock.method(Date, 'now', () => elapsed);
try {
  const slowRepair = await automaticallyRepairLatex({ ...request, source: 'broken' }, 'test-key', {
    compile: async tex => {
      slowCompileSources.push(String(tex));
      return tex === 'broken' ? failure('! Undefined control sequence.') : { statusCode: 200, pdf };
    },
    repair: async () => {
      elapsed = 61000;
      return { status: 200, json: { summary: 'Fix', edits: [{ before: 'broken', after: 'fixed', reason: 'Fix syntax' }], modelUsed: LATEX_REPAIR_MODELS[0] } };
    },
  });
  assert.deepEqual(slowCompileSources, ['broken', 'fixed'], 'every fix is recompiled immediately, even after a slow repair');
  assert.ok('success' in slowRepair.json && slowRepair.json.success);
  assert.ok('continueRepair' in slowRepair.json && !slowRepair.json.continueRepair, 'successful recompilation stops without another batch or AI call');
} finally {
  slowRepairClock.mock.restore();
}
let aiCalls = 0;
const unusedRepair: typeof repairLatex = async () => { aiCalls++; throw new Error('AI must not run'); };
const working = await automaticallyRepairLatex(request, 'test-key', { compile: async () => ({ statusCode: 200, pdf }), repair: unusedRepair });
assert.ok('success' in working.json && working.json.success);
assert.equal(aiCalls, 0);
const largeDocument = await automaticallyRepairLatex({ ...request, source: 'x'.repeat(100000) }, 'test-key', { compile: async () => ({ statusCode: 200, pdf }), repair: unusedRepair });
assert.equal(largeDocument.status, 200);
assert.ok('success' in largeDocument.json && largeDocument.json.success);
let timeoutRetries = 0;
const timeout = await automaticallyRepairLatex({ ...request, log: 'COMPILATION_TIMEOUT' }, 'test-key', { compile: async () => { timeoutRetries++; return { statusCode: 504, json: { log: 'COMPILATION_TIMEOUT' } }; }, repair: unusedRepair });
assert.equal(timeout.status, 200);
assert.equal(timeoutRetries, 1);
assert.ok('source' in timeout.json && timeout.json.source === source);
assert.ok('message' in timeout.json && timeout.json.message.includes('timed out'));
assert.equal(aiCalls, 0);
const recoveredTimeout = await automaticallyRepairLatex({ ...request, log: 'COMPILATION_TIMEOUT' }, 'test-key', { compile: async () => ({ statusCode: 200, pdf }), repair: unusedRepair });
assert.ok('success' in recoveredTimeout.json && recoveredTimeout.json.success);
assert.ok('pdfBase64' in recoveredTimeout.json && recoveredTimeout.json.pdfBase64 === pdf.toString('base64'));
assert.equal(aiCalls, 0);
let timeoutRepairCalls = 0;
const repairedTimeout = await automaticallyRepairLatex({ ...request, source: 'broken', log: 'COMPILATION_TIMEOUT' }, 'test-key', {
  compile: async (tex) => tex === 'broken' ? failure('! Undefined control sequence.') : { statusCode: 200, pdf },
  repair: async (body) => {
    const data = latexRepairRequestSchema.parse(body);
    assert.equal(data.log, '! Undefined control sequence.');
    timeoutRepairCalls++;
    return { status: 200, json: { summary: 'Targeted fix', edits: [{ before: 'broken', after: 'fixed', reason: 'Fix compiler error' }], modelUsed: 'gemini-3.8-flash' } };
  },
});
assert.equal(timeoutRepairCalls, 1);
assert.ok('success' in repairedTimeout.json && repairedTimeout.json.success);
assert.ok('source' in repairedTimeout.json && repairedTimeout.json.source === 'fixed');
const oversized = await automaticallyRepairLatex({ ...request, source: 'x'.repeat(400001) }, 'test-key');
assert.equal(oversized.status, 400);
assert.ok('error' in oversized.json && oversized.json.error.includes('400,000'));
assert.ok('error' in oversized.json && !oversized.json.error.includes('Compile your current document'));
const recompilationTimeout = await automaticallyRepairLatex(request, 'test-key', { compile: async () => failure('COMPILATION_TIMEOUT'), repair: unusedRepair });
assert.ok('message' in recompilationTimeout.json && recompilationTimeout.json.message.includes('timed out'));
assert.equal(aiCalls, 0);
const keylessAutomatic = await automaticallyRepairLatex(request, '', { compile: async () => ({ statusCode: 200, pdf }), repair: unusedRepair });
assert.equal(keylessAutomatic.status, 200);
assert.ok('success' in keylessAutomatic.json && keylessAutomatic.json.success);
const noLog = await automaticallyRepairLatex(request, 'test-key', { compile: async () => ({ statusCode: 502 }), repair: unusedRepair });
assert.ok('success' in noLog.json && !noLog.json.success);
assert.equal(aiCalls, 0);
const bounded = await automaticallyRepairLatex(request, 'test-key', {
  compile: async () => failure('Still broken'),
  repair: async (body) => {
    const data = latexRepairRequestSchema.parse(body);
    return { status: 200, json: { summary: 'Fix', edits: [{ before: data.source, after: data.source + ' ', reason: 'Test progress' }], modelUsed: LATEX_REPAIR_MODELS[data.modelOffset ?? 0] } };
  },
});
assert.ok('repairs' in bounded.json && bounded.json.repairs === MAX_AI_REPAIR_ROUNDS);
assert.ok('continueRepair' in bounded.json && bounded.json.continueRepair === true);
assert.ok('modelOffset' in bounded.json && bounded.json.modelOffset === 0, 'safe progress keeps the fast model rather than escalating every round');
assert.ok('success' in bounded.json && !bounded.json.success);
const unsafeAutomatic = await automaticallyRepairLatex(request, 'test-key', {
  compile: async () => failure('Error'),
  repair: async () => ({ status: 200, json: { summary: 'Unsafe', edits: [{ ...edit, after: '\\write18{unsafe}' }], modelUsed: 'gemini-3.8-flash' } }),
});
assert.ok('source' in unsafeAutomatic.json && unsafeAutomatic.json.source === source);
assert.ok('repairs' in unsafeAutomatic.json && unsafeAutomatic.json.repairs === 0);
const cycle = await automaticallyRepairLatex({ ...request, source: 'A' }, 'test-key', {
  compile: async () => failure('Error'),
  repair: async (body) => {
    const data = latexRepairRequestSchema.parse(body);
    return { status: 200, json: { summary: 'Fix', edits: [{ before: data.source, after: data.source === 'A' ? 'B' : 'A', reason: 'Test cycle' }], modelUsed: 'gemini-3.8-flash' } };
  },
});
assert.ok('source' in cycle.json && cycle.json.source === 'B');
assert.ok('repairs' in cycle.json && cycle.json.repairs === 1);
const sessionOffsets: number[] = [];
let sessionRequests = 0;
const manyErrors = 'error1 error2 error3 error4 error5 error6';
const completeSession = await runLatexRepairSession({ ...request, source: manyErrors }, async batch => {
  sessionRequests++;
  const response = await automaticallyRepairLatex(batch, 'test-key', {
    compile: async tex => /error\d/.test(String(tex)) ? failure('The next hidden compiler error') : { statusCode: 200, pdf },
    repair: async body => {
      const data = latexRepairRequestSchema.parse(body);
      sessionOffsets.push(data.modelOffset ?? 0);
      const before = data.source.match(/error\d/)![0];
      return { status: 200, json: { summary: 'Fix next error', edits: [{ before, after: 'fixed', reason: 'Fix syntax' }], modelUsed: LATEX_REPAIR_MODELS[data.modelOffset ?? 0] } };
    },
  });
  return response.json;
}, new AbortController().signal);
assert.equal(completeSession.success, true, 'one session handles more than two AI rounds without another click');
assert.equal(completeSession.source, 'fixed fixed fixed fixed fixed fixed');
assert.equal(completeSession.repairs, 6);
assert.equal(completeSession.pdfBase64, pdf.toString('base64'));
assert.equal(sessionRequests, 3, 'continues across short server requests');
assert.deepEqual(sessionOffsets, [0, 0, 0, 0, 0, 0]);

let batchRepairCalls = 0;
const allTogether = await automaticallyRepairLatex({ ...request, source: 'error1 error2' }, 'test-key', {
  compile: async tex => String(tex).includes('error') ? failure('Two errors') : { statusCode: 200, pdf },
  repair: async () => {
    batchRepairCalls++;
    return { status: 200, json: { summary: 'Fix both', edits: [
      { before: 'error1', after: 'fixed1', reason: 'First error' },
      { before: 'error2', after: 'fixed2', reason: 'Second error' },
    ], modelUsed: LATEX_REPAIR_MODELS[0] } };
  },
});
assert.ok('success' in allTogether.json && allTogether.json.success);
assert.equal(batchRepairCalls, 1, 'all independent edits are applied together before recompiling');

const boundedBatch = await automaticallyRepairLatex({ ...request, source: 'error1 error2', remainingRepairs: 1 }, 'test-key', {
  compile: async () => failure('Another repairable error'),
  repair: async () => ({ status: 200, json: { summary: 'Fix first error', edits: [{ before: 'error1', after: 'fixed1', reason: 'Fix syntax' }], modelUsed: LATEX_REPAIR_MODELS[0] } }),
});
assert.ok('continueRepair' in boundedBatch.json && boundedBatch.json.continueRepair, 'reaching the per-request budget continues rather than ending the session');
assert.ok('repairs' in boundedBatch.json && boundedBatch.json.repairs === 1);
const progressing = { source: 'B', success: false, message: 'Continue', log: 'Error', repairs: 1, durationMs: 0, continueRepair: true };
let limitedSessionCalls = 0;
const limitedSession = await runLatexRepairSession({ ...request, source: 'A' }, async batch => {
  limitedSessionCalls++;
  assert.equal(batch.remainingRepairs, LATEX_MAX_AUTO_REPAIRS, 'each short request has a fresh bounded budget');
  const success = limitedSessionCalls === LATEX_MAX_AUTO_REPAIRS + 5;
  return { ...progressing, source: `progress${limitedSessionCalls}`, success, continueRepair: !success };
}, new AbortController().signal);
assert.equal(limitedSessionCalls, LATEX_MAX_AUTO_REPAIRS + 5);
assert.equal(limitedSession.repairs, LATEX_MAX_AUTO_REPAIRS + 5);
assert.equal(limitedSession.success, true);
assert.equal(limitedSession.continueRepair, false);
let cyclicSessionCalls = 0;
const cyclicSession = await runLatexRepairSession({ ...request, source: 'A' }, async () => ({ ...progressing, source: ++cyclicSessionCalls === 1 ? 'B' : 'A' }), new AbortController().signal);
assert.equal(cyclicSessionCalls, 2);
assert.equal(cyclicSession.source, 'B', 'retains last non-cyclic source across batches');
let quotaSessionCalls = 0;
const stoppedSession = await runLatexRepairSession({ ...request, source: 'A' }, async () => {
  if (++quotaSessionCalls === 1) return progressing;
  throw new Error('Daily quota exhausted');
}, new AbortController().signal);
assert.equal(stoppedSession.source, 'B', 'partial fixes survive quota exhaustion in later batches');
assert.ok(stoppedSession.message.includes('Daily quota'));
assert.equal(quotaSessionCalls, 2, 'does not retry exhausted requests');
let noProgressCalls = 0;
const noProgressSession = await runLatexRepairSession(request, async () => { noProgressCalls++; return { ...progressing, source, repairs: 0 }; }, new AbortController().signal);
assert.equal(noProgressCalls, 1);
assert.equal(noProgressSession.continueRepair, false);
const stopController = new AbortController();
let stopRequests = 0;
const stoppedByUser = await runLatexRepairSession({ ...request, source: 'A' }, async () => {
  if (++stopRequests === 1) return progressing;
  stopController.abort();
  throw new DOMException('Repair cancelled', 'AbortError');
}, stopController.signal);
assert.equal(stoppedByUser.source, 'B', 'stopping retains completed batches');
assert.equal(stoppedByUser.repairs, 1);
assert.equal(stoppedByUser.continueRepair, false);
assert.ok(stoppedByUser.message.includes('stopped'));
const aborted = new AbortController();
aborted.abort();
await assert.rejects(runLatexRepairSession(request, async () => { throw new Error('Must not send'); }, aborted.signal), /abort/i);

const { compileRemote, hasDefinitiveLocalSyntaxError, createCachedLatexCompiler } = await import('../server/latexHandler');
let cacheTime = 0;
let cachedCompileCalls = 0;
const cachedCompiler = createCachedLatexCompiler(async () => {
  cachedCompileCalls++;
  return failure('! Undefined control sequence.');
}, () => cacheTime);
await Promise.all([cachedCompiler('broken'), cachedCompiler('broken', [])]);
assert.equal(cachedCompileCalls, 1, 'concurrent identical compiles share a single request');
await cachedCompiler('broken');
assert.equal(cachedCompileCalls, 1, 'repair reuses recent compiler-reported failure without recompiling unchanged source');
await cachedCompiler('fixed');
await cachedCompiler('broken', [{ name: 'chapter.tex', content: 'changed' }]);
assert.equal(cachedCompileCalls, 3, 'source and context changes always require fresh compilation');
cacheTime = 30001;
await cachedCompiler('broken');
assert.equal(cachedCompileCalls, 4, 'failure diagnostics expire promptly');
let efficientCompileCalls = 0;
let efficientAiCalls = 0;
const efficientSource = Array.from({ length: LATEX_MAX_AUTO_REPAIRS + 5 }, (_, index) => `broken${index};`).join(' ');
const efficientCompiler = createCachedLatexCompiler(async tex => {
  efficientCompileCalls++;
  return /broken\d+/.test(String(tex)) ? failure('! Undefined control sequence.') : { statusCode: 200, pdf };
});
await efficientCompiler(efficientSource, []);
const efficientSession = await runLatexRepairSession({ ...request, source: efficientSource }, async batch => {
  const response = await automaticallyRepairLatex(batch, 'test-key', {
    compile: efficientCompiler,
    repair: async body => {
      efficientAiCalls++;
      const data = latexRepairRequestSchema.parse(body);
      return { status: 200, json: { summary: 'Fix syntax', edits: [{ before: data.source.match(/broken\d+;/)![0], after: 'fixed', reason: 'Fix syntax' }], modelUsed: LATEX_REPAIR_MODELS[0] } };
    },
  });
  return response.json;
}, new AbortController().signal);
assert.equal(efficientSession.success, true);
assert.equal(efficientSession.repairs, LATEX_MAX_AUTO_REPAIRS + 5, 'no lifetime repair cap');
assert.equal(efficientAiCalls, efficientSession.repairs, 'no unnecessary AI calls after success');
assert.equal(efficientCompileCalls, efficientSession.repairs + 1, 'exactly one initial compile and one immediate recompile per fix, without duplicate checks across batches');
for (const outcome of [{ statusCode: 504, json: { log: 'COMPILATION_TIMEOUT' } }, { statusCode: 503 }, failure('LaTeX Warning: References changed.'), { statusCode: 200, pdf }]) {
  let calls = 0;
  const uncached = createCachedLatexCompiler(async () => { calls++; return outcome; });
  await uncached('same');
  await uncached('same');
  assert.equal(calls, 2, 'timeouts, infrastructure failures, warnings and PDFs are not retained in the failure cache');
}
assert.equal(hasDefinitiveLocalSyntaxError('! Missing $ inserted.\nl.12 Energy'), true);
assert.equal(hasDefinitiveLocalSyntaxError('! Extra }, or forgotten $.'), true);
assert.equal(hasDefinitiveLocalSyntaxError('Runaway argument?\n! Paragraph ended before \\title was complete.'), true);
assert.equal(hasDefinitiveLocalSyntaxError("! LaTeX Error: File `geometry.sty' not found.\n! Missing $ inserted."), false, 'missing dependencies retain remote fallback');
assert.equal(hasDefinitiveLocalSyntaxError('! Undefined control sequence.'), false, 'an unknown command may depend on an unavailable package');
assert.equal(hasDefinitiveLocalSyntaxError('Overfull \\hbox (12.0pt too wide)'), false);
assert.equal(hasDefinitiveLocalSyntaxError('COMPILATION_TIMEOUT'), false);
const originalFetch = globalThis.fetch;
const remoteRequests: { compiler: string; options: { compiler: { halt_on_error: boolean; force: boolean } }; resources: { path: string; content: string }[] }[] = [];
try {
  globalThis.fetch = async (_url, init) => {
    remoteRequests.push(JSON.parse(String(init?.body)));
    return remoteRequests.length === 1
      ? new Response(JSON.stringify({ error: 'COMPILATION_TIMEOUT' }), { status: 422 })
      : new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } });
  };
  const recovered = await compileRemote(source, [{ name: 'chapter.tex', content: 'Chapter text' }]);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.engine, 'xelatex');
  assert.deepEqual(remoteRequests.map(item => item.compiler), ['pdflatex', 'xelatex']);
  assert.ok(remoteRequests.every(item => item.options.compiler.halt_on_error && !item.options.compiler.force));
  assert.equal(remoteRequests[0].resources[1].path, 'chapter.tex');
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: 'COMPILATION_TIMEOUT' }), { status: 422 }); };
  assert.equal((await compileRemote(source)).statusCode, 504);
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: 'COMPILATION_FAILED', log_files: { 'main.log': '! Undefined control sequence.\\n l.10 \\badcommand' } }), { status: 422 }); };
  const syntaxError = await compileRemote(source);
  assert.equal(syntaxError.statusCode, 422);
  assert.ok(String(syntaxError.json?.log).includes('Undefined control sequence'));
  assert.equal(calls, 1);
} finally {
  globalThis.fetch = originalFetch;
}
resetRepairCooldowns();
const limitedCalls: string[] = [];
const rateLimited = await repairLatex(request, undefined, async (model) => {
  limitedCalls.push(model);
  throw new Error('429 RESOURCE_EXHAUSTED: Please retry in 0.05s.');
});
assert.equal(rateLimited.status, 429, 'returns rate-limit status without retrying provider calls');
assert.deepEqual(limitedCalls, [...LATEX_REPAIR_MODELS]);
const allCooling = await repairLatex(request, undefined, async () => { throw new Error('Must not call a cooling model'); });
assert.equal(allCooling.status, 429);
resetRepairCooldowns();
const skipCalls: string[] = [];
await repairLatex(request, undefined, async (model) => {
  skipCalls.push(model);
  if (model === 'gemini-3.5-flash-lite') throw new Error('429 Too Many Requests. Please retry in 20s.');
  return { summary: 'Close math.', edits: [edit] };
});
skipCalls.length = 0;
const skipped = await repairLatex(request, undefined, async (model) => { skipCalls.push(model); return { summary: 'Close math.', edits: [edit] }; });
assert.equal(skipped.status, 200);
assert.deepEqual(skipCalls, ['gemini-3.1-flash-lite'], 'skips a model that is still cooling down');
resetRepairCooldowns();
const daily = await repairLatex(request, undefined, async () => { throw new Error('429 quota exceeded: GenerateRequestsPerDayPerProjectPerModel'); });
assert.equal(daily.status, 429);
assert.ok('error' in daily.json && /midnight Pacific/i.test(daily.json.error));
const originalNow = Date.now;
const quotaDetectedAt = Date.now();
try {
  Date.now = () => quotaDetectedAt + Math.min(2 * 60 * 60 * 1000, nextGeminiQuotaReset(quotaDetectedAt) - quotaDetectedAt - 1);
  let dailyRetryCalls = 0;
  const stillExhausted = await repairLatex(request, undefined, async () => { dailyRetryCalls++; return { summary: 'Fix', edits: [edit] }; });
  assert.equal(stillExhausted.status, 429);
  assert.equal(dailyRetryCalls, 0, 'daily exhaustion remains blocked beyond the old one-hour cooldown');
  Date.now = () => nextGeminiQuotaReset(quotaDetectedAt);
  const afterReset = await repairLatex(request, undefined, async () => ({ summary: 'Fix', edits: [edit] }));
  assert.equal(afterReset.status, 200, 'models become available at the Pacific daily reset');
} finally {
  Date.now = originalNow;
}
resetRepairCooldowns();
const mixedFailures = await repairLatex(request, undefined, async model => {
  if (model === LATEX_REPAIR_MODELS[0]) throw new Error('429 daily quota exceeded');
  throw new Error('404 model unavailable for this project');
});
assert.equal(mixedFailures.status, 502, 'does not label unavailable models as quota exhausted');
assert.ok('error' in mixedFailures.json && mixedFailures.json.error.includes('not confirmed for every model'));
resetRepairCooldowns();
assert.equal(nextGeminiQuotaReset(Date.parse('2026-09-30T12:00:00Z')), Date.parse('2026-10-01T07:00:00Z'));
assert.equal(nextGeminiQuotaReset(Date.parse('2026-03-08T08:00:00Z')), Date.parse('2026-03-09T07:00:00Z'), 'spring DST day is 23 hours');
assert.equal(nextGeminiQuotaReset(Date.parse('2026-11-01T07:00:00Z')), Date.parse('2026-11-02T08:00:00Z'), 'fall DST day is 25 hours');
resetRepairCooldowns();
const bigLines = Array.from({ length: 2000 }, (_, i) => `Line ${i + 1} filler text for a very large document.`);
bigLines[0] = '\\documentclass{article}';
bigLines[1] = '\\begin{document}';
const bigPayload = buildRepairPayload({ source: bigLines.join('\n'), log: '! Undefined control sequence.\nl.1200 \\bad' });
assert.ok(!('source' in bigPayload) && 'sourceExcerpt' in bigPayload);
assert.ok(bigPayload.sourceExcerpt.includes('Line 1200 filler') && !bigPayload.sourceExcerpt.includes('Line 1500 filler'));
assert.ok(bigPayload.sourceExcerpt.length < 10000);
resetRepairCooldowns();
const slowCalls: string[] = [];
const slow = await repairLatex(request, undefined, async (model) => {
  slowCalls.push(model);
  await new Promise(resolve => setTimeout(resolve, 5100));
  return { summary: 'Close math.', edits: [edit] };
});
assert.equal(slow.status, 200);
assert.deepEqual(slowCalls, ['gemini-3.5-flash-lite'], 'a response slower than five seconds does not launch a speculative fallback');
let activeModels = 0;
let peakActiveModels = 0;
const sequentialFallback = await repairLatex(request, undefined, async (model) => {
  activeModels++;
  peakActiveModels = Math.max(peakActiveModels, activeModels);
  await new Promise(resolve => setTimeout(resolve, 10));
  activeModels--;
  if (model === 'gemini-3.5-flash-lite') throw new Error('Temporary provider failure');
  return { summary: 'Close math.', edits: [edit] };
});
assert.equal(sequentialFallback.status, 200);
assert.equal(peakActiveModels, 1);
resetRepairCooldowns();
const partial = await repairLatex(request, undefined, async () => ({ summary: 'Two fixes.', edits: [edit, { before: 'text that is not in the source', after: 'x', reason: 'Bad match.' }] }));
assert.equal(partial.status, 200, 'keeps valid edits even when another edit does not match');
assert.equal('edits' in partial.json && partial.json.edits.length, 1);
const multi = applyApplicableLatexEdits('a\nb\nc\nd', [
  { before: 'a', after: 'A', reason: 'fix 1' },
  { before: 'c', after: 'c\nnew line', reason: 'add line' },
  { before: 'zzz', after: 'y', reason: 'no match' },
]);
assert.equal(multi.source, 'A\nb\nc\nnew line\nd', 'applies every valid replacement and added line at once');
assert.equal(multi.skipped, 1);
resetRepairCooldowns();
mock.timers.enable({ apis: ['setTimeout'] });
try {
  let timedOutSignal: AbortSignal | undefined;
  const deadline = repairLatex(request, undefined, async (model, _options, signal) => {
    if (model === 'gemini-3.5-flash-lite') {
      timedOutSignal = signal;
      return new Promise(() => {});
    }
    assert.ok(timedOutSignal?.aborted, 'cancel the timed-out model before starting fallback');
    return { summary: 'Close math.', edits: [edit] };
  });
  mock.timers.tick(MODEL_TIMEOUT_MS);
  assert.equal((await deadline).status, 200);
} finally {
  mock.timers.reset();
}

resetRepairCooldowns();
let providerCalls = 0;
let signalProviderStarted: () => void = () => {};
const providerStarted = new Promise<void>(resolve => { signalProviderStarted = resolve; });
let releaseProvider: () => void = () => {};
const providerReleased = new Promise<void>(resolve => { releaseProvider = resolve; });
try {
  globalThis.fetch = async () => {
    providerCalls++;
    signalProviderStarted();
    await providerReleased;
    return new Response(JSON.stringify({ candidates: [{
      content: { role: 'model', parts: [{ text: JSON.stringify({ summary: 'Close math.', edits: [edit] }) }] },
      finishReason: 'STOP',
    }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const first = repairLatex(request, 'deduplication-test-key');
  const duplicate = repairLatex({ ...request }, 'deduplication-test-key');
  await providerStarted;
  assert.equal(providerCalls, 1, 'identical concurrent requests share one provider call');
  releaseProvider();
  const results = await Promise.all([first, duplicate]);
  assert.ok(results.every(result => result.status === 200));
  assert.deepEqual(results[0], results[1]);
  assert.equal((await repairLatex(request, 'different-credential-test-key')).status, 200);
  assert.equal(providerCalls, 2, 'results are not shared across credentials');
  assert.equal((await repairLatex(request, 'deduplication-test-key')).status, 200);
  assert.equal(providerCalls, 3, 'completed requests are removed, not persisted as unverified repair results');
} finally {
  releaseProvider();
  globalThis.fetch = originalFetch;
}
console.log('LaTeX repair checks passed: Lite-first sequential fallback, timeout cancellation, concurrent deduplication, no speculative requests or rate-limit retries, Pacific daily reset including DST, cooldown skipping, stable fast-model reuse, local syntax routing, automatic multi-batch sessions beyond two AI rounds, batched edits, cross-batch cycles, partial quota failure retention, session limits, cancellation, edit safety, PDF verification, no-error gating, and cycle protection.');
