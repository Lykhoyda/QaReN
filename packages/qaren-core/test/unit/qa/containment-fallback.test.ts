import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from '../../../dist/qa/screen.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { LabelProvenanceDiagnostic } from '../../../dist/qa/label-provenance.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

for (const shape of [
  'Other',
  'ScrollView',
  'Cell',
  'twins',
  'interactive',
  'three',
  'unhittable',
  'edge',
] as const) {
  test(`unavailable provenance containment: ${shape}`, async () => {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal target needs no model')),
    );
    let now = 0;
    f.deps.now = () => now;
    f.deps.captureScreen = async () => {
      now += 1_000;
      return join(
        [
          {
            ref: '@outer',
            type:
              shape === 'interactive' || shape === 'twins'
                ? 'Button'
                : shape === 'Cell'
                  ? 'Cell'
                  : shape === 'ScrollView'
                    ? 'ScrollView'
                    : 'Other',
            label: 'Continue',
            hittable: true,
            rect: {
              x: 0,
              y: 0,
              width: shape === 'twins' ? 120 : 400,
              height: shape === 'twins' ? 60 : 800,
            },
          },
          {
            ref: '@inner',
            parentIndex: shape === 'twins' ? undefined : 0,
            type: 'Button',
            label: 'Continue',
            hittable: shape !== 'unhittable',
            rect: { x: shape === 'edge' ? 0 : 20, y: 300, width: 360, height: 60 },
          },
          ...(shape === 'three'
            ? [
                {
                  ref: '@third',
                  parentIndex: 0,
                  type: 'Button',
                  label: 'Continue',
                  hittable: true,
                  rect: { x: 20, y: 500, width: 360, height: 60 },
                },
              ]
            : []),
        ],
        [],
        'app',
        { native: 'complete', react: 'complete' },
      );
    };
    const events: LabelProvenanceDiagnostic[] = [];
    f.deps.labelProvenanceDiagnostic = (event) => events.push(event);
    f.deps.readLabelProvenance = async (_refs, deadline, report) => {
      now = deadline + 100;
      report({
        requested: true,
        sampleCount: 3,
        nodeIndex: null,
        differedFields: [],
        deadlineExpired: true,
        outcome: 'deadline',
      });
      return undefined;
    };
    f.deps.press = async (ref, context) => {
      assert.equal(context.deadline, 11_000);
      f.actions.push(`press ${ref}`);
      return { ok: true, proven: true };
    };
    const result = await runPlan(parsePlan('1. Tap "Continue"').blocks!, f.deps);
    if (['Other', 'ScrollView', 'Cell'].includes(shape)) {
      assert.equal(result.verdict, 'PASS', JSON.stringify(result));
      assert.deepEqual(f.actions, ['press @inner']);
      assert.equal(events[0].outcome, 'deadline');
      assert.equal(events[0].sampleCount, 3);
      assert.equal(events[0].resolvedBy, 'containment');
    } else {
      assert.match(JSON.stringify(result), /TARGET_AMBIGUOUS/);
      assert.deepEqual(f.actions, []);
      assert.ok(events.every((event) => event.resolvedBy === undefined));
    }
    assert.doesNotMatch(JSON.stringify(events), /Continue|@inner|@outer/);
  });
}

for (const source of ['descendant', 'direct', 'none', 'process-mismatch', 'expired'] as const) {
  test(`containment preserves ${source} provenance and observation authority`, async () => {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal target needs no model')),
    );
    let now = 0;
    f.deps.now = () => now;
    f.deps.captureScreen = async () =>
      join(
        [
          {
            ref: '@outer',
            type: 'Other',
            label: 'Continue',
            hittable: true,
            rect: { x: 0, y: 0, width: 400, height: 800 },
          },
          {
            ref: '@inner',
            parentIndex: 0,
            type: 'Button',
            label: 'Continue',
            hittable: true,
            rect: { x: 20, y: 300, width: 360, height: 60 },
          },
        ],
        [],
        'app',
        { native: 'complete', react: 'complete' },
      );
    const events: LabelProvenanceDiagnostic[] = [];
    f.deps.labelProvenanceDiagnostic = (event) => events.push(event);
    f.deps.readLabelProvenance = async (refs, deadline, report) => {
      if (source === 'expired') {
        now = deadline + 1_501;
        return undefined;
      }
      if (source === 'process-mismatch') {
        report({
          requested: true,
          sampleCount: null,
          nodeIndex: null,
          differedFields: [],
          deadlineExpired: null,
          outcome: 'process-mismatch',
        });
        return undefined;
      }
      return refs.map((ref) => ({ ref, labelSource: ref === '@outer' ? source : 'direct' }));
    };
    const result = await runPlan(parsePlan('1. Tap "Continue"').blocks!, f.deps);
    if (source === 'descendant') {
      assert.equal(result.verdict, 'PASS', JSON.stringify(result));
      assert.deepEqual(f.actions, ['press @inner']);
    } else {
      assert.match(JSON.stringify(result), /TARGET_AMBIGUOUS/);
      assert.deepEqual(f.actions, []);
    }
    assert.ok(events.every((event) => event.resolvedBy === undefined));
  });
}

test('containment selection preserves both captured candidates and cannot prove an unchanged tap', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal target needs no model')),
  );
  const signatures: string[] = [];
  f.deps.captureScreen = async () => {
    const screen = join(
      [
        {
          ref: '@outer',
          type: 'Other',
          label: 'Continue',
          hittable: true,
          rect: { x: 0, y: 0, width: 400, height: 800 },
        },
        {
          ref: '@inner',
          parentIndex: 0,
          type: 'Button',
          label: 'Continue',
          hittable: true,
          rect: { x: 20, y: 300, width: 360, height: 60 },
        },
      ],
      [],
      'app',
      { native: 'complete', react: 'complete' },
    );
    signatures.push(JSON.stringify(screen));
    return screen;
  };
  f.deps.readLabelProvenance = async () => undefined;
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    return { ok: true };
  };
  const result = await runPlan(parsePlan('1. Tap "Continue"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL', JSON.stringify(result));
  assert.ok(f.actions.length > 0);
  assert.ok(f.actions.every((action) => action === 'press @inner'));
  assert.ok(signatures.length > 1);
  assert.ok(signatures.every((signature) => signature === signatures[0]));
  assert.doesNotMatch(JSON.stringify(result), /TARGET_AMBIGUOUS/);
});
