import sharp from 'sharp';
import { buildInkMap } from '../src/lib/handwriting/sampleFont.ts';
const file = process.argv[2];
const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const ink = buildInkMap({ width: info.width, height: info.height, data: new Uint8ClampedArray(data) } as ImageData);
const out = Buffer.alloc(info.width * info.height);
for (let i = 0; i < out.length; i++) out[i] = ink.labels[i] ? 0 : 255;
await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toFile(process.argv[3]);
console.log(ink.components.length, 'components');
