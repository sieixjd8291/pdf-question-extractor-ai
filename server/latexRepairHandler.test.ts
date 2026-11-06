import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRepairPayload,
  GATEWAY_REPAIR_MODELS,
  LATEX_REPAIR_MODELS,
  repairAttempts,
  repairLatex,
  resetRepairCooldowns,
} from './latexRepairHandler.js';

function largeSource() {
  const lines = ['\\documentclass{article}', '\\begin{document}'];
  for (let line = 3; line <= 2200; line++) lines.push(`Section ${line} ${'x'.repeat(90)}`);
  lines[1499] = '\\badcommand % error on line 1500';
  lines.push('\\end{document}');
  return lines.join('\n');
}

test('large repair payloads stay bounded and retain numbered error context', () => {
  const payload = buildRepairPayload({
    source: largeSource(),
    fileName: 'main.tex',
    message: 'Compilation failed',
    log: '! Undefined control sequence.\nl.1500 \\badcommand',
    files: [{ name: 'unreferenced.tex', content: 'y'.repeat(100000) }],
  });
  const excerpt = 'sourceExcerpt' in payload ? payload.sourceExcerpt : '';
  assert.ok(excerpt.length > 0);
  assert.ok(excerpt.length <= 85000, `Excerpt was ${excerpt.length} characters`);
  assert.match(excerpt, /1500\| \\badcommand/);
  assert.ok(JSON.stringify(payload).length < 100000);
  assert.equal('source' in payload, false);
  assert.equal('content' in payload.contextFiles[0], false);

  const noLinePayload = buildRepairPayload({ source: largeSource(), log: 'Fatal error occurred', files: [] });
  const noLineExcerpt = 'sourceExcerpt' in noLinePayload ? noLinePayload.sourceExcerpt : '';
  assert.ok(noLineExcerpt.length > 0);
  assert.ok(noLineExcerpt.length <= 85000, `Fallback excerpt was ${noLineExcerpt.length} characters`);
});

test('provider chain tries non-Google models first and recovers from quota errors', async () => {
  resetRepairCooldowns();
  try {
    const planned = repairAttempts('test-key').map(attempt => attempt.label);
    assert.deepEqual(planned.slice(0, 3), GATEWAY_REPAIR_MODELS.slice(0, 3));
    assert.ok(planned.slice(0, 3).every(model => !model.startsWith('google/') && !model.startsWith('gemini-')));

    const calls: string[] = [];
    const result = await repairLatex({
      source: '\\documentclass{article}\n\\begin{document}\n\\bad\n\\end{document}',
      fileName: 'main.tex',
      message: 'Compilation failed',
      log: '! Undefined control sequence.\nl.3 \\bad',
      files: [],
    }, undefined, async model => {
      calls.push(model);
      if (calls.length === 1) throw new Error('429 quota exceeded');
      return {
        summary: 'Replaced the invalid command with plain text.',
        edits: [{ before: '\\bad', after: 'Valid text.', line: 3, reason: 'Minimal compilation fix.' }],
      };
    });

    assert.equal(result.status, 200);
    assert.deepEqual(calls, GATEWAY_REPAIR_MODELS.slice(0, 2));
    assert.ok('modelUsed' in result.json);
    assert.equal(result.json.modelUsed, GATEWAY_REPAIR_MODELS[1]);
  } finally {
    resetRepairCooldowns();
  }
});

test('Gateway authentication failure does not block direct provider fallback', async () => {
  resetRepairCooldowns();
  try {
    const calls: string[] = [];
    const result = await repairLatex({
      source: '\\documentclass{article}\n\\begin{document}\n\\bad\n\\end{document}',
      fileName: 'main.tex',
      message: 'Compilation failed',
      log: '! Undefined control sequence.\nl.3 \\bad',
      files: [],
    }, undefined, async model => {
      calls.push(model);
      if (calls.length === 1) throw new Error('401 API key not valid');
      return {
        summary: 'Replaced the invalid command with plain text.',
        edits: [{ before: '\\bad', after: 'Valid text.', line: 3, reason: 'Minimal compilation fix.' }],
      };
    });

    assert.equal(result.status, 200);
    assert.deepEqual(calls, [GATEWAY_REPAIR_MODELS[0], LATEX_REPAIR_MODELS[0]]);
  } finally {
    resetRepairCooldowns();
  }
});
