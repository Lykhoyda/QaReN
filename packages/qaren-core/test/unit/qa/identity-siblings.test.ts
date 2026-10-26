// Sibling enumeration: every action path counts the same identities on the same fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import {
  bindFillIdentity,
  keyboardFallbackTarget,
  prepareTarget,
  targetVisible,
} from '../../../dist/qa/resolve.js';
import { refreshRef } from '../../../dist/fast-runner-ref-map.js';
import { bindExactFillTarget } from '../../../dist/handlers/device-interact.js';
import { classifyNativeVerification } from '../../../dist/handlers/fill-verify.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import type { Step } from '../../../dist/qa/plan.js';

const base = (): NativeNode[] => [
  { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
  {
    ref: '@win',
    index: 1,
    parentIndex: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    ref: '@field',
    index: 2,
    parentIndex: 1,
    type: 'TextField',
    identifier: 'email',
    hittable: true,
    rect: { x: 20, y: 100, width: 300, height: 44 },
  },
];

// The twin is a different kind on purpose: no kind filter may hide it before counting.
const fixtures: Record<'single' | 'twin', NativeNode[]> = {
  single: base(),
  twin: [
    ...base(),
    {
      ref: '@twin',
      index: 3,
      parentIndex: 1,
      type: 'Button',
      identifier: 'email',
      hittable: true,
      rect: { x: 20, y: 300, width: 300, height: 44 },
    },
  ],
};

const outcome = (r: ReturnType<typeof prepareTarget>): string =>
  'ref' in r ? r.ref : 'refuse' in r ? r.refuse : 'scroll' in r ? 'scroll' : 'question';

function walker(screen: Screen, calls: string[]): WalkerDeps {
  const ok: ActResult = { ok: true, proven: true };
  let clock = 0;
  return {
    async captureScreen() {
      return { ...screen, coverage: { native: 'complete', react: 'complete' } };
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return ok;
    },
    async fill(ref) {
      calls.push(`fill ${ref}`);
      return ok;
    },
    async scroll() {
      calls.push('scroll');
      return ok;
    },
    async back() {
      calls.push('back');
      return ok;
    },
    async dialog() {
      calls.push('dialog');
      return ok;
    },
    async hideDevMenu() {
      calls.push('hideDevMenu');
      return ok;
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => {},
    login: {
      marker: { id: 'email' },
      block: parsePlan('### Login\n1. Tap "Sign in"\n').blocks![0],
    },
  };
}

for (const [name, nodes] of Object.entries(fixtures)) {
  const twin = name === 'twin';
  test(`${name}: tap, fill, fallback, rebind, replay, recover, autoheal and bind agree`, async () => {
    const screen = join(nodes, []);
    const target = { quoted: 'email', phrase: 'email' };
    const fill: Step & { kind: 'fill' } = { kind: 'fill', target, text: 'a@b.co' };
    // Discovery: tap and fill.
    assert.equal(
      outcome(prepareTarget({ kind: 'press', target }, screen)),
      twin ? 'TARGET_AMBIGUOUS' : '@field',
    );
    assert.equal(outcome(prepareTarget(fill, screen)), twin ? 'TARGET_AMBIGUOUS' : '@field');
    // Keyboard fallback never resolves a target that is ambiguous or already an observable input.
    assert.equal(keyboardFallbackTarget(fill, screen), undefined);
    // Rebind after a fallback tap.
    if (twin)
      assert.throws(() => bindFillIdentity(fill, screen, 'email'), { code: 'TARGET_AMBIGUOUS' });
    else assert.equal(bindFillIdentity(fill, screen, 'email')?.kind, 'strict');
    // Replay of a stored id: terminal ambiguity, never a selector miss.
    const stored = { ...target, exact: 'id' as const };
    assert.equal(
      outcome(prepareTarget({ kind: 'press', target: stored }, screen)),
      twin ? 'TARGET_AMBIGUOUS' : '@field',
    );
    if (twin) assert.throws(() => targetVisible(stored, screen), { code: 'TARGET_AMBIGUOUS' });
    else assert.equal(targetVisible(stored, screen), true);
    // Keyboard auto-heal re-resolution.
    assert.equal(
      refreshRef({ type: 'TextField', identifier: 'email' }, nodes as never).kind,
      twin ? 'ambiguous' : 'unique',
    );
    // Dispatch-time native binding.
    const bound = bindExactFillTarget(nodes as never, 'email');
    assert.equal(bound.ok, !twin);
    if (twin) assert.equal((bound as { ambiguous?: boolean }).ambiguous, true);
    // Recovery: a login wall marked by the same id never replays login over an ambiguity.
    const calls: string[] = [];
    const ledger = await runPlan(parsePlan('1. Tap "email"\n').blocks!, walker(screen, calls));
    if (twin) {
      assert.equal(ledger.verdict, 'FAIL');
      assert.match(ledger.failure?.seen ?? '', /TARGET_AMBIGUOUS/);
      assert.deepEqual(calls, []);
    } else assert.deepEqual(calls, ['press @field']);
  });
}

// Empty and placeholder read-backs reach core as the runner's mismatch verdict (pinned in the
// Swift and Kotlin classifier tests); core must fail them, never pass them unverified.
test('empty and placeholder read-backs fail every fill path', () => {
  const verification = classifyNativeVerification('mismatch', true);
  assert.equal(verification.verified, false);
  assert.equal(verification.evidence, 'mismatch');
});
