import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';

function captureInput(platformPresence: boolean) {
  const native = nativeCapture();
  const observed = native.nodes[1];
  return captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    now: () => 0,
    native: async () => ({
      ...native,
      presenceCapture: platformPresence ? native.presenceCapture : undefined,
      nodes: [
        native.nodes[0],
        {
          ...observed,
          type: 'Window',
          identifier: undefined,
          label: '',
          rect: { x: 20, y: 40, width: 400, height: 800 },
        },
        {
          ...observed,
          ref: '@email',
          index: 2,
          parentIndex: 1,
          depth: 2,
          type: 'Other',
          identifier: 'email',
          label: 'Email',
          rect: { x: 30, y: 60, width: 100, height: 40 },
          presence: { ...observed.presence, nodeIndex: 2 },
        },
      ].map(({ presence, ...node }) => (platformPresence ? { ...node, presence } : node)),
      snapshotVerdict: { ...native.snapshotVerdict, nodeCount: 3 },
    }),
    react: async () => ({
      interactive: [{ testID: 'email', role: 'textinput', capabilities: { fill: true } }],
      verdict: { state: 'ok', path: 'interactive', complete: true },
      hostEvidence: {
        complete: true,
        hosts: [{ testID: 'email', role: null, roleSource: 'none', capabilities: { fill: true } }],
        typography: {
          version: 1,
          complete: true,
          durationMs: 10,
          coordinateSpace: 'window-points',
          nodes: [
            {
              hostIndex: 0,
              parentHostIndex: null,
              rootIndex: 0,
              hostType: 'RCTView',
              rect: { x: 10, y: 20, width: 100, height: 40 },
              text: { kind: 'none' },
            },
          ],
        },
      },
    }),
  });
}

test('prepending a semantic check preserves a quoted fill through real private capture', async () => {
  for (const checked of [false, true]) {
    const judge = scriptedJudge((questions) => {
      assert.equal(checked, true, 'the standalone quoted fill is model-free');
      assert.deepEqual(Object.keys(questions), ['check_1']);
      return { check_1: { type: 'noul', noul: 0.9 } };
    });
    const f = walker([], judge);
    const modes: boolean[] = [];
    f.deps.captureScreen = async (options) => {
      const presence = options?.platformPresence === true;
      assert.equal(options?.observation, modes.length + 1);
      modes.push(presence);
      const captured = await captureInput(presence);
      const input = captured.elements.find((element) => element.ref === '@email')!;
      assert.equal(input.kind, presence ? 'other' : 'input');
      assert.equal(captured.captureCoverage?.native, 'complete');
      if (presence) {
        assert.deepEqual(captured.coverage, { native: 'complete', react: 'complete' });
        assert.equal(input.semantic?.fill, 'supported');
        assert.equal(input.semantic?.visibility, 'visible');
        assert.equal(captured.semanticUnassociatedReact, 0);
      }
      return captured;
    };
    let authorizations = 0;
    const fill = f.deps.fill;
    f.deps.fill = async (ref, text, context) => {
      context.authorize();
      authorizations += context.authorizations;
      return fill(ref, text, context);
    };
    const result = await runPlan(
      parsePlan(`${checked ? '✓ Email is visible\n' : ''}1. Fill "Email" with "hello"`).blocks!,
      f.deps,
    );
    if (checked) assert.equal(result.steps[0].outcome, 'pass');
    assert.equal(result.verdict, 'PASS', result.failure?.seen);
    assert.deepEqual(f.actions, ['fill @email hello']);
    assert.equal(authorizations, 1);
    assert.deepEqual(modes, checked ? [true, false, false] : [false, false]);
    assert.equal(judge.requests.length, Number(checked));
    assert.doesNotMatch(JSON.stringify({ result, requests: judge.requests }), /hello/);
  }
});
