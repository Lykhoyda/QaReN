import { renderReason } from '../../../dist/qa/untrusted.js';
// A control whose only visible change is its selected state proves its press by that change alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join, screenSignature } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';

function chips(selected: 'Male' | 'Female' | undefined): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@win',
      index: 1,
      parentIndex: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    ...(['Male', 'Female'] as const).map((label, i) => ({
      ref: `@${label.toLowerCase()}`,
      index: 2 + i,
      parentIndex: 1,
      type: 'Button',
      label,
      identifier: `gender_${label === 'Male' ? 'm' : 'f'}`,
      hittable: true,
      rect: { x: 20 + i * 180, y: 300, width: 160, height: 44 },
      ...(selected === label ? { selected: true } : {}),
    })),
  ];
  return { ...join(nodes, []), coverage: { native: 'complete', react: 'complete' } };
}

function fake(screens: Screen[], press: ActResult[] = []) {
  const calls: string[] = [];
  const queue = [...screens];
  let clock = 0;
  const deps: WalkerDeps = {
    async captureScreen() {
      calls.push('capture');
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return press.shift() ?? { ok: true, proven: false };
    },
    async fill() {
      return { ok: true, proven: true };
    },
    async scroll() {
      return { ok: true, proven: false };
    },
    async back() {
      return { ok: true, proven: false };
    },
    async dialog() {
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => undefined,
  };
  return { deps, calls };
}

const block = (markdown: string) => parsePlan(markdown).blocks![0];

test('a selection change alone changes the screen signature', () => {
  assert.notEqual(screenSignature(chips(undefined)), screenSignature(chips('Male')));
  assert.equal(screenSignature(chips('Male')), screenSignature(chips('Male')));
});

test('a press whose only effect is selecting the chip passes on its first attempt', async () => {
  const f = fake([chips(undefined), chips('Male')]);
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 1);
});

test('a press on an already selected chip proves nothing and fails with its selection before and after', async () => {
  const f = fake([chips('Male')]);
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 2);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /the target stayed selected/,
  );
});

test('a press on a control never reported selected fails with the reason it had before', async () => {
  const f = fake([chips(undefined)]);
  const outcome = await walkBlock(block('1. Tap "gender_m"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.doesNotMatch(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /selected/,
  );
});
