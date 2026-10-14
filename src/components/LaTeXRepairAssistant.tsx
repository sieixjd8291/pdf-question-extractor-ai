import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles, X } from 'lucide-react';
import { isCompilerTimeout, latexRepairRequestError, latexRepairRequestSchema, type LatexAutoRepairResult, type LatexDiagnostic } from '../lib/latexRepair';
import { runLatexRepairSession } from '../lib/latexRepairSession';
import { geminiAuthHeaders, hasGeminiApiKey } from '../lib/geminiSettings';
import './LaTeXRepairAssistant.css';

export function LaTeXRepairAssistant({ fileName, source, files, signature, diagnostic, compiling, onComplete, onBusyChange, autoRunId, autoRepair, onAutoRunConsumed, onClose }: {
  fileName: string;
  source: string;
  files: { name: string; content: string }[];
  signature: string;
  diagnostic: LatexDiagnostic | null;
  compiling: boolean;
  onComplete: (result: LatexAutoRepairResult, expectedSignature: string) => boolean;
  onBusyChange: (busy: boolean) => void;
  autoRunId: number;
  autoRepair: boolean;
  onAutoRunConsumed: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [repairCount, setRepairCount] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const currentSignature = useRef(signature);
  const attemptedRunId = useRef(0);
  const automaticSession = useRef(false);
  currentSignature.current = signature;
  useEffect(() => {
    if (!autoRepair && automaticSession.current) controller.current?.abort();
  }, [autoRepair]);
  useEffect(() => () => {
    controller.current?.abort();
    controller.current = null;
    onBusyChange(false);
  }, [onBusyChange]);
  const currentError = diagnostic?.signature === signature ? diagnostic : null;
  const timedOut = Boolean(currentError && isCompilerTimeout(currentError.log));
  const canAnalyze = !busy && !compiling && currentError?.repairable && Boolean(currentError.log.trim());

  const analyze = async (automatic = false) => {
    if (!canAnalyze || !currentError || controller.current) return;
    if (!hasGeminiApiKey()) {
      setStatus('');
      setError('Enter your Gemini API key in Settings to analyze and fix errors.');
      return;
    }
    const request = latexRepairRequestSchema.safeParse({ source, fileName, files, message: currentError.message.slice(0, 2000), log: currentError.log.slice(-16000) });
    if (!request.success) {
      setError(latexRepairRequestError(request.error));
      return;
    }
    const requestSignature = signature;
    const abort = new AbortController();
    controller.current = abort;
    automaticSession.current = automatic;
    setBusy(true);
    setRepairCount(0);
    onBusyChange(true);
    setError('');
    setStatus('');
    try {
      const headers = { 'Content-Type': 'application/json', ...geminiAuthHeaders() };
      const result = await runLatexRepairSession(request.data, async batch => {
        if (currentSignature.current !== requestSignature) {
          abort.abort();
          throw new Error('Your project changed during repair.');
        }
        const response = await fetch('/api/latex-repair', {
          method: 'POST', headers, signal: abort.signal, body: JSON.stringify(batch),
        });
        const responseText = await response.text();
        let data;
        try { data = JSON.parse(responseText); } catch { data = null; }
        if (!response.ok) {
          const deploymentError = /FUNCTION_INVOCATION_FAILED|FUNCTION_INVOCATION_TIMEOUT/.test(responseText);
          throw new Error(data?.error || (deploymentError
            ? 'The deployed repair API crashed or timed out before returning a result. Check the deployment runtime logs.'
            : `The repair API returned HTTP ${response.status}.`));
        }
        return data;
      }, abort.signal, setRepairCount);
      if (currentSignature.current !== requestSignature || !onComplete(result, requestSignature)) {
        throw new Error('Your project changed during repair. The result was not applied. Compile the latest source and try again.');
      }
      if (result.success || abort.signal.aborted) setStatus(result.message);
      else setError(result.message);
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'Repair failed. Your source is unchanged.');
      else if (controller.current === abort) {
        if (currentSignature.current !== requestSignature) setError('Your project changed during repair. The result was not applied. Compile the latest source and try again.');
        else setStatus('Automatic repair stopped. Your source is unchanged.');
      }
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setBusy(false);
        onBusyChange(false);
      }
    }
  };

  useEffect(() => {
    if (!autoRepair || !autoRunId || !canAnalyze || attemptedRunId.current === autoRunId) return;
    let cancelled = false;
    // Defer startup so Strict Mode's setup/cleanup replay cannot strand a cancelled session.
    queueMicrotask(() => {
      if (cancelled) return;
      attemptedRunId.current = autoRunId;
      onAutoRunConsumed();
      void analyze(true);
    });
    return () => { cancelled = true; };
  }, [autoRunId, autoRepair, canAnalyze, analyze, onAutoRunConsumed]);

  return (
      <aside className="latex-repair" aria-labelledby="latex-assistant-title" aria-describedby="latex-assistant-description">
        <header className="latex-repair-head">
          <div><Sparkles size={16} aria-hidden="true" /><strong id="latex-assistant-title">LaTeX assistant</strong></div>
          <button className="icon-button" onClick={onClose} aria-label="Close LaTeX assistant"><X size={15} /></button>
        </header>
        <div className="latex-repair-body">
          <p id="latex-assistant-description">{busy ? (timedOut ? 'Retrying compilation and checking for errors. Source changes are only made when the compiler reports a repairable TeX error.' : 'The assistant is fixing errors and recompiling in the background.') : compiling ? 'Waiting for compiler output…' : timedOut ? 'The compiler timed out. Retry compilation and let the assistant fix any TeX errors it finds. If it times out again, your source will remain unchanged.' : currentError?.repairable && currentError.log.trim() ? 'The assistant applies all safe fixes together, recompiles, and automatically handles newly revealed errors in the same session. Lite models run first, with Flash fallback when needed. There is no fixed session limit, but repair stops on repeated changes, unsafe suggestions or provider limits.' : currentError ? 'This failure has no repairable compiler log. Check compiler availability and try compiling again.' : diagnostic ? 'The source has changed. Compile again to check the latest errors.' : 'No compilation errors to fix. Compile your document first if you have made changes.'}</p>
          <div aria-live="polite" aria-busy={busy}>
            {busy && <p className="latex-repair-progress"><RefreshCw size={14} className="spinner" aria-hidden="true" /> {timedOut ? 'Retrying compilation and checking errors…' : repairCount ? `${repairCount} repair rounds applied. Checking and fixing remaining errors automatically…` : 'Analyzing and fixing all reported errors…'}</p>}
            {error && <div role="status">
              <p>{/quota|rate.?limit|429/i.test(error)
                ? 'Automatic repair is paused because Gemini has no available capacity. Your source is preserved. Retry when capacity returns, or use a billing-enabled Google project.'
                : 'Automatic repair is paused. Your source is preserved. Expand the details below for the next step.'}</p>
              <details><summary>Repair details</summary><p>{error}</p></details>
            </div>}
            {status && <p>{status}</p>}
          </div>
          <footer className="latex-repair-actions">
            {busy
              ? <button className="btn btn-sm" onClick={() => controller.current?.abort()}><X size={14} aria-hidden="true" />Stop repair</button>
              : <button className="btn primary btn-sm" disabled={!canAnalyze} onClick={() => void analyze()}><Sparkles size={14} aria-hidden="true" />Analyze and fix errors</button>}
          </footer>
        </div>
      </aside>
  );
}
