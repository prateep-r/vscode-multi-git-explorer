import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Limiter, TaskQueue } from '../core/queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
}

test('never runs more jobs than the concurrency limit', async () => {
  const queue = new TaskQueue(2);
  let active = 0;
  let peak = 0;
  for (let i = 0; i < 10; i++) {
    queue.enqueue(`job${i}`, 0, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    });
  }
  await queue.onIdle();
  assert.equal(peak, 2);
});

test('runs higher priority jobs first', async () => {
  const queue = new TaskQueue(1);
  const gate = deferred();
  const order: string[] = [];
  queue.enqueue('blocker', 0, () => gate.promise);
  queue.enqueue('low', 0, async () => void order.push('low'));
  queue.enqueue('high', 3, async () => void order.push('high'));
  queue.enqueue('mid', 1, async () => void order.push('mid'));
  gate.resolve();
  await queue.onIdle();
  assert.deepEqual(order, ['high', 'mid', 'low']);
});

test('re-enqueuing a waiting key raises its priority without running it twice', async () => {
  const queue = new TaskQueue(1);
  const gate = deferred();
  const order: string[] = [];
  queue.enqueue('blocker', 0, () => gate.promise);
  queue.enqueue('a', 0, async () => void order.push('a'));
  queue.enqueue('b', 0, async () => void order.push('b'));
  queue.enqueue('b', 2, async () => void order.push('b'));
  gate.resolve();
  await queue.onIdle();
  assert.deepEqual(order, ['b', 'a']);
});

test('re-enqueuing a running key runs it once more afterwards', async () => {
  const queue = new TaskQueue(4);
  const gate = deferred();
  let runs = 0;
  queue.enqueue('a', 0, async () => {
    runs++;
    await gate.promise;
  });
  queue.enqueue('a', 0, async () => void runs++);
  queue.enqueue('a', 0, async () => void runs++);
  gate.resolve();
  await queue.onIdle();
  assert.equal(runs, 2);
});

test('a failing job does not stop the queue', async () => {
  const queue = new TaskQueue(1);
  let ran = false;
  queue.enqueue('bad', 0, async () => {
    throw new Error('boom');
  });
  queue.enqueue('good', 0, async () => void (ran = true));
  await queue.onIdle();
  assert.equal(ran, true);
});

test('a raised concurrency limit starts waiting jobs at once, and an idle queue is idle right away', async () => {
  const queue = new TaskQueue(1);
  await queue.onIdle();
  let running = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  for (const key of ['a', 'b', 'c']) {
    queue.enqueue(key, 0, async () => {
      running++;
      await gate;
    });
  }
  assert.equal(running, 1);
  queue.setConcurrency(3);
  assert.equal(running, 3);
  queue.setConcurrency(0);
  release();
  await queue.onIdle();
});

test('a Limiter keeps its limit across separate calls', async () => {
  const limiter = new Limiter(2);
  let active = 0;
  let peak = 0;
  const job = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    return 'done';
  };
  const first = [limiter.run(job), limiter.run(job)];
  const later = [limiter.run(job), limiter.run(job), limiter.run(job)];
  assert.deepEqual(await Promise.all([...first, ...later]), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(peak, 2);
});

test('a Limiter passes on failures, and clear cancels what has not started', async () => {
  const limiter = new Limiter(1);
  const gate = deferred();
  let started = 0;
  const running = limiter.run(async () => {
    started++;
    await gate.promise;
    throw new Error('git failed');
  });
  const waiting = limiter.run(async () => void started++);
  limiter.clear();
  gate.resolve();
  await assert.rejects(running, /git failed/);
  await assert.rejects(waiting, /cancelled/);
  assert.equal(started, 1);
  assert.equal(await limiter.run(async () => 'after'), 'after', 'still usable');
});
