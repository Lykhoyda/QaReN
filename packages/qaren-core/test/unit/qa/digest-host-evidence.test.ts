import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { HELPERS_VERSION } from '../../../dist/injected-helpers.js';
import { buildFiber, createSandbox, INJECTED_HELPERS } from '../helpers/inject-harness.js';
import { PRIVATE_INPUT_LIMITS } from '../../../dist/qa/private-input-limits.js';
import { devFreeze } from './rn-dev-freeze.ts';

const { maxHosts } = PRIVATE_INPUT_LIMITS;

interface FiberSpec {
  name?: string;
  hostType?: string;
  props?: Record<string, unknown>;
  children?: FiberSpec[];
}

function readDigest(sandbox: vm.Context, semanticEvidence = true) {
  return JSON.parse(
    vm.runInContext(
      `__QAREN.getTree({ interactiveOnly: true, semanticEvidence: ${semanticEvidence} })`,
      sandbox,
    ),
  );
}

function digest(children: FiberSpec[]) {
  return readDigest(createSandbox({ fiberRoot: buildFiber({ name: 'Screen', children }) }));
}

const handler = () => assert.fail('capturing evidence must never invoke handlers');

test('opt-in host evidence includes a heading-only host without changing the legacy digest', () => {
  const sandbox = createSandbox({
    fiberRoot: buildFiber({
      hostType: 'RCTText',
      props: {
        testID: 'title',
        nativeID: 'native-title',
        role: 'heading',
        accessibilityLabel: 'Private heading',
        value: 'Private value',
      },
    }),
  });
  const legacy = readDigest(sandbox, false);
  const { hostEvidence, ...rest } = readDigest(sandbox);
  assert.deepEqual(rest, legacy);
  assert.equal(legacy.hostEvidence, undefined);
  assert.deepEqual(hostEvidence, {
    hosts: [
      {
        testID: 'title',
        nativeID: 'native-title',
        role: 'heading',
        roleSource: 'role',
        capabilities: {},
        order: 0,
      },
    ],
    complete: true,
  });
  assert.deepEqual(legacy.interactive, []);
});

test('only actual hosts contribute evidence, including unidentified and independent same-ID hosts', () => {
  const result = digest([
    { name: 'Heading', props: { testID: 'pretend', role: 'heading' } },
    { name: 'RCTText', props: { testID: 'also-pretend', accessibilityRole: 'header' } },
    { name: 'Pressable', props: { testID: 'missing-host', onPress: handler } },
    {
      name: 'Pressable',
      props: { testID: 'shared', onPress: handler },
      children: [
        {
          hostType: 'RCTView',
          props: { testID: 'shared', onPress: handler },
          children: [{ hostType: 'RCTText', props: { testID: 'shared', role: 'heading' } }],
        },
      ],
    },
    { hostType: 'RCTView', props: { nativeID: 'shared' } },
    { hostType: 'RCTView' },
  ]);
  assert.equal(result.hostEvidence.complete, true);
  // Host indices are breadth-first; order is the fiber (paint) order among each parent's host children.
  assert.deepEqual(result.hostEvidence.hosts, [
    { nativeID: 'shared', role: null, roleSource: 'none', capabilities: {}, order: 1 },
    { role: null, roleSource: 'none', capabilities: {}, order: 2 },
    { testID: 'shared', role: null, roleSource: 'none', capabilities: { press: true }, order: 0 },
    { testID: 'shared', role: 'heading', roleSource: 'role', capabilities: {}, order: 0 },
  ]);
});

test('capabilities are observed positives, never negative claims about opaque native behavior', () => {
  const result = digest([
    { hostType: 'RCTView', props: { onPress: handler } },
    { hostType: 'RCTView', props: { onClick: handler } },
    { hostType: 'RCTView', props: { onPress: true, onClick: '[Function]' } },
    { hostType: 'NativeOpaqueControl', props: { onChangeText: handler, onChange: handler } },
    { hostType: 'NativeOpaqueControl', props: { role: 'button' } },
    { hostType: 'AndroidTextInput' },
    { hostType: 'RCTSinglelineTextInputView', props: { editable: true } },
    { name: 'TextInput', props: { onChangeText: handler } },
  ]);
  assert.equal(result.hostEvidence.complete, true);
  assert.deepEqual(
    result.hostEvidence.hosts.map((host) => host.capabilities),
    [{ press: true }, { press: true }, {}, {}, {}, { fill: true }, { fill: true }],
  );
});

test('host disabled and read-only positives stay separate from forwarded parent digest state', () => {
  const result = digest([
    {
      name: 'Pressable',
      props: { testID: 'save', disabled: true, onPress: handler },
      children: [{ hostType: 'RCTView', props: { testID: 'save', onPress: handler } }],
    },
    { hostType: 'RCTView', props: { disabled: true, onPress: handler } },
    { hostType: 'RCTView', props: { accessibilityState: { disabled: true } } },
    { hostType: 'RCTView', props: { 'aria-disabled': true } },
    { hostType: 'AndroidTextInput', props: { editable: false, onChangeText: handler } },
    { hostType: 'AndroidTextInput', props: { readOnly: true } },
    { hostType: 'AndroidTextInput', props: { 'aria-readonly': true } },
    { hostType: 'AndroidTextInput', props: { disabled: true } },
  ]);
  assert.equal(result.interactive.find((entry) => entry.testID === 'save').disabled, true);
  assert.deepEqual(result.hostEvidence.hosts, [
    { role: null, roleSource: 'none', capabilities: { press: true }, disabled: true, order: 1 },
    { role: null, roleSource: 'none', capabilities: {}, disabled: true, order: 2 },
    { role: null, roleSource: 'none', capabilities: {}, disabled: true, order: 3 },
    { role: null, roleSource: 'none', capabilities: {}, readOnly: true, order: 4 },
    { role: null, roleSource: 'none', capabilities: {}, readOnly: true, order: 5 },
    { role: null, roleSource: 'none', capabilities: {}, readOnly: true, order: 6 },
    { role: null, roleSource: 'none', capabilities: { fill: true }, disabled: true, order: 7 },
    { testID: 'save', role: null, roleSource: 'none', capabilities: { press: true }, order: 0 },
  ]);
});

test('unsupported editability values do not establish a positive fill capability', () => {
  for (const props of [
    { editable: 'false' },
    { editable: 0 },
    { readOnly: 'true' },
    { 'aria-readonly': 'true' },
  ]) {
    assert.deepEqual(digest([{ hostType: 'AndroidTextInput', props }]).hostEvidence.hosts, [
      { role: null, roleSource: 'none', capabilities: {}, order: 0 },
    ]);
  }
});

test('explicit roles retain owner precedence, normalization and provenance without name inference', () => {
  const result = digest([
    { hostType: 'RCTView', props: { role: 'heading', accessibilityRole: 'button' } },
    { hostType: 'RCTView', props: { role: null, accessibilityRole: 'header' } },
    { hostType: 'RCTView', props: { accessibilityRole: 'image' } },
    { hostType: 'RCTView', props: { role: 'none', accessibilityRole: 'button' } },
    { hostType: 'RCTText' },
    { hostType: 'Button' },
    { hostType: 'TextInput' },
  ]);
  assert.equal(result.hostEvidence.complete, true);
  assert.deepEqual(
    result.hostEvidence.hosts.map(({ role, roleSource }) => ({ role, roleSource })),
    [
      { role: 'heading', roleSource: 'role' },
      { role: 'header', roleSource: 'accessibilityRole' },
      { role: 'img', roleSource: 'accessibilityRole' },
      { role: 'none', roleSource: 'role' },
      { role: null, roleSource: 'none' },
      { role: null, roleSource: 'none' },
      { role: null, roleSource: 'none' },
    ],
  );
});

test('unsupported selected roles are unknown and incomplete, never coerced or bypassed', () => {
  const unsupported = ['', false, 0, 7, [], ['heading'], {}, 'invented', 'Heading', 'toString'];
  for (const value of unsupported) {
    for (const props of [
      { role: value, accessibilityRole: 'button' },
      { accessibilityRole: value },
    ]) {
      const result = digest([{ hostType: 'RCTText', props: { testID: 'title', ...props } }]);
      assert.deepEqual(result.hostEvidence, {
        hosts: [
          {
            testID: 'title',
            role: null,
            roleSource: 'role' in props ? 'role' : 'accessibilityRole',
            capabilities: {},
            order: 0,
          },
        ],
        complete: false,
      });
    }
  }
});

test('unsupported identities keep their host observation and mark coverage incomplete', () => {
  for (const field of ['testID', 'nativeID']) {
    for (const value of [12, false, {}, ['save']]) {
      const result = digest([{ hostType: 'RCTView', props: { [field]: value, onPress: handler } }]);
      assert.deepEqual(result.hostEvidence, {
        hosts: [{ role: null, roleSource: 'none', capabilities: { press: true }, order: 0 }],
        complete: false,
      });
    }
  }
});

test('host tag identifies native object types but similarly named composites are not hosts', () => {
  const root = buildFiber({ name: 'RCTText', props: { role: 'heading', testID: 'title' } });
  Object.assign(root, { tag: 5 });
  assert.deepEqual(readDigest(createSandbox({ fiberRoot: root })).hostEvidence, {
    hosts: [{ testID: 'title', role: 'heading', roleSource: 'role', capabilities: {}, order: 0 }],
    complete: true,
  });
  Object.assign(root, { tag: 0 });
  assert.deepEqual(readDigest(createSandbox({ fiberRoot: root })).hostEvidence, {
    hosts: [],
    complete: true,
  });
});

test('host evidence saturates at the shared host cap and discloses incomplete coverage without changing the digest', () => {
  // 336 is the measured Home plus lazily mounted Tasks tab of the workspace test app.
  for (const count of [336, maxHosts - 1, maxHosts, maxHosts + 50]) {
    const sandbox = createSandbox({
      fiberRoot: buildFiber({
        name: 'Screen',
        children: Array.from({ length: count }, (_, i) => ({
          hostType: 'RCTText',
          props: { testID: `heading-${i}`, role: 'heading' },
        })),
      }),
    });
    const legacy = readDigest(sandbox, false);
    const { hostEvidence, ...rest } = readDigest(sandbox);
    assert.deepEqual(rest, legacy);
    assert.deepEqual(legacy.interactive, []);
    assert.equal(legacy.verdict.complete, true);
    assert.equal(hostEvidence.hosts.length, Math.min(count, maxHosts));
    assert.equal(hostEvidence.complete, count < maxHosts);
    if (count === 336) assert.equal(hostEvidence.complete, true);
  }
});

test('host evidence uses the same node budget and never finds hosts past the interactive scan', () => {
  const result = digest([
    ...Array.from({ length: 2000 }, () => ({ name: 'Wrapper' })),
    { hostType: 'RCTText', props: { testID: 'past-budget', role: 'heading' } },
  ]);
  assert.equal(result.totalNodes, 2000);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.hostEvidence, { hosts: [], complete: false });
});

test('the interactive entry cap also withholds host completeness and does not trigger another scan', () => {
  const result = digest([
    ...Array.from({ length: 200 }, () => ({ name: 'Pressable', props: { onPress: handler } })),
    { hostType: 'RCTText', props: { testID: 'past-cap', role: 'heading' } },
  ]);
  assert.equal(result.interactive.length, 200);
  assert.equal(result.totalNodes, 201);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.hostEvidence, { hosts: [], complete: false });
});

test('the interactive deadline also bounds host evidence', () => {
  const sandbox = createSandbox({ fiberRoot: buildFiber({ hostType: 'RCTText' }) });
  let reads = 0;
  Object.assign(sandbox, { Date: { now: () => (reads++ === 0 ? 0 : 3001) } });
  const result = readDigest(sandbox);
  assert.equal(result.totalNodes, 0);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.hostEvidence, { hosts: [], complete: false });
});

test('renderer enumeration failures retain observed hosts but withhold completeness', () => {
  const root = buildFiber({ hostType: 'RCTView', props: { testID: 'observed' } });
  for (const mode of ['throws', 'unregistered', 'invalid-registry', 'extra-roots']) {
    const sandbox = createSandbox();
    Object.assign(sandbox, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        renderers:
          mode === 'unregistered'
            ? undefined
            : mode === 'invalid-registry'
              ? {}
              : new Map([
                  [1, {}],
                  [29, {}],
                ]),
        getFiberRoots(id: number) {
          if (mode === 'throws' && id === 29) throw new Error('renderer teardown');
          return id === 1 ? new Set([{ current: root }]) : new Set();
        },
      },
      __QAREN_EXTRA_ROOTS__:
        mode === 'extra-roots'
          ? () => {
              throw new Error('unreadable');
            }
          : undefined,
    });
    const result = readDigest(sandbox);
    assert.deepEqual(
      result.hostEvidence,
      {
        hosts: [{ testID: 'observed', role: null, roleSource: 'none', capabilities: {}, order: 0 }],
        complete: false,
      },
      mode,
    );
  }
});

test('missing renderers and app error overlays return incomplete opt-in evidence only', () => {
  for (const sandbox of [
    createSandbox(),
    createSandbox({ fiberRoot: buildFiber({ name: 'LogBox' }) }),
  ]) {
    const legacy = readDigest(sandbox, false);
    const { hostEvidence, ...rest } = readDigest(sandbox);
    assert.deepEqual(rest, legacy);
    assert.deepEqual(hostEvidence, { hosts: [], complete: false });
  }
});

test('roots disappearing before the interactive scan cannot establish complete host evidence', () => {
  const root = buildFiber({ hostType: 'RCTView' });
  const sandbox = createSandbox();
  let reads = 0;
  Object.assign(sandbox, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map([[1, {}]]),
      getFiberRoots(id: number) {
        return new Set(id === 1 && reads++ === 0 ? [{ current: root }] : []);
      },
    },
  });
  assert.deepEqual(readDigest(sandbox).hostEvidence, { hosts: [], complete: false });
});

test('hosts across renderer roots are included once per actual fiber, not deduplicated by ID', () => {
  const a = buildFiber({ hostType: 'RCTText', props: { testID: 'shared', role: 'heading' } });
  const b = buildFiber({ hostType: 'RCTText', props: { testID: 'shared', role: 'heading' } });
  const sandbox = createSandbox();
  Object.assign(sandbox, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map([
        [1, {}],
        [29, {}],
      ]),
      getFiberRoots(id: number) {
        return new Set(
          id === 1 ? [{ current: a }] : id === 29 ? [{ current: a }, { current: b }] : [],
        );
      },
    },
  });
  assert.deepEqual(readDigest(sandbox).hostEvidence, {
    // Separate roots rank by root; the core leaves a hit across several roots unresolved.
    hosts: [
      { testID: 'shared', role: 'heading', roleSource: 'role', capabilities: {}, order: 0 },
      { testID: 'shared', role: 'heading', roleSource: 'role', capabilities: {}, order: 1 },
    ],
    complete: true,
  });
});

test('current helper replaces a warm version 77 producer and reinjection stays idempotent', () => {
  const sandbox = createSandbox({ fiberRoot: buildFiber({ hostType: 'RCTView' }) });
  Object.assign(sandbox, { __QAREN: { __v: 77 } });
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(vm.runInContext('__QAREN.__v', sandbox), HELPERS_VERSION);
  assert.equal(readDigest(sandbox).hostEvidence.complete, true);
  const producer = vm.runInContext('__QAREN.getTree', sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(vm.runInContext('__QAREN.getTree', sandbox), producer);
});

test('one control identity forwards through a single identity-less wrapper view', () => {
  const tab = (wrapperChildren: FiberSpec[]) =>
    digest([
      {
        name: 'TabItem',
        props: { testID: 'tab-home', onPress: handler },
        children: [{ hostType: 'RCTView', props: {}, children: wrapperChildren }],
      },
    ]).interactive;
  const pressable: FiberSpec = {
    name: 'Pressable',
    props: { testID: 'tab-home', onPress: handler },
    children: [{ hostType: 'RCTView', props: { testID: 'tab-home', onClick: handler } }],
  };
  assert.deepEqual(
    tab([pressable]).map((d: { testID?: string }) => d.testID),
    ['tab-home'],
  );
  assert.equal(
    tab([pressable, { hostType: 'RCTView', props: {} }]).length,
    2,
    'a wrapper with several children does not forward one identity',
  );
});

test('a nativeID is reported as a nativeID, never as a testID', () => {
  const [entry] = digest([
    { name: 'Pressable', props: { nativeID: '17', onPress: handler } },
  ]).interactive;
  assert.equal(entry.testID, undefined);
  assert.equal(entry.nativeID, '17');
});

test('an entry interactive only by role or component name is marked handlerless', () => {
  const entries = digest([
    { hostType: 'RCTView', props: { accessibilityRole: 'adjustable' } },
    { name: 'Pressable', props: {} },
    { name: 'Switch', props: { value: true, onValueChange: handler } },
    { name: 'Pressable', props: { onLongPress: handler } },
    { name: 'TextInput', props: {} },
  ]).interactive;
  assert.deepEqual(
    entries.map((d: { handlerless?: boolean }) => d.handlerless === true),
    [true, true, false, false, false],
  );
});

test('observations under an accessibility-hidden host view are marked hidden', () => {
  const pressable = (testID: string): FiberSpec => ({
    name: 'Pressable',
    props: { testID, onPress: handler },
    children: [{ hostType: 'RCTView', props: { testID, onClick: handler } }],
  });
  for (const hiding of [
    { 'aria-hidden': true },
    { accessibilityElementsHidden: true },
    { importantForAccessibility: 'no-hide-descendants' },
  ]) {
    const tree = digest([
      { hostType: 'RCTView', props: hiding, children: [pressable('home-btn')] },
      pressable('tasks-btn'),
    ]);
    assert.deepEqual(
      Object.fromEntries(
        tree.interactive.map((d: { testID?: string; hidden?: boolean }) => [
          d.testID,
          d.hidden === true,
        ]),
      ),
      { 'home-btn': true, 'tasks-btn': false },
    );
    const host = (testID: string) =>
      tree.hostEvidence.hosts.find((h: { testID?: string }) => h.testID === testID);
    assert.equal(host('home-btn').hidden, true);
    assert.equal(host('tasks-btn').hidden, undefined);
  }
});

test('hosts carry their pointerEvents and zIndex, prop before style and the last style entry first', () => {
  const result = digest([
    { hostType: 'RCTView', props: { pointerEvents: 'none', style: { pointerEvents: 'auto' } } },
    {
      hostType: 'RCTView',
      props: { style: [{ pointerEvents: 'box-only', zIndex: 1 }, { zIndex: 100 }] },
    },
    { hostType: 'RCTView', props: { style: [null, false, [{ pointerEvents: 'box-none' }]] } },
    { hostType: 'RCTView', props: { pointerEvents: 'auto', style: { zIndex: -1 } } },
    { hostType: 'RCTView' },
  ]);
  assert.equal(result.hostEvidence.complete, true);
  assert.deepEqual(
    result.hostEvidence.hosts.map(({ pointerEvents, zIndex, order }) => ({
      pointerEvents,
      zIndex,
      order,
    })),
    [
      { pointerEvents: 'none', zIndex: undefined, order: 0 },
      { pointerEvents: 'box-only', zIndex: 100, order: 1 },
      { pointerEvents: 'box-none', zIndex: undefined, order: 2 },
      { pointerEvents: 'auto', zIndex: -1, order: 3 },
      { pointerEvents: undefined, zIndex: undefined, order: 4 },
    ],
  );
});

test('a host drawn before a shallower sibling ranks first, whatever its breadth-first index', () => {
  const result = digest([
    {
      name: 'Card',
      children: [{ name: 'Inner', children: [{ hostType: 'RCTView', props: { testID: 'deep' } }] }],
    },
    { hostType: 'RCTView', props: { testID: 'overlay' } },
  ]);
  assert.deepEqual(
    result.hostEvidence.hosts.map(({ testID, order }) => ({ testID, order })),
    [
      { testID: 'overlay', order: 1 },
      { testID: 'deep', order: 0 },
    ],
  );
});

test('an unknown pointerEvents reads as auto; an unreadable zIndex leaves only that host unordered', () => {
  const sometimes = digest([
    { hostType: 'RCTView', props: { testID: 'odd', pointerEvents: 'sometimes' } },
    { hostType: 'RCTView', props: { testID: 'plain' } },
  ]);
  assert.deepEqual(
    sometimes.hostEvidence.hosts.map(({ pointerEvents, order }) => ({ pointerEvents, order })),
    [
      { pointerEvents: undefined, order: 0 },
      { pointerEvents: undefined, order: 1 },
    ],
  );
  for (const props of [
    { style: 7 },
    { style: { zIndex: '2' } },
    { style: { zIndex: Number.NaN } },
  ]) {
    const result = digest([
      { hostType: 'RCTView', props: { testID: 'opaque', ...props } },
      { hostType: 'RCTView', props: { testID: 'plain' } },
    ]);
    assert.equal(result.hostEvidence.complete, true, JSON.stringify(props));
    assert.deepEqual(
      result.hostEvidence.hosts.map(({ testID, pointerEvents, zIndex, order }) => ({
        testID,
        pointerEvents,
        zIndex,
        order,
      })),
      [
        { testID: 'opaque', pointerEvents: undefined, zIndex: undefined, order: undefined },
        { testID: 'plain', pointerEvents: undefined, zIndex: undefined, order: 1 },
      ],
      JSON.stringify(props),
    );
  }
});

test("a dev renderer's frozen props still yield touch facts and an order for every host", () => {
  // RN dev renderers deep-freeze host prop values into bound identity accessors; a strict read refuses them.
  const result = digest([
    {
      hostType: 'RCTView',
      props: devFreeze({
        testID: 'counters',
        style: devFreeze([devFreeze({ position: 'absolute' }), devFreeze({ zIndex: 100 })]),
        pointerEvents: 'none',
      }),
    },
    {
      hostType: 'RCTView',
      props: devFreeze({ style: devFreeze({ pointerEvents: 'box-none', zIndex: 2 }) }),
    },
    { hostType: 'RCTView', props: devFreeze({ testID: 'plain', style: devFreeze({ flex: 1 }) }) },
  ]);
  assert.equal(result.hostEvidence.complete, true);
  assert.deepEqual(
    result.hostEvidence.hosts.map(({ pointerEvents, zIndex, order }) => ({
      pointerEvents,
      zIndex,
      order,
    })),
    [
      { pointerEvents: 'none', zIndex: 100, order: 0 },
      { pointerEvents: 'box-none', zIndex: 2, order: 1 },
      { pointerEvents: undefined, zIndex: undefined, order: 2 },
    ],
  );
});
