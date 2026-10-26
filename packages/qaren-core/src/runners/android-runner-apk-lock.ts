import { randomUUID } from 'node:crypto';
import { cancellationSignal, sleep, throwIfCancelled } from '../domain/cancellation.js';
import {
  androidRunnerApkOwnerPresence,
  type AndroidRunnerApkOwner,
} from '../domain/android-runner-apk-ownership.js';
import { probeProcessBirth } from '../lifecycle/process-birth.js';
import { openAuthorityStore } from '../util/sqlite-store.js';
import {
  androidProvisioningGroupPresence,
  androidProvisioningProcessGroup,
  stopAndroidProvisioningChildren,
} from './android-provisioning-processes.js';

function recoveryMessage(lockPath: string, owner?: AndroidRunnerApkOwner): string {
  const identity = owner
    ? `pid=${owner.birth.pid}, start=${owner.birth.token}, group=${owner.pgid}`
    : 'unknown';
  return `Android runner APK fence ${lockPath}; owner ${identity}. Verify the recorded owner identity and process group with ps; stop only that owner's Gradle/adb children, then retry. If identity or group absence cannot be proven, keep the fence. For an unreadable or legacy fence, prove all provisioning callers and Gradle/adb writers for this runner directory stopped before removing the fence and its SQLite sidecars.`;
}

export class AndroidRunnerApkLockTimeoutError extends Error {
  readonly code = 'ANDROID_RUNNER_APK_LOCK_TIMEOUT';
  constructor(lockPath: string, owner?: AndroidRunnerApkOwner) {
    super(
      `ANDROID_RUNNER_APK_LOCK_TIMEOUT: timed out waiting for live Android runner APK owner. ${recoveryMessage(lockPath, owner)}`,
    );
  }
}

export class AndroidRunnerApkLockUnprovenError extends Error {
  readonly code = 'ANDROID_RUNNER_APK_LOCK_UNPROVEN';
  constructor(lockPath: string, owner?: AndroidRunnerApkOwner) {
    super(
      `ANDROID_RUNNER_APK_LOCK_UNPROVEN: APK writer shutdown or owner liveness cannot be proven. ${recoveryMessage(lockPath, owner)}`,
    );
  }
}

function forcedSubprocessStop(error: unknown): boolean {
  for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth += 1) {
    const failure = error as { killed?: unknown; signal?: unknown; cause?: unknown };
    if (failure.killed === true || typeof failure.signal === 'string') return true;
    error = failure.cause;
  }
  return false;
}

function parseOwner(value: unknown): AndroidRunnerApkOwner | undefined {
  try {
    const owner = JSON.parse(String(value)) as AndroidRunnerApkOwner;
    if (
      typeof owner.nonce !== 'string' ||
      !owner.nonce ||
      typeof owner.retained !== 'boolean' ||
      !Number.isSafeInteger(owner.pgid) ||
      owner.pgid <= 0 ||
      !Number.isSafeInteger(owner.birth?.pid) ||
      owner.birth.pid <= 0 ||
      !['linux-proc', 'darwin-libproc', 'windows-powershell'].includes(owner.birth.source) ||
      !/^[a-f0-9]{64}$/.test(owner.birth.token)
    )
      return undefined;
    return owner;
  } catch {
    return undefined;
  }
}

// Stale retries acquire the rebuild-budget lock before the APK outputs lock.
// SQLite atomically publishes complete owner identity and compares its nonce
// during reclaim/release; two contenders can never remove a successor's fence.
export async function withAndroidRunnerApkLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number; onWait?: (message: string) => void } = {},
): Promise<T> {
  const signal = cancellationSignal(options.signal);
  const deadline = performance.now() + (options.timeoutMs ?? 15 * 60_000);
  const birth = probeProcessBirth(process.pid);
  const pgid = androidProvisioningProcessGroup(process.pid);
  if (birth.status !== 'present' || !pgid) throw new AndroidRunnerApkLockUnprovenError(lockPath);
  const mine: AndroidRunnerApkOwner = {
    nonce: randomUUID(),
    birth: birth.birth,
    pgid,
    retained: false,
  };
  let store: ReturnType<typeof openAuthorityStore> | undefined;
  try {
    store = openAuthorityStore(lockPath);
    store.database.exec(
      'CREATE TABLE IF NOT EXISTS android_apk_owner (slot INTEGER PRIMARY KEY CHECK(slot = 1), owner TEXT NOT NULL)',
    );
  } catch {
    try {
      store?.close();
    } catch {}
    throw new AndroidRunnerApkLockUnprovenError(lockPath);
  }
  const database = store.database;
  const encoded = JSON.stringify(mine);
  let acquired = false;
  let announced: string | undefined;
  try {
    for (;;) {
      throwIfCancelled(signal);
      const inserted = database
        .prepare(
          'INSERT INTO android_apk_owner(slot, owner) VALUES (1, ?) ON CONFLICT(slot) DO NOTHING RETURNING owner',
        )
        .get(encoded);
      if (inserted) {
        acquired = true;
        break;
      }
      const record = database.prepare('SELECT owner FROM android_apk_owner WHERE slot = 1').get();
      if (!record) continue;
      const owner = parseOwner(record.owner);
      if (!owner) throw new AndroidRunnerApkLockUnprovenError(lockPath);
      const presence = androidRunnerApkOwnerPresence(
        owner,
        probeProcessBirth(owner.birth.pid),
        androidProvisioningGroupPresence(owner.pgid),
      );
      if (presence === 'absent') {
        const replaced = database
          .prepare(
            'UPDATE android_apk_owner SET owner = ? WHERE slot = 1 AND owner = ? RETURNING owner',
          )
          .get(encoded, record.owner);
        if (replaced) {
          acquired = true;
          break;
        }
        continue;
      }
      if (presence === 'unknown') throw new AndroidRunnerApkLockUnprovenError(lockPath, owner);
      if (announced !== owner.nonce) {
        (options.onWait ?? ((message) => process.stderr.write(`${message}\n`)))(
          `Waiting for Android runner APK fence ${lockPath}; owner pid=${owner.birth.pid}, start=${owner.birth.token}, group=${owner.pgid}.`,
        );
        announced = owner.nonce;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new AndroidRunnerApkLockTimeoutError(lockPath, owner);
      await sleep(Math.min(25, remaining), signal);
    }
    let interrupted = false;
    try {
      throwIfCancelled(signal);
      const result = await operation();
      throwIfCancelled(signal);
      return result;
    } catch (error) {
      interrupted = forcedSubprocessStop(error);
      throw error;
    } finally {
      if (signal?.aborted || interrupted) {
        if (!(await stopAndroidProvisioningChildren(mine.birth, mine.pgid))) {
          database
            .prepare('UPDATE android_apk_owner SET owner = ? WHERE slot = 1 AND owner = ?')
            .run(JSON.stringify({ ...mine, retained: true }), encoded);
          acquired = false;
        }
      }
      if (acquired)
        database.prepare('DELETE FROM android_apk_owner WHERE slot = 1 AND owner = ?').run(encoded);
    }
  } finally {
    store.close();
  }
}
