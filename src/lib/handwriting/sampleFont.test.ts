import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInkMap, rowMatched, segmentSample, segmentFromBoxes, segmentWithAi, type Piece } from './sampleFont';

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
