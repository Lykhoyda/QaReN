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
import { nativeDevOverlayObservation, type NativeObservation } from '../../dist/qa/capture.js';

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
    assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED_EVALUATE_FAILED');
    if (name !== 'a rejected preferences call') assert.equal(calls[0].value, 'unverified');
    assert.match(
      env.error ?? '',
      name === 'a rejected preferences call'
        ? /the preferences call failed/
        : /the preferences did not read back hidden/,
    );
  });
}

test('D4: the walk closes an open menu before changing preferences', () => {
  assert.deepEqual(
    [...WALK_DEV_SETTINGS],
    ['hideDevMenu', 'hideDevMenuFab', 'disableDevMenu', 'disableFastRefresh'],
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

type Overlay = ReturnType<typeof nativeDevOverlayObservation>;

function overlays(
  reads: Array<Overlay | Error> = [{ state: 'clear', front: 'app' }],
  settings: Partial<Record<DevAction, () => ToolResult>> = {},
  budgetMs = 2000,
) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const controller = new AbortController();
  let clock = Math.ceil(performance.now());
  const deps = {
    deadline: clock + budgetMs,
    now: () => clock,
    async devSettings({ action, timeoutMs }: { action: DevAction; timeoutMs?: number }) {
      assert.ok(timeoutMs! <= budgetMs);
      calls.push(action);
      return settings[action]?.() ?? okResult({ action, executed: true });
    },
    async observeDevOverlay(): Promise<Overlay> {
      calls.push('read');
      const result = reads.length > 1 ? reads.shift()! : reads[0];
      if (result instanceof Error) throw result;
      return result;
    },
    log: (message: string) => calls.push(`log ${message}`),
    async sleep(ms: number) {
      sleeps.push(ms);
      clock += ms;
    },
  };
  const run = (recover = false) =>
    withCancellation(controller.signal, () =>
      recover ? recoverDevOverlays(deps) : clearDevOverlays(deps),
    );
  return { calls, sleeps, deps, controller, run };
}

const clear: Overlay = { state: 'clear', front: 'app' };
const unknown: Overlay = { state: 'unknown', error: 'coverage_incomplete' };
const shown: Overlay = { state: 'shown', front: 'dev-fab' };

test('overlays: a failed read and incomplete evidence retry until complete app evidence', async () => {
  const fixture = overlays([new Error('private runner error'), unknown, clear]);
  assert.equal(parseEnvelope(await fixture.run()).ok, true);
  assert.equal(fixture.calls.filter((call) => call === 'read').length, 3);
  assert.deepEqual(fixture.sleeps, [250, 250]);
  assert.deepEqual(fixture.calls.slice(0, 4), [...WALK_DEV_SETTINGS]);
});

test('overlays: four incomplete reads do not exhaust the remaining startup budget', async () => {
  const fixture = overlays([unknown, unknown, unknown, unknown, clear]);
  assert.equal(parseEnvelope(await fixture.run()).ok, true);
  assert.equal(fixture.calls.filter((call) => call === 'read').length, 5);
});

test('overlays: complete chrome at deadline refuses as NOT_HIDDEN', async () => {
  const fixture = overlays([shown], {}, 500);
  const env = parseEnvelope(await fixture.run());
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED_NOT_HIDDEN');
  assert.match(env.error, /front=dev-fab/);
  assert.equal(fixture.calls.filter((call) => call === 'read').length, 2);
});

test('overlays: shown then unknown at deadline reports the latest evidence', async () => {
  const fixture = overlays([shown, unknown], {}, 500);
  const env = parseEnvelope(await fixture.run());
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED_READ_FAILED');
  assert.match(env.error, /last_error=coverage_incomplete/);
  assert.doesNotMatch(env.error, /front=dev/);
});

test('overlays: permanent failed reads expose only their class and stop at the deadline', async () => {
  const fixture = overlays([new Error('private runner error')], {}, 620);
  const env = parseEnvelope(await fixture.run());
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED_READ_FAILED');
  assert.match(env.error, /reads=3; evaluations=1; elapsed_ms=620; last_error=other/);
  assert.doesNotMatch(env.error, /private runner error/);
  assert.deepEqual(fixture.sleeps, [250, 250, 120]);
});

test('overlays: fading chrome is retried and still needs complete clear evidence', async () => {
  assert.equal(parseEnvelope(await overlays([shown, shown, clear]).run()).ok, true);
});

for (const [surface, changes, state] of [
  ['app', {}, 'clear'],
  ['expo_dev_menu', {}, 'shown'],
  ['react_native_dev_menu', {}, 'shown'],
  ['app', { truncated: true }, 'unknown'],
  ['app', { snapshotVerdict: undefined }, 'unknown'],
  ['unknown', {}, 'clear'],
  ['unrecognized', {}, 'clear'],
  ['dev_client_picker', {}, 'clear'],
] as const) {
  test(`observation: ${surface} with ${JSON.stringify(changes)} is ${state}`, () => {
    assert.equal(
      nativeDevOverlayObservation({ ...nativeOverlay(surface), ...changes }).state,
      state,
    );
  });
}

for (const subreason of ['EVALUATE_TIMEOUT', 'EVALUATE_FAILED'] as const) {
  test(`overlays: three failing FAB evaluations preserve ${subreason}`, async () => {
    const fixture = overlays([clear], {
      hideDevMenuFab: () =>
        failResult('private evaluation detail', `DEV_MENU_HIDE_UNVERIFIED_${subreason}`),
    });
    const env = parseEnvelope(await fixture.run());
    assert.equal(env.code, `DEV_MENU_HIDE_UNVERIFIED_${subreason}`);
    assert.doesNotMatch(env.error, /private evaluation detail/);
    assert.equal(fixture.calls.filter((call) => call === 'hideDevMenuFab').length, 3);
    assert.ok(!fixture.calls.includes('read'));
  });
}

test('overlays: transient FAB evaluation failure retries before native proof', async () => {
  let attempt = 0;
  const fixture = overlays([clear], {
    hideDevMenuFab: () =>
      attempt++ === 0
        ? failResult('timeout', 'DEV_MENU_HIDE_UNVERIFIED_EVALUATE_TIMEOUT')
        : okResult({ executed: true }),
  });
  assert.equal(parseEnvelope(await fixture.run()).ok, true);
  assert.equal(attempt, 2);
});

test('overlays: an unavailable preferences module still requires native proof', async () => {
  const fixture = overlays([clear], {
    hideDevMenuFab: () => warnResult({ executed: false }, 'no module'),
  });
  assert.equal(parseEnvelope(await fixture.run()).ok, true);
  assert.equal(fixture.calls.at(-1), 'read');
});

test('overlays: cancellation blocks the next action', async () => {
  const fixture = overlays();
  fixture.deps.devSettings = async ({ action }) => {
    fixture.calls.push(action);
    fixture.controller.abort(new RunCancelledError());
    return okResult({ executed: true });
  };
  await assert.rejects(fixture.run(), /RUN_CANCELLED/);
  assert.deepEqual(fixture.calls, ['hideDevMenu']);
});

test('overlays: authority errors are never treated as uncertain reads', async () => {
  const { SessionAuthorityError } = await import('../../dist/domain/authority-error.js');
  const authority = new SessionAuthorityError('SESSION_OWNER_LOST', 'owner gone');
  const fixture = overlays([authority]);
  await assert.rejects(fixture.run(), (error) => error === authority);
});

test('recovery: complete clear evidence and a no-op hide stay a no-op', async () => {
  const fixture = overlays([clear], {
    hideDevMenu: () => okResult({ executed: false }),
  });
  assert.equal(parseEnvelope(await fixture.run(true)).data.executed, false);
  assert.deepEqual(fixture.calls, ['read', 'hideDevMenu']);
});

test('recovery: unknown evidence re-proves clearance after hiding', async () => {
  const fixture = overlays([unknown, clear]);
  assert.equal(parseEnvelope(await fixture.run(true)).ok, true);
  assert.equal(fixture.calls.filter((call) => call === 'hideDevMenu').length, 1);
  assert.equal(fixture.calls.at(-1), 'read');
});

test('Android: Fast Refresh reload is marked and proven; recovery never repeats it', async () => {
  for (const recover of [false, true]) {
    const fixture = overlays(recover ? [shown, clear] : [clear]);
    const deps = {
      ...fixture.deps,
      fastRefreshReload: {
        async mark() {
          fixture.calls.push('mark');
        },
        async settled() {
          fixture.calls.push('settled');
        },
      },
    };
    assert.equal(
      parseEnvelope(await (recover ? recoverDevOverlays(deps) : clearDevOverlays(deps))).ok,
      true,
    );
    if (recover) {
      assert.ok(!fixture.calls.includes('disableFastRefresh'));
      assert.ok(!fixture.calls.includes('mark'));
    } else {
      const mark = fixture.calls.indexOf('mark');
      assert.deepEqual(fixture.calls.slice(mark, mark + 3), [
        'mark',
        'disableFastRefresh',
        'settled',
      ]);
    }
  }
});

test('Android: an unproven reload aborts before native proof', async () => {
  const fixture = overlays();
  await assert.rejects(
    clearDevOverlays({
      ...fixture.deps,
      fastRefreshReload: {
        async mark() {},
        async settled() {
          throw new Error('reload unproven');
        },
      },
    }),
    /reload unproven/,
  );
  assert.ok(!fixture.calls.includes('read'));
});

test('observation: a complete permission dialog is clear for overlay admission', async () => {
  const observation = nativeDevOverlayObservation({
    ...nativeOverlay('unknown'),
    nodes: [{ ref: 'e0', index: 0, type: 'Alert', packageName: 'com.apple.springboard' }],
  });
  assert.deepEqual(observation, { state: 'clear', front: 'dialog' });
  assert.equal(parseEnvelope(await overlays([observation]).run()).ok, true);
});

test('observation: keyboard and known foreign surfaces do not become dev chrome', () => {
  for (const type of ['Keyboard', 'Application'])
    assert.equal(
      nativeDevOverlayObservation({
        ...nativeOverlay('unknown'),
        nodes: [{ ref: 'e0', index: 0, type, packageName: 'com.android.permissioncontroller' }],
      }).state,
      'clear',
    );
});

test('overlays: a proven app exit is terminal and never retried as unknown', async () => {
  const { AppProcessGoneError } = await import('../../dist/domain/app-process.js');
  const gone = new AppProcessGoneError();
  const fixture = overlays([gone]);
  await assert.rejects(fixture.run(), (error) => error === gone);
  assert.equal(fixture.calls.filter((call) => call === 'read').length, 1);
  assert.deepEqual(fixture.sleeps, []);
});

for (const subreason of ['EVALUATE_TIMEOUT', 'EVALUATE_FAILED'] as const) {
  test(`overlays: deadline between FAB attempts preserves ${subreason}`, async () => {
    const fixture = overlays(
      [clear],
      {
        hideDevMenuFab: () => failResult('opaque', `DEV_MENU_HIDE_UNVERIFIED_${subreason}`),
      },
      200,
    );
    const env = parseEnvelope(await fixture.run());
    assert.equal(env.code, `DEV_MENU_HIDE_UNVERIFIED_${subreason}`);
    assert.equal(fixture.calls.filter((call) => call === 'hideDevMenuFab').length, 1);
  });
}

test('recovery: a failed menu hide is returned unchanged', async () => {
  const failed = failResult('menu close failed', 'DEV_MENU_HIDE_FAILED');
  const fixture = overlays([shown], { hideDevMenu: () => failed });
  assert.equal(await fixture.run(true), failed);
});
