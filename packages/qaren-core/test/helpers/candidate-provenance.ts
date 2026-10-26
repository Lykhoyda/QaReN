import assert from 'node:assert/strict';
import { join } from '../../dist/qa/screen.js';
import { parsePlan } from '../../dist/qa/plan.js';
import { runPlan } from '../../dist/qa/walker.js';
import {
  unavailableProvenance,
  type ProvenanceReadDiagnostic,
} from '../../dist/qa/label-provenance.js';
import { scriptedJudge, walker } from '../unit/qa/judgment-fixtures.ts';

export async function assertProvenanceAdmission(
  diagnostic: ProvenanceReadDiagnostic | undefined,
  dispatch: boolean,
  indices: [number, number] = [0, 1],
): Promise<void> {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('quoted tap needs no model')),
  );
  f.deps.captureScreen = async () =>
    join(
      [
        {
          ref: `@e${indices[0]}`,
          type: 'Other',
          label: 'Add coverage',
          hittable: true,
          rect: { x: 0, y: 0, width: 400, height: 800 },
        },
        {
          ref: `@e${indices[1]}`,
          type: 'Button',
          parentIndex: 0,
          label: 'Add coverage',
          hittable: true,
          rect: { x: 20, y: 300, width: 360, height: 60 },
        },
      ],
      [],
      'app',
      { native: 'complete', react: 'complete' },
    );
  f.deps.readLabelProvenance = async (_refs, _deadline, report) => {
    report(diagnostic ?? unavailableProvenance('malformed'));
    return undefined;
  };
  let screenshots = 0;
  f.deps.screenshot = async () => {
    screenshots++;
    return 'screen.png';
  };
  const outcome = await runPlan(parsePlan('1. Tap "Add coverage"').blocks!, f.deps);
  if (dispatch) {
    assert.equal(outcome.verdict, 'PASS', JSON.stringify(outcome));
    assert.deepEqual(f.actions, [`press @e${indices[1]}`]);
  } else {
    assert.match(JSON.stringify(outcome), /TARGET_AMBIGUOUS/);
    assert.deepEqual(f.actions, []);
    assert.equal(screenshots, 0);
  }
}
