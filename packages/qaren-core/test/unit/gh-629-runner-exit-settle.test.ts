import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { awaitChildExit } from '../../dist/runners/rn-fast-runner-client.js';

// GH #629: the first-start retry may only proceed once the failed first launch
// has provably exited. These exercise the real settle logic against real
// processes — the injected-fixture suite covers the retry decision, this one
// covers the primitive that decision trusts.

function spawnKeepAlive(script: string): ChildProcess {
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
}

// The child prints 'ready' only once its signal disposition is installed —
// waiting on the 'spawn' event alone races the script's own evaluation.
async function whenReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => {
      if (chunk.includes('ready')) resolve();
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('child exited before signalling ready')));
  });
}

test('a null handle settles immediately (nothing to wait for)', async () => {
  const t0 = Date.now();
  assert.equal(await awaitChildExit(null, 5000), true);
  assert.ok(Date.now() - t0 < 1000, 'must not wait on an absent process');
});

test('an already-exited child settles immediately without escalation', async () => {
  const child = spawnKeepAlive('');
  await new Promise((resolve) => child.once('exit', resolve));
  const t0 = Date.now();
  assert.equal(await awaitChildExit(child, 5000), true);
  assert.ok(Date.now() - t0 < 1000, 'an exited child must not burn the grace window');
});

test('a child that honours SIGTERM settles true before the grace cap', async () => {
  // The READY timeout has already sent SIGTERM in production; teardown is async.
  const child = spawnKeepAlive("setInterval(() => {}, 1000); console.log('ready');");
  await whenReady(child);
  child.kill('SIGTERM');
  const t0 = Date.now();
  assert.equal(await awaitChildExit(child, 3000), true);
  assert.ok(Date.now() - t0 < 3000, 'settled via SIGTERM, not the SIGKILL escalation');
  assert.equal(child.signalCode, 'SIGTERM');
});

test('a child that ignores SIGTERM is escalated to SIGKILL at the grace cap', async () => {
  const child = spawnKeepAlive(
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');",
  );
  await whenReady(child);
  child.kill('SIGTERM');
  const t0 = Date.now();
  assert.equal(await awaitChildExit(child, 300), true);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 300, `escalation fired before the grace cap: ${elapsed}ms`);
  assert.ok(elapsed < 2300, `escalation must not fall through to the backstop: ${elapsed}ms`);
  // SIGKILL, not a voluntary exit: the escalation is what reaped it.
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(child.exitCode, null);
});

test('a handle surviving SIGKILL is refused at the backstop (retry must not stack)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // A real process cannot survive SIGKILL, so the unkillable-zombie shape is
  // modelled with a handle that reports itself live and never emits 'exit'.
  const signals: Array<string | undefined> = [];
  const zombie = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: (signal?: string) => {
      signals.push(signal);
      return true;
    },
  }) as unknown as ChildProcess;

  let settled: boolean | undefined;
  const settling = awaitChildExit(zombie, 100).then((result) => {
    settled = result;
    return result;
  });

  t.mock.timers.tick(100);
  assert.deepEqual(signals, ['SIGKILL'], 'escalation is attempted before giving up');
  t.mock.timers.tick(1999);
  await Promise.resolve();
  assert.equal(settled, undefined, 'the process remains unsettled before the backstop');

  t.mock.timers.tick(1);
  assert.equal(await settling, false, 'a surviving process must refuse the retry');
  assert.equal(
    (zombie as unknown as EventEmitter).listenerCount('exit'),
    0,
    'the exit listener must be removed when the backstop gives up',
  );
});
