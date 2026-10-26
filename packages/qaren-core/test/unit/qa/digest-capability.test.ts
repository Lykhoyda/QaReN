import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';

interface FiberSpec {
  name?: string;
  hostType?: string;
  props?: Record<string, unknown>;
  children?: FiberSpec[];
}

function readDigest(sandbox: vm.Context) {
  return JSON.parse(vm.runInContext('__QAREN.getTree({ interactiveOnly: true })', sandbox));
}

function digest(children: FiberSpec[]) {
  return readDigest(createSandbox({ fiberRoot: buildFiber({ name: 'Screen', children }) }));
}

const handler = () => assert.fail('digest capture must not invoke handlers');

test('press capability requires an observed press or click function, not an inferred button role', () => {
  const none = { press: false, fill: false };
  for (const props of [{ onChange: handler }, { onPressIn: handler }, { onLongPress: handler }]) {
    assert.deepEqual(digest([{ name: 'GenericControl', props }]).interactive, [
      { role: 'button', capabilities: none },
    ]);
  }
  for (const props of [
    { accessibilityRole: 'button' },
    { accessibilityRole: 'button', onPress: true, onClick: '[Function]' },
  ]) {
    assert.deepEqual(digest([{ name: 'GenericControl', props }]).interactive, [
      { role: 'button', capabilities: none, handlerless: true },
    ]);
  }
  for (const name of ['Button', 'Pressable']) {
    assert.deepEqual(digest([{ name }]).interactive, [
      { role: 'button', capabilities: none, handlerless: true },
    ]);
  }
  for (const props of [{ onPress: handler }, { onClick: handler }]) {
    assert.deepEqual(digest([{ hostType: 'RCTView', props }]).interactive, [
      { role: 'button', capabilities: { press: true, fill: false } },
    ]);
  }
});

test('fill capability comes from an editable TextInput or an observed onChangeText function', () => {
  assert.deepEqual(
    digest([
      { name: 'TextInput' },
      { name: 'TextInput', props: { editable: true } },
      { name: 'CustomInput', props: { onChangeText: handler } },
      { hostType: 'AndroidTextInput', props: { onChangeText: handler } },
      { name: 'CustomInput', props: { accessibilityRole: 'button', onChangeText: handler } },
      { name: 'GenericControl', props: { accessibilityRole: 'search' } },
      { name: 'GenericControl', props: { onSubmitEditing: handler, onChangeText: true } },
    ]).interactive,
    [
      { role: 'textinput', capabilities: { press: false, fill: true } },
      { role: 'textinput', capabilities: { press: false, fill: true } },
      { role: 'textinput', capabilities: { press: false, fill: true } },
      { role: 'textinput', capabilities: { press: false, fill: true } },
      { role: 'button', capabilities: { press: false, fill: true } },
      { role: 'search', capabilities: { press: false, fill: false }, handlerless: true },
      { role: 'button', capabilities: { press: false, fill: false } },
    ],
  );
});

test('capability evidence does not erase disabled state or make a read-only input fillable', () => {
  assert.deepEqual(
    digest([
      { name: 'Pressable', props: { onPress: handler, disabled: true } },
      { hostType: 'RCTView', props: { onClick: handler, accessibilityState: { disabled: true } } },
      { name: 'TextInput', props: { onChangeText: handler, editable: false } },
      { name: 'TextInput', props: { disabled: true } },
    ]).interactive,
    [
      { role: 'button', capabilities: { press: true, fill: false }, disabled: true },
      { role: 'button', capabilities: { press: true, fill: false }, disabled: true },
      { role: 'textinput', capabilities: { press: false, fill: false }, disabled: true },
      { role: 'textinput', capabilities: { press: false, fill: true }, disabled: true },
    ],
  );
});

test('a proven single-child identity chain unions positive capabilities and retains disabled state', () => {
  for (const { outer, inner } of [
    { outer: { onPress: handler, disabled: true }, inner: { onChangeText: handler } },
    {
      outer: { onChangeText: handler },
      inner: { onClick: handler, accessibilityState: { disabled: true } },
    },
  ]) {
    const identity = { testID: 'shared', accessibilityRole: 'button' };
    assert.deepEqual(
      digest([
        {
          name: 'Control',
          props: { ...identity, ...outer },
          children: [
            {
              name: 'TransparentWrapper',
              children: [
                {
                  name: 'Control',
                  props: { ...identity, ...inner },
                  children: [
                    {
                      hostType: 'RCTView',
                      props: { ...identity, onChange: handler, disabled: false },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]).interactive,
      [
        {
          role: 'button',
          testID: 'shared',
          capabilities: { press: true, fill: true },
          disabled: true,
        },
      ],
    );
  }
});

test('distinct controls sharing an ID do not share capabilities across siblings or native hosts', () => {
  const press: FiberSpec = { hostType: 'RCTView', props: { testID: 'shared', onClick: handler } };
  const fill: FiberSpec = {
    hostType: 'RCTView',
    props: { testID: 'shared', accessibilityRole: 'button', onChangeText: handler },
  };
  for (const children of [[press, fill], [{ ...press, children: [fill] }]]) {
    assert.deepEqual(digest(children).interactive, [
      { role: 'button', testID: 'shared', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'shared', capabilities: { press: false, fill: true } },
    ]);
  }
});

test('capability forwarding still stops at branches, changed IDs and changed roles', () => {
  const press: FiberSpec = { name: 'Pressable', props: { testID: 'shared', onPress: handler } };
  const fill: FiberSpec = {
    name: 'CustomInput',
    props: { testID: 'shared', accessibilityRole: 'button', onChangeText: handler },
  };
  assert.deepEqual(digest([{ ...press, children: [fill, fill] }]).interactive, [
    { role: 'button', testID: 'shared', capabilities: { press: true, fill: false } },
    { role: 'button', testID: 'shared', capabilities: { press: false, fill: true } },
    { role: 'button', testID: 'shared', capabilities: { press: false, fill: true } },
  ]);
  assert.deepEqual(
    digest([
      {
        ...press,
        children: [{ name: 'Wrapper', props: { testID: 'different' }, children: [fill] }],
      },
    ]).interactive,
    [
      { role: 'button', testID: 'shared', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'shared', capabilities: { press: false, fill: true } },
    ],
  );
  assert.deepEqual(
    digest([{ ...press, children: [{ name: 'TextInput', props: { testID: 'shared' } }] }])
      .interactive,
    [
      { role: 'button', testID: 'shared', capabilities: { press: true, fill: false } },
      { role: 'textinput', testID: 'shared', capabilities: { press: false, fill: true } },
    ],
  );
});

test('capability capture preserves the existing complete digest verdict and omits truncation', () => {
  assert.deepEqual(digest([{ hostType: 'RCTView', props: { onClick: handler } }]), {
    interactive: [{ role: 'button', capabilities: { press: true, fill: false } }],
    totalNodes: 2,
    rootsSeeded: 1,
    verdict: {
      state: 'ok',
      path: 'interactive',
      reasons: [],
      rootsSeeded: 1,
      scannedNodes: 2,
      effectiveDepth: 4,
      droppedSubtrees: 0,
      collapsedChildLists: 0,
      complete: true,
      rendererErrors: 0,
      unscannedRendererIds: [],
    },
  });
});

test('capability evidence does not upgrade an incomplete renderer scan to complete', () => {
  const root = buildFiber({ hostType: 'RCTView', props: { onPress: handler } });
  const sandbox = createSandbox();
  Object.assign(sandbox, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map([
        [1, {}],
        [29, {}],
      ]),
      getFiberRoots(id: number) {
        if (id === 29) throw new Error('renderer teardown');
        return id === 1 ? new Set([{ current: root }]) : new Set();
      },
    },
  });
  const result = readDigest(sandbox);
  assert.deepEqual(result.interactive, [
    { role: 'button', capabilities: { press: true, fill: false } },
  ]);
  assert.equal(result.truncated, undefined);
  assert.deepEqual(result.verdict, {
    state: 'degraded',
    path: 'interactive',
    reasons: ['renderer-error'],
    rootsSeeded: 1,
    scannedNodes: 1,
    effectiveDepth: 4,
    droppedSubtrees: 0,
    collapsedChildLists: 0,
    complete: false,
    rendererErrors: 1,
    unscannedRendererIds: [],
  });
});

test('missing renderer evidence still returns the existing failed verdict, not an empty digest', () => {
  const result = readDigest(createSandbox());
  assert.equal(result.interactive, undefined);
  assert.equal(result.verdict.state, 'failed');
  assert.equal(result.verdict.complete, false);
  assert.ok(result.verdict.reasons.includes('no-renderer'));
});

test('capability capture preserves the 200-entry cap and its truncation disclosure', () => {
  const result = digest(
    Array.from({ length: 250 }, (_, i) => ({
      name: 'GenericControl',
      props: { testID: `control-${i}`, onChange: handler },
    })),
  );
  assert.equal(result.interactive.length, 200);
  for (const entry of result.interactive) {
    assert.deepEqual(entry.capabilities, { press: false, fill: false });
  }
  assert.equal(result.truncated, true);
  assert.equal(result.totalNodes, 201);
  assert.equal(result.verdict.state, 'degraded');
  assert.equal(result.verdict.complete, false);
  assert.deepEqual(result.verdict.reasons, ['scan-budget-exhausted']);
});

test('capability capture preserves scan-budget exhaustion before reaching a control', () => {
  const result = digest([
    ...Array.from({ length: 2000 }, () => ({ name: 'View' })),
    { name: 'Pressable', props: { onPress: handler } },
  ]);
  assert.deepEqual(result.interactive, []);
  assert.equal(result.truncated, true);
  assert.equal(result.totalNodes, 2000);
  assert.equal(result.verdict.state, 'degraded');
  assert.equal(result.verdict.complete, false);
  assert.deepEqual(result.verdict.reasons, ['scan-budget-exhausted']);
});
