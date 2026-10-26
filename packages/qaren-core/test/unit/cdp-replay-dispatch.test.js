import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCdpDispatch,
  replayTreeData,
  runCdpReplayCommands,
  unwrapTree,
} from '../../dist/handlers/cdp-replay-dispatch.js';
import { ReplayDispatchError } from '../../dist/domain/cdp-flow-replay.js';

// Contract: the REAL __QAREN.getTree() payload wraps the node under `.tree`
// (single match) or `.tree.matches[]` (multi match).
const GETTREE_SINGLE = { tree: { testID: 'fab-create-task', children: [] }, totalNodes: 1 };
const GETTREE_MULTI = {
  tree: {
    matches: [
      { testID: 'tab-tasks', children: [] },
      { testID: 'tab-feed', children: [] },
    ],
  },
  totalNodes: 2,
};

test('buildCdpDispatch accepts propagated fiber matches collapsed by the frontmost oracle', async () => {
  const calls = [];
  const dispatch = buildCdpDispatch({
    pressByTestId: async (id) => calls.push(id),
    typeByTestId: async () => {},
    treeFor: async () => ({
      tree: { matches: [{ testID: 'welcome' }, { testID: 'welcome' }] },
    }),
    frontmostFor: async () => ({ visible: true, matchCount: 1 }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await dispatch.press('welcome');
  assert.deepEqual(calls, ['welcome']);
});

test('visibility trusts the exact-ID oracle over substring-filtered tree evidence', async () => {
  // A screen name substring-matches the selector, so the filtered tree is a
  // complete non-null tree WITHOUT the exact testID. The pre-oracle gate threw
  // EVAL_FAILED here and killed the timed wait on its first poll (review-22).
  let mounted = false;
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => {},
    typeByTestId: async () => {},
    treeFor: async () =>
      unwrapTree(
        replayTreeData({
          ok: true,
          data: { tree: { name: 'OtpScreen', children: [] } },
          meta: {
            treeVerdict: {
              state: 'ok',
              path: 'filter',
              reasons: [],
              rootsSeeded: 1,
              complete: true,
              droppedSubtrees: 0,
              collapsedChildLists: 0,
            },
          },
        }),
      ),
    frontmostFor: async () =>
      mounted
        ? { visible: true, matchCount: 1 }
        : { visible: false, matchCount: 0, reason: 'testID is not mounted' },
    launchApp: async () => {},
    settle: async () => {},
  });
  const absent = await dispatch.visibility('otp');
  assert.equal(absent.visible, false);
  assert.equal(absent.code, 'TESTID_NOT_FOUND');
  assert.equal(absent.meta?.failedSelector, 'otp');
  mounted = true;
  assert.deepEqual(await dispatch.visibility('otp'), { visible: true });
});

test('exact presence despite incomplete descendants proceeds to the frontmost decision', async () => {
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => {},
    typeByTestId: async () => {},
    treeFor: async () =>
      unwrapTree(
        replayTreeData({
          ok: true,
          data: { tree: { testID: 'otp', children: [] } },
          meta: {
            treeVerdict: {
              state: 'ok',
              path: 'filter',
              reasons: [],
              rootsSeeded: 2,
              complete: false,
              droppedSubtrees: 1,
              collapsedChildLists: 0,
            },
          },
        }),
      ),
    frontmostFor: async () => ({
      visible: false,
      reason: 'testID is ambiguous across mounted React trees',
      matchCount: 2,
    }),
    launchApp: async () => {},
    settle: async () => {},
  });
  const verdict = await dispatch.visibility('otp');
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'AMBIGUOUS_TESTID');
  assert.match(verdict.reason ?? '', /resolves to 2 mounted elements/);
});

test('buildCdpDispatch revalidates a retained input target before mutation', async () => {
  let mutations = 0;
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => {},
    typeByTestId: async () => {
      mutations += 1;
    },
    treeFor: async () => ({ tree: { testID: 'stale-field', children: [] } }),
    frontmostFor: async () => ({ visible: false, reason: 'field is behind a modal' }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await assert.rejects(dispatch.type('stale-field', 'value'), /behind a modal/);
  assert.equal(mutations, 0);
});

test('exact oracle disabled state refuses mutation when the readable tree omits the target', async () => {
  let mutations = 0;
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => {
      mutations += 1;
    },
    typeByTestId: async () => {},
    treeFor: async () => ({ tree: { name: 'CollapsedScreen', children: [] } }),
    frontmostFor: async () => ({ visible: true, disabled: true, matchCount: 1 }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await assert.rejects(dispatch.press('disabled-action'), /disabled|non-interactable/);
  assert.equal(mutations, 0);
});

test('buildCdpDispatch refuses duplicate oracle matches as ambiguous', async () => {
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => {},
    typeByTestId: async () => {},
    treeFor: async () => ({
      tree: { matches: [{ testID: 'duplicate' }, { testID: 'duplicate' }] },
    }),
    frontmostFor: async () => ({
      visible: false,
      reason: 'testID is ambiguous across mounted React trees',
      matchCount: 2,
    }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await assert.rejects(dispatch.press('duplicate'), /resolves to 2 mounted elements/);
});

test('unwrapTree returns the bare node for a single match and the matches wrapper for many', () => {
  assert.deepEqual(unwrapTree(GETTREE_SINGLE), { testID: 'fab-create-task', children: [] });
  assert.deepEqual(unwrapTree(GETTREE_MULTI), {
    matches: [
      { testID: 'tab-tasks', children: [] },
      { testID: 'tab-feed', children: [] },
    ],
  });
  assert.equal(unwrapTree(null), null);
  // already a bare node (no `.tree`) → returned unchanged
  assert.deepEqual(unwrapTree({ testID: 'x', children: [] }), { testID: 'x', children: [] });
});

test('replayTreeData returns readable envelopes without exact-id verdict gating', () => {
  // Exact-ID presence/absence is oracle-owned; the substring-filtered tree may
  // no longer refuse readable data based on verdict quality or match content.
  const treeVerdict = {
    state: 'ok',
    path: 'filter',
    reasons: [],
    rootsSeeded: 1,
    complete: true,
    droppedSubtrees: 0,
    collapsedChildLists: 0,
  };
  for (const envelope of [
    { ok: true, data: { tree: { testID: 'otp', children: [] } }, meta: { treeVerdict } },
    { ok: true, data: { tree: { name: 'otp-container', children: [] } }, meta: { treeVerdict } },
    { ok: true, data: { tree: null }, meta: { treeVerdict } },
    {
      ok: true,
      data: { tree: null },
      meta: {
        treeVerdict: {
          ...treeVerdict,
          state: 'degraded',
          complete: false,
          reasons: ['scan-budget-exhausted'],
        },
      },
    },
    {
      ok: true,
      data: { tree: null },
      meta: { treeVerdict: { ...treeVerdict, complete: false, droppedSubtrees: 1 } },
    },
    {
      ok: true,
      data: { tree: { matches: Array.from({ length: 10 }, () => ({ testID: 'otp' })) } },
      meta: { treeVerdict },
    },
    {
      ok: true,
      data: { interactive: [{ testID: 'otp' }] },
      meta: { treeVerdict: { ...treeVerdict, path: 'interactive' } },
    },
  ]) {
    assert.deepEqual(replayTreeData(envelope), envelope.data);
  }
});

test('React replay propagates a component-tree transport envelope without selector repair evidence', async () => {
  const replay = await runCdpReplayCommands(
    [{ assertVisible: { id: 'ready' } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: false,
          code: 'RECONNECT_TIMEOUT',
          error: 'Component tree connection timed out',
          meta: { reconnectAttempted: true },
        }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'RECONNECT_TIMEOUT');
  assert.equal(replay.failureMeta?.failedSelector, 'ready');
  assert.equal(typeof replay.failureMeta?.waitedMs, 'number');
  assert.equal(replay.steps[0].t, 'assert');
  assert.deepEqual(replay.failureMeta?.treeEnvelope, {
    ok: false,
    code: 'RECONNECT_TIMEOUT',
    error: 'Component tree connection timed out',
    meta: { reconnectAttempted: true },
  });
});

test('React replay refuses a truncated component tree distinctly from readable absence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' }, timeout: 250 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: true,
          data: { __agent_truncated: true, originalLength: 75_000 },
        }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'EVAL_FAILED');
  assert.equal(replay.failedStepIndex, 0);
  assert.deepEqual(replay.failureMeta?.treeEnvelope, {
    ok: true,
    truncated: true,
    originalLength: 75_000,
  });
});

test('React replay refuses a serialization sentinel distinctly from exact-ID absence', async () => {
  let oracleReads = 0;
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' }, timeout: 250 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: true,
          data: { __agent_error: 'Serialization failed: cyclic fiber value' },
        }),
      frontmostFor: async () => {
        oracleReads += 1;
        return { visible: false, matchCount: 0 };
      },
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'EVAL_FAILED');
  assert.notEqual(replay.failureCode, 'TESTID_NOT_FOUND');
  assert.equal(oracleReads, 0);
  assert.deepEqual(replay.failureMeta?.treeEnvelope, {
    ok: true,
    agentError: 'Serialization failed: cyclic fiber value',
  });
});

test('React replay refuses helper-truncated filtered evidence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' }, timeout: 250 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: true,
          data: { tree: { testID: 'otp' }, truncated: true },
          meta: {
            treeVerdict: {
              state: 'degraded',
              path: 'filter',
              reasons: ['output-truncated'],
            },
          },
        }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'EVAL_FAILED');
  assert.equal(replay.failureMeta?.treeEnvelope?.truncated, true);
});

test('React replay refuses oracle budget exhaustion distinctly from absence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' }, timeout: 250 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: true,
          data: { tree: null },
          meta: {
            treeVerdict: {
              state: 'degraded',
              path: 'filter',
              reasons: ['scan-budget-exhausted'],
            },
          },
        }),
      frontmostFor: async () => ({
        visible: false,
        code: 'ASSERTION_FAILED',
        reason: 'frontmost testID scan exceeded its bounded React-tree budget',
      }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'ASSERTION_FAILED');
  assert.match(replay.reason ?? '', /bounded React-tree budget/);
  assert.equal(replay.failureMeta?.failedSelector, 'otp');
});

test('React replay refuses oracle renderer-coverage gaps distinctly from absence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' }, timeout: 250 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () => ({ tree: null }),
      frontmostFor: async () => ({
        visible: false,
        code: 'ASSERTION_FAILED',
        reason: 'frontmost proof cannot cover every mounted renderer',
      }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'ASSERTION_FAILED');
  assert.match(replay.reason ?? '', /cannot cover every mounted renderer/);
});

const COVERAGE = {
  reasons: ['renderer-error'],
  registeredRendererIds: [1, 2],
  erroredRendererIds: [3],
  unscannedRendererIds: [],
  rendererErrors: 1,
  extraRootsError: false,
  scanFinished: true,
};

function coverageDispatch(frontmost) {
  return buildCdpDispatch({
    pressByTestId: async () => {},
    typeByTestId: async () => {},
    treeFor: async () => ({ tree: { testID: 'otp', children: [] } }),
    frontmostFor: async () => frontmost,
    launchApp: async () => {},
    settle: async () => {},
  });
}

test('visibility and interactable assertion disclose oracle coverage meta', async () => {
  const frontmost = {
    visible: false,
    code: 'ASSERTION_FAILED',
    reason: 'frontmost proof cannot cover every mounted renderer',
    coverage: COVERAGE,
  };
  const dispatch = coverageDispatch(frontmost);
  const verdict = await dispatch.visibility('otp');
  assert.deepEqual(verdict.meta?.coverage, COVERAGE);
  await assert.rejects(dispatch.press('otp'), (error) => {
    assert.ok(error instanceof ReplayDispatchError);
    assert.deepEqual(error.meta?.coverage, COVERAGE);
    return true;
  });
});

test('visibility without coverage keeps today shape', async () => {
  const verdict = await coverageDispatch({
    visible: false,
    code: 'ASSERTION_FAILED',
    reason: 'frontmost proof cannot cover every mounted renderer',
  }).visibility('otp');
  assert.deepEqual(verdict, {
    visible: false,
    code: 'ASSERTION_FAILED',
    reason: 'frontmost proof cannot cover every mounted renderer',
  });
});

test('React replay propagates APP_HAS_REDBOX instead of reporting a missing testID', async () => {
  const replay = await runCdpReplayCommands(
    [{ tapOn: { id: 'submit' } }],
    {},
    {
      pressByTestId: async () => assert.fail('redbox must refuse before mutation'),
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: true,
          data: { message: 'App is showing an error screen.' },
          meta: { warning: 'APP_HAS_REDBOX', treeVerdict: { quality: 'unavailable' } },
        }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'APP_HAS_REDBOX');
  assert.equal(replay.failureMeta?.failedSelector, undefined);
  assert.deepEqual(replay.failureMeta?.treeEnvelope, {
    ok: true,
    warning: 'APP_HAS_REDBOX',
    message: 'App is showing an error screen.',
    meta: { warning: 'APP_HAS_REDBOX', treeVerdict: { quality: 'unavailable' } },
  });
});

test('disabled-guard fires on a node found through the getTree `.tree` wrapper', async () => {
  const calls = [];
  const deps = {
    pressByTestId: async (id) => {
      calls.push(id);
    },
    typeByTestId: async () => {},
    treeFor: async () => ({
      tree: { testID: 'save', disabled: true, children: [] },
      totalNodes: 1,
    }),
    frontmostFor: async () => ({ visible: true, matchCount: 1 }),
    launchApp: async () => {},
    settle: async () => {},
  };
  await assert.rejects(buildCdpDispatch(deps).press('save'), /disabled|non-interactable/);
  assert.deepEqual(calls, [], 'must not press a disabled node found through the wrapper');
});

test('press refuses a child beneath pointerEvents none or box-only ancestors', async () => {
  const calls = [];
  const base = {
    pressByTestId: async () => calls.push('press'),
    typeByTestId: async () => calls.push('type'),
    frontmostFor: async () => ({ visible: true, matchCount: 1 }),
    launchApp: async () => {},
    settle: async () => {},
  };
  for (const pointerEvents of ['none', 'box-only']) {
    await assert.rejects(
      buildCdpDispatch({
        ...base,
        treeFor: async () => ({
          tree: { props: { pointerEvents }, children: [{ testID: 'child', children: [] }] },
        }),
      }).press('child'),
      /not user-interactable/,
    );
  }
  assert.deepEqual(calls, []);
});

test('text input preserves box-none and auto ancestors but rejects hidden hit-testing', async () => {
  const calls = [];
  const tree = (pointerEvents) => ({
    tree: { props: { pointerEvents }, children: [{ testID: 'field', children: [] }] },
  });
  const make = (value) =>
    buildCdpDispatch({
      pressByTestId: async () => {},
      typeByTestId: async () => calls.push('type'),
      treeFor: async () => tree(value),
      frontmostFor: async () => ({ visible: true, matchCount: 1 }),
      launchApp: async () => {},
      settle: async () => {},
    });
  await make('box-none').type('field', 'ok');
  await make('auto').type('field', 'ok');
  await assert.rejects(make('none').type('field', 'no'), /not user-interactable/);
  assert.deepEqual(calls, ['type', 'type']);
});

test('target box-none refuses press and type without dispatch', async () => {
  const calls = [];
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => calls.push('press'),
    typeByTestId: async () => calls.push('type'),
    treeFor: async () => ({ tree: { testID: 'target', props: { pointerEvents: 'box-none' } } }),
    frontmostFor: async () => ({ visible: true, matchCount: 1 }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await assert.rejects(dispatch.press('target'), /target has pointerEvents="box-none"/);
  await assert.rejects(dispatch.type('target', 'value'), /target has pointerEvents="box-none"/);
  assert.deepEqual(calls, []);
});

// Regression test for #317: disabled-guard must resolve nativeID-identified nodes
function deps(tree) {
  const calls = [];
  return {
    calls,
    pressByTestId: async (id) => {
      calls.push(id);
    },
    typeByTestId: async () => {},
    treeFor: async () => tree,
    frontmostFor: async () => ({ visible: true, matchCount: 1 }),
    launchApp: async () => {},
    settle: async () => {},
  };
}

test('buildCdpDispatch.press: disabled node by testID → rejects, does not press', async () => {
  const d = deps({ testID: 'save', disabled: true, children: [] });
  await assert.rejects(buildCdpDispatch(d).press('save'));
  assert.deepEqual(d.calls, []);
});

test('buildCdpDispatch.press: disabled node by nativeID → rejects, does not press', async () => {
  const d = deps({ nativeID: 'save2', accessibilityState: { disabled: true }, children: [] });
  await assert.rejects(buildCdpDispatch(d).press('save2'));
  assert.deepEqual(d.calls, []);
});
