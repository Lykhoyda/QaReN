import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  completeCapture,
  controlEvidence,
  dismissCandidate,
  optInShaped,
  type InterruptionDiagnostic,
} from '../../../dist/qa/recover.js';
import { modalCoverDiagnostic } from '../../../dist/qa/screen.js';
import { replayCapture } from './ios-capture-replay.ts';

// Recovery's presence read in the captured run while its line 39 ("Wait for "Home ready" to
// appear") waited behind a reminders opt-in Modal that opened on its own; on the device it
// declined with "Not now" (@e14).
test('a real iOS opt-in Modal that opens on its own counts two controls and is declined as a permission opt-in', () => {
  const s = replayCapture(
    new URL('../../fixtures/ios-optin-modal/launch-presence.json', import.meta.url),
  );
  assert.equal(s.front, 'app');
  assert.equal(completeCapture(s), true);
  assert.deepEqual(modalCoverDiagnostic(s), {
    modalCount: 1,
    associatedCount: 3,
    associatedOutside: 0,
    modalTypes: ['RCTModalHostView'],
    identities: { 'no-test-id': 27, 'native-id-count': 3, matched: 3 },
  });
  const counted = controlEvidence(s);
  assert.deepEqual(counted.evidence, {
    evidenceGap: false,
    pressGaps: 0,
    fillGaps: 0,
    unknownPress: 0,
    unknownFill: 0,
    controls: 2,
  });
  assert.deepEqual(
    counted.controls?.map((e) => [e.ref, e.label]),
    [
      ['@e13', 'Turn on notifications'],
      ['@e14', 'Not now'],
    ],
  );
  assert.equal(optInShaped(s)?.ref, '@e14');
  const rejected: InterruptionDiagnostic[] = [];
  const wait = { phrase: 'Home ready', quoted: 'Home ready', kind: 'wait' as const, line: 39 };
  // A wait that times out on an unchanged screen recovers with absent-surface proof.
  assert.deepEqual(
    dismissCandidate(s, [wait], (r) => rejected.push(r), 'absent-surface'),
    { label: 'Not now', screenClass: 'permission-opt-in' },
  );
  assert.deepEqual(rejected, []);
});
