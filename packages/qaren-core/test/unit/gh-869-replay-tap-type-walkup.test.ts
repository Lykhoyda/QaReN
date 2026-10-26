import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import {
  runCdpReplayCommands,
  type CdpReplayDeps,
} from '../../dist/handlers/cdp-replay-dispatch.js';
import { makeReplayDeps } from '../../dist/handlers/cdp-replay-deps.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

interface Fiber {
  tag: number;
  type: string | { displayName?: string };
  memoizedProps: Record<string, unknown>;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
}

function makeFiber(type: Fiber['type'], memoizedProps: Record<string, unknown> = {}): Fiber {
  return {
    tag: typeof type === 'string' ? 5 : 0,
    type,
    memoizedProps,
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

function createAgent(
  root: Fiber,
  beforeEvaluate?: (expression: string) => void,
  navState: Record<string, unknown> = { index: 0, routes: [{ name: 'Home' }] },
  repeatRoot = false,
) {
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
  sandbox.__expo_router_state__ = navState;
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (id: number) =>
      id === 1
        ? new Set(repeatRoot ? [{ current: root }, { current: root }] : [{ current: root }])
        : new Set(),
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return {
    evaluate: async (expression: string): Promise<{ value?: unknown; error?: unknown }> => {
      try {
        beforeEvaluate?.(expression);
        return { value: vm.runInContext(expression, sandbox) };
      } catch (error) {
        return { error };
      }
    },
  };
}

function buildDeps(agent: ReturnType<typeof createAgent>): CdpReplayDeps {
  const client = createMockClient({
    evaluate: (expr: string) => agent.evaluate(expr),
    probeHelperFreshness: async () => ({ fresh: true, version: 0, probed: true }),
  }) as never;
  const deps = makeReplayDeps({
    getActiveSession: () => ({
      name: 'gh-869-test',
      platform: 'ios',
      deviceId: 'test-device',
      appId: 'dev.rn.agent.fixture',
      openedAt: '2026-08-30T00:00:00.000Z',
    }),
    getClient: () => client,
    resolveIosUdid: async () => 'test-device',
    execute: async () => undefined,
  });
  assert.ok(deps);
  return deps;
}

function otpFixture() {
  const calls = { focus: 0, typed: [] as string[] };
  const root = makeFiber('Root');
  const app = appendChild(root, makeFiber({ displayName: 'App' }));
  const pressable = appendChild(
    app,
    makeFiber(
      { displayName: 'Pressable' },
      {
        testID: 'otp_email-pressable',
        onPress: () => {
          calls.focus += 1;
        },
      },
    ),
  );
  const pressableHost = appendChild(pressable, makeFiber('RCTView'));
  const inputComposite = appendChild(
    pressableHost,
    makeFiber({ displayName: 'TextInput' }, { testID: 'otp_email' }),
  );
  const inputHost = appendChild(
    inputComposite,
    makeFiber('RCTSinglelineTextInputView', { testID: 'otp_email', value: '' }),
  );
  inputHost.memoizedProps.onChangeText = (value: string): void => {
    calls.typed.push(value);
    inputHost.memoizedProps.value = value;
  };
  return { root, app, pressable, pressableHost, inputComposite, calls, inputHost };
}

function tabFixture() {
  const calls = { wrapper: 0, navigation: 0 };
  const root = makeFiber('Root');
  const navigate = () => calls.navigation++;
  const handlePress = () => {
    calls.wrapper++;
    navigate();
  };
  const outer = appendChild(
    root,
    makeFiber(
      { displayName: 'BottomTabItem' },
      {
        testID: 'tab-home',
        onPress: navigate,
      },
    ),
  );
  const outerHost = appendChild(outer, makeFiber('RCTView'));
  const animated = appendChild(
    outerHost,
    makeFiber(
      { displayName: 'Animated(Pressable)' },
      {
        testID: 'tab-home',
        onPress: handlePress,
      },
    ),
  );
  const pressable = appendChild(
    animated,
    makeFiber(
      { displayName: 'Pressable' },
      {
        testID: 'tab-home',
        onPress: handlePress,
      },
    ),
  );
  const host = appendChild(
    pressable,
    makeFiber('RCTView', {
      testID: 'tab-home',
      accessible: true,
      accessibilityRole: 'button',
      onResponderGrant: () => {},
    }),
  );
  return { root, outer, outerHost, animated, pressable, host, calls };
}

type RouteState = { key?: string; index: number; routes: { key: string; name: string }[] };

// React Navigation renamed dangerouslyGetState to getState in v6.
function scopedNavigation(state: RouteState, isFocused: () => boolean, legacy: boolean) {
  return legacy
    ? { dangerouslyGetState: () => state, isFocused }
    : { getState: () => state, isFocused };
}

function sceneProps(
  route: { key: string; name: string },
  state: RouteState,
  isFocused = () => state.routes[state.index]?.key === route.key,
  legacy = false,
) {
  const neverInvoke = () => assert.fail('scene callbacks and renderers must not be invoked');
  return {
    screen: { name: route.name, component: neverInvoke },
    route,
    getState: neverInvoke,
    setState: neverInvoke,
    clearOptions: neverInvoke,
    navigation: scopedNavigation(state, isFocused, legacy),
  };
}

function tabDescriptor(route: { key: string; name: string }, state: RouteState, legacy = false) {
  return {
    route,
    navigation: scopedNavigation(state, () => state.routes[state.index]?.key === route.key, legacy),
    options: {},
    render: () => assert.fail('descriptor renderers must not be invoked'),
  };
}

// @react-navigation/bottom-tabs renders the bar as a sibling of the scenes and
// hands each item the descriptor of the route it navigates to.
function routedTabFixture({ nested = true, selected = 1, legacy = false, routeOuter = true } = {}) {
  const fixture = tabFixture();
  const home = { key: 'home-tab', name: 'HomeTab' };
  const tasks = { key: 'tasks-tab', name: 'TasksTab' };
  const tabState = { key: 'tabs-state', index: selected, routes: [home, tasks] };
  const descriptors = {
    [home.key]: tabDescriptor(home, tabState, legacy),
    [tasks.key]: tabDescriptor(tasks, tabState, legacy),
  };
  const tabs = { key: 'root-tabs', name: 'Tabs', state: tabState };
  const root = makeFiber('Root');
  const state = nested ? { key: 'root-state', index: 0, routes: [tabs] } : tabState;
  const owner = nested
    ? appendChild(
        root,
        makeFiber({ displayName: 'MinifiedScene' }, sceneProps(tabs, state, undefined, legacy)),
      )
    : root;
  const bar = appendChild(
    owner,
    makeFiber(
      { displayName: 'BottomTabBar' },
      {
        state: tabState,
        descriptors,
        navigation: { getState: () => tabState, isFocused: () => true },
      },
    ),
  );
  const provider = appendChild(
    bar,
    makeFiber(
      { displayName: 'NavigationProvider' },
      {
        route: home,
        navigation: descriptors[home.key].navigation,
        children: fixture.outer,
      },
    ),
  );
  // v7 nests the route context outside the navigation one; v5/v6 nest them the other way round.
  const [outerValue, innerValue] = routeOuter
    ? [home, descriptors[home.key].navigation]
    : [descriptors[home.key].navigation, home];
  const outerContext = appendChild(
    provider,
    makeFiber({}, { value: outerValue, children: fixture.outer }),
  );
  outerContext.tag = 10;
  const innerContext = appendChild(
    outerContext,
    makeFiber({}, { value: innerValue, children: fixture.outer }),
  );
  innerContext.tag = 10;
  const routeContext = routeOuter ? outerContext : innerContext;
  const navigationContext = routeOuter ? innerContext : outerContext;
  const focusContext = appendChild(
    innerContext,
    makeFiber(
      {},
      {
        value: selected === 0,
        children: fixture.outer,
      },
    ),
  );
  focusContext.tag = 10;
  appendChild(focusContext, fixture.outer);
  Object.assign(fixture.outer.memoizedProps, {
    route: home,
    descriptor: descriptors[home.key],
    focused: selected === 0,
  });
  return {
    ...fixture,
    root,
    owner,
    bar,
    provider,
    routeContext,
    navigationContext,
    focusContext,
    descriptors,
    state,
    home,
    tasks,
    tabState,
  };
}

function expoRootState(selected: number) {
  return {
    index: 0,
    routes: [
      {
        name: '(tabs)',
        state: { index: selected, routes: [{ name: 'HomeTab' }, { name: 'TasksTab' }] },
      },
    ],
  };
}

test('#951 a navigator exposing only dangerouslyGetState still proves tab ownership', async (t) => {
  for (const active of [true, false]) {
    await t.test(active ? 'active scene' : 'inactive scene', async () => {
      const fixture = routedTabFixture({ legacy: true });
      if (!active) {
        fixture.owner.memoizedProps = sceneProps(fixture.home, fixture.tabState, undefined, true);
      }
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(createAgent(fixture.root, undefined, fixture.state)),
      );
      assert.equal(result.passed, active, JSON.stringify(result));
      if (!active) {
        assert.equal(result.failedStepIndex, 0);
        assert.equal(result.failureCode, 'ASSERTION_FAILED');
      }
      const expected = active ? 1 : 0;
      assert.deepEqual(fixture.calls, { wrapper: expected, navigation: expected });
    });
  }
});

test('#951 a root tab navigator presses its own items without a scene ancestor', async (t) => {
  const layouts = [
    {
      name: 'direct root',
      state: (selected: number) => ({
        index: selected,
        routes: [{ name: 'HomeTab' }, { name: 'TasksTab' }],
      }),
    },
    { name: 'expo root', state: expoRootState },
  ];
  for (const layout of layouts) {
    for (const selected of [0, 1]) {
      await t.test(`${layout.name}: ${selected === 0 ? 'active' : 'inactive'} tab`, async () => {
        const fixture = routedTabFixture({ nested: false, selected });
        const result = await runCdpReplayCommands(
          [{ tapOn: { id: 'tab-home' } }],
          {},
          buildDeps(createAgent(fixture.root, undefined, layout.state(selected))),
        );
        assert.equal(result.passed, true, JSON.stringify(result));
        assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
      });
    }
  }
});

test('#951 saved Home tap from Tasks uses the enclosing Tabs scene, not its destination descriptor', async () => {
  const fixture = routedTabFixture();
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'tab-home' } }],
    {},
    buildDeps(createAgent(fixture.root, undefined, fixture.state)),
  );
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(
    result.steps.map(({ t, target, ok }) => ({ t, target, ok })),
    [{ t: 'tap', target: 'tab-home', ok: true }],
  );
  assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
});

test('#951 an active destination descriptor cannot authorize content in an inactive scene', async () => {
  const fixture = routedTabFixture();
  fixture.owner.memoizedProps = sceneProps(fixture.home, fixture.tabState);
  Object.assign(fixture.outer.memoizedProps, {
    route: fixture.tasks,
    descriptor: tabDescriptor(fixture.tasks, fixture.tabState),
  });
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'tab-home' } }],
    {},
    buildDeps(createAgent(fixture.root, undefined, fixture.state)),
  );
  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'ASSERTION_FAILED');
  assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
});

test('#951 visibility assertions, waits and conditional flows share scene ownership', async (t) => {
  const consumers = [
    { name: 'assertVisible', command: { assertVisible: { id: 'tab-home' } }, presses: 0 },
    {
      name: 'timed wait',
      command: { extendedWaitUntil: { visible: { id: 'tab-home' }, timeout: 50 } },
      presses: 0,
    },
    {
      name: 'conditional flow',
      command: {
        runFlow: {
          when: { visible: { id: 'tab-home' } },
          commands: [{ tapOn: { id: 'tab-home' } }],
        },
      },
      presses: 1,
    },
  ];
  for (const { name, command, presses } of consumers) {
    for (const proof of ['focused', 'inactive', 'malformed']) {
      await t.test(`${name}: ${proof}`, async () => {
        const fixture = routedTabFixture();
        if (proof === 'inactive')
          fixture.owner.memoizedProps = sceneProps(fixture.home, fixture.tabState);
        if (proof === 'malformed') delete fixture.owner.memoizedProps.navigation.isFocused;
        const result = await runCdpReplayCommands(
          [command],
          {},
          buildDeps(createAgent(fixture.root, undefined, fixture.state)),
        );
        assert.equal(result.passed, proof === 'focused', JSON.stringify(result));
        if (proof !== 'focused') {
          assert.equal(result.failureCode, 'ASSERTION_FAILED');
          assert.equal(result.failedStepIndex, 0);
        }
        const expected = proof === 'focused' ? presses : 0;
        assert.deepEqual(fixture.calls, { wrapper: expected, navigation: expected });
      });
    }
  }
});

function insertScope(parent: Fiber, props: Record<string, any>) {
  const child = parent.child!;
  parent.child = null;
  const scope = appendChild(parent, makeFiber({ displayName: 'OpaqueScope' }, props));
  appendChild(scope, child);
  return scope;
}

test('#951 destination providers cannot hide a real inactive ownership edge', async (t) => {
  const cases: [string, (fixture: ReturnType<typeof routedTabFixture>) => void][] = [
    [
      'inactive navigator with locally selected descriptor',
      (f) => {
        f.bar.memoizedProps.navigation.isFocused = () => false;
        for (const descriptor of Object.values(f.descriptors)) {
          descriptor.navigation.isFocused = () => false;
        }
      },
    ],
    [
      'inactive outer owner',
      (f) => {
        f.owner.memoizedProps = sceneProps(f.home, f.tabState);
      },
    ],
    [
      'owner below the item',
      (f) => {
        insertScope(f.outer, sceneProps(f.home, f.tabState));
      },
    ],
    [
      'transparent scope below the item',
      (f) => {
        insertScope(f.outer, { ...f.provider.memoizedProps });
      },
    ],
    [
      'richer scene between item and navigator',
      (f) => {
        Object.assign(f.provider.memoizedProps, sceneProps(f.home, f.tabState));
      },
    ],
    [
      'singular descriptor owner',
      (f) => {
        insertScope(f.provider, { descriptor: f.descriptors[f.home.key] });
      },
    ],
    [
      'scene descriptor owner',
      (f) => {
        insertScope(f.provider, { scene: { descriptor: f.descriptors[f.home.key] } });
      },
    ],
    [
      'paired contexts below the item',
      (f) => {
        const route = insertScope(f.outer, { value: f.home, children: null });
        route.tag = 10;
        const nav = insertScope(route, {
          value: f.descriptors[f.home.key].navigation,
          children: null,
        });
        nav.tag = 10;
      },
    ],
    [
      'richer paired context',
      (f) => {
        f.routeContext.memoizedProps.screen = {};
      },
    ],
    [
      'control-shaped content under an inactive screen',
      (f) => {
        insertScope(f.bar, sceneProps(f.home, f.tabState));
      },
    ],
  ];
  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const fixture = routedTabFixture();
      change(fixture);
      const agent = createAgent(fixture.root, undefined, fixture.state);
      const verdict = JSON.parse(
        String((await agent.evaluate('__QAREN.isTestIdFrontmost("tab-home")')).value),
      );
      assert.equal(verdict.visible, false);
      assert.equal(verdict.matchCount, 1);
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(agent),
      );
      assert.equal(result.passed, false);
      assert.equal(result.failureCode, 'ASSERTION_FAILED');
      assert.equal(result.failedStepIndex, 0);
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
});

test('#951 destination binding refuses malformed and cross-navigator associations', async (t) => {
  const cases: [string, (fixture: ReturnType<typeof routedTabFixture>) => void][] = [
    [
      'copied destination descriptor',
      (f) => {
        f.outer.memoizedProps.descriptor = { ...f.descriptors[f.home.key] };
      },
    ],
    [
      'missing descriptor map',
      (f) => {
        delete f.bar.memoizedProps.descriptors;
      },
    ],
    [
      'missing navigator state',
      (f) => {
        delete f.bar.memoizedProps.state;
      },
    ],
    [
      'missing selected descriptor',
      (f) => {
        delete f.bar.memoizedProps.descriptors[f.tasks.key];
      },
    ],
    [
      'selected descriptor route mismatch',
      (f) => {
        f.descriptors[f.tasks.key].route = f.home;
      },
    ],
    [
      'missing selected flag',
      (f) => {
        delete f.outer.memoizedProps.focused;
      },
    ],
    [
      'invalid selected flag',
      (f) => {
        f.outer.memoizedProps.focused = 'false';
      },
    ],
    [
      'selected flag contradicts state',
      (f) => {
        f.outer.memoizedProps.focused = true;
      },
    ],
    [
      'invalid press handler',
      (f) => {
        f.outer.memoizedProps.onPress = null;
      },
    ],
    [
      'own malformed navigation',
      (f) => {
        f.outer.memoizedProps.navigation = null;
      },
    ],
    [
      'navigator focus disagrees',
      (f) => {
        f.bar.memoizedProps.navigation.isFocused = () => false;
      },
    ],
    [
      'selected descriptor is unfocused',
      (f) => {
        f.descriptors[f.tasks.key].navigation.isFocused = () => false;
      },
    ],
    [
      'different destination navigation',
      (f) => {
        f.provider.memoizedProps.navigation = scopedNavigation(f.tabState, () => true, false);
      },
    ],
    [
      'conflicting paired navigation',
      (f) => {
        f.navigationContext.memoizedProps.value = scopedNavigation(f.tabState, () => true, false);
      },
    ],
    [
      'same keys and names from another navigator state',
      (f) => {
        f.descriptors[f.tasks.key].navigation.getState = () => ({
          ...f.tabState,
          key: 'foreign-tabs',
        });
      },
    ],
    [
      'same state key but different route membership',
      (f) => {
        f.descriptors[f.tasks.key].navigation.getState = () => ({
          ...f.tabState,
          routes: [f.tasks],
          index: 0,
        });
      },
    ],
    [
      'duplicate destination membership',
      (f) => {
        f.tabState.routes.push(f.home);
      },
    ],
    [
      'invalid modern getter with valid legacy',
      (f) => {
        const nav = f.descriptors[f.home.key].navigation as Record<string, any>;
        nav.dangerouslyGetState = () => f.tabState;
        nav.getState = null;
      },
    ],
    [
      'throwing modern getter with valid legacy',
      (f) => {
        const nav = f.descriptors[f.home.key].navigation as Record<string, any>;
        nav.dangerouslyGetState = () => f.tabState;
        nav.getState = () => {
          throw new Error('unreadable');
        };
      },
    ],
    [
      'truncated scope ancestry',
      (f) => {
        let parent = makeFiber({});
        for (let index = 0; index < 1000; index++) {
          parent = appendChild(parent, makeFiber({}));
        }
        f.root.return = parent;
      },
    ],
  ];
  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const fixture = routedTabFixture();
      change(fixture);
      const agent = createAgent(fixture.root, undefined, fixture.state);
      const verdict = JSON.parse(
        String((await agent.evaluate('__QAREN.isTestIdFrontmost("tab-home")')).value),
      );
      assert.equal(verdict.visible, false);
      assert.equal(verdict.code, 'ASSERTION_FAILED');
      assert.equal(verdict.matchCount, 1);
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(agent),
      );
      assert.equal(result.passed, false);
      assert.equal(result.failureCode, 'ASSERTION_FAILED');
      assert.equal(result.failedStepIndex, 0);
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
});

test('#951 legacy-ordered route contexts still prove tab ownership', async (t) => {
  for (const selected of [0, 1]) {
    await t.test(selected === 0 ? 'active tab' : 'inactive tab', async () => {
      const fixture = routedTabFixture({ routeOuter: false, selected });
      const agent = createAgent(fixture.root, undefined, fixture.state);
      const verdict = JSON.parse(
        String((await agent.evaluate('__QAREN.isTestIdFrontmost("tab-home")')).value),
      );
      assert.equal(verdict.visible, true, JSON.stringify(verdict));
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(agent),
      );
      assert.equal(result.passed, true, JSON.stringify(result));
      assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
    });
  }
});

test('#951 route-shaped contexts without a navigation partner are skipped, not refused', async (t) => {
  const cases: [string, (fixture: ReturnType<typeof routedTabFixture>) => void][] = [
    [
      'expo-router params beside a route node',
      (f) => {
        const params = insertScope(f.outer, {
          value: { key: 'details-key', name: 'Details' },
          children: null,
        });
        params.tag = 10;
        const routeNode = insertScope(params, {
          value: { route: 'details', contextKey: './details.tsx' },
          children: null,
        });
        routeNode.tag = 10;
      },
    ],
    [
      'half-shaped route context',
      (f) => {
        f.routeContext.memoizedProps.value = { key: f.home.key };
      },
    ],
  ];
  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const fixture = routedTabFixture();
      change(fixture);
      const agent = createAgent(fixture.root, undefined, fixture.state);
      const verdict = JSON.parse(
        String((await agent.evaluate('__QAREN.isTestIdFrontmost("tab-home")')).value),
      );
      assert.equal(verdict.visible, true, JSON.stringify(verdict));
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(agent),
      );
      assert.equal(result.passed, true, JSON.stringify(result));
      assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
    });
  }
});

test('#951 a mounted host observed twice presses once, two distinct hosts still refuse', async (t) => {
  await t.test('repeated observation of one host', async () => {
    const fixture = routedTabFixture();
    const agent = createAgent(fixture.root, undefined, fixture.state, true);
    const verdict = JSON.parse(
      String((await agent.evaluate('__QAREN.isTestIdFrontmost("tab-home")')).value),
    );
    assert.equal(verdict.visible, true, JSON.stringify(verdict));
    assert.equal(verdict.matchCount, 1);
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'tab-home' } }],
      {},
      buildDeps(agent),
    );
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
  });

  await t.test('two distinct hosts under the same control', async () => {
    const fixture = routedTabFixture();
    fixture.outerHost.memoizedProps.testID = 'tab-home';
    const agent = createAgent(fixture.root, undefined, fixture.state);
    const verdict = JSON.parse(
      String((await agent.evaluate('__QAREN.isTestIdFrontmost("tab-home")')).value),
    );
    assert.equal(verdict.visible, false);
    assert.equal(verdict.code, 'ASSERTION_FAILED');
    assert.equal(verdict.matchCount, 1);
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'tab-home' } }],
      {},
      buildDeps(agent),
    );
    assert.equal(result.passed, false);
    assert.equal(result.failureCode, 'ASSERTION_FAILED');
    assert.equal(result.failedStepIndex, 0);
    assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
  });
});

test('#951 destination binding uses local descriptors across repeated names and legacy parent getters', async (t) => {
  for (const legacy of [false, true]) {
    for (const selected of [0, 1]) {
      await t.test(`${legacy ? 'early v5' : 'modern'} selected ${selected}`, async () => {
        const fixture = routedTabFixture({ legacy, selected });
        fixture.tasks.name = fixture.home.name;
        const outerRoute = { key: fixture.home.key, name: fixture.home.name };
        const parentState = { key: 'parent-state', index: 0, routes: [outerRoute] };
        fixture.owner.memoizedProps = sceneProps(outerRoute, parentState, () => true, legacy);
        // Early-v5 navigator helpers can inherit a parent getter; the descriptor owns the local one.
        fixture.bar.memoizedProps.navigation = scopedNavigation(parentState, () => true, legacy);
        const result = await runCdpReplayCommands(
          [{ tapOn: { id: 'tab-home' } }],
          {},
          buildDeps(createAgent(fixture.root, undefined, fixture.state)),
        );
        assert.equal(result.passed, true, JSON.stringify(result));
        assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
      });
    }
  }
});

test('#951 the ownership walk follows an alternate outer scene without losing its veto', async (t) => {
  for (const active of [true, false]) {
    await t.test(active ? 'active alternate' : 'inactive alternate', async () => {
      const fixture = routedTabFixture();
      const alternate = makeFiber(
        {},
        sceneProps(fixture.home, fixture.tabState, () => false),
      );
      if (active) alternate.memoizedProps = fixture.owner.memoizedProps;
      Object.assign(fixture.owner, { alternate });
      Object.assign(alternate, { alternate: fixture.owner });
      alternate.return = fixture.root;
      fixture.bar.return = alternate;
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(createAgent(fixture.root, undefined, fixture.state)),
      );
      assert.equal(result.passed, active);
      if (!active) {
        assert.equal(result.failureCode, 'ASSERTION_FAILED');
        assert.equal(result.failedStepIndex, 0);
      }
      assert.deepEqual(fixture.calls, { wrapper: active ? 1 : 0, navigation: active ? 1 : 0 });
    });
  }
});

test('#951 an inactive sibling with the same ID remains ambiguous before scene eligibility', async () => {
  const fixture = routedTabFixture();
  const inactive = appendChild(
    fixture.root,
    makeFiber({ displayName: 'Scene' }, sceneProps(fixture.home, fixture.tabState)),
  );
  let inactivePresses = 0;
  appendChild(
    inactive,
    makeFiber('RCTView', {
      testID: 'tab-home',
      onPress: () => {
        inactivePresses++;
      },
    }),
  );
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'tab-home' } }],
    {},
    buildDeps(createAgent(fixture.root, undefined, fixture.state)),
  );
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'AMBIGUOUS_TESTID');
  assert.deepEqual(result.failureMeta, { matchCount: 2 });
  assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
  assert.equal(inactivePresses, 0);
});

test('#951 replay input and live designation consumption require a focused owning scene', async (t) => {
  for (const mode of ['focused', 'inactive', 'inactive before type', 'malformed before type']) {
    await t.test(mode, async () => {
      const fixture = otpFixture();
      const home = { key: 'home', name: 'Home' };
      const state = { index: 0, routes: [home, { key: 'other-home', name: 'Home' }] };
      let focused = mode !== 'inactive';
      const owner = makeFiber(
        { displayName: 'MinifiedScene' },
        sceneProps(home, state, () => focused),
      );
      fixture.root.child = owner;
      owner.return = fixture.root;
      appendChild(owner, fixture.app);
      let changedBeforeType = false;
      const agent = createAgent(
        fixture.root,
        (expression) => {
          if (!expression.startsWith('__QAREN.interact(')) return;
          const args = JSON.parse(expression.slice(expression.indexOf('(') + 1, -1));
          if (!args.requireLiveInputDesignation || !mode.endsWith('before type')) return;
          changedBeforeType = true;
          if (mode === 'malformed before type') delete owner.memoizedProps.navigation.isFocused;
          else focused = false;
        },
        state,
      );
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
        {},
        buildDeps(agent),
      );
      assert.equal(result.passed, mode === 'focused', JSON.stringify(result));
      assert.equal(fixture.calls.focus, 0);
      assert.deepEqual(fixture.calls.typed, mode === 'focused' ? ['0451'] : []);
      if (mode !== 'focused') {
        assert.equal(result.failureCode, 'ASSERTION_FAILED');
        assert.equal(result.failedStepIndex, mode === 'inactive' ? 0 : 1);
        assert.equal(fixture.inputHost.memoizedProps.value, '');
      }
      if (mode.endsWith('before type')) {
        assert.equal(changedBeforeType, true);
        assert.equal(result.steps[0].focusOnly, true);
        assert.equal(result.failureMeta?.mutation, 'none');
        assert.equal(result.failureMeta?.focusOnly, true);
      }
    });
  }
});

test('#951 saved replay dispatches a wrapped navigator press through its native-path callback', async () => {
  const fixture = tabFixture();
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'tab-home' } }],
    {},
    buildDeps(createAgent(fixture.root)),
  );
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(
    result.steps.map(({ t, target, ok }) => ({ t, target, ok })),
    [{ t: 'tap', target: 'tab-home', ok: true }],
  );
  assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
});

test('#951 replay refuses nested host controls with distinct callbacks', async (t) => {
  for (const outerHasId of [false, true]) {
    await t.test(`outer host ID=${outerHasId}`, async () => {
      const fixture = tabFixture();
      fixture.outerHost.memoizedProps.onResponderGrant = () => {};
      fixture.outerHost.memoizedProps.accessible = true;
      if (outerHasId) fixture.outerHost.memoizedProps.testID = 'tab-home';
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(createAgent(fixture.root)),
      );
      assert.equal(result.passed, false);
      assert.equal(result.failedStepIndex, 0);
      assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.deepEqual(result.failureMeta, {
        hint: 'Multiple distinct pressable fibers resolve from this testID. Pass the testID of the exact pressable component instead.',
        count: 2,
        candidates: [
          { component: 'BottomTabItem', testID: 'tab-home' },
          { component: 'Animated(Pressable)', testID: 'tab-home' },
        ],
      });
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
});

test('#951 replay dispatches one shared callback across nested hosts exactly once', async (t) => {
  for (const outerHasId of [false, true]) {
    await t.test(`outer host ID=${outerHasId}`, async () => {
      const fixture = tabFixture();
      fixture.outerHost.memoizedProps.onResponderGrant = () => {};
      fixture.outerHost.memoizedProps.accessible = true;
      if (outerHasId) fixture.outerHost.memoizedProps.testID = 'tab-home';
      fixture.outer.memoizedProps.onPress = fixture.animated.memoizedProps.onPress;
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(createAgent(fixture.root)),
      );
      assert.equal(result.passed, true, JSON.stringify(result));
      assert.deepEqual(
        result.steps.map((step) => ({ t: step.t, target: step.target, ok: step.ok })),
        [{ t: 'tap', target: 'tab-home', ok: true }],
      );
      assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 1 });
    });
  }
});

test('#951 replay preserves frontmost ambiguity for sibling hosts with distinct or shared callbacks', async (t) => {
  for (const shared of [false, true]) {
    await t.test(`shared=${shared}`, async () => {
      const fixture = tabFixture();
      const sibling = appendChild(
        fixture.root,
        makeFiber(
          { displayName: 'OtherButton' },
          {
            testID: 'tab-home',
            onPress: shared
              ? fixture.animated.memoizedProps.onPress
              : () => fixture.calls.navigation++,
          },
        ),
      );
      appendChild(sibling, makeFiber('RCTView', { testID: 'tab-home' }));
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(createAgent(fixture.root)),
      );
      assert.equal(result.passed, false);
      assert.equal(result.failedStepIndex, 0);
      assert.equal(result.failureCode, 'AMBIGUOUS_TESTID');
      assert.deepEqual(result.failureMeta, { matchCount: 2 });
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
});

test('#951 live eligibility rechecks every source after the replay proof', async (t) => {
  const cases: Array<{
    label: string;
    mutate: (fixture: ReturnType<typeof tabFixture>) => void;
    reason: string;
  }> = [
    {
      label: 'disabled outer source',
      mutate: (f) => {
        f.outer.memoizedProps.disabled = true;
      },
      reason: 'disabled exact-ID fiber',
    },
    {
      label: 'disabled host',
      mutate: (f) => {
        f.host.memoizedProps.disabled = true;
      },
      reason: 'disabled exact-ID fiber',
    },
    {
      label: 'disabled ancestor target',
      mutate: (f) => {
        f.pressable.memoizedProps.disabled = true;
      },
      reason: 'disabled walk target',
    },
    {
      label: 'pointer-blocked host',
      mutate: (f) => {
        f.host.memoizedProps.pointerEvents = 'none';
      },
      reason: 'exact-ID fiber has pointerEvents="none"',
    },
    {
      label: 'pointer-blocked parent',
      mutate: (f) => {
        f.outerHost.memoizedProps.pointerEvents = 'box-only';
      },
      reason: 'exact-ID fiber is beneath pointerEvents="box-only"',
    },
    {
      label: 'hidden host',
      mutate: (f) => {
        f.host.memoizedProps.style = { display: 'none' };
      },
      reason: 'hidden exact-ID subtree',
    },
  ];
  for (const { label, mutate, reason } of cases) {
    await t.test(label, async () => {
      const fixture = tabFixture();
      const agent = createAgent(fixture.root, (expression) => {
        if (expression.startsWith('__QAREN.interact(')) mutate(fixture);
      });
      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'tab-home' } }],
        {},
        buildDeps(agent),
      );
      assert.equal(result.passed, false);
      assert.equal(result.failedStepIndex, 0);
      assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.deepEqual(result.failureMeta, { reason });
      assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
    });
  }
});

test('#951 the existing modal gate refuses an occluded tab before dispatch', async () => {
  const fixture = tabFixture();
  const modal = appendChild(fixture.root, makeFiber('RCTView', { accessibilityViewIsModal: true }));
  appendChild(modal, makeFiber('RCTText', { children: 'Blocking sheet' }));
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'tab-home' } }],
    {},
    buildDeps(createAgent(fixture.root)),
  );
  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'ASSERTION_FAILED');
  assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
});

test('#951 a throwing forwarding handler preserves replay execution metadata', async () => {
  const fixture = tabFixture();
  const throwOnPress = () => {
    fixture.calls.wrapper++;
    throw new Error('forwarding failure');
  };
  fixture.animated.memoizedProps.onPress = throwOnPress;
  fixture.pressable.memoizedProps.onPress = throwOnPress;
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'tab-home' } }],
    {},
    buildDeps(createAgent(fixture.root)),
  );
  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.deepEqual(result.failureMeta, {
    actionExecuted: true,
    handlerError: 'forwarding failure',
    hint: 'The app handler raised an exception — the screen may be in an error state. Check cdp_error_log before continuing.',
  });
  assert.deepEqual(fixture.calls, { wrapper: 1, navigation: 0 });
});

test('#951 replay preserves absence and bounded-search metadata', async (t) => {
  await t.test('absent target', async () => {
    const fixture = tabFixture();
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'missing-tab' } }],
      {},
      buildDeps(createAgent(fixture.root)),
    );
    assert.equal(result.passed, false);
    assert.equal(result.failureCode, 'TESTID_NOT_FOUND');
    assert.deepEqual(result.failureMeta, { failedSelector: 'missing-tab' });
    assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
  });
  await t.test('no handler', async () => {
    const fixture = tabFixture();
    for (const fiber of [fixture.outer, fixture.animated, fixture.pressable])
      delete fiber.memoizedProps.onPress;
    const result = await runCdpReplayCommands(
      [{ tapOn: { id: 'tab-home' } }],
      {},
      buildDeps(createAgent(fixture.root)),
    );
    assert.equal(result.passed, false);
    assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
    assert.deepEqual(result.failureMeta, { walkUpSearched: 8 });
    assert.deepEqual(fixture.calls, { wrapper: 0, navigation: 0 });
  });
});

test('#869 replay designates the Pressable-wrapped input by its exact testID, then types on that same input', async () => {
  const fixture = otpFixture();
  const deps = buildDeps(createAgent(fixture.root));

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(
    result.steps.map((s) => ({ t: s.t, target: s.target, ok: s.ok })),
    [
      { t: 'tap', target: 'otp_email', ok: true },
      { t: 'type', target: 'otp_email', ok: true },
    ],
  );
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(fixture.calls.focus, 0, 'the wrapper onPress must never fire for an input target');
  assert.deepEqual(fixture.calls.typed, ['0451']);
  assert.equal(
    fixture.inputHost.memoizedProps.value,
    '0451',
    'the type step must land on the exact matched input fiber',
  );
  assert.equal(result.finalFocusId, null);
});

test('#869 replay walks up to the nearest pressable for a non-input exact-ID target', async () => {
  let wrapperPresses = 0;
  const root = makeFiber('Root');
  const app = appendChild(root, makeFiber({ displayName: 'App' }));
  const pressable = appendChild(
    app,
    makeFiber(
      { displayName: 'Pressable' },
      {
        onPress: () => {
          wrapperPresses += 1;
        },
      },
    ),
  );
  const pressableHost = appendChild(pressable, makeFiber('RCTView'));
  appendChild(pressableHost, makeFiber({ displayName: 'Text' }, { testID: 'submit_label' }));
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'submit_label' } }], {}, deps);

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(wrapperPresses, 1);
  assert.notEqual(result.steps[0].focusOnly, true);
});

test('#869 a forwarded same-ID composite/host pressable stack presses exactly once', async () => {
  let fired = 0;
  const onPress = (): void => {
    fired += 1;
  };
  const root = makeFiber('Root');
  const composite = appendChild(
    root,
    makeFiber({ displayName: 'Pressable' }, { testID: 'btn', pointerEvents: 'box-only', onPress }),
  );
  const view = appendChild(
    composite,
    makeFiber({ displayName: 'View' }, { testID: 'btn', pointerEvents: 'box-only', onPress }),
  );
  appendChild(view, makeFiber('RCTView', { testID: 'btn', pointerEvents: 'box-only', onPress }));
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'btn' } }], {}, deps);

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(fired, 1);
});

test('#869 control: a box-only ancestor outside the exact-ID lineage still refuses', async () => {
  let fired = 0;
  const onPress = (): void => {
    fired += 1;
  };
  const root = makeFiber('Root');
  const blocker = appendChild(
    root,
    makeFiber({ displayName: 'View' }, { testID: 'shell', pointerEvents: 'box-only' }),
  );
  const blockerHost = appendChild(
    blocker,
    makeFiber('RCTView', { testID: 'shell', pointerEvents: 'box-only' }),
  );
  const composite = appendChild(
    blockerHost,
    makeFiber({ displayName: 'Pressable' }, { testID: 'btn', onPress }),
  );
  appendChild(composite, makeFiber('RCTView', { testID: 'btn', onPress }));
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'btn' } }], {}, deps);

  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /pointerEvents/);
  assert.equal(fired, 0);
});

test('#869 a TextInput carrying its own onPress presses once, then types', async (t) => {
  for (const wrapped of [false, true]) {
    await t.test(wrapped ? 'under a Pressable wrapper' : 'bare', async () => {
      const calls = { input: 0, wrapper: 0, typed: [] as string[] };
      const onPress = (): void => {
        calls.input += 1;
      };
      const root = makeFiber('Root');
      const app = appendChild(root, makeFiber({ displayName: 'App' }));
      const parent = wrapped
        ? appendChild(
            app,
            makeFiber(
              { displayName: 'Pressable' },
              {
                testID: 'otp_email-pressable',
                onPress: () => {
                  calls.wrapper += 1;
                },
              },
            ),
          )
        : app;
      const composite = appendChild(
        parent,
        makeFiber({ displayName: 'TextInput' }, { testID: 'otp_email', onPress }),
      );
      const host = appendChild(
        composite,
        makeFiber('RCTSinglelineTextInputView', { testID: 'otp_email', value: '', onPress }),
      );
      host.memoizedProps.onChangeText = (value: string): void => {
        calls.typed.push(value);
        host.memoizedProps.value = value;
      };
      const deps = buildDeps(createAgent(root));

      const result = await runCdpReplayCommands(
        [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
        {},
        deps,
      );

      assert.equal(result.passed, true, JSON.stringify(result));
      assert.equal(calls.input, 1, "the input's own onPress must fire exactly once");
      assert.equal(calls.wrapper, 0);
      assert.deepEqual(calls.typed, ['0451']);
      assert.equal(host.memoizedProps.value, '0451');
    });
  }
});

test('#869 a same-ID box-only host above a same-ID pressable still refuses', async () => {
  let fired = 0;
  const root = makeFiber('Root');
  const outer = appendChild(
    root,
    makeFiber({ displayName: 'View' }, { testID: 'x', pointerEvents: 'box-only' }),
  );
  const outerHost = appendChild(
    outer,
    makeFiber('RCTView', { testID: 'x', pointerEvents: 'box-only' }),
  );
  const onPress = (): void => {
    fired += 1;
  };
  const pressable = appendChild(
    outerHost,
    makeFiber({ displayName: 'Pressable' }, { testID: 'x', onPress }),
  );
  const pressableView = appendChild(
    pressable,
    makeFiber({ displayName: 'View' }, { testID: 'x', onPress }),
  );
  appendChild(pressableView, makeFiber('RCTView', { testID: 'x', onPress }));
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'x' } }], {}, deps);

  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /pointerEvents/);
  assert.equal(fired, 0);
});

test('#869 eligibility reads the root-down tree, not a stale return pointer', async () => {
  const calls = { typed: [] as string[] };
  const root = makeFiber('Root');
  const app = appendChild(root, makeFiber('RCTView'));
  const blockerHost = appendChild(app, makeFiber('RCTView', { pointerEvents: 'box-only' }));
  const inputComposite = appendChild(
    blockerHost,
    makeFiber({ displayName: 'TextInput' }, { testID: 'otp_email' }),
  );
  const inputHost = appendChild(
    inputComposite,
    makeFiber('RCTSinglelineTextInputView', { testID: 'otp_email', value: '' }),
  );
  inputHost.memoizedProps.onChangeText = (value: string): void => {
    calls.typed.push(value);
    inputHost.memoizedProps.value = value;
  };
  const cleanStandIn = makeFiber('RCTView');
  cleanStandIn.return = app;
  inputComposite.return = cleanStandIn;
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ inputText: '0451' }], {}, deps, {
    initialFocusId: 'otp_email',
  });

  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /pointerEvents/);
  assert.deepEqual(calls.typed, []);
  assert.equal(inputHost.memoizedProps.value, '');
});

test('#869 control: a directly pressable testID still presses without walking', async () => {
  let fired = 0;
  const root = makeFiber('Root');
  appendChild(
    root,
    makeFiber(
      { displayName: 'Pressable' },
      {
        testID: 'login_submit',
        onPress: () => {
          fired += 1;
        },
      },
    ),
  );
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'login_submit' } }], {}, deps);

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(fired, 1);
});

test('#869 control: a non-input target with no actionable ancestor still refuses the tap', async () => {
  const root = makeFiber('Root');
  const view = appendChild(root, makeFiber({ displayName: 'View' }));
  appendChild(view, makeFiber({ displayName: 'Text' }, { testID: 'orphan_label' }));
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'orphan_label' } }], {}, deps);

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.match(result.reason ?? '', /no onPress handler/);
});

test('#869 control: a bare TextInput with no actionable ancestor is still designated, not pressed', async () => {
  const fixture = otpFixture();
  delete fixture.pressable.memoizedProps.onPress;
  const deps = buildDeps(createAgent(fixture.root));

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(result.steps[1].target, 'otp_email');
  assert.equal(result.finalFocusId, null);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, ['0451']);
  assert.equal(fixture.inputHost.memoizedProps.value, '0451');
});

test('#869 control: a non-editable input refuses from the projected tree', async () => {
  const fixture = otpFixture();
  fixture.inputHost.memoizedProps.editable = false;
  const deps = buildDeps(createAgent(fixture.root));

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 0, 'the walk-up press must never fire on a disabled target');
  assert.deepEqual(fixture.calls.typed, []);

  const typeResult = await runCdpReplayCommands([{ inputText: '0451' }], {}, deps, {
    initialFocusId: 'otp_email',
  });

  assert.equal(typeResult.passed, false);
  assert.equal(typeResult.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(typeResult.reason ?? '', /disabled/);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: an accessibility-disabled input refuses tap and type', async () => {
  const fixture = otpFixture();
  fixture.inputHost.memoizedProps.accessibilityState = { disabled: true };
  const deps = buildDeps(createAgent(fixture.root));

  const tapResult = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(tapResult.passed, false);
  assert.equal(tapResult.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(tapResult.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, []);

  const typeResult = await runCdpReplayCommands([{ inputText: '0451' }], {}, deps, {
    initialFocusId: 'otp_email',
  });

  assert.equal(typeResult.passed, false);
  assert.equal(typeResult.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(typeResult.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: the live gate rechecks a host input disabled after tree proof', async () => {
  const fixture = otpFixture();
  let disabledBeforeInteract = false;
  const agent = createAgent(fixture.root, (expression) => {
    if (!disabledBeforeInteract && expression.startsWith('__QAREN.interact(')) {
      fixture.inputHost.memoizedProps.editable = false;
      disabledBeforeInteract = true;
    }
  });
  const deps = buildDeps(agent);

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(disabledBeforeInteract, true);
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: type rechecks a newly disabled selected host candidate', async () => {
  const fixture = otpFixture();
  delete fixture.inputHost.memoizedProps.testID;
  let interactCalls = 0;
  const agent = createAgent(fixture.root, (expression) => {
    if (expression.startsWith('__QAREN.interact(')) {
      interactCalls += 1;
      if (interactCalls === 2) fixture.inputHost.memoizedProps.editable = false;
    }
  });
  const deps = buildDeps(agent);

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(interactCalls, 2);
  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 1);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /disabled/);
  assert.equal(fixture.calls.focus, 1);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: exact-ID lineage pointer and hidden state refuse tap and type', async (t) => {
  const cases: Array<{
    label: string;
    apply: (fixture: ReturnType<typeof otpFixture>) => void;
    reason: RegExp;
  }> = [
    {
      label: 'host target box-none',
      apply: (fixture) => {
        fixture.inputHost.memoizedProps.pointerEvents = 'box-none';
      },
      reason: /pointerEvents/,
    },
    {
      label: 'input beneath an out-of-lineage box-only host',
      apply: (fixture) => {
        fixture.pressableHost.memoizedProps.pointerEvents = 'box-only';
      },
      reason: /pointerEvents/,
    },
    {
      label: 'hidden host',
      apply: (fixture) => {
        fixture.inputHost.memoizedProps.style = { display: 'none' };
      },
      reason: /hidden/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.label, async () => {
      const fixture = otpFixture();
      testCase.apply(fixture);
      const deps = buildDeps(createAgent(fixture.root));

      const tapResult = await runCdpReplayCommands(
        [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
        {},
        deps,
      );
      const typeResult = await runCdpReplayCommands([{ inputText: '0451' }], {}, deps, {
        initialFocusId: 'otp_email',
      });

      assert.equal(tapResult.passed, false);
      assert.equal(tapResult.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.match(tapResult.reason ?? '', testCase.reason);
      assert.equal(typeResult.passed, false);
      assert.equal(typeResult.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.match(typeResult.reason ?? '', testCase.reason);
      assert.equal(fixture.calls.focus, 0);
      assert.deepEqual(fixture.calls.typed, []);
    });
  }
});

test('#869 projection: interactive fallback marks a non-editable host input disabled', async () => {
  const fixture = otpFixture();
  fixture.inputHost.memoizedProps.editable = false;
  const result = await createAgent(fixture.root).evaluate(
    '__QAREN.getTree({"interactiveOnly":true})',
  );
  assert.equal(result.error, undefined);
  const data = JSON.parse(result.value as string) as {
    interactive: Array<{ testID?: string; disabled?: boolean }>;
  };
  const inputs = data.interactive.filter((entry) => entry.testID === 'otp_email');
  assert.equal(
    inputs.some((entry) => entry.disabled === true),
    true,
  );
});

test('#869 control: a disabled nearest pressable refuses without walking farther', async (t) => {
  for (const [label, disabledProps] of [
    ['disabled prop', { disabled: true }],
    ['accessibility state', { accessibilityState: { disabled: true } }],
  ] as const) {
    await t.test(label, async () => {
      let outerPresses = 0;
      const root = makeFiber('Root');
      const app = appendChild(root, makeFiber({ displayName: 'App' }));
      const outerPressable = appendChild(
        app,
        makeFiber(
          { displayName: 'Pressable' },
          {
            onPress: () => {
              outerPresses += 1;
            },
          },
        ),
      );
      let innerPresses = 0;
      const innerPressable = appendChild(
        outerPressable,
        makeFiber(
          { displayName: 'Pressable' },
          {
            ...disabledProps,
            onPress: () => {
              innerPresses += 1;
            },
          },
        ),
      );
      const innerHost = appendChild(innerPressable, makeFiber('RCTView'));
      appendChild(innerHost, makeFiber({ displayName: 'Text' }, { testID: 'submit_label' }));
      const deps = buildDeps(createAgent(root));

      const result = await runCdpReplayCommands([{ tapOn: { id: 'submit_label' } }], {}, deps);

      assert.equal(result.passed, false);
      assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
      assert.match(result.reason ?? '', /disabled/);
      assert.equal(innerPresses, 0);
      assert.equal(outerPresses, 0, 'the walk must not skip past a disabled nearest pressable');
    });
  }
});

test('#869 control: an input behind an active modal subtree refuses the tap', async () => {
  const fixture = otpFixture();
  const sheetBranch = appendChild(fixture.app, makeFiber({ displayName: 'View' }));
  const modal = appendChild(
    sheetBranch,
    makeFiber({ displayName: 'View' }, { accessibilityViewIsModal: true }),
  );
  appendChild(modal, makeFiber({ displayName: 'Text' }, { children: 'blocking sheet' }));
  const deps = buildDeps(createAgent(fixture.root));

  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'otp_email' } }, { inputText: '0451' }],
    {},
    deps,
  );

  assert.equal(result.passed, false);
  assert.match(result.reason ?? '', /behind the active modal/);
  assert.equal(fixture.calls.focus, 0);
  assert.deepEqual(fixture.calls.typed, []);
});

test('#869 control: duplicate testIDs across distinct inputs refuse before any press', async () => {
  const calls = { first: 0, second: 0 };
  const root = makeFiber('Root');
  const app = appendChild(root, makeFiber({ displayName: 'App' }));
  for (const key of ['first', 'second'] as const) {
    const pressable = appendChild(
      app,
      makeFiber(
        { displayName: 'Pressable' },
        {
          onPress: () => {
            calls[key] += 1;
          },
        },
      ),
    );
    appendChild(
      pressable,
      makeFiber({ displayName: 'TextInput' }, { testID: 'dup_input', value: '' }),
    );
  }
  const deps = buildDeps(createAgent(root));

  const result = await runCdpReplayCommands([{ tapOn: { id: 'dup_input' } }], {}, deps);

  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'AMBIGUOUS_TESTID');
  assert.equal(calls.first, 0);
  assert.equal(calls.second, 0);
});

test('#869 control: a type step without a preceding exact tap target refuses', async () => {
  const deps = buildDeps(createAgent(makeFiber('Root')));

  const result = await runCdpReplayCommands([{ inputText: '0451' }], {}, deps);

  assert.equal(result.passed, false);
  assert.match(result.reason ?? '', /inputText before any tapOn/);
});
