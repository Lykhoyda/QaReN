import assert from 'node:assert/strict';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runMaestroInline } from '../../dist/maestro-invoke.js';
import { spawnManagedProcessGroup } from '../../dist/lifecycle/managed-automation.js';
import { buildReplayEngineStatus, MAESTRO_RUNNER_PIN } from '../../dist/domain/engine-pin.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    return (
      commandEnd < 0 ||
      stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/, 1)[0] !== 'Z'
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

async function waitForFile(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Number(readFileSync(path, 'utf8'));
}

async function waitForChildClose(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'close');
}

test('managed executor removes process-group descendants after timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-group-'));
  const pidFile = join(dir, 'child.pid');
  try {
    const script = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      fs.writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const pending = spawnManagedProcessGroup(process.execPath, ['-e', script, pidFile], {
      timeoutMs: 1_000,
      platform: 'ios',
      tool: 'fixture',
    });
    const childPid = await waitForFile(pidFile);
    const result = await pending;
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupProven, true);
    assert.equal(alive(childPid), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('managed executor escalates a resistant process group to SIGKILL', async () => {
  let child: ChildProcess | null = null;
  let killed = false;
  let closed = false;
  const result = await spawnManagedProcessGroup(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { timeoutMs: 100, platform: 'ios', tool: 'resistant' },
    {
      spawn: ((bin, args, options) => {
        child = spawnChild(bin, args, options);
        child.once('close', () => {
          closed = true;
        });
        return child;
      }) as typeof spawnChild,
      signalGroup: (_pgid, signal) => {
        if (signal === 'SIGKILL') {
          child?.kill(signal);
          killed = true;
        }
      },
      groupLiveness: () => (killed && closed ? 'no-live-members' : 'live'),
    },
  );
  await waitForChildClose(child);
  assert.equal(result.cleanupProven, true);
  assert.equal(result.cleanupEscalated, true);
  assert.equal(result.signal, 'SIGKILL');
});

test('zombie-only process groups count as absent and do not retain a refusal', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4343,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const pending = spawnManagedProcessGroup(
    'maestro',
    [],
    { timeoutMs: 1_000, platform: 'ios', deviceId: 'UDID-ZOMBIE', tool: 'zombie' },
    {
      spawn: (() => child) as typeof spawnChild,
      signalGroup: () => {},
      groupLiveness: () => 'no-live-members',
    },
  );
  setImmediate(() => child.emit('close', 0, null));
  const result = await pending;
  assert.equal(result.cleanupProven, true);
  assert.equal(result.cleanupRefusal, undefined);
});

test('output overflow remains an executor failure after exit zero', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4444,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const pending = spawnManagedProcessGroup(
    'maestro',
    [],
    { timeoutMs: 1_000, platform: 'ios', tool: 'overflow' },
    {
      spawn: (() => child) as typeof spawnChild,
      signalGroup: () => {},
      groupLiveness: () => 'no-live-members',
    },
  );
  setImmediate(() => {
    child.stdout.write(Buffer.alloc(10 * 1024 * 1024 + 1, 'x'));
    child.emit('close', 0, null);
  });
  const result = await pending;
  assert.equal(result.code, 0);
  assert.equal(result.error, 'Maestro output exceeded 10 MiB');
  assert.equal(result.cleanupProven, true);
});

test('inline Maestro cannot pass an output-overflow execution that exits zero', async () => {
  const result = await runMaestroInline(
    '- tapOn: Continue',
    { platform: 'ios', appId: 'com.example.app' },
    {
      chooseDispatch: (() => ({
        runner: 'maestro',
        binPath: '/fake/maestro',
        buildArgs: () => [],
      })) as never,
      resolveEngineStatus: async () =>
        buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
      spawnManaged: async () => ({
        stdout: '',
        stderr: '',
        code: 0,
        signal: null,
        timedOut: false,
        cleanupProven: true,
        cleanupEscalated: false,
        error: 'Maestro output exceeded 10 MiB',
      }),
    },
  );
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, 'Maestro output exceeded 10 MiB');
});

test('spawn-before-PID failure returns its own error', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const pending = spawnManagedProcessGroup(
    'missing-maestro',
    [],
    { timeoutMs: 1_000, platform: 'ios', deviceId: 'UDID-SPAWN', tool: 'spawn-failure' },
    { spawn: (() => child) as typeof spawnChild },
  );
  setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
  const result = await pending;
  assert.equal(result.error, 'spawn ENOENT');
  assert.equal(result.cleanupProven, true);
  assert.equal(result.cleanupRefusal, undefined);
});

test('unproven cleanup returns manual guidance and refuses the same bridge device', async () => {
  let spawnCalls = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const spawn = (() => {
    spawnCalls += 1;
    return child;
  }) as typeof spawnChild;
  const signalGroup = (_pgid: number, signal: NodeJS.Signals | 0) => {
    if (signal === 'SIGKILL') return;
    if (signal === 0 && spawnCalls > 0) {
      const error = new Error('unknown') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
  };
  const first = spawnManagedProcessGroup(
    'maestro',
    [],
    { timeoutMs: 1_000, platform: 'ios', deviceId: 'UDID-FENCED', tool: 'first' },
    { spawn, signalGroup, groupLiveness: () => 'unknown' },
  );
  setImmediate(() => child.emit('close', 1, null));
  const unproven = await first;
  assert.equal(unproven.cleanupProven, false);
  assert.deepEqual(unproven.cleanupRefusal, {
    processGroup: 'owned-process-group',
    manualCommand: 'kill -TERM -4242',
  });

  const refused = await spawnManagedProcessGroup(
    'maestro',
    [],
    { timeoutMs: 1_000, platform: 'ios', deviceId: 'UDID-FENCED', tool: 'second' },
    { spawn, signalGroup, groupLiveness: () => 'unknown' },
  );
  assert.equal(refused.cleanupProven, false);
  assert.equal(refused.cleanupRefusal?.manualCommand, 'kill -TERM -4242');
  assert.equal(spawnCalls, 1);
});
