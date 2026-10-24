import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { NativeSnapshotIncomplete } from '../../../dist/qa/private-input.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { attested } from './platform-presence-fixtures.ts';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

for (const source of ['descendant', 'direct', 'none', 'unsettled'] as const) {
  test(`candidate-only ${source} provenance after a private fill never admits pixels or presses an ambiguous target`, async () => {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal target needs no model')),
    );
    let filled = false;
    let pressed = false;
    let reads = 0;
    let metadataReads = 0;
    f.deps.captureScreen = (options) => {
      reads++;
      if (options?.platformPresence)
        throw new NativeSnapshotIncomplete(121, ['keyboard-state-unknown', 'retry-deadline']);
      return captureScreen({
        ...options,
        requirePrivateInputs: true,
        native: async () =>
          attested(
            pressed
              ? [{ ref: '@home', type: 'StaticText', label: 'Home' }]
              : filled
                ? [
                    {
                      ref: '@app',
                      type: 'Application',
                      rect: { x: 0, y: 0, width: 400, height: 800 },
                    },
                    {
                      ref: '@container',
                      parentIndex: 0,
                      type: 'ScrollView',
                      label: 'Your coverage, Add coverage, Details',
                      identifier: 'list',
                      hittable: true,
                      rect: { x: 0, y: 0, width: 400, height: 800 },
                    },
                    {
                      ref: '@card',
                      parentIndex: 1,
                      type: 'Other',
                      label: 'Add coverage, Details',
                      hittable: true,
                      rect: { x: 20, y: 300, width: 360, height: 60 },
                    },
                  ]
                : [
                    {
                      ref: '@code',
                      type: 'TextField',
                      label: 'Code',
                      hittable: true,
                      rect: { x: 20, y: 100, width: 200, height: 40 },
                    },
                  ],
          ),
        react: async () => ({}),
      });
    };
    f.deps.fill = async () => {
      filled = true;
      return { ok: true, proven: true };
    };
    f.deps.readLabelProvenance = async (refs) => {
      metadataReads++;
      assert.deepEqual(refs, ['@container', '@card']);
      return source === 'unsettled'
        ? undefined
        : refs.map((ref) => ({
            ref,
            labelSource: ref === '@container' ? source : ('direct' as const),
          }));
    };
    f.deps.press = async (ref) => {
      assert.equal(ref, '@card');
      pressed = true;
      return { ok: true, proven: true };
    };
    f.deps.screenshot = async () => {
      assert.ok(
        metadataReads === 0 || pressed,
        'metadata-only evidence cannot authorize a screenshot',
      );
      return undefined;
    };
    const result = await runPlan(
      parsePlan('1. Type "private-code-canary" into "Code"\n2. Tap "Add coverage"').blocks!,
      f.deps,
    );
    if (source === 'descendant') assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    else {
      assert.match(JSON.stringify(result), /TARGET_AMBIGUOUS/);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INPUT_CAPTURE_UNKNOWN/);
      if (source === 'unsettled')
        assert.match(JSON.stringify(result), /provenance was unavailable/);
    }
    assert.equal(metadataReads, 1);
    assert.equal(pressed, source === 'descendant');
    assert.equal(JSON.stringify({ result, rows: f.rows }).includes('private-code-canary'), false);
    assert.ok(reads >= 3);
  });
}

for (const failure of ['ordinary-private', 'metadata-private', 'metadata-deadline'] as const) {
  test(`${failure} keeps privacy admission separate from metadata-only failure`, async () => {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('failure needs no model')),
    );
    let now = 0;
    let reads = 0;
    f.deps.now = () => now;
    f.deps.captureScreen = async () => {
      if (failure === 'ordinary-private')
        throw new NativeSnapshotIncomplete(4, ['keyboard-state-unknown']);
      now = failure === 'metadata-deadline' ? 21_999 : 0;
      return captureScreen({
        requirePrivateInputs: true,
        native: async () =>
          attested([
            { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
            {
              ref: '@outer',
              parentIndex: 0,
              type: 'ScrollView',
              label: 'Add coverage, Details',
              hittable: true,
              rect: { x: 0, y: 0, width: 400, height: 800 },
            },
            {
              ref: '@inner',
              parentIndex: 1,
              type: 'Other',
              label: 'Add coverage, Details',
              hittable: true,
              rect: { x: 20, y: 300, width: 360, height: 60 },
            },
          ]),
        react: async () => ({}),
      });
    };
    f.deps.readLabelProvenance = async () => {
      reads++;
      if (failure === 'metadata-deadline') return new Promise(() => {});
      throw new NativeSnapshotIncomplete(4, ['private-error-canary']);
    };
    f.deps.screenshot = async () => assert.fail('unknown evidence cannot authorize pixels');
    const result = await runPlan(parsePlan('1. Tap "Add coverage"').blocks!, f.deps);
    assert.deepEqual(f.actions, []);
    assert.equal(reads, failure === 'ordinary-private' ? 0 : 1);
    assert.match(
      JSON.stringify(result),
      failure === 'ordinary-private'
        ? /PRIVATE_INPUT_CAPTURE_UNKNOWN/
        : /TARGET_AMBIGUOUS: candidate label provenance was unavailable/,
    );
    assert.doesNotMatch(JSON.stringify(result), /private-error-canary/);
  });
}

test('cancellation during candidate metadata takes precedence over unavailable provenance', async () => {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('cancelled metadata needs no model')),
  );
  f.deps.captureScreen = () =>
    captureScreen({
      requirePrivateInputs: true,
      native: async () =>
        attested([
          { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
          {
            ref: '@outer',
            parentIndex: 0,
            type: 'ScrollView',
            label: 'Add coverage, Details',
            hittable: true,
            rect: { x: 0, y: 0, width: 400, height: 800 },
          },
          {
            ref: '@inner',
            parentIndex: 1,
            type: 'Other',
            label: 'Add coverage, Details',
            hittable: true,
            rect: { x: 20, y: 300, width: 360, height: 60 },
          },
        ]),
      react: async () => ({}),
    });
  let cancelled = false;
  f.deps.cancelled = () => cancelled;
  f.deps.readLabelProvenance = async () => {
    cancelled = true;
    return undefined;
  };
  const result = await runPlan(parsePlan('1. Tap "Add coverage"').blocks!, f.deps);
  assert.match(JSON.stringify(result), /RUN_CANCELLED/);
  assert.doesNotMatch(JSON.stringify(result), /TARGET_AMBIGUOUS/);
  assert.deepEqual(f.actions, []);
});
