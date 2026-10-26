// GH #623 — cdp_run_action integration: a ledger-qualified trailing
// verification failure stays passed:false with its existing failureKind,
// REFUSES auto-repair (no YAML rewrite for a merely-slow selector), persists
// the qualifier block on the RunRecord, and never recommends reboot/relaunch.
// Negative controls preserve today's behavior end to end.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPinnedRunActionHandler as createRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

let project: ReturnType<typeof createTmpProject>;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

function fakeRepairAction(envelope: unknown, calls: unknown[] = []) {
  return async (args: unknown) => {
    calls.push(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      ...((envelope as { ok?: boolean }).ok === false ? { isError: true } : {}),
    };
  };
}

const CLEAN_TERMINATION = {
  exitCode: 1,
  signal: null,
  timedOut: false,
  outputTruncated: false,
  bootstrapFailure: false,
  transportFailure: false,
  artifactFinalized: true,
};

const RUNTIME_DEGRADED = { medianTapMs: 1800, floorMs: 1500, sampleCount: 3 };
const RUNTIME_CAVEAT =
  'RUNTIME_DEGRADED: median tapOn latency 1800ms (>= 1500ms) — runtime is slow; the goal state may have appeared after the wait — verify before rebooting.';

function qualifier(overrides: Record<string, unknown> = {}) {
  return {
    trailingVerificationOnly: true,
    mutationEvidence: 'proven',
    provenMutations: 6,
    failedVerifications: 1,
    notRunOperations: 0,
    stageTerminations: [CLEAN_TERMINATION],
    attempt: { attemptId: 'att-1', ordinal: 1, kind: 'initial' },
    ...overrides,
  };
}

// The failure envelope maestro_run emits for a trailing id-wait timeout —
// failureKind SELECTOR_NOT_FOUND per GH #580, plus the ledger qualifier and
// the verify-first (non-reboot) degraded caveat in the headline.
function trailingIdWaitEnv(trailingVerification: Record<string, unknown>) {
  return {
    ok: false,
    error:
      'Maestro flow failed at step "extendedWaitUntil: visible id=\\"home_screen\\"" (SELECTOR_NOT_FOUND: home_screen) — RUNTIME_DEGRADED: median tapOn latency 1800ms (>= 1500ms) — runtime is slow; the goal state may have appeared after the wait — verify before rebooting.',
    meta: {
      passed: false,
      output: '    ✗ extendedWaitUntil: visible id="home_screen" (30.0s)',
      terminal: {
        exitClass: 'step-failure',
        completedSteps: 6,
        failedStep: 'extendedWaitUntil: visible id="home_screen"',
        failureKind: 'SELECTOR_NOT_FOUND',
        failureSelector: 'home_screen',
      },
      trailingVerification,
      runtimeDegraded: RUNTIME_DEGRADED,
      runnerResume: { attempted: true, healthy: true },
    },
  };
}

// The real classifier binds the qualifier to the dispatched attempt, so the
// stub does the same: the qualifier's lineage is copied from args.attempt
// (never fabricated) unless a case deliberately breaks it via overrides.
function fakeTrailingMaestroRun(
  calls: Array<{ attempt?: Record<string, unknown> }>,
  overrides: Record<string, unknown> = {},
) {
  return async (args: { attempt?: Record<string, unknown> }) => {
    calls.push(args);
    const attempt = args.attempt!;
    const env = trailingIdWaitEnv(
      qualifier({
        attempt: { attemptId: attempt.attemptId, ordinal: attempt.ordinal, kind: attempt.kind },
        ...overrides,
      }),
    );
    return { content: [{ type: 'text', text: JSON.stringify(env) }], isError: true };
  };
}

const REPAIR_CALLS_FORBIDDEN = () => {
  throw new Error('cdp_repair_action must NOT be called for a trailing verification failure');
};

test('gh-623: trailing verification failure refuses repair, keeps kind, persists qualifier, no reboot advice', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo' }), null);
  const maestroCalls: Array<{ attempt?: Record<string, unknown> }> = [];
  const handler = createRunActionHandler({
    maestroRun: fakeTrailingMaestroRun(maestroCalls),
    repairAction: REPAIR_CALLS_FORBIDDEN,
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const body = JSON.parse(result.content[0].text);

  assert.equal(body.ok, false, 'the goal state is unproven — never a pass');
  assert.equal(body.code, 'TESTID_NOT_FOUND', 'existing failing-step tool code preserved');
  assert.equal(body.meta.failureKind, 'SELECTOR_NOT_FOUND', 'existing failureKind preserved');
  assert.equal(body.meta.trailingVerification.trailingVerificationOnly, true);
  assert.equal(body.meta.trailingVerification.mutationEvidence, 'proven');
  assert.deepEqual(body.meta.runtimeDegraded, RUNTIME_DEGRADED);
  assert.equal(body.meta.autoRepair.attempted, false);
  assert.equal(body.meta.autoRepair.outcome, 'refused');
  assert.equal(body.meta.autoRepair.refusedReason, 'NOT_REPAIRABLE_KIND');
  assert.match(body.error, /trailing verification only/);
  assert.match(body.error, /UNPROVEN/);
  assert.match(body.error, /verify the live state/i);
  assert.ok(body.error.includes(RUNTIME_CAVEAT), body.error);
  assert.equal(body.error.split(RUNTIME_CAVEAT).length - 1, 1);
  assert.ok(!/reboot it \(xcrun simctl/.test(body.error), body.error);
  assert.ok(!/relaunch the app/.test(body.error), body.error);

  const sidecar = JSON.parse(readFileSync(project.sidecarPath('demo'), 'utf8'));
  const run = sidecar.runHistory.at(-1);
  assert.equal(run.status, 'fail');
  assert.equal(run.failureCode, 'SELECTOR_NOT_FOUND');
  // The COMPLETE qualifier block — lineage bound to the DISPATCHED attempt and
  // full termination provenance — must survive result AND persisted RunRecord.
  const dispatched = maestroCalls[0].attempt!;
  const expectedQualifier = qualifier({
    attempt: { attemptId: dispatched.attemptId, ordinal: 1, kind: 'initial' },
  });
  assert.deepEqual(run.trailingVerification, expectedQualifier);
  assert.deepEqual(body.meta.trailingVerification, expectedQualifier);
  assert.equal(run.autoRepair.outcome, 'refused');
});

test('gh-623: explicit repair opt-out keeps USER_DISABLED telemetry on a qualified failure', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo' }), null);
  const handler = createRunActionHandler({
    maestroRun: fakeTrailingMaestroRun([]),
    repairAction: REPAIR_CALLS_FORBIDDEN,
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, autoRepair: false });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.meta.autoRepair.refusedReason, 'USER_DISABLED');
  assert.equal(body.meta.trailingVerification.trailingVerificationOnly, true);
});

test('gh-623: a repaired qualifier with the wrong parent lineage is rejected', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }), null);
  let invocation = 0;
  const handler = createRunActionHandler({
    maestroRun: async (args: { attempt?: Record<string, unknown> }) => {
      invocation++;
      if (invocation === 1) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                data: {
                  passed: false,
                  output: "Element with id 'fab-create-task' not found",
                  flowFile: 'x',
                  platform: 'ios',
                },
              }),
            },
          ],
          isError: true,
        };
      }
      const retryEnv = trailingIdWaitEnv(
        qualifier({
          attempt: {
            attemptId: args.attempt!.attemptId,
            ordinal: args.attempt!.ordinal,
            kind: args.attempt!.kind,
            parentAttemptId: 'different-parent-attempt',
          },
        }),
      );
      return { content: [{ type: 'text', text: JSON.stringify(retryEnv) }], isError: true };
    },
    repairAction: fakeRepairAction({
      ok: true,
      data: {
        patched: true,
        actionId: 'demo',
        oldSelector: 'fab-create-task',
        newSelector: 'fab-create-task-btn',
        score: 0.91,
        replacements: 1,
      },
    }),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.meta.trailingVerification, undefined);
  assert.doesNotMatch(body.error, /trailing verification only/);
  const sidecar = JSON.parse(readFileSync(project.sidecarPath('demo'), 'utf8'));
  assert.equal(sidecar.runHistory.at(-1).trailingVerification, undefined);
});
