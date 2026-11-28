import { isAbort } from '../domain/cancellation.js';

// QaReN's own device runner, asked on a step that failed before it sent anything.
// alive: it answers (or answers as another driver's, which is not QaReN's to restart), so the step's
// own failure stands. relaunched: it was down and one bounded
// attach-only start brought it back beside the same app process. down: it is still not answering.
// app-changed: the app's process is gone or is a different one, so there is no state to return to.
export type RunnerRecovery = 'alive' | 'relaunched' | 'down' | 'app-changed';

// One start per call; a run that needs a third start has an unstable runner and is refused.
export const RUNNER_RELAUNCH_LIMIT = 2;

export interface RunnerRecoveryDeps {
  // The app's process id, undefined when it is not running; rejects when it cannot be read.
  appProcess(): Promise<number | undefined>;
  // Probes the runner; with `relaunch` it may start it once, attach-only, when it is down.
  runner(relaunch: boolean): Promise<'alive' | 'relaunched' | 'down'>;
  // Records the relaunch against the app's process before and after it.
  relaunched(fromPid: number | undefined, toPid: number | undefined): void;
  note?(line: string): void;
}

export interface RunnerRecoveryPort {
  recover(): Promise<RunnerRecovery>;
  readonly relaunches: number;
}

export function createRunnerRecovery(deps: RunnerRecoveryDeps): RunnerRecoveryPort {
  let relaunches = 0;
  const note = (line: string): void => {
    try {
      deps.note?.(line);
    } catch {
      /* Diagnostics cannot change recovery. */
    }
  };
  const appProcess = async (): Promise<{ known: boolean; pid?: number }> => {
    try {
      return { known: true, pid: await deps.appProcess() };
    } catch (error) {
      if (isAbort(error)) throw error;
      return { known: false };
    }
  };
  return {
    get relaunches() {
      return relaunches;
    },
    async recover() {
      const allowed = relaunches < RUNNER_RELAUNCH_LIMIT;
      // A runner that answers needs no app read; only a start is weighed against the app's process.
      const first = await deps.runner(false);
      if (first === 'alive') return 'alive';
      if (first === 'relaunched') {
        // Another owner (a timeout containment) restarted it while this step waited: no start of our
        // own, but the step starts again only within the same limit, and only beside a running app.
        if (!allowed) {
          note(`runner-recovery=down relaunches=${relaunches} limit=reached by=containment`);
          return 'down';
        }
        relaunches += 1;
        const after = await appProcess();
        deps.relaunched(undefined, after.pid);
        if (after.known && after.pid === undefined) {
          note(`runner-recovery=app-changed relaunches=${relaunches} by=containment`);
          return 'app-changed';
        }
        note(`runner-recovery=relaunched relaunches=${relaunches} by=containment app=unproven`);
        return 'relaunched';
      }
      if (!allowed) {
        note(`runner-recovery=down relaunches=${relaunches} limit=reached`);
        return 'down';
      }
      const before = await appProcess();
      if (before.known && before.pid === undefined) {
        note('runner-recovery=app-changed app=not-running');
        return 'app-changed';
      }
      relaunches += 1;
      const outcome = await deps.runner(true);
      if (outcome !== 'relaunched') {
        note(`runner-recovery=${outcome} relaunches=${relaunches}`);
        return outcome;
      }
      const after = await appProcess();
      deps.relaunched(before.pid, after.pid);
      if (
        (after.known && after.pid === undefined) ||
        (before.pid !== undefined && after.pid !== undefined && before.pid !== after.pid)
      ) {
        note(`runner-recovery=app-changed relaunches=${relaunches}`);
        return 'app-changed';
      }
      note(
        `runner-recovery=relaunched relaunches=${relaunches} app=${before.pid !== undefined && after.pid !== undefined ? 'same-process' : 'unproven'}`,
      );
      return 'relaunched';
    },
  };
}
