import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureScreen, NativeCaptureError } from '../../../dist/qa/capture.js';
import {
  PrivateInputCaptureError,
  ReactCaptureIncomplete,
} from '../../../dist/qa/private-input.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import type { TimingEvent } from '../../../dist/qa/timing.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { createWriter, resultForWalk } from '../../../dist/qa/wire.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { loadBlock } from '../../../dist/qa/blocks.js';
import { buildLedger, type LedgerRow } from '../../../dist/qa/ledger.js';
import { createQaReactCapture } from '../../../dist/qa/react-capture.js';

const secret = 'field-secret@example.test';

function withField() {
  const native = nativeCapture();
  native.nodes.push({
    ...native.nodes[1],
    ref: '@email',
    index: 2,
    type: 'TextField',
    identifier: 'email',
    label: 'Email',
    value: secret,
    presence: { ...native.nodes[1].presence, nodeIndex: 2 },
  });
  native.snapshotVerdict.nodeCount = native.nodes.length;
  return { ...native, presenceCapture: undefined };
}

test('a React digest failure degrades coverage without a retry or a refusal', async () => {
  for (const failure of [
    new PrivateInputCaptureError(),
    new ReactCaptureIncomplete('disconnected'),
    new ReactCaptureIncomplete('reconnected'),
    new Error('transport closed'),
    new Error('malformed digest'),
  ]) {
    let natives = 0;
    let reads = 0;
    const events: TimingEvent[] = [];
    const screen = await captureScreen({
      requirePrivateInputs: true,
      appId: 'com.test',
      native: async () => {
        natives += 1;
        return withField();
      },
      react: async () => {
        reads += 1;
        throw failure;
      },
      timing: (event) => events.push(event),
    });
    assert.deepEqual({ natives, reads }, { natives: 1, reads: 1 });
    assert.equal(screen.coverage?.react, 'unknown');
    assert.equal(
      screen.reactConnection,
      failure instanceof ReactCaptureIncomplete
        ? { disconnected: 'lost', reconnected: 'reconnected' }[failure.reason]
        : undefined,
    );
    assert.equal(events.filter((event) => event.stage === 'refresh').length, 0);
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact(`typed ${secret}`), 'typed •••');
    assert.equal(privacy.canScreenshot(), false);
  }
});

test('a lost connection withholds every block of the walk; a capture limit or reconnect only its own block', async () => {
  const healthy = () => ({
    interactive: [],
    verdict: { state: 'ok', path: 'interactive', complete: true },
    hostEvidence: { complete: true, hosts: [] },
  });
  const gaps = [
    [
      'unknown',
      () => {
        throw new ReactCaptureIncomplete('deadline');
      },
    ],
    [
      'unknown',
      () => {
        throw new Error('helper failed: private detail');
      },
    ],
    ['incomplete', () => ({ interactive: [], verdict: { state: 'degraded', complete: false } })],
    ['reconnected', () => ({ ...healthy(), reconnected: true as const })],
    [
      'reconnected',
      () => {
        throw new ReactCaptureIncomplete('reconnected');
      },
    ],
    [
      'lost',
      () => {
        throw new ReactCaptureIncomplete('disconnected');
      },
    ],
  ] as const;
  for (const platform of ['ios', 'android'] as const) {
    for (const mode of ['walk', 'replay'] as const) {
      for (const [gap, observe] of gaps) {
        for (const lostAt of [2, 3]) {
          const appRoot = mkdtempSync(join(tmpdir(), 'react-reconnect-'));
          try {
            const blocks = parsePlan(
              '### Before\n✓ "Save"\n### Tap\n1. Tap "save"\n### After\n✓ "Save"',
            ).blocks!;
            const store = { appRoot, appId: 'com.test', platform };
            let reads = 0;
            let lose = false;
            const f = walker(
              [],
              scriptedJudge(() => assert.fail('literal plan needs no model')),
            );
            f.deps.captureScreen = () =>
              captureScreen({
                native: async () => ({ ...nativeCapture(), presenceCapture: undefined }),
                react: async () => {
                  reads += 1;
                  return lose && reads === lostAt ? observe() : healthy();
                },
              });
            if (mode === 'replay') {
              const healthy = await runPlan(blocks, f.deps, [], store);
              assert.equal(healthy.verdict, 'PASS');
              assert.equal(healthy.blocksWritten?.length, 3);
            }
            const before = blocks.map((block) => loadBlock(appRoot, block.slug));
            reads = 0;
            lose = true;
            const result = await runPlan(blocks, f.deps, [], store);
            assert.equal(result.verdict, gap === 'lost' ? 'REFUSED' : 'PASS');
            assert.equal(result.path, mode);
            assert.deepEqual(
              result.steps.map((row) => row.reactCoverage),
              [undefined, gap, undefined],
            );
            assert.ok(result.steps.every((row) => row.outcome === 'pass'));
            assert.equal(reads, 4);
            const learned = mode === 'walk' && gap !== 'lost';
            assert.deepEqual(result.blocksWritten, learned ? [blocks[0].slug, blocks[2].slug] : []);
            assert.deepEqual(loadBlock(appRoot, blocks[1].slug), before[1]);
            if (!learned)
              assert.deepEqual(
                blocks.map((block) => loadBlock(appRoot, block.slug)),
                before,
              );
            if (mode === 'walk')
              assert.deepEqual(
                result.blocks.map((block) => block.saved !== false),
                [learned, false, learned],
              );
            if (mode === 'walk') assert.match(result.blocks[1].unsavable!, /React coverage/);
            assert.ok(!JSON.stringify(result).includes('private detail'));
          } finally {
            rmSync(appRoot, { recursive: true, force: true });
          }
        }
      }
    }
  }
});

test('coverage gaps preserve an existing failed row instead of replacing its failure', () => {
  const failure = { step: 2, seen: 'the expected confirmation was absent' };
  const result = buildLedger(
    [],
    [
      {
        block: 'plan',
        line: 2,
        text: '✓ "Saved"',
        attempt: 1,
        kind: 'check',
        resolvedBy: 'exact',
        t: 0,
        outcome: 'fail',
        reactCoverage: 'lost',
      },
    ],
    failure,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.failure, failure);
});

test('Metro stop and restart preserves same-step and later recovery; renewed or permanent loss refuses', async () => {
  for (const { restartAt, relapseAt, helpersAt } of [
    { restartAt: 3 },
    { restartAt: 4 },
    { restartAt: 3, helpersAt: 4 },
    { restartAt: 3, relapseAt: 4 },
    { restartAt: undefined },
  ]) {
    const appRoot = mkdtempSync(join(tmpdir(), 'react-stop-restart-'));
    try {
      const f = walker(
        [],
        scriptedJudge(() => assert.fail('literal plan needs no model')),
      );
      let reads = 0;
      let connected = true;
      let generation = 1;
      const reactCapture = createQaReactCapture({
        get isConnected() {
          return connected;
        },
        get connectionGeneration() {
          return generation;
        },
        async reinjectHelpers() {
          return helpersAt === undefined || reads >= helpersAt;
        },
        async withPrivateHelperWorld(operation) {
          if (!connected) throw new Error('Metro transport closed');
          if (helpersAt !== undefined && reads >= restartAt! && reads < helpersAt)
            throw new Error('Private helper world unavailable');
          return operation(async () => ({
            v: 1,
            id: '1abcd',
            state: 'ready',
            tree: JSON.stringify({
              interactive: [],
              verdict: {
                state: 'ok',
                path: 'interactive',
                complete: true,
                reasons: [],
                rendererErrors: 0,
                unscannedRendererIds: [],
                droppedSubtrees: 0,
                collapsedChildLists: 0,
              },
              hostEvidence: { complete: true, hosts: [] },
            }),
          }));
        },
      });
      f.deps.captureScreen = () =>
        captureScreen({
          native: async () => ({ ...nativeCapture(), presenceCapture: undefined }),
          react: async () => {
            reads += 1;
            if (reads === 2 || reads === relapseAt) connected = false;
            if (reads === restartAt) {
              connected = true;
              generation += 1;
            }
            return reactCapture();
          },
        });
      const result = await runPlan(
        parsePlan('### Before\n✓ "Save"\n### Tap\n1. Tap "save"\n### After\n✓ "Save"').blocks!,
        f.deps,
        [],
        { appRoot, appId: 'com.test', platform: 'ios' },
      );
      assert.equal(reads, 4);
      const recovered = restartAt !== undefined && relapseAt === undefined;
      assert.equal(result.verdict, recovered ? 'PASS' : 'REFUSED');
      assert.equal(result.steps[1].reactCoverage, 'lost');
      assert.deepEqual(
        result.steps[1].reactConnections,
        restartAt === 3 && helpersAt === undefined ? ['lost', 'reconnected'] : ['lost'],
      );
      if (helpersAt !== undefined)
        assert.deepEqual(result.steps[2].reactConnections, ['reconnected']);
      assert.deepEqual(f.rows[1].reactConnections, result.steps[1].reactConnections);
      assert.deepEqual(result.blocksWritten, []);
      assert.deepEqual(readdirSync(appRoot), []);
      const output: string[] = [];
      assert.equal(
        createWriter((line) => output.push(line), 'restart').result(resultForWalk(result, 'lease')),
        recovered ? 0 : 4,
      );
      assert.deepEqual(
        JSON.parse(output[0]).payload.steps[1].reactConnections,
        result.steps[1].reactConnections,
      );
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  }
});

test('nested login recovery preserves connection chronology, block withholding and product failures', async () => {
  for (const failPlan of [false, true]) {
    const appRoot = mkdtempSync(join(tmpdir(), 'react-login-recovery-'));
    try {
      const f = walker(
        [],
        scriptedJudge(() => assert.fail('literal plan needs no model')),
      );
      let loggedIn = false;
      let reads = 0;
      f.deps.captureScreen = async () => ({
        ...screen([loggedIn ? element('@save', 'Save') : element('@login', 'Sign in')]),
        ...(++reads === 1
          ? { reactConnection: 'lost' as const }
          : reads === 3
            ? { reactConnection: 'reconnected' as const }
            : {}),
      });
      f.deps.press = async (ref, context) => {
        context.authorize();
        f.actions.push(`press ${ref}`);
        loggedIn = true;
        return { ok: true, proven: true };
      };
      f.deps.hideDevMenu = async () => ({ ok: true, proven: true });
      f.deps.login = {
        marker: { text: 'Sign in' },
        block: parsePlan('### Login\n1. Tap "Sign in"').blocks![0],
      };
      const result = await runPlan(
        parsePlan(`1. Tap "Save"${failPlan ? '\n✓ "Missing"' : ''}`).blocks!,
        f.deps,
        [],
        { appRoot, appId: 'com.test', platform: 'ios' },
      );
      assert.equal(result.verdict, failPlan ? 'FAIL' : 'PASS');
      assert.deepEqual(f.actions, ['press @login', 'press @save']);
      assert.deepEqual(result.steps[0].reactConnections, ['reconnected']);
      const retry = result.steps.find((row) => row.outcome === 'retry')!;
      assert.equal(retry.reactCoverage, 'lost');
      assert.deepEqual(retry.reactConnections, ['lost', 'reconnected']);
      if (failPlan) {
        assert.equal(result.steps.at(-1)?.outcome, 'fail');
        assert.match(result.failure!.seen, /Missing/);
      }
      assert.deepEqual(result.blocksWritten, []);
      assert.deepEqual(readdirSync(appRoot), []);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  }
});

test('a retry retaining old lost coverage does not undo an observed reconnect', () => {
  const row: LedgerRow = {
    block: 'tap',
    line: 22,
    text: '',
    attempt: 1,
    kind: 'step',
    resolvedBy: 'exact',
    t: 0,
    outcome: 'retry',
    reactCoverage: 'lost',
    reactConnections: ['lost', 'reconnected'],
  };
  const retry: LedgerRow = { ...row, attempt: 2, outcome: 'pass', reactConnections: [] };
  assert.equal(buildLedger([], [row, retry]).verdict, 'PASS');
  assert.equal(buildLedger([], [row, { ...retry, reactConnections: ['lost'] }]).verdict, 'REFUSED');
});

test('a native snapshot failure still refuses', async () => {
  await assert.rejects(
    captureScreen({
      requirePrivateInputs: true,
      native: async () => {
        throw new Error('runner down');
      },
      react: async () => assert.fail('native failed first'),
    }),
    NativeCaptureError,
  );
});

test('only a post-act React disconnect refuses; a capture limit passes; neither saves a block', async () => {
  for (const [failure, coverage, verdict, exit] of [
    [new ReactCaptureIncomplete('disconnected'), 'lost', 'REFUSED', 4],
    [new ReactCaptureIncomplete('interactive-cap'), 'unknown', 'PASS', 0],
    [new ReactCaptureIncomplete('verdict-reasons:scan-budget-exhausted'), 'unknown', 'PASS', 0],
    [new PrivateInputCaptureError(), 'unknown', 'PASS', 0],
  ] as const) {
    const appRoot = mkdtempSync(join(tmpdir(), 'react-coverage-'));
    try {
      let reads = 0;
      const f = walker(
        [],
        scriptedJudge(() => assert.fail('a quoted tap needs no model')),
      );
      f.deps.captureScreen = (options) =>
        captureScreen({
          timing: options?.timing,
          native: async () => ({ ...nativeCapture(), presenceCapture: undefined }),
          react: async () => {
            reads += 1;
            if (reads === 2) throw failure;
            return {
              interactive: [
                { role: 'button', testID: 'save', capabilities: { press: true, fill: false } },
              ],
              verdict: { state: 'ok', path: 'interactive', complete: true },
              hostEvidence: { complete: true, hosts: [] },
            };
          },
        });
      const result = await runPlan(parsePlan('1. Tap "save"').blocks!, f.deps, [], {
        appRoot,
        appId: 'com.test',
        platform: 'ios',
      });
      assert.equal(result.verdict, verdict, JSON.stringify(result));
      assert.equal('code' in result && result.code, verdict === 'REFUSED' && 'REACT_COVERAGE_LOST');
      assert.equal(result.steps[0].reactCoverage, coverage);
      assert.equal(f.rows[0].reactCoverage, coverage);
      assert.deepEqual(result.blocksWritten, []);
      assert.equal(result.blocks[0].saved, false);
      assert.match(result.blocks[0].unsavable!, /React coverage/);
      assert.deepEqual(readdirSync(appRoot), []);
      const output: string[] = [];
      const writer = createWriter((line) => output.push(line), 'react-loss');
      assert.equal(writer.result(resultForWalk(result, 'lease')), exit);
      assert.equal(JSON.parse(output[0]).payload.steps[0].reactCoverage, coverage);
      assert.deepEqual(f.actions, ['press @e1']);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  }
});
