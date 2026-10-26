// GH #186 P0: runner-leak recovery should try a NON-DESTRUCTIVE reacquire
// (re-foreground the target app via the fast-runner) BEFORE the ~44s full
// relaunch. Both the daemon-leak and the maestro-eviction cases surface as the
// same AgentDeviceRunner sentinel, so we don't try to distinguish them — we add
// a strictly-additive cheap tier that falls back to today's behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverFromRunnerLeak } from '../../dist/handlers/runner-leak-recovery.js';
import { markCdpStale, consumeCdpStale } from '../../dist/cdp/recovery.js';

const SENTINEL = [{ label: 'AgentDeviceRunner' }]; // isAgentDeviceRunnerSentinel → true
const APP = [{ label: 'Home', identifier: 'home' }]; // → false

const ok = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
const snap = (nodes) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { nodes } }) }],
  __nodes: nodes,
});

function makeDeps(snapshotQueue, { withReacquire = true } = {}) {
  const calls = [];
  let i = 0;
  const deps = {
    closeSession: async () => {
      calls.push('close');
      return ok();
    },
    openSession: async (a) => {
      calls.push(a.attachOnly ? 'open:attach' : 'open:relaunch');
      return ok();
    },
    resnapshot: async () => {
      calls.push('resnap');
      return snap(snapshotQueue[i++] ?? SENTINEL);
    },
    parseNodes: (r) => r.__nodes ?? null,
    sleep: async () => {},
  };
  if (withReacquire)
    deps.reacquire = async () => {
      calls.push('reacquire');
      return ok();
    };
  return { calls, deps };
}

test('reacquire tier clears the sentinel WITHOUT any relaunch/attach', async () => {
  const { calls, deps } = makeDeps([APP]); // reacquire's resnapshot → real app tree
  const out = await recoverFromRunnerLeak({ platform: 'ios', appId: 'com.x' }, deps);
  assert.equal(out.recovered, true);
  assert.equal(out.tier, 'reacquire');
  assert.ok(calls.includes('reacquire'), 'tried reacquire');
  assert.ok(
    !calls.some((c) => c.startsWith('open:')),
    'no openSession — app state preserved, no 44s relaunch',
  );
});

test('falls through reacquire → attachOnly → full-relaunch when reacquire does not clear the sentinel', async () => {
  // reacquire→SENTINEL, attachOnly→SENTINEL, full-relaunch→APP
  const { calls, deps } = makeDeps([SENTINEL, SENTINEL, APP]);
  const out = await recoverFromRunnerLeak({ platform: 'ios', appId: 'com.x' }, deps);
  assert.equal(out.recovered, true);
  assert.equal(out.tier, 'full-relaunch');
  assert.deepEqual(
    calls.filter((c) => c === 'reacquire' || c.startsWith('open:')),
    ['reacquire', 'open:attach', 'open:relaunch'],
    'tier order: reacquire first, then the existing attach + relaunch tiers',
  );
});

test('without a reacquire dep, behavior is unchanged (attach-only tier still works)', async () => {
  const { calls, deps } = makeDeps([APP], { withReacquire: false });
  const out = await recoverFromRunnerLeak({ platform: 'ios', appId: 'com.x' }, deps);
  assert.equal(out.recovered, true);
  assert.equal(out.tier, 'attach-only');
  assert.ok(!calls.includes('reacquire'));
});

// CDP re-pin flag — read-and-clear so withConnection picks it up exactly once.
test('markCdpStale / consumeCdpStale is a read-and-clear flag', () => {
  consumeCdpStale(); // normalize any prior state
  assert.equal(consumeCdpStale(), false, 'starts clear');
  markCdpStale();
  assert.equal(consumeCdpStale(), true, 'set then consumed true');
  assert.equal(consumeCdpStale(), false, 'cleared after one consume');
});
