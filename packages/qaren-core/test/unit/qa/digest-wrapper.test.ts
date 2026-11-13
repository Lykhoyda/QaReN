import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { PrivateInputCaptureError } from '../../../dist/qa/private-input.js';
import { PRIVATE_INPUT_LIMITS } from '../../../dist/qa/private-input-limits.js';
import { join, semanticActionView, visibilityView } from '../../../dist/qa/screen.js';
import { fillHostInside, prepareTarget } from '../../../dist/qa/resolve.js';
import { exactIdentities } from '../../../dist/qa/identity.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';

interface FiberSpec {
  name?: string;
  hostType?: string;
  props?: Record<string, unknown>;
  children?: FiberSpec[];
  // A React portal fiber (tag 4): its children are drawn into another host.
  portal?: true;
}

const handler = () => assert.fail('capture must not invoke callbacks');
const control = (testID = 'save'): FiberSpec => ({
  name: 'Pressable',
  props: { testID, onPress: handler },
  children: [{ hostType: 'RCTView', props: { testID, onClick: handler } }],
});
const wrapper = (children: FiberSpec[] = [control()]): FiberSpec => ({
  name: 'SwipeableTaskRow',
  props: { onLongPress: handler, onDelete: handler },
  children,
});

function markPortals(
  fiber: { tag?: number; type?: unknown; child?: unknown; sibling?: unknown },
  spec: FiberSpec,
): void {
  if (spec.portal) {
    fiber.tag = 4;
    fiber.type = null;
  }
  let child = fiber.child as typeof fiber | null;
  for (const childSpec of spec.children ?? []) {
    markPortals(child!, childSpec);
    child = child!.sibling as typeof fiber | null;
  }
}

async function observe(children: FiberSpec[]) {
  const root = { current: buildFiber({ name: 'Screen', children }) };
  markPortals(root.current, { children });
  const sandbox = createSandbox({ fiberRoot: root.current });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([root]) : new Set();
  return captureQaReact({
    isConnected: true,
    async withPrivateHelperWorld(run) {
      return run(async (expression) => vm.runInContext(expression, sandbox));
    },
  });
}

test('J1 excludes three custom task-row wrappers but keeps their separately identified controls', async () => {
  const ids = ['first', 'second', 'third'];
  const react = await observe(ids.map((id) => wrapper([control(id)])));
  assert.deepEqual(
    react.interactive!.map((entry) => entry.compositeWrapper === true),
    [true, true, true, false, false, false],
  );
  const native = nativeCapture();
  native.nodes = [
    native.nodes[0],
    ...ids.map((id, i) => ({
      ...native.nodes[1],
      ref: `@row${i}`,
      identifier: id,
      index: i + 1,
      presence: { ...native.nodes[1].presence, nodeIndex: i + 1 },
    })),
  ];
  native.snapshotVerdict.nodeCount = native.nodes.length;
  const screen = await captureScreen({
    appId: 'com.test',
    native: async () => native,
    react: async () => react,
  });
  assert.equal(screen.semanticUnassociatedReact, 0);
  for (const projection of [visibilityView(screen), semanticActionView(screen, 'press')]) {
    assert.ok('elements' in projection, JSON.stringify(projection));
    assert.deepEqual(
      projection.elements.map((entry) => entry.testID),
      ids,
    );
  }
});

test('J1 requires an interactive descendant, not merely a sibling or noninteractive child', async () => {
  for (const children of [[], [{ name: 'View' }]]) {
    const react = await observe([wrapper(children), control()]);
    assert.equal(react.interactive![0].compositeWrapper, undefined);
    assert.equal(join([], react.interactive!).semanticUnassociatedReact, 2);
  }
  const react = await observe([wrapper([{ name: 'View', children: [wrapper()] }])]);
  assert.deepEqual(
    react.interactive!.map((entry) => entry.compositeWrapper === true),
    [true, true, false],
  );
  assert.equal(join([], react.interactive!).semanticUnassociatedReact, 1);
});

test('J1 retains identified composites, views, known controls and explicitly declared controls', async () => {
  const known = [
    'View',
    'RCTView',
    'ScrollView',
    'Text',
    'Pressable',
    'Button',
    'TextInput',
    'Switch',
    'Link',
    'TouchableOpacity',
    'TouchableHighlight',
    'TouchableWithoutFeedback',
    'TouchableNativeFeedback',
    'Animated.View',
    'CssInterop.Pressable',
  ];
  for (const outer of [
    { ...wrapper(), props: { testID: 'row', onLongPress: handler } },
    ...known.map((name) => ({ name, props: { onLongPress: handler }, children: [control()] })),
    { hostType: 'CustomNativeControl', props: { onLongPress: handler }, children: [control()] },
    { ...wrapper(), props: { onLongPress: handler, accessibilityRole: 'button' } },
    { ...wrapper(), props: { onLongPress: handler, role: 'button' } },
  ]) {
    const react = await observe([outer]);
    assert.equal(join([], react.interactive!).semanticUnassociatedReact, 2, JSON.stringify(outer));
    if (!outer.props.testID) assert.equal(react.interactive![0].compositeWrapper, undefined);
  }
});

test('a nativeID forwarding chain cannot count itself as a separate interactive descendant', async () => {
  const props = { nativeID: 'row', onPress: handler };
  const react = await observe([
    { name: 'SwipeableTaskRow', props, children: [{ name: 'Pressable', props }] },
  ]);
  assert.equal(react.interactive!.length, 1);
  assert.equal(react.interactive![0].compositeWrapper, undefined);
  assert.equal(join([], react.interactive!).semanticUnassociatedReact, 1);
});

test('J1 does not remove host evidence or turn incomplete captures into complete screens', async () => {
  const react = await observe([wrapper([{ hostType: 'RCTView', props: { onClick: handler } }])]);
  assert.equal(join([], react.interactive!).semanticUnassociatedReact, 1);
  assert.deepEqual(react.hostEvidence!.hosts, [
    { role: null, roleSource: 'none', capabilities: { press: true }, order: 0 },
  ]);
  const screen = join([], react.interactive!, 'app', { native: 'complete', react: 'incomplete' });
  assert.ok('refuse' in visibilityView(screen));
  // Each wrapper adds two entries and one host: past the private entry limit, under the host limit.
  const capped = Array.from({ length: PRIVATE_INPUT_LIMITS.maxHosts / 2 + 1 }, () => wrapper());
  await assert.rejects(observe(capped), PrivateInputCaptureError);
});

test('capture rejects malformed composite-wrapper facts rather than dropping them', async () => {
  for (const compositeWrapper of [false, 'true', 1, null, {}]) {
    await assert.rejects(
      captureQaReact({
        isConnected: true,
        async withPrivateHelperWorld(run) {
          return run(async () => ({
            v: 1,
            id: 'abc',
            state: 'ready',
            inputs: { version: 1, complete: true, facts: [] },
            tree: JSON.stringify({
              interactive: [{ role: 'button', compositeWrapper }],
              hostEvidence: { complete: true, hosts: [] },
              verdict: { state: 'ok', path: 'interactive', complete: true },
            }),
          }));
        },
      }),
      PrivateInputCaptureError,
    );
  }
});

for (const ancestor of [true, false]) {
  test(`input forwarding requires captured ancestry: ${ancestor}`, async () => {
    const input = {
      name: 'TextInput',
      props: { testID: 'notes', onChangeText: handler },
      children: [{ hostType: 'RCTTextInput', props: { testID: 'notes', onChangeText: handler } }],
    };
    const composite = {
      name: 'NotesField',
      props: { testID: 'notes', onPress: handler },
      children: ancestor ? [input] : [],
    };
    const react = await observe(ancestor ? [composite] : [composite, input]);
    const screen = join(
      [{ ref: '@input', type: 'TextField', identifier: 'notes', hittable: true }],
      react.interactive!,
      'app',
      undefined,
      react.hostEvidence,
    );
    assert.equal(
      exactIdentities(screen, { quoted: 'notes', phrase: 'notes', exact: 'id' }, 'fill').length,
      ancestor ? 1 : 2,
    );
    assert.deepEqual(react.interactive![0].inputHostIndices, ancestor ? [0] : undefined);
  });
}

test('merged EmailField input retains its placeholder for Fill Email', async () => {
  const props = { testID: 'email', onChangeText: handler, placeholder: 'Email' };
  const react = await observe([
    {
      name: 'EmailField',
      props,
      children: [{ name: 'TextInput', props, children: [{ hostType: 'RCTTextInput', props }] }],
    },
  ]);
  assert.equal(react.interactive!.length, 1);
  assert.equal(react.interactive![0].compositeWrapper, undefined);
  const screen = join(
    [{ ref: '@email', type: 'TextField', identifier: 'email', label: '', hittable: true }],
    react.interactive!,
    'app',
    undefined,
    react.hostEvidence,
  );
  const target = prepareTarget(
    { kind: 'fill', target: { quoted: 'Email', phrase: 'Email' }, text: 'qa@example.test' },
    screen,
  );
  assert.ok('ref' in target, JSON.stringify(target));
  assert.equal(target.ref, '@email');
  assert.equal(target.element.placeholder, 'Email');
  assert.equal(
    exactIdentities(screen, { quoted: 'email', phrase: 'email', exact: 'id' }, 'fill').length,
    1,
  );
});

const unnamedInput = (): FiberSpec => {
  const props = { placeholder: 'Scratch note', onChangeText: handler };
  return {
    name: 'NoteField',
    props: { ...props, onPress: handler },
    children: [
      {
        name: 'TextInput',
        props,
        children: [
          {
            name: 'InternalTextInput',
            props,
            children: [{ hostType: 'RCTSinglelineTextInputView', props }],
          },
        ],
      },
    ],
  };
};
const unnamedNativeInput = {
  ref: '@note',
  type: 'TextField',
  hittable: true,
  enabled: true,
  rect: { x: 20, y: 100, width: 300, height: 44 },
};

test('separately emitted unnamed TextInput layers fill their single attested input', async () => {
  const react = await observe([unnamedInput()]);
  assert.equal(react.interactive!.length, 4);
  assert.ok(react.interactive!.some((entry) => entry.compositeWrapper));
  const screen = join(
    [unnamedNativeInput],
    react.interactive!,
    'app',
    { native: 'complete', react: 'complete' },
    react.hostEvidence,
  );
  const target = prepareTarget(
    { kind: 'fill', target: { quoted: 'Scratch note', phrase: 'Scratch note' }, text: 'alpha' },
    screen,
  );
  assert.ok('element' in target, JSON.stringify(target));
  assert.equal(target.element.ref, '@note');
  const f = walker(
    [screen],
    scriptedJudge(() => assert.fail('literal Fill needs no judgment')),
  );
  const ledger = await runPlan(parsePlan('1. Fill "Scratch note" with "alpha"').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.deepEqual(f.actions, ['fill @note alpha']);
});

test('separate nested inputs sharing a placeholder still refuse, including a React-only competitor', async () => {
  const react = await observe([unnamedInput(), unnamedInput()]);
  assert.deepEqual(
    react.hostEvidence?.hosts.map((host) => host.capabilities.fill),
    [true, true],
  );
  for (const nodes of [
    [unnamedNativeInput],
    [unnamedNativeInput, { ...unnamedNativeInput, ref: '@other' }],
  ]) {
    const screen = join(
      nodes,
      react.interactive!,
      'app',
      { native: 'complete', react: 'complete' },
      react.hostEvidence,
    );
    const f = walker(
      [screen],
      scriptedJudge(() => assert.fail('literal Fill needs no judgment')),
    );
    const target = prepareTarget(
      { kind: 'fill', target: { quoted: 'Scratch note', phrase: 'Scratch note' }, text: 'alpha' },
      screen,
    );
    assert.ok('refuse' in target);
    assert.equal(target.refuse, 'TARGET_NOT_FOUND');
    const ledger = await runPlan(parsePlan('1. Fill "Scratch note" with "alpha"').blocks!, f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    assert.deepEqual(f.actions, []);
  }
});

// C2: an ordinary capture proves a React-only input lies beneath the wrapper view QaReN would tap.
const W = 'qa-hidden-c-pressable';
const X = 'qa-hidden-c';
const presetInput = (id = X): FiberSpec => ({
  name: 'TextInput',
  props: { testID: id, value: 'preset', onChangeText: handler },
  children: [
    {
      name: 'InternalTextInput',
      props: { testID: id, value: 'preset', onChangeText: handler },
      children: [
        {
          hostType: 'RCTSinglelineTextInputView',
          props: { testID: id, text: 'preset', onChange: handler, onChangeText: handler },
        },
      ],
    },
  ],
});
const plainView = (children: FiberSpec[]): FiberSpec => ({
  name: 'View',
  props: {},
  children: [{ hostType: 'RCTView', props: {}, children }],
});
const pressableAround = (children: FiberSpec[], id = W): FiberSpec => {
  const own = { testID: id, accessible: true, onClick: handler, onResponderGrant: handler };
  return {
    name: 'Pressable',
    props: { testID: id, onPress: handler },
    children: [
      { name: 'View', props: own, children: [{ hostType: 'RCTView', props: own, children }] },
    ],
  };
};
const wrapperShapes: Array<{ name: string; met: boolean; id?: string; tree: FiberSpec[] }> = [
  {
    name: '1 the Test App fixture: HiddenPressableInput > Pressable W > view > TextInput X',
    met: true,
    tree: [
      {
        name: 'HiddenPressableInput',
        props: { baseId: X, inputTestID: X, value: 'preset', onChangeText: handler },
        children: [pressableAround([plainView([presetInput()])])],
      },
    ],
  },
  {
    name: '2 a custom component W passes W on to such a pressable',
    met: true,
    tree: [
      {
        name: 'FormField',
        props: { testID: W, onPress: handler },
        children: [pressableAround([plainView([presetInput()])])],
      },
    ],
  },
  {
    name: '3 a plain view between the component W and its view W',
    met: true,
    tree: [
      {
        name: 'Pressable',
        props: { testID: W, onPress: handler },
        children: [
          {
            hostType: 'RCTView',
            props: {},
            children: [
              {
                hostType: 'RCTView',
                props: { testID: W, onClick: handler },
                children: [plainView([presetInput()])],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: '4 the pressable W and the input are siblings',
    met: false,
    tree: [plainView([pressableAround([]), presetInput()])],
  },
  {
    name: '5 two inputs inside the pressable',
    met: false,
    tree: [pressableAround([plainView([presetInput(), presetInput('other-input')])])],
  },
  {
    name: '6 a front view W; a back component W passes W to no view and wraps the input',
    met: false,
    tree: [
      {
        name: 'Front',
        props: {},
        children: [{ hostType: 'RCTView', props: { testID: W, accessible: true } }],
      },
      {
        name: 'Back',
        props: {},
        children: [
          {
            name: 'Field',
            props: { testID: W, accessibilityRole: 'button', onPress: handler },
            children: [presetInput()],
          },
        ],
      },
    ],
  },
  {
    name: '7 a component W draws its view W beside the input',
    met: false,
    tree: [
      {
        name: 'Field',
        props: { testID: W, onChangeText: handler },
        children: [{ hostType: 'RCTView', props: { testID: W } }, presetInput()],
      },
    ],
  },
  {
    name: '8 the wrapper carries the input id',
    met: false,
    id: X,
    tree: [pressableAround([plainView([presetInput()])], X)],
  },
  {
    name: '9 the input is rendered through a portal below the wrapper view',
    met: false,
    tree: [pressableAround([{ portal: true, children: [presetInput()] }])],
  },
  {
    name: '10 a portal between the component W and its view W',
    met: false,
    tree: [
      {
        name: 'Pressable',
        props: { testID: W, onPress: handler },
        children: [
          {
            portal: true,
            children: [
              {
                hostType: 'RCTView',
                props: { testID: W, onClick: handler },
                children: [plainView([presetInput()])],
              },
            ],
          },
        ],
      },
    ],
  },
];
const wrapperNode = (ref: string, id: string, y: number) => ({
  ref,
  type: 'Other',
  identifier: id,
  label: '',
  hittable: true,
  rect: { x: 20, y, width: 300, height: 44 },
});

for (const shape of wrapperShapes) {
  test(`C2 U1 shape ${shape.name}: the ordinary capture ${shape.met ? 'proves' : 'does not prove'} the input beneath the wrapper view`, async () => {
    const wrapperID = shape.id ?? W;
    const react = await observe(shape.tree);
    const hosts = react.hostEvidence!.hosts;
    assert.equal(react.hostEvidence!.typography, undefined);
    assert.equal(react.hostEvidence!.complete, true);
    if (shape.met) {
      const entries = react.interactive!.filter((entry) => entry.testID === W);
      assert.equal(entries.length, 1, JSON.stringify(react.interactive));
      const viewHosts = hosts.flatMap((host, i) =>
        host.testID === W && !host.capabilities.fill ? [i] : [],
      );
      const inputHosts = hosts.flatMap((host, i) =>
        host.testID === X && host.capabilities.fill ? [i] : [],
      );
      assert.equal(viewHosts.length, 1);
      assert.equal(inputHosts.length, 1);
      assert.equal(entries[0].hostIndex, viewHosts[0], JSON.stringify(entries[0]));
      assert.deepEqual(entries[0].inputHostIndices, inputHosts);
    }
    const screen = join(
      [wrapperNode('@wrap', wrapperID, 100)],
      react.interactive!,
      'app',
      { native: 'complete', react: 'complete' },
      react.hostEvidence,
    );
    const wrap = screen.elements.find((element) => element.ref === '@wrap')!;
    assert.equal(fillHostInside(screen, X, wrap), shape.met, JSON.stringify(react.interactive));
  });
}

test('C2 U1: two native nodes carrying the wrapper id do not prove the input beneath either', async () => {
  const react = await observe(wrapperShapes[0].tree);
  const screen = join(
    [wrapperNode('@wrap', W, 100), wrapperNode('@twin', W, 300)],
    react.interactive!,
    'app',
    { native: 'complete', react: 'complete' },
    react.hostEvidence,
  );
  for (const ref of ['@wrap', '@twin'])
    assert.equal(fillHostInside(screen, X, screen.elements.find((e) => e.ref === ref)!), false);
});
