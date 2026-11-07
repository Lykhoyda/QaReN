import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  dismissCandidate,
  soleDecline,
  targetBehindInterruption,
} from '../../../dist/qa/recover.js';
import type {
  InterruptionDiagnostic,
  InterruptionProof,
  RecoveryTarget,
} from '../../../dist/qa/recover.js';
import {
  hostAssociationIdentity,
  join,
  modalCoverDiagnostic,
  type Screen,
} from '../../../dist/qa/screen.js';

// Real Android 17 captures of a full-screen React Native Modal promo (heading, copy, one Close)
// presented over a mounted Home: Android lists only the modal's own window.
function joinArgs(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(`../../fixtures/android-promo-modal/${name}.json`, import.meta.url),
      'utf8',
    ),
  ).joinArgs;
}

const joined = (a: ReturnType<typeof joinArgs>): Screen =>
  join(
    a.nodes,
    a.digest,
    a.front,
    a.coverage,
    a.reactHostEvidence,
    a.nativePresence,
    a.nativeAcquisition,
  );

const capture = (name: string): Screen => joined(joinArgs(name));

const target = (
  quoted: string,
  kind: RecoveryTarget['kind'],
  line: number,
  extra: Partial<RecoveryTarget> = {},
): RecoveryTarget => ({ phrase: quoted, quoted, kind, line, ...extra });

const decide = (screen: Screen, targets: RecoveryTarget[], proof?: InterruptionProof) => {
  const records: InterruptionDiagnostic[] = [];
  return {
    result: dismissCandidate(screen, targets, (record) => records.push(record), proof),
    records,
  };
};

for (const name of ['check-first-presence', 'fill-first-presence', 'wait-first-presence']) {
  test(`Android ${name}: the Close inside the presented modal associates and is the only control`, () => {
    const screen = capture(name);
    const close = screen.elements.find((e) => e.testID === 'qa-promo-close')!;
    assert.equal(hostAssociationIdentity(close), 'matched');
    assert.equal(screen.pressGapCount, 0);
    assert.equal(soleDecline(screen), true);
    assert.equal(modalCoverDiagnostic(screen)?.refused, undefined);
  });
}

test('Android check-first: a later tap matching the promo copy no longer keeps the sole Close up', () => {
  const { result, records } = decide(capture('check-first-presence'), [
    target('Target taps: 0', 'check', 23),
    target('qa-promo-home-target', 'press', 24),
    target('See offers', 'press', 25),
  ]);
  assert.deepEqual(result, { label: 'Close' });
  assert.deepEqual(records, []);
});

test('Android fill-first: a missing fill target behind the presented modal closes it', () => {
  const { result } = decide(
    capture('fill-first-presence'),
    [target('qa-promo-home-field', 'fill', 23)],
    'surface',
  );
  assert.deepEqual(result, { label: 'Close' });
});

test('Android wait-first: a React-only target is proven behind the presented modal', () => {
  const screen = capture('wait-first-presence');
  const wait = target('qa-promo-home-target', 'wait', 23, { exact: 'id' });
  assert.equal(targetBehindInterruption(screen, wait), true);
  assert.deepEqual(decide(screen, [wait], 'covered-target').result, { label: 'Close' });
});

test('Android tap-first: the ordinary press capture cannot prove the cover', () => {
  const screen = capture('tap-first-press');
  assert.equal(
    targetBehindInterruption(screen, target('qa-promo-home-target', 'press', 23, { exact: 'id' })),
    false,
  );
});

test('Android with two presented modals vetoes recovery without a proven cover', () => {
  const a = joinArgs('fill-first-presence');
  const nodes = a.reactHostEvidence.typography.nodes;
  // Turn a mounted Home container with children into a second presented modal.
  const second = nodes.find(
    (node: { hostIndex: number; hostType: string | null }) =>
      node.hostType === 'RCTView' &&
      a.reactHostEvidence.hosts[node.hostIndex].testID === 'qa-promo-home' &&
      nodes.some(
        (child: { parentHostIndex: number | null }) => child.parentHostIndex === node.hostIndex,
      ),
  );
  assert.ok(second, 'the capture mounts Home under its own container');
  second.hostType = 'RCTModalHostView';
  const screen = joined(a);
  const cover = modalCoverDiagnostic(screen)!;
  assert.equal(cover.associatedCount, 0);
  assert.ok(cover.modalCount >= 1);
  for (const decision of [
    decide(screen, [target('qa-promo-home-field', 'fill', 23)], 'surface'),
    decide(screen, [target('qa-promo-home-target', 'wait', 23, { exact: 'id' })], 'covered-target'),
  ]) {
    assert.equal(decision.result, undefined);
    assert.equal(decision.records.length, 1);
    assert.equal(decision.records[0].veto, 'uncovered-target');
  }
});
