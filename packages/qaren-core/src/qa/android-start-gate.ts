import { TargetReadinessTimeoutError } from '../cdp/discovery.js';
import { interruptible, isAbort, sleep } from '../domain/cancellation.js';

type StartState = 'undecided' | 'holding' | 'loaded' | 'let_through';

// One admission owns one gate, including its poll spacing across readiness retries.
// It steps aside only after giveUpMs with no read showing the app's process.
export function androidStartGate({
  read,
  log,
  at,
  pollMs = 2000,
  giveUpMs = 15_000,
}: {
  read(): Promise<unknown>;
  log(line: string): void;
  at(): number;
  pollMs?: number;
  giveUpMs?: number;
}) {
  let current: StartState = 'undecided';
  let nextRead = 0;
  // The last loading answer; before one, the first ask.
  let lastSeen: number | undefined;
  let askedAgain = false;
  const held = () =>
    new TargetReadinessTimeoutError("Timed out waiting for the app's first screen");
  return {
    state: (): StartState => current,
    // A new start: hold it again until its own first views.
    restart(): void {
      current = 'undecided';
      nextRead = 0;
      lastSeen = undefined;
      askedAgain = false;
    },
    note(): string {
      switch (current) {
        case 'undecided':
          return '; the first-views check had not answered, so no debugger was attached';
        case 'holding':
          return "; the app's first views had not appeared, so no debugger was attached";
        case 'let_through':
          return '; the first-views check could not be read; attaching a debugger was allowed as before';
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
          continue;
        }
        nextRead = performance.now() + pollMs;
        lastSeen ??= performance.now();
        let answer: unknown;
        try {
          answer = await interruptible(read);
        } catch (error) {
          if (isAbort(error)) throw error;
          answer = 'unknown';
        }
        if (answer === 'loaded') {
          current = 'loaded';
          log(`android start: first views seen at ${at()} ms; attaching`);
          return;
        }
        if (answer === 'loading') {
          lastSeen = performance.now();
          if (current !== 'holding') {
            current = 'holding';
            log(`android start: holding the debugger until the app's first views at ${at()} ms`);
          }
        } else if (performance.now() - lastSeen >= giveUpMs) {
          current = 'let_through';
          log(`android start: first-views check unavailable at ${at()} ms; attaching as before`);
          return;
        } else if (!askedAgain) {
          askedAgain = true;
          log(`android start: first-views check not answered at ${at()} ms; asking again`);
        }
        if (performance.now() >= end) throw held();
      }
    },
  };
}
