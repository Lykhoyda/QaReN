import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { associatedHostAncestorsOf, join } from '../../../dist/qa/screen.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

type Variant = 'captured' | 'disabled-close' | 'sibling-close';
type JoinArgs = Parameters<typeof join>;
interface CapturedInput {
  nodes: JoinArgs[0];
  digest: JoinArgs[1];
  front: JoinArgs[2];
  coverage: NonNullable<JoinArgs[3]>;
  reactHostEvidence: NonNullable<JoinArgs[4]>;
  nativePresence?: JoinArgs[5];
  nativeAcquisition: NonNullable<JoinArgs[6]>;
}

function capture(name: string, variant: Variant, mutate?: (input: CapturedInput) => void) {
  const a: CapturedInput = JSON.parse(
    readFileSync(new URL(`../../fixtures/ios-cover-toast/${name}.json`, import.meta.url), 'utf8'),
  );
  if (variant === 'disabled-close') {
    const close = a.nodes.find((node) => node.identifier === 'qa-cover-toast-close');
    if (close) close.enabled = false;
  }
  if (variant === 'sibling-close' && a.reactHostEvidence.typography) {
    const { hosts, typography } = a.reactHostEvidence;
    const owner = hosts.findIndex((host) => host.testID === 'qa-cover-toast');
    const close = hosts.findIndex((host) => host.testID === 'qa-cover-toast-close');
    typography.nodes[close].parentHostIndex = typography.nodes[owner].parentHostIndex;
    hosts[close].order = 3;
  }
  mutate?.(a);
  return {
    ...join(
      a.nodes,
      a.digest,
      a.front,
      a.coverage,
      a.reactHostEvidence,
      a.nativePresence,
      a.nativeAcquisition,
    ),
    captureCoverage: { native: a.nativeAcquisition, react: a.coverage.react },
    keyboardVisible: false,
  };
}

async function persistentToast(variant: Variant = 'captured') {
  const w = walker(
    [],
    scriptedJudge(() => assert.fail('the quoted target is model-free')),
  );
  w.deps.platform = 'ios';
  w.deps.captureScreen = async (options) =>
    capture(
      !w.actions.length ? 'before-scroll' : options?.platformPresence ? 'presence' : 'after-scroll',
      variant,
    );
  let attempts = 0;
  w.deps.press = async (ref, _context, options) => {
    attempts++;
    assert.equal(ref, '@e20', 'only Continue may be attempted');
    assert.equal(options?.requireLiveHit, true);
    return {
      ok: false,
      proven: false,
      mutation: 'none',
      error: 'LIVE_HIT_UNPROVEN: not-hittable; no tap was performed',
    };
  };
  const notes: string[] = [];
  w.deps.note = (note) => notes.push(note);
  const result = await runPlan(parsePlan('1. Tap "Continue"').blocks!, w.deps);
  const row = ('steps' in result ? result.steps : []).at(-1);
  assert.equal(row?.outcome, 'fail', JSON.stringify(row));
  assert.equal(row?.coverWaitMs, 5000);
  assert.equal(attempts, 1, 'the non-mutating live hit is not repeated');
  assert.deepEqual(w.actions, ['scroll down']);
  assert.equal(w.rows.at(-1)?.coverWaitMs, 5000);
  assert.match(String(row?.reason), /the live hit read refused the press \(not-hittable\)/);
  assert.equal(notes.filter((note) => note.startsWith('cover-wait ')).length, 2);
  return row;
}

test('captured iOS toast: the refusal counts its Close despite flattened native ancestry', async () => {
  const row = await persistentToast();
  assert.match(
    String(row?.reason),
    /the cover holds 1 pressable controls \(decline-labelled: Close\)/,
  );
});

test('captured iOS toast: a disabled Close is not counted', async () => {
  const row = await persistentToast('disabled-close');
  assert.match(String(row?.reason), /the cover holds 0 pressable controls/);
  assert.doesNotMatch(String(row?.reason), /decline-labelled:/);
});

test('captured iOS toast: an overlapping sibling Close is not owned by the cover', async () => {
  const screen = capture('presence', 'sibling-close');
  const owner = screen.elements.find((element) => element.testID === 'qa-cover-toast');
  const close = screen.elements.find((element) => element.testID === 'qa-cover-toast-close');
  assert.ok(owner && close);
  assert.equal(close.semantic?.press, 'supported');
  assert.equal(close.semantic?.visibility, 'visible');
  assert.equal(associatedHostAncestorsOf(close).includes(owner), false);
  const row = await persistentToast('sibling-close');
  assert.match(String(row?.reason), /the cover holds 0 pressable controls/);
  assert.doesNotMatch(String(row?.reason), /decline-labelled:/);
});

for (const gap of ['incomplete-evidence', 'duplicate-owner', 'mismatched-owner-frame']) {
  test(`captured iOS toast: ${gap} cannot prove React cover membership`, () => {
    const screen = capture('presence', 'captured', (a) => {
      if (gap === 'incomplete-evidence') a.reactHostEvidence.complete = false;
      if (gap === 'duplicate-owner') {
        const owner = a.nodes.find((node) => node.identifier === 'qa-cover-toast');
        assert.ok(owner);
        a.nodes.push({ ...owner, ref: '@duplicate', index: a.nodes.length });
        assert.ok(a.nativePresence && typeof a.nativePresence === 'object');
        a.nativePresence.nodes.push({ status: 'observed', labelSource: 'none' });
      }
      if (gap === 'mismatched-owner-frame') {
        const { hosts, typography } = a.reactHostEvidence;
        const owner = hosts.findIndex((host) => host.testID === 'qa-cover-toast');
        assert.ok(typography?.nodes[owner].rect);
        typography.nodes[owner].rect.width++;
      }
    });
    const owner = screen.elements.find((element) => element.testID === 'qa-cover-toast');
    const close = screen.elements.find((element) => element.testID === 'qa-cover-toast-close');
    assert.ok(owner && close);
    assert.equal(associatedHostAncestorsOf(close).includes(owner), false);
  });
}
