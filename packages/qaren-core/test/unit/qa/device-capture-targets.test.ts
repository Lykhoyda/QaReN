// Replays of the exact join() arguments recorded on an iOS device at two quoted taps (Test App
// a7299ee, iOS 26.5). Both are ordinary press captures, the capture mode every quoted target takes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coverOwner, prepareTarget } from '../../../dist/qa/resolve.js';
import { join, touchOwnerAt } from '../../../dist/qa/screen.js';
import type { Screen } from '../../../dist/qa/screen.js';

function replay(name: string): Screen {
  const { joinArgs: a } = JSON.parse(
    readFileSync(new URL(`../../fixtures/device-captures/${name}.json`, import.meta.url), 'utf8'),
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

const tap = (quoted: string) => ({
  kind: 'press' as const,
  target: { phrase: quoted, quoted },
});

test('device C1: the covered row names no cover and says the capture carried no native presence', () => {
  const screen = replay('c1-header-inset-line41-obs26-press');
  const row = screen.elements.find((e) => e.testID === 'qa-hi-row-1');
  assert.ok(row, 'the covered row is a native element of the capture');
  // Its centre, 201,283, lies under the sticky cover; no React host can be tied to a native node here.
  assert.equal(touchOwnerAt(screen, 201, 283), 'no-native-presence');
  assert.deepEqual(coverOwner(row, screen), { gap: 'no-native-presence' });
  // The sticky cover is in the same capture, so a presence recapture is what can name it.
  assert.ok(screen.elements.some((e) => e.testID === 'qa-hi-cover'));
});

test('device N1: only the inner Close is native, so the tap resolves to it without a collapse', () => {
  const screen = replay('n1-nested-close-line36-obs22-press');
  // The 185x56 container labelled Close exists only as a React host with no native node.
  assert.equal(
    screen.elements.filter(
      (e) => e.testID === 'qa-nested-close-container' && !e.ref.startsWith('react:'),
    ).length,
    0,
  );
  const result = prepareTarget(tap('Close'), screen);
  assert.ok('ref' in result, JSON.stringify(result));
  assert.equal(result.element.testID, 'qa-nested-close-x');
  assert.equal(result.collapsed, undefined);
  assert.equal(result.candidateExclusions, undefined);
});
