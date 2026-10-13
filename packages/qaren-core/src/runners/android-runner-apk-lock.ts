import { mkdirSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cancellationSignal, sleep, throwIfCancelled } from '../domain/cancellation.js';

export class AndroidRunnerApkLockTimeoutError extends Error {
  readonly code = 'ANDROID_RUNNER_APK_LOCK_TIMEOUT';

  constructor() {
    super('ANDROID_RUNNER_APK_LOCK_TIMEOUT: timed out waiting for Android runner APK outputs');
  }
}

function forcedSubprocessStop(error: unknown): boolean {
  // Provisioning preserves subprocess metadata in Error.cause. A killed or
  // signal-terminated launcher cannot prove its descendants stopped writing.
  for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth += 1) {
    const failure = error as { killed?: unknown; signal?: unknown; cause?: unknown };
    if (failure.killed === true || typeof failure.signal === 'string') return true;
    error = failure.cause;
  }
  return false;
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
  let interrupted = false;
  try {
    throwIfCancelled(signal);
    return await operation();
  } catch (error) {
    interrupted = forcedSubprocessStop(error);
    throw error;
  } finally {
    // Cancellation and forced stops may return before descendants stop. Keep
    // the fence in those cases, just as after a crash; no timed takeover.
    if (!signal?.aborted && !interrupted) rmdirSync(lockPath);
  }
}
