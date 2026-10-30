// GH #418: the Android health probe parses /health.commands, the classify
// helper enforces REQUIRED_ANDROID_COMMANDS, and remediation is a REAL
// invalidation tier — deleting the APKs forces resolveAndroidInstallAction
// into 'build-then-install' (review amendment: 'install' alone re-installs
// the same stale APK and never runs Gradle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireAndroidRunnerRebuildLock,
  AndroidAuthorityStaleError,
  beginAndroidRunnerRebuildCleanup,
  completeAndroidRunnerRebuildLock,
  heartbeatAndroidRunnerRebuildLock,
  probeAndroidRunnerHealthInfo,
  resolveAndroidInstallAction,
  invalidateAndroidRunnerApks,
  _androidRunnerApkPathsForTest,
  AndroidCommandsStaleError,
  androidRetryCleanupContext,
  runBoundedAndroidRunnerRebuild,
  markAndroidRunnerRebuildCleanupUnverified,
  releaseAndroidRunnerRebuildLock,
  _setFetchForTest,
} from '../../dist/runners/qaren-android-runner-client.js';
import {
  classifyRunnerCompatibility,
  REQUIRED_ANDROID_COMMANDS,
} from '../../dist/runners/protocol.js';

const runnerSource = readFileSync(
  new URL('../../src/runners/qaren-android-runner-client.ts', import.meta.url),
  'utf8',
);
const noAndroidRebuildCleanup = async () => {};

test('gh-418 android: probe parses commands array (non-strings filtered)', async () => {
  _setFetchForTest(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      protocolVersion: 1,
      commands: ['tap', 'type', 7, 'snapshot'],
    }),
  }));
  try {
    const info = await probeAndroidRunnerHealthInfo(4723);
    assert.deepEqual(info.commands, ['tap', 'type', 'snapshot']);
  } finally {
    _setFetchForTest(globalThis.fetch);
  }
});

test('gh-418 android: absent commands + required list → missing-commands', () => {
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1 }, null, REQUIRED_ANDROID_COMMANDS),
    {
      compatible: false,
      reason: 'missing-commands',
      missing: [...REQUIRED_ANDROID_COMMANDS],
    },
  );
});

test('gh-418 android: AndroidCommandsStaleError message carries the typed prefix + hint', () => {
  const err = new AndroidCommandsStaleError(['dismissKeyboard'], 'com.example');
  assert.ok(err.message.startsWith('RUNNER_COMMANDS_STALE'));
  assert.match(err.message, /dismissKeyboard/);
  assert.match(err.message, /device_snapshot action=open/);
  assert.deepEqual(err.missing, ['dismissKeyboard']);
});

test('Android authority upgrades use the bounded artifact rebuild owner', () => {
  const err = new AndroidAuthorityStaleError();
  assert.ok(err.message.startsWith('RUNNER_OWNERSHIP_MISMATCH'));
  assert.match(
    runnerSource,
    /err instanceof AndroidAuthorityStaleError[\s\S]*?runBoundedAndroidRunnerRebuild\(\s*err,\s*async \(signal\)[\s\S]*?signal\.throwIfAborted\(\)[\s\S]*?invalidateAndroidRunnerApks\(undefined, signal\)[\s\S]*?_forceReinstall: true[\s\S]*?_rebuildSignal: signal/,
  );
  assert.match(
    runnerSource,
    /execFileAsync\(GRADLEW[\s\S]*?signal: opts\.signal[\s\S]*?buildAdbInstallArgs[\s\S]*?signal: opts\.signal/,
  );
});

test('Android rebuild cleanup calls are bound to lease authority', () => {
  const retrySource = runnerSource.slice(
    runnerSource.indexOf('export async function startAndroidRunner('),
    runnerSource.indexOf('async function startAndroidRunnerAttempt('),
  );
  const reapCalls = [...retrySource.matchAll(/await reapMismatchedAndroidRunner\(([\s\S]*?)\);/g)];
  assert.equal(reapCalls.length, 4);
  for (const call of reapCalls) assert.match(call[1], /\bsignal\b/);
});

test('Android artifact rebuild is serialized and budgeted once', async () => {
  const events = [];
  const result = await runBoundedAndroidRunnerRebuild(
    new AndroidAuthorityStaleError('serial-a'),
    async () => {
      events.push('rebuild');
      return 'ready';
    },
    noAndroidRebuildCleanup,
    {
      acquire: (pluginVersion) => {
        events.push('acquire');
        return {
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        };
      },
      heartbeat: () => true,
      complete: (lock) => {
        events.push(`complete:${lock.ownerNonce}`);
        return true;
      },
      release: () => assert.fail('successful rebuild must not be released as failed'),
    },
  );

  assert.equal(result, 'ready');
  assert.deepEqual(events, ['acquire', 'rebuild', 'complete:lock-a']);
});

test('Android artifact rebuild preserves ownership mismatch after a failed rebuild', async () => {
  const mismatch = new AndroidAuthorityStaleError('serial-a');
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      mismatch,
      async () => {
        throw mismatch;
      },
      noAndroidRebuildCleanup,
      {
        acquire: (pluginVersion) => ({
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        }),
        heartbeat: () => true,
        beginCleanup: () => true,
        complete: () => {
          assert.fail('failed rebuild must not be completed');
        },
        release: () => true,
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.startsWith('RUNNER_OWNERSHIP_MISMATCH'),
  );
});

test('Android artifact rebuild consumes a bounded attempt after failure', async () => {
  const events = [];
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      new AndroidAuthorityStaleError('serial-a'),
      async () => {
        events.push('rebuild');
        throw new Error('transient build failure');
      },
      async () => {
        events.push('cleanup');
      },
      {
        acquire: (pluginVersion) => ({
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        }),
        heartbeat: () => true,
        beginCleanup: () => {
          events.push('fence');
          return true;
        },
        complete: () => {
          assert.fail('failed rebuild must not be completed');
        },
        release: () => {
          events.push('failed');
          return true;
        },
      },
    ),
    /transient build failure/,
  );
  assert.deepEqual(events, ['rebuild', 'fence', 'cleanup', 'failed']);
});

test('Android artifact rebuild lease heartbeats and finalizes under its nonce', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rn-android-rebuild-lock-'));
  const database = join(directory, 'lock.sqlite');
  try {
    const first = acquireAndroidRunnerRebuildLock('1.0.0', 1_000, 'owner-a', database);
    assert.deepEqual(first, {
      status: 'acquired',
      lock: { ownerNonce: 'owner-a', pluginVersion: '1.0.0' },
    });
    assert.deepEqual(acquireAndroidRunnerRebuildLock('1.0.0', 1_001, 'owner-b', database), {
      status: 'busy',
    });
    assert.equal(heartbeatAndroidRunnerRebuildLock(first.lock, 2_000, database), true);
    assert.deepEqual(
      acquireAndroidRunnerRebuildLock('1.0.0', 1_000 + 15 * 60_000 + 1, 'owner-b', database),
      { status: 'busy' },
    );

    const replacement = acquireAndroidRunnerRebuildLock(
      '1.0.0',
      2_000 + 15 * 60_000 + 1,
      'owner-b',
      database,
    );
    assert.deepEqual(replacement, {
      status: 'acquired',
      lock: { ownerNonce: 'owner-b', pluginVersion: '1.0.0' },
    });
    assert.equal(releaseAndroidRunnerRebuildLock(first.lock, 2_001, database), false);
    assert.equal(completeAndroidRunnerRebuildLock(replacement.lock, 2_002, database), true);
    assert.deepEqual(acquireAndroidRunnerRebuildLock('1.0.0', 2_003, 'owner-c', database), {
      status: 'exhausted',
    });

    const nextVersion = acquireAndroidRunnerRebuildLock('2.0.0', 2_004, 'owner-c', database);
    assert.equal(nextVersion.status, 'acquired');
    assert.equal(releaseAndroidRunnerRebuildLock(nextVersion.lock, 2_005, database), true);
    assert.deepEqual(acquireAndroidRunnerRebuildLock('2.0.0', 2_006, 'owner-d', database), {
      status: 'exhausted',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Android cleanup fence blocks stale takeover until terminal persistence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rn-android-rebuild-cleanup-'));
  const database = join(directory, 'lock.sqlite');
  try {
    const first = acquireAndroidRunnerRebuildLock('1.0.0', 1_000, 'owner-a', database);
    assert.equal(first.status, 'acquired');
    assert.equal(beginAndroidRunnerRebuildCleanup(first.lock, 2_000, database), true);
    assert.deepEqual(
      acquireAndroidRunnerRebuildLock('1.0.0', 2_000 + 15 * 60_000 + 1, 'owner-b', database),
      { status: 'busy' },
    );
    assert.deepEqual(
      acquireAndroidRunnerRebuildLock('2.0.0', 2_000 + 15 * 60_000 + 1, 'owner-b', database),
      { status: 'busy' },
    );
    assert.equal(markAndroidRunnerRebuildCleanupUnverified(first.lock, 2_001, database), true);
    assert.deepEqual(acquireAndroidRunnerRebuildLock('2.0.0', 2_002, 'owner-b', database), {
      status: 'busy',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Android artifact rebuild heartbeats while the protected operation runs', async () => {
  let heartbeats = 0;
  let secondHeartbeat;
  const beatenTwice = new Promise((resolve) => {
    secondHeartbeat = resolve;
  });
  const result = await runBoundedAndroidRunnerRebuild(
    new AndroidAuthorityStaleError('serial-a'),
    () => beatenTwice.then(() => 'ready'),
    noAndroidRebuildCleanup,
    {
      acquire: (pluginVersion) => ({
        status: 'acquired',
        lock: { ownerNonce: 'lock-a', pluginVersion },
      }),
      heartbeat: () => {
        heartbeats += 1;
        if (heartbeats >= 2) secondHeartbeat();
        return true;
      },
      complete: () => true,
      release: () => true,
      heartbeatIntervalMs: 5,
    },
  );

  assert.equal(result, 'ready');
  assert.ok(heartbeats >= 2);
});

test('Android stale rebuild owner skips cleanup and release after authority loss', async () => {
  let fenced = false;
  let cleaned = false;
  let released = false;
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      new AndroidAuthorityStaleError('serial-a'),
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              fenced = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      async () => {
        cleaned = true;
      },
      {
        acquire: (pluginVersion) => ({
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        }),
        heartbeat: () => false,
        complete: () => assert.fail('authority-lost rebuild must not complete'),
        beginCleanup: () => assert.fail('stale owner must not start cleanup'),
        release: () => {
          released = true;
          return true;
        },
        heartbeatIntervalMs: 5,
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.includes('rebuild authority was lost'),
  );
  assert.equal(fenced, true);
  assert.equal(cleaned, false);
  assert.equal(released, false);
});

test('Android artifact completion is durable before exposing a ready runner', async () => {
  let released = false;
  let completionAttempts = 0;
  const result = await runBoundedAndroidRunnerRebuild(
    new AndroidAuthorityStaleError('serial-a'),
    async () => 'ready',
    noAndroidRebuildCleanup,
    {
      acquire: (pluginVersion) => ({
        status: 'acquired',
        lock: { ownerNonce: 'lock-a', pluginVersion },
      }),
      heartbeat: () => true,
      complete: () => {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error('database unavailable');
        return completionAttempts >= 3;
      },
      release: () => {
        released = true;
        return true;
      },
      heartbeatIntervalMs: 5,
      completionRetryIntervalMs: 5,
      completionAttempts: 3,
    },
  );

  assert.equal(result, 'ready');
  assert.equal(completionAttempts, 3);
  assert.equal(released, false);
});

test('Android artifact completion failure cleans up before releasing the lease', async () => {
  const events = [];
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      new AndroidAuthorityStaleError('serial-a'),
      async () => 'ready',
      async () => {
        events.push('cleanup');
      },
      {
        acquire: (pluginVersion) => ({
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        }),
        heartbeat: () => true,
        beginCleanup: () => {
          events.push('fence');
          return true;
        },
        complete: () => {
          events.push('complete');
          return false;
        },
        release: () => {
          events.push('release');
          return true;
        },
        completionRetryIntervalMs: 1,
        completionAttempts: 2,
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.includes('completion was not durable'),
  );
  assert.deepEqual(events, ['complete', 'complete', 'fence', 'cleanup', 'release']);
});

test('Android cleanup timeout persists cleanup-unverified before returning', async () => {
  const events = [];
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      new AndroidAuthorityStaleError('serial-a'),
      async () => {
        throw new Error('build failed');
      },
      (signal) =>
        new Promise((_resolve, reject) => {
          events.push('cleanup');
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      {
        acquire: (pluginVersion) => ({
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        }),
        heartbeat: () => true,
        beginCleanup: () => {
          events.push('fence');
          return true;
        },
        complete: () => assert.fail('failed rebuild must not complete'),
        release: () => assert.fail('unverified cleanup must not be marked verified'),
        markCleanupUnverified: () => {
          events.push('cleanup-unverified');
          return true;
        },
        cleanupTimeoutMs: 5,
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.includes('cleanup could not be verified'),
  );
  assert.deepEqual(events, ['fence', 'cleanup', 'cleanup-unverified']);
});

test('Android rebuild refuses to release an attempt without verified cleanup', async () => {
  let released = false;
  let cleanupUnverified = false;
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      new AndroidAuthorityStaleError('serial-a'),
      async () => {
        throw new Error('build failed');
      },
      async () => {
        throw new Error('cleanup failed');
      },
      {
        acquire: (pluginVersion) => ({
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        }),
        heartbeat: () => true,
        beginCleanup: () => true,
        complete: () => assert.fail('failed rebuild must not complete'),
        release: () => {
          released = true;
          return true;
        },
        markCleanupUnverified: () => {
          cleanupUnverified = true;
          return true;
        },
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.includes('cleanup could not be verified'),
  );
  assert.equal(released, false);
  assert.equal(cleanupUnverified, true);
});

test('Android rebuild refuses an undurable terminal failure state', async () => {
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      new AndroidAuthorityStaleError('serial-a'),
      async () => {
        throw new Error('build failed');
      },
      noAndroidRebuildCleanup,
      {
        acquire: (pluginVersion) => ({
          status: 'acquired',
          lock: { ownerNonce: 'lock-a', pluginVersion },
        }),
        heartbeat: () => true,
        beginCleanup: () => true,
        complete: () => assert.fail('failed rebuild must not complete'),
        release: () => false,
        completionRetryIntervalMs: 1,
        completionAttempts: 2,
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.includes('failure state was not durable'),
  );
});

test('Android rebuild state initialization closes its store on schema failure', () => {
  assert.match(
    runnerSource,
    /function initializeAndroidRunnerRebuildState[\s\S]*?const store = openAuthorityStore[\s\S]*?try \{[\s\S]*?store\.database\.exec[\s\S]*?catch \(cause\) \{[\s\S]*?store\.close\(\)/,
  );
});

test('Android artifact rebuild budget refuses repeated ownership upgrades', async () => {
  const mismatch = new AndroidAuthorityStaleError('serial-a');
  let rebuildAttempted = false;
  await assert.rejects(
    runBoundedAndroidRunnerRebuild(
      mismatch,
      async () => {
        rebuildAttempted = true;
      },
      noAndroidRebuildCleanup,
      {
        acquire: () => ({ status: 'exhausted' }),
      },
    ),
    (error) =>
      error instanceof AndroidAuthorityStaleError &&
      error.message.startsWith('RUNNER_OWNERSHIP_MISMATCH'),
  );
  assert.equal(rebuildAttempted, false);
});

test('Android retry cleanup preserves the attempted device before runner readiness', () => {
  const authorityError = new AndroidAuthorityStaleError('serial-a');
  const commandsError = new AndroidCommandsStaleError(
    ['dismissKeyboard'],
    'com.example',
    'serial-b',
  );

  assert.deepEqual(androidRetryCleanupContext(null, authorityError), { deviceId: 'serial-a' });
  assert.deepEqual(androidRetryCleanupContext(null, commandsError), { deviceId: 'serial-b' });
  assert.deepEqual(androidRetryCleanupContext({ deviceId: 'persisted' }, authorityError), {
    deviceId: 'persisted',
  });
});

test('gh-418 android: invalidation deletes exactly the paths the apksExist check reads', async () => {
  const removed = [];
  await invalidateAndroidRunnerApks((p) => removed.push(p));
  // Same source of truth (RUNNER_APK_PATHS) as androidRunnerApksExist — a
  // drift between what is deleted and what is existence-checked fails here.
  assert.deepEqual(removed, [..._androidRunnerApkPathsForTest()]);
  assert.ok(removed.some((p) => p.endsWith('app-debug.apk')));
  assert.ok(removed.some((p) => p.endsWith('app-debug-androidTest.apk')));
  // With the APKs gone the pure decision is Gradle:
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: false, apksExist: false }),
    'build-then-install',
  );
  // …whereas a stale-but-present APK alone would only be re-installed, never
  // rebuilt — the blind spot this tier closes:
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: false, apksExist: true }),
    'install',
  );
});
