import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan, type WalkerDeps } from '../../../dist/qa/walker.js';
import { NativeSnapshotIncomplete } from '../../../dist/qa/private-input.js';
import type { Screen } from '../../../dist/qa/screen.js';
import { element, screen } from './judgment-fixtures.ts';

const PRESENCE_CAUSE = 'presence-incomplete=final-eligibility:deadline';

// Interruption recovery is the only presence read of a quoted Fill; it is refused as on a long list.
function walk(current: Screen, recoveryRead: () => Error = refusedRead) {
  const shots: string[] = [];
  const captures: boolean[] = [];
  const deps: WalkerDeps = {
    async captureScreen(options) {
      captures.push(options?.platformPresence === true);
      if (options?.platformPresence) throw recoveryRead();
      return current;
    },
    async press() {
      throw new Error('unexpected press');
    },
    async fill() {
      throw new Error('unexpected fill');
    },
    async scroll() {
      throw new Error('unexpected scroll');
    },
    async back() {
      throw new Error('unexpected back');
    },
    async dialog() {
      throw new Error('unexpected dialog');
    },
    async hideDevMenu() {
      throw new Error('unexpected dev menu');
    },
    async screenshot(name) {
      shots.push(name);
      return name;
    },
    now: () => 0,
    async sleep() {},
    row() {},
  };
  return { deps, shots, captures };
}

function refusedRead(): Error {
  return new NativeSnapshotIncomplete(312, ['verdict=degraded', PRESENCE_CAUSE], 3, 20_035);
}

const fill = (target: string) => parsePlan(`1. Fill "${target}" with "rv"`).blocks!;

// One input the placeholder could name, but no React coverage to pair it with.
const unpairedField = (): Screen => ({
  ...screen([element('@field', '', { kind: 'input' })]),
  coverage: { native: 'complete', react: 'incomplete' },
  captureCoverage: { native: 'complete', react: 'incomplete' },
});

async function refused(current: Screen, target: string) {
  const f = walk(current);
  const result = await runPlan(fill(target), f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(result.code, 'NATIVE_SNAPSHOT_INCOMPLETE');
  assert.ok(f.captures.includes(true), 'recovery took its presence read');
  return { result, shots: f.shots, causes: result.message?.match(/causes=([^)]*)\)/)?.[1] };
}

test('a quoted Fill whose target is missing names that first reason inside the recovery read refusal', async () => {
  const { result, shots, causes } = await refused(
    screen([element('@settings', 'Settings')]),
    'Search',
  );
  // The refusal still withholds the screen and leaves the video unproven, as without the reason.
  assert.deepEqual(shots, []);
  assert.equal(result.videoPublication, 'unknown');
  assert.equal(result.failure?.seen, result.message);
  assert.match(result.message!, /\(nodes=312; .*\); read 3 times over 20035 ms\.$/);
  assert.equal(
    causes,
    `verdict=degraded,${PRESENCE_CAUSE},step-reason=target-not-found`,
    result.message,
  );
});

test('an unpaired placeholder field adds the placeholder pairing gap to the refusal', async () => {
  const { result, causes } = await refused(unpairedField(), 'Search');
  assert.equal(
    causes,
    `verdict=degraded,${PRESENCE_CAUSE},step-reason=target-not-found,placeholder-pairing=incomplete`,
    result.message,
  );
});

test('a first reason outside the fixed target codes is named only as other', async () => {
  // An unquoted Tap over more than 30 candidates refuses CANDIDATE_LIMIT, a recoverable code without a fixed word.
  const crowded = screen(
    Array.from({ length: 31 }, (_, index) => element(`@b${index}`, `Item ${index}`)),
  );
  let presenceReads = 0;
  const f = walk(crowded);
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    if (options?.platformPresence && ++presenceReads === 1) return crowded;
    return capture(options);
  };
  const result = await runPlan(parsePlan('1. Tap the settings button').blocks!, f.deps);
  assert.equal(result.code, 'NATIVE_SNAPSHOT_INCOMPLETE', result.message);
  assert.equal(
    result.message?.match(/causes=([^)]*)\)/)?.[1],
    `verdict=degraded,${PRESENCE_CAUSE},step-reason=other`,
  );
});

test('the refusal filter drops a step reason or pairing word outside the closed set', () => {
  const error = new NativeSnapshotIncomplete(1, [
    'step-reason=target-not-found',
    'step-reason=private-label-canary',
    'step-reason=TARGET_NOT_FOUND',
    'placeholder-pairing=complete',
    'placeholder-pairing=unknown',
  ]);
  assert.deepEqual(error.causes, ['step-reason=target-not-found', 'placeholder-pairing=unknown']);
});

test('a cancelled recovery read still cancels the walk', async () => {
  const f = walk(screen([element('@settings', 'Settings')]), () =>
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  );
  await assert.rejects(runPlan(fill('Search'), f.deps), { name: 'AbortError' });
});
