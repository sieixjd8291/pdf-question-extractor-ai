import { buildInkMap, segmentSample } from '../src/lib/handwriting/sampleFont';
const W = 140, H = 100;
const data = new Uint8ClampedArray(W * H * 4).fill(255);
for (const [rx, ry, rw, rh] of [[10, 40, 60, 40], [70, 76, 10, 3], [80, 40, 14, 40], [94, 76, 10, 3], [104, 20, 14, 60]]) for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) { const o = (y * W + x) * 4; data[o] = data[o + 1] = data[o + 2] = 20; }
const ink = buildInkMap({ width: W, height: H, data, colorSpace: 'srgb' } as ImageData);
console.log(JSON.stringify(ink.components));
const seg = segmentSample(ink, 'mil');
console.log(JSON.stringify(seg.error), seg.rows.map((r) => r.text + ' ' + r.pieces.map((p) => `${p.x0}-${p.x1}`).join(',')));
