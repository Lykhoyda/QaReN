// GH#525 finding 2: pressing a testID that sits on a non-pressable wrapper
// (handler on an ancestor Pressable) failed with "Component has no onPress
// handler", forcing a snapshot + coordinate-tap detour. Opt-in walkUp:true
// searches a bounded number of fiber ancestors (8) for the nearest onPress;
// default behavior (flag absent) stays byte-for-byte identical, and the walk
// itself refuses when no pressable ancestor exists within the bound. testID
// resolution semantics (strict first match) are shared with direct press and
// deliberately unchanged — the walk itself is deterministic (nearest wins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { createInteractHandler } from '../../dist/handlers/interact.js';

interface FiberSpec {
  name?: string;
  // host:true builds a host fiber, whose `type` is a plain string (e.g. 'RCTView').
  host?: boolean;
  props?: Record<string, unknown>;
  children?: FiberSpec[];
}

interface SandboxFiber {
  tag: number;
  type: { displayName: string } | string | null;
  memoizedProps: Record<string, unknown>;
  return: SandboxFiber | null;
  child: SandboxFiber | null;
  sibling: SandboxFiber | null;
  alternate: SandboxFiber | null;
  stateNode: null;
}

function createSandbox(opts: { fiberRoot?: SandboxFiber; repeatRoot?: boolean } = {}) {
  const sandbox: Record<string, unknown> = {
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Error,
    Date,
    parseInt,
    parseFloat,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    String,
    Number,
    Boolean,
    RegExp,
    Symbol,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  if (opts.fiberRoot) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: (id: number) =>
        id === 1
          ? new Set(
              opts.repeatRoot
                ? [{ current: opts.fiberRoot }, { current: opts.fiberRoot }]
                : [{ current: opts.fiberRoot }],
            )
          : new Set(),
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox as Record<string, any>;
}

function buildFiber(spec: FiberSpec, parent: SandboxFiber | null = null): SandboxFiber {
  const fiber: SandboxFiber = {
    tag: spec.host ? 5 : 0,
    type: spec.name ? (spec.host ? spec.name : { displayName: spec.name }) : null,
    memoizedProps: spec.props || {},
    return: parent,
    child: null,
    sibling: null,
    alternate: null,
    stateNode: null,
  };
  if (spec.children && spec.children.length > 0) {
    let prev: SandboxFiber | null = null;
    for (const c of spec.children) {
      const child = buildFiber(c, fiber);
      if (!fiber.child) fiber.child = child;
      else if (prev) prev.sibling = child;
      prev = child;
    }
  }
  return fiber;
}

// Pressable > CardWrapper > View[testID] — handler 2 fiber levels above the match.
function cardTree(onPress: (...args: unknown[]) => void): SandboxFiber {
  return buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { onPress },
        children: [
          {
            name: 'CardWrapper',
            children: [{ name: 'View', props: { testID: 'externalCoverageCard_1' } }],
          },
        ],
      },
    ],
  });
}

test('#525 default (no walkUp): the refusal payload is byte-for-byte unchanged and nothing fires', () => {
  let fired = 0;
  const sandbox = createSandbox({ fiberRoot: cardTree(() => fired++) });
  const raw = sandbox.__QAREN.interact({ action: 'press', testID: 'externalCoverageCard_1' });
  assert.equal(
    raw,
    '{"error":"Component has no onPress handler","component":"View","testID":"externalCoverageCard_1"}',
  );
  assert.equal(fired, 0);
});

function forwardedPressTree() {
  const calls = { wrapper: 0, navigation: 0 };
  const navigate = () => calls.navigation++;
  const handlePress = () => {
    calls.wrapper++;
    navigate();
  };
  const root = buildFiber({
    name: 'BottomTabItem',
    props: { testID: 'tab-home', onPress: navigate },
    children: [
      {
        name: 'RCTView',
        host: true,
        children: [
          {
            name: 'Animated(Pressable)',
            props: { testID: 'tab-home', onPress: handlePress },
            children: [
              {
                name: 'Pressable',
                props: { testID: 'tab-home', onPress: handlePress },
                children: [
                  {
                    name: 'View',
                    props: { testID: 'tab-home' },
                    children: [
                      {
                        name: 'RCTView',
                        host: true,
                        props: {
                          testID: 'tab-home',
                          accessible: true,
                          accessibilityRole: 'button',
                          onResponderGrant: () => {},
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const outerHost = root.child;
  const animated = outerHost?.child;
  const pressable = animated?.child;
  const view = pressable?.child;
  const host = view?.child;
  assert.ok(outerHost && animated && pressable && view && host);
  return { root, outerHost, animated, pressable, view, host, calls };
}

test('#951 a single host witnesses distinct forwarding callbacks and dispatches the nearest once', () => {
  const fixture = forwardedPressTree();
  const sandbox = createSandbox({ fiberRoot: fixture.root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({
      action: 'press',
      testID: 'tab-home',
      walkUp: true,
    }),
  );
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.component, 'Pressable');
  assert.equal(result.walkUpLevels, 2);
  assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
});

function pressFixture(fixture: ReturnType<typeof forwardedPressTree>, repeatRoot = false) {
  return JSON.parse(
    createSandbox({ fiberRoot: fixture.root, repeatRoot }).__QAREN.interact({
      action: 'press',
      testID: 'tab-home',
      walkUp: true,
    }),
  );
}

function assertTabAmbiguity(result: Record<string, unknown>, innerName = 'Animated(Pressable)') {
  assert.deepEqual(result, {
    error: 'Ambiguous walkUp press target',
    testID: 'tab-home',
    count: 2,
    candidates: [
      { component: 'BottomTabItem', testID: 'tab-home' },
      { component: innerName, testID: 'tab-home' },
    ],
    hint: 'Multiple distinct pressable fibers resolve from this testID. Pass the testID of the exact pressable component instead.',
  });
}

test('#951 a bailout boundary inside the forwarding chain still resolves the host', () => {
  const fixture = forwardedPressTree();
  const animatedOld: SandboxFiber = { ...fixture.animated, alternate: fixture.animated };
  fixture.animated.alternate = animatedOld;
  fixture.pressable.return = animatedOld;
  const result = pressFixture(fixture);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.component, 'Pressable');
  assert.equal(result.walkUpLevels, 2);
  assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
});

test('#951 repeated observations of the same mounted host still dispatch once', () => {
  const fixture = forwardedPressTree();
  assert.equal(pressFixture(fixture, true).success, true);
  assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
});

test('#951 the witness uses fiber and native host facts independently of composite names', () => {
  const fixture = forwardedPressTree();
  for (const fiber of [fixture.root, fixture.animated, fixture.pressable, fixture.view])
    fiber.type = null;
  fixture.host.memoizedProps.onPress = fixture.pressable.memoizedProps.onPress;
  const result = pressFixture(fixture);
  assert.equal(result.success, true);
  assert.equal(result.component, 'RCTView');
  assert.equal(result.walkUpLevels, undefined);
  assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
});

test('#951 existing same-callback forwarding through an inert host keeps its original target', () => {
  const fixture = forwardedPressTree();
  fixture.root.memoizedProps.onPress = fixture.animated.memoizedProps.onPress;
  fixture.outerHost.memoizedProps.testID = 'tab-home';
  const result = pressFixture(fixture);
  assert.equal(result.success, true);
  assert.equal(result.component, 'BottomTabItem');
  assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
});

test('#951 the single-host witness selects only within the existing eight-hop bound', async (t) => {
  for (const hops of [8, 9]) {
    await t.test(`${hops} hops`, () => {
      const fixture = forwardedPressTree();
      let parent = fixture.view;
      for (let index = 0; index < hops - 2; index++) {
        const wrapper = buildFiber({ name: 'Wrapper' }, parent);
        parent.child = wrapper;
        parent = wrapper;
      }
      parent.child = fixture.host;
      fixture.host.return = parent;
      const result = pressFixture(fixture);
      if (hops === 8) {
        assert.equal(result.success, true);
        assert.equal(result.walkUpLevels, 8);
        assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
      } else {
        assertTabAmbiguity(result);
        assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
      }
    });
  }
});

test('#951 distinct callbacks cannot collapse separate nested host controls', async (t) => {
  for (const outerHasId of [false, true]) {
    await t.test(`outer host ID=${outerHasId}`, () => {
      const fixture = forwardedPressTree();
      fixture.outerHost.memoizedProps.onResponderGrant = () => {};
      fixture.outerHost.memoizedProps.accessible = true;
      if (outerHasId) fixture.outerHost.memoizedProps.testID = 'tab-home';
      assertTabAmbiguity(pressFixture(fixture));
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
});

test('#951 one callback shared across nested hosts keeps collapsing to a single dispatch', async (t) => {
  for (const outerHasId of [false, true]) {
    await t.test(`outer host ID=${outerHasId}`, () => {
      const fixture = forwardedPressTree();
      fixture.outerHost.memoizedProps.onResponderGrant = () => {};
      fixture.outerHost.memoizedProps.accessible = true;
      if (outerHasId) fixture.outerHost.memoizedProps.testID = 'tab-home';
      fixture.root.memoizedProps.onPress = fixture.animated.memoizedProps.onPress;
      const result = pressFixture(fixture);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.component, 'BottomTabItem');
      assert.equal(result.walkUpLevels, undefined);
      assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
    });
  }
});

test('#951 siblings remain ambiguous with distinct or shared callbacks and host IDs', async (t) => {
  for (const shared of [false, true]) {
    await t.test(`shared=${shared}`, () => {
      const fixture = forwardedPressTree();
      const sibling = buildFiber({
        name: 'OtherButton',
        props: {
          testID: 'tab-home',
          onPress: shared
            ? fixture.animated.memoizedProps.onPress
            : () => fixture.calls.navigation++,
        },
        children: [{ name: 'RCTView', host: true, props: { testID: 'tab-home' } }],
      });
      fixture.root.sibling = sibling;
      const result = pressFixture(fixture);
      assert.equal(result.count, 3);
      assert.deepEqual(result.candidates, [
        { component: 'BottomTabItem', testID: 'tab-home' },
        { component: 'Animated(Pressable)', testID: 'tab-home' },
        { component: 'OtherButton', testID: 'tab-home' },
      ]);
      assert.equal(
        result.hint,
        'Multiple distinct pressable fibers resolve from this testID. Pass the testID of the exact pressable component instead.',
      );
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
});

test('#951 unproven host semantics and incomplete ancestry preserve ambiguity metadata', async (t) => {
  const cases: Record<string, (fixture: ReturnType<typeof forwardedPressTree>) => void> = {
    'hostless distinct callbacks': (f) => {
      f.host.tag = 0;
    },
    'unknown native host': (f) => {
      f.outerHost.type = 'CustomNativeControl';
    },
    'click handler': (f) => {
      f.outerHost.memoizedProps.onClick = () => {};
    },
    'touch handler': (f) => {
      f.outerHost.memoizedProps.onTouchStart = () => {};
    },
    'responder negotiation': (f) => {
      f.outerHost.memoizedProps.onStartShouldSetResponder = () => true;
    },
    'scroll responder negotiation': (f) => {
      f.outerHost.memoizedProps.onScrollShouldSetResponder = () => true;
    },
    'accessible host': (f) => {
      f.outerHost.memoizedProps.accessible = true;
    },
    'focusable host': (f) => {
      f.outerHost.memoizedProps.focusable = true;
    },
    'host control role': (f) => {
      f.outerHost.memoizedProps.accessibilityRole = 'button';
    },
    'return cycle': (f) => {
      f.root.return = f.host;
    },
    'broken return': (f) => {
      f.host.return = null;
    },
    'cyclic mounted traversal': (f) => {
      f.host.child = f.animated;
    },
    'off-line exact-ID source': (f) => {
      f.animated.sibling = buildFiber(
        { name: 'OffLine', props: { testID: 'tab-home' } },
        f.outerHost,
      );
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    await t.test(label, () => {
      const fixture = forwardedPressTree();
      mutate(fixture);
      assertTabAmbiguity(pressFixture(fixture), label === 'return cycle' ? 'Pressable' : undefined);
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
});

test('#951 incomplete match collection refuses without dispatching the witnessed host', () => {
  const fixture = forwardedPressTree();
  let tail = fixture.root;
  for (let index = 0; index < 8000; index++) {
    tail.sibling = buildFiber({ name: 'Unrelated' });
    tail = tail.sibling;
  }
  const result = pressFixture(fixture);
  assert.deepEqual(result, {
    error: 'Resolution truncated',
    truncated: true,
    scanned: 8001,
    hint: 'increase budget or scope with a container/anchor',
  });
  assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
});

test('#951 an ancestor candidate with a different testID cannot join the witness', () => {
  const fixture = forwardedPressTree();
  fixture.root.memoizedProps.testID = 'outer-control';
  const source = buildFiber({ name: 'Wrapper', props: { testID: 'tab-home' } }, fixture.root);
  fixture.root.child = source;
  source.child = fixture.outerHost;
  fixture.outerHost.return = source;
  const result = pressFixture(fixture);
  assert.equal(result.count, 2);
  assert.deepEqual(result.candidates, [
    { component: 'BottomTabItem', testID: 'outer-control' },
    { component: 'Animated(Pressable)', testID: 'tab-home' },
  ]);
  assert.equal(
    result.hint,
    'Multiple distinct pressable fibers resolve from this testID. Pass the testID of the exact pressable component instead.',
  );
  assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
});

test('#951 a throwing nearest forwarding handler reports execution without calling navigation', () => {
  const fixture = forwardedPressTree();
  const throwOnPress = () => {
    fixture.calls.wrapper++;
    throw new Error('forwarding failure');
  };
  fixture.animated.memoizedProps.onPress = throwOnPress;
  fixture.pressable.memoizedProps.onPress = throwOnPress;
  const result = pressFixture(fixture);
  assert.equal(result.success, false);
  assert.equal(result.action_executed, true);
  assert.equal(result.component, 'Pressable');
  assert.equal(result.handler_error, 'forwarding failure');
  assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 0 });
});

test('#951 eligible sources are never selected by filtering away disabled or hidden duplicates', async (t) => {
  for (const target of ['root', 'host', 'pressable'] as const) {
    await t.test(`disabled ${target}`, () => {
      const fixture = forwardedPressTree();
      fixture[target].memoizedProps.disabled = true;
      const result = pressFixture(fixture);
      assert.equal(result.error, 'Component is disabled');
      assert.equal(
        result.reason,
        target === 'pressable' ? 'disabled walk target' : 'disabled exact-ID fiber',
      );
      assert.equal(result.testID, 'tab-home');
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
  for (const props of [
    { disabled: true },
    { style: { display: 'none' } },
    { pointerEvents: 'none' },
  ]) {
    await t.test(`ambiguous ${JSON.stringify(props)}`, () => {
      const fixture = forwardedPressTree();
      Object.assign(fixture.host.memoizedProps, props);
      fixture.outerHost.memoizedProps.onResponderGrant = () => {};
      assertTabAmbiguity(pressFixture(fixture));
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
});

test('#525 default (no walkUp): direct press response stays byte-for-byte unchanged', () => {
  let fired = 0;
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Button', props: { testID: 'plain-btn', onPress: () => fired++ } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const raw = sandbox.__QAREN.interact({ action: 'press', testID: 'plain-btn' });
  assert.equal(raw, '{"success":true,"action":"press","component":"Button","testID":"plain-btn"}');
  assert.equal(fired, 1);
});

test('#525 default (no walkUp): duplicate testIDs keep strict first-match semantics', () => {
  let first = 0;
  let second = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      { name: 'Button', props: { testID: 'dup-plain', onPress: () => first++ } },
      { name: 'Button', props: { testID: 'dup-plain', onPress: () => second++ } },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const raw = sandbox.__QAREN.interact({ action: 'press', testID: 'dup-plain' });
  assert.equal(raw, '{"success":true,"action":"press","component":"Button","testID":"dup-plain"}');
  assert.equal(first, 1);
  assert.equal(second, 0);
});

test('#525 walkUp:true presses the nearest pressable ancestor and reports the walk', () => {
  let fired = 0;
  const sandbox = createSandbox({ fiberRoot: cardTree(() => fired++) });
  const result = JSON.parse(
    sandbox.__QAREN.interact({
      action: 'press',
      testID: 'externalCoverageCard_1',
      walkUp: true,
    }),
  );
  assert.equal(result.success, true);
  assert.equal(fired, 1);
  assert.equal(result.component, 'Pressable');
  assert.equal(result.walkedUpFrom, 'View');
  assert.equal(result.walkUpLevels, 2);
});

function wrapperChain(levels: number, testID: string, onPress: () => void): SandboxFiber {
  // Pressable > L1 > … > L<levels-1> > View[testID] — handler `levels` fiber
  // hops above the match. Live NativeWind evidence (GH #525 proof run): one
  // JSX wrapper costs ~3 fibers (CssInterop.View > View > RCTView), so the
  // bound is 8 — two wrapped JSX levels.
  let spec: FiberSpec = { name: 'View', props: { testID } };
  for (let i = levels - 1; i >= 1; i--) spec = { name: `L${i}`, children: [spec] };
  return buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { onPress }, children: [spec] }],
  });
}

test('#525 walkUp:true succeeds at exactly the 8-level bound (inclusive)', () => {
  let fired = 0;
  const sandbox = createSandbox({ fiberRoot: wrapperChain(8, 'card8', () => fired++) });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'card8', walkUp: true }),
  );
  assert.equal(result.success, true);
  assert.equal(fired, 1);
  assert.equal(result.walkUpLevels, 8);
});

test('#525 walkUp:true still refuses when the pressable sits beyond the 8-level bound', () => {
  let fired = 0;
  const sandbox = createSandbox({ fiberRoot: wrapperChain(9, 'deep-card', () => fired++) });
  const raw = sandbox.__QAREN.interact({ action: 'press', testID: 'deep-card', walkUp: true });
  assert.equal(
    raw,
    '{"error":"Component has no onPress handler","component":"View","testID":"deep-card","walkUpSearched":8}',
  );
  assert.equal(fired, 0);
});

test('#525 walkUp:true refuses when no ancestor has onPress at all', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Wrapper', children: [{ name: 'View', props: { testID: 'inert' } }] }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const raw = sandbox.__QAREN.interact({ action: 'press', testID: 'inert', walkUp: true });
  assert.equal(
    raw,
    '{"error":"Component has no onPress handler","component":"View","testID":"inert","walkUpSearched":8}',
  );
});

test('#525 walkUp:true with a directly pressable target presses it without walking', () => {
  let direct = 0;
  let ancestor = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Outer',
        props: { onPress: () => ancestor++ },
        children: [{ name: 'Button', props: { testID: 'direct-btn', onPress: () => direct++ } }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'direct-btn', walkUp: true }),
  );
  assert.equal(result.success, true);
  assert.equal(direct, 1);
  assert.equal(ancestor, 0);
  assert.equal(result.walkedUpFrom, undefined);
});

test('#525 duplicate testIDs resolving to DISTINCT pressables: walkUp refuses and fires nothing', () => {
  let first = 0;
  let second = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { onPress: () => first++ },
        children: [{ name: 'Wrap', children: [{ name: 'View', props: { testID: 'dup' } }] }],
      },
      {
        name: 'Pressable',
        props: { onPress: () => second++ },
        children: [{ name: 'Wrap', children: [{ name: 'View', props: { testID: 'dup' } }] }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'dup', walkUp: true }),
  );
  assert.ok(result.error, 'ambiguous walk targets must refuse');
  assert.match(result.error, /[Aa]mbiguous/);
  assert.equal(first, 0);
  assert.equal(second, 0);
});

test('#525 distinct sibling pressables sharing the SAME onPress function still refuse as ambiguous', () => {
  // Function identity is not target identity: two separate Pressables reusing
  // one callback are still two controls, so the walk must refuse.
  let fired = 0;
  const shared = () => fired++;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { onPress: shared },
        children: [{ name: 'Wrap', children: [{ name: 'View', props: { testID: 'dup-fn' } }] }],
      },
      {
        name: 'Pressable',
        props: { onPress: shared },
        children: [{ name: 'Wrap', children: [{ name: 'View', props: { testID: 'dup-fn' } }] }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'dup-fn', walkUp: true }),
  );
  assert.ok(result.error, 'distinct pressables must refuse even with one shared callback');
  assert.match(result.error, /[Aa]mbiguous/);
  assert.equal(fired, 0);
});

test('#525 duplicate matches sharing ONE handler (composite + host forwarding) collapse and press once', () => {
  // A composite component and its host child often both carry the forwarded
  // testID. They resolve to the same onPress, so the walk stays unambiguous.
  let fired = 0;
  const onPress = () => fired++;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { onPress },
        children: [
          {
            name: 'Card',
            props: { testID: 'shared' },
            children: [{ name: 'View', props: { testID: 'shared' } }],
          },
        ],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'shared', walkUp: true }),
  );
  assert.equal(result.success, true);
  assert.equal(fired, 1);
});

test('#525 nested distinct pressables both matching the testID refuse as ambiguous', () => {
  // Candidates collapse only when they resolve to the exact same pressable
  // fiber. A Card and its nested Pressable are two pressable targets even on
  // one ancestor chain — refuse and let the caller pass the inner testID.
  let outer = 0;
  let inner = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Card',
        props: { testID: 'fwd', onPress: () => outer++ },
        children: [{ name: 'Pressable', props: { testID: 'fwd', onPress: () => inner++ } }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'fwd', walkUp: true }),
  );
  assert.ok(result.error, 'distinct pressable fibers on one chain must refuse');
  assert.match(result.error, /[Aa]mbiguous/);
  assert.equal(inner, 0);
  assert.equal(outer, 0);
});

function threadAlternate(fiber: SandboxFiber): SandboxFiber {
  const old: SandboxFiber = { ...fiber, alternate: fiber };
  fiber.alternate = old;
  return old;
}

// One sheet close control: four components forward one testID and one handler
// through a native glass host that is not an inert RCTView.
function sheetCloseTree(opts: { distinctInner?: boolean; alternates?: boolean } = {}) {
  const calls = { close: 0, inner: 0 };
  const onClose = () => calls.close++;
  const forwarded = { testID: 'sheet-close', onPress: onClose };
  const root = buildFiber({
    name: 'Sheet',
    children: [
      {
        name: 'SheetHeader',
        props: forwarded,
        children: [
          {
            name: 'RCTView',
            host: true,
            children: [
              {
                name: 'ClosePill',
                props: forwarded,
                children: [
                  {
                    name: 'IconButton',
                    props: forwarded,
                    children: [
                      {
                        name: 'AnimatedComponent',
                        children: [
                          {
                            name: 'GlassView',
                            host: true,
                            children: [
                              {
                                name: 'Pressable',
                                props: {
                                  testID: 'sheet-close',
                                  onPress: opts.distinctInner ? () => calls.inner++ : onClose,
                                },
                                children: [
                                  {
                                    name: 'RCTView',
                                    host: true,
                                    props: {
                                      testID: 'sheet-close',
                                      accessible: true,
                                      accessibilityRole: 'button',
                                      onResponderGrant: () => {},
                                    },
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const header = root.child!;
  const headerHost = header.child!;
  const pill = headerHost.child!;
  const icon = pill.child!;
  const animated = icon.child!;
  if (opts.alternates) {
    headerHost.return = threadAlternate(header);
    const iconOld = threadAlternate(icon);
    iconOld.return = threadAlternate(pill);
    animated.return = iconOld;
  }
  return { root, calls };
}

function pressSheetClose(root: SandboxFiber) {
  return JSON.parse(
    createSandbox({ fiberRoot: root }).__QAREN.interact({
      action: 'press',
      testID: 'sheet-close',
      walkUp: true,
    }),
  );
}

test('#525 one shared handler forwarded through a glass host and alternate returns presses once', async (t) => {
  for (const alternates of [false, true]) {
    await t.test(`alternates=${alternates}`, () => {
      const fixture = sheetCloseTree({ alternates });
      const result = pressSheetClose(fixture.root);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.component, 'SheetHeader');
      assert.deepEqual(fixture.calls, { close: 1, inner: 0 });
    });
  }
});

test('#525 a distinct inner handler under the glass host stays ambiguous with or without alternates', async (t) => {
  for (const alternates of [false, true]) {
    await t.test(`alternates=${alternates}`, () => {
      const fixture = sheetCloseTree({ distinctInner: true, alternates });
      const result = pressSheetClose(fixture.root);
      assert.equal(result.error, 'Ambiguous walkUp press target', JSON.stringify(result));
      assert.deepEqual(result.candidates, [
        { component: 'SheetHeader', testID: 'sheet-close' },
        { component: 'Pressable', testID: 'sheet-close' },
      ]);
      assert.deepEqual(fixture.calls, { close: 0, inner: 0 });
    });
  }
});

test('#525 one pressable reached through both halves of its alternate pair presses once', () => {
  let fired = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { testID: 'pair', onPress: () => fired++ },
        children: [
          {
            name: 'GlassView',
            host: true,
            children: [
              {
                name: 'RCTView',
                host: true,
                props: { testID: 'pair', accessible: true, onResponderGrant: () => {} },
              },
            ],
          },
        ],
      },
    ],
  });
  const pressable = root.child!;
  pressable.child!.return = threadAlternate(pressable);
  const result = JSON.parse(
    createSandbox({ fiberRoot: root }).__QAREN.interact({
      action: 'press',
      testID: 'pair',
      walkUp: true,
    }),
  );
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.component, 'Pressable');
  assert.equal(fired, 1);
});

test('#525 walkUp press passes an explicit value to the ancestor handler (GH#336 parity)', () => {
  const seen: unknown[] = [];
  const sandbox = createSandbox({ fiberRoot: cardTree((v) => seen.push(v)) });
  const result = JSON.parse(
    sandbox.__QAREN.interact({
      action: 'press',
      testID: 'externalCoverageCard_1',
      walkUp: true,
      value: 'card-1',
    }),
  );
  assert.equal(result.success, true);
  assert.deepEqual(seen, ['card-1']);
});

test('#525 a throwing walked-up handler keeps the GH#250 action_executed contract', () => {
  const sandbox = createSandbox({
    fiberRoot: cardTree(() => {
      throw new Error('boom from ancestor');
    }),
  });
  const result = JSON.parse(
    sandbox.__QAREN.interact({
      action: 'press',
      testID: 'externalCoverageCard_1',
      walkUp: true,
    }),
  );
  assert.equal(result.success, false);
  assert.equal(result.action_executed, true);
  assert.match(result.handler_error, /boom from ancestor/);
});

test('#525 a throwing walked-up handler names the fiber that actually ran', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'RCTView',
        host: true,
        props: {
          onPress: () => {
            throw new Error('boom from host ancestor');
          },
        },
        children: [
          {
            name: 'CardWrapper',
            children: [{ name: 'RCTTextView', host: true, props: { testID: 'throwing-host' } }],
          },
        ],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'throwing-host', walkUp: true }),
  );
  assert.equal(result.action_executed, true);
  assert.match(result.handler_error, /boom from host ancestor/);
  assert.equal(result.component, 'RCTView');
});

test('#525 a throwing direct press still names the matched component (default unchanged)', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Button',
        props: {
          testID: 'throwing-direct',
          onPress: () => {
            throw new Error('boom direct');
          },
        },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'throwing-direct' }),
  );
  assert.equal(result.action_executed, true);
  assert.equal(result.component, 'Button');
});

test('#525 walkUp is press-only: other actions refuse it explicitly and never dispatch', () => {
  let typed = 0;
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Input', props: { testID: 'field', onChangeText: () => typed++ } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'typeText', testID: 'field', text: 'x', walkUp: true }),
  );
  assert.ok(result.error, 'walkUp with a non-press action must refuse');
  assert.match(result.error, /walkUp/);
  assert.equal(typed, 0);
});

test('#525 walkUp refuses on ladder selectors instead of silently dropping the flag', () => {
  let fired = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'RCTView',
        host: true,
        props: { onPress: () => fired++ },
        children: [{ name: 'RCTText', host: true, props: { children: 'Card' } }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', text: 'Card', walkUp: true }),
  );
  assert.match(result.error, /walkUp/);
  assert.equal(fired, 0, 'a refused walkUp must fire nothing');
});

test('#525 tool layer forwards walkUp to the helper call', async () => {
  let evaluated = '';
  const client = createMockClient({
    evaluate: async (expr: string) => {
      evaluated = expr;
      return { value: JSON.stringify({ success: true, action: 'press' }) };
    },
  });
  const handler = createInteractHandler(() => client);
  await handler({ action: 'press', testID: 'card', walkUp: true, animated: true });
  const opts = JSON.parse(evaluated.replace(/^__QAREN\.interact\(/, '').replace(/\)$/, ''));
  assert.equal(opts.walkUp, true);
});

test('#525 walkUp reports real host-fiber names (string fiber type) instead of Unknown', () => {
  let fired = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'RCTView',
        host: true,
        props: { onPress: () => fired++ },
        children: [
          {
            name: 'CardWrapper',
            children: [{ name: 'RCTTextView', host: true, props: { testID: 'host-card' } }],
          },
        ],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'host-card', walkUp: true }),
  );
  assert.equal(result.success, true);
  assert.equal(fired, 1);
  assert.equal(result.component, 'RCTView');
  assert.equal(result.walkedUpFrom, 'RCTTextView');
});

test('#525 walkUp refusal names the host fiber it started from', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Wrapper',
        children: [{ name: 'RCTView', host: true, props: { testID: 'inert-host' } }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'inert-host', walkUp: true }),
  );
  assert.equal(result.component, 'RCTView');
  assert.equal(result.walkUpSearched, 8);
});

test('#525 ambiguous walkUp candidates list real host-fiber names', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'RCTView',
        host: true,
        props: { onPress: () => {}, testID: 'outer-host' },
        children: [
          {
            name: 'Wrap',
            children: [{ name: 'RCTText', host: true, props: { testID: 'dup-host' } }],
          },
        ],
      },
      {
        name: 'RCTScrollView',
        host: true,
        props: { onPress: () => {}, testID: 'other-host' },
        children: [
          {
            name: 'Wrap',
            children: [{ name: 'RCTText', host: true, props: { testID: 'dup-host' } }],
          },
        ],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', testID: 'dup-host', walkUp: true }),
  );
  assert.match(result.error, /[Aa]mbiguous/);
  assert.deepEqual(
    result.candidates.map((c: { component: string }) => c.component),
    ['RCTView', 'RCTScrollView'],
  );
});

test('#525 tool layer forwards walkUpSearched on a walkUp refusal', async () => {
  const client = createMockClient({
    evaluate: async () => ({
      value: JSON.stringify({
        error: 'Component has no onPress handler',
        component: 'RCTView',
        testID: 'card',
        walkUpSearched: 8,
      }),
    }),
  });
  const handler = createInteractHandler(() => client);
  const envelope = parseEnvelope(
    await handler({ action: 'press', testID: 'card', walkUp: true, animated: true }),
  );
  assert.equal(envelope.ok, false);
  assert.equal(envelope.meta?.walkUpSearched, 8);
});

test('#525 tool layer forwards ambiguity candidates and count on a walkUp refusal', async () => {
  const candidates = [
    { component: 'RCTView', testID: 'outer' },
    { component: 'Pressable', testID: 'inner' },
  ];
  const client = createMockClient({
    evaluate: async () => ({
      value: JSON.stringify({
        error: 'Ambiguous walkUp press target',
        testID: 'dup',
        count: 2,
        candidates,
        hint: 'Pass the testID of the exact pressable component instead.',
      }),
    }),
  });
  const handler = createInteractHandler(() => client);
  const envelope = parseEnvelope(
    await handler({ action: 'press', testID: 'dup', walkUp: true, animated: true }),
  );
  assert.equal(envelope.ok, false);
  assert.equal(envelope.meta?.count, 2);
  assert.deepEqual(envelope.meta?.candidates, candidates);
  assert.match(String(envelope.meta?.hint), /exact pressable/);
});

test('#525 tool layer leaves refusals without diagnostics free of meta', async () => {
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify({ error: 'Component not found' }) }),
  });
  const handler = createInteractHandler(() => client);
  const envelope = parseEnvelope(
    await handler({ action: 'press', testID: 'gone', animated: true }),
  );
  assert.equal(envelope.ok, false);
  assert.equal(envelope.meta, undefined);
});

test('#525 tool layer omits walkUp when not requested (default unchanged)', async () => {
  let evaluated = '';
  const client = createMockClient({
    evaluate: async (expr: string) => {
      evaluated = expr;
      return { value: JSON.stringify({ success: true, action: 'press' }) };
    },
  });
  const handler = createInteractHandler(() => client);
  await handler({ action: 'press', testID: 'card', animated: true });
  const opts = JSON.parse(evaluated.replace(/^__QAREN\.interact\(/, '').replace(/\)$/, ''));
  assert.ok(!('walkUp' in opts));
});

test('style resets preserve exact-ID press eligibility on hosts and ancestors', () => {
  for (const key of ['display', 'pointerEvents']) {
    for (const target of ['host', 'outerHost'] as const) {
      for (const reset of [undefined, null, 'missing']) {
        const fixture = forwardedPressTree();
        fixture[target].memoizedProps.style = [
          { [key]: 'none' },
          [reset === 'missing' ? {} : { [key]: reset }],
        ];
        const result = pressFixture(fixture);
        assert.equal(result.success === true, reset !== 'missing', `${key} ${target} ${reset}`);
        assert.deepEqual(fixture.calls, {
          wrapper: reset === 'missing' ? 0 : 1,
          navigation: reset === 'missing' ? 0 : 1,
        });
      }
    }
  }
});
