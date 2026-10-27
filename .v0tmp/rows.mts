import { buildInkMap, segmentSample } from '../src/lib/handwriting/sampleFont';
const W = 260, H = 420;
const rects: number[][] = [[150, 4, 3, 8]];
for (const x of [20, 70, 120]) rects.push([x, 40, 30, 120]);
for (const x of [20, 70, 120]) rects.push([x, 200, 30, 50]);
for (const x of [20, 60]) rects.push([x, 290, 20, 30]);
rects.push([20, 360, 6, 30], [20, 394, 6, 6], [60, 370, 14, 30]);
const data = new Uint8ClampedArray(W * H * 4).fill(255);
for (const [rx, ry, rw, rh] of rects) for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) { const o = (y * W + x) * 4; data[o] = data[o + 1] = data[o + 2] = 20; }
const ink = buildInkMap({ width: W, height: H, data, colorSpace: 'srgb' } as ImageData);
console.log(ink.components.length, JSON.stringify(ink.components.map((c) => [c.x0, c.y0, c.area])));
const seg = segmentSample(ink, 'abc\nDEF\n12\n!?');
console.log(JSON.stringify(seg.error), JSON.stringify(seg.rows.map((r) => [r.text, r.pieces.map((p) => `${p.x0},${p.y0}-${p.y1}`)])));
