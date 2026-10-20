import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import {
  RunInputs,
  withInputs,
  InputPrivacyRefusal,
  withEchoScope,
  declareEcho,
} from '../../../dist/qa/inputs.js';
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

test("the filled field's own echo hashes as a constant", (t) => {
  const email = 'qa-synth-1234@example.test';
  const original = crypto.createHash;
  let calls = 0;
  t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
    calls++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const field = (label: string, over: Record<string, unknown> = {}) => [
      node,
      {
        ...node,
        index: 1,
        type: 'android.widget.EditText',
        identifier: 'login_email',
        label,
        ...over,
      },
    ];
    const hashWith = (values: Record<string, string>, label: string, over = {}, bind = true) => {
      const inputs = new RunInputs(values, Object.keys(values));
      if (bind) inputs.expectEcho('login_email');
      return withInputs(inputs, () => hashSnapshotNodes(field(label, over)));
    };
    calls = 0;
    const first = hashWith({ EMAIL: email, OTP: '482913' }, email);
    const second = hashWith(
      { EMAIL: 'other-user@example.test', OTP: '482913' },
      'other-user@example.test',
    );
    assert.equal(calls, 2);
    assert.equal(first, second);
    assert.notEqual(first, hashWith({ EMAIL: email, OTP: '482913' }, 'Email'));
    const nfc = 'caf\u00e9-synth-user';
    assert.equal(hashWith({ EMAIL: nfc }, nfc.normalize('NFD')), first);
    const quoted = 'left"right-synth';
    assert.equal(hashWith({ EMAIL: quoted }, JSON.stringify(quoted).slice(1, -1)), first);
    assert.equal(hashWith({ EMAIL: email, OTP: '482913' }, '4 8 2 9 1 3'), first);
    for (const [label, over, bind] of [
      [email, { identifier: 'welcome_label', type: 'android.widget.TextView' }, true],
      ['Email', { identifier: email }, true],
      [email, { identifier: undefined }, true],
      [email, {}, false],
    ] as const) {
      calls = 0;
      assert.throws(() => hashWith({ EMAIL: email }, label, over, bind), InputPrivacyRefusal);
      assert.equal(calls, 0);
    }
    const secure = { type: 'SecureTextField', identifier: 'login_password' };
    const dots = '\u2022'.repeat(8);
    assert.equal(
      hashWith({ EMAIL: email }, dots, secure),
      hashWith({ EMAIL: email }, dots, secure, false),
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('a registered fill target lets the runner snapshot hash and keep its refs', async () => {
  const digests: string[] = [];
  for (const value of ['qa-synth-1234@example.test', 'other-user@example.test']) {
    clearRefMap();
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
            data: { nodes: [node, { ...node, index: 1, identifier: 'login_email', label: value }] },
          }),
        ),
    );
    const inputs = new RunInputs({ EMAIL: value }, ['EMAIL']);
    inputs.expectEcho('login_email');
    await withInputs(inputs, () => runIOS({ command: 'snapshot', bundleId: 'com.test' }));
    const digest = getLastSnapshotHash();
    assert.equal(typeof digest, 'string');
    assert.equal(hasRefMap(), true);
    digests.push(digest!);
  }
  assert.equal(digests[0], digests[1]);
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
});

test('a declared echo hashes as a constant for this block only', (t) => {
  const email = 'qa-synth-1234@example.test';
  const original = crypto.createHash;
  let calls = 0;
  t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
    calls++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const hint = (label: string, over: Record<string, unknown> = {}) => [
      node,
      { ...node, index: 1, type: 'StaticText', identifier: 'code_hint', label, ...over },
    ];
    const run = <T>(values: Record<string, string>, operation: () => T): T =>
      withInputs(new RunInputs(values, Object.keys(values)), operation);
    const declared = (
      values: Record<string, string>,
      label: string,
      over = {},
      names = ['EMAIL'],
    ) =>
      run(values, () =>
        withEchoScope(() => {
          for (const name of names) declareEcho(name);
          return hashSnapshotNodes(hint(label, over));
        }),
      );
    const both = { EMAIL: email, OTP: '482913' };
    calls = 0;
    const first = declared(both, `We sent a code to ${email}`);
    assert.equal(calls, 1);
    const other = 'other-user@example.test';
    assert.equal(declared({ ...both, EMAIL: other }, `We sent a code to ${other}`), first);
    assert.notEqual(
      run(both, () => hashSnapshotNodes(hint('We sent a code to you'))),
      first,
    );
    const nfc = 'caf\u00e9-synth-user';
    assert.equal(declared({ EMAIL: nfc }, `We sent a code to ${nfc.normalize('NFD')}`), first);
    const quoted = 'left"right-synth';
    assert.equal(
      declared({ EMAIL: quoted }, `We sent a code to ${JSON.stringify(quoted).slice(1, -1)}`),
      first,
    );
    assert.equal(
      declared({ EMAIL: '482913' }, 'We sent a code to 4 8 2 9 1 3'),
      declared({ EMAIL: '771204' }, 'We sent a code to 7 7 1 2 0 4'),
    );
    const refusals: Array<() => unknown> = [
      () => run(both, () => hashSnapshotNodes(hint(`We sent a code to ${email}`))),
      () =>
        run(both, () => {
          withEchoScope(() => declareEcho('EMAIL'));
          return hashSnapshotNodes(hint(`We sent a code to ${email}`));
        }),
      () => declared(both, `Code 482913 sent to ${email}`),
      () => declared(both, 'Your code is 482913'),
      () => declared(both, 'Email', { identifier: email }),
      () => declared(both, 'Email', { type: email }),
    ];
    for (const refusal of refusals) {
      calls = 0;
      assert.throws(refusal, InputPrivacyRefusal);
      assert.equal(calls, 0);
    }
    const dots = '\u2022'.repeat(8);
    const secure = { type: 'SecureTextField', identifier: 'login_password' };
    assert.equal(
      declared(both, dots, secure),
      run(both, () => hashSnapshotNodes(hint(dots, secure))),
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('a declared echo lets the runner snapshot hash and keep its refs', async () => {
  const digests: string[] = [];
  for (const value of ['qa-synth-1234@example.test', 'other-user@example.test']) {
    clearRefMap();
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
            data: {
              nodes: [
                node,
                { ...node, index: 1, identifier: 'code_hint', label: `Code sent to ${value}` },
              ],
            },
          }),
        ),
    );
    await withInputs(new RunInputs({ EMAIL: value }, ['EMAIL']), () =>
      withEchoScope(() => {
        declareEcho('EMAIL');
        return runIOS({ command: 'snapshot', bundleId: 'com.test' });
      }),
    );
    const digest = getLastSnapshotHash();
    assert.equal(typeof digest, 'string');
    assert.equal(hasRefMap(), true);
    digests.push(digest!);
  }
  assert.equal(digests[0], digests[1]);
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
});

test('non-secret forms retain exact hash operands, even at a filled target or with a redundant echo', () => {
  const hashes: string[] = [];
  for (const value of [
    'fixture-canary',
    'other-fixture',
    'caf\u00e9-value',
    'cafe\u0301-value',
    'left"right',
    '123456',
  ]) {
    const inputs = new RunInputs({ FIXTURE: value }, ['FIXTURE'], undefined, ['FIXTURE']);
    inputs.expectEcho(node.identifier, 'FIXTURE');
    for (const field of ['label', 'identifier', 'type']) {
      const forms = [
        value,
        ` ${value} `,
        value.normalize('NFC'),
        value.normalize('NFD'),
        JSON.stringify(value).slice(1, -1),
        ...(value === '123456' ? ['12-34 56'] : []),
      ];
      for (const form of forms) {
        const nodes = [{ ...node, [field]: form }];
        const ordinary = hashSnapshotNodes(nodes);
        const actual = withInputs(inputs, () =>
          withEchoScope(() => {
            declareEcho('FIXTURE');
            return hashSnapshotNodes(nodes);
          }),
        );
        assert.equal(actual, ordinary, field);
        assert.equal(inputs.maskFilledEcho(nodes[0]), nodes[0]);
      }
    }
    hashes.push(withInputs(inputs, () => hashSnapshotNodes([{ ...node, label: value }])));
  }
  assert.notEqual(hashes[0], hashes[1]);
});

test('strict collisions win across equal, normalized, escaped, digit and mixed echoes', () => {
  for (const [strict, fixture, label] of [
    ['same-value', 'same-value', 'same-value'],
    ['caf\u00e9-value', 'cafe\u0301-value', 'cafe\u0301-value'],
    ['left"right', 'left\\"right', 'left\\"right'],
    ['123456', '12-34 56', '12-34 56'],
    ['strict-value', 'fixture-value', 'strict-value and fixture-value'],
  ]) {
    for (const field of ['label', 'identifier', 'type']) {
      const inputs = new RunInputs(
        { SECRET: strict, FIXTURE: fixture },
        ['SECRET', 'FIXTURE'],
        undefined,
        ['FIXTURE'],
      );
      inputs.expectEcho(node.identifier, 'FIXTURE');
      assert.throws(
        () =>
          withInputs(inputs, () =>
            withEchoScope(() => {
              declareEcho('FIXTURE');
              return hashSnapshotNodes([{ ...node, [field]: label }]);
            }),
          ),
        InputPrivacyRefusal,
      );
      assert.throws(() => inputs.assertHashSafe('ordinary fixture-value'), InputPrivacyRefusal);
    }
    const inputs = new RunInputs(
      { SECRET: strict, FIXTURE: fixture },
      ['SECRET', 'FIXTURE'],
      undefined,
      ['FIXTURE'],
    );
    withInputs(inputs, () =>
      withEchoScope(() => {
        declareEcho('SECRET');
        assert.equal(
          hashSnapshotNodes([{ ...node, label }]),
          hashSnapshotNodes([{ ...node, label: '[runtime input]' }]),
        );
      }),
    );
  }
});

test('non-secret snapshots retain runner refs and ordinary package and settle hashes', async () => {
  const { getLastSnapshotHashForPackage, updateRefMapFromFlat } =
    await import('../../../dist/fast-runner-ref-map.js');
  const { buildIosProbes, hashAndroidAppSnapshotNodes } =
    await import('../../../dist/lifecycle/settle.js');
  for (const value of ['first-fixture', 'second-fixture']) {
    const nodes = [{ ...node, label: value, packageName: 'com.test' }];
    const expected = hashSnapshotNodes(nodes);
    _setFastRunnerStateForTest({
      schemaVersion: 1,
      pid: process.pid,
      port: 22090,
      deviceId: 'TEST-UDID',
      bundleId: 'com.test',
      startedAt: '',
      protocolVersion: 1,
    });
    _setFetchForTest(async () => new Response(JSON.stringify({ ok: true, v: 1, data: { nodes } })));
    try {
      const inputs = new RunInputs({ FIXTURE: value }, ['FIXTURE'], undefined, ['FIXTURE']);
      await withInputs(inputs, async () => {
        await runIOS({ command: 'snapshot', bundleId: 'com.test' });
        assert.equal(hasRefMap(), true);
        assert.equal(getLastSnapshotHash(), expected);
        updateRefMapFromFlat(nodes);
        assert.equal(getLastSnapshotHashForPackage('com.test'), expected);
        assert.equal(await buildIosProbes('com.test').snapshotHash!(), expected);
        assert.equal(hashAndroidAppSnapshotNodes(nodes, 'com.test'), expected);
      });
    } finally {
      _setFetchForTest(globalThis.fetch);
      _setFastRunnerStateForTest(null);
      clearRefMap();
    }
  }
});
