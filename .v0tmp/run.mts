import sharp from 'sharp';
import { buildInkMap, segmentSample, rowMatched } from '../src/lib/handwriting/sampleFont.ts';
const file = process.argv[2] ?? '/tmp/hw/crop.png';
const scale = Number(process.argv[3] ?? 1);
const text = process.env.TEXT ?? `ABCDEFGHIJKLMNOPQRSTUVWXYZ
abcdefghijklmnopqrstuvwxyz

0123456789

. , ! ? : ; … - · – — ( ) [ ] " ' ‘ ’ , “ ” „ ‹ › « » ¡ ¿ • ″ ′`;
const meta = await sharp(file).metadata();
const w = Math.round(meta.width! * scale), h = Math.round(meta.height! * scale);
const { data } = await sharp(file).resize(w, h).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const ink = buildInkMap({ width: w, height: h, data: new Uint8ClampedArray(data), colorSpace: 'srgb' } as ImageData);
const seg = segmentSample(ink, text);
if (seg.error) console.log('ERROR', seg.error);
for (const r of seg.rows) {
  console.log(rowMatched(r) ? 'OK ' : 'BAD', `${r.pieces.length}/${r.letters.length}`, r.text);
  console.log('    ', r.pieces.map((p, i) => `${r.letters[i] ?? '?'}@${p.x0}-${p.x1}`).join(' '));
}
