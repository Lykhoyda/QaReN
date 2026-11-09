import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dismissCandidate } from '../../../dist/qa/recover.js';
import { join } from '../../../dist/qa/screen.js';
import { createWriter } from '../../../dist/qa/wire.js';
import type { InterruptionDiagnostic } from '../../../dist/qa/recover.js';
import { element, screen } from './judgment-fixtures.ts';

const targets = [{ phrase: '"Private target"', quoted: 'Private target' }];
// Control-count evidence with no gaps; each record overrides what its screen lacks.
const provenCount = {
  evidenceGap: false,
  pressGaps: 0,
  fillGaps: 0,
  unknownPress: 0,
  unknownFill: 0,
};

test('an interruption rejection crosses the wire in a run without inputs, value-free', () => {
  const event = {
    kind: 'interruption-rejected',
    line: 7,
    veto: 'later-target',
    targetIndex: 1,
    exactDeclineCount: 2,
  };
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'interruption-test');
  writer.diagnostic({ ...event, label: 'Close' });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).payload, event);
  assert.doesNotMatch(lines[0], /Close/);
});

function observed(labels: string[]) {
  return join(
    labels.map((label, index) => ({
      ref: `@e${index}`,
      type: 'Button',
      label,
      hittable: true,
    })),
    [],
    'app',
    { native: 'complete', react: 'complete' },
  );
}

test('a rejected interruption crosses the wire on a run with no inputs', () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'interruption-run');
  writer.diagnostic({
    kind: 'interruption-rejected',
    line: 11,
    veto: 'later-target',
    targetIndex: 2,
    exactDeclineCount: 1,
  });
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).payload),
    [
      {
        kind: 'interruption-rejected',
        line: 11,
        veto: 'later-target',
        targetIndex: 2,
        exactDeclineCount: 1,
      },
    ],
  );
});

test('ineligible decline emits one value-free record with the first failed predicate', () => {
  const logs: unknown[] = [];
  const control = element('@private', 'Skip');
  control.testID = 'private-id';
  control.hittable = false;
  control.disabled = true;
  assert.equal(
    dismissCandidate(screen([control]), targets, (record) => logs.push(record)),
    undefined,
  );
  assert.deepEqual(logs, [
    {
      veto: 'no-candidate',
      soleDecline: true,
      exactDeclineCount: 1,
      controls: { ...provenCount, controls: 1 },
      elements: [{ index: 0, failed: 'not-hittable' }],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /private|Skip|@/);
});

test('a later target veto reports only its index and successful selection emits nothing', () => {
  const logs: unknown[] = [];
  const snapshot = observed(['Close', 'Private target']);
  const planTargets = [{ phrase: '"Absent"', quoted: 'Absent' }, ...targets];
  assert.equal(
    dismissCandidate(snapshot, planTargets, (record) => logs.push(record)),
    undefined,
  );
  assert.deepEqual(logs, [
    {
      veto: 'later-target',
      targetIndex: 1,
      provenance: 'presence',
      soleDecline: false,
      exactDeclineCount: 1,
      // join() without React host evidence leaves the control count unproven.
      controls: { ...provenCount, evidenceGap: true },
      elements: [],
    },
  ]);
  logs.length = 0;
  assert.deepEqual(
    dismissCandidate(screen([element('@private', 'Close')]), targets, (record) =>
      logs.push(record),
    ),
    { label: 'Close' },
  );
  assert.deepEqual(logs, []);
});

test('front, coverage and current-target vetoes use fixed categories and a broken sink changes nothing', () => {
  for (const [snapshot, veto] of [
    [{ ...screen([]), front: 'dialog' }, 'front'],
    [{ ...screen([]), coverage: { native: 'unknown', react: 'complete' } }, 'coverage'],
    [observed(['Private target']), 'current-target'],
  ] as const) {
    const logs: InterruptionDiagnostic[] = [];
    assert.equal(
      dismissCandidate(snapshot, targets, (record) => logs.push(record)),
      undefined,
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0].veto, veto);
    assert.equal(
      dismissCandidate(snapshot, targets, () => {
        throw new Error('private sink error');
      }),
      undefined,
    );
  }
});

test('press rejection exposes existing host identity without exporting host content', () => {
  const rect = { x: 0, y: 0, width: 400, height: 800 };
  const nodes = [
    { ref: '@private-app', type: 'Application', rect },
    { ref: '@private-window', type: 'Window', rect, parentIndex: 0 },
    {
      ref: '@private-control',
      type: 'Other',
      identifier: 'private-id',
      label: 'Skip',
      hittable: true,
      rect: { x: 20, y: 20, width: 100, height: 40 },
      parentIndex: 1,
    },
  ];
  const snapshot = join(
    nodes,
    [],
    'app',
    { native: 'complete', react: 'complete' },
    {
      complete: true,
      hosts: [
        { testID: 'private-id', role: null, roleSource: 'none', capabilities: { press: true } },
      ],
    },
    {
      source: 'xcui-live',
      nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
    },
  );
  const logs: InterruptionDiagnostic[] = [];
  assert.equal(
    dismissCandidate(snapshot, targets, (record) => logs.push(record)),
    undefined,
  );
  assert.deepEqual(logs, [
    {
      veto: 'no-candidate',
      soleDecline: false,
      exactDeclineCount: 1,
      controls: { ...provenCount, evidenceGap: true, pressGaps: 1, unknownPress: 1 },
      elements: [{ index: 2, failed: 'press-not-supported', association: 'evidence-unavailable' }],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /private|Skip|@/);
});
