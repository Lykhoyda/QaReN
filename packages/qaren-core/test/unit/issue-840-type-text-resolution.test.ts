import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { performReactTreeInput } from '../../dist/handlers/device-interact.js';
import { createInteractHandler } from '../../dist/handlers/interact.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk, parseEnvelope } from '../helpers/result-helpers.js';

type Fiber = {
  tag: number;
  type: string | { displayName?: string; name?: string };
  memoizedProps: Record<string, unknown>;
  memoizedState?: unknown;
  stateNode?: {
    isFocused?: () => boolean;
    canonical?: { publicInstance?: { isFocused?: () => boolean } };
  };
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate?: Fiber | null;
};

function makeFiber(
  type: Fiber['type'],
  memoizedProps: Record<string, unknown> = {},
  memoizedState?: unknown,
): Fiber {
  return {
    tag: typeof type === 'string' ? 5 : 0,
    type,
    memoizedProps,
    memoizedState,
    child: null,
    sibling: null,
    return: null,
  };
}

function appendChild(parent: Fiber, child: Fiber): Fiber {
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

function wrap(parent: Fiber, count: number): Fiber {
  let current = parent;
  for (let index = 0; index < count; index += 1) {
    current = appendChild(current, makeFiber({ displayName: `CssInterop.View${index}` }));
  }
  return current;
}

function createAgent(
  rootOrRoots: Fiber | Fiber[],
  options: { onGetFiberRoots?: (rendererId: number) => void } = {},
) {
  const roots = Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots];
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
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(roots.map((_, index) => [index + 1, {}])),
    getFiberRoots: (rendererId: number) => {
      options.onGetFiberRoots?.(rendererId);
      const root = roots[rendererId - 1];
      return root ? new Set([{ current: root }]) : new Set();
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return {
    evaluate: async (expression: string): Promise<{ value?: unknown; error?: unknown }> => {
      try {
        return { value: vm.runInContext(expression, sandbox) };
      } catch (error) {
        return { error };
      }
    },
    interact(opts: Record<string, unknown>): Record<string, unknown> {
      return JSON.parse(
        vm.runInContext(`__QAREN.interact(${JSON.stringify(opts)})`, sandbox) as string,
      ) as Record<string, unknown>;
    },
    readInputValue(testID: string): Record<string, unknown> {
      return JSON.parse(
        vm.runInContext(`__QAREN.readInputValue(${JSON.stringify(testID)})`, sandbox) as string,
      ) as Record<string, unknown>;
    },
  };
}

function runInteract(
  rootOrRoots: Fiber | Fiber[],
  opts: Record<string, unknown>,
): Record<string, unknown> {
  return createAgent(rootOrRoots).interact(opts);
}

test('typeText keeps the proven shallow wrapped-field path typeable', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber({ displayName: 'TextField' }, { testID: 'email' }));
  const leaf = appendChild(
    wrap(wrapper, 6),
    makeFiber('AndroidTextInput', {
      testID: 'email',
      value: '',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'email', text: 'hello' });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['hello']);
  assert.equal(result.handlerCalled, 'onChangeText');
  assert.equal(result.controlled, true);
  assert.equal(result.valueBefore, '');
  assert.equal(leaf.memoizedProps.value, '');
});

test('typeText collapses a stock TextInput composite and host that share one onChangeText', () => {
  const calls: string[] = [];
  const onChangeText = (value: string) => {
    calls.push(value);
  };
  const root = makeFiber('Root');
  const userProps = { testID: 'login_email', value: 'a', editable: true, onChangeText };
  const composite = appendChild(root, makeFiber({ displayName: 'TextInput' }, { ...userProps }));
  composite.tag = 11;
  const host = appendChild(
    composite,
    makeFiber('RCTSinglelineTextInputView', { ...userProps, onChange() {}, text: 'a' }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'login_email', text: 'b' });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.handlerCalled, 'onChangeText');
  assert.equal(result.controlled, true);
  assert.equal(result.valueBefore, 'a');
  assert.match(String(result.resolvedFrom), /^RCTSinglelineTextInputView/);
  assert.deepEqual(calls, ['b']);
  assert.equal(host.memoizedProps.value, 'a');
});

test('typeText keeps a stock-shaped composite and host ambiguous when they own distinct onChangeText functions', () => {
  const calls: string[] = [];
  const outer = (value: string) => {
    calls.push(`outer:${value}`);
  };
  const inner = (value: string) => {
    calls.push(`inner:${value}`);
  };
  const root = makeFiber('Root');
  const composite = appendChild(
    root,
    makeFiber({ displayName: 'TextInput' }, { testID: 'login_email', onChangeText: outer }),
  );
  composite.tag = 11;
  appendChild(
    composite,
    makeFiber('RCTSinglelineTextInputView', { testID: 'login_email', onChangeText: inner }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'login_email', text: 'unsafe' });

  assert.equal(result.error, 'Ambiguous typeText resolution');
  assert.equal(result.count, 2);
  assert.deepEqual(calls, []);
});

test('typeText searches every same-testID match and selects the sole typeable target', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(root, makeFiber({ displayName: 'View' }, { testID: 'shared' }));
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'shared',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'shared', text: 'chosen' });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['chosen']);
});

test('typeText readback resolves the same deep controlled target as mutation', () => {
  const root = makeFiber('Root');
  appendChild(root, makeFiber('View', { testID: 'shared-readback' }));
  const wrapper = appendChild(root, makeFiber('View', { testID: 'shared-readback' }));
  const input = appendChild(
    wrap(wrapper, 28),
    makeFiber('AndroidTextInput', {
      testID: 'shared-readback',
      value: '',
      onChangeText(value: string) {
        input.memoizedProps.value = value;
      },
    }),
  );
  const agent = createAgent(root);

  const mutation = agent.interact({
    action: 'typeText',
    testID: 'shared-readback',
    text: 'verified',
    verify: true,
  });
  const readback = agent.readInputValue('shared-readback');

  assert.equal(mutation.success, true, JSON.stringify(mutation));
  assert.equal(mutation.handlerCalled, 'onChangeText');
  assert.equal(mutation.controlled, true);
  assert.equal(mutation.valueBefore, '');
  assert.deepEqual(readback, { value: 'verified', controlled: true, focused: false });
});

test('typeText and readInputValue share one budget on a screen-sized tree', () => {
  const root = makeFiber('Root');
  for (let index = 0; index < 600; index += 1) {
    appendChild(root, makeFiber('View', { testID: `row-${index}` }));
  }
  const calls: string[] = [];
  appendChild(
    wrap(appendChild(root, makeFiber('View', { testID: 'screen-email-pressable' })), 3),
    makeFiber('AndroidTextInput', {
      testID: 'screen-email',
      value: 'qa.user@example.com',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  const agent = createAgent(root);

  const readback = agent.readInputValue('screen-email');
  const mutation = agent.interact({ action: 'typeText', testID: 'screen-email', text: 'unsafe' });

  assert.deepEqual(readback, { value: 'qa.user@example.com', controlled: true, focused: false });
  assert.equal(mutation.success, true, JSON.stringify(mutation));
  assert.equal(mutation.handlerCalled, 'onChangeText');
  assert.equal(mutation.truncated, undefined);
  assert.deepEqual(calls, ['unsafe']);
});

test('typeText mutates and reads back a controlled field beyond the former 100000 work limit', () => {
  const root = makeFiber('Root');
  let tail = appendChild(root, makeFiber('View'));
  for (let index = 1; index < 40000; index += 1) {
    const next = makeFiber('View');
    next.return = root;
    tail.sibling = next;
    tail = next;
  }
  const calls: string[] = [];
  const input = makeFiber('AndroidTextInput', {
    testID: 'large-screen-field',
    value: '',
    onChangeText(value: string) {
      calls.push(value);
      input.memoizedProps.value = value;
    },
  });
  input.return = root;
  tail.sibling = input;
  const agent = createAgent(root);

  const result = agent.interact({
    action: 'typeText',
    testID: 'large-screen-field',
    text: 'Example street',
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls, ['Example street']);
  assert.deepEqual(agent.readInputValue('large-screen-field'), {
    value: 'Example street',
    controlled: true,
    focused: false,
  });
});

test('readInputValue reports focused from the host isFocused oracle', () => {
  const root = makeFiber('Root');
  const focused = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'focused-email',
      value: 'a',
      onChangeText() {},
    }),
  );
  focused.stateNode = { isFocused: () => true };
  const fabric = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'fabric-email',
      value: 'b',
      onChangeText() {},
    }),
  );
  fabric.stateNode = { canonical: { publicInstance: { isFocused: () => true } } };
  const agent = createAgent(root);

  assert.deepEqual(agent.readInputValue('focused-email'), {
    value: 'a',
    controlled: true,
    focused: true,
  });
  assert.deepEqual(agent.readInputValue('fabric-email'), {
    value: 'b',
    controlled: true,
    focused: true,
  });
});

test('readInputValue still refuses when its own read budget is exhausted', () => {
  const root = makeFiber('Root');
  let tail = appendChild(root, makeFiber('View', { testID: 'row-0' }));
  for (let index = 1; index < 150000; index += 1) {
    const next = makeFiber('View', { testID: `row-${index}` });
    next.return = root;
    tail.sibling = next;
    tail = next;
  }
  const agent = createAgent(root);

  assert.deepEqual(agent.readInputValue('row-0'), {
    __agent_error: 'typeText resolution truncated',
  });
  const mutation = agent.interact({ action: 'typeText', testID: 'row-0', text: 'unsafe' });
  assert.equal(mutation.truncated, true);
  assert.equal(mutation.reason, 'work-limit');
  assert.equal(mutation.workLimit, 500000);
});

test('React replay types through a wrapper and verifies the same controlled input', async () => {
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'replay-wrapper' }));
  const input = appendChild(
    wrap(wrapper, 28),
    makeFiber('AndroidTextInput', {
      value: '04',
      onChangeText(value: string) {
        input.memoizedProps.value = value;
      },
    }),
  );
  const agent = createAgent(root);

  const result = await performReactTreeInput('replay-wrapper', '5', agent as never);

  assert.deepEqual(expectOk(result), { filled: true, method: 'js-onChangeText', length: 1 });
  assert.equal(input.memoizedProps.value, '045');
});

test('typeText types through a box-none wrapper testID onto the inner input', async () => {
  const root = makeFiber('Root');
  const wrapper = appendChild(
    root,
    makeFiber('View', { testID: 'box_none_field', pointerEvents: 'box-none' }),
  );
  const input = appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      value: '',
      onChangeText(value: string) {
        input.memoizedProps.value = value;
      },
    }),
  );
  const agent = createAgent(root);

  const result = await performReactTreeInput('box_none_field', 'abc', agent as never);

  assert.deepEqual(expectOk(result), { filled: true, method: 'js-onChangeText', length: 3 });
  assert.equal(input.memoizedProps.value, 'abc');
});

test('typeText refuses when a host ancestor of the input is box-only', async () => {
  const root = makeFiber('Root');
  const blocker = appendChild(root, makeFiber('View', { pointerEvents: 'box-only' }));
  const wrapper = appendChild(blocker, makeFiber('View', { testID: 'blocked_field' }));
  const input = appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      value: '',
      onChangeText(value: string) {
        input.memoizedProps.value = value;
      },
    }),
  );
  const agent = createAgent(root);

  const result = await performReactTreeInput('blocked_field', 'abc', agent as never);
  const envelope = parseEnvelope(result);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'INTERACTION_NOT_ACTUATED');
  assert.match(envelope.error ?? '', /pointerEvents/);
  assert.equal(input.memoizedProps.value, '');
});

test('typeText refuses when the selected input itself is box-none', async () => {
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'box_none_input' }));
  const input = appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      value: '',
      pointerEvents: 'box-none',
      onChangeText(value: string) {
        input.memoizedProps.value = value;
      },
    }),
  );
  const agent = createAgent(root);

  const result = await performReactTreeInput('box_none_input', 'abc', agent as never);
  const envelope = parseEnvelope(result);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'INTERACTION_NOT_ACTUATED');
  assert.match(envelope.error ?? '', /pointerEvents/);
  assert.equal(input.memoizedProps.value, '');
});

test('typeText searches matching fibers across every registered renderer', () => {
  const calls: string[] = [];
  const inertRoot = makeFiber('Root');
  appendChild(inertRoot, makeFiber('View', { testID: 'cross-renderer' }));
  const typeableRoot = makeFiber('Root');
  appendChild(
    typeableRoot,
    makeFiber('AndroidTextInput', {
      testID: 'cross-renderer',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract([inertRoot, typeableRoot], {
    action: 'typeText',
    testID: 'cross-renderer',
    text: 'second-renderer',
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['second-renderer']);
});

test('typeText reaches a NativeWind-style input beyond sixteen wrapper layers', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber({ displayName: 'TextField' }, { testID: 'deep' }));
  appendChild(
    wrap(wrapper, 28),
    makeFiber(
      { displayName: 'CssInterop.TextInput' },
      {
        testID: 'deep',
        onChangeText(value: string) {
          calls.push(value);
        },
      },
    ),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'deep', text: 'landed' });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['landed']);
  assert.ok((result.visitedFibers as number) > 16);
});

test('typeText reaches the number input inside a phone-style compound field', () => {
  const typed: string[] = [];
  const root = makeFiber('Root');
  const phone = appendChild(root, makeFiber({ displayName: 'PhoneField' }, { testID: 'phone' }));
  appendChild(phone, makeFiber({ displayName: 'CountrySelect' }, { onPress() {} }));
  appendChild(
    wrap(phone, 20),
    makeFiber('AndroidTextInput', {
      testID: 'phone',
      onChangeText(value: string) {
        typed.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'phone', text: '15112345678' });

  assert.equal(result.success, true);
  assert.deepEqual(typed, ['15112345678']);
});

test('typeText supports placeholder and role+name selectors', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      placeholder: 'Search policies',
      onChangeText(value: string) {
        calls.push(`placeholder:${value}`);
      },
    }),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      accessibilityRole: 'textbox',
      accessibilityLabel: 'Phone number',
      onChangeText(value: string) {
        calls.push(`role:${value}`);
      },
    }),
  );

  const byPlaceholder = runInteract(root, {
    action: 'typeText',
    placeholder: 'Search policies',
    text: 'home',
    exact: true,
  });
  const byRole = runInteract(root, {
    action: 'typeText',
    role: 'textbox',
    name: 'Phone number',
    text: '1234',
    exact: true,
  });

  assert.equal(byPlaceholder.success, true, JSON.stringify(byPlaceholder));
  assert.equal(byRole.success, true, JSON.stringify(byRole));
  assert.deepEqual(calls, ['placeholder:home', 'role:1234']);
});

test('typeText binds selector evidence to the source that owns the selected handler', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'inert-search',
      placeholder: 'Search policies',
    }),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'active-search',
      placeholder: 'Search policies',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Search policies',
    text: 'home',
    exact: true,
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls, ['home']);
  assert.deepEqual(result.selectorBundle, {
    testID: 'active-search',
    role: 'none',
    placeholder: 'Search policies',
  });
});

test('typeText refuses mixed onChangeText and onChange logical targets', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'mixed-handlers',
      onChangeText(value: string) {
        calls.push(`text:${value}`);
      },
    }),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'mixed-handlers',
      onChange(event: { nativeEvent: { text: string } }) {
        calls.push(`event:${event.nativeEvent.text}`);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'mixed-handlers',
    text: 'unsafe',
  });

  assert.match(String(result.error), /Ambiguous typeText resolution/);
  assert.deepEqual(calls, []);
});

test('typeText refuses generic onChange on a non-text host', () => {
  const calls: unknown[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'switch-field' }));
  appendChild(
    wrapper,
    makeFiber('Switch', {
      onChange(event: unknown) {
        calls.push(event);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'switch-field',
    text: 'unsafe',
  });

  assert.match(String(result.error), /no onChangeText or onChange handler/);
  assert.deepEqual(calls, []);
});

test('typeText admits generic onChange on a native text-input host', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'event-input',
      onChange(event: { nativeEvent: { text: string } }) {
        calls.push(event.nativeEvent.text);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'event-input',
    text: 'safe',
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls, ['safe']);
});

test('typeText refuses mixed component-name candidates without preferring a host input', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber(
      { displayName: 'FormControl' },
      {
        testID: 'mixed-components',
        onChangeText(value: string) {
          calls.push(`custom:${value}`);
        },
      },
    ),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'mixed-components',
      onChangeText(value: string) {
        calls.push(`native:${value}`);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'mixed-components',
    text: 'unsafe',
  });

  assert.equal(result.error, 'Ambiguous typeText resolution');
  assert.equal(result.count, 2);
  assert.deepEqual(calls, []);
});

test('typeText keeps shared functions with different handler contracts ambiguous', () => {
  const calls: unknown[] = [];
  const shared = (value: unknown) => calls.push(value);
  const root = makeFiber('Root');
  const wrapper = appendChild(
    root,
    makeFiber(
      { displayName: 'TextField' },
      {
        testID: 'cross-contract',
        onChangeText: shared,
      },
    ),
  );
  appendChild(wrapper, makeFiber('AndroidTextInput', { onChange: shared }));

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'cross-contract',
    text: 'unsafe',
  });

  assert.equal(result.error, 'Ambiguous typeText resolution');
  assert.equal(result.handler, 'mixed');
  assert.deepEqual(
    (result.candidates as Array<{ contract: string }>).map((candidate) => candidate.contract),
    ['onChangeText:string', 'onChange:event'],
  );
  assert.deepEqual(calls, []);
});

test('typeText binds nested selector evidence to the nearest matching source', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const outer = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      testID: 'outer-evidence',
      placeholder: 'Shared placeholder',
    }),
  );
  appendChild(
    outer,
    makeFiber('AndroidTextInput', {
      testID: 'inner-exact',
      placeholder: 'Shared placeholder',
      value: '',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Shared placeholder',
    text: 'bound',
    exact: true,
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(result.selectorBundle, {
    testID: 'inner-exact',
    role: 'none',
    placeholder: 'Shared placeholder',
  });
  assert.deepEqual(calls, ['bound']);
});

test('typeText refuses nested matching sources when both exact fibers own handlers', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const outer = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      placeholder: 'Shared placeholder',
      onChangeText(value: string) {
        calls.push(`outer:${value}`);
      },
    }),
  );
  appendChild(
    outer,
    makeFiber('AndroidTextInput', {
      placeholder: 'Shared placeholder',
      onChangeText(value: string) {
        calls.push(`inner:${value}`);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Shared placeholder',
    text: 'unsafe',
    exact: true,
  });

  assert.equal(result.error, 'Ambiguous typeText resolution');
  assert.equal(result.count, 2);
  assert.deepEqual(calls, []);
});

test('typeText refuses cyclic hidden-state sibling traversal', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const input = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      placeholder: 'Cyclic search',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  const sibling = appendChild(root, makeFiber('View'));
  sibling.sibling = sibling;

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Cyclic search',
    text: 'unsafe',
    exact: true,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
  assert.equal(input.memoizedProps.placeholder, 'Cyclic search');
});

test('typeText charges hidden-state ancestor traversal to the shared work limit', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const branch = appendChild(root, makeFiber('View'));
  appendChild(
    branch,
    makeFiber('AndroidTextInput', {
      placeholder: 'Bounded search',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  let tail = branch;
  for (let index = 0; index < 200000; index += 1) {
    const next = makeFiber('View');
    next.return = root;
    tail.sibling = next;
    tail = next;
  }

  const result = runInteract(root, {
    action: 'typeText',
    placeholder: 'Bounded search',
    text: 'unsafe',
    exact: true,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 500000);
  assert.deepEqual(calls, []);
});

test('typeText refuses a cyclic accessible-name subtree within the shared budget', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const input = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      accessibilityRole: 'textbox',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  const cyclicName = appendChild(input, makeFiber('View'));
  cyclicName.child = cyclicName;

  const result = runInteract(root, {
    action: 'typeText',
    role: 'textbox',
    name: 'Never resolved',
    text: 'unsafe',
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
});

test('typeText charges labelled-by accessible-name scans to the shared work limit', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  let tail = appendChild(
    root,
    makeFiber('AndroidTextInput', {
      accessibilityRole: 'textbox',
      'aria-labelledby': 'bounded-label',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  for (let index = 0; index < 200000; index += 1) {
    const next = makeFiber('View');
    next.return = root;
    tail.sibling = next;
    tail = next;
  }
  const label = appendChild(root, makeFiber('View', { nativeID: 'bounded-label' }));
  const labelText = appendChild(label, makeFiber('Text'));
  labelText.memoizedProps = 'Bounded field' as unknown as Record<string, unknown>;

  const result = runInteract(root, {
    action: 'typeText',
    role: 'textbox',
    name: 'Bounded field',
    text: 'unsafe',
    exact: true,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 500000);
  assert.deepEqual(calls, []);
});

test('typeText preserves sibling text in labelled-by accessible names', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const label = appendChild(root, makeFiber('View', { nativeID: 'full-label' }));
  const first = appendChild(label, makeFiber('RawText'));
  first.tag = 6;
  first.memoizedProps = 'First' as unknown as Record<string, unknown>;
  const last = appendChild(label, makeFiber('RawText'));
  last.tag = 6;
  last.memoizedProps = 'Last' as unknown as Record<string, unknown>;
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      accessibilityRole: 'textbox',
      accessibilityLabelledBy: 'full-label',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    role: 'textbox',
    name: 'First Last',
    text: 'resolved',
    exact: true,
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(calls, ['resolved']);
});

test('typeText refuses a role selector without an accessible name', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', {
      accessibilityRole: 'textbox',
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', role: 'textbox', text: 'unsafe' });

  assert.match(String(result.error), /role\+name/);
  assert.deepEqual(calls, []);
});

test('the public interact handler forwards placeholder and role+name typing selectors', async () => {
  const expressions: string[] = [];
  const client = createMockClient({
    evaluate: async (expression: string) => {
      expressions.push(expression);
      return { value: JSON.stringify({ success: true, action: 'typeText' }) };
    },
  });
  const handler = createInteractHandler(() => client);

  expectOk(
    await handler({
      action: 'typeText',
      placeholder: 'Search policies',
      text: 'home',
      animated: false,
    }),
  );
  expectOk(
    await handler({
      action: 'typeText',
      role: 'textbox',
      name: 'Phone number',
      text: '1234',
      animated: false,
    }),
  );

  const interactExpressions = expressions.filter((expression) =>
    expression.startsWith('__QAREN.interact('),
  );
  assert.equal(interactExpressions.length, 2);
  assert.match(interactExpressions[0], /"placeholder":"Search policies"/);
  assert.match(interactExpressions[1], /"role":"textbox"/);
  assert.match(interactExpressions[1], /"name":"Phone number"/);
});

test('typeText refuses when distinct typeable same-testID fields remain ambiguous', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  for (const suffix of ['first', 'second']) {
    appendChild(
      root,
      makeFiber('AndroidTextInput', {
        testID: 'duplicate',
        onChangeText(value: string) {
          calls.push(`${suffix}:${value}`);
        },
      }),
    );
  }

  const result = runInteract(root, { action: 'typeText', testID: 'duplicate', text: 'unsafe' });

  assert.match(String(result.error), /Ambiguous typeText resolution/);
  assert.deepEqual(calls, []);
});

test('typeText does not collapse distinct sibling fields that share one handler', () => {
  const calls: string[] = [];
  const sharedHandler = (value: string) => calls.push(value);
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber('AndroidTextInput', { testID: 'duplicate', onChangeText: sharedHandler }),
  );
  appendChild(
    root,
    makeFiber('AndroidTextInput', { testID: 'duplicate', onChangeText: sharedHandler }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'duplicate', text: 'unsafe' });

  assert.match(String(result.error), /Ambiguous typeText resolution/);
  assert.deepEqual(calls, []);
});

test('typeText preserves distinct wrapper and host handlers as ambiguous', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(
    root,
    makeFiber(
      { displayName: 'TextField' },
      { testID: 'compound', onChangeText: (value: string) => calls.push(`outer:${value}`) },
    ),
  );
  appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      onChangeText: (value: string) => calls.push(`inner:${value}`),
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'compound', text: 'unsafe' });

  assert.match(String(result.error), /Ambiguous typeText resolution/);
  assert.deepEqual(calls, []);
});

test('typeText refuses on a cyclic subtree without firing a partial candidate', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'cyclic' }));
  const first = appendChild(wrapper, makeFiber('View'));
  const input = appendChild(
    first,
    makeFiber('AndroidTextInput', {
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  input.sibling = first;

  const result = runInteract(root, { action: 'typeText', testID: 'cyclic', text: 'unsafe' });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
});

test('typeText charges ownership return cycles to the shared resolution context', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'return-cycle' }));
  const input = appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  input.return = input;

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'return-cycle',
    text: 'unsafe',
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
});

test('typeText reports cycle truncation before accessibility-label ambiguity', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { accessibilityLabel: 'Cyclic field' }));
  const first = appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      onChangeText: (value: string) => calls.push(`first:${value}`),
    }),
  );
  const second = appendChild(
    wrapper,
    makeFiber('AndroidTextInput', {
      onChangeText: (value: string) => calls.push(`second:${value}`),
    }),
  );
  second.sibling = first;

  const result = runInteract(root, {
    action: 'typeText',
    accessibilityLabel: 'Cyclic field',
    text: 'unsafe',
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'cycle');
  assert.deepEqual(calls, []);
});

test('typeText refuses when its documented total-work limit is exhausted', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'huge' }));
  appendChild(
    wrap(wrapper, 100000),
    makeFiber('AndroidTextInput', {
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, { action: 'typeText', testID: 'huge', text: 'unsafe' });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit', JSON.stringify(result));
  assert.equal(result.workLimit, 500000);
  assert.deepEqual(calls, []);
});

test('typeText stops root enumeration when style fan-out exhausts the shared limit', () => {
  const calls: string[] = [];
  const roots: Fiber[] = [];
  const firstRoot = makeFiber('Root');
  appendChild(
    firstRoot,
    makeFiber('AndroidTextInput', {
      placeholder: 'Huge style field',
      style: Array.from({ length: 500_000 }, () => null),
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );
  roots.push(firstRoot);
  for (let index = 1; index < 25; index += 1) roots.push(makeFiber('Root'));
  const rootCalls: number[] = [];
  const agent = createAgent(roots, { onGetFiberRoots: (rendererId) => rootCalls.push(rendererId) });

  const result = agent.interact({
    action: 'typeText',
    placeholder: 'Huge style field',
    text: 'unsafe',
    exact: true,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.work, 500000);
  assert.deepEqual(rootCalls, [1]);
  assert.deepEqual(calls, []);
});

test('typeText shares one work limit across selector and candidate discovery', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  let current = root;
  for (let index = 0; index < 90000; index += 1) {
    current = appendChild(current, makeFiber('View'));
  }
  const wrapper = appendChild(current, makeFiber('View', { testID: 'combined-budget' }));
  appendChild(
    wrap(wrapper, 42000),
    makeFiber('AndroidTextInput', {
      onChangeText(value: string) {
        calls.push(value);
      },
    }),
  );

  const result = runInteract(root, {
    action: 'typeText',
    testID: 'combined-budget',
    text: 'unsafe',
  });

  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'work-limit');
  assert.equal(result.workLimit, 500000);
  assert.deepEqual(calls, []);
});

test('typeText refuses truthfully with or without verify when no handler exists', () => {
  const root = makeFiber('Root');
  const wrapper = appendChild(root, makeFiber('View', { testID: 'inert' }));
  wrap(wrapper, 25);

  for (const verify of [undefined, true]) {
    const result = runInteract(root, {
      action: 'typeText',
      testID: 'inert',
      text: 'unused',
      verify,
    });

    assert.match(String(result.error), /no onChangeText or onChange handler/);
    assert.equal(result.handlerCalled, false);
  }
});

test('setFieldValue uses the useForm return whose control matches an explicit control prop', () => {
  const calls: Array<{ name: string; value: unknown; options: unknown }> = [];
  const control = {};
  const formReturn = {
    control,
    getValues(name: string) {
      return name === 'phone' ? '' : undefined;
    },
    setValue(name: string, value: unknown, options: unknown) {
      calls.push({ name, value, options });
    },
  };
  const root = makeFiber('Root');
  const formOwner = appendChild(
    root,
    makeFiber(
      { displayName: 'RegistrationForm' },
      {},
      { memoizedState: { current: formReturn }, next: null },
    ),
  );
  const controller = appendChild(
    formOwner,
    makeFiber({ displayName: 'Controller' }, { control, name: 'phone' }),
  );
  appendChild(controller, makeFiber('View', { testID: 'phone-field' }));

  const result = runInteract(root, {
    action: 'setFieldValue',
    testID: 'phone-field',
    name: 'phone',
    value: 15112345678,
  });

  assert.equal(result.success, true);
  assert.equal(result.resolvedFrom, 'control-prop-hook');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      name: 'phone',
      value: '15112345678',
      options: { shouldValidate: true, shouldDirty: true },
    },
  ]);
});

test('setFieldValue refuses an unrelated useForm hook without calling setValue', () => {
  const calls: string[] = [];
  const explicitControl = {};
  const unrelatedFormReturn = {
    control: {},
    getValues() {
      return '';
    },
    setValue() {
      calls.push('called');
    },
  };
  const root = makeFiber('Root');
  const formOwner = appendChild(
    root,
    makeFiber(
      { displayName: 'RegistrationForm' },
      {},
      { memoizedState: { current: unrelatedFormReturn }, next: null },
    ),
  );
  const controller = appendChild(
    formOwner,
    makeFiber({ displayName: 'Controller' }, { control: explicitControl, name: 'phone' }),
  );
  appendChild(controller, makeFiber('View', { testID: 'phone-field' }));

  const result = runInteract(root, {
    action: 'setFieldValue',
    testID: 'phone-field',
    name: 'phone',
    value: '1234',
  });

  assert.match(String(result.error), /no FormProvider ancestor or matching useForm control/);
  assert.deepEqual(calls, []);
});

test('setFieldValue does not skip the nearest explicit control for an outer form', () => {
  const calls: string[] = [];
  const outerControl = {};
  const nearestControl = {};
  const outerFormReturn = {
    control: outerControl,
    getValues() {
      return '';
    },
    setValue() {
      calls.push('outer');
    },
  };
  const root = makeFiber('Root');
  const owner = appendChild(
    root,
    makeFiber(
      { displayName: 'OuterForm' },
      {},
      { memoizedState: { current: outerFormReturn }, next: null },
    ),
  );
  const outerController = appendChild(
    owner,
    makeFiber({ displayName: 'Controller' }, { control: outerControl, name: 'outer' }),
  );
  const nearestController = appendChild(
    outerController,
    makeFiber({ displayName: 'Controller' }, { control: nearestControl, name: 'phone' }),
  );
  appendChild(nearestController, makeFiber('View', { testID: 'nested-phone' }));

  const result = runInteract(root, {
    action: 'setFieldValue',
    testID: 'nested-phone',
    name: 'phone',
    value: '1234',
  });

  assert.match(String(result.error), /no FormProvider ancestor or matching useForm control/);
  assert.deepEqual(calls, []);
});

test('setFieldValue ignores a mismatched outer provider for the nearest controlled form', () => {
  const calls: string[] = [];
  const outerControl = {};
  const nearestControl = {};
  const outerFormReturn = {
    control: outerControl,
    getValues() {
      return '';
    },
    setValue() {
      calls.push('outer');
    },
  };
  const nearestFormReturn = {
    control: nearestControl,
    getValues() {
      return '';
    },
    setValue() {
      calls.push('nearest');
    },
  };
  const root = makeFiber('Root');
  const provider = appendChild(
    root,
    makeFiber({ displayName: 'FormProvider' }, { value: outerFormReturn }),
  );
  const owner = appendChild(
    provider,
    makeFiber(
      { displayName: 'InnerForm' },
      {},
      { memoizedState: { current: nearestFormReturn }, next: null },
    ),
  );
  const controller = appendChild(
    owner,
    makeFiber({ displayName: 'Controller' }, { control: nearestControl, name: 'phone' }),
  );
  appendChild(controller, makeFiber('View', { testID: 'provider-nested-phone' }));

  const result = runInteract(root, {
    action: 'setFieldValue',
    testID: 'provider-nested-phone',
    name: 'phone',
    value: '1234',
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.resolvedFrom, 'control-prop-hook');
  assert.deepEqual(calls, ['nearest']);
});

test('setFieldValue observes same-node control before provider value', () => {
  const calls: string[] = [];
  const controlA = {};
  const controlB = {};
  const methodsA = {
    control: controlA,
    getValues() {
      return '';
    },
    setValue() {
      calls.push('A');
    },
  };
  const methodsB = {
    control: controlB,
    getValues() {
      return '';
    },
    setValue() {
      calls.push('B');
    },
  };
  const root = makeFiber('Root');
  const owner = appendChild(
    root,
    makeFiber(
      { displayName: 'ControlledProvider' },
      { control: controlB, value: methodsA },
      { memoizedState: { current: methodsB }, next: null },
    ),
  );
  appendChild(owner, makeFiber('View', { testID: 'same-node-control' }));

  const result = runInteract(root, {
    action: 'setFieldValue',
    testID: 'same-node-control',
    name: 'phone',
    value: '1234',
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.resolvedFrom, 'control-prop-hook');
  assert.deepEqual(calls, ['B']);
});

test('press keeps its existing first strict-testID match semantics', () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  appendChild(root, makeFiber('Button', { testID: 'same', onPress: () => calls.push('first') }));
  appendChild(root, makeFiber('Button', { testID: 'same', onPress: () => calls.push('second') }));

  const result = runInteract(root, { action: 'press', testID: 'same' });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['first']);
});

test('clearInputValue empties only a focused controlled input and returns no value', async () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const field = (testID: string, props: Record<string, unknown>, focused: boolean) => {
    const fiber = appendChild(
      root,
      makeFiber('RCTSinglelineTextInputView', {
        testID,
        onChangeText: (text: string) => calls.push(`${testID}:${text}`),
        ...props,
      }),
    );
    fiber.stateNode = { isFocused: () => focused };
  };
  field('kept-email', { value: 'kept.private@example.test' }, true);
  field('idle-email', { value: 'idle@example.test' }, false);
  field('free-email', { defaultValue: 'free@example.test' }, true);
  field('secret', { value: 'hunter2', secureTextEntry: true }, true);
  const agent = createAgent(root);
  const clear = async (testID: string) => {
    const result = await agent.evaluate(`__QAREN.clearInputValue(${JSON.stringify(testID)})`);
    assert.doesNotMatch(String(result.value), /example\.test|hunter2/);
    return JSON.parse(String(result.value));
  };

  assert.deepEqual(await clear('kept-email'), { cleared: true });
  assert.deepEqual(await clear('idle-email'), { cleared: false, reason: 'unfocused' });
  assert.deepEqual(await clear('free-email'), { cleared: false, reason: 'uncontrolled' });
  assert.deepEqual(await clear('secret'), { cleared: false, reason: 'secure' });
  assert.deepEqual(await clear('missing'), { cleared: false, reason: 'unbound' });
  assert.deepEqual(calls, ['kept-email:']);
});

test('setInputValue sends the whole value through the handler, needs no focus and returns no value', async () => {
  const calls: string[] = [];
  const root = makeFiber('Root');
  const field = (testID: string, props: Record<string, unknown>) => {
    const fiber = appendChild(
      root,
      makeFiber('RCTSinglelineTextInputView', {
        testID,
        onChangeText: (text: string) => calls.push(`${testID}:${text}`),
        ...props,
      }),
    );
    fiber.stateNode = { isFocused: () => false };
  };
  field('idle-email', { value: 'kept@example.test' });
  field('free-email', { defaultValue: 'free@example.test' });
  field('secret', { value: 'hunter2', secureTextEntry: true });
  const agent = createAgent(root);
  const set = async (testID: string) => {
    const result = await agent.evaluate(
      `__QAREN.setInputValue(${JSON.stringify(testID)}, "new.value@example.test")`,
    );
    assert.doesNotMatch(String(result.value), /example\.test|hunter2/);
    return JSON.parse(String(result.value));
  };

  assert.deepEqual(await set('idle-email'), { set: true });
  assert.deepEqual(await set('free-email'), { set: false, reason: 'uncontrolled' });
  assert.deepEqual(await set('secret'), { set: false, reason: 'secure' });
  assert.deepEqual(await set('missing'), { set: false, reason: 'unbound' });
  assert.deepEqual(calls, ['idle-email:new.value@example.test']);
});

for (const disabledProps of [
  { disabled: true },
  { editable: false },
  { readOnly: true },
  { accessibilityState: { disabled: true } },
]) {
  for (const handler of ['onChangeText', 'onChange']) {
    test(`handler writes reject ${JSON.stringify(disabledProps)} through ${handler}`, async () => {
      const calls: unknown[] = [];
      const root = makeFiber('Root');
      const props = {
        testID: 'email',
        value: 'prior',
        [handler]: (value: unknown) => calls.push(value),
      };
      const field = appendChild(root, makeFiber('RCTSinglelineTextInputView', props));
      field.stateNode = { isFocused: () => true };
      const agent = createAgent(root);

      for (const [expression, key, value] of [
        ['__QAREN.setInputValue("email", "replacement")', 'set', 'replacement'],
        ['__QAREN.clearInputValue("email")', 'cleared', ''],
      ]) {
        calls.length = 0;
        const write = async () => JSON.parse(String((await agent.evaluate(expression)).value));
        assert.deepEqual(await write(), { [key]: true });
        field.memoizedProps = { ...props, ...disabledProps };
        assert.deepEqual(await write(), { [key]: false, reason: 'disabled' });
        assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
          handler === 'onChangeText' ? value : { nativeEvent: { text: value } },
        ]);
        field.memoizedProps = props;
        assert.deepEqual(await write(), { [key]: true });
        assert.equal(calls.length, 2);
      }
    });
  }
}
