import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested } from './platform-presence-fixtures.ts';

const app = { x: 0, y: 0, width: 400, height: 800 };
const offscreen = { x: 20, y: 900, width: 160, height: 60 };

function nodes(): NativeNode[] {
  return [
    { ref: '@e0', type: 'Application', rect: app, depth: 0 },
    { ref: '@e1', type: 'Window', rect: app, depth: 1, parentIndex: 0 },
    { ref: '@e2', type: 'Other', rect: app, depth: 2, parentIndex: 1 },
    {
      ref: '@e3',
      type: 'Other',
      rect: offscreen,
      depth: 3,
      parentIndex: 2,
      identifier: 'Card',
      label: 'private label',
      value: 'private value',
      hittable: false,
    },
    {
      ref: '@e4',
      type: 'Other',
      rect: offscreen,
      depth: 4,
      parentIndex: 3,
      identifier: 'private identifier',
      label: 'Card',
      hittable: true,
    },
  ];
}

async function walk(raw: string, nativeNodes: NativeNode[]) {
  const logs: string[] = [];
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('quoted targets are model-free')),
  );
  f.deps.captureScreen = () =>
    captureScreen({
      requirePrivateInputs: true,
      now: () => 0,
      native: async () => attested(nativeNodes),
      react: async () => ({ interactive: [] }),
      warn: (line) => logs.push(line),
    });
  const result = await runPlan(parsePlan(raw).blocks!, f.deps);
  return { result, logs, actions: f.actions };
}

test('a failed quoted wait logs matching raw native nodes once without their content', async () => {
  const { result, logs, actions } = await walk('1. Wait for "Card"', nodes());
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(actions, []);
  const diagnostics = logs.filter((line) => line.startsWith('quoted-target='));
  assert.equal(diagnostics.length, 1, 'polls must produce only one terminal diagnostic');
  assert.deepEqual(JSON.parse(diagnostics[0].slice('quoted-target='.length)), {
    line: 1,
    matches: [
      {
        index: 3,
        identifier: true,
        label: false,
        frame: offscreen,
        depth: 3,
        hittable: false,
        insideTrustedViewport: false,
      },
      {
        index: 4,
        identifier: false,
        label: true,
        frame: offscreen,
        depth: 4,
        hittable: true,
        insideTrustedViewport: false,
      },
    ],
    deepestCapturedDepth: 4,
  });
  assert.doesNotMatch(diagnostics[0], /private|@e/);
});

test('a failed quoted target with no native match logs absence and the deepest captured depth', async () => {
  const { result, logs, actions } = await walk('1. Tap "Missing"', nodes());
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(actions, []);
  const diagnostics = logs.filter((line) => line.startsWith('quoted-target='));
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(JSON.parse(diagnostics[0].slice('quoted-target='.length)), {
    line: 1,
    matches: [],
    deepestCapturedDepth: 4,
  });
  assert.doesNotMatch(diagnostics[0], /private|Card|@e/);
});

test('a failed quoted press reports matches inside the trusted viewport', async () => {
  const native = nodes();
  native[3].rect = { x: 20, y: 200, width: 160, height: 60 };
  native[4].rect = { x: 20, y: 200, width: 160, height: 60 };
  const { result, logs, actions } = await walk('1. Tap "Card"', native);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(actions, []);
  const diagnostics = logs.filter((line) => line.startsWith('quoted-target='));
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(JSON.parse(diagnostics[0].slice('quoted-target='.length)).matches, [
    {
      index: 3,
      identifier: true,
      label: false,
      frame: native[3].rect,
      depth: 3,
      hittable: false,
      insideTrustedViewport: true,
    },
    {
      index: 4,
      identifier: false,
      label: true,
      frame: native[4].rect,
      depth: 4,
      hittable: true,
      insideTrustedViewport: true,
    },
  ]);
});

test('a successful quoted wait emits no failure diagnostic', async () => {
  const native = nodes();
  native[4].rect = { x: 20, y: 200, width: 160, height: 60 };
  native[4].type = 'StaticText';
  const { result, logs } = await walk('1. Wait for "Card"', native);
  assert.equal(result.verdict, 'PASS');
  assert.equal(logs.filter((line) => line.startsWith('quoted-target=')).length, 0);
});
