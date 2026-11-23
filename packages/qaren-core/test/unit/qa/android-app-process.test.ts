import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { androidAppProcess, androidPidofAnswer } from '../../../dist/handlers/device-session.js';
import { withCancellation } from '../../../dist/domain/cancellation.js';

const appId = 'com.example.synthetic';
const serial = 'synthetic-android';
type Read =
  | { stdout: string; stderr?: string }
  | { code: unknown; stdout?: string; stderr?: string; killed?: boolean }
  | 'pending';

const exit = (code: unknown, stdout = '', stderr = '', killed = false) => ({
  code,
  stdout,
  stderr,
  killed,
});

// A fake clock and a promisified execFile that answers each pidof read in turn.
function pidof(t: TestContext, reads: Read[]) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: number[] = [];
  const execute = (() => {
    throw new Error('use the promise boundary');
  }) as typeof childProcess.execFile;
  Object.defineProperty(execute, promisify.custom, {
    value: async (file: string, args: string[], options: { timeout: number; encoding: string }) => {
      calls.push(now);
      assert.equal(file, 'adb');
      assert.deepEqual(args, ['-s', serial, 'shell', 'pidof', appId]);
      assert.equal(options.timeout, 5000);
      assert.equal(options.encoding, 'utf8');
      const read = reads.shift();
      assert.ok(read, 'no more reads were scripted');
      if (read === 'pending') return new Promise<never>(() => undefined);
      if ('code' in read)
        throw Object.assign(new Error('Command failed'), {
          code: read.code,
          stdout: read.stdout ?? '',
          stderr: read.stderr ?? '',
          killed: read.killed ?? false,
        });
      return { stdout: read.stdout, stderr: read.stderr ?? '' };
    },
  });
  const original = childProcess.execFile;
  childProcess.execFile = execute;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = original;
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  return {
    calls,
    // Lets pending reads settle first, so a pause starts before the clock moves.
    async advance(ms: number) {
      await nextTurn();
      now += ms;
      t.mock.timers.tick(ms);
      await nextTurn();
    },
  };
}

test('P1: the pidof answer has three outcomes', () => {
  assert.equal(androidPidofAnswer(exit(0, '4242\n')), 'running');
  assert.equal(androidPidofAnswer(exit(0, '  12\t4242 \n')), 'running');
  assert.equal(androidPidofAnswer(exit(0, '4294967295\n')), 'running');
  assert.equal(androidPidofAnswer(exit(0, '12x\n')), 'fault');
  assert.equal(androidPidofAnswer(exit(0, '99999999999\n')), 'fault');
  assert.equal(androidPidofAnswer(exit(0, ' \n')), 'none');
  assert.equal(androidPidofAnswer(exit(1)), 'none');
  assert.equal(androidPidofAnswer(exit(1, '', 'error: device offline\n')), 'fault');
  assert.equal(androidPidofAnswer(exit(2)), 'fault');
  assert.equal(androidPidofAnswer(exit(0, '4242\n', '', true)), 'fault');
  assert.equal(androidPidofAnswer(exit(1, '', '', true)), 'fault');
  assert.equal(androidPidofAnswer(exit('ENOENT')), 'fault');
  assert.equal(androidPidofAnswer(exit(null)), 'fault');
});

test('P1: a pid is running after one read', async (t) => {
  for (const stdout of ['4242\n', ' 12 4242\n'])
    await t.test(JSON.stringify(stdout), async (t) => {
      const stub = pidof(t, [{ stdout }]);
      assert.equal(await androidAppProcess(appId, serial), true);
      assert.equal(stub.calls.length, 1);
    });
});

test('P1: not running needs two empty reads one second apart', async (t) => {
  for (const code of [0, 1]) {
    await t.test(`exit ${code}`, async (t) => {
      const stub = pidof(t, code === 0 ? [{ stdout: '' }, { stdout: '\n' }] : [exit(1), exit(1)]);
      const pending = androidAppProcess(appId, serial);
      await stub.advance(999);
      assert.deepEqual(stub.calls, [0], 'no immediate second read');
      await stub.advance(1);
      assert.equal(await pending, false);
      assert.deepEqual(stub.calls, [0, 1000]);
    });
  }
});

test('P1: an empty read followed by a pid or a fault', async (t) => {
  for (const [name, second] of [
    ['then a pid', { stdout: '4242\n' }],
    ['then a fault', exit(1, '', 'error: closed\n')],
  ] as const)
    await t.test(name, async (t) => {
      const stub = pidof(t, [exit(1), second]);
      const pending = androidAppProcess(appId, serial);
      pending.catch(() => undefined);
      await stub.advance(1000);
      if ('code' in second) await assert.rejects(pending, Error);
      else assert.equal(await pending, true);
      assert.deepEqual(stub.calls, [0, 1000]);
    });
});

test('P1: a fault is never read as not running', async (t) => {
  for (const [name, read] of [
    ['exit 1 with stderr', exit(1, '', 'error: device offline\n')],
    ['killed', exit(null, '', '', true)],
    ['adb missing', exit('ENOENT')],
    ['not a pid', { stdout: '12x\n' }],
  ] as const)
    await t.test(name, async (t) => {
      const stub = pidof(t, [read]);
      await assert.rejects(androidAppProcess(appId, serial), Error);
      assert.equal(stub.calls.length, 1);
    });
});

test('P1: an invalid app id or serial issues no command', async (t) => {
  for (const [id, device] of [
    ['com.example;reboot', serial],
    ['', serial],
    [appId, ''],
    [appId, 'bad serial!'],
  ])
    await t.test(`${JSON.stringify(id)} on ${JSON.stringify(device)}`, async (t) => {
      const stub = pidof(t, []);
      await assert.rejects(androidAppProcess(id, device), Error);
      assert.equal(stub.calls.length, 0);
    });
});

test('P1: an abort during the read or the pause is rethrown', async (t) => {
  for (const [name, read] of [
    ['during the read', 'pending'],
    ['during the pause', exit(1)],
  ] as const)
    await t.test(name, async (t) => {
      const stub = pidof(t, [read]);
      const controller = new AbortController();
      const reason = new DOMException('stopping', 'AbortError');
      const pending = withCancellation(controller.signal, () => androidAppProcess(appId, serial));
      pending.catch(() => undefined);
      await stub.advance(500);
      assert.equal(stub.calls.length, 1);
      controller.abort(reason);
      await assert.rejects(pending, (error) => error === reason);
      assert.equal(stub.calls.length, 1);
    });
});
