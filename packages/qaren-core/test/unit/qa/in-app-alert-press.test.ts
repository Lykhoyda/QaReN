import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join as joinScreen, type Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const app = { x: 0, y: 0, width: 400, height: 800 };

function wizard(
  alert: boolean,
  title = 'New task',
  behind = true,
  keyboard = false,
  alertType = 'Element(7)',
): Screen {
  const nodes = [
    { ref: '@app', index: 0, type: 'Application', label: 'Tasks app', rect: app },
    { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect: app },
    {
      ref: '@title',
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: title,
      rect: { x: 20, y: 80, width: 300, height: 30 },
    },
    {
      ref: '@save',
      index: 3,
      parentIndex: 1,
      type: 'Button',
      label: 'Save',
      hittable: !alert,
      rect: { x: 20, y: 700, width: 360, height: 44 },
    },
    ...(alert
      ? [
          {
            ref: '@alertWin',
            index: 4,
            parentIndex: 0,
            type: 'Window',
            label: 'Discard changes?',
            rect: app,
          },
          {
            ref: '@alert',
            index: 5,
            parentIndex: 4,
            type: alertType,
            label: 'Discard changes?',
            rect: { x: 60, y: 300, width: 280, height: 160 },
          },
          {
            ref: '@message',
            index: 6,
            parentIndex: 5,
            type: 'StaticText',
            label: 'Discard changes?',
            rect: { x: 80, y: 320, width: 240, height: 30 },
          },
          {
            ref: '@cancel',
            index: 7,
            parentIndex: 5,
            type: 'Button',
            label: 'Cancel',
            hittable: true,
            rect: { x: 60, y: 400, width: 140, height: 44 },
          },
          {
            ref: '@discard',
            index: 8,
            parentIndex: 5,
            type: 'Button',
            label: 'Discard',
            hittable: true,
            rect: { x: 200, y: 400, width: 140, height: 44 },
          },
        ]
      : []),
    ...(keyboard
      ? [
          { ref: '@kbWin', index: 9, parentIndex: 0, type: 'Window', rect: app },
          {
            ref: '@suggestion',
            index: 10,
            parentIndex: 9,
            type: 'StaticText',
            label: 'Groceries',
            rect: { x: 0, y: 460, width: 130, height: 40 },
          },
          {
            ref: '@kb',
            index: 11,
            parentIndex: 9,
            type: 'Keyboard',
            rect: { x: 0, y: 500, width: 400, height: 300 },
          },
          {
            ref: '@q',
            index: 12,
            parentIndex: 11,
            type: 'Key',
            label: 'q',
            hittable: true,
            rect: { x: 0, y: 520, width: 40, height: 50 },
          },
        ]
      : []),
  ];
  const kept = behind ? nodes : nodes.filter((n) => n.parentIndex !== 1);
  const position = new Map(kept.map((n, i) => [n.index, i]));
  const captured = joinScreen(
    kept.map((n) => ({
      ...n,
      index: position.get(n.index)!,
      ...(n.parentIndex === undefined ? {} : { parentIndex: position.get(n.parentIndex) }),
    })),
    [],
  );
  return { ...captured, coverage: { native: 'complete', react: 'complete' } };
}

const noJudge = scriptedJudge(() => {
  throw new Error('an exact label needs no judge');
});

function plan(markdown: string) {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks[0];
}

test('an in-app alert button whose tap only closes the alert is not proven', async () => {
  const f = walker([wizard(true), wizard(false)], noJudge, { ok: true, proven: false });
  const outcome = await walkBlock(plan('1. Tap "Discard"'), f.deps);
  assert.deepEqual(f.actions, ['press @discard']);
  const row = outcome.rows.find((r) => r.line === 1);
  assert.equal(row?.outcome, 'pass');
  assert.match(
    row?.reason ?? '',
    /^UNVERIFIED_PRESS: the alert or sheet closed and nothing behind it changed;/,
  );
});

test('an in-app alert button whose tap also changes the app behind it passes proven', async () => {
  const f = walker([wizard(true), wizard(false, 'Tasks')], noJudge, { ok: true, proven: false });
  const outcome = await walkBlock(plan('1. Tap "Discard"'), f.deps);
  const row = outcome.rows.find((r) => r.line === 1);
  assert.equal(row?.outcome, 'pass');
  assert.equal(row?.reason, undefined);
});

test('an ordinary press that changes the screen still passes without a mark', async () => {
  const f = walker([wizard(false), wizard(false, 'Tasks')], noJudge, { ok: true, proven: false });
  const outcome = await walkBlock(plan('1. Tap "Save"'), f.deps);
  const row = outcome.rows.find((r) => r.line === 1);
  assert.equal(row?.outcome, 'pass');
  assert.equal(row?.reason, undefined);
});

test('an in-app alert that hid the app behind it leaves its button press unverified', async () => {
  const f = walker([wizard(true, 'New task', false), wizard(false, 'Tasks')], noJudge, {
    ok: true,
    proven: false,
  });
  const outcome = await walkBlock(plan('1. Tap "Discard"'), f.deps);
  const row = outcome.rows.find((r) => r.line === 1);
  assert.equal(row?.outcome, 'pass');
  assert.match(
    row?.reason ?? '',
    /^UNVERIFIED_PRESS: nothing behind the alert or sheet was captured /,
  );
});

test('a keyboard returning after the alert closes does not prove its button press', async () => {
  const f = walker([wizard(true), wizard(false, 'New task', true, true)], noJudge, {
    ok: true,
    proven: false,
  });
  const outcome = await walkBlock(plan('1. Tap "Discard"'), f.deps);
  const row = outcome.rows.find((r) => r.line === 1);
  assert.equal(row?.outcome, 'pass');
  assert.match(row?.reason ?? '', /^UNVERIFIED_PRESS: /);
});

test('a proven in-app alert button press passes without a mark', async () => {
  const f = walker([wizard(true), wizard(false)], noJudge, { ok: true, proven: true });
  const outcome = await walkBlock(plan('1. Tap "Discard"'), f.deps);
  const row = outcome.rows.find((r) => r.line === 1);
  assert.equal(row?.outcome, 'pass');
  assert.equal(row?.reason, undefined);
});

test('an action sheet button whose tap only closes the sheet is not proven', async () => {
  const f = walker([wizard(true, 'New task', true, false, 'Element(5)'), wizard(false)], noJudge, {
    ok: true,
    proven: false,
  });
  const outcome = await walkBlock(plan('1. Tap "Discard"'), f.deps);
  assert.deepEqual(f.actions, ['press @discard']);
  const row = outcome.rows.find((r) => r.line === 1);
  assert.equal(row?.outcome, 'pass');
  assert.match(row?.reason ?? '', /^UNVERIFIED_PRESS: /);
});
