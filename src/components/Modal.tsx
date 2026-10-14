import React, { useId } from 'react';
import { X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';

interface ModalProps {
  title: React.ReactNode;
  eyebrow?: string;
  closeLabel: string;
  onClose: () => void;
  /** sm = confirm (420px), md = settings (560px), lg = inspector/preview (1020px), full = crop editor */
  width?: 'sm' | 'md' | 'lg' | 'full';
  headerActions?: React.ReactNode;
  footer?: React.ReactNode;
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
}

export function Modal({
  title,
  eyebrow,
  closeLabel,
  onClose,
  width = 'md',
  headerActions,
  footer,
  bodyClassName,
  className,
  children,
}: ModalProps) {
  const ref = useDialog(onClose);
  const titleId = useId();
  const widthClass = width === 'md' ? '' : width;
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className={`modal-panel ${widthClass} ${className ?? ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div className="modal-heading">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <div className="modal-header-actions">
            {headerActions}
            <button className="icon-button" aria-label={closeLabel} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className={`modal-body ${bodyClassName ?? ''}`.trim()}>{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
