import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import {
  actionWasEditedExternally,
  loadAction,
  promoteActionRuntimeWithCAS,
  saveActionRuntimeWithCAS,
} from '../../dist/domain/action-store.js';
import { appendRunRecord } from '../../dist/domain/reusable-action.js';
import { parseAndValidateFlow } from '../../dist/domain/maestro-validator.js';
import {
  createPinnedRunActionHandler as createRunActionHandler,
  createTmpProject,
  freshFixtureState,
} from '../helpers/tmp-project.js';

let project: ReturnType<typeof createTmpProject>;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

const WIZARD_LAST_SEEN_MS = 1_784_608_627_772;
const WIZARD_YAML_MTIME_MS = 1_784_609_721_821;
const DEVICE_ID = '5C10B45B-2065-458B-B885-0F83F49747C8';

function wizardYaml(status: 'active' | 'experimental' = 'active'): string {
  return [
    'appId: com.rndevagent.testapp',
    '---',
    '# id: wizard-create-task',
    '# intent: Create a task end-to-end via the blue + FAB on the Tasks screen.',
    '# tags: [tasks, wizard, create]',
    '# mutates: true',
    `# status: ${status}`,
    '# enginePin: maestro-runner@1.1.28',
    '',
    '- launchApp:',
    '    stopApp: false',
    '- tapOn:',
    '    id: "fab-create-task"',
    '- tapOn:',
    '    id: "wizard-title-input"',
    '- inputText: ${TITLE}',
    '- tapOn:',
    '    id: "wizard-create-btn"',
    '',
  ].join('\n');
}

function oldRun(timestamp: string, durationMs: number) {
  return {
    timestamp,
    durationMs,
    status: 'pass' as const,
    trigger: 'agent' as const,
    autoRepair: {
      attempted: false,
      outcome: 'skipped' as const,
      phases: { firstAttemptMs: durationMs },
    },
    deviceId: DEVICE_ID,
  };
}

function evidenceSidecar() {
  const first = oldRun('2026-07-21T04:35:36.588Z', 30_834);
  const second = oldRun('2026-07-21T04:37:06.770Z', 30_954);
  return {
    ...freshFixtureState(WIZARD_LAST_SEEN_MS),
    updatedAt: second.timestamp,
    runHistory: [first, second],
    stats: {
      totalRuns: 2,
      successCount: 2,
      failureCount: 0,
      avgDurationMs: 30_894,
      lastSuccessAt: second.timestamp,
    },
  };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const PASS_ENV = {
  ok: true,
  data: {
    passed: true,
    output: 'Flow PASSED',
    flowFile: 'wizard-create-task.yaml',
    platform: 'ios',
    transport: 'maestro-runner',
    transportVersion: '1.0.9',
    fallback: 'none',
    deviceAuthority: {
      requestedDeviceId: DEVICE_ID,
      reportedDeviceId: DEVICE_ID,
      observedDeviceIds: [DEVICE_ID],
      wdaDeviceIds: [DEVICE_ID],
      verified: true,
      source: 'maestro-runner-log',
      reason: 'exact-runner-and-wda-match',
    },
    steps: [
      { index: 0, name: 'launchApp', verb: 'launchApp', status: 'pass', durationMs: 2_800 },
      { index: 1, name: 'tapOn', verb: 'tapOn', status: 'pass', durationMs: 1_400 },
    ],
  },
};

test('GH-588 V2: stale YAML baseline does not reject sidecar-only RunRecord persistence', async () => {
  const yaml = wizardYaml();
  const initialState = evidenceSidecar();
  project.seedAction('wizard-create-task', yaml, initialState);
  const yamlPath = project.yamlPath('wizard-create-task');
  const pinnedMtime = new Date(WIZARD_YAML_MTIME_MS);
  utimesSync(yamlPath, pinnedMtime, pinnedMtime);

  const yamlHashBefore = sha256(yamlPath);
  const yamlMtimeBefore = statSync(yamlPath).mtimeMs;
  const olderRuns = structuredClone(project.readSidecar('wizard-create-task').runHistory);
  let maestroCalls = 0;
  let repairCalls = 0;
  const handler = createRunActionHandler({
    maestroRun: async (args) => {
      maestroCalls += 1;
      assert.equal(args.flowPath, undefined);
      assert.equal(args.actionMetadata?.id, 'wizard-create-task');
      assert.equal(parseAndValidateFlow(args.inlineYaml ?? '').appId, 'com.rndevagent.testapp');
      assert.equal(args.deviceId, DEVICE_ID);
      assert.deepEqual(args.params, {
        TITLE: 'V2Fresh',
        DESC: 'fresh-cas-reproduction',
        PRIORITY: 'high',
        TAG: 'bug',
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(PASS_ENV) }] };
    },
    repairAction: async () => {
      repairCalls += 1;
      throw new Error('autoRepair=false must not invoke repair');
    },
    blindProbeContext: async () => ({ deviceId: DEVICE_ID, iosRuntimeMajor: 26 }),
    targetContext: () => ({ platform: 'ios', deviceId: DEVICE_ID }),
  });

  const result = await handler({
    actionId: 'wizard-create-task',
    projectRoot: project.root,
    platform: 'ios',
    params: {
      TITLE: 'V2Fresh',
      DESC: 'fresh-cas-reproduction',
      PRIORITY: 'high',
      TAG: 'bug',
    },
    autoRepair: false,
    forceReload: false,
  });
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(result.isError, undefined);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.passed, true);
  assert.equal(envelope.data.transport, 'maestro-runner');
  assert.equal(envelope.data.transportVersion, '1.0.9');
  assert.equal(envelope.data.fallback, 'none');
  assert.equal(envelope.data.perStepReadback.complete, true);
  assert.deepEqual(envelope.data.repair, envelope.data.autoRepair);
  assert.deepEqual(envelope.data.writes.actionYaml, {
    written: false,
    reason: 'repair-not-applied',
  });
  assert.equal(envelope.data.writes.runtimeState, 'sidecar');
  assert.equal(maestroCalls, 1, 'the mutating flow must execute exactly once');
  assert.equal(repairCalls, 0);

  const persisted = project.readSidecar('wizard-create-task');
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.lastSeenMtimeMs, WIZARD_LAST_SEEN_MS);
  assert.deepEqual(persisted.runHistory.slice(0, 2), olderRuns);
  assert.equal(persisted.runHistory.length, 3);
  assert.equal(persisted.runHistory[2].status, 'pass');
  assert.equal(persisted.runHistory[2].deviceId, DEVICE_ID);
  assert.equal(persisted.stats.totalRuns, 3);
  assert.equal(sha256(yamlPath), yamlHashBefore, 'action YAML bytes must remain pinned');
  assert.equal(
    statSync(yamlPath).mtimeMs,
    yamlMtimeBefore,
    'runtime persistence must not touch YAML',
  );

  const reloaded = loadAction(project.root, 'wizard-create-task');
  assert.ok(reloaded);
  assert.equal(
    actionWasEditedExternally(reloaded),
    true,
    'forceReload=false must retain the stale baseline for later YAML-mutating guards',
  );
});

test('GH-588 V2 disconfirmation: a real sidecar race still fails CAS without losing the winner', () => {
  project.seedAction('wizard-create-task', wizardYaml(), evidenceSidecar());
  const expected = loadAction(project.root, 'wizard-create-task');
  assert.ok(expected);

  const winner = oldRun('2026-07-21T10:01:00.000Z', 111);
  const winnerState = appendRunRecord(expected.state, winner);
  writeFileSync(
    project.sidecarPath('wizard-create-task'),
    JSON.stringify(winnerState, null, 2) + '\n',
  );

  const loser = oldRun('2026-07-21T10:01:01.000Z', 222);
  const result = saveActionRuntimeWithCAS(expected, appendRunRecord(expected.state, loser));
  assert.deepEqual(result, { ok: false, conflict: 'EXTERNAL_WRITE' });
  const persisted = project.readSidecar('wizard-create-task');
  assert.equal(persisted.runHistory.at(-1).timestamp, winner.timestamp);
  assert.equal(
    persisted.runHistory.some((run: { timestamp: string }) => run.timestamp === loser.timestamp),
    false,
  );
});

test('GH-588 V2 disconfirmation: stale forceReload=false baseline still blocks YAML promotion', () => {
  const yaml = wizardYaml('experimental');
  project.seedAction('wizard-create-task', yaml, evidenceSidecar());
  const yamlPath = project.yamlPath('wizard-create-task');
  const pinnedMtime = new Date(WIZARD_YAML_MTIME_MS);
  utimesSync(yamlPath, pinnedMtime, pinnedMtime);
  const yamlHashBefore = sha256(yamlPath);
  const sidecarBefore = readFileSync(project.sidecarPath('wizard-create-task'), 'utf8');

  const expected = loadAction(project.root, 'wizard-create-task');
  assert.ok(expected);
  const result = promoteActionRuntimeWithCAS(
    expected,
    appendRunRecord(expected.state, oldRun('2026-07-21T10:02:00.000Z', 333)),
  );

  assert.deepEqual(result, { ok: false, conflict: 'EXTERNAL_WRITE' });
  assert.equal(sha256(yamlPath), yamlHashBefore);
  assert.equal(readFileSync(yamlPath, 'utf8'), yaml);
  assert.equal(readFileSync(project.sidecarPath('wizard-create-task'), 'utf8'), sidecarBefore);
});

test('GH-588 V2: a blocked promotion degrades to sidecar-only telemetry, not a failed replay', async () => {
  const yaml = wizardYaml('experimental');
  project.seedAction('wizard-create-task', yaml, evidenceSidecar());
  const yamlPath = project.yamlPath('wizard-create-task');
  const pinnedMtime = new Date(WIZARD_YAML_MTIME_MS);
  utimesSync(yamlPath, pinnedMtime, pinnedMtime);
  const yamlHashBefore = sha256(yamlPath);

  const handler = createRunActionHandler({
    maestroRun: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(PASS_ENV) }],
    }),
    repairAction: async () => {
      throw new Error('autoRepair=false must not invoke repair');
    },
    blindProbeContext: async () => ({ deviceId: DEVICE_ID, iosRuntimeMajor: 26 }),
    targetContext: () => ({ platform: 'ios', deviceId: DEVICE_ID }),
  });

  const result = await handler({
    actionId: 'wizard-create-task',
    projectRoot: project.root,
    platform: 'ios',
    params: { TITLE: 'V2Blocked', DESC: 'd', PRIORITY: 'high', TAG: 'bug' },
    autoRepair: false,
    forceReload: false,
  });
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(result.isError, undefined);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.passed, true);
  assert.equal(envelope.data.writes.runtimeState, 'sidecar');
  assert.deepEqual(
    envelope.data.writes.actionYaml,
    { written: false, reason: 'lifecycle-promotion-refused' },
    'a withheld promotion must not be disclosed as "nothing to promote"',
  );

  const persisted = project.readSidecar('wizard-create-task');
  assert.equal(persisted.runHistory.length, 3);
  assert.equal(persisted.runHistory[2].status, 'pass');
  assert.equal(sha256(yamlPath), yamlHashBefore, 'a refused promotion must not rewrite YAML');
  assert.match(readFileSync(yamlPath, 'utf8'), /^# status: experimental$/m);
});
