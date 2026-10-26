import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  cancellableFetch,
  execFile,
  interruptible,
  isAbort,
  throwIfCancelled,
  RunCancelledError,
  sleep,
  spawn,
  withCancellation,
} from '../../../src/domain/cancellation.ts';

const execute = promisify(execFile);

test('abort at each I/O primitive blocks the next forward effect', async () => {
  for (const primitive of [
    'HTTP request',
    'CDP or runner response',
    'polling sleep',
    'exec',
    'spawn',
  ] as const) {
    const controller = new AbortController();
    const calls: string[] = [];
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release: () => void = () => {};
    let exit: Promise<unknown> | undefined;
    const pending = withCancellation(controller.signal, async () => {
      calls.push(primitive);
      switch (primitive) {
        case 'HTTP request':
          await cancellableFetch(async (_input, options) => {
            ready();
            return new Promise<Response>((resolve, reject) => {
              release = () => resolve(Response.json({ ok: true }));
              options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                once: true,
              });
            });
          }, 'http://localhost/command');
          break;
        case 'CDP or runner response':
          await interruptible((signal) => {
            assert.equal(signal, controller.signal);
            ready();
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          });
          break;
        case 'polling sleep': {
          const waiting = sleep(60_000);
          ready();
          await waiting;
          break;
        }
        case 'exec': {
          const waiting = execute(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
          ready();
          await waiting;
          break;
        }
        case 'spawn': {
          const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
          child.on('error', () => {});
          exit = new Promise((resolve) => child.once('close', resolve));
          const waiting = interruptible(() => exit!);
          ready();
          await waiting;
          break;
        }
      }
      calls.push('later effect');
    });
    const refused = assert.rejects(pending);
    await started;
    controller.abort(new RunCancelledError());
    release();
    await refused;
    if (exit) await exit;
    assert.deepEqual(calls, [primitive]);
    const resumed = withCancellation(controller.signal, () =>
      interruptible(async () => {
        calls.push('late retry');
      }),
    );
    await assert.rejects(resumed);
    assert.deepEqual(calls, [primitive]);
    await withCancellation(undefined, () =>
      execute(process.execPath, ['-e', 'process.stdout.write("cleaned")']),
    ).then(({ stdout }) => assert.equal(stdout, 'cleaned'));
  }
});

test('ordinary primitive completion preserves results and child-process options', async () => {
  const controller = new AbortController();
  await withCancellation(controller.signal, async () => {
    assert.equal(
      await interruptible(async (signal) => {
        assert.equal(signal, controller.signal);
        return 7;
      }),
      7,
    );
    const { stdout } = await execute(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.CANCEL_TEST)'],
      {
        env: { ...process.env, CANCEL_TEST: 'result' },
        encoding: 'utf8',
      },
    );
    assert.equal(stdout, 'result');
    await sleep(1);
  });
});

test('one deadline interrupts every connect primitive before its continuation', async () => {
  const { withDeadline } = await import('../../../src/domain/cancellation.ts');
  for (const primitive of ['discovery', 'handshake', 'probe', 'setup', 'retry sleep']) {
    const timeout = new Error('attach deadline exceeded');
    const effects: string[] = [];
    let release!: () => void;
    const pending = withDeadline(performance.now() + 20, timeout, async () => {
      effects.push(primitive);
      await interruptible(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      effects.push('next effect');
    });
    await assert.rejects(pending, (error) => error === timeout);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(effects, [primitive]);
  }
});

test('ambient cancellation survives wrapped errors and explicit signal omission', () => {
  const controller = new AbortController();
  const extra = new AbortController();
  const reason = new Error('walk stopped');
  withCancellation(controller.signal, () => {
    assert.equal(isAbort(new Error('ordinary failure')), false);
    assert.doesNotThrow(() => throwIfCancelled());
    controller.abort(reason);
    assert.equal(isAbort(new Error('wrapped failure')), true);
    assert.throws(
      () => throwIfCancelled(),
      (error) => error === reason,
    );
    assert.throws(
      () => throwIfCancelled(extra.signal),
      (error) => error === reason,
    );
    withCancellation(undefined, () => {
      assert.equal(isAbort(new Error('cleanup failure')), false);
      assert.doesNotThrow(() => throwIfCancelled());
    });
  });
});
