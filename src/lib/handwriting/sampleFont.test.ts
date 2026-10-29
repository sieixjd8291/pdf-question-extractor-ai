import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInkMap, detectGlyphTemplate, rowMatched, segmentSample, segmentFromBoxes, segmentWithAi, type Piece } from './sampleFont';

type Rect = [x: number, y: number, w: number, h: number];

function image(width: number, height: number, rects: Rect[]) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [rx, ry, rw, rh] of rects) {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const o = (y * width + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = 20;
      }
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
}

const letterBox = (x: number, w = 30): Rect[] => [[x, 40, w, 40]];
const center = (p: Piece) => (p.x0 + p.x1) / 2;

test('an i dot that drifts off the stem stays part of the i', () => {
  // "io": the dot sits left of the stem with no horizontal overlap.
  const rects: Rect[] = [[20, 22, 6, 6], [30, 40, 8, 40], ...letterBox(50)];
  const seg = segmentSample(buildInkMap(image(120, 100, rects)), 'io');
  const [row] = seg.rows;
  assert.ok(rowMatched(row));
  assert.ok(row.pieces[0].x0 <= 20 && row.pieces[0].x1 >= 37, 'dot and stem form one piece');
});

test('apostrophes stay separate when the text contains one', () => {
  const rects: Rect[] = [...letterBox(10), [48, 25, 5, 10], ...letterBox(60)];
  const seg = segmentSample(buildInkMap(image(120, 100, rects)), "n't");
  assert.equal(seg.rows[0].pieces.length, 3);
});

test('joined letters are cut where narrow and wide letters end', () => {
  // "mil" written as one connected stroke: wide m, narrow i, narrow l, joined by a thin baseline.
  const rects: Rect[] = [[10, 40, 60, 40], [70, 76, 10, 3], [80, 40, 14, 40], [94, 76, 10, 3], [104, 20, 14, 60]];
  const seg = segmentSample(buildInkMap(image(140, 100, rects)), 'mil');
  const [row] = seg.rows;
  assert.ok(rowMatched(row));
  assert.ok(Math.abs(center(row.pieces[0]) - 40) < 8, 'm keeps its full width');
  assert.ok(center(row.pieces[1]) > 75 && center(row.pieces[1]) < 95, 'i is the middle stroke');
});

test('word gaps decide which pieces belong to which word', () => {
  const rects: Rect[] = [...letterBox(10), ...letterBox(45), ...letterBox(130), ...letterBox(165), ...letterBox(200)];
  const seg = segmentSample(buildInkMap(image(260, 100, rects)), 'ab cde');
  const [row] = seg.rows;
  assert.ok(rowMatched(row));
  assert.ok(center(row.pieces[2]) > 130, 'c starts the second word');
});

test('a sentence typed on one line is spread across wrapped writing', () => {
  // Two rows of writing: "ab cd" on top, "efg" below, typed as one line.
  const rects: Rect[] = [...letterBox(10), ...letterBox(45), ...letterBox(130), ...letterBox(165)];
  for (const x of [10, 45, 80]) rects.push([x, 140, 30, 40]);
  const seg = segmentSample(buildInkMap(image(260, 200, rects)), 'ab cd efg');
  assert.deepEqual(seg.rows.map((r) => r.text), ['ab cd', 'efg']);
  assert.ok(seg.rows.every(rowMatched));
});

test('dots floating above a line do not count as their own line', () => {
  // "ii" with dots well clear of the stems, typed as a single line.
  const rects: Rect[] = [[12, 10, 6, 6], [10, 40, 8, 40], [42, 10, 6, 6], [40, 40, 8, 40]];
  const seg = segmentSample(buildInkMap(image(100, 100, rects)), 'ii');
  assert.equal(seg.rows.length, 1);
  assert.ok(rowMatched(seg.rows[0]));
});

test('mismatched line counts produce a helpful error', () => {
  const seg = segmentSample(buildInkMap(image(120, 100, letterBox(10))), 'a\nb');
  assert.match(seg.error ?? '', /line/);
});

test('a single word that wraps over rows is split between them (alphabet case)', () => {
  // "ABCDE" written as "ABC" / "DE", then "fg" on its own row; typed as two lines.
  const rects: Rect[] = [];
  for (const x of [10, 50, 90]) rects.push([x, 20, 30, 40]);
  for (const x of [10, 50]) rects.push([x, 100, 30, 40]);
  for (const x of [10, 50]) rects.push([x, 180, 30, 40]);
  const seg = segmentSample(buildInkMap(image(200, 240, rects)), 'ABCDE\nfg');
  assert.equal(seg.error, undefined);
  assert.deepEqual(seg.rows.map((r) => r.text), ['ABC', 'DE', 'fg']);
  assert.ok(seg.rows.every(rowMatched));
});

test('red spell-check squiggles under dark ink are ignored', () => {
  const img = image(200, 100, [...letterBox(10), ...letterBox(60), ...letterBox(110)]);
  // A red line touching the bottom of every letter would glue them into one blob.
  for (let y = 78; y < 84; y++) {
    for (let x = 5; x < 150; x++) {
      const o = (y * 200 + x) * 4;
      img.data[o] = 230; img.data[o + 1] = 30; img.data[o + 2] = 30;
    }
  }
  const seg = segmentSample(buildInkMap(img), 'abc');
  assert.ok(rowMatched(seg.rows[0]));
  assert.ok(seg.rows[0].pieces.every((p) => p.x1 - p.x0 < 40), 'letters stay separate');
});

test('AI glyph boxes split touching letters and skip ruled lines', () => {
  // "ab" written as one joined stroke (x 10..89), plus "c" apart, plus a ruled line.
  const ink = buildInkMap(image(200, 100, [[10, 20, 80, 40], [120, 20, 30, 40], [0, 90, 200, 2]]));
  const seg = segmentFromBoxes(ink, [{ text: 'abc', chars: [
    { c: 'a', box: [0.05, 0.2, 0.25, 0.6] },
    { c: 'b', box: [0.25, 0.2, 0.45, 0.6] },
    { c: 'c', box: [0.6, 0.2, 0.75, 0.6] },
  ] }]);
  assert.equal(seg.error, undefined);
  assert.deepEqual(seg.rows[0].letters, ['a', 'b', 'c']);
  assert.ok(rowMatched(seg.rows[0]));
  assert.ok(seg.rows[0].pieces[0].x1 < 55 && seg.rows[0].pieces[1].x0 >= 45, 'joined stroke is sliced between a and b');
  assert.ok(seg.rows[0].pieces.every((p) => p.y1 < 85), 'ruled line ignored');
});

test('segmentWithAi falls back to glyph boxes when text segmentation cannot line up', () => {
  const ink = buildInkMap(image(200, 100, [[10, 20, 80, 40], [120, 20, 30, 40]]));
  const seg = segmentWithAi(ink, [{ text: 'abc', chars: [
    { c: 'a', box: [0.05, 0.2, 0.25, 0.6] },
    { c: 'b', box: [0.25, 0.2, 0.45, 0.6] },
    { c: 'c', box: [0.6, 0.2, 0.75, 0.6] },
  ] }]);
  assert.ok(seg.rows.every(rowMatched));
  assert.equal(seg.rows[0].letters.join(''), 'abc');
});

test('AI boxes keep sentence word spacing and skip unsure glyphs', () => {
  const ink = buildInkMap(image(300, 100, [[10, 20, 30, 40], [50, 20, 30, 40], [150, 20, 30, 40], [190, 20, 30, 40]]));
  const seg = segmentFromBoxes(ink, [{ text: 'hi yo', chars: [
    { c: 'h', box: [0.03, 0.2, 0.14, 0.6] },
    { c: 'i', box: [0.16, 0.2, 0.27, 0.6] },
    { c: 'y', box: [0.49, 0.2, 0.6, 0.6], sure: false },
    { c: 'o', box: [0.63, 0.2, 0.74, 0.6] },
  ] }]);
  assert.equal(seg.rows[0].text, 'hi o');
  assert.deepEqual(seg.rows[0].letters, ['h', 'i', 'o']);
  assert.ok(rowMatched(seg.rows[0]));
});

test('wrapped alphabet row does not steal letters from the next typed line', () => {
  const rects: Rect[] = [];
  for (let i = 0; i < 24; i++) rects.push([10 + i * 40, 20, 28, 40]);
  for (let i = 0; i < 2; i++) rects.push([10 + i * 40, 100, 28, 40]);
  for (let i = 0; i < 26; i++) rects.push([10 + i * 37, 180, 26, 40]);
  for (let i = 0; i < 10; i++) rects.push([10 + i * 40, 260, 28, 40]);
  const seg = segmentSample(buildInkMap(image(1000, 320, rects)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789');
  assert.equal(seg.error, undefined);
  assert.deepEqual(seg.rows.map((r) => r.text), ['ABCDEFGHIJKLMNOPQRSTUVWX', 'YZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789']);
  assert.ok(seg.rows.every(rowMatched));
});

test('rows joined by a touching descender are still split into two lines', () => {
  const rects: Rect[] = [];
  for (let i = 0; i < 8; i++) rects.push([10 + i * 40, 20, 28, 30]);
  for (let i = 0; i < 8; i++) rects.push([10 + i * 40, 75, 28, 30]);
  rects.push([130, 20, 4, 60]); // descender from row 1 running into row 2
  const seg = segmentSample(buildInkMap(image(360, 120, rects)), 'abcdefgh\nijklmnop');
  assert.equal(seg.error, undefined);
  assert.equal(seg.rows.length, 2);
});

test('a row of capitals with dense top and bottom bars stays one line', () => {
  const rects: Rect[] = [];
  for (let i = 0; i < 6; i++) {
    const x = 10 + i * 40;
    rects.push([x, 20, 28, 5], [x, 40, 20, 4], [x, 55, 28, 5], [x, 20, 5, 40]);
  }
  const seg = segmentSample(buildInkMap(image(260, 80, rects)), 'EEEEEE');
  assert.equal(seg.error, undefined);
  assert.equal(seg.rows.length, 1);
  assert.ok(rowMatched(seg.rows[0]));
});

test('short rows of digits and capitals are not folded into a tall lowercase row', () => {
  // A tall lowercase line, a stray pen tick above it, then capitals, digits and punctuation.
  // "abc" with tall b/h-like strokes and a short c far below the tick.
  const rects: Rect[] = [[130, 2, 3, 6], [20, 40, 30, 120], [70, 40, 30, 120], [120, 120, 30, 40]];
  for (const x of [20, 70, 120]) rects.push([x, 200, 30, 50]);
  for (const x of [20, 60]) rects.push([x, 290, 20, 30]);
  rects.push([20, 360, 6, 30], [20, 394, 6, 6], [60, 370, 14, 30]);
  const seg = segmentSample(buildInkMap(image(260, 420, rects)), 'abc\nDEF\n12\n!?');
  assert.equal(seg.error, undefined);
  assert.deepEqual(seg.rows.map((r) => r.text), ['abc', 'DEF', '12', '!?']);
  assert.ok(seg.rows.every(rowMatched));
  assert.ok(seg.rows[0].pieces.every((p) => p.y0 >= 40), 'the stray tick is not glued onto a letter');
});

test('a dot just above a short letter still joins it', () => {
  const rects: Rect[] = [[24, 18, 6, 6], [22, 40, 8, 40], ...letterBox(50)];
  const seg = segmentSample(buildInkMap(image(120, 100, rects)), 'io');
  assert.ok(rowMatched(seg.rows[0]));
  assert.ok(seg.rows[0].pieces[0].y0 <= 18, 'the i keeps its dot');
});

test('AI boxes shifted by whole letters still label each glyph correctly', () => {
  const W = 520;
  const H = 120;
  // Two rows of separate letters with different widths so a shift is detectable.
  const widths = [20, 34, 14, 28, 40, 18, 30, 24];
  const rects: Rect[] = [];
  const truth: { c: string; x0: number; x1: number; y0: number }[] = [];
  const text = ['abcdefgh', 'ijklmnop'];
  text.forEach((line, r) => {
    let x = 10;
    Array.from(line).forEach((c, i) => {
      const w = widths[(i + r * 3) % widths.length];
      rects.push([x, 10 + r * 60, w, 40]);
      truth.push({ c, x0: x, x1: x + w - 1, y0: 10 + r * 60 });
      x += w + 22;
    });
  });
  const ink = buildInkMap(image(W, H, rects));
  for (const shift of [55, 110]) {
    const aiLines = text.map((line, r) => ({
      text: line,
      chars: truth.filter((t) => t.y0 === 10 + r * 60).map((t) => ({
        c: t.c,
        box: [(t.x0 + shift) / W, (t.y0 - 8) / H, (t.x1 + shift) / W, (t.y0 + 32) / H] as [number, number, number, number],
      })),
    }));
    const seg = segmentWithAi(ink, aiLines);
    assert.equal(seg.error, undefined);
    const got = seg.rows.flatMap((r) => r.pieces.map((p, i) => ({ c: r.letters[i], x0: p.x0 })));
    assert.equal(got.length, 16, `shift ${shift}`);
    for (const t of truth) assert.equal(got.find((g) => g.c === t.c)?.x0, t.x0, `${t.c} at shift ${shift}`);
  }
});

test('a stray tick above a joined word is not glued onto its letters', () => {
  // "mil" as one connected stroke whose tall l reaches up, then "no"; a pen tick floats over the m.
  const word: Rect[] = [[10, 60, 60, 40], [70, 96, 10, 3], [80, 60, 14, 40], [94, 96, 10, 3], [104, 40, 14, 60], [150, 60, 30, 40], [200, 60, 30, 40]];
  for (const tickY of [2, 18]) {
    const seg = segmentSample(buildInkMap(image(260, 120, [...word, [36, tickY, 4, 8]])), 'mil no');
    assert.equal(seg.error, undefined);
    const [row] = seg.rows;
    assert.ok(rowMatched(row));
    assert.deepEqual(row.letters, ['m', 'i', 'l', 'n', 'o']);
    assert.ok(row.pieces.every((p) => p.y0 >= 40), `tick at y=${tickY} stays out of every glyph`);
    assert.ok(row.pieces[2].x0 >= 95, 'the l is the tall stroke, not the tick');
  }
});

test('a stray tick grazing a loose AI box is left out of the glyph', () => {
  const W = 160;
  const H = 120;
  const rects: Rect[] = [[10, 60, 30, 40], [60, 60, 30, 40], [110, 60, 30, 40], [72, 22, 4, 8]];
  const box = (x0: number, x1: number): [number, number, number, number] => [x0 / W, 30 / H, x1 / W, 104 / H];
  const seg = segmentFromBoxes(buildInkMap(image(W, H, rects)), [
    { text: 'abc', chars: [{ c: 'a', box: box(6, 44) }, { c: 'b', box: box(56, 94) }, { c: 'c', box: box(106, 144) }] },
  ]);
  assert.ok(rowMatched(seg.rows[0]));
  assert.equal(seg.rows[0].pieces[1].y0, 60, 'the b does not reach up to the tick');
});

test('a photo with a shadow across the page still yields separate letters', () => {
  const W = 400;
  const H = 120;
  const img = image(W, H, []);
  const letters: Rect[] = [[20, 40, 8, 40], [80, 40, 8, 40], [150, 40, 30, 8], [230, 40, 8, 40], [300, 40, 30, 8], [360, 40, 8, 40]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const paper = 250 - (x / W) * 150;
      const inLetter = letters.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
      const v = inLetter ? paper * 0.3 : paper;
      const o = (y * W + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
    }
  }
  const seg = segmentSample(buildInkMap(img), 'abcdef');
  assert.ok(rowMatched(seg.rows[0]));
  assert.ok(seg.rows[0].pieces.every((p) => p.x1 - p.x0 < 40), 'shaded paper is not read as ink');
});

test('a glyph sheet with table grid borders, hollow section frames and colored badges detects every letter', () => {
  const W = 800;
  const H = 360;
  const rects: Rect[] = [];
  // Section header tab "[Uppercase]" with text strokes inside it sitting on top of the A-Z table
  rects.push([30, 21, 130, 2], [30, 45, 130, 2], [30, 21, 2, 26], [158, 21, 2, 26]);
  rects.push([42, 27, 14, 11], [62, 27, 18, 11], [86, 27, 22, 11]); // fake header words inside tab

  // 2x13 grid for A-M and N-Z with full horizontal and vertical grid lines (with small anti-alias gaps)
  const gx0 = 30;
  const gy0 = 45;
  const cellW = 55;
  const cellH = 55;
  const cols = 13;
  const gridW = cols * cellW;
  for (let r = 0; r <= 2; r++) {
    rects.push([gx0, gy0 + r * cellH, 320, 2], [gx0 + 324, gy0 + r * cellH, gridW - 324, 2]);
  }
  for (let c = 0; c <= cols; c++) rects.push([gx0 + c * cellW, gy0, 2, cellH * 2]);

  // Section header tab "[Numbers]" with fake "Num" and "bers" words inside it sitting on top of 0-9 table
  const ny0 = 195;
  rects.push([30, ny0 - 22, 110, 2], [30, ny0, 110, 2], [30, ny0 - 22, 2, 24], [138, ny0 - 22, 2, 24]);
  rects.push([40, ny0 - 16, 28, 11], [74, ny0 - 16, 32, 11]); // "Num" and "bers" inside badge

  // 1x10 grid for 0-9 below
  const nCellW = 65;
  const nGridW = 10 * nCellW;
  for (let r = 0; r <= 1; r++) rects.push([gx0, ny0 + r * cellH, nGridW, 2]);
  for (let c = 0; c <= 10; c++) rects.push([gx0 + c * nCellW, ny0, 2, cellH]);

  // Place handwritten letters inside each cell
  const truth: { c: string; cx: number; cy: number; box: [number, number, number, number] }[] = [];
  const upper1 = 'ABCDEFGHIJKLM';
  const upper2 = 'NOPQRSTUVWXYZ';
  const digits = '0123456789';

  Array.from(upper1).forEach((ch, c) => {
    const x = gx0 + c * cellW + 16;
    const y = gy0 + 12;
    rects.push([x, y, 22, 32]);
    truth.push({ c: ch, cx: x + 11, cy: y + 16, box: [(x - 2) / W, (y - 2) / H, (x + 24) / W, (y + 34) / H] });
  });
  Array.from(upper2).forEach((ch, c) => {
    const x = gx0 + c * cellW + 16;
    const y = gy0 + cellH + 12;
    rects.push([x, y, 22, 32]);
    truth.push({ c: ch, cx: x + 11, cy: y + 16, box: [(x - 2) / W, (y - 2) / H, (x + 24) / W, (y + 34) / H] });
  });
  Array.from(digits).forEach((ch, c) => {
    const x = gx0 + c * nCellW + 20;
    const y = ny0 + 12;
    rects.push([x, y, 20, 30]);
    truth.push({ c: ch, cx: x + 10, cy: y + 15, box: [(x - 2) / W, (y - 2) / H, (x + 22) / W, (y + 32) / H] });
  });

  const img = image(W, H, rects);
  // Make the 0-9 table grid lines fluctuate in light-grey brightness (165..215) across Otsu's
  // threshold so only sporadic segments binarize directly, testing grey-aware grid removal.
  for (let r = 0; r <= 1; r++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let x = gx0; x < gx0 + nGridW; x++) {
        const o = ((ny0 + r * cellH + dy) * W + x) * 4;
        const g = (x % 9 < 4) ? 175 : 212;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
      }
    }
  }

  const ink = buildInkMap(img);
  // Both text-only segmentation and AI-assisted segmentation must match all 36 characters cleanly,
  // and no piece may span across two rows (no A+N double-height boxes).
  const textSeg = segmentSample(ink, `${upper1}\n${upper2}\n${digits}`);
  assert.equal(textSeg.error, undefined);
  assert.deepEqual(textSeg.rows.map((r) => r.letters.join('')), [upper1, upper2, digits]);
  assert.ok(textSeg.rows.every(rowMatched));
  assert.ok(textSeg.rows.flatMap((r) => r.pieces).every((p) => p.y1 - p.y0 + 1 <= 40), 'no multi-row pieces');

  const aiSeg = segmentWithAi(ink, [
    { text: upper1, chars: truth.slice(0, 13).map((t) => ({ c: t.c, box: t.box })) },
    { text: upper2, chars: truth.slice(13, 26).map((t) => ({ c: t.c, box: t.box })) },
    { text: digits, chars: truth.slice(26).map((t) => ({ c: t.c, box: t.box })) },
  ]);
  assert.equal(aiSeg.error, undefined);
  assert.equal(aiSeg.rows.reduce((s, r) => s + r.letters.length, 0), 36);
  assert.ok(aiSeg.rows.every(rowMatched));
  assert.ok(aiSeg.rows.flatMap((r) => r.pieces).every((p) => p.y1 - p.y0 + 1 <= 40), 'no multi-row pieces in AI seg');
});

test('letters with tall vertical stems (d, f, j, p, q, 9) near grid borders are never cut off', () => {
  const W = 800;
  const H = 220;
  const gx0 = 30;
  const gy0 = 30;
  const cellW = 55;
  const cellH = 65;
  const cols = 13;
  const gridW = cols * cellW;
  const rects: Rect[] = [];

  // 2x13 grid for lowercase a-m and n-z
  for (let r = 0; r <= 2; r++) rects.push([gx0, gy0 + r * cellH, gridW, 2]);
  for (let c = 0; c <= cols; c++) rects.push([gx0 + c * cellW, gy0, 2, cellH * 2]);

  const row1 = 'abcdefghijklm';
  const row2 = 'nopqrstuvwxyz';
  Array.from(row1).forEach((ch, c) => {
    const x = gx0 + c * cellW + 15;
    const yTop = gy0 + 4; // only 2px below top horizontal border
    const yMid = gy0 + 24;
    if (ch === 'd') {
      // hollow bowl + tall right vertical stem reaching within 1px of top border
      rects.push([x, yMid, 14, 3], [x, yMid + 19, 14, 3], [x, yMid, 3, 22], [x + 14, yTop - 2, 4, 44]);
    } else if (ch === 'f') {
      // top hook + detached crossbar + tall vertical stem reaching within 2px of both borders
      rects.push([x + 6, yTop - 1, 12, 4], [x + 6, yTop - 1, 4, 60], [x, yMid, 5, 4], [x + 11, yMid, 7, 4]);
    } else if (ch === 'j') {
      // dot + vertical stem + detached bottom hook near bottom cell border
      rects.push([x + 10, yTop + 4, 5, 5], [x + 10, yTop + 14, 4, 42], [x, gy0 + cellH - 8, 9, 4]);
    } else {
      rects.push([x, yMid, 20, 24]);
    }
  });
  Array.from(row2).forEach((ch, c) => {
    const x = gx0 + c * cellW + 15;
    const r2Top = gy0 + cellH;
    const yMid = r2Top + 14;
    if (ch === 'p') {
      // hollow bowl + left vertical descender stem reaching within 2px of bottom border
      rects.push([x, yMid, 4, 48], [x + 4, yMid, 14, 3], [x + 4, yMid + 19, 14, 3], [x + 15, yMid, 3, 22]);
    } else if (ch === 'q') {
      // hollow bowl + right vertical descender stem + detached tail reaching within 2px of bottom border
      rects.push([x, yMid, 14, 3], [x, yMid + 19, 14, 3], [x, yMid, 3, 22], [x + 14, yMid, 4, 48], [x + 19, r2Top + cellH - 6, 8, 4]);
    } else {
      rects.push([x, yMid, 20, 24]);
    }
  });

  const ink = buildInkMap(image(W, H, rects));
  const seg = segmentSample(ink, `${row1}\n${row2}`);
  assert.equal(seg.error, undefined);
  assert.ok(seg.rows.every(rowMatched));

  const byChar = new Map<string, Piece>();
  seg.rows.forEach((r) => r.letters.forEach((ch, i) => byChar.set(ch, r.pieces[i])));

  const d = byChar.get('d')!;
  assert.ok(d.y1 - d.y0 + 1 >= 42 && d.x1 - d.x0 + 1 >= 16, `d retains hollow bowl and full ascender height (got ${d.x1 - d.x0 + 1}x${d.y1 - d.y0 + 1})`);
  const f = byChar.get('f')!;
  assert.ok(f.y1 - f.y0 + 1 >= 58 && f.x1 - f.x0 + 1 >= 16, `f retains detached crossbar and full stem height (got ${f.x1 - f.x0 + 1}x${f.y1 - f.y0 + 1})`);
  const j = byChar.get('j')!;
  assert.ok(j.y1 - j.y0 + 1 >= 50 && j.x1 - j.x0 + 1 >= 13, `j retains dot, stem and detached hook (got ${j.x1 - j.x0 + 1}x${j.y1 - j.y0 + 1})`);
  const p = byChar.get('p')!;
  assert.ok(p.y1 - p.y0 + 1 >= 46 && p.x1 - p.x0 + 1 >= 16, `p retains hollow bowl and full descender stem (got ${p.x1 - p.x0 + 1}x${p.y1 - p.y0 + 1})`);
  const q = byChar.get('q')!;
  assert.ok(q.y1 - q.y0 + 1 >= 46 && q.x1 - q.x0 + 1 >= 24, `q retains hollow bowl, descender stem and tail (got ${q.x1 - q.x0 + 1}x${q.y1 - q.y0 + 1})`);

  // Also verify detectGlyphTemplate recognizes this 2x13 lowercase template directly.
  const tmpl = detectGlyphTemplate(ink);
  assert.ok(tmpl, 'detectGlyphTemplate recognizes the 2x13 template');
  assert.equal(tmpl.rows.reduce((n, r) => n + r.letters.length, 0), 26);

  // Verify segmentWithAi filters section headers and splits 26-char lines across 2x13 grid rows.
  const aiSeg = segmentWithAi(ink, [
    { text: 'Lowercase Letters', chars: [] },
    { text: 'abcdefghijklmnopqrstuvwxyz', chars: [] },
  ]);
  assert.equal(aiSeg.error, undefined);
  assert.equal(aiSeg.rows.length, 2);
  assert.equal(aiSeg.rows.reduce((n, r) => n + r.letters.length, 0), 26);
});
