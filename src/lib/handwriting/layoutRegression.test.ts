import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS, PAGE_SIZES, findFont, type AssignmentDoc, type PageSizeId } from './catalog';
import { LayoutFields } from '../../components/assignment/LayoutPanel';
import { pageSignature, type RenderInput } from './render';
import { runLayout, segment } from './compose';
import type { HandwritingEngine } from './engine';
import { docOnLines, pageWritesOnLines, templateLineStep } from './snapLines';
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

test('first-line slider can reach the photo top instead of clamping to its first printed rule', () => {
  const photoRuling = { ...ruling, firstLine: 279, lineHeight: 48.44 };
  for (const customized of [false, true]) {
    for (const top of [0, 1, 40, 80, 160]) {
      const doc = document();
      const desired = { ...layout, marginTop: top };
      if (customized) doc.overrides[0] = desired;
      else doc.settings = { ...doc.settings, layout: desired };
      const drawn = docOnLines(doc, () => photoRuling, () => doc.settings.paper);
      const actual = customized ? drawn.overrides[0] : drawn.settings.layout;
      const minimumBaseline = Math.ceil(doc.settings.fontSize * Math.max(1, doc.settings.headingScale));
      assert.equal(actual.marginTop, Math.max(top, minimumBaseline));
      assert.ok(actual.marginTop < photoRuling.firstLine);
      assert.equal(actual.lineHeight, 48.44);
      assert.equal(actual.angle, photoRuling.angle);
      assert.equal(actual.marginBottom, desired.marginBottom);
      assert.equal((customized ? doc.overrides[0] : doc.settings.layout).marginTop, top);
    }
  }
});

test('individual snapping overrides the global mode without changing other pages or saved positions', () => {
  for (const globalEnabled of [true, false]) {
    const doc = document();
    doc.settings = { ...doc.settings, snapToLines: globalEnabled };
    doc.pageSnapToLines = { 0: !globalEnabled };
    doc.textOffsets = { 'p0.l0': { x: 5, y: 17 }, 'p1.l0': { x: 9, y: 17 } };
    const before = structuredClone(doc);
    const drawn = docOnLines(doc, () => ruling, () => doc.settings.paper);
    assert.deepEqual(doc, before);
    assert.equal(drawn.overrides[0].snapToLines, !globalEnabled);
    assert.equal(drawn.overrides[0].lineHeight, globalEnabled ? layout.lineHeight : ruling.lineHeight);
    assert.equal(drawn.textOffsets['p0.l0'].y, globalEnabled ? 17 : 0);
    assert.equal(drawn.textOffsets['p1.l0'].y, globalEnabled ? 0 : 17);
    assert.equal(drawn.settings.snapToLines, globalEnabled);
  }
});

test('grid pages enable alignment automatically but retain an explicit opt-out', () => {
  for (const template of [3, 4]) {
    const doc = document();
    doc.settings = { ...doc.settings, snapToLines: false };
    doc.pagePapers[1] = { kind: 'template', template };
    doc.textOffsets = { 'p1.l0': { x: 10, y: 17 } };
    const paperFor = (page: number) => doc.pagePapers[page] ?? doc.settings.paper;
    assert.equal(pageWritesOnLines(doc, 1, paperFor(1)), true);
    assert.equal(docOnLines(doc, () => null, paperFor).textOffsets['p1.l0'].y, 26);
    doc.pageSnapToLines = { 1: false };
    assert.equal(pageWritesOnLines(doc, 1, paperFor(1)), false);
    assert.equal(docOnLines(doc, () => null, paperFor).textOffsets['p1.l0'].y, 17);
  }
});

test('top and bottom slider ranges cannot overlap on any supported page size', () => {
  for (const pageSize of Object.keys(PAGE_SIZES) as PageSizeId[]) {
    const pageHeight = PAGE_SIZES[pageSize].height;
    for (const margins of [layout, { ...layout, marginTop: 1000, marginBottom: 90 }, { ...layout, marginTop: 0, marginBottom: pageHeight - 1 }]) {
      const html = renderToStaticMarkup(createElement(LayoutFields, { layout: margins, pageSize, onChange: () => {} }));
      const ranges = [...html.matchAll(/<input\b[^>]*type="range"[^>]*>/g)].map(([input]) => Number(/max="([^"]+)"/.exec(input)?.[1]));
      assert.equal(ranges.length, 5);
      assert.ok(ranges[2] + margins.marginBottom < pageHeight);
      assert.ok(ranges[3] + margins.marginTop < pageHeight);
      assert.ok(ranges[2] >= 0 && ranges[3] >= 0);
    }
  }
});

test('bottom limit leaves room for the photo baseline even above the first detected rule', () => {
  const html = renderToStaticMarkup(createElement(LayoutFields, {
    layout: { ...layout, marginTop: 0 }, pageSize: 'a4', firstBaseline: 279, onChange: () => {},
  }));
  const ranges = [...html.matchAll(/<input\b[^>]*type="range"[^>]*>/g)].map(([input]) => Number(/max="([^"]+)"/.exec(input)?.[1]));
  assert.ok(ranges[3] + 279 < PAGE_SIZES.a4.height);
});

test('a margin guide keeps updating between snapped rows, including customized pages', () => {
  const doc = document();
  const flatRuling = { ...ruling, angle: 0, slope: 0 };
  const drawn = docOnLines(doc, () => flatRuling, () => doc.settings.paper);
  const input: RenderInput = {
    engine: {} as HandwritingEngine,
    settings: drawn.settings,
    overrides: {},
    guideDoc: doc,
    layout: { pages: 1, glyphs: new Float32Array(), glyphCount: 0, strokes: [], glyphsByPage: [[]], blocks: [] },
    units: [], fontA: findFont(DEFAULT_SETTINGS.fontFamily), fontB: findFont(DEFAULT_SETTINGS.fontFamily),
    photo: null, images: {}, pagePapers: {},
  };
  const first = { ...layout, marginTop: 121 };
  const second = { ...layout, marginTop: 124 };
  for (const customized of [false, true]) {
    const requested = (value: typeof layout): AssignmentDoc => customized
      ? { ...doc, overrides: { 0: value } }
      : { ...doc, settings: { ...doc.settings, layout: value } };
    const a = requested(first);
    const b = requested(second);
    assert.equal(docOnLines(a, () => flatRuling, () => a.settings.paper).settings.layout.marginTop,
      docOnLines(b, () => flatRuling, () => b.settings.paper).settings.layout.marginTop);
    assert.notEqual(pageSignature({ ...input, guideDoc: a }, 0, 'same-ink'), pageSignature({ ...input, guideDoc: b }, 0, 'same-ink'));
  }
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

test('mixed snapping modes affect only the selected page and reuse both cached engine results', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 40 }) }) }) } });
  try {
    for (const globalEnabled of [true, false]) {
      let calls = 0;
      const engine = { layout: (input: Float32Array) => {
        calls++;
        const y = input[12] ? 183 : 176;
        return new Float32Array([2, 2, 2,
          0, 0, 150, y, 0, 1, 0, 0, 1, 0,
          1, 0, 150, y, 0, 1, 0, 0, 1, 0,
          0, 4, 2, 150, y + 8, 170, y + 8,
          1, 4, 2, 150, y + 8, 170, y + 8]);
      } } as unknown as HandwritingEngine;
      const font = findFont(DEFAULT_SETTINGS.fontFamily);
      const settings = { ...DEFAULT_SETTINGS, snapToLines: globalEnabled };
      const overrides = { 0: { ...layout, snapToLines: !globalEnabled } };
      const text = segment('a\fb');
      const result = runLayout(engine, settings, text, font, font, overrides);
      assert.equal(result.glyphs[3], globalEnabled ? 183 : 176);
      assert.equal(result.glyphs[13], globalEnabled ? 176 : 183);
      assert.equal(result.strokes[0].points[1], globalEnabled ? 191 : 184);
      assert.equal(result.strokes[1].points[1], globalEnabled ? 184 : 191);
      runLayout(engine, settings, text, font, font, overrides, { p0: { x: 10, y: 0 } });
      assert.equal(calls, 2);
    }
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
