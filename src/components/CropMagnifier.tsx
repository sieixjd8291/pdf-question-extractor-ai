import { useLayoutEffect, useRef } from 'react';
import type { Point } from '../lib/edgeDetector';

export function CropMagnifier({ image, point, rotation }: {
  image: HTMLImageElement; point: Point; rotation: 0 | 90 | 180 | 270;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { naturalWidth: w, naturalHeight: h } = image;
    const raw = rotation === 90 ? { x: point.y, y: 1 - point.x }
      : rotation === 180 ? { x: 1 - point.x, y: 1 - point.y }
      : rotation === 270 ? { x: 1 - point.y, y: point.x } : point;
    const patch = Math.max(40, Math.min(100, Math.min(w, h) / 24));
    ctx.resetTransform();
    ctx.fillStyle = '#34343b';
    ctx.fillRect(0, 0, 256, 256);
    ctx.translate(128, 128);
    ctx.scale(256 / patch, 256 / patch);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(image, -raw.x * w, -raw.y * h);
  }, [image, point.x, point.y, rotation]);
  return (
    <div className={`scanner-crop-magnifier ${point.x > .5 ? 'at-left' : 'at-right'} ${point.y > .5 ? 'at-top' : 'at-bottom'}`}
      role="img" aria-label="Magnified original page boundary; crosshair marks the selected corner">
      <canvas ref={canvasRef} width={256} height={256} aria-hidden="true" />
      <span className="scanner-magnifier-crosshair" aria-hidden="true" />
      <span className="scanner-magnifier-label">Precision view</span>
    </div>
  );
}
