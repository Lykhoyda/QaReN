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
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { loadBlock } from '../../../dist/qa/blocks.js';
import { buildLedger } from '../../../dist/qa/ledger.js';

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
