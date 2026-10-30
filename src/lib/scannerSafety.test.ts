import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReliableOrientation, type MlOrientationResult } from './mlOrientation';
import { automaticDocumentQuad } from './automaticDocumentCrop';
import type { DocumentDetectionResult } from './precisionDetection';

const quad = { tl: { x: 0.1, y: 0.1 }, tr: { x: 0.9, y: 0.12 }, br: { x: 0.88, y: 0.9 }, bl: { x: 0.12, y: 0.88 } };
const detection: DocumentDetectionResult = {
  quad, quality: 'strong', edgeSupport: [0.9, 0.9, 0.9, 0.9], source: 'paper-region',
  reason: 'Page boundaries verified', twoPageDetails: null, width: 1000, height: 1400, durationMs: 0,
};
function prediction(rotationDelta: MlOrientationResult['rotationDelta'], confidence: number): MlOrientationResult {
  const scores = { 0: 0, 90: 0, 180: 0, 270: 0 };
  for (const angle of [0, 90, 180, 270] as const) scores[angle] = angle === rotationDelta ? confidence : (1 - confidence) / 3;
  return { rotationDelta, confidence, scores };
}

test('ambiguous model winners never authorize rotation', () => {
  for (const angle of [90, 180, 270] as const) {
    for (const confidence of [0.5, 0.7, 0.9, 0.949]) assert.equal(isReliableOrientation(prediction(angle, confidence)), false);
  }
});

test('quarter-turns accept strong agreement only when every independent view supports the correction', () => {
  for (const angle of [90, 270] as const) {
    const result = prediction(angle, 0.925);
    assert.equal(isReliableOrientation({ ...result, minViewConfidence: 0.92 }), true);
    for (const minViewConfidence of [0.89, NaN, Infinity, 1.1]) {
      assert.equal(isReliableOrientation({ ...result, minViewConfidence }), false);
    }
  }
  assert.equal(isReliableOrientation({ ...prediction(180, 0.925), minViewConfidence: 0.92 }), false);
});

test('half-turns require stronger evidence than quarter-turns', () => {
  assert.equal(isReliableOrientation(prediction(180, 0.98)), false);
  assert.equal(isReliableOrientation(prediction(180, 0.995)), true);
  assert.equal(isReliableOrientation(prediction(90, 0.97)), true);
  assert.equal(isReliableOrientation(prediction(270, 0.97)), true);
  assert.equal(isReliableOrientation(prediction(0, 0.99)), true);
});

test('inconsistent and non-finite model scores are rejected', () => {
  const result = prediction(180, 0.999);
  assert.equal(isReliableOrientation({ ...result, scores: { ...result.scores, 0: 0.99 } }), false);
  assert.equal(isReliableOrientation({ ...result, confidence: NaN }), false);
  assert.equal(isReliableOrientation({ ...result, scores: { ...result.scores, 90: NaN } }), false);
});

test('review outlines are never silently applied, even with high edge scores', () => {
  for (const source of ['photo', 'pdf'] as const) {
    assert.equal(automaticDocumentQuad({ ...detection, quality: 'review' }, source), null);
    assert.equal(automaticDocumentQuad({ ...detection, quality: 'none' }, source), null);
  }
});

test('verified perspective crops remain available', () => {
  assert.equal(automaticDocumentQuad(detection, 'photo'), quad);
  assert.equal(automaticDocumentQuad(detection, 'pdf'), quad);
});

test('one unsupported edge prevents an uneven automatic crop', () => {
  for (let edge = 0; edge < 4; edge++) {
    const edgeSupport = [0.95, 0.95, 0.95, 0.95];
    edgeSupport[edge] = 0.55;
    assert.equal(automaticDocumentQuad({ ...detection, edgeSupport }, 'photo'), null);
  }
});

test('malformed scores and non-finite or out-of-frame corners are rejected', () => {
  for (const edgeSupport of [[], [1, 1, 1], [1, 1, 1, NaN], [1, 1, 1, 1.1]]) {
    assert.equal(automaticDocumentQuad({ ...detection, edgeSupport }, 'photo'), null);
  }
  for (const x of [NaN, Infinity, -0.1, 1.1]) {
    assert.equal(automaticDocumentQuad({ ...detection, quad: { ...quad, tl: { x, y: 0.1 } } }, 'photo'), null);
  }
});

test('small internal boxes and full-frame outlines are not automatic page crops', () => {
  assert.equal(automaticDocumentQuad({ ...detection, quad: { tl: { x: 0.3, y: 0.3 }, tr: { x: 0.7, y: 0.3 }, br: { x: 0.7, y: 0.7 }, bl: { x: 0.3, y: 0.7 } } }, 'photo'), null);
  assert.equal(automaticDocumentQuad({ ...detection, quad: { tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 } } }, 'photo'), null);
});

test('PDF internal tables and reduced-resolution proposals remain excluded', () => {
  assert.equal(automaticDocumentQuad({ ...detection, source: 'canny' }, 'pdf'), null);
  assert.equal(automaticDocumentQuad({ ...detection, reason: 'Reduced-resolution fallback' }, 'pdf'), null);
});
