import { useId, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Modal } from '../Modal';

export function RenameAssignment({ name, disabled, onRename }: { name: string; disabled: boolean; onRename: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  const formId = useId();
  const valid = /[\w]/.test(draft);
  return (
    <>
      <span className="am-actionbar-icons">
        <button type="button" className="icon-button" aria-label="Rename assignment" title="Rename assignment" disabled={disabled}
          onClick={() => { setDraft(name); setOpen(true); }}>
          <Pencil size={16} />
        </button>
      </span>
      {open && (
        <Modal title="Rename assignment" closeLabel="Close rename" width="sm" onClose={() => setOpen(false)}
          footer={<>
            <button type="button" className="btn secondary btn-sm" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" form={formId} className="btn btn-sm" disabled={!valid}>Save</button>
          </>}>
          <form id={formId} onSubmit={(e) => { e.preventDefault(); if (!valid) return; onRename(draft.trim()); setOpen(false); }}>
            <label htmlFor={`${formId}-name`}>File name</label>
            <input id={`${formId}-name`} autoFocus maxLength={120} value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault(); }} />
          </form>
        </Modal>
      )}
    </>
  );
}
