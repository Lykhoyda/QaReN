import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { RunInputs, withInputs, InputPrivacyRefusal } from '../../../dist/qa/inputs.js';
import { createStop } from '../../../dist/qa/stop.js';
import {
  runIOS,
  _setFetchForTest,
  _setFastRunnerStateForTest,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { getLastSnapshotHash, hasRefMap, clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import { hashSnapshotNodes } from '../../../dist/lifecycle/settle-hash.js';
import { waitForSettle } from '../../../dist/lifecycle/settle.js';
import {
  settleAfterMutationWithOutcome,
  establishInteractionBaseline,
} from '../../../dist/agent-device-wrapper.js';
import { okResult } from '../../../dist/utils.js';

const node = {
  ref: '@e0',
  index: 0,
  type: 'Button',
  identifier: 'control',
  label: 'Ready',
  rect: { x: 0, y: 0, width: 40, height: 40 },
};

test('runner mapping refuses every private batch before crypto and invalidates refs', async (t) => {
  const values = [
    'SentinelValue',
    'left"right',
    'left\\right',
    'left\\nright',
    'caf\u00e9-secret',
    'cafe\u0301-secret',
  ];
  for (const value of values)
    for (const field of ['label', 'identifier', 'type']) {
      const echoes = [
        value,
        JSON.stringify(value).slice(1, -1),
        value.normalize('NFC'),
        value.normalize('NFD'),
        `\n\t${value}\n`,
      ];
      for (const echo of echoes) {
        clearRefMap();
        hashSnapshotNodes([node]);
        _setFastRunnerStateForTest({
          schemaVersion: 1,
          pid: process.pid,
          port: 22090,
          deviceId: 'TEST-UDID',
          bundleId: 'com.test',
          startedAt: '',
          protocolVersion: 1,
        });
        _setFetchForTest(
          async () =>
            new Response(
              JSON.stringify({
                ok: true,
                v: 1,
                data: { nodes: [node, { ...node, index: 1, [field]: echo }] },
              }),
            ),
        );
        const stop = createStop();
        const inputs = new RunInputs({ PASSWORD: value }, ['PASSWORD']);
        inputs.onRefusal((reason) => stop.begin(reason));
        let cryptoCalls = 0;
        const original = crypto.createHash;
        const spy = t.mock.method(
          crypto,
          'createHash',
          (...args: Parameters<typeof crypto.createHash>) => {
            cryptoCalls++;
            return original(...args);
          },
        );
        syncBuiltinESMExports();
        try {
          await withInputs(inputs, async () => {
            await assert.rejects(
              stop.track(() => runIOS({ command: 'snapshot', bundleId: 'com.test' })),
              InputPrivacyRefusal,
            );
            await assert.rejects(
              stop.track(async () => assert.fail('later dispatch/save')),
              InputPrivacyRefusal,
            );
          });
          assert.equal(cryptoCalls, 0, `${field}: no partial batch enters crypto`);
          assert.equal(stop.signal.reason.code, 'CORE_REFUSED');
          assert.equal(getLastSnapshotHash(), null);
          assert.equal(hasRefMap(), false);
          assert.ok(!String(stop.signal.reason).includes(value));
        } finally {
          spy.mock.restore();
          syncBuiltinESMExports();
        }
      }
    }
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
});

test('accepted hierarchy bytes and digest stay unchanged', () => {
  const expected = crypto
    .createHash('sha256')
    .update(JSON.stringify(['control', 'Button', 'Ready', 0, 0, 10, 10, null, null]))
    .update('\n')
    .digest('hex');
  const inputs = new RunInputs({ PASSWORD: 'absent-secret' }, ['PASSWORD']);
  assert.equal(
    withInputs(inputs, () => hashSnapshotNodes([node])),
    expected,
  );
});

test('privacy abort crosses settle and baseline catches without returning action success', async () => {
  for (const boundary of ['settle', 'mutation', 'baseline']) {
    const stop = createStop();
    const inputs = new RunInputs({ PASSWORD: 'absent-secret' }, ['PASSWORD']);
    inputs.onRefusal((reason) => stop.begin(reason));
    const probes = {
      snapshotHash: async () => {
        inputs.assertHashSafe('absent-secret');
        return 'unreachable';
      },
      sleep: async () => {},
      now: () => 0,
    };
    const deps = { enabled: () => true, capabilities: () => [], probes: () => probes };
    await assert.rejects(
      withInputs(inputs, () =>
        stop.track(() =>
          boundary === 'settle'
            ? waitForSettle({ platform: 'ios', capabilities: [], probes })
            : boundary === 'mutation'
              ? settleAfterMutationWithOutcome(
                  okResult({}),
                  { platform: 'ios', verb: 'fill' },
                  deps,
                )
              : establishInteractionBaseline(
                  { platform: 'ios' },
                  { verificationRequired: true },
                  deps,
                ),
        ),
      ),
      InputPrivacyRefusal,
    );
  }
});

test('whole-value guard refuses whole echoes and accepts partial ones', (t) => {
  const email = 'qa-user+tag@example.com';
  const original = crypto.createHash;
  let calls = 0;
  t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
    calls++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const ordinary = new RunInputs({ OTP: '4821', USERNAME: email }, ['OTP', 'USERNAME']);
    withInputs(ordinary, () =>
      hashSnapshotNodes([
        { ...node, label: 'Email' },
        { ...node, index: 1, identifier: 'com.example.app', type: 'Button', label: 'Code' },
      ]),
    );
    assert.equal(calls, 1);
    for (const [values, label] of [
      [{ OTP: '4821', USERNAME: email }, `Signed in as ${email}`],
      [{ OTP: '4821', USERNAME: email }, 'Code: 4 8 2 1'],
      [{ OTP: '4821', USERNAME: 'caf\u00e9-secret' }, 'user cafe\u0301-secret here'],
      [{ OTP: '4821', USERNAME: 'left"right' }, 'x left\\"right y'],
    ] as const) {
      calls = 0;
      const inputs = new RunInputs(values, Object.keys(values));
      assert.throws(
        () => withInputs(inputs, () => hashSnapshotNodes([node, { ...node, index: 1, label }])),
        InputPrivacyRefusal,
      );
      assert.equal(calls, 0);
    }
    for (const [values, label] of [
      [{ USERNAME: email }, 'q\u2022\u2022\u2022@example.com'],
      [{ CARD: '4111222233334444' }, 'card \u2022\u2022\u2022\u2022 4444'],
    ] as const) {
      const inputs = new RunInputs(values, Object.keys(values));
      withInputs(inputs, () => hashSnapshotNodes([{ ...node, label }]));
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
