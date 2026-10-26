import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputIndicatesFlowFailure } from '../../dist/domain/maestro-error-parser.js';

// GH#249/B193: the exit-0 secondary guard was `output.includes('FAILED')` over combined
// stdout+stderr — which contains app/console logs, so a passing flow whose app merely
// logged the substring (FETCH_FAILED, LOGIN_FAILED, ...) was flagged failed and kicked
// off pointless auto-repair. The guard must key on Maestro's own terminal status LINES.
// (maestro-runner emits no uppercase FAILED at all — verified against the binary — so
// the token only ever comes from the JVM Maestro fallback, e.g. the 'Test FAILED' line
// already pinned in maestro-error-parser.test.js.)

test('#249 matches Maestro terminal status lines', () => {
  assert.equal(outputIndicatesFlowFailure('Test FAILED'), true);
  assert.equal(outputIndicatesFlowFailure('[INFO] Tapping on "ok"\nTest FAILED\n'), true);
  assert.equal(outputIndicatesFlowFailure('Flow FAILED'), true);
  assert.equal(outputIndicatesFlowFailure('[FAILED] Tap on element with id "submit"'), true);
  assert.equal(outputIndicatesFlowFailure('  FAILED  '), true); // bare status line, indented
});

test('#249 does NOT match app/console log content that merely contains the substring', () => {
  assert.equal(outputIndicatesFlowFailure('[INFO] dispatching action FETCH_FAILED'), false);
  assert.equal(
    outputIndicatesFlowFailure('console.log: USER_REGISTRATION_FAILED event sent'),
    false,
  );
  assert.equal(
    outputIndicatesFlowFailure('2026-06-10 12:00:01 upload FAILED midway, retrying'),
    false,
  );
  assert.equal(outputIndicatesFlowFailure('FAILED to fetch user profile'), false); // line-leading but prose, not a status line
  assert.equal(outputIndicatesFlowFailure('All steps passed'), false);
  assert.equal(outputIndicatesFlowFailure(''), false);
});
