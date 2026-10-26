// GH #428: hardening the Android **raw** screenshot capture path
// (`device-screenshot-raw.ts`). #427 hardened the iOS raw path; the Android raw
// path remained fallback-only and unchanged, carrying three pre-existing bugs:
//
//   1. Truncate-before-success — `createWriteStream(path)` opened the caller's
//      FINAL path (truncating it) before capture was known good, and a failed
//      `adb exec-out screencap` then `unlinkSync(path)`'d a file the tool never
//      created. Fix: write to a unique sibling temp file, `renameSync` onto the
//      final path only after BOTH the stream and adb succeed.
//   2. Multi-emulator first-pick — the resolver returned the FIRST emulator
//      line, so with several emulators booted and no session binding a raw
//      screenshot could hit the wrong device. iOS got exactly-one-or-refuse in
//      #427; Android now mirrors it (`resolveAndroidEmu`).
//   3. adb child leak on stream error — on `out.on('error')` (ENOSPC/EACCES)
//      the stream settled false but the `adb` child kept running, blocked on
//      stdout. Fix: unpipe + kill the child before settling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RAW_MOD = '../../dist/handlers/device-screenshot-raw.js';

// A minimal stand-in for the `adb exec-out screencap` child process. It exposes
// exactly what the capturer touches — `stdout` (a Readable to pipe), `on` for
// 'error'/'close', and `kill()` — plus test hooks to drive lifecycle events and
// counters to assert the leak fix (finding 3).
function makeFakeAdb() {
  const ee = new EventEmitter();
  const stdout = new PassThrough();
  let unpipeCount = 0;
  const realUnpipe = stdout.unpipe.bind(stdout);
  stdout.unpipe = (dest?: NodeJS.WritableStream) => {
    unpipeCount += 1;
    return realUnpipe(dest);
  };
  const proc = {
    stdout,
    killed: false,
    killCount: 0,
    get unpipeCount() {
      return unpipeCount;
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      ee.on(event, cb);
      return proc;
    },
    kill() {
      proc.killed = true;
      proc.killCount += 1;
      return true;
    },
    emitClose(code: number) {
      ee.emit('close', code);
    },
    emitError(err: Error) {
      ee.emit('error', err);
    },
  };
  return proc;
}

// ── Finding 2: exactly-one-or-refuse resolver ───────────────────────────────

test('parseAdbDevicesEmuAll: returns ALL online emulators, skips offline/unauthorized/physical (GH #428)', async () => {
  const { parseAdbDevicesEmuAll } = await import(RAW_MOD);
  const stdout =
    'List of devices attached\n' +
    'emulator-5554\tdevice\n' +
    'physical-abc-123\tdevice\n' +
    'emulator-5556\tdevice\n' +
    'emulator-5558\tunauthorized\n' +
    'emulator-5560\toffline\n';
  assert.deepEqual(parseAdbDevicesEmuAll(stdout), ['emulator-5554', 'emulator-5556']);
});

test('parseAdbDevicesEmuAll: returns [] when no online emulator', async () => {
  const { parseAdbDevicesEmuAll } = await import(RAW_MOD);
  assert.deepEqual(parseAdbDevicesEmuAll(''), []);
  assert.deepEqual(parseAdbDevicesEmuAll('List of devices attached\n'), []);
  assert.deepEqual(parseAdbDevicesEmuAll('List of devices attached\nemulator-5554\toffline\n'), []);
});

test('resolveAndroidEmu: exactly one booted emulator → returns it (GH #428 finding 2)', async () => {
  const { resolveAndroidEmu } = await import(RAW_MOD);
  const one = 'List of devices attached\nemulator-5554\tdevice\n';
  assert.equal(await resolveAndroidEmu(async () => one), 'emulator-5554');
});

test('resolveAndroidEmu: TWO booted emulators → null (refuse first-pick, mirrors iOS GH #427)', async () => {
  const { resolveAndroidEmu } = await import(RAW_MOD);
  const two = 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n';
  assert.equal(await resolveAndroidEmu(async () => two), null);
});

test('resolveAndroidEmu: no emulator → null', async () => {
  const { resolveAndroidEmu } = await import(RAW_MOD);
  assert.equal(await resolveAndroidEmu(async () => 'List of devices attached\n'), null);
});

test('resolveAndroidEmu: probe throws → null (never throws)', async () => {
  const { resolveAndroidEmu } = await import(RAW_MOD);
  assert.equal(
    await resolveAndroidEmu(async () => {
      throw new Error('adb not found');
    }),
    null,
  );
});

// ── Finding 1: temp-file + rename (never truncate the caller's path early) ───

test('rawTempPath: sits in the same directory as the final path (atomic rename) (GH #428 finding 1)', async () => {
  const { rawTempPath } = await import(RAW_MOD);
  assert.equal(rawTempPath('/a/b/shot.png', '999.1'), '/a/b/.shot.png.999.1.rawtmp');
});

test('defaultAndroidCapturer: success renames temp onto path, leaves no temp behind (GH #428 finding 1)', async () => {
  const raw = await import(RAW_MOD);
  const dir = mkdtempSync(join(tmpdir(), 'gh428-ok-'));
  const path = join(dir, 'shot.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const proc = makeFakeAdb();
  raw._setForTest({ androidSpawn: () => proc });
  try {
    const p = raw.defaultAndroidCapturer('emulator-5554', path);
    proc.stdout.end(bytes);
    proc.emitClose(0);
    assert.equal(await p, true);
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(readdirSync(dir), ['shot.png']);
  } finally {
    raw._resetForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultAndroidCapturer: failed adb preserves a pre-existing file at path (GH #428 finding 1)', async () => {
  const raw = await import(RAW_MOD);
  const dir = mkdtempSync(join(tmpdir(), 'gh428-fail-'));
  const path = join(dir, 'existing.png');
  const sentinel = Buffer.from('DO-NOT-DESTROY-THIS-USER-FILE');
  writeFileSync(path, sentinel);
  const proc = makeFakeAdb();
  raw._setForTest({ androidSpawn: () => proc });
  try {
    const p = raw.defaultAndroidCapturer('emulator-5554', path);
    proc.stdout.end(Buffer.from([0x00]));
    proc.emitClose(1); // adb exited non-zero
    assert.equal(await p, false);
    // The file the tool did NOT create must survive a failed capture.
    assert.deepEqual(readFileSync(path), sentinel);
    assert.deepEqual(readdirSync(dir), ['existing.png']); // temp cleaned up
  } finally {
    raw._resetForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Finding 3: kill the adb child when the write stream errors ───────────────

test('defaultAndroidCapturer: write-stream error kills + unpipes the adb child (GH #428 finding 3)', async () => {
  const raw = await import(RAW_MOD);
  // Parent directory does not exist → createWriteStream emits ENOENT 'error'.
  const path = join(tmpdir(), `gh428-nodir-${process.pid}`, 'missing', 'shot.png');
  const proc = makeFakeAdb();
  raw._setForTest({ androidSpawn: () => proc });
  try {
    const ok = await raw.defaultAndroidCapturer('emulator-5554', path);
    assert.equal(ok, false);
    assert.equal(proc.killed, true, 'adb child must be killed on write-stream error (no leak)');
    assert.ok(proc.unpipeCount >= 1, 'stdout must be unpiped from the errored write stream');
  } finally {
    raw._resetForTest();
  }
});
