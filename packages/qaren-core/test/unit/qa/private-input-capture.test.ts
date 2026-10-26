import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen, NativeCaptureError } from '../../../dist/qa/capture.js';
import type { ReactObservation } from '../../../dist/qa/capture.js';
import { PrivateInputCaptureError } from '../../../dist/qa/private-input.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { ObservedPrivacy, redactEvidence } from '../../../dist/qa/privacy.js';
import { scriptedJudge } from './judgment-fixtures.ts';
import { walker } from './judgment-fixtures.ts';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { exitCodeFor, resultForWalk } from '../../../dist/qa/wire.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

function observedNative(nodes: NativeNode[]) {
  const native = nativeCapture();
  const observed = native.nodes[1];
  return {
    ...native,
    nodes: [
      native.nodes[0],
      ...nodes.map((node, i) => ({
        ...observed,
        identifier: undefined,
        label: undefined,
        ...node,
        index: i + 1,
        presence: { ...observed.presence, nodeIndex: i + 1 },
      })),
    ],
    snapshotVerdict: { ...native.snapshotVerdict, nodeCount: nodes.length + 1 },
  };
}

const secret = 'private-native-field@example.test';
const field = (value: string, extra: Partial<NativeNode> = {}): NativeNode => ({
  ref: '@field',
  type: 'TextField',
  identifier: 'field',
  label: 'Field',
  value,
  ...extra,
});
function observation(): ReactObservation {
  return {
    interactive: [],
    verdict: { state: 'ok', path: 'interactive', complete: true },
    hostEvidence: { complete: true, hosts: [] },
  };
}

test('native field values mask echoes without becoming assertion evidence', async () => {
  const screen = await captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    native: async () =>
      observedNative([field(secret), { ref: '@echo', type: 'StaticText', label: secret }]),
    react: async () => observation(),
  });
  const judge = scriptedJudge((questions, _, state) => {
    assert.equal(JSON.stringify({ questions, state }).includes(secret), false);
    return { check_1: { type: 'noul', noul: 0.99 } };
  });
  assert.equal(
    (
      await decideScreen(screen, judge, {
        kind: 'check',
        literal: false,
        text: `The message says ${secret}`,
        line: 1,
      })
    ).check,
    'pass',
  );
  assert.equal(judge.requests.length, 1);
  assert.equal(redactEvidence(screen, secret), '•••');
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  assert.equal(privacy.redact(secret), '•••');
});

test('private field values cannot bypass missing assertion evidence, while native echoes remain judgeable', async (t) => {
  for (const secure of [false, true]) {
    for (const [label, expected, calls] of [
      ['Welcome, Bob', 'unsure', 0],
      ['Welcome, Anton', 'pass', 1],
    ] as const) {
      await t.test(`${secure ? 'secure' : 'plain'} input with ${label}`, async () => {
        const screen = await captureScreen({
          requirePrivateInputs: true,
          appId: 'com.test',
          native: async () =>
            observedNative([
              field('Anton', secure ? { type: 'SecureTextField' } : {}),
              { ref: '@greeting', type: 'StaticText', label },
            ]),
          react: async () => observation(),
        });
        for (const typed of [[], ['Anton']]) {
          const judge = scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.99 } }));
          const decision = await decideScreen(
            screen,
            judge,
            { kind: 'check', literal: false, text: 'The greeting says Welcome, Anton', line: 1 },
            undefined,
            typed,
          );
          assert.equal(decision.check, expected);
          assert.equal(judge.requests.length, calls);
          assert.equal(JSON.stringify(judge.requests).includes('Anton'), false);
        }
        const privacy = new ObservedPrivacy();
        privacy.observe(screen);
        assert.equal(privacy.redact('Anton'), '•••');
        assert.equal(privacy.canScreenshot(), false);
      });
    }
  }
});

test('hidden and uncertain private input contents are never proved by a model', async () => {
  for (const secure of [true, false]) {
    const input = field(secret, { label: 'Email', ...(secure ? { type: 'SecureTextField' } : {}) });
    const screen = await captureScreen({
      requirePrivateInputs: true,
      native: async () => attested([input]),
      react: async () => observation(),
    });
    const judge = scriptedJudge(() => assert.fail('private contents cannot be judged'));
    for (const text of [
      'Email field is valid',
      `Email contains ${secret}`,
      'Password is filled',
      'Welcome heading is valid',
    ]) {
      assert.deepEqual(
        (
          await decideScreen(screen, judge, {
            kind: 'check',
            literal: false,
            text,
            line: 1,
          })
        ).check,
        {
          refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
          reason:
            'semantic projection requires complete native and React coverage (capture native=complete react=complete; projected native=unknown react=complete)',
        },
        text,
      );
    }
  }
  const screen = await captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    native: async () =>
      observedNative([
        field(secret, { label: 'Password', type: 'SecureTextField' }),
        { ref: '@welcome', type: 'StaticText', label: 'Welcome' },
      ]),
    react: async () => observation(),
  });
  const judge = scriptedJudge(() => assert.fail('secure contents cannot be judged'));
  for (const text of [
    'Password is valid',
    'Password is filled',
    `Password contains ${secret}`,
    'Password field contains other',
  ])
    assert.equal(
      (await decideScreen(screen, judge, { kind: 'check', literal: false, text, line: 1 })).check,
      'unsure',
      text,
    );
  assert.equal(judge.requests.length, 0);
});

test('an incomplete native capture is never usable, while a missing React digest only degrades', async () => {
  const withWelcome = () =>
    observedNative([field(secret), { ref: '@welcome', type: 'StaticText', label: 'Welcome' }]);
  const incomplete = [
    () => ({
      ...withWelcome(),
      snapshotVerdict: { state: 'failed', nodeCount: 3, refMapUpdated: true, reasons: [] },
    }),
    () => ({ ...withWelcome(), truncated: true }),
  ];
  for (const native of incomplete) {
    for (const source of ['✓ Welcome is visible', `1. Tap "${secret}"`]) {
      const judge = scriptedJudge(() => assert.fail('incomplete capture must not be judged'));
      const f = walker([], judge);
      f.deps.captureScreen = (options) =>
        captureScreen({
          requirePrivateInputs: true,
          appId: 'com.test',
          timing: options?.timing,
          native: async () => native(),
          react: async () => observation(),
        });
      f.deps.screenshot = async () => assert.fail('incomplete capture must not take screenshots');
      const plan = parsePlan(source);
      assert.ok(plan.blocks);
      const result = await runPlan(plan.blocks, f.deps);
      // Strict rule 1: a provably incomplete native tree refuses at capture.
      assert.equal(result.verdict, 'REFUSED', source);
      assert.equal('code' in result && result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN', source);
      assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
      assert.equal(judge.requests.length, 0);
      assert.deepEqual(f.actions, []);
    }
  }
  const judge = scriptedJudge(() => assert.fail('literal checks are local'));
  const f = walker([], judge);
  let reads = 0;
  f.deps.captureScreen = () =>
    captureScreen({
      requirePrivateInputs: true,
      appId: 'com.test',
      native: async () => withWelcome(),
      react: async () => {
        reads++;
        throw new PrivateInputCaptureError();
      },
    });
  f.deps.screenshot = async () => assert.fail('native field values withhold pixels');
  const plan = parsePlan(`✓ "Welcome"\n✓ "Field: ${secret}"`);
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, f.deps);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.ok(reads > 0);
  assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
  const degraded = await captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    native: async () => withWelcome(),
    react: async () => {
      throw new PrivateInputCaptureError();
    },
  });
  assert.equal(degraded.coverage?.react, 'unknown');
  assert.equal(degraded.captureCoverage?.native, 'complete');
  const privacy = new ObservedPrivacy();
  privacy.observe(degraded);
  assert.equal(privacy.redact(secret), '•••');
  assert.equal(privacy.canScreenshot(), false);
});

test('private input values and screenshot restrictions persist into later screens and blocks', async () => {
  const first = await captureScreen({
    native: async () => ({
      nodes: [field(secret), { ref: '@welcome', type: 'StaticText', label: 'Welcome' }],
    }),
    react: async () => observation(),
  });
  const later = await captureScreen({
    native: async () => ({ nodes: [{ ref: '@echo', type: 'StaticText', label: secret }] }),
    react: async () => observation(),
  });
  const judge = scriptedJudge(() => assert.fail('literal checks are local'));
  const f = walker([first, later], judge);
  f.deps.screenshot = async () => assert.fail('text masking does not redact pixels');
  const plan = parsePlan(`## First\n✓ "Welcome"\n## Second\n✓ "${secret}"`);
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
});

test('native acquisition failures refuse at their own boundary without inspecting private diagnostics', async () => {
  const raw = new Error(secret);
  Object.defineProperty(raw, 'cause', {
    get: () => assert.fail('raw cause must not be inspected'),
  });
  raw.toString = () => assert.fail('raw failure must not be stringified');
  for (const afterSafeCapture of [false, true]) {
    const judge = scriptedJudge(() => assert.fail('native failure must not reach the judge'));
    const f = walker([], judge);
    let captures = 0;
    let reactCalls = 0;
    f.deps.captureScreen = () =>
      captureScreen({
        requirePrivateInputs: true,
        native: async () => {
          if (afterSafeCapture && captures++ === 0)
            return attested([
              { ref: '@safe', type: 'StaticText', label: 'Welcome' },
              field(secret),
              { ref: '@echo', type: 'StaticText', label: secret },
            ]);
          throw raw;
        },
        react: async () => {
          reactCalls++;
          return observation();
        },
        warn: () => assert.fail('no raw acquisition logs'),
      });
    f.deps.screenshot = async () => assert.fail('no screenshots');
    const plan = parsePlan(
      `${afterSafeCapture ? '## Safe\n✓ "Welcome"\n' : ''}## ${secret}\n1. Tap "${secret}"`,
    );
    assert.ok(plan.blocks);
    const result = await runPlan(plan.blocks, f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal('code' in result && result.code, 'NATIVE_CAPTURE_UNAVAILABLE');
    assert.equal('message' in result && result.message, 'Native capture is unavailable.');
    assert.equal(result.failure?.seen, 'Native capture is unavailable.');
    assert.equal(result.steps.at(-1)?.block, 'native-capture');
    assert.equal(result.steps.at(-1)?.text, 'Native capture is unavailable.');
    assert.equal(result.steps.at(-1)?.reason, 'NATIVE_CAPTURE_UNAVAILABLE');
    assert.equal(result.steps.length, afterSafeCapture ? 2 : 1);
    assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
    assert.equal(reactCalls, afterSafeCapture ? 1 : 0);
    assert.deepEqual(f.actions, []);
    assert.equal(exitCodeFor(resultForWalk(result, 'test-lease')), 4);
  }
  await assert.rejects(
    captureScreen({
      native: async () => {
        throw raw;
      },
      react: async () => assert.fail('legacy native failure must not read React'),
    }),
    (error) => error === raw,
  );
});

test('acquisition refusals use fresh safe errors and classify by acquisition boundary', async () => {
  for (const ErrorClass of [NativeCaptureError, PrivateInputCaptureError]) {
    const safe = new ErrorClass();
    const contaminated = new ErrorClass();
    contaminated.message = secret;
    Reflect.set(contaminated, 'code', secret);
    Object.defineProperty(contaminated, 'cause', { get: () => assert.fail('never inspect cause') });
    const judge = scriptedJudge(() => assert.fail('no judgments after acquisition refusal'));
    const f = walker([], judge);
    f.deps.captureScreen = async () => {
      throw contaminated;
    };
    f.deps.screenshot = async () => assert.fail('no screenshots');
    const plan = parsePlan(`## ${secret}\n✓ "${secret}"`);
    assert.ok(plan.blocks);
    const result = await runPlan(plan.blocks, f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal('code' in result && result.code, safe.code);
    assert.equal('message' in result && result.message, safe.message);
    assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
    assert.equal(exitCodeFor(resultForWalk(result, 'test-lease')), 4);
  }
  const degraded = await captureScreen({
    requirePrivateInputs: true,
    native: async () => attested([field(secret)]),
    react: async () => {
      throw new NativeCaptureError();
    },
    warn: (message) => assert.equal(message.includes(secret), false),
  });
  assert.equal(degraded.coverage?.react, 'unknown');
  for (const thrown of [new PrivateInputCaptureError(), new Error(secret)])
    await assert.rejects(
      captureScreen({
        requirePrivateInputs: true,
        native: async () => {
          throw thrown;
        },
        react: async () => assert.fail('native failed before React acquisition'),
      }),
      (error) =>
        error instanceof NativeCaptureError &&
        error.code === 'NATIVE_CAPTURE_UNAVAILABLE' &&
        error.message === 'Native capture is unavailable.' &&
        !('cause' in error),
    );
});

test('secure native fields withhold pixels and conceal values the native snapshot reports', async () => {
  for (const node of [
    field('•••••', { label: 'Password', type: 'SecureTextField' }),
    field('', { label: 'Password', type: 'SecureTextField', value: undefined }),
  ]) {
    const screen = await captureScreen({
      native: async () => ({ nodes: [node] }),
      react: async () => observation(),
    });
    assert.equal(screen.elements[0].value, undefined);
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.canScreenshot(), false);
  }
  const screen = await captureScreen({
    native: async () => ({
      nodes: [{ ref: '@unknown', type: 'Other', secure: true, value: secret }],
    }),
    react: async () => observation(),
  });
  assert.equal(JSON.stringify(screen).includes(secret), false);
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  assert.equal(privacy.redact(secret), '•••');
  assert.equal(privacy.canScreenshot(), false);
});

test('nonsecure native values stay local and cannot authorize semantic equality', async () => {
  const react = observation();
  react.hostEvidence = {
    complete: true,
    hosts: [{ testID: 'email', role: null, roleSource: 'none', capabilities: {} }],
  };
  const screen = await captureScreen({
    appId: 'com.test',
    native: async () =>
      observedNative([
        { ref: '@label', type: 'StaticText', label: 'Email' },
        { ref: '@email', identifier: 'email', type: 'TextField', label: 'Email', value: secret },
      ]),
    react: async () => react,
  });
  const judge = scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.99 } }));
  assert.equal(
    (
      await decideScreen(screen, judge, {
        kind: 'check',
        literal: false,
        text: `Email field contains ${secret}`,
        line: 1,
      })
    ).check,
    'unsure',
  );
  assert.equal(judge.requests.length, 0);
  assert.equal(JSON.stringify(judge.requests).includes(secret), false);
  for (const [text, expected] of [
    [secret, 'pass'],
    ['•••', 'fail'],
    ['[QAREN_VALUE_1]', 'fail'],
  ] as const) {
    assert.equal(
      (
        await decideScreen(
          screen,
          judge,
          {
            kind: 'check',
            literal: true,
            text,
            line: 1,
          },
          { kind: 'fill', target: { quoted: 'Email', phrase: 'Email' }, text: 'new', line: 2 },
        )
      ).check,
      expected,
    );
  }
});

test('private native input evidence withholds pixels even with no React digest', async () => {
  for (const node of [
    { ref: '@native', type: 'SecureTextField', value: secret },
    { ref: '@native', type: 'TextField', value: secret },
    { ref: '@native', type: 'android.widget.EditText', label: secret },
  ]) {
    const screen = await captureScreen({
      native: async () => ({ nodes: [node] }),
      react: async () => {
        throw new PrivateInputCaptureError();
      },
    });
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.canScreenshot(), false);
    assert.equal(privacy.redact(secret), '•••');
  }
});

test('secure generic native accessibility labels may be values even without native input metadata', async () => {
  for (const identifier of ['password', undefined]) {
    const screen = await captureScreen({
      native: async () => ({
        nodes: [{ ref: '@password', type: 'Other', secure: true, identifier, label: secret }],
      }),
      react: async () => observation(),
    });
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact(secret), '•••');
    assert.equal(privacy.canScreenshot(), false);
  }
});

test('private-capture secure short values follow whole-token and substring rules without becoming local evidence', async () => {
  for (const value of ['7', 'ab', '.']) {
    const echo = `code=${value} x${value}x`;
    const screen = await captureScreen({
      requirePrivateInputs: true,
      appId: 'com.test',
      native: async () =>
        observedNative([
          field(value, { type: 'SecureTextField' }),
          { ref: '@echo', type: 'StaticText', label: echo },
        ]),
      react: async () => observation(),
    });
    const judge = scriptedJudge((_, __, state) => {
      assert.equal(JSON.stringify(state).includes(echo), false);
      const expected = `code=[QAREN_VALUE_1] ${value.length === 1 ? `x${value}x` : 'x[QAREN_VALUE_1]x'}`;
      assert.ok(JSON.stringify(state).includes(expected));
      return { check_1: { type: 'noul', noul: 0.99 } };
    });
    await decideScreen(screen, judge, {
      kind: 'check',
      text: 'Welcome is visible',
      literal: false,
      line: 1,
    });
    assert.equal(judge.requests.length, 1);
    const expected = `code=••• ${value.length === 1 ? `x${value}x` : 'x•••x'}`;
    assert.equal(redactEvidence(screen, echo), expected);
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact(echo), expected);
    const local = scriptedJudge(() => assert.fail('quoted checks must not ask the model'));
    for (const [text, expected] of [
      [echo, 'pass'],
      ['•••', 'fail'],
      ['[QAREN_VALUE_1]', 'fail'],
    ] as const) {
      assert.equal(
        (
          await decideScreen(screen, local, {
            kind: 'check',
            text,
            literal: true,
            line: 1,
          })
        ).check,
        expected,
      );
    }
  }
});

test('secure short-value provenance survives later captures without widening typed-only masking', async () => {
  const first = await captureScreen({
    native: async () => ({
      nodes: [
        field('7', { type: 'SecureTextField' }),
        { ref: '@welcome', type: 'StaticText', label: 'Welcome' },
      ],
    }),
    react: async () => observation(),
  });
  const echo = 'code=7 x7x code=z xzx';
  const later = await captureScreen({
    appId: 'com.test',
    native: async () => observedNative([{ ref: '@echo', type: 'StaticText', label: echo }]),
    react: async () => observation(),
  });
  const judge = scriptedJudge((_, __, state) => {
    assert.deepEqual(state, {
      front: 'app',
      assertionEvidence: {
        observed: [
          'Text "code=[QAREN_VALUE_2] x7x code=z xzx" (native accessibility name; platform-observed presence)',
        ],
        unknown: [],
        unassociatedReact: 0,
        qualifiedHeadings: [],
      },
    });
    return { check_4: { type: 'noul', noul: 0.99 } };
  });
  const f = walker([first, later], judge);
  const plan = parsePlan(
    `## First\n✓ "Welcome"\n## Second\n✓ Welcome is visible\n✓ "${echo}"\n1. Fill "Missing" with "z"`,
  );
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, f.deps);
  assert.equal(judge.requests.length, 1);
  assert.ok(result.steps.some((row) => row.text.includes('code=••• x7x code=z xzx')));
  assert.equal(JSON.stringify(result).includes('code=7'), false);
  assert.ok(JSON.stringify(result).includes('x7x'));
  const typedOnly = new ObservedPrivacy(['7', 'z']);
  typedOnly.observe(later);
  assert.equal(typedOnly.redact(echo), echo);
});
