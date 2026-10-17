// Scroll-until direction: a target covered inside the viewport scrolls toward revealing it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStep } from '../../../dist/qa/plan.js';
import { scrollUntilDirection } from '../../../dist/qa/resolve.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';

// `up` drags the finger top-to-bottom and reveals content above; `down` reveals content below.
const VIEWPORT = { x: 0, y: 0, width: 1080, height: 2400 };

function welcome(y: number, height: number, visibleToUser: boolean, index = 3): NativeNode {
  return {
    ref: `@welcome-${index}`,
    index,
    parentIndex: 2,
    type: 'StaticText',
    label: 'Welcome',
    hittable: visibleToUser,
    visibleToUser,
    rect: { x: 37, y, width: 1006, height },
  };
}

function observed(targets: NativeNode[]): Screen {
  return join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: VIEWPORT },
      { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect: VIEWPORT },
      { ref: '@scroll', index: 2, parentIndex: 1, type: 'ScrollView', rect: VIEWPORT },
      ...targets,
    ],
    [],
  );
}

function until(line: string) {
  const parsed = parseStep(line);
  assert.ok(parsed && !('refuse' in parsed) && parsed.kind === 'scroll' && parsed.until);
  return { target: parsed.until, direction: parsed.direction };
}

const plans = ['Scroll up until "Welcome"', 'Scroll down until "Welcome"'];

test('a target covered in the upper part of the viewport scrolls up whatever the plan says', () => {
  for (const y of [0, -20, 600]) {
    const screen = observed([welcome(y, 34, false)]);
    assert.equal(screen.elements[3].offscreen, true);
    for (const line of plans) {
      const { target, direction } = until(line);
      assert.equal(scrollUntilDirection(target, screen, direction), 'up', `${line} at ${y}`);
    }
  }
});

test('a target covered in the lower part of the viewport scrolls down whatever the plan says', () => {
  for (const y of [2366, 2380, 1600]) {
    const screen = observed([welcome(y, 34, false)]);
    assert.equal(screen.elements[3].offscreen, true);
    for (const line of plans) {
      const { target, direction } = until(line);
      assert.equal(scrollUntilDirection(target, screen, direction), 'down', `${line} at ${y}`);
    }
  }
});

test('a target fully above or below the viewport keeps scrolling toward its side', () => {
  for (const [y, expected] of [
    [-100, 'up'],
    [2500, 'down'],
  ] as const) {
    const screen = observed([welcome(y, 34, false)]);
    for (const line of plans) {
      const { target, direction } = until(line);
      assert.equal(scrollUntilDirection(target, screen, direction), expected, `${line} at ${y}`);
    }
  }
});

test('no single resolved target follows the plan direction', () => {
  const none = observed([]);
  const twins = observed([welcome(0, 34, false), welcome(2366, 34, false, 4)]);
  for (const screen of [none, twins])
    for (const line of plans) {
      const { target, direction } = until(line);
      assert.equal(scrollUntilDirection(target, screen, direction), direction, line);
    }
});

test('a visible target follows the plan direction', () => {
  for (const y of [0, 2366]) {
    const screen = observed([welcome(y, 34, true)]);
    assert.equal(screen.elements[3].offscreen, false);
    for (const line of plans) {
      const { target, direction } = until(line);
      assert.equal(scrollUntilDirection(target, screen, direction), direction, `${line} at ${y}`);
    }
  }
});
