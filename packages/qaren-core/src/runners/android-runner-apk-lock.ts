import { mkdirSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cancellationSignal, sleep, throwIfCancelled } from '../domain/cancellation.js';

export class AndroidRunnerApkLockTimeoutError extends Error {
  readonly code = 'ANDROID_RUNNER_APK_LOCK_TIMEOUT';

  constructor() {
    super('ANDROID_RUNNER_APK_LOCK_TIMEOUT: timed out waiting for Android runner APK outputs');
  }
}

// One worktree's APK pair is a single provisioning resource. This outputs lock
// has no version budget and is never nested inside itself. Stale retries acquire
// the rebuild-budget lock first, then this lock for invalidation and provisioning.
// Never steal it by age: a cold Gradle build may still be writing the outputs.
export async function withAndroidRunnerApkLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const signal = cancellationSignal(options.signal);
  const deadline = performance.now() + (options.timeoutMs ?? 15 * 60_000);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    throwIfCancelled(signal);
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new AndroidRunnerApkLockTimeoutError();
      await sleep(Math.min(25, remaining), signal);
    }
  }
  try {
    throwIfCancelled(signal);
    return await operation();
  } finally {
    // Cancellation may return before Gradle's descendants have stopped. Keep
    // the fence in that case, just as after a process crash; no timed takeover.
    if (!signal?.aborted) rmdirSync(lockPath);
  }
}
