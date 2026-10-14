import { Check, Loader2 } from 'lucide-react';
import { useProgressSnapshot, type StagedProgress } from '../lib/stagedProgress';

export function ScannerProgressBubble({ store }: { store: StagedProgress }) {
  const progress = useProgressSnapshot(store);
  if (!progress) return null;

  const subject = progress.format || 'Document';
  const title = progress.done
    ? progress.kind === 'import'
      ? 'Import complete'
      : `${subject} export complete`
    : progress.kind === 'import'
      ? 'Importing documents'
      : `Exporting ${subject}`;

  return (
    <div className="scanner-export-top-bubble animate-fadeIn" role="status" aria-live="polite">
      <div className="scanner-export-top-bubble-inner">
        <div className="scanner-export-top-bubble-icon">
          {progress.done ? (
            <Check size={18} className="text-accent" aria-hidden="true" />
          ) : (
            <Loader2 size={18} className="spin text-accent" aria-hidden="true" />
          )}
        </div>
        <div className="scanner-export-top-bubble-main">
          <div className="scanner-export-top-bubble-row">
            <span className="scanner-export-top-bubble-title">
              {title}
              {!progress.done && (
                <span className="scanner-loading-dots" aria-hidden="true">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              )}
            </span>
            <span className="scanner-export-top-bubble-pct">{progress.percent}%</span>
          </div>
          <div className="scanner-export-top-bubble-msg">{progress.message}</div>
          <div
            className="scanner-export-top-bubble-track"
            role="progressbar"
            aria-label={title}
            aria-valuenow={progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="scanner-export-top-bubble-bar" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ExportButtonLabel({ store, idleLabel }: { store: StagedProgress; idleLabel: string }) {
  const progress = useProgressSnapshot(store);
  if (!progress || progress.kind !== 'export') return <span>{idleLabel}</span>;
  return <span>{progress.done ? 'Exported' : `Exporting (${progress.percent}%)`}</span>;
}
