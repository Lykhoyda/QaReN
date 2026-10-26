// GH #623 — maestro_run handler integration: the canonical ledger is built
// from per-stage producer artifacts (before output flattening), the ONE
// classifier emits the qualifier into the envelope, and RUNTIME_DEGRADED
// advice is gated: verify-first caveat on a ledger-proven trailing
// verification, verbatim reboot advice for early failures and true wedges.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMaestroRunHandler } from '../../dist/handlers/maestro-run.js';
import { chooseMaestroDispatch } from '../../dist/handlers/maestro-dispatch.js';
import { isProvenTrailingVerificationQualifier } from '../../dist/domain/maestro-run-ledger.js';
import {
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
  buildReplayEngineStatus,
  MAESTRO_RUNNER_PIN,
} from '../../dist/domain/engine-pin.js';

beforeEach(() =>
  _setEngineStatusForTest(buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false)),
);
afterEach(() => _resetEngineStatusForTest());

const EXACT = '5C10B45B-2065-458B-B885-0F83F49747C8';
const APP_ID = 'com.rndevagent.testapp';
const REBOOT_ADVICE = 'reboot it (xcrun simctl shutdown';
const VERIFY_CAVEAT = 'verify before rebooting';

const REGISTRATION_YAML = [
  '- launchApp',
  '- tapOn:',
  '    text: "Email"',
  '- inputText: "user@example.com"',
  '- tapOn:',
  '    text: "Password"',
  '- inputText: "hunter2"',
  '- tapOn:',
  '    text: "Register"',
  '- extendedWaitUntil:',
  '    visible: "Welcome home"',
  '    timeout: 30000',
].join('\n');

// Slow-but-passing taps (median ≥ 1500ms) so RUNTIME_DEGRADED fires; only the
// trailing wait fails.
const TRAILING_FAIL_STDOUT = [
  'maestro-runner 1.1.28',
  `Starting WDA on device ${EXACT} (port: 8447)`,
  '    ✓ launchApp (2.7s)',
  '    ✓ tapOn: text="Email" (1.8s)',
  '    ✓ inputText: "user@example.com" (0.4s)',
  '    ✓ tapOn: text="Password" (1.7s)',
  '    ✓ inputText: "hunter2" (0.4s)',
  '    ✓ tapOn: text="Register" (2.1s)',
  '    ✗ extendedWaitUntil: visible text="Welcome home" (30.0s)',
  "      ╰─ Element 'Welcome home' not visible within 30s (cause: context deadline exceeded)",
].join('\n');

const EARLY_FAIL_STDOUT = [
  'maestro-runner 1.1.28',
  `Starting WDA on device ${EXACT} (port: 8447)`,
  '    ✓ launchApp (2.7s)',
  '    ✓ tapOn: text="Email" (1.8s)',
  '    ✓ inputText: "user@example.com" (0.4s)',
  '    ✓ tapOn: text="Password" (1.7s)',
  '    ✗ tapOn: text="Register" (12.7s)',
  "      ╰─ Element not found: text='Register'",
].join('\n');

type ArtifactRow = [string, 'passed' | 'failed' | 'skipped' | 'running'];

function writeStageReport(dir: string, rows: ArtifactRow[], invocation: number): void {
  mkdirSync(join(dir, 'flows'), { recursive: true });
  const failed = rows.filter(([, status]) => status === 'failed').length;
  const status = failed > 0 ? 'failed' : 'passed';
  writeFileSync(
    join(dir, 'maestro-runner.log'),
    `Starting WDA on device ${EXACT}\ninvocation ${invocation}`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'flows', 'flow-000.json'),
    JSON.stringify({
      id: 'flow-000',
      startTime: `2026-08-29T13:00:0${invocation}.000Z`,
      commands: rows.map(([type, rowStatus], index) => ({
        id: `cmd-00${index}`,
        index,
        type,
        yaml: `${type}: …`,
        status: rowStatus,
        ...(rowStatus === 'failed'
          ? { error: { type: 'unknown', message: 'Wait condition not met within 30s' } }
          : {}),
      })),
    }),
    'utf8',
  );
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify({
      status,
      startTime: `2026-08-29T13:00:0${invocation}.000Z`,
      device: { id: EXACT, platform: 'ios' },
      flows: [
        {
          id: 'flow-000',
          status,
          dataFile: 'flows/flow-000.json',
          device: { id: EXACT, platform: 'ios' },
          commands: {
            total: rows.length,
            passed: rows.filter(([, s]) => s === 'passed').length,
            failed,
            skipped: rows.filter(([, s]) => s === 'skipped').length,
            running: rows.filter(([, s]) => s === 'running').length,
            pending: 0,
          },
        },
      ],
    }),
    'utf8',
  );
}

const MAIN_STAGE_PASSING: ArtifactRow[] = [
  ['tapOn', 'passed'],
  ['inputText', 'passed'],
  ['tapOn', 'passed'],
  ['inputText', 'passed'],
  ['tapOn', 'passed'],
];

function reportDirFrom(args: string[]): string {
  const index = args.indexOf('--output');
  assert.notEqual(index, -1, 'maestro-runner must receive a report --output dir');
  return args[index + 1];
}

function fakeRunnerDispatch() {
  const dispatch = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/maestro-runner',
  });
  if ('error' in dispatch) throw new Error(dispatch.error);
  return dispatch;
}

interface StagePlan {
  rows: ArtifactRow[];
  stdout?: string;
  throwWith?: Record<string, unknown>;
  skipReportWrite?: boolean;
  waitForAbort?: boolean;
}

const invocationCounter = { count: 0 };

function trailingHandler(
  stagePlans: StagePlan[],
  options: {
    fastHealthCheck?: () => Promise<boolean>;
    now?: () => number;
    completeNativeOrigin?: (targetExpected: boolean, signal?: AbortSignal) => Promise<void>;
  } = {},
) {
  let invocation = 0;
  invocationCounter.count = 0;
  return createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run: () => Promise<unknown>) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: options.completeNativeOrigin ?? (async () => {}),
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {},
    fastHealthCheck: options.fastHealthCheck ?? (async () => true),
    ...(options.now ? { now: options.now } : {}),
    execFile: async (_file: string, args: string[], execOptions) => {
      // Count the ATTEMPT before the bounds check so a forbidden extra
      // invocation is visible even if its throw gets swallowed upstream.
      invocation++;
      invocationCounter.count = invocation;
      if (invocation > stagePlans.length) {
        throw new Error(`unexpected extra runner invocation #${invocation} — no retries allowed`);
      }
      const plan = stagePlans[invocation - 1];
      const dir = reportDirFrom(args);
      if (!plan.skipReportWrite) writeStageReport(dir, plan.rows, invocation);
      if (plan.waitForAbort) {
        const signal = execOptions.signal;
        assert.ok(signal);
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
      }
      if (plan.throwWith) {
        throw Object.assign(new Error('runner exited 1'), {
          stdout: plan.stdout ?? '',
          stderr: '',
          code: 1,
          ...plan.throwWith,
        });
      }
      return { stdout: plan.stdout ?? '    ✓ launchApp (2.7s)', stderr: '' };
    },
  });
}

const TRAILING_STAGES: StagePlan[] = [
  { rows: [['launchApp', 'passed']] },
  {
    rows: [...MAIN_STAGE_PASSING, ['extendedWaitUntil', 'failed']],
    stdout: TRAILING_FAIL_STDOUT,
    throwWith: { code: 1 },
  },
];

async function runFlow(
  handler: ReturnType<typeof createMaestroRunHandler>,
  attempt?: object,
  overrides: Record<string, unknown> = {},
) {
  const result = await handler({
    inlineYaml: REGISTRATION_YAML,
    platform: 'ios',
    appId: APP_ID,
    ...(attempt ? { attempt } : {}),
    ...overrides,
  } as Parameters<typeof handler>[0]);
  return JSON.parse(result.content[0].text);
}

test('gh-623 regression: trailing wait timeout emits the ledger qualifier, stays failed, and never advises reboot', async () => {
  const body = await runFlow(trailingHandler(TRAILING_STAGES));
  assert.equal(body.ok, false, JSON.stringify(body).slice(0, 400));
  assert.equal(body.meta.passed, false, 'still a failure — the goal state is unproven');
  const qualifier = body.meta.trailingVerification;
  assert.ok(
    isProvenTrailingVerificationQualifier(qualifier),
    `qualifier missing/invalid: ${JSON.stringify(qualifier)}`,
  );
  assert.equal(qualifier.trailingVerificationOnly, true);
  assert.equal(qualifier.mutationEvidence, 'proven');
  assert.equal(qualifier.provenMutations, 6);
  assert.equal(qualifier.failedVerifications, 1);
  assert.equal(qualifier.attempt.kind, 'initial');
  assert.equal(typeof qualifier.attempt.attemptId, 'string');
  assert.deepEqual(
    qualifier.stageTerminations.map((termination: Record<string, unknown>) => ({ ...termination })),
    [
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
        bootstrapFailure: false,
        transportFailure: false,
        artifactFinalized: true,
      },
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputTruncated: false,
        bootstrapFailure: false,
        transportFailure: false,
        artifactFinalized: true,
      },
    ],
  );
  assert.equal(body.meta.terminal.exitClass, 'step-failure', 'failing-step class preserved');
  assert.equal(invocationCounter.count, 2, 'exactly the two planned stages — no retry machinery');
  const ledger = body.meta.ledger;
  assert.ok(ledger, 'canonical ledger must ride the failure envelope');
  assert.equal(ledger.attempt.complete, true);
  assert.equal(
    ledger.operations.filter((op: { effect: string }) => op.effect === 'mutation').length,
    6,
  );
  // Advice gating: detector unchanged, destructive advice withheld.
  assert.match(body.error, /RUNTIME_DEGRADED/);
  assert.ok(body.error.includes(VERIFY_CAVEAT), body.error);
  assert.ok(!body.error.includes(REBOOT_ADVICE), body.error);
});

test('gh-623 regression: renderer timeout wording does not veto clean producer termination', async () => {
  const body = await runFlow(
    trailingHandler([
      TRAILING_STAGES[0],
      {
        ...TRAILING_STAGES[1],
        stdout: `${TRAILING_FAIL_STDOUT}\n      ╰─ Timed out waiting for element "Welcome home"`,
      },
    ]),
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.passed, false);
  assert.equal(body.meta.terminal.failureKind, 'TIMEOUT');
  assert.ok(isProvenTrailingVerificationQualifier(body.meta.trailingVerification));
  assert.ok(body.error.includes(VERIFY_CAVEAT), body.error);
  assert.ok(!body.error.includes(REBOOT_ADVICE), body.error);
});

test('gh-623 regression: post-run deadline expiry does not veto clean producer termination', async () => {
  let clock = 0;
  const body = await runFlow(
    trailingHandler(TRAILING_STAGES, {
      now: () => clock,
      fastHealthCheck: async () => {
        clock = 120_001;
        return true;
      },
    }),
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.passed, false);
  assert.equal(body.meta.timedOut, true);
  assert.equal(body.meta.terminal.exitClass, 'timed-out');
  assert.ok(isProvenTrailingVerificationQualifier(body.meta.trailingVerification));
  assert.ok(body.error.includes(VERIFY_CAVEAT), body.error);
  assert.ok(!body.error.includes(REBOOT_ADVICE), body.error);
});

test('gh-623 regression: authority cleanup crossing the deadline does not veto a self-exited runner', async () => {
  const body = await runFlow(
    trailingHandler(TRAILING_STAGES, {
      completeNativeOrigin: async (_targetExpected, signal) => {
        assert.ok(signal);
        if (signal.aborted) return;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      },
    }),
    undefined,
    { timeoutMs: 1_000 },
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.passed, false);
  assert.equal(body.meta.timedOut, true);
  assert.equal(body.meta.terminal.exitClass, 'timed-out');
  assert.ok(isProvenTrailingVerificationQualifier(body.meta.trailingVerification));
  assert.ok(body.error.includes(VERIFY_CAVEAT), body.error);
  assert.ok(!body.error.includes(REBOOT_ADVICE), body.error);
});

test('gh-623 regression: an already-aborted deadline does not veto a self-exited runner', async () => {
  const body = await runFlow(
    trailingHandler([
      TRAILING_STAGES[0],
      {
        ...TRAILING_STAGES[1],
        waitForAbort: true,
      },
    ]),
    undefined,
    { timeoutMs: 1_000 },
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.passed, false);
  assert.equal(body.meta.timedOut, true);
  assert.equal(body.meta.terminal.exitClass, 'timed-out');
  assert.ok(isProvenTrailingVerificationQualifier(body.meta.trailingVerification));
  assert.ok(body.error.includes(VERIFY_CAVEAT), body.error);
  assert.ok(!body.error.includes(REBOOT_ADVICE), body.error);
});

test('gh-623 regression: a partial native partition forwards no whole-attempt ledger claims', async () => {
  let reactPresses = 0;
  let invocation = 0;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partitioned-trailing',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {
        reactPresses++;
      },
      typeByTestId: async () => {},
      treeFor: async (id: string) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run: () => Promise<unknown>) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {},
    fastHealthCheck: async () => true,
    execFile: async (_file: string, args: string[]) => {
      invocation++;
      writeStageReport(
        reportDirFrom(args),
        [
          ['tapOn', 'passed'],
          ['tapOn', 'passed'],
          ['extendedWaitUntil', 'failed'],
        ],
        invocation,
      );
      throw Object.assign(new Error('runner exited 1'), {
        stdout: [
          'maestro-runner 1.1.28',
          `Starting WDA on device ${EXACT} (port: 8447)`,
          '    ✓ tapOn: text="Native submit" (1.8s)',
          '    ✓ tapOn: text="Native confirm" (1.9s)',
          '    ✗ extendedWaitUntil: visible text="Native done" (30.0s)',
          '      ╰─ Timed out waiting for element "Native done"',
        ].join('\n'),
        stderr: '',
        code: 1,
      });
    },
  });
  const result = await handler({
    inlineYaml: [
      '- tapOn: "Native submit"',
      '- tapOn: "Native confirm"',
      '- extendedWaitUntil:',
      '    visible: "Native done"',
      '    timeout: 30000',
      '- tapOn:',
      '    id: "react-later"',
    ].join('\n'),
    platform: 'ios',
    appId: APP_ID,
    attempt: { attemptId: 'att-partitioned', ordinal: 1, maxAttempts: 1, kind: 'initial' },
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.meta.passed, false);
  assert.equal(body.meta.trailingVerification, undefined);
  assert.equal(body.meta.ledger, undefined);
  assert.ok(body.error.includes(REBOOT_ADVICE), body.error);
  assert.ok(!body.error.includes(VERIFY_CAVEAT), body.error);
  assert.equal(reactPresses, 0);
});

test('gh-623 negative control: an early mutating-step failure keeps hard failure and verbatim reboot advice', async () => {
  const body = await runFlow(
    trailingHandler([
      { rows: [['launchApp', 'passed']] },
      {
        rows: [
          ['tapOn', 'passed'],
          ['inputText', 'passed'],
          ['tapOn', 'passed'],
          ['inputText', 'skipped'],
          ['tapOn', 'failed'],
          ['extendedWaitUntil', 'skipped'],
        ],
        stdout: EARLY_FAIL_STDOUT,
        throwWith: { code: 1 },
      },
    ]),
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.trailingVerification, undefined);
  assert.match(body.error, /RUNTIME_DEGRADED/);
  assert.ok(body.error.includes(REBOOT_ADVICE), body.error);
  assert.ok(!body.error.includes(VERIFY_CAVEAT), body.error);
});

test('gh-623 negative control: a runner killed by abort keeps TIMEOUT class and reboot advice', async () => {
  const body = await runFlow(
    trailingHandler([
      { rows: [['launchApp', 'passed']] },
      {
        rows: [...MAIN_STAGE_PASSING, ['extendedWaitUntil', 'failed']],
        stdout: TRAILING_FAIL_STDOUT,
        throwWith: { killed: true, signal: 'SIGTERM', code: null },
        waitForAbort: true,
      },
    ]),
    undefined,
    { timeoutMs: 1_000 },
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.trailingVerification, undefined);
  assert.equal(body.meta.terminal.exitClass, 'timed-out');
  assert.match(body.error, /RUNTIME_DEGRADED/);
  assert.ok(body.error.includes(REBOOT_ADVICE), body.error);
});

test('gh-623 negative control: a stage that wrote no fresh artifact never qualifies', async () => {
  const body = await runFlow(
    trailingHandler([
      { rows: [['launchApp', 'passed']] },
      {
        rows: [],
        skipReportWrite: true,
        stdout: TRAILING_FAIL_STDOUT,
        throwWith: { code: 1 },
      },
    ]),
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.trailingVerification, undefined);
  assert.equal(body.meta.ledger.attempt.complete, false);
});

test('gh-623 negative control: a truncated-output run (maxBuffer kill) never qualifies', async () => {
  const body = await runFlow(
    trailingHandler([
      { rows: [['launchApp', 'passed']] },
      {
        rows: [...MAIN_STAGE_PASSING, ['extendedWaitUntil', 'failed']],
        stdout: TRAILING_FAIL_STDOUT,
        throwWith: { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      },
    ]),
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.trailingVerification, undefined);
  assert.equal(body.meta.outputTruncated, true);
});

test('gh-623 negative control: a non-terminal (running) artifact row never qualifies', async () => {
  const body = await runFlow(
    trailingHandler([
      { rows: [['launchApp', 'passed']] },
      {
        rows: [
          ...MAIN_STAGE_PASSING.slice(0, 4),
          ['tapOn', 'running'],
          ['extendedWaitUntil', 'failed'],
        ],
        stdout: TRAILING_FAIL_STDOUT,
        throwWith: { code: 1 },
      },
    ]),
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.trailingVerification, undefined);
  assert.equal(body.meta.ledger.attempt.complete, false);
});

test('gh-623 adversarial: stdout renders a trailing wait but the artifact proves an early tap failure — no qualifier', async () => {
  // Renderer text lies about where the flow stopped; only the producer
  // artifact may decide, so the qualifier must be withheld.
  const body = await runFlow(
    trailingHandler([
      { rows: [['launchApp', 'passed']] },
      {
        rows: [
          ['tapOn', 'passed'],
          ['inputText', 'passed'],
          ['tapOn', 'failed'],
          ['inputText', 'skipped'],
          ['tapOn', 'skipped'],
          ['extendedWaitUntil', 'skipped'],
        ],
        stdout: TRAILING_FAIL_STDOUT,
        throwWith: { code: 1 },
      },
    ]),
  );
  assert.equal(body.ok, false);
  assert.equal(body.meta.trailingVerification, undefined);
});

test('gh-623 adversarial: unparseable stdout with a ledger-proven trailing failure still qualifies', async () => {
  // No step lines at all — a renderer-derived classifier would see nothing,
  // but the canonical ledger alone establishes the qualifier.
  const body = await runFlow(
    trailingHandler([
      { rows: [['launchApp', 'passed']] },
      {
        rows: [...MAIN_STAGE_PASSING, ['extendedWaitUntil', 'failed']],
        stdout: 'maestro-runner 1.1.28\nunstructured noise without any step lines',
        throwWith: { code: 1 },
      },
    ]),
  );
  assert.equal(body.ok, false);
  const qualifier = body.meta.trailingVerification;
  assert.ok(isProvenTrailingVerificationQualifier(qualifier), JSON.stringify(qualifier));
  assert.equal(qualifier.provenMutations, 6);
});

test('gh-623: a repaired attempt carries its lineage through the qualifier', async () => {
  const body = await runFlow(trailingHandler(TRAILING_STAGES), {
    attemptId: 'att-repair-2',
    ordinal: 2,
    maxAttempts: 2,
    kind: 'repaired',
    parentAttemptId: 'att-initial-1',
  });
  const qualifier = body.meta.trailingVerification;
  assert.ok(isProvenTrailingVerificationQualifier(qualifier));
  assert.deepEqual(qualifier.attempt, {
    attemptId: 'att-repair-2',
    ordinal: 2,
    kind: 'repaired',
    parentAttemptId: 'att-initial-1',
  });
});

test('gh-623: a passing flow carries no qualifier fields at all', async () => {
  const handler = trailingHandler([
    { rows: [['launchApp', 'passed']] },
    {
      rows: [...MAIN_STAGE_PASSING, ['extendedWaitUntil', 'passed']],
      stdout: [
        'maestro-runner 1.1.28',
        `Starting WDA on device ${EXACT} (port: 8447)`,
        '    ✓ tapOn: text="Email" (1.8s)',
        '    ✓ extendedWaitUntil: visible text="Welcome home" (2.0s)',
      ].join('\n'),
    },
  ]);
  const body = await runFlow(handler);
  assert.equal(body.ok, true, JSON.stringify(body).slice(0, 400));
  assert.equal(body.data.trailingVerification, undefined);
  assert.equal(body.meta?.trailingVerification, undefined);
});
