import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { PrivateInputCaptureError } from '../../../dist/qa/private-input.js';
import { join, semanticActionView, visibilityView } from '../../../dist/qa/screen.js';
import { prepareTarget } from '../../../dist/qa/resolve.js';
import { exactIdentities } from '../../../dist/qa/identity.js';
import { nativeCapture } from './platform-presence-fixtures.ts';

interface FiberSpec {
  name?: string;
  hostType?: string;
  props?: Record<string, unknown>;
  children?: FiberSpec[];
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

async function observe(children: FiberSpec[]) {
  const root = { current: buildFiber({ name: 'Screen', children }) };
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
  const capped = Array.from({ length: 200 }, () => wrapper());
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
