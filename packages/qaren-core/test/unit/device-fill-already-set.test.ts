import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CDPClient } from '../../dist/cdp-client.js';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  runIOS,
} from '../../dist/runners/qaren-ios-runner-client.js';
import { buildFiber, createSandbox } from './helpers/inject-harness.js';
import { createDeviceFillHandler, performExactFill } from '../../dist/handlers/device-interact.js';
import {
  _setActiveSessionForTest,
  _setRunAgentDeviceForTest,
  markSnapshotDirty,
} from '../../dist/agent-device-wrapper.js';
import { updateRefMapFromFlat, clearRefMap } from '../../dist/fast-runner-ref-map.js';
import { QaDispatchContext } from '../../dist/domain/qa-dispatch.js';
import { okResult } from '../../dist/utils.js';

const TEXT = 'fill-sentinel-882';
const NODE = {
  ref: '@e1',
  identifier: 'name',
  label: 'Name',
  type: 'TextField',
  rect: { x: 20, y: 100, width: 320, height: 40 },
};
type Args = Parameters<ReturnType<typeof createDeviceFillHandler>>[0];
type Call = {
  command: string[];
  opts: {
    exactTarget?: { inputRef: string; operationToken?: string };
    focusedProof?: () => Promise<boolean>;
  };
};

async function run(
  options: {
    args?: Partial<Args>;
    value?: string;
    verdict?: string;
    stable?: boolean;
    secure?: boolean;
    platform?: 'ios' | 'android';
    noClient?: boolean;
    noTestID?: boolean;
    uncontrolled?: boolean;
    focused?: boolean;
    changeOnConfirm?: boolean;
    onRead?: () => void;
    abortSignal?: AbortSignal;
    nativeClient?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const replies: string[] = [];
  let reads = 0;
  let clears = 0;
  let latched = 0;
  let value = options.value ?? TEXT;
  const props = {
    testID: 'name',
    value: options.uncontrolled ? undefined : value,
    defaultValue: value,
    placeholder: TEXT,
    secureTextEntry: options.secure === true,
    onChangeText(text: string) {
      clears++;
      value = text;
      props.value = text;
    },
  };
  const fiber = buildFiber({
    hostType: 'RCTSinglelineTextInputView',
    props,
    stateNode: { isFocused: () => options.focused !== false },
  });
  const sandbox = createSandbox({ fiberRoot: fiber });
  const client = new CDPClient();
  Object.defineProperty(client, 'isConnected', { get: () => true });
  Object.defineProperty(client, 'sendWithTimeout', {
    value: async (_method: string, params: { expression: string }) => {
      const expression = params.expression;
      if (expression.startsWith('__QAREN.readInputValue')) {
        reads++;
        options.onRead?.();
        if (options.changeOnConfirm && reads === (options.args?.focused ? 3 : 2))
          props.value = 'changed';
      }
      const result = vm.runInContext(expression, sandbox);
      replies.push(result);
      return { result: { value: result } };
    },
  });
  const diagnostics: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(' '));
  if (options.nativeClient) {
    _setFastRunnerStateForTest({
      schemaVersion: 1,
      pid: process.pid,
      port: 22657,
      deviceId: 'TEST-DEVICE',
      bundleId: 'com.test',
      startedAt: new Date(0).toISOString(),
      protocolVersion: 2,
    } as never);
    _setFetchForTest(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.command, 'verifyInput');
      assert.equal(body.text, TEXT);
      return new Response(
        JSON.stringify({
          ok: true,
          v: 2,
          data: {
            verifyVerdict: body.operationToken ? 'exact' : (options.verdict ?? 'exact'),
            verifyStable: true,
          },
        }),
      );
    });
  }
  const node = {
    ...NODE,
    ...(options.secure ? { type: 'SecureTextField' } : {}),
    ...(options.noTestID ? { identifier: undefined } : {}),
  };
  _setActiveSessionForTest({
    platform: options.platform ?? 'ios',
    deviceId: 'TEST-DEVICE',
    appId: 'com.test',
  });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat([node], { snapshotGeneration: 7, keyboardVisible: true });
  _setRunAgentDeviceForTest(async (command: string[], opts: Call['opts']) => {
    calls.push({ command, opts });
    if (command[0] === 'snapshot') {
      updateRefMapFromFlat([node], { snapshotGeneration: 8, keyboardVisible: true });
      return okResult({ nodes: [node] });
    }
    if (command[0] === 'verify-input') {
      if (options.nativeClient)
        return runIOS({
          command: 'verifyInput',
          text: command[2],
          operationToken: opts.exactTarget?.operationToken,
          snapshotIdentifier: 'name',
          snapshotElementType: 'TextField',
          snapshotGeneration: 8,
        } as never);
      return okResult({
        verifyVerdict: opts.exactTarget?.operationToken ? 'exact' : (options.verdict ?? 'exact'),
        verifyStable: options.stable ?? true,
      });
    }
    if (command[0] === 'fill') {
      if (opts.focusedProof) assert.equal(await opts.focusedProof(), true);
      props.value = command.includes('--clear-first')
        ? command[2]
        : (props.value ?? '') + command[2];
      return okResult({ typed: true });
    }
    throw new Error('unexpected command');
  });
  const args: Args = { ref: '@e1', text: TEXT, onPrivateInput: () => latched++, ...options.args };
  try {
    const result = options.abortSignal
      ? await performExactFill(args, options.noClient ? null : (client as never), {
          abortSignal: options.abortSignal,
        })
      : await createDeviceFillHandler(() =>
          options.noClient ? (null as never) : (client as never),
        )(args);
    const env = JSON.parse(result.content[0].text);
    assert.equal(result.content[0].text.includes(TEXT), false, 'receipts never retain the value');
    assert.equal(
      diagnostics.join('\n').includes(TEXT),
      false,
      'core and client diagnostics never retain the value',
    );
    return { env, calls, replies, reads, clears, latched };
  } finally {
    console.error = originalError;
    if (options.nativeClient) {
      _setFetchForTest(globalThis.fetch);
      _setFastRunnerStateForTest(null);
    }
    _setActiveSessionForTest(null);
    _setRunAgentDeviceForTest(null);
    clearRefMap();
  }
}

function preReads(calls: Call[]) {
  return calls.filter(
    (c) => c.command[0] === 'verify-input' && !c.opts.exactTarget?.operationToken,
  );
}
function fills(calls: Call[]) {
  return calls.filter((c) => c.command[0] === 'fill');
}

function skipped(env: any) {
  assert.equal(env.ok, true);
  assert.equal(env.meta.fillMethod, 'already-set');
  assert.equal(env.meta.verify, 'exact');
  assert.equal(env.meta.mutation, 'none');
}

test('an exact stable pre-read survives the exported handler without native typing', async () => {
  const result = await run();
  skipped(result.env);
  assert.equal(fills(result.calls).length, 0);
  assert.equal(preReads(result.calls).length, 1);
  assert.equal(preReads(result.calls)[0].opts.exactTarget?.inputRef, '@e1');
  assert.deepEqual(
    result.calls.map((c) => c.command[0]),
    ['snapshot', 'verify-input'],
  );
});

test('a private pre-read does not report a typing readback metric', async () => {
  const timings: unknown[] = [];
  const result = await run({
    args: {
      privateValue: true,
      qaTiming: { now: () => 1, observe: (event) => timings.push(event) },
    },
  });
  skipped(result.env);
  assert.deepEqual(timings, []);
});

for (const verdict of [
  'mismatch',
  'case-normalized',
  'unreadable',
  'secure-masked',
  'target-lost',
  'ambiguous',
  'unavailable',
]) {
  test(`a ${verdict} pre-read keeps clear-then-type`, async () => {
    const result = await run({ verdict });
    assert.equal(fills(result.calls).length, 1);
    assert.deepEqual(fills(result.calls)[0].command, ['fill', '@e1', TEXT, '--clear-first']);
    assert.equal(result.env.meta.fillMethod, 'keyboard');
  });
}

test('an unstable exact pre-read keeps typing', async () => {
  const result = await run({ stable: false });
  assert.equal(fills(result.calls).length, 1);
});

for (const options of [
  { args: { alwaysRetype: true } },
  { secure: true },
  { platform: 'android' as const },
]) {
  test('opt-out, secure fields and Android never pre-read', async () => {
    const result = await run(options);
    assert.equal(preReads(result.calls).length, 0);
    assert.equal(result.reads, 0);
    assert.equal(fills(result.calls).length, 1);
  });
}

test('a private exact value is compared in the app with the live client and latches privacy', async () => {
  const result = await run({ args: { privateValue: true } });
  skipped(result.env);
  assert.equal(result.reads, 2);
  assert.equal(result.latched, 1);
  assert.equal(
    result.calls.some((c) => c.command[0] === 'verify-input' || c.command[0] === 'fill'),
    false,
  );
  assert.equal(
    result.replies.some((r) => r.includes(TEXT)),
    false,
  );
});

for (const options of [
  { noClient: true },
  { noTestID: true },
  { uncontrolled: true },
  { changeOnConfirm: true },
]) {
  test('private comparison needs an identity, client and two controlled exact reads', async () => {
    const result = await run({ ...options, args: { privateValue: true } });
    assert.equal(fills(result.calls).length, 1);
    assert.equal(preReads(result.calls).length, 0);
    assert.notEqual(result.env.meta.fillMethod, 'already-set');
    assert.equal(
      result.replies.some((r) => r.includes(TEXT)),
      false,
    );
  });
}

for (const privateValue of [false, true]) {
  test('focused replacement skips before clear and post-typing verification', async () => {
    const result = await run({
      args: { focused: true, testID: 'name', clearFirst: true, privateValue },
    });
    skipped(result.env);
    assert.equal(result.clears, 0);
    assert.equal(fills(result.calls).length, 0);
    assert.equal(result.latched, privateValue ? 2 : 0);
    assert.equal(result.reads, 3);
  });
}

for (const args of [{ clearFirst: false }, { clearFirst: true, alwaysRetype: true }]) {
  test('focused append and always-retype do type an equal value', async () => {
    const result = await run({ args: { focused: true, testID: 'name', ...args } });
    assert.ok(fills(result.calls).length > 0);
    assert.notEqual(result.env.meta.fillMethod, 'already-set');
  });
}

for (const options of [
  { uncontrolled: true },
  { focused: false },
  { changeOnConfirm: true },
  { value: TEXT.toUpperCase() },
  { value: 'fill sentinel 882' },
]) {
  test('focused skipping refuses uncontrolled, unfocused, changed and formatted values', async () => {
    const result = await run({
      ...options,
      args: { focused: true, testID: 'name', clearFirst: true },
    });
    assert.notEqual(result.env.meta?.fillMethod, 'already-set');
  });
}

for (const cancelled of [false, true]) {
  test('an expired or cancelled context refuses before the pre-read', async () => {
    const context = new QaDispatchContext(
      cancelled ? 100 : 0,
      () => 0,
      () => cancelled,
    );
    await assert.rejects(run({ args: { qaContext: context } }), {
      code: cancelled ? 'RUN_CANCELLED' : 'EVIDENCE_EXPIRED',
    });
  });
}

test('an aborted exact fill refuses before the pre-read', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await run({ abortSignal: controller.signal });
  assert.equal(result.env.meta.mutation, 'none');
  assert.equal(preReads(result.calls).length, 0);
  assert.equal(fills(result.calls).length, 0);
});

test('expiry during private confirmation cannot become a skip', async () => {
  let now = 0;
  const context = new QaDispatchContext(10, () => now);
  await assert.rejects(
    run({
      args: { privateValue: true, qaContext: context },
      onRead: () => {
        now = 10;
      },
    }),
    { code: 'EVIDENCE_EXPIRED' },
  );
});

for (const verdict of ['exact', 'unreadable']) {
  test(`the native client keeps the value out of diagnostics on ${verdict} pre-read`, async () => {
    const result = await run({ nativeClient: true, verdict });
    if (verdict === 'exact') skipped(result.env);
    assert.equal(fills(result.calls).length, verdict === 'exact' ? 0 : 1);
  });
}
