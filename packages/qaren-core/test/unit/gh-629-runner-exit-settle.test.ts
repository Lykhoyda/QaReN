import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { awaitChildExit } from '../../dist/runners/qaren-ios-runner-client.js';

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
  // Observation also accepts an exit already requested by its owner.
  const child = spawnKeepAlive("setInterval(() => {}, 1000); console.log('ready');");
  await whenReady(child);
  child.kill('SIGTERM');
  const t0 = Date.now();
  assert.equal(await awaitChildExit(child, 3000), true);
  assert.ok(Date.now() - t0 < 3000, 'settled via SIGTERM, not the SIGKILL escalation');
  assert.equal(child.signalCode, 'SIGTERM');
});

test('a child that ignores cancellation is retained when the grace expires', async () => {
  const child = spawnKeepAlive(
    "process.on('SIGINT', () => {}); setInterval(() => {}, 1000); console.log('ready');",
  );
  try {
    await whenReady(child);
    child.kill('SIGINT');
    assert.equal(await awaitChildExit(child, 50), false);
    assert.equal(child.signalCode, null);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('an initializing runner is never force-killed when the wait expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: Array<string | undefined> = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: (signal?: string) => {
      signals.push(signal);
      return true;
    },
  }) as unknown as ChildProcess;
  const settling = awaitChildExit(child, 100);
  t.mock.timers.tick(100);
  assert.equal(await settling, false);
  assert.deepEqual(signals, []);
  assert.equal(child.listenerCount('exit'), 0);
});
