import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureScreen, type NativeObservation } from '../../../dist/qa/capture.js';
import type { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import type { Questions } from '../../../dist/qa/questions.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import { createDeviceFillHandler } from '../../../dist/handlers/device-interact.js';
import { createDeviceSnapshotHandler } from '../../../dist/handlers/device-session.js';
import { unwrap } from '../../../dist/qa/adapt.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { createJev, JEV_MODEL } from '../../../dist/qa/jev.js';
import {
  createTimingObserver,
  formatTimingEvent,
  type RecordedTimingEvent,
} from '../../../dist/qa/timing.js';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  _setCapabilitiesForTest,
} from '../../../dist/runners/rn-fast-runner-client.js';
import {
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';
import {
  runNative,
  setActiveSessionInMemoryForTest,
  resetActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { analyze, readMetrics } from '../../calibration/analyze.ts';
import { hash, planPath, policy, schedule, target } from '../../calibration/schedule.ts';
import { command } from '../../calibration/run.ts';

afterEach(() => {
  _setFetchForTest(fetch);
  _setFastRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  resetActiveSessionInMemoryForTest();
  clearRefMap();
});

async function fixedPlanPipeline() {
  const state = {
    port: 12345,
    pid: process.pid,
    deviceId: target.device,
    bundleId: target.appId,
    startedAt: 'now',
    capability: 'PRIVATE-capability',
    instanceId: 'PRIVATE-instance',
    sessionId: 'PRIVATE-session',
    claimEpoch: 1,
  };
  _setFastRunnerStateForTest(state);
  setActiveSessionInMemoryForTest({
    name: 'qa',
    platform: 'ios',
    appId: state.bundleId,
    deviceId: state.deviceId,
  });
  let clock = 100;
  const now = () => clock;
  let changes = 0;
  let presses = 0;
  let value = '';
  const lines: string[] = [];
  const timing = createTimingObserver((event) => lines.push(formatTimingEvent(event)));
  _setFetchForTest(async (url, init) => {
    clock += 2;
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'PLATFORM_PRESENCE_V2', 'QA_READ_ONLY_V1'],
        instanceId: state.instanceId,
        sessionId: state.sessionId,
        claimEpoch: state.claimEpoch,
        deviceId: state.deviceId,
        appId: state.bundleId,
      });
    const command = JSON.parse(String(init?.body));
    assert.ok(!Object.keys(command).some((key) => /timing|observe|now/i.test(key)));
    if (command.command === 'verifyInput')
      return Response.json({
        ok: true,
        v: 2,
        data: {
          verifyVerdict: command.text === value ? 'exact' : 'mismatch',
          verifyStable: true,
        },
      });
    if (command.command !== 'snapshot') {
      changes++;
      if (command.command === 'tap') presses++;
      if (command.command === 'type') value = command.text;
      return Response.json({ ok: true, v: 2, data: {} });
    }
    const capture = nativeCapture();
    capture.nodes[0].label = `Screen ${changes}`;
    capture.nodes[1].identifier = 'tab-profile';
    capture.nodes[1].label = [
      'Skip onboarding',
      'Done finish onboarding',
      'Tasks',
      'Home',
      'Profile',
    ][Math.min(presses, 4)];
    if (presses >= 5)
      capture.nodes.push({
        ...capture.nodes[1],
        index: 2,
        type: 'TextField',
        identifier: 'profile-notes-input',
        label: value || 'Notes',
        rect: { x: 10, y: 80, width: 100, height: 40 },
        presence: { ...capture.nodes[1].presence, nodeIndex: 2 },
      });
    capture.presenceCapture.appId = state.bundleId;
    const { presenceCapture, ...plain } = capture;
    const data = command.platformPresence
      ? {
          ...plain,
          presenceCapture: {
            ...presenceCapture,
            diagnostics: {
              phaseMs: {
                'initial-eligibility': 10,
                enumeration: 20,
                observation: 30,
                'final-eligibility': 20,
                revalidation: 20,
              },
            },
          },
        }
      : plain;
    clock += 100;
    const response = Response.json({ ok: true, v: 2, data });
    const json = response.json.bind(response);
    response.json = async () => {
      clock += 3;
      return json();
    };
    return response;
  });
  const judge = createJev({
    apiKey: 'unit-test-only',
    now,
    timing,
    fetch: async (_url, init) => {
      clock += 7;
      const { questions }: { questions: Questions } = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => {
          if (q.type === 'noul') return [id, { type: 'noul', noul: 0.99 }];
          const keys = Object.keys(q.criteria);
          const selected = keys.find((key) => key !== 'none');
          return [
            id,
            {
              type: 'choice',
              choice: selected,
              confidence: 1,
              probabilities: Object.fromEntries(keys.map((key) => [key, Number(key === selected)])),
            },
          ];
        }),
      );
      return Response.json({ model: JEV_MODEL, answers, usage: { input_tokens: 1 } });
    },
  });
  const handler = createDeviceSnapshotHandler();
  const fill = createDeviceFillHandler(() => null as never);
  const act = async (args: string[], context?: QaDispatchContext) => {
    const result = await runNative(args, { qaContext: context, settle: { enabled: false } });
    return { ok: !result.isError, proven: false };
  };
  const ledger = await runPlan(parsePlan(readFileSync(planPath, 'utf8')).blocks!, {
    timing,
    now,
    judge,
    sleep: async (ms) => {
      clock += ms;
    },
    row: () => {},
    screenshot: async (name) => {
      clock += 5;
      return name;
    },
    captureScreen: (options) =>
      captureScreen({
        now,
        timing: options?.timing,
        appId: state.bundleId,
        requirePrivateInputs: true,
        native: async (presenceBudgetMs) => {
          const { data, meta } = unwrap<NativeObservation>(
            await handler({
              action: 'snapshot',
              qaReadOnly: true,
              platformPresence: options?.platformPresence,
              presenceBudgetMs,
              qaTiming: options?.timing ? { now, observe: options.timing } : undefined,
            }),
          );
          return { ...data, snapshotVerdict: meta?.snapshotVerdict };
        },
        react: () =>
          captureQaReact({
            isConnected: true,
            withPrivateHelperWorld: async (work) =>
              work(async () => {
                clock += 1;
                const hosts =
                  presses >= 5
                    ? [
                        {
                          testID: 'profile-notes-input',
                          role: null,
                          roleSource: 'none',
                          capabilities: { fill: true },
                        },
                      ]
                    : [];
                return {
                  v: 1,
                  id: 'a1',
                  state: 'ready',
                  tree: JSON.stringify({
                    interactive: [],
                    verdict: { state: 'ok', path: 'interactive', complete: true },
                    hostEvidence: { complete: true, hosts },
                  }),
                };
              }),
          }),
      }),
    press: (ref, context) => act(['press', ref], context),
    fill: async (ref, text, qaContext) => {
      unwrap(await fill({ ref, text, qaContext }));
      return { ok: true, proven: true };
    },
    scroll: (_direction, context) => act(['scroll', '10', '100', '10', '50'], context),
    back: () => assert.fail('not scheduled'),
    dialog: () => assert.fail('not scheduled'),
  });
  assert.equal(ledger.verdict, 'PASS', JSON.stringify(ledger));
  const log = `qaren-core: bundle proven\n${lines.join('')}qaren-core: teardown\n`;
  assert.ok(!log.includes('PRIVATE'));
  assert.ok(!log.includes('Calibration note'));
  return { ledger, log, events: readMetrics(log) };
}

test('the fixed plan analyzes emitted real walker, capture, Jev and adapter events without synthetic stage injection', async () => {
  const { ledger, events } = await fixedPlanPipeline();
  assert.deepEqual(analyze(events, ledger).failures, []);
  assert.ok(events.some((e) => e.stage === 'capture' && e.presence === 0));
  assert.ok(events.some((e) => e.stage === 'capture' && e.presence === 1));
});

function readTamperedMetrics(events: RecordedTimingEvent[]): RecordedTimingEvent[] {
  return readMetrics(
    events.map((event, index) => formatTimingEvent({ ...event, seq: index + 1 })).join(''),
  );
}

test('readbacks require their own post-mutation capture, not rebound pre-action evidence', async (t) => {
  const { ledger, events } = await fixedPlanPipeline();
  const baseline = analyze(events, ledger);
  assert.equal(baseline.pass, true);
  assert.equal(baseline.counts.captures, 31);
  for (const mutation of events.filter((e) => e.stage === 'mutation' && e.edge === 'end')) {
    await t.test(`line ${mutation.line}`, () => {
      const readback = events.find(
        (e) => e.stage === 'readback' && e.line === mutation.line && e.seq > mutation.seq,
      )!;
      const captureStart = events.find(
        (e) =>
          e.stage === 'capture' && e.edge === 'start' && e.observation === readback.observation,
      )!;
      const captureEnd = events.find(
        (e) => e.stage === 'capture' && e.edge === 'end' && e.observation === readback.observation,
      )!;
      const tampered = readTamperedMetrics(
        events
          .filter((e) => e.seq < captureStart.seq || e.seq > captureEnd.seq)
          .map((e) => (e === readback ? { ...e, observation: mutation.observation } : e)),
      );
      const result = analyze(tampered, ledger);
      assert.equal(result.counts.captures, 30);
      assert.equal(
        result.pass,
        false,
        'a complete PASS ledger cannot replace post-action evidence',
      );
      assert.ok(result.failures.includes('READBACK_MISSING'));
      const rebound = analyze(
        readTamperedMetrics(
          events.map((e) => (e === readback ? { ...e, observation: mutation.observation } : e)),
        ),
        ledger,
      );
      assert.equal(rebound.counts.captures, 31);
      assert.ok(
        rebound.failures.includes('READBACK_MISSING'),
        'an unbound post-action capture cannot validate pre-action readback',
      );
      const wrongLine = analyze(
        readTamperedMetrics(
          events.map((e) =>
            captureStart.seq <= e.seq && e.seq <= captureEnd.seq
              ? { ...e, line: schedule().lines[0] }
              : e,
          ),
        ),
        ledger,
      );
      assert.ok(
        wrongLine.failures.includes('READBACK_MISSING'),
        'readback must use a capture from the same plan line',
      );
      const premature = analyze(
        readTamperedMetrics(
          events
            .filter((e) => e !== readback)
            .flatMap((e) => (e === captureEnd ? [{ ...readback, at: captureEnd.at }, e] : [e])),
        ),
        ledger,
      );
      assert.ok(
        premature.failures.includes('READBACK_MISSING'),
        'the capture must finish before readback',
      );
      const overlapping = analyze(
        readTamperedMetrics(
          events
            .filter((e) => e !== captureStart)
            .flatMap((e) => (e === mutation ? [{ ...captureStart, at: mutation.at }, e] : [e])),
        ),
        ledger,
      );
      assert.ok(
        overlapping.failures.includes('READBACK_MISSING'),
        'post-action capture cannot start before mutation finishes',
      );
    });
  }
});

test('authorizations must use the mutation observation, not merely occur inside its span', async () => {
  const { ledger, events } = await fixedPlanPipeline();
  assert.equal(analyze(events, ledger).pass, true);
  const line = schedule().cycles.find((c) => c.kind === 'scroll')!.line;
  const unrelated = events.find((e) => e.stage === 'capture' && e.edge === 'end')!.observation;
  const tampered = readTamperedMetrics(
    events.map((e) =>
      e.stage === 'authorization' && e.line === line ? { ...e, observation: unrelated } : e,
    ),
  );
  const result = analyze(tampered, ledger);
  assert.equal(result.pass, false);
  assert.ok(result.failures.includes('AUTHORIZATION_ACCOUNTING'));
});

test('each qualifying Jev decision requires validation inside its successful attempt', async (t) => {
  const { ledger, events } = await fixedPlanPipeline();
  assert.equal(analyze(events, ledger).pass, true);
  const cohortLines = schedule().acquisitions.flatMap((group) => group.lines);
  const cohortDecisions = events
    .filter((e) => e.stage === 'decision' && e.edge === 'start' && cohortLines.includes(e.line!))
    .map((start) => ({
      start,
      end: events.find(
        (e) =>
          e.stage === 'decision' &&
          e.edge === 'end' &&
          e.line === start.line &&
          e.observation === start.observation &&
          e.seq > start.seq,
      )!,
    }));
  const omitted = events.filter(
    (e) =>
      e.stage === 'jev-validation' &&
      cohortDecisions.some(({ start, end }) => start.seq < e.seq && e.seq < end.seq),
  );
  assert.equal(omitted.filter((e) => e.edge === 'end').length, 15);
  await t.test('all fifteen acquisition-cohort validation spans omitted', () => {
    const result = analyze(readTamperedMetrics(events.filter((e) => !omitted.includes(e))), ledger);
    assert.equal(result.pass, false);
    assert.ok(result.failures.includes('PROJECTION_USE_MISSING'));
  });
  for (const { line, failure } of [
    { line: cohortLines[0], failure: 'PROJECTION_USE_MISSING' },
    {
      line: schedule().cycles.find((cycle) => cycle.model)!.line,
      failure: 'LIVE_DECISION_CYCLE_MISSING',
    },
  ]) {
    await t.test(`line ${line}: validation inside decision but outside attempt`, () => {
      const start = events.find(
        (e) => e.stage === 'decision' && e.edge === 'start' && e.line === line,
      )!;
      const end = events.find(
        (e) => e.stage === 'decision' && e.edge === 'end' && e.line === line && e.seq > start.seq,
      )!;
      const validation = events.filter(
        (e) => e.stage === 'jev-validation' && start.seq < e.seq && e.seq < end.seq,
      );
      assert.equal(validation.length, 2);
      const attempt = events.find(
        (e) =>
          e.stage === 'jev-attempt' && e.edge === 'end' && start.seq < e.seq && e.seq < end.seq,
      )!;
      const relocated = events
        .filter((e) => !validation.includes(e))
        .flatMap((e) => (e === attempt ? [e, ...validation] : [e]));
      const result = analyze(readTamperedMetrics(relocated), ledger);
      assert.equal(result.pass, false);
      assert.ok(result.failures.includes(failure));
    });
  }
});

test('missing and partial real adapter metrics cannot pass a completed fixed-plan ledger', async () => {
  const { ledger, events } = await fixedPlanPipeline();
  for (const stage of [
    'native-readiness',
    'native-transport',
    'native-decode',
    'native-read-only-v1',
  ] as const) {
    const incomplete = events.filter((e) => e.stage !== stage);
    assert.equal(analyze(incomplete, ledger).pass, false, stage);
  }
  const missingSecondProbe = events.filter(
    (e) => !(e.stage === 'native-readiness' && e.count === 2),
  );
  assert.ok(analyze(missingSecondProbe, ledger).failures.includes('READINESS_PROBES_INCOMPLETE'));
  const missingSecondAttestation = events.filter(
    (e) => !(e.stage === 'native-read-only-v1' && e.count === 2),
  );
  assert.ok(
    analyze(missingSecondAttestation, ledger).failures.includes('MISSING_NATIVE_READ_ONLY_V1'),
  );
  const partialDecode = events.filter((e) => !(e.stage === 'native-decode' && e.edge === 'end'));
  assert.ok(analyze(partialDecode, ledger).failures.includes('UNFINISHED_SPAN'));
  const gappedLog = events
    .filter((_, index) => index !== 5)
    .map(formatTimingEvent)
    .join('');
  assert.throws(() => readMetrics(gappedLog), /CALIBRATION_METRICS_INVALID/);
});

test('the offline CLI analyzes frozen manifest and actual emitted log shapes, retaining missing evidence as failure', async () => {
  const { ledger, log } = await fixedPlanPipeline();
  const directory = mkdtempSync(join(tmpdir(), 'qaren-calibration-unit-'));
  try {
    const put = (name: string, object: unknown) =>
      writeFileSync(join(directory, name), JSON.stringify(object));
    const runId = 'check-unit-fixture';
    const runDir = join(directory, runId);
    mkdirSync(join(runDir, 'logs'), { recursive: true });
    const snapshot = Object.fromEntries(
      ['source', 'app', 'config', 'cli', 'runtime', 'native'].map((key) => [
        key,
        hash('unit-test-artifacts'),
      ]),
    );
    put('manifest.json', {
      version: 1,
      root: resolve(dirname(planPath), '../../../..'),
      app: join(directory, 'unit-app'),
      target,
      policy,
      schedule: schedule(),
      snapshot,
      command: command(),
    });
    put('started.json', { manifest: hash(readFileSync(join(directory, 'manifest.json'))) });
    put('finished.json', { status: 0, signal: null, spawnError: false, snapshot });
    const core = { run_id: runId, pgid: 9000, at: '2026-02-02T02:42:00Z', outcome: 'absent' };
    const fresh = {
      run_id: runId,
      app_id: target.appId,
      device_id: target.device,
      proven_absent_at: '2026-02-02T02:40:00Z',
      status: 'proven_absent',
    };
    const candidate = { app_id: target.appId };
    put(`${runId}/run.json`, {
      schema: 'qaren-run/1',
      run_id: runId,
      phase: 'cleaned',
      created_at: '2026-02-02T02:39:00Z',
      candidate,
      resources: {
        device_borrowed: true,
        ios_simulator: { udid: target.device },
        core_cleanup: core,
        fresh_install: fresh,
      },
    });
    put(`${runId}/ledger.json`, ledger);
    writeFileSync(join(runDir, 'logs/core.log'), log);
    const shot = join(
      runDir,
      ledger.steps.find((row) => row.line === schedule().cachedCheck)!.screenshot!,
    );
    mkdirSync(dirname(shot), { recursive: true });
    writeFileSync(
      shot,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZfoAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    put('receipt.json', {
      schema: 'qaren/1',
      verb: 'check',
      run_id: runId,
      phase: 'cleaned',
      result: 'pass',
      emitted_at: '2026-02-02T02:43:00Z',
      candidate,
      ledger: { verdict: 'PASS' },
      device: { ios_udid: target.device },
      outcomes: { fresh_install: 'proven_absent' },
      cleanup: { core: 'absent', metro: 'removed', simulator: 'kept', device_lease: 'removed' },
      core_cleanup: core,
      fresh_install: fresh,
      artifacts: { ledger: join(runDir, 'ledger.json'), run_record: join(runDir, 'run.json') },
    });
    const script = fileURLToPath(new URL('../../calibration/run.ts', import.meta.url));
    const execute = () =>
      spawnSync(process.execPath, [script, 'analyze', directory], {
        encoding: 'utf8',
        timeout: 20_000,
      });
    const accepted = execute();
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.equal(JSON.parse(accepted.stdout).pass, true);
    writeFileSync(join(runDir, 'logs/core.log'), log.slice(0, Math.floor(log.length / 2)));
    const truncated = execute();
    assert.equal(truncated.status, 1);
    assert.equal(JSON.parse(truncated.stdout).pass, false);
    writeFileSync(join(runDir, 'logs/core.log'), log);
    rmSync(shot);
    const missingShot = execute();
    assert.equal(missingShot.status, 1);
    assert.ok(JSON.parse(missingShot.stdout).failures.includes('CACHED_SCREENSHOT_FILE_MISSING'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
