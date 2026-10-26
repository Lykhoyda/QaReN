import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import type { DigestEntry, NativeNode } from '../../../dist/qa/screen.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { choice, scriptedJudge } from './judgment-fixtures.ts';

async function captureRows(
  rows: Array<{
    label: string;
    type?: 'Button' | 'StaticText';
    unknown?: boolean;
    testID?: string;
  }>,
  interactive: DigestEntry[] = [],
) {
  const source = nativeCapture();
  const nodes: NativeNode[] = [source.nodes[0]];
  for (const [offset, row] of rows.entries()) {
    const index = offset + 1;
    nodes.push({
      ...source.nodes[1],
      ref: `@e${index}`,
      index,
      identifier: row.testID,
      type: row.type ?? 'StaticText',
      label: row.label,
      rect: { x: 10, y: 20 + offset * 22, width: 100, height: 20 },
      presence: {
        ...source.nodes[1].presence,
        nodeIndex: index,
        status: row.unknown ? 'unknown' : 'observed',
        observedUptimeMs: row.unknown ? undefined : 150,
      },
    });
  }
  return captureScreen({
    appId: 'com.test',
    now: () => 0,
    requirePrivateInputs: true,
    native: async () => ({
      ...source,
      nodes,
      snapshotVerdict: { ...source.snapshotVerdict, nodeCount: nodes.length },
    }),
    react: async () => ({
      interactive,
      verdict: { state: 'ok', path: 'interactive', complete: true },
      hostEvidence: { complete: true, hosts: [] },
    }),
  });
}

function waitFor(phrase: string) {
  const plan = parsePlan(`1. Wait for ${phrase}`);
  assert.ok(plan.blocks);
  const step = plan.blocks[0].items[0];
  assert.equal(step.kind, 'wait');
  if (step.kind !== 'wait') assert.fail('fixture must parse as a wait');
  assert.deepEqual(step.target, { quoted: undefined, phrase });
  return step;
}

test('an observed text witness can pass with explicit unknown siblings', async (t) => {
  const step = waitFor('receipt text');
  const positive = await captureRows([{ label: 'Receipt' }]);
  const judge = scriptedJudge(() => ({ visibility_1: { type: 'noul', noul: 0.99 } }));
  assert.deepEqual((await decideScreen(positive, judge, undefined, step)).visibility, {
    verdict: 'present',
  });
  assert.equal(judge.requests.length, 1);

  for (const label of ['Support', 'Receipt']) {
    await t.test(label === 'Receipt' ? 'same-word sibling' : 'unrelated sibling', async () => {
      const screen = await captureRows([{ label: 'Receipt' }, { label, unknown: true }]);
      assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
      assert.equal(screen.elements[1].semantic?.visibility, 'visible');
      assert.equal(screen.elements[2].semantic?.visibility, 'unknown');
      const judge = scriptedJudge((_questions, _index, state) => {
        assert.deepEqual(state, {
          front: 'app',
          assertionEvidence: {
            observed: ['Text "Receipt" (native accessibility name; platform-observed presence)'],
            unknown: [{ description: `Text "${label}"`, reason: 'visibility' }],
            unassociatedReact: 0,
            qualifiedHeadings: [],
          },
        });
        return { visibility_1: { type: 'noul', noul: 0.99 } };
      });
      const decision = await decideScreen(screen, judge, undefined, step);
      assert.deepEqual(decision.visibility, { verdict: 'present' });
      assert.equal(judge.requests.length, 1);
      assert.equal(screen.elements[2].semantic?.visibility, 'unknown');
    });
  }
});

test('checks and waits both refuse unknown-only text without an optimistic model judgment', async () => {
  const screen = await captureRows([{ label: 'Backup ready', unknown: true }]);
  assert.equal(screen.elements[1].semantic?.visibility, 'unknown');
  assert.deepEqual(screen.visibleText, ['Backup ready']);
  const judge = scriptedJudge(() => assert.fail('unknown-only content is not a positive witness'));
  const decision = await decideScreen(
    screen,
    judge,
    { kind: 'check', text: 'Backup ready is visible', literal: false, line: 1 },
    { ...waitFor('backup ready text'), line: 2 },
  );
  assert.equal(decision.visibility, undefined);
  const wait = await decideScreen(screen, judge, undefined, waitFor('backup ready text'));
  assert.deepEqual(decision.check, wait.visibility);
  assert.ok(wait.visibility && 'refuse' in wait.visibility);
  assert.equal(wait.visibility.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  assert.equal(judge.requests.length, 0);
});

test('action selection still distinguishes unrelated text from an unknown control', async (t) => {
  for (const type of ['StaticText', 'Button'] as const) {
    await t.test(type, async () => {
      const screen = await captureRows([
        { label: 'Save', type: 'Button' },
        { label: 'Save', type, unknown: true },
      ]);
      const judge = scriptedJudge((questions) => {
        assert.equal(type, 'StaticText');
        return { target_1: choice(questions.target_1) };
      });
      const decision = await decideScreen(screen, judge, undefined, {
        kind: 'press',
        target: { phrase: 'save control' },
        line: 1,
      });
      assert.ok(decision.target);
      if (type === 'Button') {
        assert.ok('refuse' in decision.target);
        assert.equal(decision.target.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
        assert.equal(judge.requests.length, 0);
      } else {
        assert.ok('ref' in decision.target);
        assert.equal(decision.target.ref, '@e1');
        assert.equal(judge.requests.length, 1);
      }
    });
  }
});

test('checks and waits cannot establish a heading from body words', async () => {
  const screen = await captureRows([{ label: 'Receipt' }]);
  const judge = scriptedJudge(() => assert.fail('body words cannot manufacture heading evidence'));
  const decision = await decideScreen(
    screen,
    judge,
    { kind: 'check', literal: false, text: 'receipt heading', line: 2 },
    waitFor('receipt heading'),
  );
  assert.deepEqual(decision.visibility, { verdict: 'pending' });
  assert.equal(decision.check, 'unsure');
  assert.equal(judge.requests.length, 0);
});

test('oversized whole claims refuse rather than combining partial group answers', async (t) => {
  for (const [phrase, first, last] of [
    ['all controls say Save', 'Save', 'Cancel'],
    ['exactly thirty Save controls', 'Save', 'Save'],
    ['no Save control', 'Cancel', 'Save'],
  ]) {
    await t.test(phrase, async () => {
      const screen = await captureRows([
        ...Array.from({ length: 30 }, () => ({ label: first, type: 'Button' as const })),
        { label: last, type: 'Button' },
      ]);
      const judge = scriptedJudge(() => assert.fail('overflow must not create partial judgments'));
      const decision = await decideScreen(
        screen,
        judge,
        { kind: 'check', literal: false, text: phrase, line: 2 },
        waitFor(phrase),
      );
      assert.equal(decision.visibility, undefined);
      const wait = await decideScreen(screen, judge, undefined, waitFor(phrase));
      assert.deepEqual(decision.check, wait.visibility);
      assert.ok(wait.visibility && 'refuse' in wait.visibility);
      assert.equal(wait.visibility.refuse, 'CANDIDATE_LIMIT');
      assert.equal(judge.requests.length, 0);
    });
  }
});

test('checks and waits judge a bounded whole claim once each using the same evidence', async (t) => {
  for (const [text, labels, noul] of [
    ['all controls say Save', ['Save', 'Cancel'], 0.01],
    ['exactly two Save controls', ['Save', 'Save', 'Save'], 0.01],
    ['no Save control', ['Cancel', 'Save'], 0.01],
    ['Receipt and confirmation number are present', ['Receipt', 'Confirmation number'], 0.99],
  ] as const) {
    await t.test(text, async () => {
      const screen = await captureRows(labels.map((label) => ({ label, type: 'Button' })));
      const judge = scriptedJudge((questions, _index, state) => {
        assert.deepEqual(Object.keys(questions), ['check_2', 'visibility_1']);
        assert.deepEqual(questions.check_2, questions.visibility_1);
        assert.match(questions.check_2.instructions, /WHOLE expectation/);
        assert.ok(questions.check_2.instructions.includes(text));
        assert.doesNotMatch(JSON.stringify(state), /visibleText|visibilityEvidenceGroups/);
        return { check_2: { type: 'noul', noul }, visibility_1: { type: 'noul', noul } };
      });
      const decision = await decideScreen(
        screen,
        judge,
        { kind: 'check', literal: false, text, line: 2 },
        waitFor(text),
      );
      assert.equal(decision.check, noul === 0.99 ? 'pass' : 'fail');
      assert.deepEqual(decision.visibility, { verdict: noul === 0.99 ? 'present' : 'absent' });
      assert.equal(judge.requests.length, 1);
    });
  }
});

test('negative judgments with unknown contributions never establish absence', async () => {
  const screen = await captureRows([{ label: 'Receipt' }, { label: 'Support', unknown: true }]);
  const judge = scriptedJudge(() => ({
    check_2: { type: 'noul', noul: 0.01 },
    visibility_1: { type: 'noul', noul: 0.01 },
  }));
  const decision = await decideScreen(
    screen,
    judge,
    { kind: 'check', literal: false, text: 'receipt text', line: 2 },
    waitFor('receipt text'),
  );
  assert.equal(decision.check, 'unsure');
  assert.deepEqual(decision.visibility, { verdict: 'pending' });
  assert.equal(judge.requests.length, 1);
});

test('unknown native descriptions do not inherit unproven React disabled flags', async () => {
  const screen = await captureRows(
    [
      { label: 'Save', type: 'Button' },
      { label: 'Cancel', type: 'Button', unknown: true, testID: 'cancel' },
    ],
    [
      {
        role: 'button',
        testID: 'cancel',
        disabled: true,
        capabilities: { press: true, fill: false },
      },
    ],
  );
  assert.equal(screen.elements[2].disabled, true);
  assert.equal(screen.elements[2].semantic?.disabled, false);
  const judge = scriptedJudge((_questions, _index, state) => {
    assert.doesNotMatch(JSON.stringify(state), /disabled/);
    return { check_1: { type: 'noul', noul: 0.5 } };
  });
  const result = await decideScreen(screen, judge, {
    kind: 'check',
    literal: false,
    text: 'All enabled controls say Save',
    line: 1,
  });
  assert.equal(result.check, 'unsure');
  assert.equal(judge.requests.length, 1);
  assert.equal(screen.elements[2].disabled, true);
});
