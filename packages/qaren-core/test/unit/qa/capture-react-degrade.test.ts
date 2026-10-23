import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureScreen, NativeCaptureError } from '../../../dist/qa/capture.js';
import { PrivateInputCaptureError } from '../../../dist/qa/private-input.js';
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
    assert.equal(events.filter((event) => event.stage === 'refresh').length, 0);
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact(`typed ${secret}`), 'typed •••');
    assert.equal(privacy.canScreenshot(), false);
  }
});

test('reconnected React cannot erase a pre-act or post-act gap or teach blocks from that walk', async () => {
  for (const platform of ['ios', 'android'] as const) {
    for (const mode of ['walk', 'replay'] as const) {
      for (const gap of ['unknown', 'incomplete'] as const) {
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
                  if (lose && reads === lostAt) {
                    if (gap === 'unknown') throw new Error('transport closed: private detail');
                    return { interactive: [], verdict: { state: 'degraded', complete: false } };
                  }
                  return {
                    interactive: [],
                    verdict: { state: 'ok', path: 'interactive', complete: true },
                    hostEvidence: { complete: true, hosts: [] },
                  };
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
            assert.equal(result.verdict, 'REFUSED');
            assert.equal(result.path, mode);
            assert.deepEqual(
              result.steps.map((row) => row.reactCoverage),
              [undefined, gap, undefined],
            );
            assert.ok(result.steps.every((row) => row.outcome === 'pass'));
            assert.equal(reads, 4);
            assert.deepEqual(result.blocksWritten, []);
            assert.deepEqual(
              blocks.map((block) => loadBlock(appRoot, block.slug)),
              before,
            );
            if (mode === 'walk') assert.ok(result.blocks.every((block) => block.saved === false));
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
        reactCoverage: 'unknown',
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

test('a post-act React disconnect refuses the run and cannot save a native-proven block', async () => {
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
          if (reads === 2) throw new PrivateInputCaptureError();
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
    assert.equal(result.verdict, 'REFUSED', JSON.stringify(result));
    assert.equal('code' in result && result.code, 'REACT_COVERAGE_LOST');
    assert.equal(result.steps[0].reactCoverage, 'unknown');
    assert.equal(f.rows[0].reactCoverage, 'unknown');
    assert.deepEqual(result.blocksWritten, []);
    assert.equal(result.blocks[0].saved, false);
    assert.match(result.blocks[0].unsavable!, /React coverage/);
    assert.deepEqual(readdirSync(appRoot), []);
    const output: string[] = [];
    const writer = createWriter((line) => output.push(line), 'react-loss');
    assert.equal(writer.result(resultForWalk(result, 'lease')), 4);
    assert.equal(JSON.parse(output[0]).payload.steps[0].reactCoverage, 'unknown');
    assert.deepEqual(f.actions, ['press @e1']);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});
