import React, { useState, useRef, useEffect } from 'react';
import {
  Save,
  Trash2,
  Sliders,
  ChevronLeft,
  ChevronRight,
  SquareDashedMousePointer,
  X,
  Compass,
  RotateCcw,
  RotateCw,
  Loader2,
} from 'lucide-react';
import { QuestionDetection, PageData } from '../types';
import { cropQuestionFromCanvas } from '../lib/cropper';
import {
  detectDocumentOrientation,
} from '../lib/orientationDetector';
import { useToast } from './Toast';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';

interface BoundingBoxEditorProps {
  question: QuestionDetection | null;
  pages: PageData[];
  pageIndex: number;
  onClose: () => void;
  onUpdateQuestion: (updatedQuestion: QuestionDetection) => void;
  onDeleteQuestion: (questionId: string) => void;
  onAddQuestion: (pageIndex: number, box2D: [number, number, number, number]) => void;
  onUpdatePage?: (pageIndex: number, updatedPage: PageData) => void;
}

const RANGES: { index: number; label: string }[] = [
  { index: 0, label: 'Top (Y-min)' },
  { index: 2, label: 'Bottom (Y-max)' },
  { index: 1, label: 'Left (X-min)' },
  { index: 3, label: 'Right (X-max)' },
];

function rotateBox2D(
  box: [number, number, number, number],
  delta: 90 | 180 | 270
): [number, number, number, number] {
  const [ymin, xmin, ymax, xmax] = box;
  if (delta === 90) {
    // 90° clockwise: (x, y) -> (1000 - y, x)
    return [xmin, 1000 - ymax, xmax, 1000 - ymin];
  } else if (delta === 180) {
    // 180°: (x, y) -> (1000 - x, 1000 - y)
    return [1000 - ymax, 1000 - xmax, 1000 - ymin, 1000 - xmin];
  } else if (delta === 270) {
    // 270° clockwise (90° CCW): (x, y) -> (y, 1000 - x)
    return [1000 - xmax, ymin, 1000 - xmin, ymax];
  }
  return box;
}

export const BoundingBoxEditor: React.FC<BoundingBoxEditorProps> = ({
  question,
  pages,
  pageIndex,
  onClose,
  onUpdateQuestion,
  onDeleteQuestion,
  onAddQuestion,
  onUpdatePage,
}) => {
  const toast = useToast();
  const [currentPageIdx, setCurrentPageIdx] = useState(pageIndex);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(question ? question.id : null);
  const [box2D, setBox2D] = useState<[number, number, number, number]>(
    question ? question.box2D : [100, 100, 400, 900]
  );
  const [isDrawingNew, setIsDrawingNew] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [isDraggingBox, setIsDraggingBox] = useState(false);
  const [previewCrop, setPreviewCrop] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isAnalyzingOrientation, setIsAnalyzingOrientation] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragOriginRef = useRef<{ x: number; y: number; box: [number, number, number, number] } | null>(null);

  const activePage = pages[currentPageIdx] || pages[0];
  const pageQuestions = activePage?.questions || [];

  /**
   * Fast in-place page image and bounding box rotation.
   * Transposes the image and converts box coordinates instantly.
   */
  const rotatePageImage = (delta: 90 | 180 | 270) => {
    if (!activePage?.canvasDataUrl) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const nextCanvas = document.createElement('canvas');
      const swapDims = delta === 90 || delta === 270;
      nextCanvas.width = swapDims ? img.height : img.width;
      nextCanvas.height = swapDims ? img.width : img.height;

      const ctx = nextCanvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      ctx.translate(nextCanvas.width / 2, nextCanvas.height / 2);
      ctx.rotate((delta * Math.PI) / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      const newCanvasDataUrl = nextCanvas.toDataURL('image/jpeg', 0.92);

      // Rotate currently edited active box
      const nextActiveBox = rotateBox2D(box2D, delta);
      setBox2D(nextActiveBox);

      // Rotate all questions on this page
      const nextQuestions = pageQuestions.map((q) => {
        const nextQBox = rotateBox2D(q.box2D, delta);
        const cropRes = cropQuestionFromCanvas(nextCanvas, nextQBox);
        return {
          ...q,
          box2D: nextQBox,
          pngDataUrl: cropRes.pngDataUrl,
          jpgDataUrl: cropRes.jpgDataUrl,
          pdfDataUrl: cropRes.pdfDataUrl,
          pdfBlob: cropRes.pdfBlob,
          cropWidth: cropRes.width,
          cropHeight: cropRes.height,
        };
      });

      const updatedPage: PageData = {
        ...activePage,
        canvasDataUrl: newCanvasDataUrl,
        width: nextCanvas.width,
        height: nextCanvas.height,
        questions: nextQuestions,
      };

      if (onUpdatePage) {
        onUpdatePage(currentPageIdx, updatedPage);
      } else {
        activePage.canvasDataUrl = newCanvasDataUrl;
        activePage.width = nextCanvas.width;
        activePage.height = nextCanvas.height;
        activePage.questions = nextQuestions;
      }

      // Update live crop preview
      const cropRes = cropQuestionFromCanvas(nextCanvas, nextActiveBox);
      setPreviewCrop(cropRes.pngDataUrl);
    };
    img.src = activePage.canvasDataUrl;
  };

  /**
   * Fast, non-blocking auto-orientation analysis of the current page.
   * Leverages multi-feature visual layout analysis and AI orientation detection
   * to calculate rotation in 90-degree increments and apply it instantly to the current view.
   */
  const handleAutoCorrectOrientation = async () => {
    if (!activePage?.canvasDataUrl || isAnalyzingOrientation) return;
    setIsAnalyzingOrientation(true);

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load image for orientation analysis'));
        img.src = activePage.canvasDataUrl;
      });

      // Execute orientation detector (AI with automatic local CV fallback)
      const res = await detectDocumentOrientation(img, 0);

      if (res.needsRotation && res.rotationDelta !== 0) {
        rotatePageImage(res.rotationDelta);
        toast.success(res.reason || `Orientation corrected: rotated ${res.rotationDelta}° upright.`);
      } else {
        toast.success(res.reason || 'Document is already in upright orientation.');
      }
    } catch (err: any) {
      console.error('Orientation detection failed:', err);
      toast.error('Could not analyze document orientation.');
    } finally {
      setIsAnalyzingOrientation(false);
    }
  };

  // Sync selected question when changed
  useEffect(() => {
    if (selectedQuestionId) {
      const q = pageQuestions.find((item) => item.id === selectedQuestionId);
      if (q) {
        setBox2D(q.box2D);
      }
    }
  }, [selectedQuestionId, currentPageIdx, pageQuestions]);

  // Update live preview crop when box2D changes
  useEffect(() => {
    if (!activePage?.canvasDataUrl) return;

    // Create temporary canvas from image data URL to test crop
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = img.width;
      tempCanvas.height = img.height;
      const ctx = tempCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const result = cropQuestionFromCanvas(tempCanvas, box2D);
        setPreviewCrop(result.pngDataUrl);
      }
    };
    img.src = activePage.canvasDataUrl;
  }, [box2D, activePage]);

  const handleSliderChange = (index: number, val: number) => {
    const next = [...box2D] as [number, number, number, number];
    next[index] = Math.max(0, Math.min(1000, val));
    // Ensure ymin < ymax and xmin < xmax
    if (index === 0 && next[0] >= next[2]) next[0] = next[2] - 10;
    if (index === 1 && next[1] >= next[3]) next[1] = next[3] - 10;
    if (index === 2 && next[2] <= next[0]) next[2] = next[0] + 10;
    if (index === 3 && next[3] <= next[1]) next[3] = next[1] + 10;
    setBox2D(next);
  };

  const handleSave = () => {
    if (!selectedQuestionId) return;
    const currentQ = pageQuestions.find((q) => q.id === selectedQuestionId);
    if (!currentQ) return;

    // Render new crop
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = img.width;
      tempCanvas.height = img.height;
      const ctx = tempCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const cropRes = cropQuestionFromCanvas(tempCanvas, box2D);
        onUpdateQuestion({
          ...currentQ,
          box2D,
          pngDataUrl: cropRes.pngDataUrl,
          jpgDataUrl: cropRes.jpgDataUrl,
          pdfDataUrl: cropRes.pdfDataUrl,
          pdfBlob: cropRes.pdfBlob,
          cropWidth: cropRes.width,
          cropHeight: cropRes.height,
        });
        onClose();
      }
    };
    img.src = activePage.canvasDataUrl;
  };

  // Convert a pointer position into the page's normalized 0-1000 box coordinate space
  const pointerToBoxCoords = (clientX: number, clientY: number) => {
    const rect = imageRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1000, ((clientX - rect.left) / rect.width) * 1000)),
      y: Math.max(0, Math.min(1000, ((clientY - rect.top) / rect.height) * 1000)),
    };
  };

  const shiftBoxBy = (
    box: [number, number, number, number],
    dx: number,
    dy: number
  ): [number, number, number, number] => {
    const [ymin, xmin, ymax, xmax] = box;
    const w = xmax - xmin;
    const h = ymax - ymin;
    const nxmin = Math.max(0, Math.min(1000 - w, xmin + dx));
    const nymin = Math.max(0, Math.min(1000 - h, ymin + dy));
    return [Math.round(nymin), Math.round(nxmin), Math.round(nymin + h), Math.round(nxmin + w)];
  };

  // Pointer Events cover mouse, touch, and pen — required so box drawing works on mobile
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawingNew || !imageRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointerToBoxCoords(e.clientX, e.clientY);
    setDrawStart(p);
    setBox2D([Math.round(p.y), Math.round(p.x), Math.round(p.y), Math.round(p.x)]);
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawingNew || !drawStart || !imageRef.current) return;
    const current = pointerToBoxCoords(e.clientX, e.clientY);

    const ymin = Math.round(Math.min(drawStart.y, current.y));
    const xmin = Math.round(Math.min(drawStart.x, current.x));
    const ymax = Math.round(Math.max(drawStart.y, current.y));
    const xmax = Math.round(Math.max(drawStart.x, current.x));

    setBox2D([ymin, xmin, ymax, xmax]);
  };

  const handleCanvasPointerUp = () => {
    if (!isDrawingNew || !drawStart) return;
    setIsDrawingNew(false);
    setDrawStart(null);
    // Ignore taps / accidental micro-drags so a degenerate box is never added
    if (box2D[2] - box2D[0] > 8 && box2D[3] - box2D[1] > 8) {
      onAddQuestion(currentPageIdx, box2D);
    }
  };

  // Drag an existing box to reposition it (touch-friendly alternative to sliders)
  const handleBoxPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    box: [number, number, number, number]
  ) => {
    if (isDrawingNew || !imageRef.current) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = pointerToBoxCoords(e.clientX, e.clientY);
    dragOriginRef.current = { x: p.x, y: p.y, box };
    setIsDraggingBox(true);
  };

  const handleBoxPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!isDraggingBox || !origin || !imageRef.current) return;
    const p = pointerToBoxCoords(e.clientX, e.clientY);
    setBox2D(shiftBoxBy(origin.box, p.x - origin.x, p.y - origin.y));
  };

  const handleBoxPointerUp = () => {
    if (!isDraggingBox) return;
    setIsDraggingBox(false);
    dragOriginRef.current = null;
  };

  return (
    <>
      <Modal
        title="Adjust crop"
        eyebrow="BOUNDING BOX EDITOR"
        closeLabel="Close crop editor"
        onClose={onClose}
        width="full"
        className="bounding-box-editor"
        bodyClassName="editor-body"
        headerActions={
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              className="btn quiet btn-sm"
              onClick={() => rotatePageImage(270)}
              title="Rotate 90° counter-clockwise"
              aria-label="Rotate counter-clockwise"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              className="btn quiet btn-sm"
              onClick={() => rotatePageImage(90)}
              title="Rotate 90° clockwise"
              aria-label="Rotate clockwise"
            >
              <RotateCw size={14} />
            </button>
            <button
              type="button"
              className="btn primary btn-sm font-semibold auto-orient-btn-prominent shadow-sm"
              onClick={handleAutoCorrectOrientation}
              disabled={isAnalyzingOrientation}
              title="Auto-Correct Orientation: Grayscale histogram and entropy analysis in 90° increments"
              aria-label="Auto-Correct Orientation"
            >
              {isAnalyzingOrientation ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Compass size={13} />
              )}
              <span>Auto-Correct Orientation</span>
            </button>
            <div className="w-[1px] h-4 bg-line mx-1 hide-sm" />
            <button
              onClick={() => setCurrentPageIdx(Math.max(0, currentPageIdx - 1))}
              disabled={currentPageIdx === 0}
              className="icon-button bordered"
              aria-label="Previous page"
              title="Previous page"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="chip">{currentPageIdx + 1} / {pages.length}</span>
            <button
              onClick={() => setCurrentPageIdx(Math.min(pages.length - 1, currentPageIdx + 1))}
              disabled={currentPageIdx >= pages.length - 1}
              className="icon-button bordered"
              aria-label="Next page"
              title="Next page"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        }
        footer={<>
          <span className="editor-footer-hint">
            {isDrawingNew
              ? 'Drag on the page to draw the new box…'
              : isDraggingBox
              ? 'Release to drop the box in place…'
              : 'Tap a box to edit or drag it, or draw a new one.'}
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              className="btn primary auto-orient-btn-prominent"
              onClick={handleAutoCorrectOrientation}
              disabled={isAnalyzingOrientation}
              title="Detect orientation and rotate page upright automatically"
            >
              {isAnalyzingOrientation ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Compass size={14} />
              )}
              <span>Auto-Orient</span>
            </button>
            <button
              type="button"
              className="icon-button bordered"
              onClick={() => rotatePageImage(270)}
              disabled={isAnalyzingOrientation}
              title="Rotate 90° counter-clockwise"
              aria-label="Rotate 90 degrees counter-clockwise"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              className="icon-button bordered"
              onClick={() => rotatePageImage(90)}
              disabled={isAnalyzingOrientation}
              title="Rotate 90° clockwise"
              aria-label="Rotate 90 degrees clockwise"
            >
              <RotateCw size={14} />
            </button>
            <button
              className={`btn ${isDrawingNew ? 'danger' : 'bordered'}`}
              onClick={() => {
                setIsDrawingNew((v) => !v);
                setDrawStart(null);
              }}
            >
              {isDrawingNew ? <X size={14} /> : <SquareDashedMousePointer size={14} />}
              {isDrawingNew ? 'Cancel draw' : 'Draw new box'}
            </button>
            {selectedQuestionId && (
              <button className="btn danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} />
                <span className="hide-sm">Delete box</span>
              </button>
            )}
            <button className="btn primary" onClick={handleSave} disabled={!selectedQuestionId}>
              <Save size={14} />
              <span className="hide-sm">Save & apply crop</span>
              <span className="show-sm">Save</span>
            </button>
          </div>
        </>}
      >
        {/* Left: Full Page with Box Overlays */}
        <div
          ref={containerRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerUp}
          className={`editor-canvas select-none ${isDrawingNew ? 'drawing' : ''}`}
        >
          <div className="page-frame">
            <img
              ref={imageRef}
              src={activePage?.canvasDataUrl}
              alt={`Page ${currentPageIdx + 1}`}
              className="pointer-events-none"
            />

            {/* Render all boxes for current page */}
            {pageQuestions.map((q) => {
              const isSelected = q.id === selectedQuestionId;
              const [ymin, xmin, ymax, xmax] = isSelected ? box2D : q.box2D;

              return (
                <div
                  key={q.id}
                  onPointerDown={(e) => {
                    handleBoxPointerDown(e, q.box2D);
                    setSelectedQuestionId(q.id);
                    setBox2D(q.box2D);
                  }}
                  onPointerMove={handleBoxPointerMove}
                  onPointerUp={handleBoxPointerUp}
                  onPointerCancel={handleBoxPointerUp}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedQuestionId(q.id);
                    setBox2D(q.box2D);
                  }}
                  style={{
                    top: `${ymin / 10}%`,
                    left: `${xmin / 10}%`,
                    height: `${(ymax - ymin) / 10}%`,
                    width: `${(xmax - xmin) / 10}%`,
                  }}
                  className={`q-box absolute cursor-pointer transition-all duration-150 border-2 ${
                    isSelected
                      ? 'border-accent bg-accent-soft z-20'
                      : 'border-positive bg-positive/10 hover:bg-positive/20 z-10'
                  }`}
                >
                  <span
                    className="box-label"
                    style={
                      isSelected
                        ? { background: 'var(--accent-solid)', color: '#fff' }
                        : { background: 'var(--surface)', color: 'var(--positive)', border: '1px solid var(--positive-soft)' }
                    }
                  >
                    {q.questionNumberRaw || `Q${q.questionIndex}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Live Cropped Preview & Precision Sliders */}
        <aside className="editor-rail">
          <div className="space-y-2">
            <div className="rail-block-heading">
              <span>Live cropped preview</span>
              <span className="chip">{box2D[3] - box2D[1]} × {box2D[2] - box2D[0]}</span>
            </div>
            <div className="crop-preview">
              {previewCrop ? (
                <img src={previewCrop} alt="Live crop preview" />
              ) : (
                <span className="text-[12.5px] text-secondary">Generating crop…</span>
              )}
            </div>
          </div>

          {/* Document Orientation & Auto-Correct */}
          <div className="space-y-2">
            <div className="rail-block-heading">
              <Compass size={13} />
              <span>Page orientation</span>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn quiet btn-sm flex-1 justify-center py-1.5"
                  onClick={() => rotatePageImage(270)}
                  title="Rotate 90° counter-clockwise"
                  aria-label="Rotate counter-clockwise"
                >
                  <RotateCcw size={16} />
                </button>
                <button
                  type="button"
                  className="btn quiet btn-sm flex-1 justify-center py-1.5"
                  onClick={() => rotatePageImage(90)}
                  title="Rotate 90° clockwise"
                  aria-label="Rotate clockwise"
                >
                  <RotateCw size={16} />
                </button>
              </div>
              <button
                type="button"
                className="btn primary w-full justify-center auto-orient-btn-prominent font-semibold py-2 shadow-sm"
                onClick={handleAutoCorrectOrientation}
                disabled={isAnalyzingOrientation}
                title="Automatically analyze grayscale histogram & entropy to calculate 90° rotation and snap upright"
                aria-label="Auto-Correct Orientation"
              >
                {isAnalyzingOrientation ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Compass size={14} />
                )}
                <span>Auto-Correct Orientation</span>
              </button>
            </div>
          </div>

          {/* Coordinate Adjuster Sliders */}
          <div className="space-y-3">
            <div className="rail-block-heading">
              <Sliders size={13} />
              <span>Boundaries (0–1000)</span>
            </div>

            {RANGES.map(({ index, label }) => (
              <div className="range-row" key={index}>
                <div className="range-values">
                  <span>{label}: {box2D[index]}</span>
                  <span>{(box2D[index] / 10).toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1000"
                  value={box2D[index]}
                  onChange={(e) => handleSliderChange(index, parseInt(e.target.value))}
                  aria-label={label}
                />
              </div>
            ))}
          </div>
        </aside>
      </Modal>

      {confirmDelete && selectedQuestionId && (
        <ConfirmDialog
          title="Delete this question block?"
          message="The crop and its exports will be removed from your results."
          confirmLabel="Delete box"
          danger
          onConfirm={() => {
            onDeleteQuestion(selectedQuestionId);
            onClose();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
};
