// GH #60 Bug 5 / D684: cdp_interact accessibilityLabel matching was strict-equal
// only — case/whitespace differences (and non-exact strings like "Continue" vs
// "Continue button") returned "Component not found" on visible buttons.
// cdp_component_tree filter only matched component name + testID/nativeID, so
// "Home" against a tab labeled accessibilityLabel="Home" returned tree:null.
//
// Fix: tiered match for the accessibilityLabel branch of interact() (exact →
// trim+lowercase → substring) with a structured Ambiguous error when the
// chosen tier has >1 hit. testID stays strict + early-return. getTree filter
// gains accessibilityLabel as a third matched field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

function createSandbox(opts = {}) {
  const sandbox = {
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
      getFiberRoots: (id) => (id === 1 ? new Set([{ current: opts.fiberRoot }]) : new Set()),
    };
  }

  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

// Build a simple fiber tree: parent → child → sibling chain
// Each spec is { name, props, children?, sibling? }
function buildFiber(spec, parent = null) {
  const fiber = {
    type: spec.name ? { displayName: spec.name } : null,
    memoizedProps: spec.props || {},
    return: parent,
    child: null,
    sibling: null,
    stateNode: spec.stateNode || null,
  };
  if (spec.children && spec.children.length > 0) {
    let prev = null;
    for (const c of spec.children) {
      const child = buildFiber(c, fiber);
      if (!fiber.child) fiber.child = child;
      else prev.sibling = child;
      prev = child;
    }
  }
  return fiber;
}

// ── interact() — testID strict equality (regression guard) ──────────────

test('interact: testID exact match still works (strict ===)', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { testID: 'continue-btn', onPress: () => {} } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.interact({ action: 'press', testID: 'continue-btn' }));
  assert.equal(result.success, true);
  assert.equal(result.testID, 'continue-btn');
});

test('interact: testID case-mismatch still fails (testID stays strict)', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { testID: 'Continue-Btn', onPress: () => {} } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.interact({ action: 'press', testID: 'continue-btn' }));
  assert.equal(result.error, 'Component not found');
});

// ── interact() — accessibilityLabel tier 1: exact match ─────────────────

test('interact: accessibilityLabel exact === match presses', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          accessibilityLabel: 'Continue',
          onPress: () => {
            pressed = true;
          },
        },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.success, true);
  assert.equal(pressed, true);
});

// ── interact() — tier 2: normalized match (trim + collapse-ws + lowercase) ──

test('interact: accessibilityLabel matches across trailing whitespace', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          accessibilityLabel: 'Continue ',
          onPress: () => {
            pressed = true;
          },
        },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.success, true);
  assert.equal(pressed, true);
});

test('interact: accessibilityLabel matches case-insensitively', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          accessibilityLabel: 'Continue',
          onPress: () => {
            pressed = true;
          },
        },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'continue' }),
  );
  assert.equal(result.success, true);
  assert.equal(pressed, true);
});

test('interact: accessibilityLabel matches across collapsed inner whitespace', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          accessibilityLabel: 'Sign  In',
          onPress: () => {
            pressed = true;
          },
        },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'sign in' }),
  );
  assert.equal(result.success, true);
  assert.equal(pressed, true);
});

// ── interact() — tier 3: substring contains ─────────────────────────────

test('interact: accessibilityLabel substring fallback presses single match', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          accessibilityLabel: 'Continue button',
          onPress: () => {
            pressed = true;
          },
        },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.success, true);
  assert.equal(pressed, true);
});

// ── interact() — tier-priority: exact wins over later tiers (no false ambiguity) ──

test('interact: exact match wins over substring sibling — no ambiguity', () => {
  let pressedExact = false;
  let pressedSubstring = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          accessibilityLabel: 'Continue',
          onPress: () => {
            pressedExact = true;
          },
        },
      },
      {
        name: 'Pressable',
        props: {
          accessibilityLabel: 'Continue button',
          onPress: () => {
            pressedSubstring = true;
          },
        },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.success, true, result.error || 'should succeed');
  assert.equal(pressedExact, true, 'exact tier should take priority');
  assert.equal(pressedSubstring, false, 'substring sibling must not fire');
});

// ── interact() — ambiguity error when chosen tier has >1 match ──────────

test('interact: two exact matches return Ambiguous error with both descriptors', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { accessibilityLabel: 'Continue', testID: 'a', onPress: () => {} },
      },
      {
        name: 'Pressable',
        props: { accessibilityLabel: 'Continue', testID: 'b', onPress: () => {} },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.error, 'Ambiguous component match');
  assert.equal(result.count, 2);
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches.map((m) => m.testID).sort(), ['a', 'b']);
  assert.match(result.hint, /Add a testID/);
});

test('interact: substring tier ambiguity returns error (does not silently pick first)', () => {
  let firstPressed = false;
  let secondPressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: {
          accessibilityLabel: 'Continue button',
          onPress: () => {
            firstPressed = true;
          },
        },
      },
      {
        name: 'Pressable',
        props: {
          accessibilityLabel: 'Continue link',
          onPress: () => {
            secondPressed = true;
          },
        },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.error, 'Ambiguous component match');
  assert.equal(firstPressed, false);
  assert.equal(secondPressed, false);
});

// ── interact() — not-found shape includes new hint ──────────────────────

test('interact: accessibilityLabel no match returns Component not found with tiered hint', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { accessibilityLabel: 'Cancel', onPress: () => {} } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.error, 'Component not found');
  assert.match(result.hint, /exact, case\/whitespace-normalized, and substring/);
  assert.match(result.hint, /cdp_component_tree/);
});

// ── interact() — non-string accessibilityLabel values must not crash ────

test('interact: handles falsy/non-string accessibilityLabel values without crashing', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      { name: 'Pressable', props: { accessibilityLabel: false, onPress: () => {} } },
      { name: 'Pressable', props: { accessibilityLabel: null, onPress: () => {} } },
      { name: 'Pressable', props: { accessibilityLabel: '', onPress: () => {} } },
      { name: 'Pressable', props: { accessibilityLabel: 'Continue', onPress: () => {} } },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__QAREN.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.success, true);
});

// ── getTree() — filter now matches accessibilityLabel ───────────────────

test('getTree: filter matches accessibilityLabel (the Home tab case)', () => {
  const root = buildFiber({
    name: 'NavigationContainer',
    children: [
      {
        name: 'BottomTabItem',
        props: { accessibilityLabel: 'Home' },
      },
      {
        name: 'BottomTabItem',
        props: { accessibilityLabel: 'Settings' },
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.getTree({ filter: 'Home', maxDepth: 4 }));
  assert.notEqual(
    result.tree,
    null,
    'filter "Home" should now find the BottomTabItem with accessibilityLabel:"Home"',
  );
});

test('getTree: filter against name + testID still works (regression)', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'CartBadge', props: { testID: 'cart-badge' } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const byName = JSON.parse(sandbox.__QAREN.getTree({ filter: 'CartBadge', maxDepth: 4 }));
  assert.notEqual(byName.tree, null);
  const byTestID = JSON.parse(sandbox.__QAREN.getTree({ filter: 'cart-badge', maxDepth: 4 }));
  assert.notEqual(byTestID.tree, null);
});

test('getTree: filter is case-insensitive on accessibilityLabel', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { accessibilityLabel: 'Submit Form' } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.getTree({ filter: 'submit', maxDepth: 4 }));
  assert.notEqual(result.tree, null);
});

test('getTree: filter with no match returns tree:null with rootsSeeded count', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { accessibilityLabel: 'Cancel' } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.getTree({ filter: 'NotPresent', maxDepth: 4 }));
  assert.equal(result.tree, null);
  assert.ok(typeof result.rootsSeeded === 'number');
});

// ── source-grep regression guard: ensure helper code doesn't drift ──────

test('source guard: interact() has tiered match scaffolding', () => {
  assert.match(INJECTED_HELPERS, /var exactMatches = \[\];/);
  assert.match(INJECTED_HELPERS, /var normMatches = \[\];/);
  assert.match(INJECTED_HELPERS, /var containsMatches = \[\];/);
  assert.match(INJECTED_HELPERS, /Ambiguous component match/);
});

test('source guard: getTree filter checks accessibilityLabel', () => {
  assert.match(INJECTED_HELPERS, /matchesLabel/);
  assert.match(INJECTED_HELPERS, /matchesName \|\| matchesTestID \|\| matchesLabel/);
});
