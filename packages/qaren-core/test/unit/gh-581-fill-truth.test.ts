// GH #581: device_fill truth matrix — exact binding, single-operation native
// dispatch, exact verification, mutation-safe correction, and secret
// scrubbing, driven through the runNative seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { createDeviceFillHandler, performExactFill, extractTypingMeta } =
  await import('../../dist/handlers/device-interact.js');
const { _setMaestroInlineObserverForTest, runMaestroInline } =
  await import('../../dist/maestro-invoke.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');
const { HandlerError, fillEvidence, unwrap } = await import('../../dist/qa/adapt.js');
const { QaDispatchContext } = await import('../../dist/domain/qa-dispatch.js');

const NODES = [
  {
    ref: '@e1',
    identifier: 'first-name-pressable',
    type: 'Other',
    rect: { x: 20, y: 100, width: 360, height: 60 },
  },
  {
    ref: '@e2',
    identifier: 'first-name',
    type: 'TextField',
    rect: { x: 40, y: 110, width: 320, height: 40 },
  },
  {
    ref: '@e3',
    identifier: 'last-name',
    type: 'TextField',
    rect: { x: 40, y: 180, width: 320, height: 40 },
  },
  {
    ref: '@e4',
    identifier: 'password',
    type: 'SecureTextField',
    rect: { x: 40, y: 250, width: 320, height: 40 },
  },
  {
    ref: '@e5',
    identifier: 'submit',
    type: 'Button',
    rect: { x: 40, y: 320, width: 320, height: 40 },
  },
];

interface Call {
  cliArgs: string[];
  opts: Record<string, unknown>;
}

interface SeamConfig {
  platform?: 'ios' | 'android';
  nodes?: typeof NODES;
  snapshot?: (count: number) => typeof NODES;
  fill?: (call: Call, fillCount: number) => ReturnType<typeof okResult>;
  verify?: (call: Call, verifyCount: number) => ReturnType<typeof okResult>;
}

async function withFillSeam<T>(
  config: SeamConfig,
  run: () => Promise<T>,
): Promise<{ result: T; calls: Call[] }> {
  const platform = config.platform ?? 'ios';
  _setActiveSessionForTest({ platform, deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  const nodes = config.nodes ?? NODES;
  updateRefMapFromFlat(nodes as never, { snapshotGeneration: 7, keyboardVisible: false });
  const calls: Call[] = [];
  let fillCount = 0;
  let verifyCount = 0;
  let snapshotCount = 0;
  let lastFill: { target: string; text: string } | null = null;
  _setRunAgentDeviceForTest(async (cliArgs: string[], opts: Record<string, unknown>) => {
    const call = { cliArgs, opts };
    calls.push(call);
    if (cliArgs[0] === 'snapshot') {
      snapshotCount += 1;
      const snapshotNodes = config.snapshot?.(snapshotCount) ?? nodes;
      updateRefMapFromFlat(snapshotNodes as never, {
        snapshotGeneration: 6 + snapshotCount,
        keyboardVisible: false,
      });
      return okResult({ nodes: snapshotNodes });
    }
    if (cliArgs[0] === 'fill') {
      fillCount += 1;
      lastFill = { target: cliArgs[1], text: cliArgs[2] };
      return config.fill
        ? config.fill(call, fillCount)
        : okResult({ typed: true, focusTap: 'performed', inputResolution: 'descriptor' });
    }
    if (cliArgs[0] === 'verify-input') {
      verifyCount += 1;
      if (config.verify) return config.verify(call, verifyCount);
      // The default oracle only reports exact for the value/target the fill
      // actually dispatched — a wrong-value verification can never pass it.
      const matchesFill =
        lastFill !== null && cliArgs[1] === lastFill.target && cliArgs[2] === lastFill.text;
      return matchesFill
        ? okResult({ verifyVerdict: 'exact', verifyStable: true })
        : okResult({ verifyVerdict: 'mismatch', verifyStable: true });
    }
    return okResult({});
  });
  try {
    const result = await run();
    return { result, calls };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

function envelope(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

const NATIVE_ONLY = {};

function fakeClient(handlers: {
  read?: () => { value?: string | null; controlled?: boolean } | null;
  typeText?: () => Record<string, unknown>;
}) {
  return {
    isConnected: true,
    evaluate: async (expr: string) => {
      if (expr.includes('readInputValue')) {
        const read = handlers.read?.();
        if (!read) return { error: 'unreadable' };
        return {
          value: JSON.stringify({ value: read.value ?? null, controlled: read.controlled ?? true }),
        };
      }
      if (expr.includes('typeText')) {
        const result = handlers.typeText?.() ?? { error: 'no handler' };
        return {
          value: JSON.stringify(
            result.error || result.handlerCalled === false
              ? result
              : { bindingId: 'ttb:test:1', ...result },
          ),
        };
      }
      return { value: JSON.stringify({}) };
    },
  } as never;
}

test('gh-581: wrapper binds its inner input and dispatches one exact native operation', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e1', text: 'Anna' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError, envelope(result as never).error);
  const env = envelope(result as never);
  assert.deepEqual(env.data, { filled: true, method: 'native', length: 4 });
  assert.equal(env.meta.verify, 'exact');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'press'), 'no separate pre-tap press');
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.equal(fill.cliArgs[1], '@e2', 'fill targets the inner input, not the wrapper');
  const exactTarget = fill.opts.exactTarget as Record<string, number | string>;
  assert.equal(exactTarget.inputRef, '@e2');
  assert.equal(exactTarget.focusX, 200, 'focus tap is the wrapper center');
  assert.equal(exactTarget.focusY, 130);
  const verify = calls.find((c) => c.cliArgs[0] === 'verify-input')!;
  assert.equal(verify.cliArgs[1], '@e2');
});

test('gh-581: direct testID ref binds without a wrapper', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: 'last-name', text: 'Ng' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError);
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.equal(fill.cliArgs[1], '@e3');
  assert.equal((fill.opts.exactTarget as { focusX: number }).focusX, 200);
});

test('gh-581: final verification uses the fill operation token after ref recycling', async () => {
  const replacement = NODES.map((node) =>
    node.identifier === 'last-name'
      ? { ...node, ref: '@e8', identifier: 'replacement-name' }
      : node,
  );
  const { result, calls } = await withFillSeam(
    {
      fill: (call) => {
        updateRefMapFromFlat(replacement as never, {
          snapshotGeneration: 8,
          keyboardVisible: false,
        });
        return okResult({ typed: true, operationToken: call.opts.exactTarget });
      },
      verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'Ng' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError, envelope(result as never).error);
  const fill = calls.find((call) => call.cliArgs[0] === 'fill')!;
  const verify = calls.find((call) => call.cliArgs[0] === 'verify-input')!;
  const fillTarget = fill.opts.exactTarget as { inputRef: string; operationToken: string };
  const verifyTarget = verify.opts.exactTarget as { inputRef: string; operationToken: string };
  assert.equal(verify.cliArgs[1], '@e3');
  assert.equal(verifyTarget.inputRef, '@e3');
  assert.ok(fillTarget.operationToken.length > 0);
  assert.equal(verifyTarget.operationToken, fillTarget.operationToken);
});

test('gh-581: duplicate wrapper mapping rejects without mutation', async () => {
  const nodes = [
    ...NODES,
    {
      ref: '@e9',
      identifier: 'first-name',
      type: 'TextField',
      rect: { x: 40, y: 400, width: 320, height: 40 },
    },
  ];
  const { result, calls } = await withFillSeam({ nodes }, () =>
    performExactFill({ ref: '@e1', text: 'Anna' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TARGET_AMBIGUOUS');
  assert.equal(env.meta.mutation, 'none');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'), 'no mutation dispatched');
});

test('gh-581: duplicate direct testIDs reject without mutation', async () => {
  const nodes = [
    ...NODES,
    {
      ref: '@e9',
      identifier: 'last-name',
      type: 'TextField',
      rect: { x: 40, y: 400, width: 320, height: 40 },
    },
  ];
  const { result, calls } = await withFillSeam({ nodes }, () =>
    performExactFill({ ref: 'last-name', text: 'x' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(result as never).code, 'TARGET_AMBIGUOUS');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

for (const [name, ref, duplicateIndex] of [
  ['positional input', '@e3', 2],
  ['direct input ID', 'last-name', 2],
  ['positional wrapper', '@e1', 0],
  ['wrapper inner input', 'first-name-pressable', 1],
] as const) {
  test(`gh-581: QA ${name} preserves ambiguity when a twin appears at binding`, async () => {
    const context = new QaDispatchContext(10, () => 1);
    const { result, calls } = await withFillSeam(
      {
        snapshot: () => [
          ...NODES,
          {
            ...NODES[duplicateIndex],
            ref: '@e9',
            rect: { x: 40, y: 400, width: 320, height: 40 },
          },
        ],
      },
      () => createDeviceFillHandler(() => null as never)({ ref, text: 'x', qaContext: context }),
    );
    const env = envelope(result);
    assert.equal(env.code, 'TARGET_AMBIGUOUS');
    assert.equal(env.meta.mutation, 'none');
    assert.deepEqual(env.meta.pathsTried, []);
    assert.deepEqual(
      calls.map((call) => call.cliArgs[0]),
      ['snapshot'],
    );
    assert.doesNotThrow(() => context.assertComplete());
  });
}

test('gh-581: QA unique bindings still fill and verify without invalidation', async () => {
  for (const ref of ['@e3', 'last-name', '@e1', 'first-name-pressable']) {
    const context = new QaDispatchContext(10, () => 1);
    const { result, calls } = await withFillSeam({}, () =>
      createDeviceFillHandler(() => null as never)({ ref, text: 'x', qaContext: context }),
    );
    assert.equal(envelope(result).ok, true, ref);
    assert.deepEqual(
      calls.map((call) => call.cliArgs[0]),
      ['snapshot', 'fill', 'verify-input'],
    );
    assert.doesNotThrow(() => context.assertComplete());
  }
});

test('gh-581: a non-input ref rejects instead of typing into ambient focus', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e5', text: 'x' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('gh-581: unverifiable outcome is an error, never filled:true', async () => {
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'unreadable', verifyStable: false }) },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'possible');
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1, 'no blind retype');
});

test('gh-581: unstable native exact never promotes to success', async () => {
  const { result } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'exact', verifyStable: false }) },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(result as never).code, 'TEXT_ENTRY_UNVERIFIED');
});

test('gh-581: stable mismatch refuses after one native mutation on iOS and Android', async () => {
  const fixtures = [
    { platform: 'ios' as const, nodes: NODES, ref: '@e3' },
    {
      platform: 'android' as const,
      nodes: [
        {
          ref: '@e3',
          identifier: 'last-name',
          type: 'android.widget.EditText',
          rect: { x: 40, y: 180, width: 320, height: 40 },
        },
      ] as typeof NODES,
      ref: '@e3',
    },
  ];
  for (const fixture of fixtures) {
    const { result, calls } = await withFillSeam(
      {
        platform: fixture.platform,
        nodes: fixture.nodes,
        verify: () => okResult({ verifyVerdict: 'mismatch', verifyStable: true }),
      },
      () => performExactFill({ ref: fixture.ref, text: 'value' }, null, NATIVE_ONLY),
    );
    const env = envelope(result as never);
    const fills = calls.filter((call) => call.cliArgs[0] === 'fill');
    const verifies = calls.filter((call) => call.cliArgs[0] === 'verify-input');
    assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED', fixture.platform);
    assert.equal(env.meta.mutation, 'observed', fixture.platform);
    assert.deepEqual(env.meta.pathsTried, ['native'], fixture.platform);
    assert.equal(fills.length, 1, fixture.platform);
    assert.equal(verifies.length, 1, fixture.platform);
    assert.equal(
      (verifies[0].opts.exactTarget as { operationToken: string }).operationToken,
      (fills[0].opts.exactTarget as { operationToken: string }).operationToken,
      fixture.platform,
    );
  }
});

test('gh-581: stable mismatch on A cannot mutate replacement B with the same identity fields', async () => {
  const replacement = NODES.map((node) =>
    node.identifier === 'last-name' ? { ...node, ref: '@e8' } : node,
  );
  let replacementMutations = 0;
  const { result, calls } = await withFillSeam(
    {
      fill: (_call, fillCount) => {
        if (fillCount > 1) replacementMutations += 1;
        updateRefMapFromFlat(replacement as never, {
          snapshotGeneration: 9,
          keyboardVisible: false,
        });
        return okResult({ typed: true });
      },
      verify: () => okResult({ verifyVerdict: 'mismatch', verifyStable: true }),
      snapshot: (count) => (count === 1 ? NODES : replacement),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  const fills = calls.filter((call) => call.cliArgs[0] === 'fill');
  const verifies = calls.filter((call) => call.cliArgs[0] === 'verify-input');
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.equal(fills.length, 1);
  assert.equal(replacementMutations, 0);
  assert.equal(calls.filter((call) => call.cliArgs[0] === 'snapshot').length, 1);
  assert.equal(
    (verifies[0].opts.exactTarget as { operationToken: string }).operationToken,
    (fills[0].opts.exactTarget as { operationToken: string }).operationToken,
  );
});

test('gh-581: a stable mismatch cannot dispatch a second native mutation', async () => {
  const { result, calls } = await withFillSeam(
    {
      fill: (_call, fillCount) =>
        fillCount === 1
          ? okResult({ typed: true })
          : failResult('target moved', 'FOCUS_TARGET_OCCLUDED', { mutation: 'none' }),
      verify: () => okResult({ verifyVerdict: 'mismatch', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.equal(calls.filter((call) => call.cliArgs[0] === 'fill').length, 1);
});

test('gh-581: secure uncontrolled masked value hard-fails and is not retried', async () => {
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'secure-masked', verifyStable: true }) },
    () => performExactFill({ ref: '@e4', text: 'value-a' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
  const verify = calls.find((c) => c.cliArgs[0] === 'verify-input')!;
  assert.equal((verify.opts.exactTarget as { secure?: boolean }).secure, true);
});

test('I5: the real fill envelope carries the evidence class the walker maps', async () => {
  const cases = [
    { verdict: 'secure-masked', stable: true, expected: 'masked' },
    { verdict: 'secure-masked', stable: false, expected: 'unavailable' },
    { verdict: 'mismatch', stable: true, expected: 'mismatch' },
    { verdict: 'mismatch', stable: false, expected: 'unavailable' },
    { verdict: 'ambiguous', stable: true, expected: 'unavailable' },
    { verdict: 'target-lost', stable: false, expected: 'unavailable' },
    { verdict: 'unreadable', stable: true, expected: 'unavailable' },
  ];
  for (const { verdict, stable, expected } of cases) {
    const { result } = await withFillSeam(
      { verify: () => okResult({ verifyVerdict: verdict, verifyStable: stable }) },
      () => performExactFill({ ref: '@e4', text: 'value-a' }, null, NATIVE_ONLY),
    );
    let caught: unknown;
    try {
      unwrap(result as never);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof HandlerError, verdict);
    assert.equal(fillEvidence(caught), expected, `${verdict} stable=${stable}`);
  }
  assert.equal(fillEvidence(new Error('TEXT_ENTRY_UNVERIFIED: x')), undefined);
});

test('gh-581: ambiguous and target-lost verdicts hard-fail without retype', async () => {
  for (const verdict of ['ambiguous', 'target-lost']) {
    const { result, calls } = await withFillSeam(
      { verify: () => okResult({ verifyVerdict: verdict, verifyStable: true }) },
      () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
    );
    assert.equal(envelope(result as never).code, 'TEXT_ENTRY_UNVERIFIED', verdict);
    assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1, verdict);
  }
});

test('gh-581: runner refusal with mutation none maps to NO_TEXT_INPUT_TARGET', async () => {
  const { result } = await withFillSeam(
    {
      fill: () =>
        failResult('NO_TEXT_INPUT_TARGET: gone', 'NO_TEXT_INPUT_TARGET', { mutation: 'none' }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
});

test('gh-581: occluded focus preserves its mutation-free refusal code', async () => {
  const { result } = await withFillSeam(
    {
      fill: () =>
        failResult('focus point is occluded', 'FOCUS_TARGET_OCCLUDED', { mutation: 'none' }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'FOCUS_TARGET_OCCLUDED');
  assert.equal(env.meta.mutation, 'none');
});

test('gh-581: possibly-mutating runner failure recovers ONLY via exact read-back', async () => {
  const recovered = await withFillSeam(
    {
      fill: () => failResult('timeout', 'RUNNER_TIMEOUT', { mutation: 'possible' }),
      verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const recoveredEnv = envelope(recovered.result as never);
  assert.equal(recoveredEnv.data.filled, true);
  assert.equal(recoveredEnv.meta.recovered, 'post-error-exact-readback');
  assert.equal(recovered.calls.filter((c) => c.cliArgs[0] === 'fill').length, 1, 'never resent');

  const unproven = await withFillSeam(
    {
      fill: () => failResult('timeout', 'RUNNER_TIMEOUT', { mutation: 'possible' }),
      verify: () => okResult({ verifyVerdict: 'unreadable', verifyStable: false }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const unprovenEnv = envelope(unproven.result as never);
  assert.equal(unprovenEnv.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(unprovenEnv.meta.mutation, 'possible');
  assert.equal(unproven.calls.filter((c) => c.cliArgs[0] === 'fill').length, 1, 'never resent');
});

test('gh-581: unlabeled runner failure defaults to possible mutation (no blind descent)', async () => {
  const { result, calls } = await withFillSeam(
    {
      fill: () => failResult('mystery failure'),
      verify: () => okResult({ verifyVerdict: 'unreadable', verifyStable: false }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(result as never).code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('gh-581: empty text is a verified clear (clear-first dispatch + exact empty read-back)', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e3', text: '' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError);
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.ok(fill.cliArgs.includes('--clear-first'));
  const env = envelope(result as never);
  assert.deepEqual(env.data, { filled: true, method: 'native', length: 0 });
  const verify = calls.find((c) => c.cliArgs[0] === 'verify-input')!;
  assert.equal(verify.cliArgs[2], '');
});

test('a strict fill replaces an already-filled field and verifies the exact plan text', async () => {
  for (const [initial, text] of [
    ['Ada', 'Grace'],
    ['', 'Grace'],
    ['Ada', ''],
  ]) {
    let field = initial;
    const { result, calls } = await withFillSeam(
      {
        fill: (call) => {
          const typed = call.cliArgs[2];
          field = call.cliArgs.includes('--clear-first') ? typed : field + typed;
          return okResult({ typed: true, focusTap: 'performed', inputResolution: 'descriptor' });
        },
        verify: (call) =>
          okResult({
            verifyVerdict: call.cliArgs[2] === field ? 'exact' : 'mismatch',
            verifyStable: true,
          }),
      },
      () => performExactFill({ ref: '@e3', text }, null, NATIVE_ONLY),
    );
    assert.ok(!(result as { isError?: boolean }).isError, `${initial} -> ${text}`);
    assert.equal(field, text, `${initial} -> ${text}`);
    assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
  }
});

test('gh-581: rejected native A never rebinds to replacement B with the same testID', async () => {
  const replacement = NODES.map((node) =>
    node.identifier === 'last-name' ? { ...node, ref: '@e8' } : node,
  );
  let replacementMutations = 0;
  let maestroInvocations = 0;
  _setMaestroInlineObserverForTest(() => {
    maestroInvocations += 1;
  });
  try {
    const { result, calls } = await withFillSeam(
      {
        fill: (call) => {
          if (call.cliArgs[1] === '@e8') replacementMutations += 1;
          updateRefMapFromFlat(replacement as never, {
            snapshotGeneration: 9,
            keyboardVisible: false,
          });
          return failResult('rejected', 'SET_TEXT_REJECTED', { mutation: 'none' });
        },
        snapshot: (count) => (count === 1 ? NODES : replacement),
      },
      () => createDeviceFillHandler(() => null as never)({ ref: '@e3', text: 'value' }),
    );
    const env = envelope(result as never);
    const fills = calls.filter((call) => call.cliArgs[0] === 'fill');
    const verifies = calls.filter((call) => call.cliArgs[0] === 'verify-input');
    assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, 'none');
    assert.deepEqual(env.meta.pathsTried, ['native']);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].cliArgs[1], '@e3');
    assert.equal(replacementMutations, 0);
    assert.equal(maestroInvocations, 0);
    assert.equal(calls.filter((call) => call.cliArgs[0] === 'snapshot').length, 1);
    assert.equal(
      verifies.filter(
        (call) => !(call.opts.exactTarget as { operationToken?: string }).operationToken,
      ).length,
      0,
    );
    await runMaestroInline(
      '- tapOn: "probe"',
      { platform: 'ios' },
      {
        chooseDispatch: () => ({ error: 'probe refusal' }) as never,
      },
    );
    assert.equal(maestroInvocations, 1);
  } finally {
    _setMaestroInlineObserverForTest(null);
  }
});

test('gh-581: possible SET_TEXT_REJECTED hard-fails without verification', async () => {
  const { result, calls } = await withFillSeam(
    {
      fill: () => failResult('rejected', 'SET_TEXT_REJECTED', { mutation: 'possible' }),
      verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'possible');
  assert.equal(calls.filter((call) => call.cliArgs[0] === 'verify-input').length, 0);
});

test('gh-581: observed SET_TEXT_REJECTED requires independent verification', async () => {
  const exact = await withFillSeam(
    {
      fill: () => failResult('rejected', 'SET_TEXT_REJECTED', { mutation: 'observed' }),
      verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(exact.result as never).data.filled, true);
  assert.equal(exact.calls.filter((call) => call.cliArgs[0] === 'verify-input').length, 1);

  const mismatch = await withFillSeam(
    {
      fill: () => failResult('rejected', 'SET_TEXT_REJECTED', { mutation: 'observed' }),
      verify: () => okResult({ verifyVerdict: 'mismatch', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const mismatchEnv = envelope(mismatch.result as never);
  assert.equal(mismatchEnv.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(mismatchEnv.meta.mutation, 'observed');
  assert.equal(mismatch.calls.filter((call) => call.cliArgs[0] === 'verify-input').length, 1);
});

test('gh-581: android parity — EditText fixtures, same arbiter, same success rule', async () => {
  const androidNodes = [
    {
      ref: '@e1',
      identifier: 'first-name-pressable',
      type: 'android.view.ViewGroup',
      rect: { x: 20, y: 100, width: 360, height: 60 },
    },
    {
      ref: '@e2',
      identifier: 'first-name',
      type: 'android.widget.EditText',
      rect: { x: 40, y: 110, width: 320, height: 40 },
    },
  ];
  const { result, calls } = await withFillSeam(
    { platform: 'android', nodes: androidNodes as never },
    () => performExactFill({ ref: '@e1', text: 'Anna' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError, envelope(result as never).error);
  assert.equal(envelope(result as never).meta.verify, 'exact');
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.equal(fill.cliArgs[1], '@e2', 'binds the EditText, not the ViewGroup wrapper');
  assert.ok(calls.some((c) => c.cliArgs[0] === 'verify-input'));
});

test('gh-581: bare "EditText" snapshot type never binds on Android', async () => {
  const bareNodes = [
    {
      ref: '@e2',
      identifier: 'first-name',
      type: 'EditText',
      rect: { x: 40, y: 110, width: 320, height: 40 },
    },
  ];
  const { result } = await withFillSeam({ platform: 'android', nodes: bareNodes as never }, () =>
    performExactFill({ ref: '@e2', text: 'Anna' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(result as never).code, 'NO_TEXT_INPUT_TARGET');
});

test('gh-581: React evidence cannot promote a native mismatch', async () => {
  let evaluations = 0;
  const client = {
    isConnected: true,
    evaluate: async () => {
      evaluations += 1;
      return { value: JSON.stringify({ value: 'value', controlled: true }) };
    },
  } as never;
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'mismatch', verifyStable: true }) },
    () => performExactFill({ ref: '@e3', text: 'value' }, client, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(evaluations, 0);
  assert.ok(!JSON.stringify(env).includes('"filled":true'));
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('gh-581: controlled inputs use native authority without React dispatch', async () => {
  let evaluations = 0;
  const client = {
    isConnected: true,
    evaluate: async () => {
      evaluations += 1;
      return { value: JSON.stringify({ value: 'Anna', controlled: true }) };
    },
  } as never;
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }) },
    () => performExactFill({ ref: '@e2', text: 'Anna' }, client, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError);
  const env = envelope(result as never);
  assert.deepEqual(env.data, { filled: true, method: 'native', length: 4 });
  assert.equal(env.meta.verify, 'exact');
  assert.equal(evaluations, 0);
  assert.ok(calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('gh-581: React state never promotes unavailable native verification', async () => {
  let evaluations = 0;
  const client = {
    isConnected: true,
    evaluate: async () => {
      evaluations += 1;
      return { value: JSON.stringify({ value: 'Anna', controlled: true }) };
    },
  } as never;
  for (const [verifyVerdict, verifyStable] of [
    ['unavailable', false],
    ['secure-masked', true],
    ['target-lost', false],
  ] as const) {
    const { result, calls } = await withFillSeam(
      { verify: () => okResult({ verifyVerdict, verifyStable }) },
      () => performExactFill({ ref: '@e2', text: 'Anna' }, client, NATIVE_ONLY),
    );
    const env = envelope(result as never);
    assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED', verifyVerdict);
    assert.equal(env.meta.mutation, 'possible', verifyVerdict);
    assert.ok(
      calls.some((c) => c.cliArgs[0] === 'verify-input'),
      verifyVerdict,
    );
    assert.ok(
      calls.some((c) => c.cliArgs[0] === 'fill'),
      verifyVerdict,
    );
  }
  assert.equal(evaluations, 0);
});

test('gh-581: conflicting explicit testID rejects before any mutation', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill(
      { ref: '@e2', testID: 'last-name', text: 'Anna' },
      fakeClient({ read: () => ({ value: '', controlled: true }) }),
      NATIVE_ONLY,
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('gh-581: cancellation after mismatch cannot trigger another mutation', async () => {
  const abortController = new AbortController();
  const { result, calls } = await withFillSeam(
    {
      verify: () => {
        abortController.abort();
        return okResult({ verifyVerdict: 'mismatch', verifyStable: true });
      },
    },
    () =>
      performExactFill({ ref: '@e3', text: 'value' }, null, {
        ...NATIVE_ONLY,
        abortSignal: abortController.signal,
      }),
  );
  const env = envelope(result as never);
  assert.equal(env.meta.mutation, 'observed');
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('gh-581: device fill never dispatches a React handler', async () => {
  let typeTextCalls = 0;
  const client = fakeClient({
    read: () => ({ value: null, controlled: false }),
    typeText: () => {
      typeTextCalls += 1;
      return { controlled: false, handlerCalled: 'onChangeText', valueBefore: null };
    },
  });
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e2', text: 'Anna' }, client, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError);
  assert.equal(typeTextCalls, 0, 'fiber typeText never fired for an uncontrolled input');
  assert.ok(
    calls.some((c) => c.cliArgs[0] === 'fill'),
    'native tier used',
  );
});

test('gh-581: a failing React client cannot affect native fill', async () => {
  const client = {
    isConnected: true,
    evaluate: async (expr: string) => {
      if (expr.includes('readInputValue')) {
        return { value: JSON.stringify({ value: '', controlled: true }) };
      }
      throw new Error('socket closed mid-dispatch');
    },
  } as never;
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e2', text: 'Anna' }, client, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.data.filled, true);
  assert.equal(env.data.method, 'native');
  assert.ok(calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('gh-581: no envelope ever echoes the requested text', async () => {
  const secret = 'sekrit-canary-1234';
  const scenarios: Array<() => Promise<{ result: unknown }>> = [
    () => withFillSeam({}, () => performExactFill({ ref: '@e1', text: secret }, null, NATIVE_ONLY)),
    () =>
      withFillSeam(
        { verify: () => okResult({ verifyVerdict: 'unreadable', verifyStable: false }) },
        () => performExactFill({ ref: '@e3', text: secret }, null, NATIVE_ONLY),
      ),
    () =>
      withFillSeam(
        { fill: () => failResult('refused', 'NO_TEXT_INPUT_TARGET', { mutation: 'none' }) },
        () => performExactFill({ ref: '@e3', text: secret }, null, NATIVE_ONLY),
      ),
    () => {
      let value = '';
      const client = fakeClient({
        read: () => ({ value, controlled: true }),
        typeText: () => {
          value = secret;
          return { controlled: true, handlerCalled: 'onChangeText', valueBefore: '' };
        },
      });
      return withFillSeam({}, () =>
        performExactFill({ ref: '@e2', text: secret }, client, NATIVE_ONLY),
      );
    },
  ];
  for (const scenario of scenarios) {
    const outcome = await scenario();
    const text = (outcome.result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(!text.includes(secret), 'envelope leaked the requested text (redacted)');
  }
});

test('gh-581: extractTypingMeta surfaces typingBurst + keyboardWaitMs from the runner envelope', () => {
  const result = okResult({ typed: true, typingBurst: true, keyboardWaitMs: 120 });
  assert.deepEqual(extractTypingMeta(result), { burst: true, keyboardWaitMs: 120 });
  assert.equal(extractTypingMeta(okResult({ typed: true })), null);
  assert.equal(extractTypingMeta(failResult('nope')), null);
});

test('a native read-back differing only by letter case is unverified with case evidence, not a mismatch', async () => {
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'case-normalized', verifyStable: true }) },
    () => performExactFill({ ref: '@e3', text: 'Hello Ada' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.verification.evidence, 'case-normalized');
  assert.equal(env.meta.mutation, 'observed');
  assert.doesNotMatch(JSON.stringify(env), /Hello|Ada/);
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1, 'no retype');
});
