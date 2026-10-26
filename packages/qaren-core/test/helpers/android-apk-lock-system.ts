import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';
import type { TestContext } from 'node:test';

export function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Fake the kernel boundary, keeping the real identity parser, group cleanup and SQLite fence.
export function apkLockSystem(t: TestContext) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  let sequence = 1;
  const processes = new Map<number, { pgid: number; started: number; unknown?: boolean }>();
  const addProcess = (pid: number, pgid = pid) => {
    processes.set(pid, { pgid, started: sequence++ });
  };
  addProcess(process.pid);
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof originalRead>) => {
    const path = String(args[0]);
    if (path === '/proc/sys/kernel/random/boot_id') return 'fixture-boot';
    const match = /^\/proc\/(\d+)\/stat$/.exec(path);
    if (!match) return Reflect.apply(originalRead, fs, args);
    const pid = Number(match[1]);
    const entry = processes.get(pid);
    if (!entry || entry.unknown)
      throw Object.assign(new Error('fixture process unreadable'), {
        code: entry ? 'EACCES' : 'ENOENT',
      });
    const fields = Array<string>(20).fill('0');
    fields[0] = 'S';
    fields[1] = '1';
    fields[2] = String(entry.pgid);
    fields[19] = String(entry.started);
    return `${pid} (fixture) ${fields.join(' ')}`;
  });
  const originalReaddir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof originalReaddir>) =>
    String(args[0]) === '/proc'
      ? [...processes.keys()].map(String)
      : Reflect.apply(originalReaddir, fs, args),
  );
  const signals: { pid: number; signal: string | number | undefined }[] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    assert.ok(pid > 0, 'cleanup must target an individual owned writer');
    if (!processes.has(pid)) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    if (signal === 0) return true;
    assert.equal(signal, 'SIGKILL');
    signals.push({ pid, signal });
    processes.delete(pid);
    return true;
  });
  for (const method of ['execFileSync', 'spawn'] as const) {
    t.mock.method(childProcess, method, () => assert.fail(`unexpected host ${method}`));
  }
  let sleepCalls = 0;
  const sleeps: number[] = [];
  const subscribers: ((ms: number) => void)[] = [];
  const nextSleep = () => {
    const ms = sleeps.shift();
    let subscriber: ((ms: number) => void) | undefined;
    const promise =
      ms === undefined
        ? new Promise<number>((resolve) => {
            subscriber = resolve;
            subscribers.push(resolve);
          })
        : Promise.resolve(ms);
    return {
      promise,
      cancel: () => {
        const index = subscriber ? subscribers.indexOf(subscriber) : -1;
        if (index >= 0) subscribers.splice(index, 1);
      },
    };
  };
  t.mock.method(
    timers,
    'setTimeout',
    (ms: number, value: unknown, options?: { signal?: AbortSignal }) => {
      sleepCalls++;
      const subscriber = subscribers.shift();
      if (subscriber) subscriber(ms);
      else sleeps.push(ms);
      return new Promise((resolve, reject) => {
        const signal = options?.signal;
        signal?.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        }, ms);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    t.mock.timers.reset();
    Object.defineProperty(process, 'platform', platform);
    syncBuiltinESMExports();
  });
  return {
    processes,
    addProcess,
    signals,
    get sleepCalls() {
      return sleepCalls;
    },
    nextSleep: (operation: Promise<unknown>) => {
      const waiting = nextSleep();
      return Promise.race([
        waiting.promise,
        operation.then(() => assert.fail('operation finished without waiting')),
      ]).finally(waiting.cancel);
    },
    withoutSleeping: (operation: Promise<unknown>) => {
      const waiting = nextSleep();
      return Promise.race([
        operation,
        waiting.promise.then(() => assert.fail('operation waited instead of finishing')),
      ]).finally(waiting.cancel);
    },
    advance: (ms: number) => t.mock.timers.tick(ms),
  };
}
