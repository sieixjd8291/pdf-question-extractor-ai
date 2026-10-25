import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, findFont, type AssignmentDoc } from './catalog';
import { runLayout, segment } from './compose';
import type { HandwritingEngine } from './engine';
import { docOnLines, templateLineStep } from './snapLines';
import { pageLook } from './variation';
import { clampDelta, shiftedOffsets } from '../../components/assignment/TextArrangeLayer';

const layout = DEFAULT_SETTINGS.layout;
const ruling = { lineHeight: 48, firstLine: 120, lastLine: 1608, marginRule: null, angle: 2, slope: Math.tan(2 * Math.PI / 180), centerX: 600 };
function document(): AssignmentDoc {
  return { text: 'One\fTwo', settings: { ...DEFAULT_SETTINGS, paper: { kind: 'stock', id: 'spiral-notebook' } }, overrides: {}, pagePapers: {}, pageAdjust: {}, pageVariation: {}, diagrams: [], textOffsets: {} };
}

test('grid uses half-height rows; plain templates never force snapping', () => {
  for (const template of [3, 4]) assert.equal(templateLineStep({ kind: 'template', template }, layout), layout.lineHeight / 2);
  for (const template of [1, 2, 5, 8, 9]) assert.equal(templateLineStep({ kind: 'template', template }, layout), layout.lineHeight);
  for (const template of [0, 6, 7]) assert.equal(templateLineStep({ kind: 'template', template }, layout), null);
});

test('mixed pages preserve their layouts and never inherit a photo tilt', () => {
  const doc = document();
  doc.pagePapers = { 1: { kind: 'template', template: 3 }, 2: { kind: 'template', template: 0 } };
  doc.overrides[1] = { ...layout, marginTop: 193, lineHeight: 61, angle: 3 };
  doc.textOffsets = { 'p1.l0': { x: 15, y: 46 }, 'p2.l0': { x: 10, y: 17 } };
  const drawn = docOnLines(doc, (page) => page < 1 ? ruling : null, (page) => doc.pagePapers[page] ?? doc.settings.paper);
  assert.equal(drawn.overrides[1].angle, 0);
  assert.equal(drawn.overrides[1].lineHeight, 61);
  assert.equal(drawn.overrides[1].marginTop, 193);
  assert.equal(drawn.overrides[2].angle, 0);
  assert.equal(drawn.overrides[2].lineHeight, layout.lineHeight);
  assert.equal(drawn.textOffsets['p1.l0'].y, 61);
  assert.equal(drawn.textOffsets['p2.l0'].y, 17);
  assert.equal(doc.overrides[1].angle, 3);
  assert.equal(doc.textOffsets['p1.l0'].y, 46);
});

test('turning snapping off leaves every slider and text position untouched', () => {
  const doc = document();
  doc.settings = { ...doc.settings, snapToLines: false };
  doc.textOffsets = { 'p0.l0': { x: 12, y: 17 } };
  assert.equal(docOnLines(doc, () => null, () => doc.settings.paper), doc);
});

test('photo snapping is derived, retaining original slider values', () => {
  const doc = document();
  const before = structuredClone(doc);
  const drawn = docOnLines(doc, () => ruling, () => doc.settings.paper);
  assert.deepEqual(doc, before);
  assert.equal(drawn.settings.layout.angle, 2);
  assert.equal(drawn.settings.layout.lineHeight % ruling.lineHeight, 0);
  assert.equal(drawn.settings.layout.marginLeft, doc.settings.layout.marginLeft);
  assert.equal(drawn.settings.layout.marginRight, doc.settings.layout.marginRight);
});

test('no variation until reroll; individual reroll only changes its page', () => {
  assert.equal(DEFAULT_SETTINGS.variationSeed, 0);
  for (const strength of ['subtle', 'natural', 'strong'] as const) {
    assert.equal(pageLook(strength, 0, undefined, 0, 1240, 1754), null);
    assert.ok(pageLook(strength, 0, { seed: 123 }, 0, 1240, 1754));
    assert.equal(pageLook(strength, 0, undefined, 1, 1240, 1754), null);
  }
  const first = pageLook('natural', 42, undefined, 0, 1240, 1754);
  assert.deepEqual(first, pageLook('natural', 42, undefined, 0, 1240, 1754));
  assert.notDeepEqual(first, pageLook('natural', 43, undefined, 0, 1240, 1754));
  assert.equal(pageLook('natural', 42, { off: true }, 0, 1240, 1754), null);
});

test('drag offsets reuse engine geometry; layout edits invalidate it', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 40 }) }) }) } });
  try {
    let calls = 0;
    const engine = { layout: () => {
      calls++;
      return new Float32Array([1, 1, 0, 0, 0, 150, 176, 0, 1, 0, 1, 0, 0]);
    } } as unknown as HandwritingEngine;
    const font = findFont(DEFAULT_SETTINGS.fontFamily);
    const text = segment('a');
    const base = runLayout(engine, DEFAULT_SETTINGS, text, font, font, {});
    const moved = runLayout(engine, DEFAULT_SETTINGS, text, font, font, {}, { p0: { x: 20, y: 26 } });
    assert.equal(calls, 1);
    assert.equal(moved.glyphs[2], base.glyphs[2] + 20);
    assert.equal(moved.glyphs[3], base.glyphs[3] + 26);
    assert.equal(base.glyphs[2], 150);
    runLayout(engine, { ...DEFAULT_SETTINGS, layout: { ...layout, marginLeft: 180 } }, text, font, font, {});
    assert.equal(calls, 2);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('large snapped drags stop at the last valid row instead of jumping back', () => {
  const bounds = { left: 100, top: 100, right: 300, bottom: 200 };
  const box = { left: 50, top: 50, right: 600, bottom: 550 };
  assert.deepEqual(clampDelta(bounds, box, 0, 10000, 25), [0, 350]);
  assert.deepEqual(clampDelta(bounds, box, 0, -10000, 25), [0, -50]);
  assert.deepEqual(clampDelta(bounds, box, 4.2, 14, 25), [4.2, 25]);
  assert.deepEqual(clampDelta(bounds, box, 4.2, 14, null), [4.2, 14]);
  assert.deepEqual(shiftedOffsets(['p0.l0'], { 'p0.l0': { x: 10, y: 25 } }, 0, 25), { 'p0.l0': { x: 10, y: 50 } });
});
