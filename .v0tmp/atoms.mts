import sharp from 'sharp';
import { buildInkMap, clusterRow } from '../src/lib/handwriting/sampleFont.ts';
const { data, info } = await sharp(process.argv[2]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const ink = buildInkMap({ width: info.width, height: info.height, data: new Uint8ClampedArray(data) } as ImageData);
const [x0, x1, y0, y1] = process.argv[3].split(',').map(Number);
ink.components.forEach((c, i) => { if (c.area >= 3 && c.x1 >= x0 && c.x0 <= x1 && c.y1 >= y0 && c.y0 <= y1) console.log(i + 1, c); });
