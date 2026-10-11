// A dialog step passes on the runner's proof of the tapped button, and an unproven tap never retries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';

const RECT = { x: 57, y: 494, width: 140, height: 48 };

function screen(title = 'Notifications'): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@title',
      index: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: title,
      rect: { x: 20, y: 100, width: 200, height: 30 },
    },
  ];
  return { ...join(nodes, []), coverage: { native: 'complete', react: 'complete' } };
}

function fake(dialog: ActResult, changes = false) {
  const calls: string[] = [];
  const notes: string[] = [];
  let clock = 0;
  const deps: WalkerDeps = {
    async captureScreen() {
      return screen(changes && calls.length > 0 ? 'Reminder set' : 'Notifications');
    },
    async press() {
      return { ok: true, proven: false };
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
    async dialog(action, context) {
      context.authorize();
      calls.push(action);
      return dialog;
    },
    async screenshot(name) {
      return name;
    },
    note: (line) => notes.push(line),
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => undefined,
  };
  return { deps, calls, notes };
}

const block = () => parsePlan('1. Dismiss the permission dialog\n').blocks![0];

test('a proven dismissal passes on an unchanged screen and records the tapped label and frame', async () => {
  const f = fake({ ok: true, proven: true, dialog: { label: 'Don’t Allow', rect: RECT } });
  const outcome = await walkBlock(block(), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(f.calls, ['dismiss']);
  assert.deepEqual(outcome.rows[0].dialog, { label: 'Don’t Allow', rect: RECT });
  assert.ok(f.notes.some((line) => line.startsWith('dialog-tap ') && line.includes('Don’t Allow')));
});

test('an unproven dialog tap fails with its reason and is never retried', async () => {
  const f = fake({
    ok: false,
    proven: false,
    mutation: 'observed',
    error: 'DIALOG_TAP_UNPROVEN: "Don’t Allow" was tapped but the alert stayed open',
  });
  const outcome = await walkBlock(block(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(f.calls, ['dismiss']);
  assert.match(outcome.failure?.seen ?? '', /^DIALOG_TAP_UNPROVEN: .*stayed open/);
});

test('a dialog tap without proof needs a screen change to pass', async () => {
  const f = fake({ ok: true, proven: false });
  const outcome = await walkBlock(block(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(outcome.rows.at(-1)?.dialog, undefined);
});

test('an unproven dialog tap fails even when the screen changed', async () => {
  const f = fake(
    {
      ok: false,
      proven: false,
      mutation: 'observed',
      error:
        'DIALOG_TAP_UNPROVEN: the runner did not prove it tapped the "Don\u2019t Allow" button',
    },
    true,
  );
  const outcome = await walkBlock(block(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(f.calls, ['dismiss']);
  assert.match(outcome.failure?.seen ?? '', /^DIALOG_TAP_UNPROVEN: /);
});
