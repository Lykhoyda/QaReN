import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { HELPERS_VERSION } from '../../../dist/injected-helpers.js';
import { buildFiber, createSandbox, INJECTED_HELPERS } from '../helpers/inject-harness.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { inputValues, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';
import { devFreeze } from './rn-dev-freeze.ts';
import { PRIVATE_INPUT_LIMITS } from '../../../dist/qa/private-input-limits.js';

function setup(props: Record<string, unknown> = {}, hostType = 'RCTTextInput') {
  const fiber = buildFiber({ hostType, props });
  fiber.tag = 5;
  const root = { current: fiber };
  const sandbox = createSandbox({ fiberRoot: fiber });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([root]) : new Set();
  const api = sandbox.__QAREN;
  return { fiber, root, sandbox, api };
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function assertNoInputs(reply: Record<string, unknown>, ...secrets: string[]) {
  assert.equal('inputs' in reply, false);
  for (const secret of secrets) assert.equal(JSON.stringify(reply).includes(secret), false, secret);
}

function compositeDigest(props: Record<string, unknown>) {
  const fixture = setup(
    { testID: 'continue', accessibilityRole: 'button', onPress() {} },
    'RCTView',
  );
  const wrapper = buildFiber({ name: 'Card', props: { onPress() {}, ...props } });
  wrapper.tag = 0;
  wrapper.child = fixture.fiber;
  fixture.fiber.return = wrapper;
  fixture.root.current = wrapper;
  return fixture;
}

const digestElement = {
  $$typeof: Symbol.for('react.transitional.element'),
  type: 'Text',
  props: { children: 'element-canary' },
};
for (const key of ['title', 'accessibilityLabel', 'placeholder']) {
  for (const [variant, value] of Object.entries({
    element: digestElement,
    number: 42,
    array: [digestElement],
    boolean: false,
    null: null,
    undefined,
  })) {
    test(`composite non-string ${key} (${variant}) does not refuse ordinary host capture`, async () => {
      for (const typography of [false, true]) {
        const fixture = compositeDigest({ [key]: value });
        const begin = fixture.api.beginQaCapture(typography);
        await tick();
        const result = begin.state === 'pending' ? fixture.api.readQaCapture(begin.id) : begin;
        assert.equal(result.state, 'ready', `${key}: ${typeof value}, typography=${typography}`);
        assertNoInputs(result, 'element-canary');
        const tree = JSON.parse(result.tree);
        assert.equal(tree.verdict.complete, true);
        assert.equal(tree.hostEvidence.complete, true);
        assert.equal(tree.hostEvidence.hosts[0].testID, 'continue');
        const entry = tree.interactive[0];
        assert.equal(entry.text, undefined);
        assert.equal(entry.label, undefined);
        assert.equal(entry.placeholder, undefined);
      }
    });
  }
}

test('opaque host strings and composite identities or roles still refuse', () => {
  const opaque = {
    toString() {
      assert.fail('opaque props must not be coerced');
    },
  };
  for (const key of [
    'role',
    'accessibilityRole',
    'testID',
    'nativeID',
    'title',
    'accessibilityLabel',
    'placeholder',
  ]) {
    const result = setup({ [key]: opaque }, 'RCTView').api.beginQaCapture();
    assert.equal(result.state, 'refused', key);
  }
  for (const key of ['role', 'accessibilityRole', 'testID', 'nativeID']) {
    assert.equal(compositeDigest({ [key]: opaque }).api.beginQaCapture().state, 'refused', key);
  }
});

test('composite display and predicate getters and input value getters refuse unread', () => {
  let reads = 0;
  for (const key of [
    'title',
    'accessibilityLabel',
    'placeholder',
    'editable',
    'readOnly',
    'aria-readonly',
    'value',
  ]) {
    const fixture = compositeDigest({});
    const props =
      key === 'value' ? fixture.fiber.memoizedProps : fixture.root.current.memoizedProps;
    if (key === 'value') fixture.fiber.type = 'RCTTextInput';
    Object.defineProperty(props, key, {
      get() {
        reads++;
        throw new Error('getter-canary');
      },
    });
    const result = fixture.api.beginQaCapture();
    assert.equal(result.state, 'refused', key);
    assertNoInputs(result, 'getter-canary');
  }
  assert.equal(reads, 0);
});

test('ignored composite objects are never coerced and rendered host text reaches the adapter', async () => {
  const opaque = {
    toString() {
      assert.fail('display props must not be coerced');
    },
    toJSON() {
      assert.fail('display props must not be serialized');
    },
  };
  for (const typography of [false, true]) {
    const fixture = compositeDigest({
      title: opaque,
      accessibilityLabel: opaque,
      placeholder: opaque,
    });
    fixture.fiber.child = buildFiber(
      { hostType: 'RCTText', children: [{ text: 'Continue' }] },
      fixture.fiber,
    );
    fixture.fiber.child.tag = 5;
    fixture.fiber.child.child.tag = 6;
    const observation = await captureQaReact(
      {
        isConnected: true,
        async withPrivateHelperWorld(run) {
          return run(async (expression) => vm.runInContext(expression, fixture.sandbox));
        },
      },
      typography,
    );
    assert.equal(observation.hostEvidence?.complete, true);
    assert.ok(
      observation.interactive?.some(
        (entry) => entry.testID === 'continue' && entry.text === 'Continue',
      ),
    );
  }
});

test('composite string display props retain their digest meaning', () => {
  const fixture = compositeDigest({
    title: 'Continue',
    accessibilityLabel: 'Next step',
    placeholder: 'Hint',
  });
  const result = fixture.api.beginQaCapture();
  assert.equal(result.state, 'ready');
  const entry = JSON.parse(result.tree).interactive[0];
  assert.equal(entry.text, 'Continue');
  assert.equal(entry.label, 'Next step');
  assert.equal(entry.placeholder, 'Hint');
});

const inputCanary = 'native-input-echo-canary';

function inputPipeline(props: Record<string, unknown>, typography: boolean, hostType: string) {
  const fixture = setup({}, 'RCTView');
  const input = buildFiber({ hostType, props: { testID: 'field', ...props } }, fixture.fiber);
  input.tag = 5;
  const echo = buildFiber({ hostType: 'RCTText' }, fixture.fiber);
  echo.tag = 5;
  echo.child = buildFiber({ text: inputCanary }, echo);
  echo.child.tag = 6;
  fixture.fiber.child = input;
  input.sibling = echo;
  const provenance = nativeCapture();
  const observed = provenance.nodes[1];
  const native = async () => ({
    ...provenance,
    snapshotVerdict: { ...provenance.snapshotVerdict, nodeCount: 3 },
    nodes: [
      provenance.nodes[0],
      {
        ...observed,
        ref: '@field',
        type: props.secureTextEntry ? 'SecureTextField' : 'TextField',
        identifier: 'field',
        label: 'Field',
        value: inputCanary,
        secure: props.secureTextEntry === true,
        hittable: true,
        enabled: true,
      },
      {
        ...observed,
        ref: '@echo',
        index: 2,
        identifier: undefined,
        type: 'StaticText',
        label: inputCanary,
        presence: { ...observed.presence, nodeIndex: 2 },
      },
    ],
  });
  const capture = () =>
    captureScreen({
      requirePrivateInputs: true,
      appId: 'com.test',
      native,
      react: () =>
        captureQaReact(
          {
            isConnected: true,
            async withPrivateHelperWorld(run) {
              return run(async (expression) => vm.runInContext(expression, fixture.sandbox));
            },
          },
          typography,
        ),
    });
  return { ...fixture, capture };
}

test('native input values mask their echo through decisions and walking, whatever the React props', async () => {
  for (const hostType of ['RCTSinglelineTextInputView', 'AndroidTextInput']) {
    for (const secureTextEntry of [false, true]) {
      for (const reactProps of [
        { value: inputCanary },
        { defaultValue: inputCanary, text: inputCanary },
        {},
      ]) {
        for (const typography of [false, true]) {
          const fixture = inputPipeline(
            { ...reactProps, secureTextEntry, onChange() {}, onChangeText() {} },
            typography,
            hostType,
          );
          assertNoInputs(fixture.api.beginQaCapture(typography));
          const screen = await fixture.capture();
          assert.ok(inputValues(screen).includes(inputCanary));
          const judge = scriptedJudge((questions, _, state) => {
            assert.equal(JSON.stringify({ questions, state }).includes(inputCanary), false);
            return { check_1: { type: 'noul', noul: 0.99 } };
          });
          const decision = await decideScreen(screen, judge, {
            kind: 'check',
            literal: false,
            text: 'Welcome is visible',
            line: 1,
          });
          assert.equal(decision.check, 'pass');
          assert.equal(judge.requests.length, 1);
          const walk = walker([], judge);
          walk.deps.captureScreen = fixture.capture;
          walk.deps.screenshot = async () => assert.fail('private input pixels must be withheld');
          for (const [source, verdict] of [
            ['✓ Welcome is visible', 'PASS'],
            ['✓ "Absent confirmation"', 'FAIL'],
          ]) {
            const plan = parsePlan(source);
            assert.ok(plan.blocks);
            const result = await runPlan(plan.blocks, walk.deps);
            assert.equal(result.verdict, verdict);
            assert.equal(
              JSON.stringify({ result, rows: walk.rows, outbound: judge.requests }).includes(
                inputCanary,
              ),
              false,
            );
          }
        }
      }
    }
  }
});

function wrappedInput(readOnly = false) {
  let namesRead = 0;
  function TextInput() {
    assert.fail('render must not execute');
  }
  const forward = { $$typeof: Symbol.for('react.forward_ref'), render: TextInput };
  const memo = { $$typeof: Symbol.for('react.memo'), type: forward, compare: null };
  for (const type of [memo, forward]) {
    Object.defineProperty(type, 'displayName', {
      configurable: true,
      get() {
        namesRead++;
        return 'TextInput';
      },
      set() {},
    });
  }
  const props = { testID: 'notes', value: 'wrapped-input-private', readOnly, editable: !readOnly };
  const fixture = setup({ ...props, onChange() {} });
  for (const [type, tag] of [
    [forward, 11],
    [memo, 14],
  ] as const) {
    const wrapper = buildFiber({ props: { ...props } });
    wrapper.type = type;
    wrapper.tag = tag;
    wrapper.child = fixture.root.current;
    fixture.root.current.return = wrapper;
    fixture.root.current = wrapper;
  }
  const native = async () =>
    attested([
      {
        ref: '@notes',
        type: 'Other',
        identifier: 'notes',
        label: 'Notes',
        value: 'wrapped-input-private',
        hittable: true,
        enabled: true,
      },
      { ref: '@echo', type: 'StaticText', label: 'wrapped-input-private', hittable: true },
    ]);
  const react = () =>
    captureQaReact({
      isConnected: true,
      async withPrivateHelperWorld(run) {
        return run(async (expression) => vm.runInContext(expression, fixture.sandbox));
      },
    });
  return { ...fixture, memo, forward, TextInput, native, react, namesRead: () => namesRead };
}

test('wrapped TextInput preserves quoted typing through producer, adapter, capture and walker', async () => {
  const fixture = wrappedInput();
  const legacy = await captureScreen({
    native: fixture.native,
    react: async () =>
      JSON.parse(fixture.api.getTree({ interactiveOnly: true, semanticEvidence: true })),
  });
  assert.equal(legacy.elements.find((element) => element.ref === '@notes')?.kind, 'input');
  const nameReads = fixture.namesRead();
  assert.ok(nameReads > 0, 'legacy producer reads the configured dev displayName');
  const capture = () =>
    captureScreen({
      requirePrivateInputs: true,
      native: async () => {
        const observation = await fixture.native();
        return {
          ...observation,
          truncated: false,
          normalizationDroppedNodes: 0,
          snapshotVerdict: {
            state: 'ok',
            nodeCount: observation.nodes.length,
            refMapUpdated: true,
            reasons: [],
          },
        };
      },
      react: fixture.react,
    });
  const observed = await capture();
  const judge = scriptedJudge(() => assert.fail('unique quoted fill must stay model-free'));
  const walk = walker([], judge);
  walk.deps.captureScreen = capture;
  walk.deps.screenshot = async () => assert.fail('private input pixels must be withheld');
  const plan = parsePlan('1. Type "x" into "notes"');
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, walk.deps);
  assert.equal(
    result.verdict,
    'PASS',
    `private kind=${observed.elements.find((element) => element.ref === '@notes')?.kind}; actions=${walk.actions.join(',')}`,
  );
  assert.deepEqual(walk.actions, ['fill @notes x']);
  assert.equal(observed.elements.find((element) => element.ref === '@notes')?.kind, 'input');
  assert.equal(fixture.namesRead(), nameReads, 'private capture never reads the type accessors');
  assert.ok(inputValues(observed).includes('wrapped-input-private'));
  assert.doesNotMatch(
    JSON.stringify({ result, rows: walk.rows, outbound: judge.requests }),
    /wrapped-input-private/,
  );
});

test('readonly wrapped TextInput keeps input identity but quoted typing cannot act', async () => {
  const fixture = wrappedInput(true);
  const capture = () =>
    captureScreen({ requirePrivateInputs: true, native: fixture.native, react: fixture.react });
  const observed = await capture();
  const notes = observed.elements.find((element) => element.ref === '@notes');
  assert.equal(notes?.kind, 'input');
  assert.equal(notes?.disabled, true);
  const walk = walker(
    [],
    scriptedJudge(() => assert.fail('disabled quoted input must not be judged')),
  );
  walk.deps.captureScreen = capture;
  walk.deps.screenshot = async () =>
    assert.fail('private input pixels must be withheld on failure');
  const plan = parsePlan('1. Type "x" into "notes"');
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, walk.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(walk.actions, []);
  assert.doesNotMatch(JSON.stringify({ result, rows: walk.rows }), /wrapped-input-private/);
  assert.equal(fixture.namesRead(), 0);
});

test('resolved wrapper names do not invent native roles in presence mode', async () => {
  const fixture = wrappedInput();
  const native = nativeCapture();
  Object.assign(native.nodes[1], {
    ref: '@notes',
    type: 'Other',
    identifier: 'notes',
    label: 'Notes',
  });
  const observation = await fixture.react();
  assert.equal(
    observation.interactive?.find((entry) => entry.testID === 'notes')?.role,
    'textinput',
  );
  assert.equal(observation.hostEvidence.hosts[0].role, null);
  assert.equal(observation.hostEvidence.hosts[0].roleSource, 'none');
  const observed = await captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    native: async () => native,
    react: async () => observation,
  });
  const notes = observed.elements.find((element) => element.ref === '@notes');
  assert.equal(notes?.kind, 'other');
  assert.equal(notes?.semantic?.nativePresence?.kind, 'other');
});

function privateNamedType(type: unknown) {
  const fixture = wrappedInput();
  fixture.root.current.type = type;
  fixture.root.current.memoizedProps.onChange = () => {};
  fixture.root.current.child = fixture.fiber;
  fixture.fiber.return = fixture.root.current;
  const result = fixture.api.beginQaCapture();
  assert.equal(result.state, 'ready');
  assertNoInputs(result, 'wrapped-input-private');
  return JSON.parse(result.tree).interactive.find(
    (entry: { testID?: string }) => entry.testID === 'notes',
  );
}

test('private names follow at most two own-data React wrapper links with own-name precedence', () => {
  function TextInput() {
    assert.fail('render or worklet must not execute');
  }
  const forward = { $$typeof: Symbol.for('react.forward_ref'), render: TextInput };
  const memo = { $$typeof: Symbol.for('react.memo'), type: forward };
  for (const type of [TextInput, forward, memo])
    assert.equal(privateNamedType(type).role, 'textinput');
  assert.equal(privateNamedType({ ...memo, displayName: 'Button' }).role, 'button');
  assert.equal(privateNamedType({ ...memo, name: 'Switch' }).role, 'switch');
  assert.equal(privateNamedType({ $$typeof: Symbol.for('react.memo'), type: memo }).role, 'button');
  const cycle = { $$typeof: Symbol.for('react.memo'), type: null as unknown };
  cycle.type = cycle;
  assert.equal(privateNamedType(cycle).role, 'button');
  assert.equal(privateNamedType(Symbol.for('react.fragment')).role, 'button');
});

test('private wrapper traversal never executes accessors or follows inherited or unrecognized links', () => {
  function TextInput() {
    assert.fail('render must not execute');
  }
  let calls = 0;
  const getter = () => {
    calls++;
    throw new Error('wrapper-canary');
  };
  const forward = { $$typeof: Symbol.for('react.forward_ref') };
  Object.defineProperty(forward, 'render', { get: getter });
  const memo = { $$typeof: Symbol.for('react.memo') };
  Object.defineProperty(memo, 'type', { get: getter });
  const accessorMarker = { type: TextInput };
  Object.defineProperty(accessorMarker, '$$typeof', { get: getter });
  const inheritedMarker = Object.assign(Object.create({ $$typeof: Symbol.for('react.memo') }), {
    type: TextInput,
  });
  const inheritedLink = Object.assign(Object.create({ type: TextInput }), {
    $$typeof: Symbol.for('react.memo'),
  });
  const failedProxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('proxy-canary');
      },
    },
  );
  for (const type of [
    forward,
    memo,
    accessorMarker,
    inheritedMarker,
    inheritedLink,
    failedProxy,
    { type: TextInput, render: TextInput },
    { $$typeof: Symbol.for('not.react.memo'), type: TextInput },
  ])
    assert.equal(privateNamedType(type).role, 'button');
  assert.equal(calls, 0);
});

test('recognized wrapper descriptor work is bounded without ordinary property reads', () => {
  let descriptors = 0;
  function TextInput() {
    assert.fail('render must not execute');
  }
  function counted(type: object) {
    return new Proxy(type, {
      getOwnPropertyDescriptor(target, key) {
        descriptors++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get() {
        assert.fail('ordinary type property read');
      },
    });
  }
  const forward = counted({
    $$typeof: Symbol.for('react.forward_ref'),
    render: counted(TextInput),
  });
  const memo = counted({ $$typeof: Symbol.for('react.memo'), type: forward });
  assert.equal(privateNamedType(memo).role, 'textinput');
  assert.ok(descriptors > 0 && descriptors <= 60, `descriptor reads: ${descriptors}`);
});

function devTypes(readName: () => string) {
  function InternalTextInput() {}
  const forward = { $$typeof: Symbol.for('react.forward_ref'), render: InternalTextInput };
  const memo = { $$typeof: Symbol.for('react.memo'), type: forward, compare: null };
  const context = { $$typeof: Symbol.for('react.context') };
  const consumer = { $$typeof: Symbol.for('react.consumer'), _context: context };
  function ClassOwner() {}
  const host = {};
  for (const type of [forward, memo, consumer, host]) {
    Object.defineProperty(type, 'displayName', {
      configurable: true,
      get: readName,
      set() {},
    });
  }
  Object.defineProperty(ClassOwner, 'name', { get: readName });
  return { forward, memo, consumer, ClassOwner, host };
}

function devTree(readName: () => string) {
  const fixture = setup({ value: 'dev-private', readOnly: true, onChange() {} });
  const types = devTypes(readName);
  fixture.fiber.type = types.host;
  fixture.fiber.stateNode = {
    canonical: {
      viewConfig: { uiViewClassName: 'RCTTextInput' },
      publicInstance: {
        measureInWindow(done: (...rect: number[]) => void) {
          queueMicrotask(() => done(0, 0, 100, 30));
        },
      },
    },
  };
  for (const [type, tag] of [
    [types.forward, 11],
    [types.memo, 14],
    [types.consumer, 9],
    [types.ClassOwner, 1],
    [Symbol.for('react.fragment'), 7],
    [Symbol.for('react.strict_mode'), 8],
  ] as const) {
    const wrapper = buildFiber({});
    wrapper.type = type;
    wrapper.tag = tag;
    wrapper.child = fixture.root.current;
    fixture.root.current.return = wrapper;
    fixture.root.current = wrapper;
  }
  return fixture;
}

test('private capture traverses React dev wrappers and symbols without reading type-name accessors', async () => {
  for (const throwing of [false, true]) {
    for (const typography of [false, true]) {
      let calls = 0;
      const { api } = devTree(() => {
        calls++;
        if (throwing) throw new Error('type-name-canary');
        return 'TextInput';
      });
      const begin = api.beginQaCapture(typography);
      assert.equal(calls, 0);
      assertNoInputs(begin, 'dev-private');
      await tick();
      const result = begin.state === 'ready' ? begin : api.readQaCapture(begin.id);
      assert.equal(result.state, 'ready');
      assert.doesNotMatch(result.tree, /dev-private|type-name-canary/);
      assert.equal(calls, 0);
    }
  }
});

test('React dev wrapper producer reaches the adapter and a native input value masks its echo', async () => {
  for (const typography of [false, true]) {
    const { sandbox } = devTree(() => assert.fail('type accessor executed'));
    const observation = await captureQaReact(
      {
        isConnected: true,
        async withPrivateHelperWorld(run) {
          return run(async (expression) => vm.runInContext(expression, sandbox));
        },
      },
      typography,
    );
    const screen = await captureScreen({
      requirePrivateInputs: true,
      react: async () => observation,
      native: async () =>
        attested([
          { ref: '@field', type: 'TextField', label: 'Field', value: 'dev-private' },
          { ref: '@echo', type: 'StaticText', label: 'dev-private' },
        ]),
    });
    assert.ok(inputValues(screen).includes('dev-private'));
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact('dev-private'), '•••');
    assert.doesNotMatch(JSON.stringify(observation), /dev-private/);
  }
});

test('private name resolution has a fixed descriptor budget and never executes accessors or unrecognized wrapper metadata', async () => {
  for (const typography of [false, true]) {
    let descriptors = 0;
    let reads = 0;
    const source = Object.create({
      get displayName() {
        reads++;
        throw new Error('inherited-name');
      },
    });
    Object.defineProperties(source, {
      name: {
        get() {
          reads++;
          throw new Error('name');
        },
      },
      render: {
        get() {
          reads++;
          throw new Error('render');
        },
      },
      type: {
        get() {
          reads++;
          throw new Error('type');
        },
      },
    });
    const type = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) {
        descriptors++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get() {
        reads++;
        throw new Error('type property read');
      },
    });
    const fixture = setup({ value: 'bounded-private' });
    const wrapper = buildFiber({ props: { onPress() {} } });
    wrapper.type = type;
    wrapper.tag = 0;
    wrapper.child = fixture.fiber;
    fixture.fiber.return = wrapper;
    fixture.root.current = wrapper;
    const begin = fixture.api.beginQaCapture(typography);
    await tick();
    assert.equal(
      (begin.state === 'ready' ? begin : fixture.api.readQaCapture(begin.id)).state,
      'ready',
    );
    assert.equal(reads, 0);
    assert.ok(descriptors > 0 && descriptors <= 16, `descriptor reads: ${descriptors}`);
  }
});

test('private captures retain fixed refusals for data-named error overlays', () => {
  for (const name of ['LogBox', 'ErrorWindow', 'RedBox']) {
    const fixture = setup({ value: 'overlay-private' });
    const overlay = buildFiber({ name });
    overlay.child = fixture.fiber;
    fixture.fiber.return = overlay;
    fixture.root.current = overlay;
    const capture = fixture.api.beginQaCapture();
    assert.equal(capture.state, 'refused');
    assert.equal(capture.reason, 'render-error');
    assertNoInputs(capture, 'overlay-private');
    assert.equal(capture.tree, undefined);
  }
});

for (const previousVersion of [89, 93, 94]) {
  test(`current helper replaces a warm ${previousVersion} helper and reinjection preserves the private API`, () => {
    const { sandbox } = setup({ value: '' });
    sandbox.__QAREN = { __v: previousVersion };
    vm.runInContext(INJECTED_HELPERS, sandbox);
    const upgraded = sandbox.__QAREN;
    assert.equal(upgraded.__v, HELPERS_VERSION);
    assert.equal(typeof upgraded.beginQaCapture, 'function');
    assert.equal(typeof upgraded.readQaCapture, 'function');
    vm.runInContext(INJECTED_HELPERS, sandbox);
    assert.equal(sandbox.__QAREN, upgraded);
  });
}

test('private begin over an anonymous disabled input exposes no input channel and consumes once', () => {
  const { api, sandbox } = setup({
    value: ' x ',
    text: '密',
    defaultValue: '\t',
    secureTextEntry: true,
    readOnly: true,
    disabled: true,
  });
  const result = api.beginQaCapture();
  assert.equal(result.v, 1);
  assert.match(result.id, /^[a-f0-9]{1,32}$/);
  assert.equal(result.state, 'ready');
  assertNoInputs(result, '密', ' x ');
  assert.equal(typeof result.tree, 'string');
  assert.deepEqual(plain(api.readQaCapture(result.id)), {
    v: 1,
    id: result.id,
    state: 'refused',
  });
  assert.equal(Object.keys(api).includes('beginQaCapture'), false);
  assert.equal(Object.keys(api).includes('readQaCapture'), false);
  assert.equal(vm.runInContext('JSON.stringify(__QAREN)', sandbox).includes('密'), false);
});

test('native aliases and Fabric canonical types use actual host props, never composite names', () => {
  function hosts(api: { beginQaCapture(): { state: string; tree?: string } }) {
    const result = api.beginQaCapture();
    assert.equal(result.state, 'ready');
    assertNoInputs(result, '密');
    return JSON.parse(result.tree!).hostEvidence.hosts;
  }
  for (const hostType of [
    'TextInput',
    'RCTTextInput',
    'RCTSinglelineTextInputView',
    'RCTMultilineTextInputView',
    'AndroidTextInput',
  ]) {
    const { api, fiber } = setup({ value: ' a\n密 ', secureTextEntry: null }, hostType);
    if (hostType === 'RCTTextInput') {
      fiber.type = { displayName: 'Anonymous' };
      fiber.stateNode = {
        canonical: { viewConfig: { uiViewClassName: hostType } },
      };
    }
    assert.equal(hosts(api)[0].capabilities.fill, true, hostType);
  }
  assert.notEqual(hosts(setup({ value: '密' }, 'CustomNativeHost').api)[0].capabilities.fill, true);
  const { api, fiber } = setup({ value: 'composite-only' });
  fiber.type = { displayName: 'TextInput' };
  fiber.tag = 0;
  assert.deepEqual(hosts(api), []);
});

test('public default, semantic and typography trees cannot opt into private input props', async () => {
  const { api, fiber } = setup({
    value: 'value-secret',
    text: 'text-secret',
    defaultValue: 'default-secret',
    secureTextEntry: true,
  });
  const wrapper = buildFiber({ name: 'TextInput', props: fiber.memoizedProps });
  wrapper.child = fiber;
  fiber.return = wrapper;
  const sandbox = createSandbox({ fiberRoot: wrapper });
  for (const opts of [
    {},
    { interactiveOnly: true, semanticEvidence: true },
    { interactiveOnly: true, semanticEvidence: true, typographyEvidence: true },
  ]) {
    const tree = await sandbox.__QAREN.getTree(
      { ...opts, privateInputs: true, privateCapture: true },
      { private: true },
    );
    assert.doesNotMatch(tree, /(?:value|text|default)-secret|"secureTextEntry"|"inputs"/);
  }
  assert.equal(api.__v, HELPERS_VERSION);
});

test('RN dev-frozen host props and Fragment children props admit a complete capture', () => {
  for (const children of [[{}, {}], 7, 'text', null]) {
    let reads = 0;
    const fixture = setup({}, 'RCTView');
    const fragment = buildFiber({}, fixture.fiber);
    fragment.tag = 7;
    fragment.memoizedProps = children;
    const field = buildFiber(
      {
        hostType: 'RCTSinglelineTextInputView',
        props: {
          testID: 'field',
          value: '',
          onChangeText() {},
          accessibilityState: devFreeze({ disabled: false }, () => reads++),
        },
      },
      fragment,
    );
    field.tag = 5;
    const next = buildFiber(
      {
        hostType: 'RCTView',
        props: {
          testID: 'next',
          onPress() {},
          accessibilityState: devFreeze({ busy: undefined, disabled: true }, () => reads++),
          style: devFreeze({ padding: 4 }),
        },
      },
      fragment,
    );
    next.tag = 5;
    fixture.fiber.child = fragment;
    fragment.child = field;
    field.sibling = next;
    const result = fixture.api.beginQaCapture();
    assert.equal(result.state, 'ready');
    assertNoInputs(result);
    assert.ok(reads > 0);
    const tree = JSON.parse(result.tree);
    assert.equal(tree.hostEvidence.hosts[2].disabled, true);
  }
});

test('dev-freeze lookalikes and dev-frozen input props refuse without invoking getters', () => {
  let calls = 0;
  function identity(value: unknown) {
    calls++;
    return value;
  }
  function throwOnImmutableMutation() {
    throw new Error('immutable');
  }
  const accessor = (descriptor: PropertyDescriptor, freeze = true) => {
    const state = Object.defineProperty({}, 'disabled', { ...descriptor, enumerable: true });
    return freeze ? Object.freeze(state) : state;
  };
  const bound = { get: identity.bind(null, false), set: throwOnImmutableMutation.bind(null) };
  for (const state of [
    accessor(bound, false),
    accessor({ get: bound.get }),
    accessor({ get: identity, set: bound.set }),
    accessor({ get: bound.get, set: throwOnImmutableMutation }),
    accessor({ get: Object.defineProperty(() => false, 'name', { value: 'bound identity' }) }),
  ]) {
    const result = setup({ value: '', accessibilityState: state }).api.beginQaCapture();
    assert.equal(result.state, 'refused');
    assertNoInputs(result);
  }
  for (const props of [{ value: 'secret' }, { value: '', secureTextEntry: true }]) {
    const result = setup(devFreeze(props, () => calls++)).api.beginQaCapture();
    assert.equal(result.state, 'refused');
    assertNoInputs(result, 'secret');
  }
  assert.equal(calls, 0);
});

test('a ready switch capture differs from refused unknown coverage, and switches stay non-inputs', () => {
  const { api, sandbox } = setup({ value: true, onChange() {} }, 'RCTSwitch');
  const ready = api.beginQaCapture();
  assert.equal(ready.state, 'ready');
  assertNoInputs(ready);
  assert.notEqual(JSON.parse(ready.tree).hostEvidence.hosts[0].capabilities.fill, true);
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.set(2, {});
  const original = sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots;
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) => {
    if (id === 2) throw new Error('secret');
    return original(id);
  };
  const unknown = api.beginQaCapture();
  assert.equal(unknown.state, 'refused');
  assertNoInputs(unknown, 'secret');
  assert.equal(createSandbox().__QAREN.beginQaCapture().state, 'refused');
});

function withChildren(count: number, props: Record<string, unknown>, hostType = 'RCTTextInput') {
  const fixture = setup({}, 'RCTView');
  let previous = null;
  for (let i = 0; i < count; i++) {
    const child = buildFiber({ hostType, props: { ...props } }, fixture.fiber);
    child.tag = 5;
    if (previous) previous.sibling = child;
    else fixture.fiber.child = child;
    previous = child;
  }
  return fixture;
}

function wrappedTail(count: number, props: Record<string, unknown> = {}) {
  const fixture = setup({}, 'RCTView');
  let previous = null;
  for (let i = 0; i <= count; i++) {
    const child = buildFiber(
      i === count
        ? { hostType: 'RCTTextInput', props: { testID: 'tail', onChangeText() {}, ...props } }
        : { name: 'Wrapper' },
      fixture.fiber,
    );
    child.tag = i === count ? 5 : 0;
    child.stateNode =
      i === count
        ? { measureInWindow: (done: (...rect: number[]) => void) => done(0, 0, 100, 30) }
        : null;
    if (previous) previous.sibling = child;
    else fixture.fiber.child = child;
    previous = child;
  }
  return { ...fixture, tail: previous! };
}

test('strict QaReN capture completes a single-root tree beyond 2000 fibers without exposing input values', async (t) => {
  // Exercise the fiber bound independently of host load; deadline tests keep their own clock.
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  for (const typography of [false, true]) {
    const fixture = wrappedTail(2998, { value: 'large-tree-input-canary' });
    const legacy = JSON.parse(
      fixture.api.getTree({ interactiveOnly: true, semanticEvidence: true }),
    );
    assert.equal(legacy.totalNodes, 2000);
    assert.equal(legacy.truncated, true);
    const begin = fixture.api.beginQaCapture(typography);
    await tick();
    const result = begin.state === 'pending' ? fixture.api.readQaCapture(begin.id) : begin;
    assertNoInputs(begin, 'large-tree-input-canary');
    assertNoInputs(result, 'large-tree-input-canary');
    assert.equal(result.state, 'ready');
    const tree = JSON.parse(result.tree);
    assert.equal(tree.totalNodes, 3000);
    assert.equal(tree.verdict.complete, true);
    assert.equal(tree.truncated, undefined);
    assert.equal(tree.hostEvidence.complete, true);
    assert.equal(tree.hostEvidence.hosts.length, 2);
    assert.equal(tree.interactive[0].testID, 'tail');
    if (typography) assert.equal(tree.hostEvidence.typography.complete, true);
  }
});

test('strict QaReN capture accepts at the existing 5000-fiber ceiling and refuses above it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  for (const typography of [false, true]) {
    const fixture = wrappedTail(4998);
    const begin = fixture.api.beginQaCapture(typography);
    await tick();
    const result = begin.state === 'pending' ? fixture.api.readQaCapture(begin.id) : begin;
    assert.equal(result.state, 'ready');
    const tree = JSON.parse(result.tree);
    assert.equal(tree.totalNodes, 5000);
    assert.equal(tree.verdict.complete, true);
    assert.equal(tree.interactive[0].testID, 'tail');
    assert.equal(wrappedTail(4999).api.beginQaCapture(typography).state, 'refused');
  }
});

test('unreadable input props beyond 2000 fibers still refuse without invoking getters', () => {
  let calls = 0;
  for (const typography of [false, true]) {
    const fixture = wrappedTail(2998);
    Object.defineProperty(fixture.tail.memoizedProps, 'value', {
      get() {
        calls++;
        throw new Error('large-tree-getter-canary');
      },
    });
    const result = fixture.api.beginQaCapture(typography);
    assert.equal(result.state, 'refused');
    assertNoInputs(result, 'large-tree-getter-canary');
  }
  assert.equal(calls, 0);
});

test('the larger strict capture retains the 200-interactive-node limit', () => {
  const fixture = withChildren(201, { onPress() {} }, 'RCTView');
  assert.equal(fixture.api.beginQaCapture().state, 'refused');
});

test('a larger strict capture still refuses measurement completion at its original deadline', async () => {
  const fixture = wrappedTail(2998, { value: 'large-tree-deadline-canary' });
  let complete: (...rect: number[]) => void = () => assert.fail('measurement not started');
  fixture.tail.stateNode = {
    measureInWindow(done: typeof complete) {
      complete = done;
    },
  };
  const time = clock({ ...fixture, complete: () => complete(0, 0, 100, 30) });
  const begin = fixture.api.beginQaCapture(true);
  assert.equal(begin.state, 'pending');
  time.advance(1000);
  complete(0, 0, 100, 30);
  await tick();
  const result = fixture.api.readQaCapture(begin.id);
  assert.equal(result.state, 'refused');
  assertNoInputs(begin, 'large-tree-deadline-canary');
  assertNoInputs(result, 'large-tree-deadline-canary');
  assert.equal(time.timers.size, 0);
});

test('non-input numeric and opaque object values coexist with an input without coercion', async () => {
  let coercions = 0;
  const opaque = {
    toString() {
      coercions++;
      throw new Error('object-canary');
    },
  };
  for (const [hostType, value] of [
    ['RNCSlider', 0.5],
    ['RCTSlider', 42],
    ['NativeSelection', opaque],
    ['RCTSwitch', true],
  ] as const) {
    for (const typography of [false, true]) {
      const fixture = withChildren(2, {});
      const control = fixture.fiber.child;
      control.type = hostType;
      control.memoizedProps = { value, onChange() {} };
      control.sibling.memoizedProps = { value: 'input-next-to-slider', secureTextEntry: true };
      const begin = fixture.api.beginQaCapture(typography);
      assertNoInputs(begin, 'input-next-to-slider', 'object-canary');
      await tick();
      const result = begin.state === 'ready' ? begin : fixture.api.readQaCapture(begin.id);
      assert.equal(result.state, 'ready', hostType);
      assert.doesNotMatch(result.tree, /input-next-to-slider|object-canary/);
    }
  }
  assert.equal(coercions, 0);
});

test('host and fiber bounds refuse instead of truncating the capture', () => {
  const { maxHosts } = PRIVATE_INPUT_LIMITS;
  assert.equal(withChildren(maxHosts - 2, {}, 'RCTView').api.beginQaCapture().state, 'ready');
  assert.deepEqual(
    plain(withChildren(maxHosts - 1, {}, 'RCTView').api.beginQaCapture().diagnostic),
    {
      cause: 'host-evidence-incomplete',
      scanned: maxHosts,
      budget: 5000,
      roots: 1,
      hosts: maxHosts,
      interactive: 0,
      queued: 0,
      pruned: 0,
    },
  );
  const wide = setup({}, 'RCTView');
  let previous = null;
  for (let i = 0; i < 5100; i++) {
    const child = buildFiber({ name: 'Row' }, wide.fiber);
    child.tag = 0;
    if (previous) previous.sibling = child;
    else wide.fiber.child = child;
    previous = child;
  }
  assert.deepEqual(plain(wide.api.beginQaCapture().diagnostic), {
    cause: 'truncated',
    scanned: 5000,
    budget: 5000,
    roots: 1,
    hosts: 1,
    interactive: 0,
    queued: 0,
    pruned: 0,
  });
  const { api, fiber } = setup({ value: '' });
  assert.equal(api.beginQaCapture().state, 'ready');
  fiber.child = fiber;
  assert.equal(api.beginQaCapture().state, 'refused');
});

test('producer refusals without a scanned tree still name one fixed cause', () => {
  const empty = setup();
  empty.sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = () => new Set();
  assert.deepEqual(plain(empty.api.beginQaCapture().diagnostic), {
    cause: 'verdict-reasons:no-renderer',
  });
  const throwing = setup();
  Object.defineProperty(throwing.fiber, 'memoizedProps', {
    get() {
      throw new Error('private-secret');
    },
  });
  const reply = throwing.api.beginQaCapture();
  assert.deepEqual(plain(reply.diagnostic), { cause: 'producer-error' });
  assert.doesNotMatch(JSON.stringify(reply), /private-secret/);
});

function link<T extends object>(parent: T, children: object[]): T {
  let previous: Record<string, unknown> | null = null;
  for (const child of children as Array<Record<string, unknown>>) {
    child.return = parent;
    if (previous) previous.sibling = child;
    else Reflect.set(parent, 'child', child);
    previous = child;
  }
  return parent;
}

function composite(name: string, props: Record<string, unknown> = {}) {
  const fiber = buildFiber({ name, props });
  fiber.tag = 0;
  return fiber;
}

function host(props: Record<string, unknown> = {}, hostType = 'RCTView') {
  const fiber = buildFiber({ hostType, props });
  fiber.tag = 5;
  return fiber;
}

const leak = 'private-secret-label';

function refusal(api: { beginQaCapture: (typography?: boolean) => Record<string, unknown> }) {
  const reply = api.beginQaCapture();
  assert.equal(reply.state, 'refused');
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(leak));
  return plain(reply.diagnostic) as Record<string, unknown>;
}

test('typography-incomplete refusals name the first fixed site without app strings', () => {
  const overlay = setup({}, 'RCTView');
  // The overlay walk follows the root fiber's siblings; the digest walks only its children.
  link(composite('Shell'), [
    overlay.fiber,
    ...Array.from({ length: 5100 }, () => composite('Row', { accessibilityLabel: leak })),
  ]);
  assert.deepEqual(refusal(overlay.api), {
    cause: 'overlay-scan-cap',
    scanned: 1,
    budget: 5000,
    roots: 1,
    hosts: 1,
    interactive: 0,
    queued: 0,
    pruned: 0,
  });

  const opaque = setup({ title: { text: leak } }, 'RCTView');
  assert.deepEqual(refusal(opaque.api), {
    cause: 'digest-prop-opaque',
    scanned: 1,
    budget: 5000,
    roots: 1,
    hosts: 1,
    interactive: 0,
    queued: 0,
    pruned: 0,
  });

  const wide = setup({ onPress() {} }, 'RCTView');
  link(
    wide.fiber,
    Array.from({ length: 2600 }, () => composite('Row', { accessibilityLabel: leak })),
  );
  const second = { current: host() };
  wide.sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([wide.root, second]) : new Set();
  assert.deepEqual(refusal(wide.api), {
    cause: 'digest-visit-cap',
    scanned: 2602,
    budget: 5000,
    roots: 2,
    hosts: 2,
    interactive: 1,
    queued: 0,
    pruned: 0,
  });

  const late = setup({}, 'RCTView');
  link(late.fiber, [host({ onPress() {}, accessibilityLabel: leak })]);
  // The clock reaches the deadline only inside the digest text walk.
  late.sandbox.Date = {
    now: () => (new Error().stack?.includes('collectText') ? 2000 : 100),
  };
  assert.equal(refusal(late.api).cause, 'typography-deadline');

  const healthy = setup({}, 'RCTView');
  link(healthy.fiber, [host({ onPress() {}, accessibilityLabel: 'Save' })]);
  const accepted = healthy.api.beginQaCapture();
  assert.equal(accepted.state, 'ready');
  assert.equal('diagnostic' in accepted, false);
});

test('truncation reports the queued frontier and inactive fibers pruned by the walk', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const capped = setup({}, 'RCTView');
  link(
    capped.fiber,
    Array.from({ length: 250 }, () => host({ onPress() {} })),
  );
  assert.deepEqual(refusal(capped.api), {
    cause: 'truncated',
    scanned: 201,
    budget: 5000,
    roots: 1,
    hosts: 201,
    interactive: 200,
    queued: 50,
    pruned: 0,
  });

  const pruning = setup({}, 'RCTView');
  const inactive = composite('RNSScreen', { activityState: 0 });
  link(inactive, [composite('Row', { accessibilityLabel: leak })]);
  link(pruning.fiber, [inactive, ...Array.from({ length: 5100 }, () => composite('Row'))]);
  const pruned = refusal(pruning.api);
  assert.equal(pruned.cause, 'truncated');
  assert.equal(pruned.pruned, 1);
  assert.equal(pruned.scanned, pruned.budget);
});

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

function pendingCapture() {
  const fixture = setup({ value: 'private-secret', secureTextEntry: true });
  let complete: (...args: number[]) => void = () => {};
  fixture.fiber.stateNode = {
    measureInWindow(cb: typeof complete) {
      complete = cb;
    },
  };
  return { ...fixture, complete: () => complete(0, 0, 100, 30) };
}

test('pending capture carries no input values and ready polling consumes once', async () => {
  const { api, sandbox, complete } = pendingCapture();
  const begin = api.beginQaCapture(true);
  assert.equal(begin.state, 'pending');
  assertNoInputs(begin, 'private-secret');
  assert.deepEqual(plain(api.readQaCapture(begin.id)), {
    v: 1,
    id: begin.id,
    state: 'pending',
  });
  for (const key of Object.keys(sandbox).filter((key) => key.startsWith('__QAREN'))) {
    assert.doesNotMatch(JSON.stringify(sandbox[key]), /private-secret/);
  }
  complete();
  await tick();
  const ready = api.readQaCapture(begin.id);
  assert.equal(ready.state, 'ready');
  assert.equal('inputs' in ready, false);
  assert.doesNotMatch(ready.tree, /private-secret/);
  assert.equal(api.readQaCapture(begin.id).state, 'refused');
});

test('in-place value prop mutation and root replacement refuse after typography', async () => {
  for (const mutate of [
    (f: ReturnType<typeof pendingCapture>) => {
      f.fiber.memoizedProps.value = 'changed';
    },
    (f: ReturnType<typeof pendingCapture>) => {
      f.root.current = buildFiber({ hostType: 'RCTView' });
    },
  ]) {
    const fixture = pendingCapture();
    const begin = fixture.api.beginQaCapture(true);
    mutate(fixture);
    fixture.complete();
    await tick();
    assert.deepEqual(plain(fixture.api.readQaCapture(begin.id)), {
      v: 1,
      id: begin.id,
      state: 'refused',
      diagnostic: {
        cause: 'tree-changed',
        scanned: 1,
        budget: 5000,
        roots: 1,
        hosts: 1,
        interactive: 0,
        queued: 0,
        pruned: 0,
      },
    });
  }
});

test('supersession cancels old captures and ignores late callbacks', async () => {
  const { api, complete } = pendingCapture();
  const first = api.beginQaCapture(true);
  const second = api.beginQaCapture();
  assert.equal(second.state, 'ready');
  complete();
  await tick();
  assert.equal(api.readQaCapture(first.id).state, 'refused');
  assert.equal(api.readQaCapture(second.id).state, 'refused');
});

function clock(fixture: ReturnType<typeof pendingCapture>) {
  let now = 100;
  let sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  fixture.sandbox.Date = { now: () => now };
  fixture.sandbox.setTimeout = (run: () => void, delay: number) => {
    const id = ++sequence;
    timers.set(id, { at: now + delay, run });
    return id;
  };
  fixture.sandbox.clearTimeout = (id: number) => timers.delete(id);
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now && timers.delete(id)) timer.run();
      }
    },
  };
}

test('producer deadline and abandonment expiry clear slots and reject late completion', async () => {
  const fixture = pendingCapture();
  const time = clock(fixture);
  const first = fixture.api.beginQaCapture(true);
  time.advance(1000);
  fixture.complete();
  await tick();
  assert.deepEqual(plain(fixture.api.readQaCapture(first.id)), {
    v: 1,
    id: first.id,
    state: 'refused',
    diagnostic: {
      cause: 'producer-deadline',
      scanned: 1,
      budget: 5000,
      roots: 1,
      hosts: 1,
      interactive: 0,
      queued: 0,
      pruned: 0,
    },
  });
  assert.equal(time.timers.size, 0);
  const next = fixture.api.beginQaCapture(true);
  time.advance(1500);
  fixture.complete();
  await tick();
  assert.equal(fixture.api.readQaCapture(next.id).state, 'refused');
  assert.equal(time.timers.size, 0);
});

test('ready-but-unread capture expires, while typography false never measures', async () => {
  const fixture = pendingCapture();
  const time = clock(fixture);
  const begin = fixture.api.beginQaCapture(true);
  fixture.complete();
  await tick();
  time.advance(1500);
  assert.equal(fixture.api.readQaCapture(begin.id).state, 'refused');
  let measurements = 0;
  fixture.fiber.stateNode.measureInWindow = () => {
    measurements++;
  };
  assert.equal(fixture.api.beginQaCapture(false).state, 'ready');
  assert.equal(measurements, 0);
  assert.equal(time.timers.size, 0);
});

test('unsupported typography style alone does not make the private capture incomplete', async () => {
  const fixture = withChildren(1, { value: 'private' });
  fixture.fiber.type = 'RCTText';
  fixture.fiber.memoizedProps.style = 123;
  const begin = fixture.api.beginQaCapture(true);
  assertNoInputs(begin);
  await tick();
  const result = fixture.api.readQaCapture(begin.id);
  assert.equal(result.state, 'ready');
  assert.equal(JSON.parse(result.tree).hostEvidence.typography.nodes[0].text.kind, 'unsupported');
});

test('capture refuses malformed roots, root overflow and unknown root registries', () => {
  for (const count of [1, 101]) {
    const { api, sandbox, fiber } = setup({ value: '' });
    assert.equal(api.beginQaCapture().state, 'ready');
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
      id === 1
        ? new Set(Array.from({ length: count }, () => (count === 1 ? {} : { current: fiber })))
        : new Set();
    assert.equal(api.beginQaCapture().state, 'refused');
  }
  const { api, sandbox } = setup({ value: '' });
  assert.equal(api.beginQaCapture().state, 'ready');
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers = {};
  assert.equal(api.beginQaCapture().state, 'refused');
});

test('malformed root and fiber accessors refuse without executing them', () => {
  for (const field of ['memoizedProps', 'type', 'child', 'stateNode']) {
    let calls = 0;
    const { api, fiber } = setup({ value: '' });
    assert.equal(api.beginQaCapture().state, 'ready');
    Object.defineProperty(fiber, field, {
      get() {
        calls++;
        throw new Error('secret');
      },
    });
    assert.equal(api.beginQaCapture().state, 'refused');
    assert.equal(calls, 0);
  }
  let calls = 0;
  const { api, root } = setup({ value: '' });
  assert.equal(api.beginQaCapture().state, 'ready');
  Object.defineProperty(root, 'current', {
    get() {
      calls++;
      throw new Error('secret');
    },
  });
  assert.equal(api.beginQaCapture().state, 'refused');
  assert.equal(calls, 0);
});

test('root object replacement, renderer coverage drift and public host identity mutation refuse', async () => {
  for (const mutate of [
    (f: ReturnType<typeof pendingCapture>) => {
      f.sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
        id === 1 ? new Set([{ current: f.fiber }]) : new Set();
    },
    (f: ReturnType<typeof pendingCapture>) => {
      f.sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.set(2, {});
    },
    (f: ReturnType<typeof pendingCapture>) => {
      f.fiber.memoizedProps.testID = 'changed';
    },
  ]) {
    const fixture = pendingCapture();
    const begin = fixture.api.beginQaCapture(true);
    mutate(fixture);
    fixture.complete();
    await tick();
    assert.equal(fixture.api.readQaCapture(begin.id).state, 'refused');
  }
});

test('public full tree omits Fabric input props even with an unrelated host display name', () => {
  const { api, fiber } = setup({ value: 'fabric-private' });
  fiber.type = { displayName: 'AnonymousNativeHost' };
  fiber.stateNode = { canonical: { viewConfig: { uiViewClassName: 'RCTTextInput' } } };
  assert.doesNotMatch(api.getTree({ privateInputs: true }), /fabric-private/);
});

function readonlyField(props: Record<string, unknown>) {
  const fixture = setup({ value: 'host-private', readOnly: true, onChange() {} });
  const forward = devTypes(() => 'TextInput').forward;
  const internal = buildFiber({
    props: { value: 'internal-private', readOnly: true, onChange() {} },
  });
  internal.type = forward.render;
  internal.tag = 0;
  internal.child = fixture.fiber;
  fixture.fiber.return = internal;
  const devWrapper = buildFiber({
    props: { value: 'wrapper-private', readOnly: true, onChange() {} },
  });
  devWrapper.type = forward;
  devWrapper.tag = 11;
  devWrapper.child = internal;
  internal.return = devWrapper;
  const field = buildFiber({
    name: 'Field',
    props: { testID: 'field', readOnly: true, onChange() {}, ...props },
  });
  field.child = devWrapper;
  devWrapper.return = field;
  const text = buildFiber({ text: 'Visible ordinary text' }, field);
  text.tag = 6;
  devWrapper.sibling = text;
  fixture.root.current = field;
  return { ...fixture, field };
}

test('public full and filtered trees suppress readonly InternalTextInput and Field value props', () => {
  const { api } = readonlyField({ value: 'field-private' });
  for (const opts of [{}, { filter: 'field' }]) {
    const tree = api.getTree(opts);
    assert.doesNotMatch(tree, /(?:host|internal|wrapper|field)-private/);
    assert.match(tree, /Visible ordinary text/);
    assert.doesNotMatch(tree, /"inputs"|"facts"/);
  }
});

test('public full and filtered trees skip suppressed prop accessors before reading them', () => {
  for (const key of ['value', 'text', 'defaultValue', 'secureTextEntry']) {
    for (const opts of [{}, { filter: 'field' }]) {
      let calls = 0;
      const { api, field } = readonlyField({});
      Object.defineProperty(field.memoizedProps, key, {
        enumerable: true,
        get() {
          calls++;
          throw new Error('suppressed-prop-canary');
        },
      });
      const tree = api.getTree(opts);
      assert.equal(calls, 0);
      assert.doesNotMatch(tree, /suppressed-prop-canary|(?:host|internal|wrapper)-private/);
    }
  }
});

test('public full trees retain boolean switch values and ordinary visible text children', () => {
  const root = buildFiber({
    name: 'Switch',
    props: { value: false },
    children: [{ text: 'Visible text' }],
  });
  root.child.tag = 6;
  const sandbox = createSandbox({ fiberRoot: root });
  const tree = JSON.parse(sandbox.__QAREN.getTree({}));
  assert.equal(tree.tree.props.value, false);
  assert.deepEqual(tree.tree.children, [{ text: 'Visible text' }]);
});

test('wide fiber enqueue and cyclic siblings terminate with fixed refusal', () => {
  const fixture = setup({}, 'RCTView');
  let previous = null;
  for (let i = 0; i < 5001; i++) {
    const child = buildFiber({ name: 'Wrapper' }, fixture.fiber);
    child.tag = 0;
    if (previous) previous.sibling = child;
    else fixture.fiber.child = child;
    previous = child;
  }
  assert.equal(fixture.api.beginQaCapture().state, 'refused');
  fixture.fiber.child.sibling = fixture.fiber.child;
  assert.equal(fixture.api.beginQaCapture().state, 'refused');
});

test('revalidation never invokes a newly installed private getter or exposes its error', async () => {
  const fixture = pendingCapture();
  let calls = 0;
  const begin = fixture.api.beginQaCapture(true);
  Object.defineProperty(fixture.fiber.memoizedProps, 'value', {
    get() {
      calls++;
      throw new Error('private-secret');
    },
  });
  fixture.complete();
  await tick();
  assert.deepEqual(plain(fixture.api.readQaCapture(begin.id)), {
    v: 1,
    id: begin.id,
    state: 'refused',
    diagnostic: {
      cause: 'tree-changed',
      scanned: 1,
      budget: 5000,
      roots: 1,
      hosts: 1,
      interactive: 0,
      queued: 0,
      pruned: 0,
    },
  });
  assert.equal(calls, 0);
});

test('the producer never executes TextInput text, default, secure or value props and returns no input channel', async () => {
  for (const typography of [false, true]) {
    for (const accessorValue of [false, true]) {
      let calls = 0;
      const props: Record<string, unknown> = { testID: 'field', onChangeText() {} };
      for (const key of ['text', 'defaultValue', 'secureTextEntry', 'value']) {
        if (key === 'value' && !accessorValue) {
          props.value = 'value-canary';
          continue;
        }
        Object.defineProperty(props, key, {
          enumerable: true,
          get() {
            calls++;
            throw new Error(`${key}-canary`);
          },
        });
      }
      const fixture = setup(props, 'RCTSinglelineTextInputView');
      fixture.fiber.stateNode = {
        measureInWindow(done: (...rect: number[]) => void) {
          queueMicrotask(() => done(0, 0, 100, 30));
        },
      };
      const begin = fixture.api.beginQaCapture(typography);
      await tick();
      const result = begin.state === 'pending' ? fixture.api.readQaCapture(begin.id) : begin;
      // The digest stability check still compares `value` as own data, so an accessor refuses unread.
      assert.equal(result.state, accessorValue ? 'refused' : 'ready');
      assert.equal(calls, 0);
      for (const reply of [begin, result])
        assertNoInputs(
          reply,
          'value-canary',
          'text-canary',
          'defaultValue-canary',
          'secureTextEntry-canary',
        );
    }
  }
});
