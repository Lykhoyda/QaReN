import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The installer reads its runner directory at import: point it at a fixture first.
const root = mkdtempSync(join(tmpdir(), 'qaren-runner-install-blocked-'));
const runner = join(root, 'qaren-android-runner');
const appApk = join(runner, 'app/build/outputs/apk/debug/app-debug.apk');
const testApk = join(runner, 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
const apkLock = join(runner, 'app/build/.qaren-apk-lock');
mkdirSync(dirname(appApk), { recursive: true });
mkdirSync(dirname(testApk), { recursive: true });
writeFileSync(join(runner, 'gradlew'), '');
writeFileSync(appApk, 'this host app APK');
writeFileSync(testApk, 'this host test APK');
const previousRoot = process.env.QAREN_NATIVE_RUNNER_ROOT;
process.env.QAREN_NATIVE_RUNNER_ROOT = root;
// Runner state and the session file live under the QaReN home: never touch the real one.
const previousHome = process.env.QAREN_HOME;
process.env.QAREN_HOME = join(root, 'home');
const client = await import('../../dist/runners/qaren-android-runner-client.js');
const { createDeviceSnapshotHandler } = await import('../../dist/handlers/device-session.js');
const { attachMetaNote, clearActiveSession, runNative } =
  await import('../../dist/agent-device-wrapper.js');
const { unwrap } = await import('../../dist/qa/adapt.js');
const { okResult } = await import('../../dist/utils.js');
const { withCancellation, RunCancelledError, isAbort } =
  await import('../../dist/domain/cancellation.js');
if (previousRoot === undefined) delete process.env.QAREN_NATIVE_RUNNER_ROOT;
else process.env.QAREN_NATIVE_RUNNER_ROOT = previousRoot;

const SERIAL = 'emulator-5560';
const MAIN = 'dev.lykhoyda.rndevagent.androidrunner';
const TEST = `${MAIN}.test`;
const PROCESSES_HEADER = 'ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)';

test.after(() => {
  if (previousHome === undefined) delete process.env.QAREN_HOME;
  else process.env.QAREN_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

type Channel = 'stdout' | 'stderr' | 'message';
type Kind = 'signature' | 'downgrade';

interface Fixture {
  /** Runner packages already on the device from another host or a newer version. */
  foreign?: string[];
  kind?: Kind;
  channel?: Channel;
  /** The block survives the uninstall, so the one reinstall fails too. */
  stickyBlock?: boolean;
  /** The device still runs a runner process after the confirmed stop. */
  survivingRunner?: boolean;
  /** Uninstall of these packages fails (the package stays unless `keepListed` says otherwise). */
  uninstallFails?: string[];
  /** These packages are still listed after their uninstall. */
  keepListed?: string[];
  listFails?: boolean;
  /** The package list command succeeds but prints something other than package lines. */
  listMalformed?: boolean;
  /** An unrelated install failure for the first APK, as adb prints it. */
  unrelated?: string;
  /** Rejects this command with a killed (timed-out) child. */
  killOn?: string;
  /** Runs before a command whose joined args contain the key. */
  before?: Record<string, () => void>;
}

function rejection(args: string[], fx: Fixture, adbText: string) {
  const command = `Command failed: adb ${args.join(' ')}`;
  const channel = fx.channel ?? 'stderr';
  // Node puts stderr in the message, never stdout.
  if (channel === 'stdout')
    return Object.assign(new Error(command), {
      code: 1,
      killed: false,
      signal: null,
      stdout: `Performing Streamed Install\n${adbText}\n`,
      stderr: '',
    });
  if (channel === 'stderr')
    return Object.assign(new Error(`${command}\nadb: failed to install: ${adbText}\n`), {
      code: 1,
      killed: false,
      signal: null,
      stdout: 'Performing Streamed Install\n',
      stderr: `adb: failed to install: ${adbText}\n`,
    });
  return new Error(`${command}\n${adbText}`);
}

function blockText(kind: Kind, pkg: string): string {
  return kind === 'signature'
    ? `Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package ${pkg} signatures do not match newer version; ignoring!]`
    : 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]';
}

function harness(t: TestContext, fx: Fixture = {}) {
  const device = new Map<string, 'this-host' | 'foreign'>();
  for (const pkg of fx.foreign ?? []) device.set(pkg, 'foreign');
  const commands: string[][] = [];
  const effects = { installs: 0, uninstalls: [] as string[] };
  const originalLease = process.env.QAREN_DEVICE_LEASE;
  const originalSerial = process.env.ANDROID_SERIAL;
  const originalExecFile = childProcess.execFile;
  process.env.QAREN_DEVICE_LEASE = 'test-check:0123456789abcdef';
  delete process.env.ANDROID_SERIAL;
  client._setAndroidRunnerStateForTest(null);
  client.consumePendingAndroidUpgradeNote();
  t.after(() => {
    if (originalLease === undefined) delete process.env.QAREN_DEVICE_LEASE;
    else process.env.QAREN_DEVICE_LEASE = originalLease;
    if (originalSerial !== undefined) process.env.ANDROID_SERIAL = originalSerial;
    t.mock.restoreAll();
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    client._setAndroidRunnerStateForTest(null);
    client.consumePendingAndroidUpgradeNote();
    clearActiveSession();
    // A forced stop keeps the APK fence on purpose; each test starts from a fresh one.
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      rmSync(`${apkLock}${suffix}`, { recursive: true, force: true });
  });
  const execute = (() => {
    throw new Error('use the promisified subprocess boundary');
  }) as typeof childProcess.execFile;
  Object.defineProperty(execute, promisify.custom, {
    configurable: true,
    value: async (file: string, args: string[]) => {
      if (file === join(runner, 'gradlew')) return { stdout: '', stderr: '' };
      assert.equal(file, 'adb');
      commands.push(args);
      const joined = args.join(' ');
      for (const [key, run] of Object.entries(fx.before ?? {})) if (joined.includes(key)) run();
      if (fx.killOn && joined.includes(fx.killOn))
        throw Object.assign(new Error(`Command failed: adb ${joined}`), {
          killed: true,
          signal: 'SIGTERM',
          code: null,
          stdout: '',
          stderr: '',
        });
      if (args[0] === 'devices')
        return { stdout: `List of devices attached\n${SERIAL}\tdevice\n\n` };
      // `forward --list` is host-wide; the runner's own forward keeps today's optional serial.
      if (args[0] === 'forward') return { stdout: '' };
      assert.deepEqual(
        args.slice(0, 2),
        ['-s', SERIAL],
        `every device command names the serial: ${joined}`,
      );
      const command = args.slice(2);
      const text = command.join(' ');
      if (command[0] === 'get-state') return { stdout: 'device\n' };
      if (text === 'shell pm list instrumentation') return { stdout: '' };
      if (text.startsWith('shell am force-stop')) return { stdout: '' };
      if (text.startsWith('shell dumpsys activity processes'))
        return {
          stdout: `${PROCESSES_HEADER}\n${fx.survivingRunner ? `  *APP* UID 10123 ProcessRecord{1 1234:${MAIN}/u0a123}\n` : ''}`,
        };
      if (text.startsWith('shell pm list packages')) {
        if (fx.listFails) throw new Error('Command failed: adb shell pm list packages');
        if (fx.listMalformed) return { stdout: 'Error: could not access the Package Manager.\n' };
        const filter = command[4] ?? '';
        return {
          stdout: [...device.keys()]
            .filter((pkg) => pkg.includes(filter))
            .map((pkg) => `package:${pkg}\n`)
            .join(''),
        };
      }
      if (command[0] === 'uninstall') {
        const pkg = command[1];
        effects.uninstalls.push(pkg);
        const existed = device.has(pkg);
        if (!fx.keepListed?.includes(pkg) && !fx.uninstallFails?.includes(pkg)) device.delete(pkg);
        // adb fails the uninstall of a package that is not installed.
        if (fx.uninstallFails?.includes(pkg) || !existed)
          throw Object.assign(new Error(`Command failed: adb ${joined}`), {
            code: 1,
            stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]\n',
            stderr: '',
          });
        return { stdout: 'Success\n' };
      }
      if (command[0] === 'install') {
        effects.installs++;
        const pkg = command[2] === appApk ? MAIN : TEST;
        if (fx.unrelated && pkg === MAIN) throw rejection(args, fx, fx.unrelated);
        if (device.get(pkg) === 'foreign' || (fx.stickyBlock && effects.uninstalls.length > 0))
          throw rejection(args, fx, blockText(fx.kind ?? 'signature', pkg));
        device.set(pkg, 'this-host');
        return { stdout: 'Success\n' };
      }
      assert.equal(command[0], 'forward', `unexpected adb command: ${joined}`);
      return { stdout: '' };
    },
  });
  childProcess.execFile = execute;
  t.mock.method(childProcess, 'spawn', () => {
    throw new Error('instrumentation launch reached');
  });
  syncBuiltinESMExports();
  return { device, commands, effects };
}

const LAUNCHED = /instrumentation launch reached/;

function deviceChanges(commands: string[][]): string[] {
  return commands
    .map((args) => args.slice(2).join(' '))
    .filter((c) => /^(install|uninstall|shell am force-stop)/.test(c))
    .map((c) => c.replace(appApk, 'app.apk').replace(testApk, 'test.apk'));
}

test('AI-513: runnerInstallBlock names the two blocks adb reports and nothing else', () => {
  assert.equal(client.runnerInstallBlock(blockText('signature', MAIN)), 'signature');
  assert.equal(client.runnerInstallBlock(blockText('downgrade', MAIN)), 'downgrade');
  assert.equal(
    client.runnerInstallBlock('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]'),
    undefined,
  );
  assert.equal(client.runnerInstallBlock('error: device offline'), undefined);
  assert.equal(client.runnerInstallBlock(''), undefined);
});

for (const kind of ['signature', 'downgrade'] as const) {
  for (const channel of ['stdout', 'stderr', 'message'] as const) {
    test(`AI-513: a ${kind} block on the first APK via ${channel} replaces both runner apps once`, async (t) => {
      const { device, commands, effects } = harness(t, { foreign: [MAIN, TEST], kind, channel });
      await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), LAUNCHED);
      assert.deepEqual(deviceChanges(commands), [
        'install -r app.apk',
        `shell am force-stop ${TEST}`,
        `shell am force-stop ${MAIN}`,
        `uninstall ${MAIN}`,
        `uninstall ${TEST}`,
        'install -r app.apk',
        'install -r test.apk',
      ]);
      assert.equal(effects.installs, 3);
      assert.equal(device.get(MAIN), 'this-host');
      assert.equal(device.get(TEST), 'this-host');
      assert.equal(
        client.consumePendingAndroidUpgradeNote(),
        `runner-apps-replaced reason=${kind}`,
      );
    });
  }
}

test('AI-513: a block on the second APK replaces both runner apps', async (t) => {
  const { device, commands } = harness(t, { foreign: [TEST] });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), LAUNCHED);
  assert.deepEqual(deviceChanges(commands), [
    'install -r app.apk',
    'install -r test.apk',
    `shell am force-stop ${TEST}`,
    `shell am force-stop ${MAIN}`,
    `uninstall ${MAIN}`,
    `uninstall ${TEST}`,
    'install -r app.apk',
    'install -r test.apk',
  ]);
  assert.equal(device.get(TEST), 'this-host');
  assert.equal(client.consumePendingAndroidUpgradeNote(), 'runner-apps-replaced reason=signature');
});

test('AI-513: a block that survives the one replacement refuses RUNNER_INSTALL_BLOCKED with no third install', async (t) => {
  const { effects } = harness(t, { foreign: [MAIN, TEST], stickyBlock: true, channel: 'stdout' });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), (err: Error) => {
    assert.match(err.message, /^RUNNER_INSTALL_BLOCKED: /);
    assert.match(err.message, /signature/);
    assert.match(err.message, /INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
    assert.ok(err.cause, 'the refusal keeps its cause');
    return true;
  });
  assert.equal(effects.installs, 2);
  assert.equal(effects.uninstalls.length, 2);
  assert.equal(client.consumePendingAndroidUpgradeNote(), undefined);
});

test('AI-513: a runner process that survives the stop refuses before any uninstall', async (t) => {
  const { effects } = harness(t, { foreign: [MAIN, TEST], survivingRunner: true });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), (err: Error) => {
    assert.match(err.message, /^RUNNER_INSTALL_BLOCKED: /);
    assert.match(err.message, /RUNNER_CLEANUP_UNCONFIRMED/);
    return true;
  });
  assert.deepEqual(effects.uninstalls, []);
  assert.equal(effects.installs, 1);
});

for (const kind of ['signature', 'downgrade'] as const) {
  for (const pkg of [MAIN, TEST]) {
    test(`AI-513: a ${kind} replacement preserves adb failure stopping ${pkg}`, async (t) => {
      const adbError = new Error(`error: device '${SERIAL}' not found`);
      const { effects } = harness(t, {
        foreign: [MAIN, TEST],
        kind,
        before: {
          [`shell am force-stop ${pkg}`]: () => {
            throw adbError;
          },
        },
      });
      await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), (err: Error) => {
        assert.match(err.message, /^RUNNER_INSTALL_BLOCKED: /);
        assert.match(
          err.message,
          kind === 'signature'
            ? /INSTALL_FAILED_UPDATE_INCOMPATIBLE/
            : /INSTALL_FAILED_VERSION_DOWNGRADE/,
        );
        assert.ok(err.message.includes(adbError.message));
        assert.match((err.cause as Error).message, /^RUNNER_CLEANUP_UNCONFIRMED: /);
        return true;
      });
      assert.deepEqual(effects.uninstalls, []);
      assert.equal(effects.installs, 1);
    });
  }

  test(`AI-513: a completed ${kind} replacement logs once before instrumentation fails`, async (t) => {
    const { device } = harness(t, { foreign: [MAIN, TEST], kind });
    const stderr: string[] = [];
    t.mock.method(process.stderr, 'write', (chunk: string) => {
      stderr.push(String(chunk));
      return true;
    });
    await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), LAUNCHED);
    assert.equal(device.get(MAIN), 'this-host');
    assert.equal(device.get(TEST), 'this-host');
    assert.deepEqual(
      stderr
        .join('')
        .split('\n')
        .filter((line) => line.includes('runner-apps-replaced')),
      [`qaren-core: runner-apps-replaced reason=${kind}`],
    );
  });
}

test('AI-513: a runner package that was not installed counts as absent', async (t) => {
  const { device, effects } = harness(t, { foreign: [MAIN] });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), LAUNCHED);
  assert.deepEqual(effects.uninstalls, [MAIN, TEST]);
  assert.equal(device.get(MAIN), 'this-host');
  assert.equal(device.get(TEST), 'this-host');
});

test('AI-513: a failed uninstall that leaves the package listed refuses', async (t) => {
  const { effects } = harness(t, { foreign: [MAIN, TEST], uninstallFails: [TEST] });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), (err: Error) => {
    assert.match(err.message, /^RUNNER_INSTALL_BLOCKED: /);
    assert.ok(err.message.includes(`${TEST} is still installed`), err.message);
    assert.match(err.message, /DELETE_FAILED_INTERNAL_ERROR/);
    return true;
  });
  assert.equal(effects.installs, 1);
});

test('AI-513: an uninstall that reports success but leaves the package listed refuses', async (t) => {
  const { effects } = harness(t, { foreign: [MAIN, TEST], keepListed: [MAIN] });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), {
    message: /^RUNNER_INSTALL_BLOCKED: .*androidrunner is still installed/,
  });
  assert.equal(effects.installs, 1);
});

test('AI-513: an unreadable package list refuses rather than assuming absence', async (t) => {
  const { effects } = harness(t, { foreign: [MAIN, TEST], listFails: true });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), {
    message: /^RUNNER_INSTALL_BLOCKED: .*package list/,
  });
  assert.equal(effects.installs, 1);
});

test('AI-513: a package list that is not made of package lines proves nothing', async (t) => {
  const { effects } = harness(t, { foreign: [MAIN, TEST], listMalformed: true });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), {
    message: /^RUNNER_INSTALL_BLOCKED: .*package list could not be read: unexpected output/,
  });
  assert.equal(effects.installs, 1);
});

test('AI-513: with no deviceId the replacement runs against the resolved serial', async (t) => {
  const { commands } = harness(t, { foreign: [MAIN, TEST] });
  await assert.rejects(client.startAndroidRunner(undefined, 'com.example', 0), LAUNCHED);
  // The harness asserts `-s <serial>` on every device command; prove the sequence ran.
  assert.ok(commands.some((args) => args.join(' ') === `-s ${SERIAL} uninstall ${MAIN}`));
});

test('AI-513: an unrelated install failure uninstalls nothing and names adb reason without the offline hint', async (t) => {
  const { effects } = harness(t, {
    unrelated: 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]',
    channel: 'stdout',
  });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), (err: Error) => {
    assert.match(err.message, /^qaren-android-runner APK install failed \(adb install -r\)\./);
    assert.match(err.message, /INSTALL_FAILED_INSUFFICIENT_STORAGE/);
    assert.doesNotMatch(err.message, /Is the emulator\/device online\?/);
    assert.doesNotMatch(err.message, /RUNNER_INSTALL_BLOCKED/);
    return true;
  });
  assert.deepEqual(effects.uninstalls, []);
});

test('AI-513: an install failure that names no adb reason keeps the offline hint', async (t) => {
  harness(t, { unrelated: 'error: closed' });
  await assert.rejects(
    client.startAndroidRunner(SERIAL, 'com.example', 0),
    /Is the emulator\/device online\? .*error: closed/s,
  );
});

test('AI-513: the open note remains available as result metadata', () => {
  const note = 'downloaded prebuilt runner; runner-apps-replaced reason=signature';
  assert.equal(unwrap(attachMetaNote(okResult({}), note)).meta?.note, note);
});

test('AI-513: session-open reports RUNNER_INSTALL_BLOCKED, not runner-down', async () => {
  const handler = createDeviceSnapshotHandler({
    startAndroidRunner: async () => {
      throw new Error('RUNNER_INSTALL_BLOCKED: fixture block');
    },
    launchAndroidApp: async () => {
      throw new Error('must not launch after a blocked install');
    },
    reapAndroidRunner: async () => {},
  });
  try {
    const result = await handler({
      action: 'open',
      platform: 'android',
      deviceId: SERIAL,
      appId: 'com.example',
    });
    const body = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      code?: string;
      error?: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'RUNNER_INSTALL_BLOCKED');
    assert.match(body.error!, /^RUNNER_INSTALL_BLOCKED: fixture block/);
  } finally {
    clearActiveSession();
  }
});

test('AI-513: the native wrapper reports RUNNER_INSTALL_BLOCKED, not runner-down', async (t) => {
  harness(t, { foreign: [MAIN, TEST], stickyBlock: true });
  const result = await runNative(['snapshot'], { platform: 'android' });
  const body = JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    code?: string;
    error?: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.code, 'RUNNER_INSTALL_BLOCKED');
  assert.match(body.error!, /^RUNNER_INSTALL_BLOCKED: /);
});

test('AI-513: runAndroid reports RUNNER_INSTALL_BLOCKED, not runner-down', async (t) => {
  harness(t, { foreign: [MAIN, TEST], stickyBlock: true });
  const result = await client.runAndroid({
    command: 'snapshot',
    deviceId: SERIAL,
    bundleId: 'com.example',
  });
  const body = JSON.parse(result.content[0]!.text) as { ok: boolean; code?: string };
  assert.equal(body.code, 'RUNNER_INSTALL_BLOCKED');
});

test('AI-513: cancellation during the replacement propagates as cancellation', async (t) => {
  const controller = new AbortController();
  const { effects } = harness(t, {
    foreign: [MAIN, TEST],
    before: { [`uninstall ${MAIN}`]: () => controller.abort(new RunCancelledError()) },
  });
  await assert.rejects(
    withCancellation(controller.signal, () => client.startAndroidRunner(SERIAL, 'com.example', 0)),
    (err: Error) => {
      assert.ok(isAbort(err), `expected cancellation, got ${err.message}`);
      assert.doesNotMatch(err.message, /RUNNER_INSTALL_BLOCKED/);
      return true;
    },
  );
  assert.equal(effects.installs, 1, 'no reinstall after cancellation');
});

test('AI-513: a timed-out uninstall refuses and keeps the killed child as its cause', async (t) => {
  const { effects } = harness(t, { foreign: [MAIN, TEST], killOn: `uninstall ${MAIN}` });
  await assert.rejects(client.startAndroidRunner(SERIAL, 'com.example', 0), (err: Error) => {
    assert.match(err.message, /^RUNNER_INSTALL_BLOCKED: /);
    assert.equal((err.cause as { killed?: boolean }).killed, true);
    return true;
  });
  assert.equal(effects.installs, 1);
});
