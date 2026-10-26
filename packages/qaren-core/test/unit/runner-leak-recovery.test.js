import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAgentDeviceRunnerSentinel,
  recoverFromRunnerLeak,
} from '../../dist/handlers/runner-leak-recovery.js';

const RUNNER_TREE = [
  { ref: 'a', label: 'AgentDeviceRunner', type: 'Application' },
  { ref: 'b', type: 'Window' },
  { ref: 'c', identifier: 'Logo', type: 'Image' },
  { ref: 'd', label: 'Agent Device Runner', type: 'StaticText' },
  { ref: 'e', identifier: 'PoweredBy', type: 'Image' },
  { ref: 'f', type: 'Other' },
];

const REAL_APP_TREE_SMALL = [
  { ref: 'a', label: 'MyAwesomeApp', type: 'Application' },
  { ref: 'b', type: 'Window' },
  { ref: 'c', label: 'Welcome', type: 'StaticText' },
];

const REAL_APP_TREE_LARGE = Array.from({ length: 25 }, (_, i) => ({
  ref: `r${i}`,
  label: i === 0 ? 'AgentDeviceRunner' : `item-${i}`,
  type: i === 0 ? 'Application' : 'Other',
}));

// ── isAgentDeviceRunnerSentinel ───────────────────────────────────────

test('detects sentinel via Application label', () => {
  assert.equal(isAgentDeviceRunnerSentinel(RUNNER_TREE), true);
});

test('detects sentinel via fingerprint identifier + visible text', () => {
  const tree = [
    { ref: 'b', type: 'Window' },
    { ref: 'c', identifier: 'Logo', type: 'Image' },
    { ref: 'd', label: 'Agent Device Runner', type: 'StaticText' },
    { ref: 'e', identifier: 'PoweredBy', type: 'Image' },
  ];
  assert.equal(isAgentDeviceRunnerSentinel(tree), true);
});

test('does not detect on real app tree (different label)', () => {
  assert.equal(isAgentDeviceRunnerSentinel(REAL_APP_TREE_SMALL), false);
});

test('does not detect on large tree even with matching label (size guard)', () => {
  assert.equal(isAgentDeviceRunnerSentinel(REAL_APP_TREE_LARGE), false);
});

test('returns false for null/empty input', () => {
  assert.equal(isAgentDeviceRunnerSentinel(null), false);
  assert.equal(isAgentDeviceRunnerSentinel(undefined), false);
  assert.equal(isAgentDeviceRunnerSentinel([]), false);
});

test('does not detect when only one fingerprint signal present', () => {
  const onlyText = [
    { ref: 'a', label: 'Some App', type: 'Application' },
    { ref: 'b', label: 'Agent Device Runner', type: 'StaticText' },
  ];
  assert.equal(isAgentDeviceRunnerSentinel(onlyText), false);

  const onlyId = [
    { ref: 'a', label: 'Some App', type: 'Application' },
    { ref: 'b', identifier: 'Logo', type: 'Image' },
  ];
  assert.equal(isAgentDeviceRunnerSentinel(onlyId), false);
});

// ── recoverFromRunnerLeak: precondition gates ─────────────────────────

test('skips recovery when no appId in session context', async () => {
  const ctx = { platform: 'ios', appId: undefined };
  const deps = makeDepsRecording([]);
  const out = await recoverFromRunnerLeak(ctx, deps);
  assert.equal(out.recovered, false);
  assert.equal(out.reason, 'no-session-context');
  assert.equal(deps.calls.length, 0);
});

test('skips recovery on non-iOS platforms', async () => {
  const ctx = { platform: 'android', appId: 'com.x' };
  const deps = makeDepsRecording([]);
  const out = await recoverFromRunnerLeak(ctx, deps);
  assert.equal(out.recovered, false);
  assert.equal(out.reason, 'wrong-platform');
});

test('skips recovery when alreadyRecovered=true', async () => {
  const ctx = { platform: 'ios', appId: 'com.x', alreadyRecovered: true };
  const deps = makeDepsRecording([]);
  const out = await recoverFromRunnerLeak(ctx, deps);
  assert.equal(out.recovered, false);
  assert.equal(out.reason, 'already-attempted');
});

// ── recoverFromRunnerLeak: tier-1 attachOnly recovery ─────────────────

test('tier-1 attachOnly success preserves the exact authority-bound device', async () => {
  const cleanNodes = [{ ref: 'a', label: 'MyApp', type: 'Application' }];
  const ctx = {
    platform: 'ios',
    appId: 'com.example.app',
    deviceId: 'SIM-EXACT',
    sessionName: 's1',
  };
  const deps = makeDepsRecording([
    { kind: 'close', result: okResult({}) },
    { kind: 'open', result: okResult({ id: 'sim-udid' }), assertAttachOnly: true },
    { kind: 'snapshot', result: okResult({ nodes: cleanNodes }) },
  ]);

  const out = await recoverFromRunnerLeak(ctx, deps);
  assert.equal(out.recovered, true);
  assert.equal(out.tier, 'attach-only');
  assert.deepEqual(
    deps.calls.map((c) => c.kind),
    ['close', 'open', 'snapshot'],
  );
  const openArgs = deps.calls.find((c) => c.kind === 'open').args;
  assert.equal(openArgs.appId, 'com.example.app');
  assert.equal(openArgs.platform, 'ios');
  assert.equal(openArgs.deviceId, 'SIM-EXACT');
  assert.equal(openArgs.attachOnly, true);
});

// ── recoverFromRunnerLeak: tier-1 fails → tier-2 escalation ───────────

test('tier-1 sentinel + tier-2 success: returns recovered + tier=full-relaunch', async () => {
  const cleanNodes = [{ ref: 'a', label: 'MyApp', type: 'Application' }];
  const ctx = { platform: 'ios', appId: 'com.example.app' };
  const deps = makeDepsRecording([
    // Tier 1 (attachOnly) — comes back with sentinel
    { kind: 'close', result: okResult({}) },
    { kind: 'open', result: okResult({ id: 'udid' }), assertAttachOnly: true },
    { kind: 'snapshot', result: okResult({ nodes: RUNNER_TREE }) },
    // Tier 2 (full relaunch) — returns clean nodes
    { kind: 'close', result: okResult({}) },
    { kind: 'open', result: okResult({ id: 'udid' }), assertAttachOnly: false },
    { kind: 'snapshot', result: okResult({ nodes: cleanNodes }) },
  ]);

  const out = await recoverFromRunnerLeak(ctx, deps);
  assert.equal(out.recovered, true);
  assert.equal(out.tier, 'full-relaunch');
  assert.equal(deps.calls.length, 6);
});

test('tier-1 reopen failure escalates to tier-2', async () => {
  const cleanNodes = [{ ref: 'a', label: 'MyApp', type: 'Application' }];
  const ctx = { platform: 'ios', appId: 'com.example.app' };
  const deps = makeDepsRecording([
    // Tier 1 — reopen fails (e.g., app not running so attachOnly aborts)
    { kind: 'close', result: okResult({}) },
    { kind: 'open', result: errResult('attachOnly recovery aborted'), assertAttachOnly: true },
    // Tier 2 — full relaunch succeeds
    { kind: 'close', result: okResult({}) },
    { kind: 'open', result: okResult({ id: 'udid' }), assertAttachOnly: false },
    { kind: 'snapshot', result: okResult({ nodes: cleanNodes }) },
  ]);

  const out = await recoverFromRunnerLeak(ctx, deps);
  assert.equal(out.recovered, true);
  assert.equal(out.tier, 'full-relaunch');
});

// ── recoverFromRunnerLeak: both tiers fail ────────────────────────────

test('both tiers return sentinel: recovered=false with reason=still-sentinel', async () => {
  const ctx = { platform: 'ios', appId: 'com.example.app' };
  const deps = makeDepsRecording([
    { kind: 'close', result: okResult({}) },
    { kind: 'open', result: okResult({ id: 'udid' }), assertAttachOnly: true },
    { kind: 'snapshot', result: okResult({ nodes: RUNNER_TREE }) },
    { kind: 'close', result: okResult({}) },
    { kind: 'open', result: okResult({ id: 'udid' }), assertAttachOnly: false },
    { kind: 'snapshot', result: okResult({ nodes: RUNNER_TREE }) },
  ]);

  const out = await recoverFromRunnerLeak(ctx, deps);
  assert.equal(out.recovered, false);
  assert.equal(out.reason, 'still-sentinel');
});

test('both tiers reopen-fail: recovered=false with reason=reopen-failed', async () => {
  const ctx = { platform: 'ios', appId: 'com.example.app' };
  const deps = makeDepsRecording([
    { kind: 'close', result: okResult({}) },
    { kind: 'open', result: errResult('attachOnly aborted'), assertAttachOnly: true },
    { kind: 'close', result: okResult({}) },
    { kind: 'open', result: errResult('simulator not booted'), assertAttachOnly: false },
  ]);

  const out = await recoverFromRunnerLeak(ctx, deps);
  assert.equal(out.recovered, false);
  assert.equal(out.reason, 'reopen-failed');
  assert.equal(out.result.isError, true);
});

// ── helpers ───────────────────────────────────────────────────────────

function okResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
}

function errResult(msg) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }],
    isError: true,
  };
}

function makeDepsRecording(scripted) {
  const calls = [];
  let i = 0;
  const next = (kind, args) => {
    calls.push({ kind, args });
    const step = scripted[i++];
    if (!step) throw new Error(`unexpected ${kind} call (no scripted step)`);
    if (step.kind && step.kind !== kind) throw new Error(`expected ${step.kind} got ${kind}`);
    if (kind === 'open' && step.assertAttachOnly !== undefined) {
      assert.equal(args.attachOnly, step.assertAttachOnly, `open call ${i} attachOnly mismatch`);
    }
    return Promise.resolve(step.result);
  };
  return {
    calls,
    closeSession: () => next('close'),
    openSession: (args) => next('open', args),
    resnapshot: () => next('snapshot'),
    parseNodes: (result) => {
      try {
        return JSON.parse(result.content[0].text).data?.nodes ?? null;
      } catch {
        return null;
      }
    },
    sleep: () => Promise.resolve(),
  };
}
