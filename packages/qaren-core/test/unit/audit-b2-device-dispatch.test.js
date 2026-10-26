// Audit batch B2 — device/dispatch correctness fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRunIOSArgs, buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';
import {
  updateRefMapFromFlat,
  clearRefMap,
  isRefMapFresh,
  getRefMapAge,
} from '../../dist/fast-runner-ref-map.js';
import { simctlScreenshotType } from '../../dist/handlers/device-screenshot-raw.js';
import { buildDirectionalSwipeCliArgs } from '../../dist/handlers/device-interact.js';
import {
  runIOS,
  _setRunnerStateForTest,
  _setFetchForTest,
  _setHttpTimeoutForTest,
} from '../../dist/runners/rn-fast-runner-client.js';

// --- tap NaN guard (iOS + Android) ---

test('buildRunIOSArgs throws instead of dispatching NaN coordinates', () => {
  clearRefMap();
  assert.throws(() => buildRunIOSArgs(['tap']), /numeric x, y/);
  assert.throws(() => buildRunIOSArgs(['tap', 'foo', 'bar']), /numeric x, y/);
  assert.deepEqual(buildRunIOSArgs(['tap', '10', '20']), { command: 'tap', x: 10, y: 20 });
});

test('buildRunAndroidArgs throws instead of dispatching NaN coordinates', () => {
  clearRefMap();
  assert.throws(() => buildRunAndroidArgs(['tap']), /numeric x, y/);
  assert.throws(() => buildRunAndroidArgs(['tap', 'x', 'y']), /numeric x, y/);
  assert.deepEqual(buildRunAndroidArgs(['tap', '5', '6']), { command: 'tap', x: 5, y: 6 });
});

// --- ref-map freshness gate ---

test('isRefMapFresh tracks snapshot age', () => {
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 10, y: 20, width: 100, height: 40 } },
  ]);
  assert.equal(isRefMapFresh(60_000), true, 'just-populated map is fresh');
  assert.equal(isRefMapFresh(-1), false, 'any positive age fails a negative threshold');
  clearRefMap();
  assert.equal(getRefMapAge(), Infinity);
  assert.equal(isRefMapFresh(), false, 'cleared map is never fresh');
});

test('buildRunIOSArgs resolves a fresh @ref to coordinates', () => {
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 10, y: 20, width: 100, height: 40 } },
  ]);
  assert.deepEqual(buildRunIOSArgs(['tap', '@e0']), { command: 'tap', x: 60, y: 40 });
});

test('buildRunIOSArgs surfaces _staleRef when the @ref is unresolvable', () => {
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 10, y: 20, width: 100, height: 40 } },
  ]);
  assert.deepEqual(buildRunIOSArgs(['tap', '@missing']), { command: 'tap', _staleRef: '@missing' });
});

// --- iOS screenshot format honored via extension ---

test('simctlScreenshotType derives type from the path extension', () => {
  assert.equal(simctlScreenshotType('shot.png'), 'png');
  assert.equal(simctlScreenshotType('SHOT.PNG'), 'png');
  assert.equal(simctlScreenshotType('shot.jpg'), 'jpeg');
  assert.equal(simctlScreenshotType('shot.jpeg'), 'jpeg');
  assert.equal(simctlScreenshotType('shot'), 'jpeg');
  assert.equal(simctlScreenshotType('shot.png.jpg'), 'jpeg');
});

// --- batch swipe is a real swipe gesture, not a scroll ---

test('buildDirectionalSwipeCliArgs emits a swipe gesture with duration', () => {
  clearRefMap();
  const down = buildDirectionalSwipeCliArgs('down');
  assert.equal(down[0], 'swipe', 'must be a swipe, not a scroll');
  assert.equal(down.length, 6, 'swipe x1 y1 x2 y2 duration');
  assert.equal(down[5], '300', 'default duration');
  const custom = buildDirectionalSwipeCliArgs('up', 500);
  assert.equal(custom[0], 'swipe');
  assert.equal(custom[5], '500', 'honors supplied duration');
});

// --- iOS dispatch no longer hangs forever when the runner wedges ---

test('runIOS returns RUNNER_TIMEOUT when the runner does not respond', async () => {
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  _setHttpTimeoutForTest(50);
  _setFetchForTest(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
  );
  try {
    const result = await runIOS({ command: 'tap', x: 1, y: 1 });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'RUNNER_TIMEOUT');
    assert.equal(payload.meta.runnerTimeoutRecovery.poisoned, true);
    assert.equal(payload.meta.runnerTimeoutRecovery.runner.stateCleared, true);
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setHttpTimeoutForTest(null);
    _setRunnerStateForTest(null);
  }
});
