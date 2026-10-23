import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../dist/qa/plan.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import type { Block } from '../../../dist/qa/plan.js';
import type { Element, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import type { LedgerRow } from '../../../dist/qa/ledger.js';

function screen(
  labels: string[],
  front: Screen['front'] = 'app',
  testIDs: Record<string, string> = {},
): Screen {
  return {
    elements: labels.map((label, i) => ({
      ref: `@e${i}`,
      kind: 'button',
      label,
      ...(testIDs[label] ? { testID: testIDs[label] } : {}),
      hittable: true,
      disabled: false,
      secure: false,
      offscreen: false,
      semantic: {
        press: 'supported',
        fill: 'unsupported',
        visibility: 'visible',
      },
      where: 'middle',
      side: 'center',
    })),
    visibleText: labels,
    front,
    coverage: { native: 'complete', react: 'complete' },
  };
}

// The app's React digest does not change under a system prompt, so its testIDs stay on screen as React-only, offscreen elements.
const reactOnly: Element = {
  ref: 'react:notif-remind-1m',
  kind: 'button',
  testID: 'notif-remind-1m',
  hittable: false,
  disabled: false,
  secure: false,
  offscreen: true,
  semantic: { press: 'unknown', fill: 'unknown', visibility: 'unknown' },
};

function underPrompt(): Screen {
  const prompt = screen(['Allow'], 'dialog');
  return { ...prompt, elements: [...prompt.elements, reactOnly] };
}

function fake(
  screens: Screen[],
  press: ActResult = { ok: true, proven: false },
): { deps: WalkerDeps; rows: LedgerRow[]; calls: string[] } {
  const rows: LedgerRow[] = [];
  const calls: string[] = [];
  let clock = 0;
  const queue = [...screens];
  const ok: ActResult = { ok: true, proven: false };
  const deps: WalkerDeps = {
    async captureScreen() {
      calls.push('capture');
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return press;
    },
    async fill(ref, text) {
      calls.push(`fill ${ref} ${text}`);
      return { ok: true, proven: true };
    },
    async scroll(direction) {
      calls.push(`scroll ${direction}`);
      return ok;
    },
    async back() {
      calls.push('back');
      return ok;
    },
    async dialog(action) {
      calls.push(`dialog ${action}`);
      return { ok: true, proven: true };
    },
    async hideDevMenu() {
      calls.push('hideDevMenu');
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: (row) => {
      rows.push(row);
    },
  };
  return { deps, rows, calls };
}

function block(markdown: string): Block {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks[0];
}

const sent = (calls: string[]) => calls.filter((c) => c !== 'capture');

test('an app element behind a system dialog is not scrolled to; the dialog is recovered and the step retried', async () => {
  const f = fake([
    underPrompt(),
    underPrompt(),
    screen(['Remind'], 'app', { Remind: 'notif-remind-1m' }),
    screen(['Reminder set']),
  ]);
  const outcome = await walkBlock(block('1. Tap "notif-remind-1m"\n'), f.deps);
  assert.deepEqual(sent(f.calls), ['dialog dismiss', 'press @e0']);
  assert.equal(outcome.recoveries, 1);
  assert.match(
    renderReason(outcome.rows[0].reason ?? '', (text) => text),
    /TARGET_NOT_FOUND.*system dialog.*recovered: dialog/,
  );
});

for (const [plan, verb] of [
  ['1. Scroll down\n', 'scroll down'],
  ['1. Back\n', 'back'],
] as const) {
  test(`a ${verb} step is not sent while a system dialog is in front`, async () => {
    const f = fake([
      screen(['Allow'], 'dialog'),
      screen(['Allow'], 'dialog'),
      screen(['Settings']),
      screen(['Profile']),
    ]);
    const outcome = await walkBlock(block(plan), f.deps);
    const calls = sent(f.calls);
    assert.equal(calls[0], 'dialog dismiss');
    assert.deepEqual(calls, ['dialog dismiss', verb]);
    assert.equal(outcome.recoveries, 1);
  });
}

test('a retry that finds the prompt its step raised passes on that late effect when the next step answers it', async () => {
  const remind = screen(['Remind']);
  const set = screen(['Reminder set']);
  const prompt = screen(['Allow'], 'dialog');
  const f = fake([remind, remind, prompt, prompt, set, set]);
  const outcome = await walkBlock(block('1. Tap "Remind"\n2. Accept the system dialog\n'), f.deps);
  assert.deepEqual(sent(f.calls), ['press @e0', 'dialog accept']);
  assert.deepEqual(
    f.rows.map((row) => [row.line, row.attempt, row.outcome]),
    [
      [1, 1, 'retry'],
      [1, 2, 'pass'],
      [2, 1, 'pass'],
    ],
  );
  assert.equal(outcome.recoveries, undefined);
  assert.equal(outcome.block.outcome, 'pass');
});

test('a retry that finds a dialog with no dialog step next declines it by default and retries', async () => {
  const remind = screen(['Remind']);
  const settings = screen(['Settings']);
  const prompt = screen(['Allow'], 'dialog');
  const f = fake([remind, remind, prompt, prompt, remind, settings, settings, screen(['Profile'])]);
  const outcome = await walkBlock(block('1. Tap "Remind"\n2. Tap "Settings"\n'), f.deps);
  assert.deepEqual(sent(f.calls), ['press @e0', 'dialog dismiss', 'press @e0', 'press @e0']);
  assert.equal(outcome.recoveries, 1);
});

test('a first attempt under a dialog leaves it to the next dialog step and fails', async () => {
  const prompt = screen(['Allow'], 'dialog');
  const f = fake([prompt, prompt, prompt]);
  const outcome = await walkBlock(
    block('1. Tap "Settings"\n2. Accept the system dialog\n'),
    f.deps,
  );
  assert.ok(!f.calls.some((call) => call.startsWith('dialog ')));
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(outcome.failure?.step, 1);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /TARGET_NOT_FOUND/,
  );
  assert.equal(outcome.failure?.kind, undefined);
  assert.equal(outcome.recoveries, undefined);
});
