import { Download } from 'lucide-react';
import { QuestionDetection } from '../types';
import { downloadSingleQuestion } from '../lib/cropper';
import { Modal } from './Modal';

interface Props {
  question: QuestionDetection;
  format: 'png' | 'jpg' | 'pdf';
  onClose: () => void;
}

export function FullscreenModal({ question, format, onClose }: Props) {
  const preview = question.pngDataUrl || question.jpgDataUrl;
  return (
    <Modal
      eyebrow={`PAGE ${question.pageNumber}`}
      title={question.questionNumberRaw || `Question ${question.questionIndex}`}
      closeLabel="Close preview"
      onClose={onClose}
      width="lg"
      bodyClassName="preview-canvas"
      headerActions={
        <button className="btn primary btn-sm" onClick={() => downloadSingleQuestion(question, format)}>
          <Download size={15} />{format.toUpperCase()}
        </button>
      }
      footer={<>
        <span>{question.cropWidth} × {question.cropHeight} pixels</span>
        <span>Review the crop before exporting</span>
      </>}
    >
      {preview
        ? <img src={preview} alt={`Question ${question.questionIndex}`} />
        : <p>Preview unavailable</p>}
    </Modal>
  );
}
