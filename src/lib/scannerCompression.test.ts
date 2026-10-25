import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTargetCompression, sampleSizeWeight, targetCompressionSettings } from './scannerCompression';

const measure = async (level: number) => 1000 - level * 8;

test('target uses the lightest integer compression that meets the size', async () => {
  assert.deepEqual(await findTargetCompression(603, measure), { level: 50, size: 600, reachable: true });
});

test('changing target replaces prior compression in either direction', async () => {
  assert.equal((await findTargetCompression(400, measure)).level, 75);
  assert.equal((await findTargetCompression(800, measure)).level, 25);
  assert.equal((await findTargetCompression(400, measure)).level, 75);
});

test('a larger target does not compress unnecessarily', async () => {
  assert.deepEqual(await findTargetCompression(1200, measure), { level: 0, size: 1000, reachable: true });
});

test('unreachable targets are reported, never silently accepted', async () => {
  assert.deepEqual(await findTargetCompression(100, measure), { level: 100, size: 200, reachable: false });
});

test('custom targets bypass the slider quality and resolution limits', () => {
  assert.deepEqual(targetCompressionSettings(0, 0.92, false), { level: 0, quality: 0.92, scale: 1, maxEdge: 0 });
  const maximum = targetCompressionSettings(100, 0.92, false);
  assert.ok(maximum.quality < 0.76);
  assert.equal(maximum.scale, 0.01);
  assert.equal(targetCompressionSettings(100, 1, true).quality, 1);
});

test('custom targets select fresh source-based settings in either direction', async () => {
  const size = async (level: number) => 1_500_000 * targetCompressionSettings(level, 0.92, false).scale ** 2;
  const small = await findTargetCompression(200_000, size);
  const large = await findTargetCompression(800_000, size);
  assert.ok(small.reachable && large.reachable);
  assert.ok(small.size <= 200_000 && large.size <= 800_000);
  assert.ok(large.level < small.level);
});

test('capped pages are not multiplied by their original pixel area', () => {
  assert.equal(sampleSizeWeight(4, 0.5, 1), 1);
  assert.equal(sampleSizeWeight(4, 1, 1), 4);
  assert.equal(sampleSizeWeight(4, 0.25, 0.5), 1);
});
