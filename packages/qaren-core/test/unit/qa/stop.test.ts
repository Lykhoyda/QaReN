import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createStop, watchOwnerPipe, watchParent } from '../../../dist/qa/stop.js';

test('the first typed terminal reason cancels pending and subsequent work', async () => {
  const stop = createStop();
  const reason = Object.assign(new Error('private hash operand refused'), { code: 'CORE_REFUSED' });
  const pending = stop.track(() => new Promise(() => undefined));
  const refused = assert.rejects(pending, (error) => error === reason);
  assert.equal(stop.begin(reason), true);
  assert.equal(stop.begin(), false);
  assert.equal(stop.signal.reason, reason);
  await refused;
  await assert.rejects(
    stop.track(async () => assert.fail('must not dispatch')),
    (error) => error === reason,
  );
});

test('a stop begins once and then refuses new device work', async () => {
  const stop = createStop();
  let ran = 0;
  assert.equal(
    await stop.track(async () => {
      ran += 1;
      return 'captured';
    }),
    'captured',
  );
  assert.equal(stop.begin(), true);
  assert.equal(stop.begin(), false, 'a second request is ignored');
  assert.equal(stop.stopping, true);
  await assert.rejects(
    stop.track(async () => {
      ran += 1;
    }),
    /RUN_CANCELLED/,
  );
  assert.equal(ran, 1, 'nothing new starts once stopping');
});

test('teardown waits for the operation already in flight, but not forever', async () => {
  const stop = createStop();
  let finish!: () => void;
  const pending = stop.track(() => new Promise<void>((resolve) => (finish = resolve)));
  const rejected = assert.rejects(pending, /RUN_CANCELLED/);
  stop.begin();
  let drained = false;
  const waiting = stop.drained(1000).then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(drained, false, 'the in-flight capture is still running');
  finish();
  await rejected;
  await waiting;
  assert.equal(drained, true);

  const overlapping = createStop();
  let slowDone = false;
  const slow = overlapping.track(
    () => new Promise<void>((resolve) => setTimeout(() => ((slowDone = true), resolve()), 30)),
  );
  const slowRejected = assert.rejects(slow, /RUN_CANCELLED/);
  await overlapping.track(async () => undefined);
  overlapping.begin();
  await overlapping.drained(1000);
  await slowRejected;
  assert.equal(slowDone, true, 'every outstanding operation is drained, not just the latest');

  const stuck = createStop();
  void stuck.track(() => new Promise(() => undefined));
  const started = Date.now();
  await stuck.drained(20);
  assert.ok(Date.now() - started < 500, 'a hung operation cannot block teardown');
});

test('the core notices once when the CLI that spawned it is gone', async () => {
  let parent = 4242;
  let gone = 0;
  const stop = watchParent(
    4242,
    () => parent,
    () => {
      gone += 1;
    },
    5,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gone, 0, 'an unchanged parent is not a departure');
  parent = 1;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gone, 1, 'a reparented core reports the departure exactly once');
  stop();
});

test('a CLI that died during startup is reported as soon as the watch starts', () => {
  let gone = 0;
  watchParent(
    4242,
    () => 1,
    () => {
      gone += 1;
    },
    5,
  );
  assert.equal(gone, 1, 'the startup parent is the baseline, not whoever adopted the core');
});

test('a stopped watch never reports', async () => {
  let parent = 4242;
  let gone = 0;
  const stop = watchParent(
    4242,
    () => parent,
    () => {
      gone += 1;
    },
    5,
  );
  stop();
  parent = 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gone, 0);
});

test('a closed owner pipe stops the walk instead of crashing the core before teardown', async () => {
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    },
  });
  const reasons: string[] = [];
  watchOwnerPipe(broken, (why) => reasons.push(why));
  broken.write('{"type":"result"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reasons, ['EPIPE']);
});
