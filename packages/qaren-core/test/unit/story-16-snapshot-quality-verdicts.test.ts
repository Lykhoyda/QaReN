// Story 16 (GH #409) — snapshot quality verdicts: degraded captures must say
// so. A sparse/empty tree caused by a degraded walk (renderer errors, unscanned
// renderers, scan-budget exhaustion, depth caps) was previously
// indistinguishable from a legitimately empty screen, so agents confidently
// acted on a lie. Every capture now carries a structured verdict computed at
// capture time, degraded interactive captures fail closed, and sparse results
// never overwrite the last-known-good ref map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { createComponentTreeHandler } from '../../dist/handlers/component-tree.js';
import { updateRefMapFromFlat, clearRefMap } from '../../dist/fast-runner-ref-map.js';
import { buildRunIOSArgs, _setRunAgentDeviceForTest } from '../../dist/agent-device-wrapper.js';
import {
  fetchSnapshotNodes,
  fetchSnapshotNodesForSameScreenProof,
} from '../../dist/handlers/device-interact.js';
import { okResult } from '../../dist/utils.js';
import {
  runIOS,
  _setRunnerStateForTest,
  _setFetchForTest,
} from '../../dist/runners/rn-fast-runner-client.js';

// ── VM sandbox for the injected helpers ─────────────────────────────

function createSandbox(opts = {}) {
  const sandbox = {
    globalThis: {},
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
  if (opts.hook) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = opts.hook;
  } else if (opts.fiberRoot) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      // Real hooks only return roots for registered renderer ids — an
      // id-blind mock would seed the same root once per probed id.
      getFiberRoots: (id) => (id === 1 ? new Set([{ current: opts.fiberRoot }]) : new Set()),
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

function userComp(name, child) {
  return { tag: 1, type: { displayName: name }, memoizedProps: {}, child, sibling: null };
}

// ── getTree verdicts (computed at capture, inside the helper) ────────

test('getTree: healthy full walk carries verdict.state ok', () => {
  const fiber = userComp('App', userComp('Home', null));
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__QAREN.getTree({ maxDepth: 4 }));
  assert.ok(result.verdict, 'every capture must carry a verdict');
  assert.equal(result.verdict.state, 'ok');
  assert.equal(result.verdict.path, 'full');
  assert.deepEqual(result.verdict.reasons, []);
  assert.equal(result.verdict.rootsSeeded, 1);
  assert.equal(result.verdict.rendererErrors, 0);
  assert.equal(result.verdict.complete, true);
});

test('getTree: a throwing renderer degrades the verdict (renderer-error)', () => {
  const fiber = userComp('App', null);
  const hook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (id) => {
      if (id === 1) return new Set([{ current: fiber }]);
      if (id === 2) throw new Error('renderer teardown mid-walk');
      return new Set();
    },
  };
  const sandbox = createSandbox({ hook });
  const result = JSON.parse(sandbox.__QAREN.getTree({ maxDepth: 4 }));
  assert.equal(result.verdict.state, 'degraded');
  assert.ok(result.verdict.reasons.includes('renderer-error'));
  assert.equal(result.verdict.rendererErrors, 1);
  assert.equal(result.verdict.complete, false);
  assert.ok(result.tree, 'partial tree is still returned, just marked degraded');
});

test('getTree: renderer registered beyond the legacy early-exit window is scanned (GH #597, was #126 class)', () => {
  const fiber = userComp('App', null);
  const hook = {
    renderers: new Map([[9, {}]]),
    getFiberRoots: (id) => (id === 9 ? new Set([{ current: fiber }]) : new Set()),
  };
  const sandbox = createSandbox({ hook });
  const result = JSON.parse(sandbox.__QAREN.getTree({ maxDepth: 4 }));
  assert.equal(
    result.error,
    undefined,
    'registered renderer 9 is discovered via the registry union',
  );
  assert.ok(result.tree, 'tree from the high-id renderer is returned');
  assert.equal(result.verdict.state, 'ok');
  assert.equal(result.verdict.complete, true);
  assert.ok(!result.verdict.reasons.includes('renderers-unscanned'));
  assert.deepEqual(result.verdict.unscannedRendererIds ?? [], []);
});

test('getTree: exact renderer membership marks an unvisited target renderer incomplete', () => {
  const earlyFiber = userComp('EarlyRenderer', null);
  const lateFiber = {
    tag: 1,
    type: { displayName: 'LateRenderer' },
    memoizedProps: { testID: 'late-target' },
    child: null,
    sibling: null,
    return: null,
  };
  const hook = {
    renderers: {
      keys: () => new Map([[40, {}]]).keys(),
      forEach: (callback: (value: object, id: number) => void) => {
        callback({}, 1);
        callback({}, 30);
        callback({}, 40);
      },
    },
    getFiberRoots: (id: number) => {
      if (id === 1) return new Set([{ current: earlyFiber }]);
      if (id === 30) return new Set([{ current: lateFiber }]);
      return new Set();
    },
  };
  const sandbox = createSandbox({ hook });
  const result = JSON.parse(sandbox.__QAREN.getTree({ filter: 'late-target' }));
  assert.equal(result.tree, null);
  assert.equal(result.verdict.state, 'degraded');
  assert.deepEqual(result.verdict.reasons, ['renderers-unscanned']);
  assert.deepEqual(result.verdict.unscannedRendererIds, [30]);
  assert.equal(result.verdict.complete, false);
});

test('getTree: an unenumerable renderer registry refuses complete absence', () => {
  const root = userComp('App', null);
  const hook = {
    renderers: {
      keys: () => {
        throw new Error('renderer registry is unreadable');
      },
      forEach: () => {},
    },
    getFiberRoots: (id: number) => (id === 1 ? new Set([{ current: root }]) : new Set()),
  };
  const sandbox = createSandbox({ hook });
  const result = JSON.parse(sandbox.__QAREN.getTree({ filter: 'missing' }));
  assert.equal(result.tree, null);
  assert.equal(result.verdict.state, 'degraded');
  assert.ok(result.verdict.reasons.includes('renderer-error'));
  assert.equal(result.verdict.complete, false);
});

test('getTree: a fully scanned filtered absence is complete', () => {
  const sandbox = createSandbox({ fiberRoot: userComp('App', null) });
  const result = JSON.parse(sandbox.__QAREN.getTree({ filter: 'missing' }));
  assert.equal(result.tree, null);
  assert.equal(result.verdict.state, 'ok');
  assert.deepEqual(result.verdict.reasons, []);
  assert.equal(result.verdict.rootsSeeded, 1);
  assert.equal(result.verdict.complete, true);
});

test('getTree: filter no-match after budget exhaustion is degraded, not a clean empty', () => {
  let node = null;
  for (let i = 0; i < 2500; i++) {
    node = { tag: 5, type: null, memoizedProps: {}, child: node, sibling: null, return: null };
  }
  const sandbox = createSandbox({ fiberRoot: node });
  const result = JSON.parse(sandbox.__QAREN.getTree({ filter: 'zzz-no-match' }));
  assert.equal(result.tree, null);
  assert.equal(result.verdict.state, 'degraded');
  assert.ok(result.verdict.reasons.includes('scan-budget-exhausted'));
  assert.equal(result.verdict.path, 'filter');
  assert.equal(result.verdict.complete, false);
});

test('getTree: depth-cap drops are counted in the verdict without flipping state', () => {
  const fiber = userComp(
    'L1',
    userComp('L2', userComp('L3', userComp('L4', userComp('L5', userComp('L6', null))))),
  );
  const sandbox = createSandbox({ fiberRoot: fiber });
  const result = JSON.parse(sandbox.__QAREN.getTree({ maxDepth: 2 }));
  assert.equal(result.verdict.state, 'ok', 'a requested depth cap is not degradation');
  assert.ok(result.verdict.droppedSubtrees >= 1, 'but the drop must be visible');
  assert.equal(result.verdict.effectiveDepth, 2);
  assert.equal(result.verdict.complete, false);
});

test('getTree: interactiveOnly cap marks the verdict degraded (scan-budget-exhausted)', () => {
  let first = null;
  let prev = null;
  for (let i = 0; i < 250; i++) {
    const btn = {
      tag: 1,
      type: { displayName: 'Btn' + i },
      memoizedProps: { onPress: () => {} },
      child: null,
      sibling: null,
    };
    if (prev) prev.sibling = btn;
    else first = btn;
    prev = btn;
  }
  const root = {
    tag: 1,
    type: { displayName: 'App' },
    memoizedProps: {},
    child: first,
    sibling: null,
  };
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(sandbox.__QAREN.getTree({ interactiveOnly: true }));
  assert.equal(result.truncated, true, 'existing truncation flag stays');
  assert.equal(result.verdict.state, 'degraded');
  assert.ok(result.verdict.reasons.includes('scan-budget-exhausted'));
  assert.equal(result.verdict.path, 'interactive');
  assert.equal(result.verdict.complete, false);
});

test('getTree: missing hook fails with a no-renderer verdict', () => {
  const sandbox = createSandbox({});
  const result = JSON.parse(sandbox.__QAREN.getTree({}));
  assert.ok(result.error);
  assert.equal(result.verdict.state, 'failed');
  assert.ok(result.verdict.reasons.includes('no-renderer'));
  assert.equal(result.verdict.complete, false);
});

// ── cdp_component_tree renders the verdict as meta.treeVerdict ───────

test('component_tree: lifts the capture verdict into meta.treeVerdict', async () => {
  const payload = {
    tree: { component: 'App' },
    totalNodes: 12,
    rootsSeeded: 1,
    verdict: { state: 'degraded', path: 'full', reasons: ['renderer-error'], complete: false },
  };
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(payload) }),
  });
  const handler = createComponentTreeHandler(() => client);
  const result = await handler({ depth: 3 });
  const env = parseEnvelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.meta?.treeVerdict?.state, 'degraded');
  assert.deepEqual(env.meta?.treeVerdict?.reasons, ['renderer-error']);
  assert.equal(env.meta?.treeVerdict?.complete, false);
  assert.equal(env.data.verdict, undefined, 'verdict renders once, in meta');
});

test('component_tree: failed capture returns failResult carrying the verdict', async () => {
  const payload = {
    error: 'React DevTools hook not available or no fiber roots — app may still be loading',
    verdict: { state: 'failed', path: 'none', reasons: ['no-renderer'] },
  };
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(payload) }),
  });
  const handler = createComponentTreeHandler(() => client);
  const result = await handler({ depth: 3 });
  const env = parseEnvelope(result);
  assert.equal(env.ok, false);
  assert.equal(result.isError, true);
  assert.equal(env.meta?.treeVerdict?.state, 'failed');
});

// ── ref map: sparse captures never overwrite last-known-good ─────────

test('updateRefMapFromFlat: empty capture preserves the last-known-good map', () => {
  clearRefMap();
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 10, y: 20, width: 100, height: 40 } },
    { ref: '@e1', type: 'TextInput', rect: { x: 10, y: 80, width: 100, height: 40 } },
  ]);
  const outcome = updateRefMapFromFlat([]);
  assert.deepEqual(outcome, { applied: false, reason: 'empty-capture' });
  assert.deepEqual(
    buildRunIOSArgs(['tap', '@e0']),
    { command: 'tap', x: 60, y: 40 },
    'refs stay bound to the last verified capture',
  );
  clearRefMap();
});

test('updateRefMapFromFlat: a non-empty capture still replaces the map', () => {
  clearRefMap();
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 10, y: 20, width: 100, height: 40 } },
  ]);
  const outcome = updateRefMapFromFlat([
    { ref: '@e5', type: 'Button', rect: { x: 0, y: 0, width: 50, height: 50 } },
  ]);
  assert.equal(outcome.applied, true);
  assert.deepEqual(buildRunIOSArgs(['tap', '@e5']), { command: 'tap', x: 25, y: 25 });
  assert.deepEqual(
    buildRunIOSArgs(['tap', '@e0']),
    { command: 'tap', _staleRef: '@e0' },
    'old generation coordinates are not served',
  );
  clearRefMap();
});

// ── runner snapshot path: meta.snapshotVerdict ───────────────────────

test('runIOS snapshot: empty capture is a degraded verdict and does not clobber the ref map', async () => {
  clearRefMap();
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', rect: { x: 10, y: 20, width: 100, height: 40 } },
  ]);
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  _setFetchForTest(async () => ({ json: async () => ({ ok: true, data: { nodes: [] } }) }));
  try {
    const result = await runIOS({ command: 'snapshot' });
    const env = parseEnvelope(result);
    assert.equal(env.ok, true);
    assert.equal(env.meta?.snapshotVerdict?.state, 'degraded');
    assert.ok(env.meta?.snapshotVerdict?.reasons?.includes('empty-capture'));
    assert.equal(env.meta?.snapshotVerdict?.refMapUpdated, false);
    assert.deepEqual(
      buildRunIOSArgs(['tap', '@e0']),
      { command: 'tap', x: 60, y: 40 },
      'last-known-good refs survive the sparse capture',
    );
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
    clearRefMap();
  }
});

test('runIOS snapshot: healthy capture carries an ok verdict and updates the ref map', async () => {
  clearRefMap();
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  _setFetchForTest(async () => ({
    json: async () => ({
      ok: true,
      data: {
        nodes: [
          { index: 0, type: 'Button', rect: { x: 10, y: 20, width: 100, height: 40 }, label: 'Go' },
        ],
      },
    }),
  }));
  try {
    const result = await runIOS({ command: 'snapshot' });
    const env = parseEnvelope(result);
    assert.equal(env.ok, true);
    assert.equal(env.meta?.snapshotVerdict?.state, 'ok');
    assert.equal(env.meta?.snapshotVerdict?.nodeCount, 1);
    assert.equal(env.meta?.snapshotVerdict?.refMapUpdated, true);
    assert.deepEqual(buildRunIOSArgs(['tap', '@e0']), { command: 'tap', x: 60, y: 40 });
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
    clearRefMap();
  }
});

// ── interactive consumers fail closed on a zero-node capture ─────────

test('fetchSnapshotNodes: zero-node capture refuses with empty-capture instead of "nothing on screen"', async () => {
  _setRunAgentDeviceForTest(async () => okResult({ nodes: [] }));
  try {
    const snap = await fetchSnapshotNodes(false);
    assert.deepEqual(snap, { ok: false, reason: 'empty-capture' });
  } finally {
    _setRunAgentDeviceForTest(null);
  }
});

test('fetchSnapshotNodes can refuse runner-leak recovery for same-screen proof', async () => {
  let snapshotCalls = 0;
  _setRunAgentDeviceForTest(async () => {
    snapshotCalls += 1;
    return okResult({
      nodes: [{ ref: 'e0', label: 'AgentDeviceRunner', type: 'Application' }],
    });
  });
  try {
    const snap = await fetchSnapshotNodesForSameScreenProof();
    assert.deepEqual(snap, {
      ok: false,
      reason: 'runner-leak-unrecovered',
      recoveryReason: 'recovery-disabled-for-proof',
    });
    assert.equal(snapshotCalls, 1);
  } finally {
    _setRunAgentDeviceForTest(null);
  }
});
