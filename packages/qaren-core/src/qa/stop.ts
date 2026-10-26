import { interruptible, withCancellation, RunCancelledError } from '../domain/cancellation.js';
// The core child's one cancellation owner: once stopping, no new device work starts.
export function createStop() {
  const controller = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  return {
    signal: controller.signal,
    get stopping(): boolean {
      return controller.signal.aborted;
    },
    begin(reason: Error = new RunCancelledError()): boolean {
      if (controller.signal.aborted) return false;
      controller.abort(reason);
      return true;
    },
    track<T>(op: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
      const pending = withCancellation(controller.signal, () =>
        interruptible(() => {
          const operation = op();
          const settled = operation.catch(() => undefined);
          inFlight.add(settled);
          void settled.finally(() => inFlight.delete(settled));
          return operation;
        }),
      );
      return pending;
    },
    // The deadline stays referenced so teardown runs even if the work never settles.
    drained(ms: number): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      return Promise.race([Promise.all(inFlight).then(() => undefined), deadline]).finally(() =>
        clearTimeout(timer),
      );
    },
  };
}

// A write error on the wire means the CLI stopped reading; stop the walk rather than crash before teardown.
export function watchOwnerPipe(
  stream: NodeJS.WritableStream,
  onGone: (code: string) => void,
): void {
  stream.on('error', (error: NodeJS.ErrnoException) => onGone(error.code ?? 'WRITE_FAILED'));
}

// `expected` is the parent recorded at process start; any other parent means the CLI is gone.
export function watchParent(
  expected: number,
  readParent: () => number,
  onGone: () => void,
  everyMs = 1000,
): () => void {
  if (readParent() !== expected) {
    onGone();
    return () => undefined;
  }
  const timer = setInterval(() => {
    if (readParent() === expected) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
