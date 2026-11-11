import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { longListSheet } from './long-list-capture-fixtures.ts';

// 260 rows plus the field: more than the agent-facing 200, under the private capture's 1000.
const ROWS = 260;

test('a private capture lists a long sheet completely while the agent digest still stops at 200', () => {
  const { api } = longListSheet(ROWS, 'Search');
  const reply = api.beginQaCapture(false);
  assert.equal(reply.state, 'ready', JSON.stringify(reply.diagnostic));
  const tree = JSON.parse(reply.tree);
  assert.equal(tree.truncated, undefined);
  assert.equal(tree.interactive.length, ROWS + 1);
  assert.equal(tree.hostEvidence.complete, true);
  assert.equal(tree.interactive.filter((entry) => entry.placeholder === 'Search').length, 1);
  const agent = JSON.parse(api.getTree({ interactiveOnly: true }));
  assert.equal(agent.interactive.length, 200);
  assert.equal(agent.truncated, true);
});

test('a quoted Fill pairs the placeholder of a long sheet through the real producer and adapter', async () => {
  const { client } = longListSheet(ROWS, 'Search');
  const input: NativeNode = {
    ref: '@input',
    type: 'TextField',
    hittable: true,
    enabled: true,
    rect: { x: 20, y: 100, width: 300, height: 44 },
  };
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('quoted targets do not need Jev')),
  );
  f.deps.captureScreen = () =>
    captureScreen({
      requirePrivateInputs: true,
      native: async () => ({
        nodes: [input],
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict: { state: 'ok', nodeCount: 1, refMapUpdated: true, reasons: [] },
      }),
      react: () => captureQaReact(client, false),
    });
  const ledger = await runPlan(parsePlan('1. Fill "Search" with "rv"').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS', ledger.failure?.seen);
  assert.deepEqual(f.actions, ['fill @input rv']);
});
