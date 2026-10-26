import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  clearDevOverlays,
  recoverDevOverlays,
  createDevSettingsHandler,
  WALK_DEV_SETTINGS,
} from '../../dist/handlers/dev-settings.js';
import { failResult, okResult, warnResult, type ToolResult } from '../../dist/utils.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { RunCancelledError, withCancellation } from '../../dist/domain/cancellation.js';
import { nativeDevOverlayUncleared, type NativeObservation } from '../../dist/qa/capture.js';

function run(preferences?: Record<string, unknown>) {
  const calls: { awaitPromise?: boolean; value?: unknown }[] = [];
  const client = createMockClient({
    evaluate: async (expression: string, awaitPromise?: boolean) => {
      try {
        const value = await runInNewContext(expression, {
          expo: { modules: { DevMenuPreferences: preferences } },
        });
        calls.push({ awaitPromise, value });
        return { value };
      } catch (error) {
        return { error: String(error) };
      }
    },
  });
  const handler = createDevSettingsHandler(() => client, { settleAfterHide: async () => {} });
  return { calls, result: handler({ action: 'hideDevMenuFab' }) };
}

test('D1: a verified hidden floating button lets the walk proceed', async () => {
  const mutations: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> = { showFloatingActionButton: true };
  const { calls, result } = run({
    setPreferencesAsync: async (preferences: Record<string, unknown>) => {
      stored = { ...preferences };
      mutations.push(stored);
    },
    getPreferencesAsync: async () => stored,
  });
  const env = parseEnvelope(await result);
  assert.equal(env.ok, true);
  assert.equal(env.data.executed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].awaitPromise, true);
  assert.equal(calls[0].value, 'ok');
  assert.deepEqual(mutations, [
    {
      showFloatingActionButton: false,
      showsAtLaunch: false,
      motionGestureEnabled: false,
      touchGestureEnabled: false,
    },
  ]);
});

test('D2: an app without the dev-menu preferences module proceeds unchanged', async () => {
  const { calls, result } = run();
  const env = parseEnvelope(await result);
  assert.notEqual(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.equal(env.data?.executed, false);
  assert.equal(calls[0].value, 'no_method_available');
});

for (const [name, preferences] of [
  [
    'an unconfirmed read-back',
    {
      setPreferencesAsync: async () => {},
      getPreferencesAsync: async () => ({ showFloatingActionButton: true }),
    },
  ],
  ['a missing read-back', { setPreferencesAsync: async () => {} }],
  [
    'a rejected preferences call',
    {
      setPreferencesAsync: async () => {
        throw new Error('setPreferencesAsync rejected');
      },
    },
  ],
] as [string, Record<string, unknown>][]) {
  test(`D3: ${name} reports the existing unverified dev-menu code`, async () => {
    const { calls, result } = run(preferences);
    const env = parseEnvelope(await result);
    assert.equal(env.ok, false);
    assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
    if (name !== 'a rejected preferences call') assert.equal(calls[0].value, 'unverified');
    assert.match(
      env.error ?? '',
      name === 'a rejected preferences call'
        ? /the preferences call failed or timed out/
        : /the preferences did not read back hidden/,
    );
  });
}

test('D4: the walk hides the floating button before the other dev-menu actions', () => {
  assert.deepEqual(
    [...WALK_DEV_SETTINGS],
    ['hideDevMenuFab', 'disableDevMenu', 'disableFastRefresh', 'hideDevMenu'],
  );
});

for (const resolver of [
  'turbo',
  'native',
  'bridge',
  'require',
  'missing',
  'methodless',
  'throws',
]) {
  test(`D5: turning hot reloading off through ${resolver} executes the setting or warns`, async () => {
    const calls: boolean[] = [];
    const settings = {
      setHotLoadingEnabled(enabled: boolean) {
        calls.push(enabled);
        if (resolver === 'throws') throw new Error('unsupported');
      },
    };
    const context = {
      ...(resolver === 'turbo' || resolver === 'throws' || resolver === 'methodless'
        ? { __turboModuleProxy: () => (resolver === 'methodless' ? {} : settings) }
        : {}),
      ...(resolver === 'native' ? { nativeModuleProxy: { DevSettings: settings } } : {}),
      ...(resolver === 'bridge'
        ? { __fbBatchedBridge: { getCallableModule: () => settings } }
        : {}),
      ...(resolver === 'require' ? { require: () => ({ DevSettings: settings }) } : {}),
    };
    const client = createMockClient({
      evaluate: async (expression: string) => ({ value: runInNewContext(expression, context) }),
    });
    const env = parseEnvelope(
      await createDevSettingsHandler(() => client)({ action: 'disableFastRefresh' }),
    );
    const unavailable = resolver === 'missing' || resolver === 'methodless';
    const ok = !unavailable && resolver !== 'throws';
    assert.deepEqual(calls, unavailable ? [] : [false]);
    assert.equal(env.ok, true);
    assert.equal(env.data.executed, ok);
    if (!ok) assert.ok(env.meta?.warning);
  });
}

type DevAction = (typeof WALK_DEV_SETTINGS)[number];

function nativeOverlay(surface: string): NativeObservation {
  const nodes = [{ ref: 'e0', index: 0, type: 'Application' }];
  return {
    surface,
    nodes,
    truncated: false,
    normalizationDroppedNodes: 0,
    snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
  };
}

function overlays(
  results: Partial<Record<DevAction, () => ToolResult>>,
  overlayReads: Array<boolean | NativeObservation> = [false],
  stopAfter?: DevAction,
) {
  const calls: string[] = [];
  const controller = new AbortController();
  const done = withCancellation(controller.signal, () =>
    clearDevOverlays({
      async devSettings({ action }) {
        calls.push(action);
        if (action === stopAfter) controller.abort(new RunCancelledError());
        return (results[action] ?? (() => okResult({ action, executed: true })))();
      },
      async devOverlayUncleared() {
        calls.push('read');
        const observation = overlayReads.length > 1 ? overlayReads.shift()! : overlayReads[0];
        return typeof observation === 'boolean'
          ? observation
          : nativeDevOverlayUncleared(observation);
      },
      log: (message) => calls.push(`log ${message}`),
      sleep: async () => {},
    }),
  );
  return { calls, done };
}

const unverifiedFab = () =>
  failResult(
    'The Expo dev-client floating button could not be confirmed hidden.',
    'DEV_MENU_HIDE_UNVERIFIED',
  );

const timedOutFab = () =>
  failResult(
    'The Expo dev-client floating button could not be confirmed hidden: the preferences call failed or timed out.',
    'DEV_MENU_HIDE_UNVERIFIED',
  );

test('overlays: a timed-out floating-button hide is retried and the walk proceeds when the retry hides it', async () => {
  let attempts = 0;
  const { calls, done } = overlays({
    hideDevMenuFab: () =>
      attempts++ === 0 ? timedOutFab() : okResult({ action: 'hideDevMenuFab', executed: true }),
  });
  assert.equal(parseEnvelope(await done).ok, true);
  assert.deepEqual(calls, [
    'hideDevMenuFab',
    'hideDevMenuFab',
    'disableDevMenu',
    'disableFastRefresh',
    'hideDevMenu',
    'read',
  ]);
});

for (const [name, reads] of [
  ['report the button hidden', [false]],
  ['show the button', [true]],
] as [string, boolean[]][]) {
  test(`overlays: a floating-button hide that keeps failing refuses after the retries even when the reads ${name}`, async () => {
    const { calls, done } = overlays({ hideDevMenuFab: unverifiedFab }, reads);
    const env = parseEnvelope(await done);
    assert.equal(env.ok, false);
    assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
    assert.match(env.error, /^The Expo dev-client floating button could not be confirmed hidden/);
    assert.deepEqual(calls, ['hideDevMenuFab', 'hideDevMenuFab', 'hideDevMenuFab']);
  });
}

test('overlays: a timed-out floating-button hide that keeps failing refuses with its reason', async () => {
  const { calls, done } = overlays({ hideDevMenuFab: timedOutFab }, [false]);
  const env = parseEnvelope(await done);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.match(
    env.error,
    /^The Expo dev-client floating button could not be confirmed hidden: .*the preferences call failed or timed out/,
  );
  assert.deepEqual(calls, ['hideDevMenuFab', 'hideDevMenuFab', 'hideDevMenuFab']);
});

test('overlays: the preserved timeout reason reaches the refusal', async () => {
  const { done } = overlays({ hideDevMenuFab: timedOutFab }, [true]);
  const env = parseEnvelope(await done);
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.match(env.error, /the preferences call failed or timed out/);
});

test('overlays: an app without the preferences module passes and is still verified natively', async () => {
  const { calls, done } = overlays({
    hideDevMenuFab: () => warnResult({ action: 'hideDevMenuFab', executed: false }, 'no module'),
  });
  assert.equal(parseEnvelope(await done).ok, true);
  assert.deepEqual(calls, [
    'hideDevMenuFab',
    'disableDevMenu',
    'disableFastRefresh',
    'hideDevMenu',
    'read',
  ]);
});

test('overlays: failed actions can pass only when native evidence proves clearance', async () => {
  const { calls, done } = overlays(
    {
      disableDevMenu: () => failResult('Dev settings error: gone'),
      hideDevMenu: () => failResult('not hidden', 'DEV_MENU_HIDE_FAILED'),
    },
    [nativeOverlay('app')],
  );
  assert.equal(parseEnvelope(await done).ok, true);
  assert.equal(calls.filter((c) => c.startsWith('log ')).length, 2);
  assert.equal(calls.at(-1), 'read');
});

for (const surface of ['expo_dev_menu', 'react_native_dev_menu']) {
  test(`overlays: ${surface} closing after the hide passes clearance`, async () => {
    const { calls, done } = overlays({}, [nativeOverlay(surface), nativeOverlay('app')]);
    const env = parseEnvelope(await done);
    assert.equal(env.ok, true);
    assert.equal(env.data.executed, true);
    assert.deepEqual(calls, [
      'hideDevMenuFab',
      'disableDevMenu',
      'disableFastRefresh',
      'hideDevMenu',
      'read',
      'read',
    ]);
  });

  test(`overlays: ${surface} still open after a failed hide is re-read and refused`, async () => {
    const { calls, done } = overlays(
      { hideDevMenu: () => failResult('not hidden', 'DEV_MENU_HIDE_FAILED') },
      [nativeOverlay(surface)],
    );
    const env = parseEnvelope(await done);
    assert.equal(env.ok, false);
    assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
    assert.equal(calls.filter((call) => call === 'read').length, 4);
    assert.equal(calls.filter((call) => call === 'hideDevMenu').length, 1);
  });
}

test('overlays: incomplete or unknown native evidence never proves clearance', async () => {
  for (const observation of [
    { ...nativeOverlay('app'), truncated: true },
    { ...nativeOverlay('app'), snapshotVerdict: undefined },
  ]) {
    const { done } = overlays({}, [observation]);
    assert.equal(parseEnvelope(await done).code, 'DEV_MENU_HIDE_UNVERIFIED');
  }
});

test('overlays: a stop between actions halts before the next action', async () => {
  const { calls, done } = overlays({}, [false], 'hideDevMenuFab');
  await assert.rejects(done, /RUN_CANCELLED/);
  assert.deepEqual(calls, ['hideDevMenuFab']);
});

test('overlays: a floating button that stays on screen refuses with the unverified code', async () => {
  const { calls, done } = overlays({}, [true]);
  const env = parseEnvelope(await done);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.ok(calls.filter((c) => c === 'read').length > 1);
});

test('overlays: a verification read that fails refuses with the unverified code and its reason', async () => {
  const calls: string[] = [];
  const env = parseEnvelope(
    await clearDevOverlays({
      devSettings: async ({ action }) => okResult({ action, executed: true }),
      async devOverlayUncleared() {
        calls.push('read');
        throw new Error('NATIVE_CAPTURE_FAILED: runner gone');
      },
      log: () => {},
      sleep: async () => {},
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.match(env.error, /runner gone/);
  assert.ok(calls.length > 1);
});

test('overlays: a floating button still fading out is re-read until it is gone', async () => {
  const { done } = overlays({}, [true, true, false]);
  assert.equal(parseEnvelope(await done).ok, true);
});

for (const [name, result] of [
  ['a lost connection', () => failResult('CDP not connected', 'NOT_CONNECTED')],
  [
    'a thrown evaluate',
    () => {
      throw new Error('WebSocket closed');
    },
  ],
] as [string, () => ToolResult][]) {
  test(`overlays: ${name} on every floating-button hide refuses with the unverified code`, async () => {
    const { calls, done } = overlays({ hideDevMenuFab: result }, [false]);
    const env = parseEnvelope(await done);
    assert.equal(env.ok, false);
    assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
    assert.match(
      env.error,
      name === 'a lost connection' ? /CDP not connected/ : /WebSocket closed/,
    );
    assert.deepEqual(calls, ['hideDevMenuFab', 'hideDevMenuFab', 'hideDevMenuFab']);
  });
}

function recovery(hide: () => ToolResult, initialOverlay: boolean | NativeObservation) {
  const calls: string[] = [];
  let reads = 0;
  const done = recoverDevOverlays({
    async devSettings({ action }) {
      calls.push(action);
      return action === 'hideDevMenu' && calls.filter((c) => c === 'hideDevMenu').length === 1
        ? hide()
        : okResult({ action, executed: true });
    },
    async devOverlayUncleared() {
      calls.push('read');
      if (reads++ !== 0) return nativeDevOverlayUncleared(nativeOverlay('app'));
      return typeof initialOverlay === 'boolean'
        ? initialOverlay
        : nativeDevOverlayUncleared(initialOverlay);
    },
    log: () => {},
    sleep: async () => {},
  });
  return { calls, done };
}

const noMenu = () =>
  okResult({ action: 'hideDevMenu', executed: false, outcome: 'no_menu_present' });

test('recovery: a hidden dev menu re-runs the overlay clearing', async () => {
  const { calls, done } = recovery(
    () => okResult({ action: 'hideDevMenu', executed: true }),
    false,
  );
  assert.equal(parseEnvelope(await done).ok, true);
  assert.deepEqual(calls, [
    'read',
    'hideDevMenu',
    'hideDevMenuFab',
    'disableDevMenu',
    'disableFastRefresh',
    'hideDevMenu',
    'read',
  ]);
});

test('recovery: a floating button in front is cleared even with no menu to hide', async () => {
  const { calls, done } = recovery(noMenu, true);
  const env = parseEnvelope(await done);
  assert.equal(env.ok, true);
  assert.equal(env.data.executed, true);
  assert.ok(calls.includes('hideDevMenuFab'));
});

for (const surface of ['expo_dev_menu', 'react_native_dev_menu']) {
  test(`recovery: ${surface} must re-prove clearance even after a no-op hide`, async () => {
    const { calls, done } = recovery(noMenu, nativeOverlay(surface));
    const env = parseEnvelope(await done);
    assert.equal(env.ok, true);
    assert.equal(env.data.executed, true);
    assert.ok(calls.includes('hideDevMenuFab'));
    assert.equal(calls.filter((call) => call === 'read').length, 2);
  });
}

test('recovery: nothing to hide stays a no-op the walker does not count', async () => {
  const { calls, done } = recovery(noMenu, false);
  assert.equal(parseEnvelope(await done).data.executed, false);
  assert.deepEqual(calls, ['read', 'hideDevMenu']);
});

test('recovery: a failed dev-menu hide is returned as it is', async () => {
  const { calls, done } = recovery(
    () => failResult('not hidden', 'DEV_MENU_HIDE_UNVERIFIED'),
    true,
  );
  assert.equal(parseEnvelope(await done).code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.deepEqual(calls, ['read', 'hideDevMenu']);
});

// Android reloads the JS bundle whenever hot loading is set; the walk must not read the reloading app.
function reloading(
  disable: () => ToolResult = () => okResult({ action: 'disableFastRefresh', executed: true }),
  settled: () => Promise<void> = async () => {},
) {
  const calls: string[] = [];
  const deps = {
    async devSettings({ action }: { action: DevAction }) {
      calls.push(action);
      return action === 'disableFastRefresh' ? disable() : okResult({ action, executed: true });
    },
    async devOverlayUncleared() {
      calls.push('read');
      return false;
    },
    log: (message: string) => calls.push(`log ${message}`),
    sleep: async () => {},
    fastRefreshReload: {
      async mark() {
        calls.push('mark');
      },
      async settled() {
        calls.push('settled');
        await settled();
      },
    },
  };
  return { calls, deps };
}

test('overlays: a reloading Fast Refresh setting is marked before and proven settled before the menu hide and reads', async () => {
  const { calls, deps } = reloading();
  assert.equal(parseEnvelope(await clearDevOverlays(deps)).ok, true);
  assert.deepEqual(calls, [
    'hideDevMenuFab',
    'disableDevMenu',
    'mark',
    'disableFastRefresh',
    'settled',
    'hideDevMenu',
    'read',
  ]);
});

for (const [name, disable] of [
  ['unavailable', () => warnResult({ action: 'disableFastRefresh', executed: false }, 'none')],
  ['failed', () => failResult('Dev settings error: gone')],
] as [string, () => ToolResult][]) {
  test(`overlays: an ${name} Fast Refresh setting reloads nothing, so nothing waits on a reload`, async () => {
    const { calls, deps } = reloading(disable);
    assert.equal(parseEnvelope(await clearDevOverlays(deps)).ok, true);
    assert.ok(!calls.includes('settled'), calls.join());
    assert.equal(calls.at(-1), 'read');
  });
}

test('overlays: a reload that is never proven settled refuses before any later action or step', async () => {
  const { calls, deps } = reloading(undefined, async () => {
    throw Object.assign(new Error('the reload never finished'), { code: 'CDP_NOT_CONNECTED' });
  });
  await assert.rejects(clearDevOverlays(deps), /the reload never finished/);
  assert.equal(calls.at(-1), 'settled');
});

test('recovery: a reloading Fast Refresh setting is not sent again mid-walk', async () => {
  const { calls, deps } = reloading();
  let reads = 0;
  deps.devOverlayUncleared = async () => {
    calls.push('read');
    return reads++ === 0;
  };
  assert.equal(parseEnvelope(await recoverDevOverlays(deps)).ok, true);
  assert.deepEqual(calls, [
    'read',
    'hideDevMenu',
    'hideDevMenuFab',
    'disableDevMenu',
    'hideDevMenu',
    'read',
  ]);
});
