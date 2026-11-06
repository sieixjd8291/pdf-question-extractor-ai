import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyApplicableLatexEdits } from './latexRepair';
import { runLatexRepairSession } from './latexRepairSession';

const repeatedSource = [
  '\\begin{enumerate}',
  '\\item One',
  '\\end{enumerate}',
  '\\begin{enumerate}',
  '\\item Two',
  '\\end{enumerate}',
].join('\n');

test('line-targeted edits safely disambiguate repeated LaTeX source', () => {
  const result = applyApplicableLatexEdits(repeatedSource, [{
    before: '\\end{enumerate}',
    after: '\\end{enumerate} % repaired',
    line: 6,
    reason: 'Repair only the second environment.',
  }]);
  assert.equal(result.applied.length, 1);
  assert.equal(result.source.split('\n')[2], '\\end{enumerate}');
  assert.equal(result.source.split('\n')[5], '\\end{enumerate} % repaired');
});

test('ambiguous edits without a valid line anchor remain unchanged', () => {
  for (const line of [undefined, 2]) {
    const result = applyApplicableLatexEdits(repeatedSource, [{
      before: '\\end{enumerate}',
      after: '\\end{enumerate} % repaired',
      line,
      reason: 'Must not guess between duplicate lines.',
    }]);
    assert.equal(result.source, repeatedSource);
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped, 1);
  }
});

test('repair session retains completed fixes when a later provider runs out of quota', async () => {
  let calls = 0;
  const result = await runLatexRepairSession({
    source: '\\bad',
    fileName: 'main.tex',
    message: 'Compilation failed',
    log: '! Undefined control sequence',
    files: [],
  }, async () => {
    calls++;
    if (calls === 1) return {
      source: 'Retained fix',
      success: false,
      message: 'Continue with fresh diagnostics.',
      log: '! Remaining error',
      repairs: 1,
      durationMs: 1,
      continueRepair: true,
      modelOffset: 1,
    };
    throw new Error('429 quota exceeded');
  }, new AbortController().signal);

  assert.equal(calls, 2);
  assert.equal(result.source, 'Retained fix');
  assert.equal(result.repairs, 1);
  assert.equal(result.success, false);
  assert.match(result.message, /retained.*429 quota exceeded/i);
});
