import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUNNER_LIVE_CHECK_REASONS, sentAfterUnavailableRead } from '../../../dist/qa/live-hit.js';

const WORDS = [
  'expired',
  'no-identity',
  'absent',
  'ambiguous',
  'exception',
  'deadline',
  'read-failed',
];

test('each of the runner words is read back as itself', () => {
  assert.deepEqual([...RUNNER_LIVE_CHECK_REASONS], WORDS);
  for (const word of WORDS) {
    assert.deepEqual(
      sentAfterUnavailableRead({ occlusionCheck: 'unavailable', liveCheckReason: word }),
      { reason: word, reported: 'word' },
    );
  }
});

test('an unavailable reply without a listed word is unreported', () => {
  for (const liveCheckReason of [undefined, 7]) {
    assert.deepEqual(sentAfterUnavailableRead({ occlusionCheck: 'unavailable', liveCheckReason }), {
      reason: 'unreported',
      reported: 'none',
    });
  }
  for (const word of ['ambiguous2', 'unreported', 'Deadline', '']) {
    assert.deepEqual(
      sentAfterUnavailableRead({ occlusionCheck: 'unavailable', liveCheckReason: word }),
      { reason: 'unreported', reported: 'unlisted' },
    );
  }
});

test('nothing is read unless the reply says the check was unavailable', () => {
  for (const data of [
    { occlusionCheck: 'hit-tested', liveCheckReason: 'deadline' },
    { liveCheckReason: 'deadline' },
    {},
    null,
    undefined,
    'unavailable',
    3,
  ]) {
    assert.equal(sentAfterUnavailableRead(data), undefined, JSON.stringify(data));
  }
});
