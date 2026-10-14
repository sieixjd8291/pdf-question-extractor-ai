import { TriangleAlert } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const ref = useDialog(onClose);
  return (
    <div className="modal-backdrop" style={{ zIndex: 70 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className="modal-panel sm confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        tabIndex={-1}
      >
        <div className="confirm-body">
          <span className={`confirm-icon ${danger ? 'danger' : ''}`.trim()}>
            <TriangleAlert size={17} />
          </span>
          <div>
            <h2 id="confirm-title">{title}</h2>
            <p id="confirm-message">{message}</p>
          </div>
        </div>
        <footer className="confirm-actions">
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className={danger ? 'btn danger-solid' : 'btn primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
