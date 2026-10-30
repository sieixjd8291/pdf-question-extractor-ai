import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSerialTaskQueue } from './serialTaskQueue';

test('batch inference runs every picture once without overlapping the shared session', async () => {
  const enqueue = createSerialTaskQueue();
  let active = 0;
  let maximumActive = 0;
  const order: number[] = [];
  const results = await Promise.all(Array.from({ length: 25 }, (_, index) => enqueue(async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    order.push(index);
    active--;
    return index;
  })));
  assert.equal(maximumActive, 1);
  assert.deepEqual(results, Array.from({ length: 25 }, (_, index) => index));
  assert.deepEqual(order, results);
});

test('a failed picture does not block orientation of the remaining batch', async () => {
  const enqueue = createSerialTaskQueue();
  const failed = enqueue(async () => { throw new Error('Inference failed'); });
  const next = enqueue(async () => 90);
  const last = enqueue(async () => 270);
  await assert.rejects(failed, /Inference failed/);
  assert.deepEqual(await Promise.all([next, last]), [90, 270]);
});
