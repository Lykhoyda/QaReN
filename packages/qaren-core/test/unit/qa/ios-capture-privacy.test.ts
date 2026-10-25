import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { AppProcessGoneError, captureScreen } from '../../../dist/qa/capture.js';
import type { NativeObservation } from '../../../dist/qa/capture.js';
import { HandlerError, unwrap } from '../../../dist/qa/adapt.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { createDeviceSnapshotHandler } from '../../../dist/handlers/device-session.js';
import {
  _setFastRunnerStateForTest,
  _setCapabilitiesForTest,
  _setFetchForTest,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';
import {
  _setActiveSessionForTest,
  getCachedSnapshot,
  setSnapshotAuthorityProvider,
} from '../../../dist/agent-device-wrapper.js';
import { clearRefMap, getCachedMetadata } from '../../../dist/fast-runner-ref-map.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';

beforeEach(() => {
  clearRefMap();
  setSnapshotAuthorityProvider(null);
  _setActiveSessionForTest({
    name: 'ios-privacy',
    platform: 'ios',
    deviceId: 'sim',
    appId: 'com.test',
    openedAt: 'now',
  });
  _setFastRunnerStateForTest({
    port: 22088,
    pid: process.pid,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
});

afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  _setActiveSessionForTest(null);
  setSnapshotAuthorityProvider(null);
  clearRefMap();
});

test('a walked sign-in code fill waits for a complete post-fill presence capture', async () => {
  const secret = 'walked-code-canary';
  let filled = false;
  let presenceReads = 0;
  const budgets: number[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1', 'PLATFORM_PRESENCE_V2'],
      });
    const request = JSON.parse(String(init?.body));
    assert.equal(request.command, 'snapshot');
    assert.equal(request.qaReadOnly, true);
    const data = nativeCapture();
    if (!request.platformPresence) {
      return Response.json({
        ok: true,
        data: {
          ...data,
          nodes: [
            data.nodes[0],
            {
              ...data.nodes[1],
              type: 'TextField',
              identifier: 'code',
              label: 'Sign-in code',
              ...(filled ? { value: secret } : {}),
            },
          ],
          presenceCapture: undefined,
        },
      });
    }
    assert.equal(filled, true);
    budgets.push(request.presenceBudgetMs);
    data.nodes[1].label = 'Notification permission';
    data.presenceCapture.appliedBudgetMs = request.presenceBudgetMs;
    if (++presenceReads === 1)
      return Response.json({
        ok: true,
        data: {
          ...data,
          keyboardVisible: undefined,
          presenceCapture: {
            ...data.presenceCapture,
            complete: false,
            diagnostics: { failure: { phase: 'revalidation', reason: 'enumeration-changed' } },
          },
        },
      });
    return Response.json({ ok: true, data });
  });
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, choice(question)])),
  );
  const f = walker([], judge);
  const fill = f.deps.fill;
  f.deps.fill = async (...args) => {
    filled = true;
    return fill(...args);
  };
  f.deps.screenshot = async () => assert.fail('private fill still withholds screenshots');
  const snapshot = createDeviceSnapshotHandler();
  f.deps.captureScreen = (options) =>
    captureScreen({
      ...options,
      requirePrivateInputs: true,
      appId: 'com.test',
      native: async (presenceBudgetMs) => {
        const result = parseEnvelope(
          await snapshot({
            action: 'snapshot',
            qaReadOnly: true,
            ...(options?.platformPresence ? { platformPresence: true, presenceBudgetMs } : {}),
          }),
        );
        assert.equal(result.ok, true);
        return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
      },
      react: async () => ({
        interactive: [],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence: { complete: true, hosts: [] },
      }),
    });
  const result = await runPlan(
    parsePlan(`1. Type "${secret}" into "Sign-in code"\n2. Tap the notification permission button`)
      .blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.ok(presenceReads >= 2);
  assert.ok(budgets[1] < budgets[0]);
  assert.ok(budgets.every(Number.isSafeInteger));
  assert.equal(
    JSON.stringify({ result, rows: f.rows, requests: judge.requests }).includes(secret),
    false,
  );
  assert.ok(f.actions.includes('press @e1'));
});

for (const terminated of [true, false]) {
  test(`presence failure after successful capture ${terminated ? 'fails for app termination' : 'refuses for a generic error'}`, async () => {
    let captures = 0;
    _setFetchForTest(async (url, init) => {
      if (String(url).endsWith('/health'))
        return Response.json({
          ok: true,
          protocolVersion: 2,
          commands: REQUIRED_IOS_COMMANDS,
          capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1', 'PLATFORM_PRESENCE_V2'],
        });
      const request = JSON.parse(String(init?.body));
      assert.equal(request.platformPresence, true);
      assert.equal(request.qaReadOnly, true);
      if (captures++ === 0)
        return Response.json({ ok: true, data: { ...nativeCapture(), appProcessIdentifier: 41 } });
      return Response.json({
        ok: false,
        error: {
          code: 'ACTION_CONTEXT_CHANGED',
          message: 'native capture failed',
          mutation: 'none',
          ...(terminated ? { reason: 'app-not-running' } : {}),
        },
      });
    });
    const snapshot = createDeviceSnapshotHandler();
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('failed capture must not reach Jev')),
    );
    f.deps.appProcess = {};
    f.deps.captureScreen = (options) =>
      captureScreen({
        appId: 'com.test',
        requirePrivateInputs: true,
        native: async (presenceBudgetMs) => {
          const result = await snapshot({
            action: 'snapshot',
            qaReadOnly: true,
            platformPresence: options?.platformPresence,
            presenceBudgetMs,
          });
          if (captures > 1) {
            const envelope = parseEnvelope(result);
            assert.equal(envelope.ok, false);
            assert.equal(envelope.meta.reason, terminated ? 'app-not-running' : undefined);
            if (!terminated) {
              assert.equal(envelope.meta.capture, 'unknown');
              assert.equal(envelope.meta.dispatched, true);
            }
          }
          try {
            const { data, meta } = unwrap<NativeObservation>(result);
            return { ...data, snapshotVerdict: meta?.snapshotVerdict };
          } catch (error) {
            if (error instanceof HandlerError && error.meta?.reason === 'app-not-running')
              throw new AppProcessGoneError();
            throw error;
          }
        },
        react: async () => ({
          interactive: [],
          verdict: { state: 'ok', path: 'interactive', complete: true },
          hostEvidence: { hosts: [], complete: true },
        }),
      });
    const initial = await f.deps.captureScreen({ platformPresence: true });
    assert.equal(initial.appProcessIdentifier, 41);
    const result = await runPlan(parsePlan('✓ The save control is shown').blocks!, f.deps);
    assert.equal(captures, 2);
    assert.deepEqual(f.actions, []);
    if (terminated) {
      assert.equal(result.verdict, 'FAIL');
      assert.match(result.failure!.seen, /APP_PROCESS_CHANGED/);
    } else {
      assert.equal(result.verdict, 'REFUSED');
      assert.equal('code' in result && result.code, 'NATIVE_CAPTURE_UNAVAILABLE');
    }
  });
}

test('iOS QA acquisition masks native values and derived labels without public values or caching', async () => {
  const secret = 'alice@example.test';
  for (const type of ['TextField', 'Other', 'UnknownView', 'SecureTextField']) {
    for (const label of ['Email', secret]) {
      for (const hasValue of [true, false]) {
        if (!hasValue && label !== secret) continue;
        const native = nativeCapture();
        const observed = native.nodes[1];
        const nodes = [
          ...native.nodes,
          {
            ...observed,
            index: 2,
            type,
            identifier: 'email',
            label,
            ...(hasValue ? { value: secret } : {}),
            presence: {
              ...observed.presence,
              nodeIndex: 2,
              labelSource: label === secret ? 'value' : 'direct',
            },
          },
          {
            ...observed,
            index: 3,
            type: 'StaticText',
            identifier: undefined,
            label: `Welcome ${secret}`,
            presence: { ...observed.presence, nodeIndex: 3 },
          },
        ];
        _setFetchForTest(async (url, init) => {
          if (String(url).endsWith('/health'))
            return Response.json({
              ok: true,
              protocolVersion: 2,
              commands: REQUIRED_IOS_COMMANDS,
              capabilities: [...REQUIRED_IOS_FEATURES, 'PLATFORM_PRESENCE_V2', 'QA_READ_ONLY_V1'],
            });
          assert.equal(JSON.parse(String(init?.body)).command, 'snapshot');
          return Response.json({ ok: true, data: { ...native, nodes } });
        });
        const snapshot = createDeviceSnapshotHandler();
        const publicResult = parseEnvelope(
          await snapshot({
            action: 'snapshot',
            platformPresence: true,
            presenceBudgetMs: 20_000,
          }),
        );
        assert.equal(publicResult.ok, true);
        assert.equal(
          publicResult.data.nodes.some((node) => Object.hasOwn(node, 'value')),
          false,
        );
        const cached = getCachedSnapshot('ios');
        assert.ok(cached);
        assert.equal(
          cached.nodes.some((node) => Object.hasOwn(node, 'value')),
          false,
        );

        const judge = scriptedJudge((questions, _, state) => {
          assert.equal(JSON.stringify({ questions, state }).includes(secret), false);
          return Object.fromEntries(
            Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.01 }]),
          );
        });
        const f = walker([], judge);
        let shots = 0;
        f.deps.screenshot = async (name) => {
          shots++;
          return name;
        };
        f.deps.captureScreen = () =>
          captureScreen({
            appId: 'com.test',
            requirePrivateInputs: true,
            native: async () => {
              const result = parseEnvelope(
                await snapshot({
                  action: 'snapshot',
                  qaReadOnly: true,
                  platformPresence: true,
                  presenceBudgetMs: 20_000,
                }),
              );
              assert.equal(result.ok, true);
              assert.equal(result.data.nodes[2].value, hasValue ? secret : undefined);
              return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
            },
            react: async () => ({
              interactive: [],
              verdict: { state: 'ok', path: 'interactive', complete: true },
              hostEvidence: { hosts: [], complete: true },
            }),
          });
        const result = await runPlan(
          parsePlan('✓ A greeting is shown\n✓ "Nothing like this"').blocks!,
          f.deps,
        );
        assert.equal(result.verdict, 'FAIL');
        assert.ok(judge.requests.length > 0);
        assert.equal(
          JSON.stringify({ result, rows: f.rows, prompts: judge.requests }).includes(secret),
          false,
        );
        if (type === 'SecureTextField')
          assert.ok(
            result.failure!.seen.endsWith('[screen text withheld: a secure field is on screen]'),
          );
        else assert.match(result.failure!.seen, /Welcome •••/);
        assert.equal(shots, 0);
        assert.strictEqual(getCachedSnapshot('ios'), cached);
        assert.equal(Object.hasOwn(getCachedMetadata('@e2')!, 'value'), false);
      }
    }
  }
});

function iosNode(index: number, type: string, extra: Record<string, unknown> = {}) {
  return {
    index,
    type,
    depth: index,
    ...(index > 0 ? { parentIndex: index - 1 } : {}),
    rect: { x: 0, y: index * 40, width: 300, height: 40 },
    enabled: true,
    hittable: true,
    ...extra,
  };
}

function captureWalk(
  nodes: ReturnType<typeof iosNode>[],
  truncated: boolean | undefined,
  judge = scriptedJudge(() => assert.fail('literal plans must not call Jev')),
) {
  const bodies: Record<string, unknown>[] = [];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'PLATFORM_PRESENCE_V2', 'QA_READ_ONLY_V1'],
      });
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    assert.equal(body.command, 'snapshot');
    return Response.json({
      ok: true,
      data: {
        ...(truncated === false
          ? {
              ...nativeCapture(),
              nodes: nodes.map((node, index) => ({
                ...node,
                ref: `@e${index}`,
                presence: {
                  ...nativeCapture().nodes[1].presence,
                  nodeIndex: index,
                },
              })),
            }
          : { nodes }),
        ...(truncated === undefined ? {} : { truncated }),
      },
    });
  });
  const snapshot = createDeviceSnapshotHandler();
  const f = walker([], judge);
  let shots = 0;
  f.deps.screenshot = async (name) => {
    shots++;
    return name;
  };
  f.deps.captureScreen = () =>
    captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      native: async () => {
        const result = parseEnvelope(
          await snapshot({
            action: 'snapshot',
            qaReadOnly: true,
            ...(truncated === false ? { platformPresence: true, presenceBudgetMs: 20_000 } : {}),
          }),
        );
        assert.equal(result.ok, true);
        return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
      },
      react: async () => ({
        interactive: [],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence: { hosts: [], complete: true },
      }),
    });
  return { f, bodies, shots: () => shots };
}

test('a container label built from a prefilled child value is masked when complete and refused when the child may be cut off', async () => {
  const secret = 'prefilled-b@example.test';
  const parent = iosNode(2, 'Other', { label: secret });
  const child = iosNode(3, 'TextField', { identifier: 'email', label: 'Email', value: secret });
  const screen = { rect: { x: 0, y: 0, width: 390, height: 844 } };
  const base = [iosNode(0, 'Application', screen), iosNode(1, 'Window', screen)];
  for (const truncated of [false, true, undefined]) {
    const judge = scriptedJudge((questions, _, state) => {
      const evidence = state as {
        assertionEvidence: { unknown: { description: string }[] };
      };
      const container = evidence.assertionEvidence.unknown.find((entry) =>
        entry.description.includes('[testID prefilled-container]'),
      );
      assert.ok(container, 'the model request must include the parent container');
      assert.match(container.description, /"Account \[QAREN_VALUE_\d+\]"/);
      assert.equal(JSON.stringify({ questions, state }).includes(secret), false);
      return Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.99 }]),
      );
    });
    const { f, bodies, shots } = captureWalk(
      truncated === false
        ? [
            ...base,
            { ...parent, identifier: 'prefilled-container', label: `Account ${secret}` },
            child,
          ]
        : [...base, parent],
      truncated,
      truncated === false ? judge : undefined,
    );
    const plan =
      truncated === false
        ? '✓ An email field is shown\n✓ "Nothing like this"'
        : '✓ "Nothing like this"';
    const result = await runPlan(parsePlan(plan).blocks!, f.deps);
    const all = JSON.stringify({ result, rows: f.rows, requests: judge.requests });
    assert.equal(all.includes(secret), false, all);
    assert.equal(shots(), 0);
    for (const body of bodies) {
      assert.equal(body.depth, undefined);
      assert.equal(body.compact, undefined);
    }
    if (truncated !== false) {
      assert.equal(result.verdict, 'REFUSED');
      assert.equal('code' in result && result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
      assert.match(result.failure!.seen, truncated ? /causes=truncated\)/ : /causes=unattested\)/);
    } else {
      assert.equal(judge.requests.length, 1, JSON.stringify(result));
      assert.equal(result.verdict, 'FAIL');
      assert.match(result.failure!.seen, /Email/);
    }
  }
});

test('twin fields that differ only by value keep both values masked on a literal capture', async () => {
  const [first, second] = ['first@example.test', 'second@example.test'];
  const screen = { rect: { x: 0, y: 0, width: 390, height: 844 } };
  const field = (index: number, value: string) =>
    iosNode(index, 'TextField', {
      identifier: 'email',
      label: 'Email',
      value,
      parentIndex: 1,
      rect: { x: 10, y: 100, width: 200, height: 40 },
    });
  const nodes = [
    iosNode(0, 'Application', screen),
    iosNode(1, 'Window', screen),
    field(2, first),
    field(3, second),
    iosNode(4, 'StaticText', {
      label: `Echo ${second}`,
      parentIndex: 1,
      rect: { x: 10, y: 200, width: 300, height: 40 },
    }),
  ];
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1'],
      });
    const body = JSON.parse(String(init?.body));
    assert.notEqual(body.platformPresence, true);
    return Response.json({ ok: true, data: { nodes, truncated: false } });
  });
  const snapshot = createDeviceSnapshotHandler();
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  let shots = 0;
  f.deps.screenshot = async (name) => {
    shots++;
    return name;
  };
  f.deps.captureScreen = () =>
    captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      native: async () => {
        const result = parseEnvelope(await snapshot({ action: 'snapshot', qaReadOnly: true }));
        return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
      },
      react: async () => ({
        interactive: [],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence: { hosts: [], complete: true },
      }),
    });
  const result = await runPlan(parsePlan('✓ "Nothing like this"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /Echo •••/);
  const all = JSON.stringify({ result, rows: f.rows });
  assert.equal(all.includes(first) || all.includes(second), false, all);
  assert.equal(shots, 0);
});

// Producer-shaped interactive QA snapshot: Window is emitted because the runner keeps it for geometry.
function carousel(scrollX: number) {
  const screen = { x: 0, y: 0, width: 402, height: 874 };
  const page = (index: number, x: number, type: string, extra: Record<string, unknown>) => ({
    index,
    type,
    depth: 3,
    parentIndex: 2,
    rect: { x: x - scrollX, y: 300, width: 300, height: 40 },
    enabled: true,
    hittable: x - scrollX >= 0 && x - scrollX < 402,
    ...extra,
  });
  const nodes = [
    { index: 0, type: 'Application', depth: 0, rect: screen, enabled: true, hittable: true },
    {
      index: 1,
      type: 'Window',
      depth: 1,
      parentIndex: 0,
      rect: screen,
      enabled: true,
      hittable: true,
    },
    {
      index: 2,
      type: 'ScrollView',
      depth: 2,
      parentIndex: 1,
      rect: screen,
      enabled: true,
      hittable: true,
    },
  ];
  const base = nodes.length;
  return [
    ...nodes,
    page(base, 20, 'StaticText', { label: 'Page one' }),
    page(base + 1, 20 + 804, 'StaticText', { label: 'Page three' }),
    page(base + 2, 20 + 804, 'TextField', {
      identifier: 'email',
      label: 'Email',
      value: 'offscreen-e@example.test',
    }),
    page(base + 3, 20, 'StaticText', { label: 'Signed in as offscreen-e@example.test' }),
  ];
}

async function literal(plan: string, tree: unknown[]) {
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'QA_READ_ONLY_V1'],
      });
    return Response.json({
      ok: true,
      data: { nodes: tree, truncated: false },
    });
  });
  const snapshot = createDeviceSnapshotHandler();
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  f.deps.captureScreen = () =>
    captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      native: async () => {
        const result = parseEnvelope(await snapshot({ action: 'snapshot', qaReadOnly: true }));
        return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
      },
      react: async () => ({
        interactive: [],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence: { hosts: [], complete: true },
      }),
    });
  const result = await runPlan(parsePlan(plan).blocks!, f.deps);
  assert.equal(
    JSON.stringify({ result, rows: f.rows }).includes('offscreen-e@example.test'),
    false,
  );
  return result.verdict;
}

test('pages outside the native window satisfy no literal check or wait until scrolled into it', async () => {
  const start = carousel(0);
  const scrolled = carousel(804);
  assert.equal(await literal('✓ "Page one"', start), 'PASS');
  assert.equal(await literal('✓ "Page three"', start), 'FAIL');
  assert.equal(await literal('1. Wait for "Page three"', start), 'FAIL');
  assert.equal(await literal('✓ "Not in this app"', start), 'FAIL');
  assert.equal(await literal('✓ "Page three"', scrolled), 'PASS');
  assert.equal(await literal('✓ "Page one"', scrolled), 'FAIL');
});
