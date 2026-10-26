import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isInViewport, decideScrollDirection } from '../../../dist/handlers/device-interact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEVICE_INTERACT_PATH = resolve(__dirname, '../../../src/handlers/device-interact.ts');

// Task 7 (GH #105 / rn-device iOS-MVP): TS implementation of `scrollintoview`
// orchestration. Pure rect-intersection helpers used by device_scrollintoview
// after we drop the external CLI's stateful scroll loop.
//
// isInViewport(element, screen): element fully or partially intersects screen.
// decideScrollDirection(element, screen): returns the swipe direction that
//   should bring `element` into the screen, or null when already visible.
//
// Convention (matches XCUI / iOS pixel coords):
//   - screen rect = current viewport (typically anchored at origin).
//   - "swipe up"   reveals content BELOW the viewport (finger up → content up).
//   - "swipe down" reveals content ABOVE the viewport.
//   - "swipe left" reveals content to the RIGHT of the viewport.
//   - "swipe right" reveals content to the LEFT of the viewport.

const screen = { x: 0, y: 0, width: 393, height: 852 };

test('isInViewport: visible element returns true', () => {
  const visible = { x: 16, y: 100, width: 361, height: 44 };
  assert.equal(isInViewport(visible, screen), true);
});

test('isInViewport: element fully below viewport returns false', () => {
  const belowFold = { x: 16, y: 1000, width: 361, height: 44 };
  assert.equal(isInViewport(belowFold, screen), false);
});

test('decideScrollDirection: returns null when element already visible', () => {
  const visible = { x: 16, y: 100, width: 361, height: 44 };
  assert.equal(decideScrollDirection(visible, screen), null);
});

test('decideScrollDirection: element below viewport → swipe up to reveal', () => {
  const belowFold = { x: 16, y: 1000, width: 361, height: 44 };
  assert.equal(decideScrollDirection(belowFold, screen), 'up');
});

test('decideScrollDirection: element above viewport → swipe down to reveal', () => {
  // Negative y → element scrolled past top edge. Swipe-down (finger top-to-
  // bottom) drags content back down into view.
  const aboveTop = { x: 16, y: -200, width: 361, height: 44 };
  assert.equal(decideScrollDirection(aboveTop, screen), 'down');
});

test('scrollintoview: Android runner env uses snapshot/swipe orchestrator', async () => {
  const previous = process.env.RN_ANDROID_RUNNER;
  delete process.env.RN_ANDROID_RUNNER;
  try {
    const source = readFileSync(DEVICE_INTERACT_PATH, 'utf8');
    assert.match(source, /session\?\.platform === ['"]android['"]/);
    assert.match(source, /RN_ANDROID_RUNNER !== ['"]0['"]/);
    assert.doesNotMatch(source, /runAgentDevice\(\[['"]scrollintoview['"]/);
  } finally {
    if (previous === undefined) delete process.env.RN_ANDROID_RUNNER;
    else process.env.RN_ANDROID_RUNNER = previous;
  }
});
