import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import vm from 'node:vm';
import { CDPClient } from '../../../dist/cdp-client.js';
import { createComponentTreeHandler } from '../../../dist/handlers/component-tree.js';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { captureQaReact, createQaReactCapture } from '../../../dist/qa/react-capture.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import {
  PrivateInputCaptureError,
  ReactCaptureIncomplete,
} from '../../../dist/qa/private-input.js';
import { inputValues } from '../../../dist/qa/privacy.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';
import { startFakeCDP } from '../../helpers/fake-cdp-server.js';

const sentinel = 'PRIVATE_TEST_INPUT_7abf';
const id = '1abcd';
const inputs = () => ({
  version: 1,
  complete: true,
  facts: [{ hostIndex: 0, values: [sentinel], secure: true }],
});
const publicTree = () => ({
  interactive: [
    {
      role: 'textinput',
      testID: 'field',
      placeholder: 'Enter',
      capabilities: { press: false, fill: true },
    },
  ],
  verdict: {
    state: 'ok',
    path: 'interactive',
    complete: true,
    reasons: [],
    rendererErrors: 0,
    unscannedRendererIds: [],
    droppedSubtrees: 0,
    collapsedChildLists: 0,
  },
  hostEvidence: {
    complete: true,
    hosts: [{ testID: 'field', role: null, roleSource: 'none', capabilities: { fill: true } }],
  },
});
const ready = () => ({ v: 1, id, state: 'ready', tree: JSON.stringify(publicTree()) });
const start = () => ({ v: 1, id, state: 'pending' });

function realProducer(props: Record<string, unknown>, allowLegacyTree = false) {
  const fiber = Object.assign(
    buildFiber({
      hostType: 'RCTTextInput',
      props,
      stateNode: {
        measureInWindow: (done: (...rect: number[]) => void) =>
          setTimeout(() => done(0, 0, 100, 40), 35),
      },
    }),
    { tag: 5 },
  );
  const root: { current: object } = { current: fiber };
  if (allowLegacyTree) {
    const wrapper = Object.assign(buildFiber({ name: 'TextInput', props }), { tag: 0 });
    Reflect.set(wrapper, 'child', fiber);
    Reflect.set(fiber, 'return', wrapper);
    root.current = wrapper;
  }
  const sandbox = createSandbox({ fiberRoot: root.current });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (renderer: number) =>
    renderer === 1 ? new Set([root]) : new Set();
  const globalKeys = Object.keys(sandbox);
  const client = new CDPClient();
  client.setLifecycleAuthority(() => false);
  const expressions: string[] = [];
  Reflect.set(client, 'ws', {
    readyState: 1,
    send(frame: string) {
      const request = JSON.parse(frame);
      assert.equal(request.method, 'Runtime.evaluate');
      assert.equal(
        request.params.contextId,
        allowLegacyTree && request.params.expression.startsWith('__QAREN.getTree(') ? undefined : 7,
      );
      assert.equal(request.params.awaitPromise, undefined);
      expressions.push(request.params.expression);
      const value: unknown = vm.runInContext(request.params.expression, sandbox);
      Reflect.get(client, 'handleMessage').call(
        client,
        Buffer.from(JSON.stringify({ id: request.id, result: { result: { value } } })),
      );
    },
  });
  Reflect.set(client, '_state', 'connected');
  Reflect.get(client, 'handleExecutionContextCreated').call(client, { context: { id: 7 } });
  Reflect.set(client, '_helpersInjected', true);
  return {
    client,
    sandbox,
    expressions,
    globalKeys,
    removeInput() {
      root.current = Object.assign(buildFiber({ hostType: 'RCTView', props: {} }), { tag: 5 });
    },
  };
}

function nativeEcho(withField: boolean) {
  const native = nativeCapture();
  const observed = native.nodes[1];
  const nodes: NativeNode[] = [
    ...native.nodes,
    {
      ...observed,
      ref: '@echo',
      index: 2,
      identifier: undefined,
      type: 'StaticText',
      label: sentinel,
      secure: false,
      value: undefined,
      presence: { ...observed.presence, nodeIndex: 2 },
    },
    ...(withField
      ? [
          {
            ...observed,
            ref: '@field',
            index: 3,
            identifier: 'field',
            type: 'TextField',
            label: 'Account',
            secure: false,
            value: undefined,
            presence: { ...observed.presence, nodeIndex: 3 },
          },
        ]
      : []),
  ];
  return {
    ...native,
    nodes,
    snapshotVerdict: { ...native.snapshotVerdict, nodeCount: nodes.length },
  };
}

test('real producer and adapter interoperate through an in-memory CDP socket', async () => {
  for (const typography of [false, true]) {
    const { client, sandbox, expressions, globalKeys } = realProducer({
      testID: 'field',
      value: sentinel,
      secureTextEntry: true,
    });
    const observation = await captureQaReact(client, typography);
    const screen = await captureScreen({
      native: async () => ({ nodes: [] }),
      react: async () => observation,
    });
    // The React walk never reads input values; privacy comes from the native snapshot.
    assert.equal(inputValues(screen).includes(sentinel), false);
    assert.equal(JSON.stringify(observation).includes(sentinel), false);
    assert.equal(JSON.stringify(screen).includes(sentinel), false);
    assert.equal(JSON.stringify(expressions).includes(sentinel), false);
    assert.equal(
      expressions.some((expression) => expression.includes('__rn_agent_async_')),
      false,
    );
    assert.equal(expressions.length >= 3, typography);
    assert.deepEqual(Object.keys(sandbox), globalKeys);
    assert.equal(inspect(client, { depth: 8 }).includes(sentinel), false);
  }
});

test('legacy whole-tree handler neither enters nor exposes the private capture channel', async (t) => {
  const producer = realProducer({ value: sentinel, readOnly: true, secureTextEntry: true }, true);
  t.mock.method(producer.client, 'withPrivateHelperWorld', async () =>
    assert.fail('public handler must remain outside private capture'),
  );
  t.mock.method(producer.client, 'autoConnect', async () =>
    assert.fail('fake CDP is already connected'),
  );
  t.mock.method(producer.client, 'reinjectHelpers', async () =>
    assert.fail('helper is already fresh'),
  );
  const handler = createComponentTreeHandler(() => producer.client);
  const result = await handler({ depth: 4 });
  assert.equal(result.isError, undefined);
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, true);
  assert.ok(envelope.data.tree);
  assert.equal(envelope.data.interactive, undefined);
  assert.equal(envelope.data.inputs, undefined);
  assert.doesNotMatch(JSON.stringify(envelope), /"inputs"|"secureTextEntry"/);
  assert.equal(JSON.stringify(envelope).includes(sentinel), false);
  assert.ok(producer.expressions.some((expression) => expression.startsWith('__QAREN.getTree(')));
  assert.ok(
    producer.expressions.every((expression) => !/beginQaCapture|readQaCapture/.test(expression)),
  );
  const capture = { native: async () => nativeEcho(false), react: async () => envelope.data };
  await captureScreen(capture);
  // Privacy comes from the native snapshot, so an unbound public tree no longer refuses.
  await captureScreen({ ...capture, requirePrivateInputs: true });
});

for (const typography of [false, true]) {
  test(`the React walk never reads an RN-only input value (typography=${typography})`, async () => {
    const producer = realProducer({ value: sentinel, readOnly: true, editable: false });
    const screen = await captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      native: async () => nativeEcho(false),
      react: () => captureQaReact(producer.client, typography),
    });
    // An RN-only value echoed as native text is ordinary screen text: the accepted visible-screen residual.
    assert.equal(inputValues(screen).includes(sentinel), false);
    assert.equal(JSON.stringify(screen.reactHostEvidence ?? {}).includes(sentinel), false);
    assert.equal(JSON.stringify(producer.expressions).includes(sentinel), false);
  });
}

function mockClient(responses: unknown[]) {
  const calls: Array<{ expression: string; timeoutMs: number }> = [];
  let operations = 0;
  const client: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld(operation) {
      operations++;
      return operation(async (expression, timeoutMs) => {
        calls.push({ expression, timeoutMs });
        assert.ok(responses.length > 0, 'unexpected extra call');
        return responses.shift();
      });
    },
  };
  return { client, calls, operations: () => operations };
}

const DETAIL =
  /^cause=[a-z][a-z:,-]*(; scanned=\d+(\/\d+)?)?(; roots=\d+)?(; hosts=\d+)?(; interactive=\d+)?(; queued=\d+)?(; pruned=\d+)?; ms=\d+$/;

function sanitized(error: unknown): boolean {
  assert.ok(error instanceof ReactCaptureIncomplete);
  assert.equal(error.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
  assert.match(error.detail, DETAIL);
  assert.equal(error.message, new ReactCaptureIncomplete(error.reason, error.counters).message);
  assert.equal(error.cause, undefined);
  assert.equal(inspect(error).includes(sentinel), false);
  return true;
}

test('immediate ready is consumed once and typography is a hardcoded boolean', async () => {
  for (const typography of [false, true]) {
    const mock = mockClient([{ ...ready() }]);
    await captureQaReact(mock.client, typography);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].expression, `globalThis.__QAREN.beginQaCapture(${typography})`);
  }
});

test('digest string values refuse without exposing private input bytes in errors or metadata', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  for (const role of ['textinput', 'switch']) {
    const tree = { ...publicTree(), interactive: [{ role, value: sentinel }] };
    const mock = mockClient([
      {
        ...ready(),
        tree: JSON.stringify(tree),
      },
    ]);
    await assert.rejects(captureQaReact(mock.client), (error) => {
      sanitized(error);
      assert.ok(error instanceof PrivateInputCaptureError);
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      assert.equal(Reflect.has(error, 'meta'), false);
      return true;
    });
    assert.equal(JSON.stringify(mock.calls).includes(sentinel), false);
  }
  assert.equal(logs.mock.callCount(), 0);
});

test('digest boolean values on non-switch roles refuse with constant diagnostics', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  for (const role of ['textinput', 'checkbox', 'button']) {
    for (const value of [false, true]) {
      const tree = { ...publicTree(), interactive: [{ role, value, label: sentinel }] };
      const mock = mockClient([
        {
          ...ready(),
          tree: JSON.stringify(tree),
        },
      ]);
      await assert.rejects(captureQaReact(mock.client), sanitized);
      assert.equal(JSON.stringify(mock.calls).includes(sentinel), false);
    }
  }
  assert.equal(logs.mock.callCount(), 0);
});

test('legitimate switch booleans retain an empty private binding', async () => {
  for (const value of [false, true]) {
    const tree = {
      ...publicTree(),
      interactive: [{ role: 'switch', testID: 'toggle', value }],
      hostEvidence: {
        complete: true,
        hosts: [
          { role: 'switch', roleSource: 'accessibilityRole', testID: 'toggle', capabilities: {} },
        ],
      },
    };
    const mock = mockClient([
      {
        ...ready(),
        tree: JSON.stringify(tree),
      },
    ]);
    const observation = await captureQaReact(mock.client);
    assert.deepEqual(observation.interactive, tree.interactive);
    const screen = await captureScreen({
      requirePrivateInputs: true,
      native: async () => ({ ...nativeCapture(), presenceCapture: undefined }),
      react: async () => observation,
    });
    assert.deepEqual(inputValues(screen), []);
  }
});

test('ordinary public tree content is not claimed to be private-channel redacted', async () => {
  const tree = publicTree();
  tree.interactive[0].placeholder = sentinel;
  const mock = mockClient([{ ...ready(), tree: JSON.stringify(tree) }]);
  const observation = await captureQaReact(mock.client);
  assert.equal(observation.interactive?.[0].placeholder, sentinel);
});

test('missing API or transport exceptions become constant refusals with no fallback', async () => {
  const client: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld() {
      throw new Error(`beginQaCapture is not a function: ${sentinel}`);
    },
  };
  await assert.rejects(captureQaReact(client), sanitized);
});

test('start wire refuses unsafe IDs, unexpected fields and any input-value payload', async () => {
  for (const value of [
    undefined,
    null,
    [],
    { ...start(), v: 2 },
    { ...start(), id: '' },
    { ...start(), id: 'a'.repeat(65) },
    { ...start(), id: `");${sentinel}//` },
    { ...start(), state: 'refused' },
    { ...start(), state: 'unknown' },
    { ...start(), error: sentinel },
    { ...start(), tree: JSON.stringify(publicTree()) },
    // A producer must never send input values; a reply still carrying them is refused.
    { ...start(), inputs: inputs() },
  ]) {
    const mock = mockClient([value]);
    await assert.rejects(captureQaReact(mock.client), sanitized);
    assert.equal(mock.calls.length, 1);
    assert.equal(JSON.stringify(mock.calls).includes(sentinel), false);
  }
});

test('polls must be public-only, same-ID, versioned completions', async () => {
  for (const value of [
    null,
    { ...ready(), v: 0 },
    { ...ready(), id: 'abc' },
    { ...ready(), id: `abc${sentinel}` },
    { ...ready(), state: 'refused' },
    { ...ready(), inputs: inputs() },
    { ...ready(), error: sentinel },
    { v: 1, id, state: 'ready' },
  ]) {
    const mock = mockClient([start(), value]);
    await assert.rejects(captureQaReact(mock.client), sanitized);
    assert.equal(mock.calls.length, 2);
    assert.equal(JSON.stringify(mock.calls).includes(sentinel), false);
  }
});

test('tree parsing and incomplete or malformed public evidence fail without raw parser diagnostics', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  for (const tree of [
    { ...publicTree(), interactive: [null] },
    { ...publicTree(), interactive: [{ role: 'button', label: {} }] },
    {
      ...publicTree(),
      interactive: [{ role: 'button', capabilities: { fill: 'true', press: false } }],
    },
    { ...publicTree(), truncated: true },
    { ...publicTree(), truncated: 'false' },
    { ...publicTree(), verdict: {} },
    { ...publicTree(), verdict: { ...publicTree().verdict, complete: false } },
    { ...publicTree(), verdict: { ...publicTree().verdict, path: 'full' } },
    { ...publicTree(), verdict: { ...publicTree().verdict, reasons: [sentinel] } },
    { ...publicTree(), verdict: { ...publicTree().verdict, rendererErrors: 1 } },
    { ...publicTree(), hostEvidence: { hosts: [], complete: false } },
    { ...publicTree(), hostEvidence: { hosts: [{}], complete: true } },
    [],
    null,
  ]) {
    const mock = mockClient([{ ...ready(), tree: JSON.stringify(tree) }]);
    await assert.rejects(captureQaReact(mock.client), sanitized);
  }
  for (const tree of [`{"private":"${sentinel}" BROKEN`, 'x'.repeat(1000000), {}, undefined]) {
    const mock = mockClient([{ ...ready(), tree }]);
    await assert.rejects(captureQaReact(mock.client), sanitized);
  }
  assert.equal(log.mock.callCount(), 0);
});

test('monotonic overall deadline includes freshness and prevents begin after timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let release!: () => void;
  let calls = 0;
  const client: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld(operation) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return operation(async () => {
        calls++;
        return start();
      });
    },
  };
  const result = assert.rejects(captureQaReact(client), (error) => {
    sanitized(error);
    assert.ok(error instanceof PrivateInputCaptureError);
    return true;
  });
  now = 1500;
  t.mock.timers.tick(1500);
  await result;
  release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls, 0);
});

test('each call receives only remaining budget and polling sleeps are bounded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timeouts: number[] = [];
  const client: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld(operation) {
      now = 400;
      return operation(async (_, timeout) => {
        timeouts.push(timeout);
        now += 300;
        return timeouts.length === 1 ? start() : ready();
      });
    },
  };
  const result = captureQaReact(client);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(timeouts, [1100]);
  now += 24;
  t.mock.timers.tick(24);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(timeouts, [1100]);
  now += 1;
  t.mock.timers.tick(1);
  await result;
  assert.deepEqual(timeouts, [1100, 775]);
});

test('hung begin and late completion cannot bypass the overall deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let release!: (value: unknown) => void;
  let calls = 0;
  const client: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld(operation) {
      return operation(async () => {
        calls++;
        return new Promise<unknown>((resolve) => {
          release = resolve;
        });
      });
    },
  };
  const result = assert.rejects(captureQaReact(client), (error) => {
    sanitized(error);
    assert.ok(error instanceof PrivateInputCaptureError);
    return true;
  });
  now = 1500;
  t.mock.timers.tick(1500);
  await result;
  release(start());
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls, 1);
});

test('port completion after the monotonic deadline cannot return an observation', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const client: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld(operation) {
      const observation = await operation(async () => ({ ...ready() }));
      now = 1501;
      return observation;
    },
  };
  await assert.rejects(captureQaReact(client), (error) => {
    sanitized(error);
    assert.ok(error instanceof PrivateInputCaptureError);
    return true;
  });
});

test('malformed ready tree processing across the deadline remains a permanent refusal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const parse = JSON.parse;
  const parsing = t.mock.method(JSON, 'parse', (text: string) => {
    now = 1501;
    return parse(text);
  });
  const client: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld(operation) {
      return operation(async () => {
        now = 1499;
        return {
          ...ready(),
          tree: `{"private":"${sentinel}" BROKEN`,
        };
      });
    },
  };
  await assert.rejects(captureQaReact(client), (error) => {
    sanitized(error);
    assert.ok(error instanceof PrivateInputCaptureError);
    return true;
  });
  assert.equal(parsing.mock.callCount(), 1);
  assert.equal(now, 1501);
});

test('a transport error after the deadline remains a permanent refusal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const client: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld() {
      now = 1501;
      throw new Error(sentinel);
    },
  };
  await assert.rejects(captureQaReact(client), (error) => {
    sanitized(error);
    assert.ok(error instanceof PrivateInputCaptureError);
    return true;
  });
});

test('the handlerless digest fact survives capture and a malformed one refuses', async () => {
  const capture = (entry: Record<string, unknown>) =>
    captureQaReact(
      mockClient([
        {
          ...ready(),
          tree: JSON.stringify({
            ...publicTree(),
            interactive: [entry],
            hostEvidence: { complete: true, hosts: [] },
          }),
        },
      ]).client,
    );
  const entry = {
    role: 'adjustable',
    capabilities: { press: false, fill: false },
    handlerless: true,
  };
  assert.deepEqual((await capture(entry)).interactive, [entry]);
  await assert.rejects(capture({ ...entry, handlerless: false }), PrivateInputCaptureError);
  await assert.rejects(
    capture({ ...entry, capabilities: { press: true, fill: false } }),
    PrivateInputCaptureError,
  );
  await assert.rejects(
    capture({ role: 'adjustable', handlerless: true }),
    PrivateInputCaptureError,
  );
});

test('the hidden digest fact survives capture and a malformed one refuses', async () => {
  const capture = (entry: Record<string, unknown>) =>
    captureQaReact(
      mockClient([
        {
          ...ready(),
          tree: JSON.stringify({
            ...publicTree(),
            interactive: [entry],
            hostEvidence: { complete: true, hosts: [] },
          }),
        },
      ]).client,
    );
  const entry = { role: 'button', testID: 'home-btn', hidden: true };
  assert.deepEqual((await capture(entry)).interactive, [entry]);
  await assert.rejects(capture({ ...entry, hidden: 'yes' }), PrivateInputCaptureError);
});

test('a QA render-error observation survives capture without exporting private helper fields', async () => {
  const observation = await captureQaReact({
    async withPrivateHelperWorld(read) {
      return read(async () => ({ v: 1, id, state: 'refused', reason: 'render-error' }));
    },
  });
  assert.deepEqual(observation, { renderError: true });
  const screen = await captureScreen({
    requirePrivateInputs: true,
    native: async () =>
      attested([
        { ref: '@error', type: 'StaticText', label: 'Render Error: boom', hittable: false },
        { ref: '@input', type: 'TextField', value: sentinel, secure: true, hittable: true },
      ]),
    react: async () => observation,
  });
  assert.equal(screen.renderError, true);
  assert.ok(screen.visibleText.some((text) => text.includes('boom')));
  assert.ok(!JSON.stringify(screen).includes(sentinel));
});

test('the injected producer reports a render error in literal and phrase capture modes', async () => {
  for (const typography of [false, true]) {
    const sandbox = createSandbox({ fiberRoot: buildFiber({ name: 'RedBox' }) });
    const observation = await captureQaReact(
      {
        async withPrivateHelperWorld(read) {
          return read(async (expression) => await vm.runInNewContext(expression, sandbox));
        },
      },
      typography,
    );
    assert.deepEqual(observation, { renderError: true });
  }
});

test('only the fixed render-error refusal maps to a render error; other refusal shapes fail closed', async () => {
  for (const reply of [
    { v: 1, id, state: 'refused' },
    { v: 1, id, state: 'refused', reason: 'other' },
    { v: 1, id, state: 'refused', reason: 'render-error', tree: '{}' },
    { v: 1, id, state: 'ready', reason: 'render-error', tree: '{}' },
    { v: 1, id, state: 'ready', tree: JSON.stringify({ warning: 'APP_HAS_REDBOX' }) },
  ]) {
    await assert.rejects(
      captureQaReact({
        async withPrivateHelperWorld(read) {
          return read(async () => reply);
        },
      }),
      PrivateInputCaptureError,
      JSON.stringify(reply),
    );
  }
});

function classified(reason: string, counters: Record<string, number> = {}) {
  return (error: unknown): boolean => {
    sanitized(error);
    assert.ok(error instanceof ReactCaptureIncomplete);
    assert.equal(error.reason, reason);
    const { ms, ...rest } = error.counters;
    assert.ok(Number.isSafeInteger(ms));
    assert.deepEqual(rest, counters);
    for (const text of [error.message, error.detail, inspect(error)])
      assert.equal(text.includes(sentinel), false);
    return true;
  };
}

function readyWith(tree: unknown) {
  return [{ ...ready(), tree: typeof tree === 'string' ? tree : JSON.stringify(tree) }];
}

const treeCounters = { scanned: 40, roots: 2, hosts: 1, interactive: 1 };
function countedTree(patch: Record<string, unknown>) {
  const tree = publicTree();
  return {
    ...tree,
    totalNodes: 40,
    rootsSeeded: 2,
    ...patch,
    verdict: { ...tree.verdict, scannedNodes: 40, rootsSeeded: 2, ...(patch.verdict as object) },
  };
}

test('each consumer refusal site carries one fixed cause and integer counters', async () => {
  const entry = { role: 'button', label: sentinel };
  const cases: Array<[string, unknown[], string, Record<string, number>]> = [
    ['start wire', [{ ...start(), extra: sentinel }], 'completion-shape', {}],
    ['non-string tree', [{ ...ready(), tree: 7 }], 'completion-shape', {}],
    ['oversized tree', readyWith(`"${sentinel}${'x'.repeat(1000000)}"`), 'tree-too-large', {}],
    ['producer size marker', readyWith({ __agent_truncated: true }), 'tree-too-large', {}],
    ['unparseable tree', readyWith(`{${sentinel}`), 'tree-shape', {}],
    ['missing interactive', readyWith({ label: sentinel }), 'tree-shape', {}],
    [
      'interactive cap',
      readyWith(countedTree({ interactive: Array.from({ length: 201 }, () => entry) })),
      'interactive-cap',
      { ...treeCounters, interactive: 201 },
    ],
    ['truncated', readyWith(countedTree({ truncated: true })), 'truncated', treeCounters],
    [
      'verdict reasons',
      readyWith(
        countedTree({
          verdict: { state: 'degraded', reasons: ['scan-budget-exhausted', sentinel] },
        }),
      ),
      'verdict-reasons:scan-budget-exhausted,unrecognized',
      treeCounters,
    ],
    [
      'verdict counts',
      readyWith(countedTree({ verdict: { droppedSubtrees: 2, unscannedRendererIds: [3] } })),
      'verdict-reasons:unscanned-renderers,dropped-subtrees',
      treeCounters,
    ],
    [
      'verdict state',
      readyWith(countedTree({ verdict: { complete: false } })),
      'verdict-reasons:incomplete',
      treeCounters,
    ],
    [
      'host evidence',
      readyWith(countedTree({ hostEvidence: { ...publicTree().hostEvidence, complete: false } })),
      'host-evidence-incomplete',
      treeCounters,
    ],
    [
      'entry shape',
      readyWith(countedTree({ interactive: [{ role: 'textinput', value: sentinel }] })),
      'entry-shape',
      treeCounters,
    ],
  ];
  for (const [name, responses, reason, counters] of cases) {
    const mock = mockClient(responses);
    await assert.rejects(captureQaReact(mock.client), classified(reason, counters), name);
  }
});

test('a producer refusal forwards its fixed cause and counters, and anything else fails closed', async () => {
  const diagnostic = {
    cause: 'truncated',
    scanned: 5000,
    budget: 5000,
    roots: 3,
    hosts: 812,
    interactive: 143,
    queued: 7,
    pruned: 4,
  };
  const refused = { v: 1, id, state: 'refused' };
  await assert.rejects(
    captureQaReact(mockClient([{ ...refused, diagnostic }]).client),
    classified('truncated', {
      scanned: 5000,
      budget: 5000,
      roots: 3,
      hosts: 812,
      interactive: 143,
      queued: 7,
      pruned: 4,
    }),
  );
  for (const cause of [
    'overlay-scan-cap',
    'digest-prop-opaque',
    'digest-visit-cap',
    'typography-deadline',
    'typography-incomplete',
  ]) {
    await assert.rejects(
      captureQaReact(mockClient([{ ...refused, diagnostic: { cause, scanned: 1624 } }]).client),
      classified(cause, { scanned: 1624 }),
    );
  }
  await assert.rejects(
    captureQaReact(
      mockClient([start(), { ...refused, diagnostic: { cause: 'tree-changed' } }]).client,
    ),
    classified('tree-changed'),
  );
  await assert.rejects(
    captureQaReact(
      mockClient([{ ...refused, diagnostic: { ...diagnostic, hosts: sentinel } }]).client,
    ),
    classified('truncated', {
      scanned: 5000,
      budget: 5000,
      roots: 3,
      interactive: 143,
      queued: 7,
      pruned: 4,
    }),
  );
  for (const hostile of [
    { ...refused, diagnostic: { cause: sentinel } },
    { ...refused, diagnostic: { cause: 'truncated', label: sentinel } },
    { ...refused, diagnostic: { cause: `verdict-reasons:${sentinel}` } },
    { ...refused, reason: 'render-error', diagnostic },
    { ...ready(), diagnostic },
    { ...start(), diagnostic },
  ]) {
    await assert.rejects(
      captureQaReact(mockClient([hostile]).client),
      classified('completion-shape'),
      JSON.stringify(hostile),
    );
  }
});

test('deadline, transport and helper-world failures are told apart', async () => {
  const pending: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    withPrivateHelperWorld: () => new Promise(() => {}),
  };
  await assert.rejects(captureQaReact(pending), classified('deadline'));
  const broken: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld() {
      throw new Error(`Private helper world unavailable ${sentinel}`);
    },
  };
  await assert.rejects(captureQaReact(broken), classified('evaluate-error'));
  // The real helper world rewraps operation errors, so the classified refusal must survive it.
  const rewrapping: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: true,
    async withPrivateHelperWorld(operation) {
      try {
        return await operation(async () => ({ ...ready(), tree: `{${sentinel}` }));
      } catch {
        throw new Error('Private helper world unavailable');
      }
    },
  };
  await assert.rejects(captureQaReact(rewrapping), classified('tree-shape'));
});

test('a dropped connection is told apart from a capture limit, even past the deadline', async () => {
  const dropped = { isConnected: true };
  const pending: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    get isConnected() {
      return dropped.isConnected;
    },
    withPrivateHelperWorld: () => {
      dropped.isConnected = false;
      return new Promise(() => {});
    },
  };
  await assert.rejects(captureQaReact(pending), classified('disconnected'));
  const broken: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'> = {
    isConnected: false,
    async withPrivateHelperWorld() {
      throw new Error(`Private helper world unavailable ${sentinel}`);
    },
  };
  await assert.rejects(captureQaReact(broken), classified('disconnected'));
});

test('the real producer refusal reaches the warning as a value-free cause with counters', async () => {
  for (const typography of [false, true]) {
    const producer = realProducer({
      testID: sentinel,
      accessibilityRole: sentinel,
      value: sentinel,
    });
    const warnings: string[] = [];
    await captureScreen({
      observation: 23,
      platformPresence: typography,
      native: async () => nativeEcho(false),
      react: () => captureQaReact(producer.client, typography),
      warn: (message) => warnings.push(message),
    });
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /^interactive digest unavailable \(cause=host-evidence-incomplete; scanned=1\/5000; roots=1; hosts=1; interactive=0; queued=0; pruned=0; ms=\d+\); React coverage is unknown; observation=23 mode=(ordinary|platform-presence)$/,
    );
    assert.ok(warnings[0].endsWith(`mode=${typography ? 'platform-presence' : 'ordinary'}`));
    assert.equal(warnings[0].includes(sentinel), false);
  }
});

test('a reconnect is marked once, and a helper world still missing after re-injection is lost', async () => {
  const state = { generation: 1, helpers: true, revive: true, reinjected: 0, tree: ready() };
  const client: Pick<
    CDPClient,
    'withPrivateHelperWorld' | 'isConnected' | 'connectionGeneration' | 'reinjectHelpers'
  > = {
    isConnected: true,
    get connectionGeneration() {
      return state.generation;
    },
    async reinjectHelpers() {
      state.reinjected += 1;
      state.helpers = state.revive;
      return state.helpers;
    },
    async withPrivateHelperWorld(operation) {
      if (!state.helpers) throw new Error(`Private helper world unavailable ${sentinel}`);
      return operation(async () => state.tree);
    },
  };
  const capture = createQaReactCapture(client);
  assert.equal((await capture()).reconnected, undefined);
  state.generation = 2;
  assert.equal((await capture()).reconnected, true);
  assert.equal((await capture()).reconnected, undefined);
  assert.equal(state.reinjected, 0);

  state.generation = 3;
  state.helpers = false;
  assert.equal((await capture()).reconnected, true);
  assert.equal(state.reinjected, 1);

  state.generation = 4;
  state.helpers = false;
  state.revive = false;
  await assert.rejects(capture(), classified('disconnected'));
  assert.equal(state.reinjected, 2);

  state.helpers = true;
  assert.equal((await capture()).reconnected, true);
  assert.equal((await capture()).reconnected, undefined);
  assert.equal(state.reinjected, 2);

  state.generation = 5;
  state.helpers = true;
  state.tree = { ...ready(), tree: 'x'.repeat(1_000_000) };
  await assert.rejects(capture(), classified('reconnected'));
  await assert.rejects(capture(), classified('tree-too-large'));
  assert.equal(state.reinjected, 2);
});

test('a final capture during replacement socket setup refuses unavailable helpers', async (t) => {
  const fake = await startFakeCDP(0, {
    targets: [
      {
        id: 'owned',
        title: 'com.example.app (iPhone)',
        appId: 'com.example.app',
        type: 'node',
        vm: 'Hermes',
        deviceName: 'iPhone',
        description: 'React Native Bridgeless [C++ connection]',
      },
    ],
  });
  const client = new CDPClient(fake.port);
  const setupEntered = Promise.withResolvers<void>();
  const setupRelease = Promise.withResolvers<void>();
  let reconnect: Promise<string> | undefined;
  t.after(async () => {
    setupRelease.resolve();
    await reconnect?.catch(() => {});
    await client.disconnect();
    await fake.close();
  });
  await client.connectExact(fake.port, { platform: 'ios', bundleId: 'com.example.app' });
  const capture = createQaReactCapture(client);
  const generation = client.connectionGeneration;
  t.mock.method(client, 'setup', async () => {
    setupEntered.resolve();
    await setupRelease.promise;
  });
  const reinjection = t.mock.method(client, 'reinjectHelpers', async () => false);
  reconnect = client.softReconnect();
  await Promise.race([setupEntered.promise, reconnect]);
  assert.equal(client.isConnected, true);
  await assert.rejects(capture(), classified('disconnected'));
  assert.equal(client.connectionGeneration, generation + 1);
  assert.equal(reinjection.mock.callCount(), 1);
});

for (const recovered of [false, true]) {
  test(`a connection change during capture is observed when recovered=${recovered}`, async () => {
    let generation = 1;
    let captures = 0;
    let reinjections = 0;
    const client: Parameters<typeof createQaReactCapture>[0] = {
      isConnected: true,
      get connectionGeneration() {
        return generation;
      },
      async reinjectHelpers() {
        reinjections++;
        return false;
      },
      async withPrivateHelperWorld(operation) {
        captures++;
        if (captures === 1) generation++;
        if (!recovered) throw new Error('helper world unavailable');
        return operation(async () => ready());
      },
    };
    const capture = createQaReactCapture(client);
    if (recovered) {
      assert.equal((await capture()).reconnected, true);
      assert.equal((await capture()).reconnected, undefined);
    } else {
      await assert.rejects(capture(), classified('disconnected'));
      assert.equal(reinjections, 1);
    }
  });
}
