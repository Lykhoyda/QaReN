import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWriter } from '../../../dist/qa/wire.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';

test('native-reread crosses the diagnostic wire without runtime inputs', () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'run');
  const metric = {
    kind: 'metric',
    stage: 'native-reread',
    edge: 'point',
    outcome: 'ok',
    at: 76145,
    line: 9,
    observation: 4,
  };
  withInputs(new RunInputs({}, []), () => writer.diagnostic(metric));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    v: 1,
    runId: 'run',
    seq: 2,
    type: 'diagnostic',
    payload: metric,
  });
});

test('ordinary native timing stays off the diagnostic wire without runtime inputs', () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'run');
  withInputs(new RunInputs({}, []), () => {
    writer.diagnostic({
      kind: 'metric',
      stage: 'native-total',
      edge: 'point',
      outcome: 'ok',
      at: 10,
    });
  });
  assert.deepEqual(lines, []);
});

for (const stage of ['manifest-probe', 'dev-client-relaunch']) {
  test(`${stage} crosses the diagnostic wire without runtime inputs`, () => {
    const lines: string[] = [];
    const writer = createWriter((line) => lines.push(line), 'run');
    const metric = { kind: 'metric', stage, edge: 'point', outcome: 'ok', at: 10 };
    withInputs(new RunInputs({}, []), () => writer.diagnostic(metric));
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      v: 1,
      runId: 'run',
      seq: 2,
      type: 'diagnostic',
      payload: metric,
    });
  });
}

for (const stage of ['native-reread', 'native-total', 'manifest-probe', 'dev-client-relaunch']) {
  test(`${stage} crosses the diagnostic wire with runtime inputs`, () => {
    const lines: string[] = [];
    const writer = createWriter((line) => lines.push(line), 'run');
    const metric = { kind: 'metric', stage, edge: 'point', outcome: 'ok', at: 10 };
    withInputs(new RunInputs({ PASSWORD: 'private-value' }, ['PASSWORD']), () =>
      writer.diagnostic(metric),
    );
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      v: 1,
      runId: 'run',
      seq: 2,
      type: 'diagnostic',
      payload: metric,
    });
  });
}
