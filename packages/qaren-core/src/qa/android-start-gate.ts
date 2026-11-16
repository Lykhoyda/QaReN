import { TargetReadinessTimeoutError } from '../cdp/discovery.js';
import { interruptible, isAbort, sleep } from '../domain/cancellation.js';

type StartState = 'undecided' | 'holding' | 'loaded' | 'let_through';

// One admission owns one gate, including its poll spacing across readiness retries.
export function androidStartGate({
  read,
  log,
  at,
  pollMs = 2000,
}: {
  read(): Promise<unknown>;
  log(line: string): void;
  at(): number;
  pollMs?: number;
}) {
  let current: StartState = 'undecided';
  let nextRead = 0;
  const held = () =>
    new TargetReadinessTimeoutError("Timed out waiting for the app's first screen");
  return {
    state: (): StartState => current,
    note(): string {
      switch (current) {
        case 'undecided':
          return '; the first-screen check had not answered, so no debugger was attached';
        case 'holding':
          return "; the app's first screen had not appeared, so no debugger was attached";
        case 'let_through':
          return '; the first-screen check could not be read; attaching a debugger was allowed as before';
        case 'loaded':
          return '';
      }
    },
    async wait(windowMs: number): Promise<void> {
      if (current === 'loaded' || current === 'let_through') return;
      const end = performance.now() + windowMs;
      for (;;) {
        const now = performance.now();
        if (nextRead > now) {
          await sleep(Math.min(nextRead - now, end - now));
          if (performance.now() >= end) throw held();
        }
        nextRead = performance.now() + pollMs;
        let answer: unknown;
        try {
          answer = await interruptible(read);
        } catch (error) {
          if (isAbort(error)) throw error;
          answer = 'unknown';
        }
        if (answer === 'loaded') {
          current = 'loaded';
          log(`android start: first screen seen at ${at()} ms; attaching`);
          return;
        }
        if (answer !== 'loading') {
          current = 'let_through';
          log('android start: first-screen check unavailable; attaching as before');
          return;
        }
        if (current !== 'holding') {
          current = 'holding';
          log('android start: holding the debugger until the first screen');
        }
        if (performance.now() >= end) throw held();
      }
    },
  };
}
