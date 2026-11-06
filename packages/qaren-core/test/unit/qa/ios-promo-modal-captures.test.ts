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
import { hostAssociationIdentity, join, type Screen } from '../../../dist/qa/screen.js';

// Real iOS 26.5 captures of a full-screen React Native Modal promo (heading, copy, one Close)
// presented over a mounted Home screen: the exact join() arguments the device produced.
function capture(name: string): Screen {
  const { joinArgs: a } = JSON.parse(
    readFileSync(new URL(`../../fixtures/ios-promo-modal/${name}.json`, import.meta.url), 'utf8'),
  );
  return join(
    a.nodes,
    a.digest,
    a.front,
    a.coverage,
    a.reactHostEvidence,
    a.nativePresence,
    a.nativeAcquisition,
  );
}

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

for (const name of ['wait-first-presence', 'check-first-presence']) {
  test(`device ${name}: the Close inside the presented modal associates despite covered React ancestors`, () => {
    const screen = capture(name);
    const close = screen.elements.find((e) => e.testID === 'qa-promo-close')!;
    assert.equal(hostAssociationIdentity(close), 'matched');
    assert.equal(screen.pressGapCount, 0);
    assert.equal(screen.pressEvidenceGap, undefined);
    assert.equal(soleDecline(screen), true);
  });
}

test('device wait-first: a React-only target behind the promo is proven covered and Close is chosen', () => {
  const screen = capture('wait-first-presence');
  const wait = target('qa-promo-home-target', 'wait', 12, { exact: 'id' });
  assert.equal(targetBehindInterruption(screen, wait), true);
  const { result, records } = decide(screen, [wait], 'covered-target');
  assert.deepEqual(result, { label: 'Close' });
  assert.deepEqual(records, []);
});

test('device promo: a missing target behind the presented modal may still close it', () => {
  const { result } = decide(
    capture('wait-first-presence'),
    [target('qa-not-mounted', 'press', 12, { exact: 'id' })],
    'surface',
  );
  assert.deepEqual(result, { label: 'Close' });
});

test('device check-first: a later tap matching the promo copy no longer keeps the sole Close up', () => {
  const { result, records } = decide(capture('check-first-presence'), [
    target('Target taps: 0', 'check', 11),
    target('qa-promo-home-target', 'press', 12),
    target('See Pro offers', 'press', 13),
  ]);
  assert.deepEqual(result, { label: 'Close' });
  assert.deepEqual(records, []);
});

test('device wait-first: a target that is not mounted is never treated as covered', () => {
  const screen = capture('wait-first-presence');
  const { result, records } = decide(
    screen,
    [target('qa-promo-form-submit', 'wait', 19, { exact: 'id' })],
    'covered-target',
  );
  assert.equal(result, undefined);
  assert.equal(records[0].veto, 'uncovered-target');
});

test('device tap-first: the ordinary press capture carries no association to prove the cover', () => {
  const screen = capture('tap-first-press');
  assert.equal(
    targetBehindInterruption(screen, target('qa-promo-home-target', 'press', 11, { exact: 'id' })),
    false,
  );
});
