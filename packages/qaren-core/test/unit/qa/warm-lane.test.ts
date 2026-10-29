import { firstScreenFacts, warmLaneRefusal } from '../../../dist/qa/warm-lane.js';
import assert from 'node:assert/strict';
import test from 'node:test';

type Screen = Parameters<typeof warmLaneRefusal>[0];
const screen = (overrides: Partial<Screen> = {}): Screen => ({
  elements: [],
  visibleText: ['Sign in'],
  front: 'app',
  coverage: { native: 'complete', react: 'complete' },
  ...overrides,
});

test('an app in front with text is a warm first screen', () => {
  assert.equal(warmLaneRefusal(screen()), undefined);
  assert.equal(warmLaneRefusal(screen({ visibleText: [], labelText: ['Menu'] })), undefined);
});

test('a covered, backgrounded or textless first screen refuses the leg', () => {
  assert.match(warmLaneRefusal(screen({ front: 'dev-menu' })) ?? '', /covered by a dev-menu/);
  assert.match(
    warmLaneRefusal(
      screen({ nativeCaptureCauses: ['presence-failure=initial-eligibility:ineligible'] }),
    ) ?? '',
    /not in the foreground/,
  );
  assert.match(warmLaneRefusal(screen({ visibleText: [] })) ?? '', /no text was observed/);
});

test('a first screen whose native capture is not complete is unproven, not warm', () => {
  for (const native of ['incomplete', 'unknown'] as const)
    assert.match(
      warmLaneRefusal(screen({ coverage: { native, react: 'complete' } })) ?? '',
      new RegExp(`native capture of the first screen is ${native}`),
    );
  assert.match(warmLaneRefusal(screen({ coverage: undefined })) ?? '', /is unknown/);
});

test('the recorded facts carry counts, never screen text', () => {
  const facts = firstScreenFacts(screen({ visibleText: ['secret@example.com', 'Next'] }));
  assert.equal(facts, 'front app, 2 text item(s), native coverage complete');
});
