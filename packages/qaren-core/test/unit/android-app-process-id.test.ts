import assert from 'node:assert/strict';
import { test } from 'node:test';
import { androidAppProcessId } from '../../dist/handlers/device-session.js';

const sequence = (reads: { stdout: string; code?: unknown; stderr?: string }[]) => {
  const queue = [...reads];
  const calls: string[][] = [];
  const waits: number[] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const next = queue.shift() ?? { stdout: '', code: 1, stderr: '' };
    return { code: next.code ?? 0, stdout: next.stdout, stderr: next.stderr ?? '' };
  };
  const pause = async (ms: number) => {
    waits.push(ms);
  };
  return { run, pause, calls, waits };
};

test('P1 one pid is the app process, read on the exact serial', async () => {
  const fake = sequence([{ stdout: '4321\n' }]);
  assert.equal(
    await androidAppProcessId('com.rndevagent.testapp', 'emulator-5554', fake.run, fake.pause),
    4321,
  );
  assert.deepEqual(fake.calls, [
    ['-s', 'emulator-5554', 'shell', 'pidof', 'com.rndevagent.testapp'],
  ]);
  assert.deepEqual(fake.waits, []);
});

test('P2 two empty reads a second apart mean not running', async () => {
  const fake = sequence([
    { stdout: '', code: 1 },
    { stdout: '', code: 1 },
  ]);
  assert.equal(
    await androidAppProcessId('com.rndevagent.testapp', 'emulator-5554', fake.run, fake.pause),
    undefined,
  );
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.waits, [1000]);
});

test('P3 more than one pid is unreadable, never "not running"', async () => {
  const first = sequence([{ stdout: '4321 4400\n' }]);
  await assert.rejects(
    androidAppProcessId('com.rndevagent.testapp', 'emulator-5554', first.run, first.pause),
  );
  const second = sequence([{ stdout: '', code: 1 }, { stdout: '4321 4400\n' }]);
  await assert.rejects(
    androidAppProcessId('com.rndevagent.testapp', 'emulator-5554', second.run, second.pause),
  );
});

test('P4 a failed read rejects', async () => {
  const fake = sequence([{ stdout: '', code: 255, stderr: 'error: device offline' }]);
  await assert.rejects(
    androidAppProcessId('com.rndevagent.testapp', 'emulator-5554', fake.run, fake.pause),
  );
  assert.deepEqual(fake.waits, []);
});

test('P5 an app id or serial that is not exact is refused before adb runs', async () => {
  const fake = sequence([{ stdout: '1\n' }]);
  await assert.rejects(
    androidAppProcessId('com.app; reboot', 'emulator-5554', fake.run, fake.pause),
  );
  await assert.rejects(androidAppProcessId('com.rndevagent.testapp', '', fake.run, fake.pause));
  assert.deepEqual(fake.calls, []);
});

test('P6 one empty read followed by a pid returns that pid', async () => {
  const fake = sequence([{ stdout: '', code: 1 }, { stdout: '4321\n' }]);
  assert.equal(
    await androidAppProcessId('com.rndevagent.testapp', 'emulator-5554', fake.run, fake.pause),
    4321,
  );
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.waits, [1000]);
});
