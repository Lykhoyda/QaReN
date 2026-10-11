import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import {
  createDeviceAcceptSystemDialogHandler,
  createDeviceDismissSystemDialogHandler,
  _setFetchSnapshotNodesForTest,
  _resetFetchSnapshotNodesForTest,
  _setTapSystemAlertForTest,
  _resetTapSystemAlertForTest,
  _setRunMaestroInlineForTest,
  _resetRunMaestroInlineForTest,
  _setIosSessionActiveForTest,
  _resetIosSessionActiveForTest,
} from '../../../dist/handlers/device-system-dialog.js';
import { runMaestroInline } from '../../../dist/maestro-invoke.js';
import { spawnManagedProcessGroup } from '../../../dist/lifecycle/managed-automation.js';
import { buildReplayEngineStatus, MAESTRO_RUNNER_PIN } from '../../../dist/domain/engine-pin.js';
import { failResult, okResult } from '../../../dist/utils.js';

afterEach(() => {
  _resetFetchSnapshotNodesForTest();
  _resetTapSystemAlertForTest();
  _resetRunMaestroInlineForTest();
  _resetIosSessionActiveForTest();
});

function dialog() {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async (_allowCache, context) => {
    assert.ok(context, 'QA snapshot must carry the operation context');
    return {
      ok: true,
      nodes: [
        { ref: '@e0', type: 'Alert', label: 'Permission' },
        { ref: '@e1', type: 'Button', label: 'Allow' },
        { ref: '@e2', type: 'Button', label: 'OK' },
      ],
      provenance: { source: 'fresh', originAuthority: 'not-proven' },
    };
  });
  _setRunMaestroInlineForTest(async () => {
    assert.fail('inline fallback must not run');
  });
}

test('QA dialog does not probe another label after an erroring press', async () => {
  dialog();
  let presses = 0;
  _setTapSystemAlertForTest(async (_label, context) => {
    context!.authorize();
    presses++;
    return failResult('unknown press outcome', 'SYSTEM_ALERT_TAP_FAILED', { mutation: 'possible' });
  });
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    createDeviceAcceptSystemDialogHandler()({ platform: 'ios', qaContext: context }),
    /ACTION_OUTCOME_UNCERTAIN/,
  );
  assert.equal(presses, 1);
  assert.equal(context.authorizations, 1);
});

test('QA dialog notices a guard swallowed into a successful result', async () => {
  dialog();
  let now = 1;
  _setTapSystemAlertForTest(async (_label, context) => {
    now = 10;
    try {
      context!.authorize();
    } catch {
      /* Simulate a legacy handler swallowing the guard. */
    }
    return okResult({ tapped: true });
  });
  const context = new QaDispatchContext(10, () => now);
  await assert.rejects(
    createDeviceAcceptSystemDialogHandler()({ platform: 'ios', qaContext: context }),
    /EVIDENCE_EXPIRED/,
  );
  assert.equal(context.authorizations, 0);
});

test('QA dialog cannot use unknown snapshot as inline fallback authority', async () => {
  dialog();
  _setFetchSnapshotNodesForTest(async () => ({ ok: false, reason: 'fetch-failed' }));
  _setTapSystemAlertForTest(async () => {
    assert.fail('no snapshot, no press');
  });
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    createDeviceAcceptSystemDialogHandler()({ platform: 'ios', qaContext: context }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.equal(context.authorizations, 0);
});

test('actual inline spawn guard survives expiry after managed execution entry', async () => {
  let now = 1;
  let pins = 0;
  let spawns = 0;
  const context = new QaDispatchContext(10, () => now);
  const result = await runMaestroInline(
    '- tapOn: Continue',
    {
      platform: 'ios',
      appId: 'qa.app',
      qaContext: context,
    },
    {
      chooseDispatch: () => ({
        runner: 'maestro',
        binPath: '/fake/maestro',
        buildArgs: () => [],
      }),
      resolveEngineStatus: async () => {
        pins++;
        return buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false);
      },
      spawnManaged: (bin, args, options) => {
        now = 10;
        return spawnManagedProcessGroup(bin, args, options, {
          spawn: () => {
            spawns++;
            throw new Error('unexpected spawn');
          },
        });
      },
    },
  );
  assert.equal(pins, 2);
  assert.equal(spawns, 0);
  assert.equal(result.passed, false);
  assert.equal(context.authorizations, 0);
  assert.throws(() => context.assertComplete(), /EVIDENCE_EXPIRED/);
});

test('actual inline spawn consumes authorization even if spawn throws', async () => {
  let spawns = 0;
  const context = new QaDispatchContext(10, () => 1);
  const result = await runMaestroInline(
    '- tapOn: Continue',
    {
      platform: 'ios',
      appId: 'qa.app',
      qaContext: context,
    },
    {
      chooseDispatch: () => ({
        runner: 'maestro',
        binPath: '/fake/maestro',
        buildArgs: () => [],
      }),
      resolveEngineStatus: async () =>
        buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
      spawnManaged: (bin, args, options) =>
        spawnManagedProcessGroup(bin, args, options, {
          spawn: () => {
            spawns++;
            throw new Error('spawn outcome unknown');
          },
        }),
    },
  );
  assert.equal(spawns, 1);
  assert.equal(result.passed, false);
  assert.equal(context.authorizations, 1);
});

function permissionPrompt() {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async () => ({
    ok: true,
    nodes: [
      { ref: '@e0', type: 'Alert', label: 'Allow notifications?' },
      { ref: '@e1', type: 'Button', label: 'Don\u2019t Allow' },
      { ref: '@e2', type: 'Button', label: 'Allow' },
    ],
    provenance: { source: 'fresh', originAuthority: 'not-proven' },
  }));
  _setRunMaestroInlineForTest(async () => {
    assert.fail('a SpringBoard alert never falls back to a text tap');
  });
}

const RECT = { x: 57, y: 494, width: 140, height: 48 };

async function dismissWith(
  outcome: (label: string) => ReturnType<typeof okResult>,
): Promise<{ env: any; tapped: string[] }> {
  permissionPrompt();
  const tapped: string[] = [];
  _setTapSystemAlertForTest(async (label, context) => {
    context!.authorize();
    tapped.push(label);
    return outcome(label);
  });
  const result = await createDeviceDismissSystemDialogHandler()({
    platform: 'ios',
    qaContext: new QaDispatchContext(10, () => 1),
  });
  return { env: JSON.parse(result.content[0].text), tapped };
}

test('dismissing taps the SpringBoard button by its exact label and proves it with the closed alert', async () => {
  const { env, tapped } = await dismissWith((label) =>
    okResult({ tappedLabel: label, tappedRect: RECT, alertClosed: true }),
  );
  assert.deepEqual(tapped, ['Don\u2019t Allow']);
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.meta?.verify, 'exact');
  assert.equal(env.data.tappedLabel, 'Don\u2019t Allow');
  assert.deepEqual(env.data.tappedRect, RECT);
});

test('an alert still open after the tap refuses as unproven', async () => {
  const { env, tapped } = await dismissWith((label) =>
    okResult({ tappedLabel: label, tappedRect: RECT, alertClosed: false }),
  );
  assert.equal(tapped.length, 1);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DIALOG_TAP_UNPROVEN');
  assert.match(env.error, /stayed open/);
  assert.equal(env.meta?.mutation, 'observed');
});

test('a tapped label other than the chosen one refuses as unproven', async () => {
  const { env } = await dismissWith(() =>
    okResult({ tappedLabel: 'Allow', tappedRect: RECT, alertClosed: true }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DIALOG_TAP_UNPROVEN');
  assert.equal(env.meta?.mutation, 'observed');
});

test('a result without the runner proof fields refuses as unproven', async () => {
  const { env } = await dismissWith(() => okResult({ message: 'tapped' }));
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DIALOG_TAP_UNPROVEN');
});

test('a runner refusal before tapping keeps its code and probes no other label', async () => {
  const { env, tapped } = await dismissWith(() =>
    failResult(
      'SYSTEM_ALERT_BUTTON_NOT_FOUND: no such button; nothing was tapped',
      'SYSTEM_ALERT_BUTTON_NOT_FOUND',
      {
        mutation: 'none',
      },
    ),
  );
  assert.equal(tapped.length, 1);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'SYSTEM_ALERT_BUTTON_NOT_FOUND');
  assert.equal(env.meta?.mutation, 'none');
});

test('a button matching a known label only by identifier is never tapped, so recorded labels stay constants', async () => {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async () => ({
    ok: true,
    nodes: [
      { ref: '@e0', type: 'Alert', label: 'Prompt' },
      { ref: '@e1', type: 'Button', label: 'Typed by the user', identifier: 'Cancel' },
    ],
    provenance: { source: 'fresh', originAuthority: 'not-proven' },
  }));
  _setTapSystemAlertForTest(async () => assert.fail('no exact-label match, no tap'));
  const result = await createDeviceDismissSystemDialogHandler()({
    platform: 'ios',
    qaContext: new QaDispatchContext(10, () => 1),
  });
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.data.tapped, false);
  assert.equal(env.meta?.code, 'DIALOG_BUTTON_NOT_FOUND', JSON.stringify(env));
});
