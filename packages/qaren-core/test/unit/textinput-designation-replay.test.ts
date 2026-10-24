import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { ReplayDispatchError } from '../../dist/domain/cdp-flow-replay.js';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import {
  createReplayPressByTestId,
  runCdpReplayCommands,
  unwrapTree,
  type CdpReplayDeps,
} from '../../dist/handlers/cdp-replay-dispatch.js';
import { performReactTreeInput } from '../../dist/handlers/device-interact.js';
import { createInteractHandler } from '../../dist/handlers/interact.js';
import { createMaestroRunHandler } from '../../dist/handlers/maestro-run.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

type Fiber = {
  tag: number;
  type: string | { displayName: string };
  memoizedProps: Record<string, unknown>;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate: Fiber | null;
};

function fiber(type: Fiber['type'], memoizedProps: Record<string, unknown> = {}): Fiber {
  return {
    tag: typeof type === 'string' ? 5 : 0,
    type,
    memoizedProps,
    child: null,
    sibling: null,
    return: null,
    alternate: null,
  };
}

function append(parent: Fiber, child: Fiber): Fiber {
  child.return = parent;
  if (!parent.child) {
    parent.child = child;
    return child;
  }
  let tail = parent.child;
  while (tail.sibling) tail = tail.sibling;
  tail.sibling = child;
  return child;
}

function replayFixture(
  options: {
    editable?: boolean;
    readOnly?: boolean;
    wrapped?: boolean;
    exactMiddle?: boolean;
    exactMiddleDisabled?: boolean;
    branchedDuplicate?: boolean;
    inputHidden?: boolean;
    inputValue?: string;
    oversizedDesignationSubtree?: boolean;
    designationFillers?: number;
    stockTextInput?: boolean;
    ownerIsInputAlternate?: boolean;
    matchPresentOnlyAsAlternate?: boolean;
    beforeDesignatedTypeDispatch?: (fixture: {
      root: Fiber;
      input: Fiber;
      designationOwner: Fiber;
      exactMiddle: Fiber | null;
    }) => void;
  } = {},
) {
  const calls = { focus: 0, press: 0, typed: [] as string[] };
  const root = fiber({ displayName: 'Root' });
  const wrapper = options.wrapped ? append(root, fiber('RCTView', { testID: 'email' })) : null;
  const exactMiddle = options.exactMiddle
    ? append(
        wrapper ?? root,
        fiber('RCTView', {
          testID: 'email',
          ...(options.exactMiddleDisabled ? { accessibilityState: { disabled: true } } : {}),
        }),
      )
    : null;
  const userProps = {
    testID: 'email',
    editable: options.editable ?? true,
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(options.inputHidden ? { style: { display: 'none' } } : {}),
    value: options.inputValue ?? '',
    onFocus: () => {
      calls.focus += 1;
    },
    onChangeText: (value: string) => {
      calls.typed.push(value);
      input.memoizedProps.value = value;
    },
  };
  const composite = options.stockTextInput
    ? append(exactMiddle ?? wrapper ?? root, fiber({ displayName: 'TextInput' }, { ...userProps }))
    : null;
  if (composite) composite.tag = 11;
  const input = append(
    composite ?? exactMiddle ?? wrapper ?? root,
    fiber('RCTSinglelineTextInputView', {
      ...userProps,
      ...(composite ? { onChange: () => {}, text: userProps.value } : {}),
    }),
  );
  if (options.branchedDuplicate) {
    append(wrapper ?? root, fiber('RCTView', { testID: 'email' }));
  }
  const designationFillers = options.oversizedDesignationSubtree
    ? 21_000
    : (options.designationFillers ?? 0);
  if (designationFillers > 0) {
    const parent = wrapper ?? root;
    let tail = append(parent, fiber('RCTView', { testID: 'filler-0' }));
    for (let filler = 1; filler < designationFillers; filler++) {
      const next = fiber('RCTView', { testID: `filler-${filler}` });
      next.return = parent;
      tail.sibling = next;
      tail = next;
    }
  }
  append(
    root,
    fiber('RCTView', {
      testID: 'continue',
      onPress: () => {
        calls.press += 1;
      },
    }),
  );
  if (options.ownerIsInputAlternate && wrapper) {
    const liveOwner = wrapper;
    const staleOwner = fiber('RCTView', { testID: 'email' });
    staleOwner.alternate = liveOwner;
    liveOwner.alternate = staleOwner;
    staleOwner.child = liveOwner.child;
    staleOwner.sibling = liveOwner.sibling;
    liveOwner.sibling = null;
    staleOwner.return = root;
    root.child = staleOwner;
  }
  if (options.matchPresentOnlyAsAlternate && wrapper) {
    const extraMatch = fiber('RCTView', { testID: 'email' });
    extraMatch.alternate = input;
    extraMatch.return = wrapper;
    extraMatch.sibling = input.sibling;
    input.sibling = extraMatch;
  }

  const sandbox: Record<string, unknown> = {
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Set,
    Error,
    Date,
    RegExp,
    Symbol,
    parseInt,
    parseFloat,
    String,
    Number,
    Boolean,
    Promise,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.__expo_router_state__ = { routeName: 'ReplayFixture' };
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (rendererId: number) =>
      rendererId === 1
        ? options.oversizedDesignationSubtree
          ? new Set([
              { current: root },
              { current: fiber({ displayName: 'Root' }) },
              { current: fiber({ displayName: 'Root' }) },
            ])
          : new Set([{ current: root }])
        : new Set(),
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);

  const client = createMockClient({
    evaluate: async (expression: string) => {
      try {
        if (
          options.beforeDesignatedTypeDispatch &&
          expression.startsWith('__QAREN.interact(') &&
          JSON.parse(expression.slice(expression.indexOf('(') + 1, -1))
            .requireLiveInputDesignation === true
        ) {
          options.beforeDesignatedTypeDispatch({
            root,
            input,
            designationOwner: wrapper ?? input,
            exactMiddle,
          });
        }
        return { value: vm.runInContext(expression, sandbox) };
      } catch (error) {
        return { error };
      }
    },
    probeHelperFreshness: async () => ({ fresh: true, version: 57, probed: true }),
  });
  const interact = createInteractHandler(() => client);
  const deps: CdpReplayDeps = {
    pressByTestId: createReplayPressByTestId(interact),
    typeByTestId: async (id, text, context) => {
      const result = await performReactTreeInput(
        id,
        text,
        client,
        undefined,
        context ? { designationToken: context.designationToken } : {},
      );
      const envelope = JSON.parse(result.content[0]?.text ?? '{}') as {
        ok?: boolean;
        code?: string;
        error?: string;
        meta?: Record<string, unknown>;
      };
      if (envelope.ok === false) {
        throw new ReplayDispatchError(
          envelope.code ?? 'TEXT_ENTRY_UNVERIFIED',
          envelope.error ?? `type "${id}" failed`,
          envelope.meta,
        );
      }
    },
    releaseInputDesignation: async (token) => {
      await client.evaluate(`__QAREN.releaseInputDesignation(${JSON.stringify(token)})`);
    },
    treeFor: async (id) => {
      const result = await client.evaluate(
        `__QAREN.getTree(${JSON.stringify({ filter: id, depth: 12 })})`,
      );
      assert.equal(result.error, undefined);
      assert.equal(typeof result.value, 'string');
      return unwrapTree(JSON.parse(result.value as string));
    },
    frontmostFor: async () => ({ visible: true, matchCount: 1 }),
    async launchApp() {},
    async settle() {},
  };

  return { calls, input, deps, client };
}

for (const options of [
  { secure: true, protectSecure: true },
  { privateValue: true },
  { focusOnly: true },
]) {
  test('private and focus-only input probes never read the value property', async () => {
    const fixture = replayFixture();
    fixture.input.memoizedProps.secureTextEntry = 'secure' in options;
    let reads = 0;
    Object.defineProperty(fixture.input.memoizedProps, 'value', {
      get() {
        reads++;
        throw new Error('private value was read');
      },
    });
    const result = await fixture.client.evaluate(
      `__QAREN.readInputValue("email",${JSON.stringify(options)})`,
    );
    assert.equal(result.error, undefined);
    assert.equal(JSON.parse(result.value as string).value, null);
    assert.equal(reads, 0);
  });
}

test('replay designates a bare TextInput and types without press or focus dispatch', async () => {
  const fixture = replayFixture();
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'person@example.test' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(result.steps[1].target, 'email');
  assert.equal(result.finalFocusId, null);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.press, 0);
  assert.deepEqual(fixture.calls.typed, ['person@example.test']);
  assert.equal(fixture.input.memoizedProps.value, 'person@example.test');
});

test('replay designates and types into a stock TextInput rendered as composite plus host', async () => {
  const fixture = replayFixture({ stockTextInput: true, inputValue: 'a' });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'b' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(result.steps[1].ok, true);
  assert.equal(result.finalFocusId, null);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.press, 0);
  assert.deepEqual(fixture.calls.typed, ['ab']);
  assert.equal(fixture.input.memoizedProps.value, 'ab');
});

test('replay designates and verifies typing beyond the former 2000-node cap', async () => {
  const fixture = replayFixture({ wrapped: true, designationFillers: 2_100 });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'person@example.test' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(result.steps[1].ok, true);
  assert.equal(result.finalFocusId, null);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.press, 0);
  assert.deepEqual(fixture.calls.typed, ['person@example.test']);
  assert.equal(fixture.input.memoizedProps.value, 'person@example.test');
});

test('a truncated designation scan refuses the press as an unproven assertion', async () => {
  const fixture = replayFixture({ wrapped: true, oversizedDesignationSubtree: true });

  const error = await fixture.deps.pressByTestId('email').then(
    () => null,
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof ReplayDispatchError, `expected a refusal, got ${String(error)}`);
  assert.equal(error.code, 'ASSERTION_FAILED');
  assert.match(error.message, /TextInput designation resolution truncated/);
  assert.doesNotMatch(error.message, /Resolution truncated/);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.press, 0);
  assert.deepEqual(fixture.calls.typed, []);
});

test('designation refuses a replacement input with the same selector and value shape', async () => {
  let replacement: Fiber | null = null;
  let replacementCalls = 0;
  const fixture = replayFixture({
    inputValue: 'a',
    beforeDesignatedTypeDispatch: ({ input }) => {
      const parent = input.return!;
      replacement = fiber('RCTSinglelineTextInputView', {
        testID: 'email',
        editable: true,
        value: 'b',
        onChangeText: () => {
          replacementCalls++;
        },
      });
      replacement.return = parent;
      replacement.sibling = input.sibling;
      parent.child = replacement;
      input.return = null;
      input.sibling = null;
    },
  });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'x' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 1);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /no longer owns the exact host input/);
  assert.deepEqual(fixture.calls.typed, []);
  assert.equal(replacementCalls, 0);
  assert.equal(replacement?.memoizedProps.value, 'b');
});

test("designation succeeds when the owner is the input's React alternate", async () => {
  const fixture = replayFixture({ wrapped: true, ownerIsInputAlternate: true });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'person@example.test' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.press, 0);
  assert.deepEqual(fixture.calls.typed, ['person@example.test']);
  assert.equal(fixture.input.memoizedProps.value, 'person@example.test');
});

test("designation succeeds when a same-id match is present only as that match's alternate", async () => {
  const fixture = replayFixture({ wrapped: true, matchPresentOnlyAsAlternate: true });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'person@example.test' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.press, 0);
  assert.deepEqual(fixture.calls.typed, ['person@example.test']);
  assert.equal(fixture.input.memoizedProps.value, 'person@example.test');
});

test('designation follows the original input across its React alternate', async () => {
  const alternateTyped: string[] = [];
  const fixture = replayFixture({
    inputValue: 'a',
    beforeDesignatedTypeDispatch: ({ input }) => {
      const parent = input.return!;
      const alternate = fiber('RCTSinglelineTextInputView', {
        ...input.memoizedProps,
        value: 'b',
        onChangeText: (value: string) => {
          alternateTyped.push(value);
          alternate.memoizedProps.value = value;
        },
      });
      input.alternate = alternate;
      alternate.alternate = input;
      alternate.return = parent;
      alternate.sibling = input.sibling;
      parent.child = alternate;
    },
  });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'x' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(alternateTyped, ['bx']);
});

test('an intervening non-input tap makes later text entry refuse without reaching the input', async () => {
  const fixture = replayFixture();
  const result = await runCdpReplayCommands(
    [
      { tapOn: { id: 'email' } },
      { tapOn: { id: 'continue' } },
      { inputText: 'must-not-reach-email' },
    ],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 2);
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(result.steps[1].focusOnly, undefined);
  assert.equal(fixture.calls.press, 1);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, []);
  assert.equal(fixture.input.memoizedProps.value, '');
});

test('a designation without typing is explicit and refuses the replay', async () => {
  const fixture = replayFixture();
  const result = await runCdpReplayCommands([{ tapOn: { id: 'email' } }], {}, fixture.deps);

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /must be followed immediately by inputText/);
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.press, 0);
  assert.deepEqual(fixture.calls.typed, []);
});

test('a non-editable bare TextInput refuses designation without callbacks', async () => {
  const fixture = replayFixture({ editable: false });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.press, 0);
  assert.deepEqual(fixture.calls.typed, []);
  assert.equal(fixture.input.memoizedProps.value, '');
});

test('a read-only bare TextInput refuses designation without callbacks', async () => {
  const fixture = replayFixture({ readOnly: true });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /disabled or non-editable/);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.press, 0);
  assert.deepEqual(fixture.calls.typed, []);
  assert.equal(fixture.input.memoizedProps.value, '');
});

test('a hidden host TextInput beneath a visible wrapper refuses designation', async () => {
  const fixture = replayFixture({ wrapped: true, inputHidden: true });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /hidden or occluded/);
  assert.deepEqual(fixture.calls.typed, []);
  assert.equal(fixture.input.memoizedProps.value, '');
});

test('a disabled intermediate exact target refuses designation', async () => {
  const fixture = replayFixture({
    wrapped: true,
    exactMiddle: true,
    exactMiddleDisabled: true,
  });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /disabled/);
  assert.deepEqual(fixture.calls.typed, []);
  assert.equal(fixture.input.memoizedProps.value, '');
});

test('a branched duplicate exact target refuses designation', async () => {
  const fixture = replayFixture({ wrapped: true, branchedDuplicate: true });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
    {},
    fixture.deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /Ambiguous TextInput designation target/);
  assert.deepEqual(fixture.calls.typed, []);
  assert.equal(fixture.input.memoizedProps.value, '');
});

test('designation preserves the frontmost and duplicate-target refusals', async (t) => {
  await t.test('occluded input', async () => {
    const fixture = replayFixture();
    fixture.deps.frontmostFor = async () => ({
      visible: false,
      reason: 'target is covered by a modal',
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 0);
    assert.match(result.reason ?? '', /covered by a modal/);
    assert.equal(fixture.calls.focus, 0);
    assert.equal(fixture.calls.press, 0);
    assert.deepEqual(fixture.calls.typed, []);
  });

  await t.test('duplicate exact input', async () => {
    const fixture = replayFixture();
    fixture.deps.frontmostFor = async () => ({ visible: true, matchCount: 2 });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 0);
    assert.equal(result.failureCode, 'AMBIGUOUS_TESTID');
    assert.equal(fixture.calls.focus, 0);
    assert.equal(fixture.calls.press, 0);
    assert.deepEqual(fixture.calls.typed, []);
  });
});

test('designation rechecks live eligibility at the injected mutation boundary', async (t) => {
  await t.test('host input stops accepting pointer events', async () => {
    const fixture = replayFixture({
      wrapped: true,
      beforeDesignatedTypeDispatch: ({ input }) => {
        input.memoizedProps.pointerEvents = 'none';
      },
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 1);
    assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
    assert.match(result.reason ?? '', /pointerEvents="none"/);
    assert.deepEqual(fixture.calls.typed, []);
    assert.equal(fixture.input.memoizedProps.value, '');
  });

  await t.test('matched wrapper becomes disabled', async () => {
    const fixture = replayFixture({
      wrapped: true,
      beforeDesignatedTypeDispatch: ({ designationOwner }) => {
        designationOwner.memoizedProps.disabled = true;
      },
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 1);
    assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
    assert.match(result.reason ?? '', /disabled or non-editable/);
    assert.deepEqual(fixture.calls.typed, []);
    assert.equal(fixture.input.memoizedProps.value, '');
  });

  await t.test('intermediate exact target becomes disabled', async () => {
    const fixture = replayFixture({
      wrapped: true,
      exactMiddle: true,
      beforeDesignatedTypeDispatch: ({ exactMiddle }) => {
        exactMiddle!.memoizedProps.accessibilityState = { disabled: true };
      },
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 1);
    assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
    assert.match(result.reason ?? '', /disabled or non-editable/);
    assert.deepEqual(fixture.calls.typed, []);
    assert.equal(fixture.input.memoizedProps.value, '');
  });

  await t.test('branched duplicate exact target mounts', async () => {
    const fixture = replayFixture({
      wrapped: true,
      beforeDesignatedTypeDispatch: ({ designationOwner }) => {
        append(designationOwner, fiber('RCTView', { testID: 'email' }));
      },
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 1);
    assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
    assert.match(result.reason ?? '', /Ambiguous TextInput designation target/);
    assert.deepEqual(fixture.calls.typed, []);
    assert.equal(fixture.input.memoizedProps.value, '');
  });

  await t.test('input becomes non-editable', async () => {
    const fixture = replayFixture({
      beforeDesignatedTypeDispatch: ({ input }) => {
        input.memoizedProps.editable = false;
      },
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 1);
    assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
    assert.match(result.reason ?? '', /disabled or non-editable/);
    assert.deepEqual(fixture.calls.typed, []);
    assert.equal(fixture.input.memoizedProps.value, '');
  });

  await t.test('input becomes read-only', async () => {
    const fixture = replayFixture({
      beforeDesignatedTypeDispatch: ({ input }) => {
        input.memoizedProps.readOnly = true;
      },
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 1);
    assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
    assert.match(result.reason ?? '', /disabled or non-editable/);
    assert.deepEqual(fixture.calls.typed, []);
    assert.equal(fixture.input.memoizedProps.value, '');
  });

  await t.test('exact target ceases to be a host TextInput', async () => {
    const fixture = replayFixture({
      beforeDesignatedTypeDispatch: ({ input }) => {
        input.type = 'RCTView';
      },
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 1);
    assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
    assert.match(result.reason ?? '', /exact host input/);
    assert.deepEqual(fixture.calls.typed, []);
    assert.equal(fixture.input.memoizedProps.value, '');
  });

  await t.test('duplicate exact input mounts', async () => {
    const fixture = replayFixture({
      beforeDesignatedTypeDispatch: ({ root }) => {
        append(
          root,
          fiber('RCTSinglelineTextInputView', {
            testID: 'email',
            editable: true,
            value: '',
            onChangeText() {},
          }),
        );
      },
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 1);
    assert.equal(result.failureCode, 'AMBIGUOUS_TESTID');
    assert.deepEqual(fixture.calls.typed, []);
    assert.equal(fixture.input.memoizedProps.value, '');
  });

  await t.test('modal covers the input', async () => {
    const fixture = replayFixture({
      beforeDesignatedTypeDispatch: ({ root }) => {
        append(root, fiber('RCTModalHostView', { accessibilityViewIsModal: true }));
      },
    });
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'email' } }, { inputText: 'blocked' }],
      {},
      fixture.deps,
    );

    assert.equal(result.passed, false);
    assert.equal(result.failedStepIndex, 1);
    assert.match(result.reason ?? '', /hidden subtree|behind the active modal/);
    assert.deepEqual(fixture.calls.typed, []);
    assert.equal(fixture.input.memoizedProps.value, '');
  });
});

test('maestro_run exposes designation in its public step trace', async () => {
  const calls: string[][] = [];
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async (id) => {
        calls.push(['press', id]);
        return { kind: 'designation', focusOnly: true, token: `designation-${id}` };
      },
      typeByTestId: async (id, text) => {
        calls.push(['type', id, text]);
      },
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      releaseInputDesignation: async () => {},
      async launchApp() {},
      async settle() {},
    }),
  });
  const result = await handler({
    platform: 'ios',
    inlineYaml: 'appId: com.example.app\n---\n- tapOn:\n    id: email\n- inputText: value\n',
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {},
    completeRunnerPark: async () => {},
  });
  const envelope = JSON.parse(result.content[0]?.text ?? '{}') as {
    ok?: boolean;
    data?: { steps?: Array<{ verb?: string; focusOnly?: boolean }> };
  };

  assert.equal(envelope.ok, true);
  assert.deepEqual(calls, [
    ['press', 'email'],
    ['type', 'email', 'value'],
  ]);
  assert.deepEqual(
    envelope.data?.steps?.map(({ verb, focusOnly }) => ({ verb, focusOnly })),
    [
      { verb: 'tap', focusOnly: true },
      { verb: 'type', focusOnly: undefined },
    ],
  );
});
