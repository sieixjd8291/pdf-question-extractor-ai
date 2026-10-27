import sharp from 'sharp';
const img = sharp('/tmp/hw/real/shot.png');
const m = await img.metadata(); console.log(m.width, m.height);
const { data, info } = await sharp('/tmp/hw/real/shot.png').extract({ left: 832, top: 172, width: 616, height: 336 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < data.length; i += 3) {
  const r = data[i], g = data[i+1], b = data[i+2];
  if (Math.max(r,g,b) - Math.min(r,g,b) > 40) { data[i]=data[i+1]=data[i+2]=255; }
}
await sharp(data, { raw: info }).resize({ width: 616*3 }).png().toFile('/tmp/hw/real/clean.png');
