// Issue #104 — handler integration tests for cdp_run_action.
//
// Uses the dependency-injection seam (`RunActionDeps`) to stub the
// underlying maestro_run + repair-action handlers. The orchestration
// logic — failure parsing, auto-repair gating, RunRecord telemetry —
// is what's being tested; the underlying tools have their own coverage
// elsewhere.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPinnedRunActionHandler as createRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

let project;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a fake maestro_run handler that returns a pre-shaped envelope. */
function fakeMaestroRun(envelopes) {
  let i = 0;
  return async () => {
    const env = envelopes[Math.min(i, envelopes.length - 1)];
    i++;
    return {
      content: [{ type: 'text', text: JSON.stringify(env) }],
      ...(env.ok === false ? { isError: true } : {}),
    };
  };
}

/** Build a fake repair-action handler. */
function fakeRepairAction(envelope) {
  return async () => ({
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    ...(envelope.ok === false ? { isError: true } : {}),
  });
}

const PASS_ENV = {
  ok: true,
  data: { passed: true, output: 'Flow passed', flowFile: 'x', platform: 'ios' },
};
const FAIL_SELECTOR_ENV = {
  ok: false,
  data: {
    passed: false,
    output: "Element with id 'fab-create-task' not found",
    flowFile: 'x',
    platform: 'ios',
  },
};
const FAIL_TIMEOUT_ENV = {
  ok: false,
  data: {
    passed: false,
    output: "Timed out waiting for element with id 'spinner-done'",
    flowFile: 'x',
    platform: 'ios',
  },
};
const REPAIR_PATCHED_ENV = {
  ok: true,
  data: {
    patched: true,
    actionId: 'demo',
    oldSelector: 'fab-create-task',
    newSelector: 'fab-create-task-btn',
    score: 0.91,
    replacements: 1,
  },
};
const FAIL_TYPED_REACT_SELECTOR_ENV = {
  ok: false,
  error: 'React-tree replay failed at step 0: testID not present',
  code: 'TESTID_NOT_FOUND',
  meta: {
    proofDomain: 'react-tree',
    failedStepIndex: 0,
    failedSelector: 'fab-create-task',
  },
};
const FAIL_TYPED_PARTITIONED_NATIVE_SELECTOR_ENV = {
  ...FAIL_TYPED_REACT_SELECTOR_ENV,
  meta: {
    ...FAIL_TYPED_REACT_SELECTOR_ENV.meta,
    proofDomain: 'partitioned',
    proofDomains: ['react-tree', 'xctest-native'],
    failedProofDomain: 'xctest-native',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Validation paths
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: missing actionId returns BAD_FILENAME', async () => {
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const result = await handler({ projectRoot: project.root });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'BAD_FILENAME');
});

test('run-action: action not found returns NO_PROJECT_ROOT', async () => {
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const result = await handler({
    actionId: 'does-not-exist',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'NO_PROJECT_ROOT');
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — first attempt passes
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: first-attempt pass appends RunRecord with no auto-repair', async () => {
  const originalYaml = `${fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] })}# retained operator note\n`;
  project.seedAction('demo', originalYaml);

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, undefined);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.ok, true);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.autoRepair.attempted, false);
  assert.equal(env.data.autoRepair.outcome, 'skipped');
  assert.deepEqual(env.data.writes.actionYaml, {
    written: true,
    authorized: true,
    reason: 'lifecycle-promotion',
  });
  const promotedYaml = readFileSync(project.yamlPath('demo'), 'utf8');
  assert.equal(
    promotedYaml,
    originalYaml.replace('# status: experimental', '# status: active'),
    'lifecycle promotion must preserve every non-status YAML byte',
  );

  // Sidecar should have one RunRecord with status 'pass'.
  // Issue #120: even on the happy path we now record an autoRepair
  // entry with `outcome: 'skipped'` and `phases.firstAttemptMs` so MTTR
  // can compute baseline detection latency without auto-repair.
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory.length, 1);
  assert.equal(sidecar.runHistory[0].status, 'pass');
  assert.equal(sidecar.runHistory[0].trigger, 'agent');
  assert.equal(sidecar.runHistory[0].autoRepair?.attempted, false);
  assert.equal(sidecar.runHistory[0].autoRepair?.outcome, 'skipped');
  assert.equal(typeof sidecar.runHistory[0].autoRepair?.phases?.firstAttemptMs, 'number');
  assert.equal(typeof sidecar.runHistory[0].runId, 'string');
  assert.equal(sidecar.runHistory[0].timing.steps.length, 1);
  assert.equal(sidecar.runHistory[0].timing.steps[0].name, 'maestro-first-attempt');
  assert.equal(
    sidecar.runHistory[0].timing.elapsedMs,
    Date.parse(sidecar.runHistory[0].timing.endedAt) -
      Date.parse(sidecar.runHistory[0].timing.startedAt),
  );
  assert.equal(
    sidecar.runHistory[0].timing.steps[0].elapsedMs,
    Date.parse(sidecar.runHistory[0].timing.steps[0].endedAt) -
      Date.parse(sidecar.runHistory[0].timing.steps[0].startedAt),
  );
});

test('run-action: forwards handoff cancellation to session authority', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));
  const flowAbort = new AbortController();
  let receivedCompletion;
  let receivedReprove;
  const handler = createRunActionHandler({
    maestroRun: async (args) => {
      await args.reproveManagedOrigin({ signal: flowAbort.signal, readinessTimeoutMs: 123 });
      await args.completeNativeOrigin(true, flowAbort.signal);
      return {
        content: [{ type: 'text', text: JSON.stringify(PASS_ENV) }],
      };
    },
    completeNativeOrigin: async (args, targetExpected, signal) => {
      receivedCompletion = { args, targetExpected, signal };
    },
    reproveManagedOrigin: async (args, options) => {
      receivedReprove = { args, options };
    },
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, undefined);
  assert.equal(receivedReprove.args.actionId, 'demo');
  assert.equal(receivedReprove.options.signal, flowAbort.signal);
  assert.equal(receivedReprove.options.readinessTimeoutMs, 123);
  assert.equal(receivedCompletion.args.actionId, 'demo');
  assert.equal(receivedCompletion.targetExpected, true);
  assert.equal(receivedCompletion.signal, flowAbort.signal);
});

test('cdp_run_action preserves a typed native-blind refusal', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([
      {
        ok: false,
        code: 'NATIVE_SURFACE_BLIND',
        error: 'bounded native comparison proved a blind surface',
        meta: {
          proofDomain: 'xctest-native',
          runner: 'maestro-runner',
          transportVersion: '1.1.28',
          nativeVision: { source: 'rn-fast-runner-snapshot', runtimeMajor: 26 },
          cleanup: { cleanupProven: true },
          nextAction: 'run the native smoke on a healthy runtime',
        },
      },
    ]),
  });
  const env = JSON.parse(
    (await handler({ actionId: 'demo', projectRoot: project.root })).content[0].text,
  );
  assert.equal(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta.failureKind, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta.proofDomain, 'xctest-native');
  assert.equal(env.meta.transportVersion, '1.1.28');
  assert.equal(env.meta.nativeVision.runtimeMajor, 26);
  assert.equal(env.meta.cleanup.cleanupProven, true);
  assert.match(env.meta.nextAction, /native smoke/);
  assert.equal(project.readSidecar('demo').runHistory[0].failureCode, 'NATIVE_SURFACE_BLIND');
});

test('cdp_run_action records a typed runner deadline as TIMEOUT', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['spinner-done'] }));
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([
      {
        ok: false,
        code: 'RUNNER_TIMEOUT',
        error: 'React replay exceeded its deadline',
        meta: { proofDomain: 'react-tree' },
      },
    ]),
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const env = JSON.parse(result.content[0].text);

  assert.equal(env.code, 'RUNNER_TIMEOUT');
  assert.equal(project.readSidecar('demo').runHistory[0].failureCode, 'TIMEOUT');
});

test('run-action: proofReplay pass on an experimental action discloses no lifecycle-promotion write', async () => {
  const originalYaml = `${fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] })}# retained operator note\n`;
  project.seedAction('demo', originalYaml);

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const result = await handler({
    actionId: 'demo',
    projectRoot: project.root,
    proofReplay: true,
    autoRepair: false,
    forceReload: false,
  });

  assert.equal(result.isError, undefined);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.proofReplay, true);
  assert.deepEqual(env.data.writes.actionYaml, {
    written: false,
    reason: 'repair-not-applied',
  });
  assert.equal(env.data.writes.runtimeState, 'none');
  assert.equal(
    readFileSync(project.yamlPath('demo'), 'utf8'),
    originalYaml,
    'proofReplay must not promote or rewrite the tracked YAML',
  );
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory.length, 0, 'proofReplay must not append RunRecords');
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-repair end-to-end: SELECTOR_NOT_FOUND → repair → retry passes
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Auto-repair: repair patched, retry STILL fails → RunRecord shows
// AUTO_REPAIR_FAIL-equivalent.
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: partitioned native selector miss remains terminal', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));
  let repairCalls = 0;

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_TYPED_PARTITIONED_NATIVE_SELECTOR_ENV]),
    repairAction: async () => {
      repairCalls += 1;
      return fakeRepairAction(REPAIR_PATCHED_ENV)({});
    },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.equal(env.meta.autoRepair.attempted, false);
  assert.equal(repairCalls, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-repair refused: budget exhausted
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Auto-repair gating: autoRepair=false explicitly disables the path.
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: autoRepair=false skips repair entirely AND records USER_DISABLED refusedReason (PR #115 review)', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  let repairCalled = false;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    repairAction: async () => {
      repairCalled = true;
      return { content: [{ type: 'text', text: JSON.stringify(REPAIR_PATCHED_ENV) }] };
    },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, autoRepair: false });

  assert.equal(result.isError, true);
  assert.equal(repairCalled, false, 'repair handler MUST NOT be invoked when autoRepair=false');

  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.autoRepair.attempted, false);
  assert.equal(env.meta.autoRepair.outcome, 'refused');
  assert.equal(
    env.meta.autoRepair.refusedReason,
    'USER_DISABLED',
    'autoRepair=false must surface USER_DISABLED so MTTR can distinguish opt-out from genuine refusals',
  );

  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory[0].autoRepair.refusedReason, 'USER_DISABLED');
});

// PR #115 multi-LLM review (Gemini conf 95): a thrown exception during
// orchestration must NOT propagate uncaught to the MCP framework. It
// must be caught, persisted as a fail RunRecord with INTERNAL_ERROR
// refusedReason, and surfaced as a structured failResult.
test('run-action: maestroRun throwing during first attempt is caught + RunRecord persisted', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  const handler = createRunActionHandler({
    maestroRun: async () => {
      throw new Error('SIMULATED_TIMEOUT: maestro execFile killed');
    },
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });

  // Should NOT throw — should return a structured failResult.
  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  assert.equal(
    result.isError,
    true,
    'expected failResult, got envelope: ' + result.content[0].text,
  );

  const env = JSON.parse(result.content[0].text);
  assert.match(env.error, /SIMULATED_TIMEOUT/);
  assert.equal(env.meta.autoRepair.outcome, 'refused');
  assert.equal(env.meta.autoRepair.refusedReason, 'INTERNAL_ERROR');

  // Telemetry survived the throw.
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory.length, 1);
  assert.equal(sidecar.runHistory[0].status, 'fail');
  assert.equal(sidecar.runHistory[0].failureCode, 'UNKNOWN');
  assert.equal(sidecar.runHistory[0].autoRepair.refusedReason, 'INTERNAL_ERROR');
});

// PR #115 multi-LLM review (both providers conf ~88): mapRefusedReason
// disambiguates STALE_TARGET into BUDGET_EXHAUSTED vs EXTERNAL_EDIT by
// regexing the literal phrase "repair budget" in repair-action's
// error string. If repair-action's wording changes, BUDGET_EXHAUSTED
// would silently flip to EXTERNAL_EDIT and MTTR analytics would
// mis-categorise. This test locks the wording.
// ─────────────────────────────────────────────────────────────────────────────
// Non-repairable failure kinds (TIMEOUT, ASSERTION_FAILED, UNKNOWN) skip
// repair without invoking the handler.
// ─────────────────────────────────────────────────────────────────────────────

test('run-action: TIMEOUT failure does NOT invoke repair (phase 1 scope)', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['spinner-done'] }));

  let repairCalled = false;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_TIMEOUT_ENV]),
    repairAction: async () => {
      repairCalled = true;
      return { content: [{ type: 'text', text: JSON.stringify(REPAIR_PATCHED_ENV) }] };
    },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, true);
  assert.equal(repairCalled, false, 'TIMEOUT failures are not auto-repairable in phase 1');

  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.autoRepair.attempted, false);
  assert.equal(env.meta.autoRepair.outcome, 'skipped');
  assert.equal(env.meta.autoRepair.refusedReason, 'NOT_REPAIRABLE_KIND');

  // RunRecord uses the action-domain code (TIMEOUT, not TESTID_NOT_FOUND).
  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory[0].failureCode, 'TIMEOUT');
});

test('run-action: APP_HAS_REDBOX tree failure never enters selector repair', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['submit'] }));

  let repairCalled = false;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([
      {
        ok: false,
        code: 'APP_HAS_REDBOX',
        error: 'App is showing an error screen.',
        meta: {
          proofDomain: 'react-tree',
          treeEnvelope: { ok: true, warning: 'APP_HAS_REDBOX' },
        },
      },
    ]),
    repairAction: async () => {
      repairCalled = true;
      return { content: [{ type: 'text', text: JSON.stringify(REPAIR_PATCHED_ENV) }] };
    },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, true);
  assert.equal(repairCalled, false);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'APP_HAS_REDBOX');
  assert.deepEqual(env.meta.treeEnvelope, { ok: true, warning: 'APP_HAS_REDBOX' });
  assert.equal(env.meta.autoRepair.attempted, false);
  assert.equal(env.meta.autoRepair.refusedReason, 'NOT_REPAIRABLE_KIND');
});

// ─────────────────────────────────────────────────────────────────────────────
// trigger annotation
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Issue #120 — phase-breakdown timing for MTTR analysis. Each phase
// boundary should produce a discrete number; introducing a deliberate
// stall at one phase boundary should show up cleanly in that phase's
// duration without contaminating the others.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Issue #117 — concurrency CAS. Two concurrent `cdp_run_action` calls
// against the same actionId must not lose RunRecords through
// read-modify-write interleaving.
// ─────────────────────────────────────────────────────────────────────────────

test('Issue #117: concurrent cdp_run_action calls on the same actionId do not lose RunRecords', async () => {
  project.seedAction(
    'demo',
    fixtureYaml({ id: 'demo', status: 'active', selectors: ['fab-create-task'] }),
  );

  // Both calls should succeed (first-attempt pass) and both should
  // append a RunRecord. Pre-#117 fix this test would intermittently
  // fail because Call B's loadAction snapshot pre-dates Call A's
  // saveAction, and B's saveAction overwrites A's append. With CAS
  // + retry, B detects the conflict, reloads, and re-appends.
  const handler1 = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  const handler2 = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });

  // Fire in parallel. Note: Node's await microtask scheduling makes
  // this strictly sequential at the JS-loop level — to actually
  // interleave the read-modify-write we need to delay the saveAction
  // step. Easiest way: await Promise.all on handlers that yield to
  // the event loop between loadAction and saveAction. The handler's
  // own awaits (parseEnvelope, persistRun's await) provide that
  // interleaving naturally, but to make the race deterministic across
  // CI environments we just verify both records land on disk.
  const [r1, r2] = await Promise.all([
    handler1({ actionId: 'demo', projectRoot: project.root }),
    handler2({ actionId: 'demo', projectRoot: project.root }),
  ]);

  assert.equal(r1.isError, undefined, 'first concurrent call should succeed');
  assert.equal(r2.isError, undefined, 'second concurrent call should succeed');

  const sidecar = project.readSidecar('demo');
  assert.equal(
    sidecar.runHistory.length,
    2,
    `both RunRecords must persist; got ${sidecar.runHistory.length} (pre-#117 fix this would be 1 due to lost-update)`,
  );
});

test('run-action: trigger="ci" surfaces in the RunRecord', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }));

  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([PASS_ENV]),
    repairAction: fakeRepairAction(REPAIR_PATCHED_ENV),
  });
  await handler({ actionId: 'demo', projectRoot: project.root, trigger: 'ci' });

  const sidecar = project.readSidecar('demo');
  assert.equal(sidecar.runHistory[0].trigger, 'ci');
});
