import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { withCancellation, RunCancelledError, sleep } from '../../../dist/domain/cancellation.js';
import { ensureSingleRunner } from '../../../dist/runners/ensure-single-runner.js';
import { createDeviceSnapshotHandler } from '../../../dist/handlers/device-session.js';
import {
  getActiveSession,
  resetActiveSessionInMemoryForTest,
} from '../../../dist/agent-device-wrapper.js';
import { admit } from '../../../dist/qa/admission.js';
import { createStop } from '../../../dist/qa/stop.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

test('abort during legacy runner grace sleep prevents further kills, removal and file writes', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = withCancellation(controller.signal, () =>
    ensureSingleRunner(
      { udid: 'device' },
      {
        listProcesses: () => '101 AgentDeviceRunner device\n102 AgentDeviceRunner device',
        readBirth: (pid) => `birth-${pid}`,
        kill: (pid, signal) => {
          calls.push(`${pid}:${signal}`);
        },
        isAlive: () => true,
        readDaemonPid: () => null,
        fileExists: () => true,
        removeFile: () => {
          calls.push('removeFile');
        },
        delay: () => {
          started();
          return sleep(60_000);
        },
        listApps: () => {
          calls.push('listApps');
          return '';
        },
        uninstallApp: () => {
          calls.push('uninstall');
        },
      },
    ),
  );
  const refused = assert.rejects(pending, { code: 'RUN_CANCELLED' });
  await ready;
  controller.abort(new RunCancelledError());
  await refused;
  assert.deepEqual(calls, ['101:SIGTERM']);
});

for (const platform of ['ios', 'android'] as const) {
  test(`abort during ${platform} launch preserves cleanup and prevents session persistence`, async () => {
    resetActiveSessionInMemoryForTest();
    const controller = new AbortController();
    const calls: string[] = [];
    const launch = async () => {
      calls.push('launch');
      controller.abort(new RunCancelledError());
    };
    const handler = createDeviceSnapshotHandler({
      ensureIosRunner: async () => ({ ok: true }),
      startAndroidRunner: async () => {
        calls.push('runner');
      },
      launchIosApp: launch,
      launchAndroidApp: launch,
      stopIosRunner: async () => {
        calls.push('cleanup');
      },
      reapAndroidRunner: async () => {
        calls.push('cleanup');
      },
      probeAndroidUi: async () => {
        throw new Error('later probe');
      },
      bindRunner: async () => {
        calls.push('bind');
      },
    });
    await assert.rejects(
      withCancellation(controller.signal, () =>
        handler({
          action: 'open',
          platform,
          appId: 'com.example.app',
          deviceId: 'device',
        }),
      ),
      { code: 'RUN_CANCELLED' },
    );
    assert.equal(getActiveSession(), null);
    assert.deepEqual(
      calls,
      platform === 'ios' ? ['launch', 'cleanup'] : ['runner', 'launch', 'cleanup'],
    );
  });
}

test('cancelling a later block never flushes an earlier saved action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qaren-cancel-blocks-'));
  try {
    const parsed = parsePlan(
      '## QA\n### First\n1. Wait for "Ready" to appear\n\n### Second\n1. Wait for "Missing" to appear',
    );
    assert.ok(parsed.blocks);
    const controller = new AbortController();
    const fake = walker(
      [screen([element('@ready', 'Ready', { testID: 'ready' })])],
      scriptedJudge(() => assert.fail('literal plan')),
    );
    fake.deps.sleep = async () => {
      controller.abort(new RunCancelledError());
      await sleep(60_000);
    };
    fake.deps.cancelled = () => controller.signal.aborted;
    await assert.rejects(
      withCancellation(controller.signal, () =>
        runPlan(parsed.blocks!, fake.deps, [], {
          appRoot: root,
          platform: 'ios',
          appId: 'com.example.app',
        }),
      ),
      { code: 'RUN_CANCELLED' },
    );
    const firstLine = parsed.blocks[0].items[0].line;
    assert.ok(fake.rows.some((row) => row.line === firstLine && row.outcome === 'pass'));
    assert.equal(existsSync(join(root, '.qaren', 'actions')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the attach deadline interrupts a stalled connect and records the host load', async () => {
  const stop = createStop();
  const calls: string[] = [];
  const pending = admit(
    {
      metroPort: 8081,
      readinessMs: 30_000,
      remainingMs: () => 25,
      load: () => 42,
      attach: async (deadline) => {
        assert.ok(deadline > performance.now());
        calls.push('attach');
        await sleep(60_000);
        calls.push('late connect');
      },
      foreignDriver: async () => {
        calls.push('foreign');
        return undefined;
      },
      open: async () => {
        calls.push('open');
      },
      prove: async () => ({ ok: true, scriptURL: 'bundle', appModules: 1 }),
      close: async () => {
        calls.push('cleanup');
      },
    },
    stop,
  );
  await assert.rejects(pending, /CDP attach deadline exceeded.*host 1-minute load 42.0/);
  await setImmediate();
  assert.deepEqual(calls, ['attach', 'cleanup']);
});

for (const replacement of ['different-birth', null]) {
  test(`legacy escalation refuses ${replacement ?? 'unknown'} birth identity`, async () => {
    let birth: string | null = 'original';
    const signals: string[] = [];
    const result = await ensureSingleRunner(
      { udid: 'device' },
      {
        listProcesses: () => '101 AgentDeviceRunner device',
        readBirth: () => birth,
        kill: (_pid, signal) => {
          signals.push(signal);
        },
        isAlive: () => true,
        readDaemonPid: () => null,
        fileExists: () => false,
        removeFile: () => assert.fail('unexpected removal'),
        delay: async () => {
          birth = replacement;
        },
        listApps: () => '{"com.example.app" = { ApplicationType = User; };}',
        uninstallApp: () => assert.fail('unexpected uninstall'),
      },
    );
    assert.deepEqual(signals, ['SIGTERM']);
    assert.deepEqual(result.killedPids, []);
    assert.match(result.warnings.join(' '), /PROCESS_OWNERSHIP_UNPROVEN/);
  });
}

test('legacy TERM refuses unknown identity before signaling', async () => {
  const result = await ensureSingleRunner(
    { udid: 'device' },
    {
      listProcesses: () => '101 AgentDeviceRunner device',
      readBirth: () => null,
      kill: () => assert.fail('unproven PID must not be signaled'),
      isAlive: () => true,
      readDaemonPid: () => null,
      fileExists: () => false,
      removeFile: () => assert.fail('unexpected removal'),
      delay: async () => assert.fail('unexpected grace sleep'),
      listApps: () => '{"com.example.app" = { ApplicationType = User; };}',
      uninstallApp: () => assert.fail('unexpected uninstall'),
    },
  );
  assert.deepEqual(result.killedPids, []);
  assert.match(result.warnings.join(' '), /PROCESS_OWNERSHIP_UNPROVEN/);
});

test('a live legacy Android daemon keeps its unproven PID and files', async () => {
  const { releaseAndroidInteractionSlot } =
    await import('../../../dist/runners/release-android-slot.js');
  const result = await releaseAndroidInteractionSlot(
    { deviceId: 'device' },
    {
      stopOwnRunner: async () => {},
      adbForceStop: async () => {},
      resolveSerial: () => ['-s', 'device'],
      readDaemonPid: () => 101,
      isAlive: () => true,
      fileExists: () => true,
      removeFile: () => assert.fail('unproven daemon record must be retained'),
      cleanupLegacy: () => true,
      now: () => 0,
    },
  );
  assert.deepEqual(result.killedDaemonPids, []);
  assert.deepEqual(result.removedFiles, []);
  assert.match(result.warnings.join(' '), /PROCESS_OWNERSHIP_UNPROVEN/);
});
