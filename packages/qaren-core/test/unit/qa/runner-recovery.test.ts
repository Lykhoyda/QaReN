import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRunnerRecovery,
  RUNNER_RELAUNCH_LIMIT,
  type RunnerRecoveryDeps,
} from '../../../dist/qa/runner-recovery.js';

type Answer = 'alive' | 'relaunched' | 'down';

function port(options: { runner: Answer[]; pids?: (number | undefined | Error)[] }) {
  const runner = [...options.runner];
  const pids = [...(options.pids ?? [])];
  const calls: string[] = [];
  const notes: string[] = [];
  const relaunched: [number | undefined, number | undefined][] = [];
  const deps: RunnerRecoveryDeps = {
    async appProcess() {
      calls.push('app');
      const next = pids.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    async runner(relaunch) {
      calls.push(relaunch ? 'relaunch' : 'probe');
      return runner.shift() ?? 'down';
    },
    relaunched: (from, to) => {
      relaunched.push([from, to]);
    },
    note: (line) => {
      notes.push(line);
    },
  };
  return { recovery: createRunnerRecovery(deps), calls, notes, relaunched };
}

test('R1 an answering runner is alive after one probe and no app read', async () => {
  const p = port({ runner: ['alive'] });
  assert.equal(await p.recovery.recover(), 'alive');
  assert.deepEqual(p.calls, ['probe']);
  assert.equal(p.recovery.relaunches, 0);
});

test('R2 a down runner beside the same app process is relaunched and recorded', async () => {
  const p = port({ runner: ['down', 'relaunched'], pids: [41, 41] });
  assert.equal(await p.recovery.recover(), 'relaunched');
  assert.deepEqual(p.calls, ['probe', 'app', 'relaunch', 'app']);
  assert.deepEqual(p.relaunched, [[41, 41]]);
});

test('R3 a different app process after the relaunch is the app, not the runner', async () => {
  const p = port({ runner: ['down', 'relaunched'], pids: [41, 77] });
  assert.equal(await p.recovery.recover(), 'app-changed');
  assert.deepEqual(p.relaunched, [[41, 77]]);
});

test('R4 an app that is not running is never answered with a relaunch', async () => {
  const p = port({ runner: ['down'], pids: [undefined] });
  assert.equal(await p.recovery.recover(), 'app-changed');
  assert.deepEqual(p.calls, ['probe', 'app']);
  assert.equal(p.recovery.relaunches, 0);
});

test('R5 an unreadable app process still allows the relaunch, recorded as unproven', async () => {
  const p = port({ runner: ['down', 'relaunched'], pids: [new Error('read'), new Error('read')] });
  assert.equal(await p.recovery.recover(), 'relaunched');
  assert.deepEqual(p.relaunched, [[undefined, undefined]]);
});

test('R6 a relaunch that does not come back is down', async () => {
  const p = port({ runner: ['down', 'down'], pids: [41] });
  assert.equal(await p.recovery.recover(), 'down');
  assert.deepEqual(p.relaunched, []);
});

test('R7 the run stops relaunching at the limit and only probes after it', async () => {
  const answers: Answer[] = [];
  for (let i = 0; i < RUNNER_RELAUNCH_LIMIT; i++) answers.push('down', 'relaunched');
  answers.push('down');
  const p = port({ runner: answers, pids: Array(RUNNER_RELAUNCH_LIMIT * 2).fill(41) });
  for (let i = 0; i < RUNNER_RELAUNCH_LIMIT; i++)
    assert.equal(await p.recovery.recover(), 'relaunched');
  const before = p.calls.length;
  assert.equal(await p.recovery.recover(), 'down');
  assert.deepEqual(p.calls.slice(before), ['probe']);
  assert.equal(p.recovery.relaunches, RUNNER_RELAUNCH_LIMIT);
});

test('R8 a cancellation during the relaunch is rethrown, never answered', async () => {
  const abort = new DOMException('stopped', 'AbortError');
  const recovery = createRunnerRecovery({
    async appProcess() {
      return 41;
    },
    async runner(relaunch) {
      if (relaunch) throw abort;
      return 'down';
    },
    relaunched: () => assert.fail('a cancelled relaunch is not recorded'),
  });
  await assert.rejects(recovery.recover(), (error) => error === abort);
});

test('R9 an app that exits during the restart is the app, not the runner', async () => {
  const p = port({ runner: ['down', 'relaunched'], pids: [41, undefined] });
  assert.equal(await p.recovery.recover(), 'app-changed');
  assert.deepEqual(p.relaunched, [[41, undefined]]);
});

test('R10 a restart made by a timeout containment is taken without a start of our own', async () => {
  const p = port({ runner: ['relaunched'], pids: [41] });
  assert.equal(await p.recovery.recover(), 'relaunched');
  assert.deepEqual(p.calls, ['probe', 'app']);
  assert.deepEqual(p.relaunched, [[undefined, 41]]);
  assert.equal(p.recovery.relaunches, 1);
});

test('R11 a containment restart past the limit refuses as down without reading the app', async () => {
  const answers: Answer[] = [];
  for (let i = 0; i < RUNNER_RELAUNCH_LIMIT; i++) answers.push('down', 'relaunched');
  answers.push('relaunched');
  const p = port({ runner: answers, pids: Array(RUNNER_RELAUNCH_LIMIT * 2).fill(41) });
  for (let i = 0; i < RUNNER_RELAUNCH_LIMIT; i++)
    assert.equal(await p.recovery.recover(), 'relaunched');
  const before = p.calls.length;
  assert.equal(await p.recovery.recover(), 'down');
  assert.deepEqual(p.calls.slice(before), ['probe']);
  assert.equal(p.recovery.relaunches, RUNNER_RELAUNCH_LIMIT);
  assert.equal(
    p.notes.at(-1),
    `runner-recovery=down relaunches=${RUNNER_RELAUNCH_LIMIT} limit=reached by=containment`,
  );
});
