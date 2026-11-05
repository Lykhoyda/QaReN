import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeCaptureCoverage } from '../../../dist/qa/acquisition-coverage.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import type { NativeObservation } from '../../../dist/qa/capture.js';

const complete: NativeObservation = {
  nodes: [{ ref: '@e1', type: 'TextField', rect: { x: 20, y: 100, width: 300, height: 44 } }],
  truncated: false,
  normalizationDroppedNodes: 0,
  snapshotVerdict: { state: 'ok', nodeCount: 1, refMapUpdated: true, reasons: [] },
};

test('ordinary capture and dispatch acquisition agree on the native completeness contract', async () => {
  for (const [patch, expected] of [
    [{}, 'complete'],
    [{ truncated: true }, 'incomplete'],
    [{ normalizationDroppedNodes: 1 }, 'incomplete'],
    [{ truncated: undefined }, 'unknown'],
    [{ normalizationDroppedNodes: undefined }, 'unknown'],
    [{ snapshotVerdict: undefined }, 'unknown'],
    [
      { snapshotVerdict: { state: 'ok', nodeCount: 1, refMapUpdated: false, reasons: [] } },
      'incomplete',
    ],
    [
      { snapshotVerdict: { state: 'degraded', nodeCount: 1, refMapUpdated: true, reasons: [] } },
      'incomplete',
    ],
    [
      { snapshotVerdict: { state: 'ok', nodeCount: 2, refMapUpdated: true, reasons: [] } },
      'incomplete',
    ],
    [
      {
        snapshotVerdict: {
          state: 'ok',
          nodeCount: 1,
          refMapUpdated: true,
          reasons: ['snapshot-ref-freshness-unknown'],
        },
      },
      'incomplete',
    ],
  ] as const) {
    const observation = { ...complete, ...patch };
    assert.equal(nativeCaptureCoverage(observation), expected);
    const screen = await captureScreen({
      native: async () => observation,
      react: async () => ({
        interactive: [],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence: { complete: true, hosts: [] },
      }),
    });
    assert.equal(screen.captureCoverage?.native, expected);
    assert.equal((screen.nativeCaptureCauses?.length ?? 0) > 0, expected === 'incomplete');
  }
});
