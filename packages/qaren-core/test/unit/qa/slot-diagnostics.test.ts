import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriter } from '../../../dist/qa/wire.js';
import { InputPrivacyRefusal, RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { PrivateInputCaptureError } from '../../../dist/qa/private-input.js';
import { createTimingObserver } from '../../../dist/qa/timing.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

test('the slot diagnostic wire projects only fixed vocabulary and measured numbers', () => {
  const outputs = ['private-user@example.test', 'quote"slash\\sentinel'].map((secret) => {
    const lines: string[] = [];
    const writer = createWriter((line) => lines.push(line), 'run');
    withInputs(new RunInputs({ PASSWORD: secret }, ['PASSWORD'], undefined, ['PASSWORD']), () => {
      writer.diagnostic({
        kind: 'metric',
        stage: 'capture',
        edge: 'end',
        outcome: 'ok',
        at: 200,
        ms: 100,
        text: secret,
        hash: Buffer.from(secret).toString('hex'),
      });
      writer.diagnostic({
        kind: 'timing',
        stage: 'dispatch',
        code: 'ACTION_INTERRUPTED',
        line: 2,
        at: 220,
        acquisitionMs: 100,
        observationAgeMs: 120,
        authorizations: 1,
        refusalDiagnostic: {
          nativeCode: 'RUNNER_TIMEOUT',
          nativeMutation: 'possible',
          message: secret,
        },
        ref: secret,
      });
      writer.diagnostic({ kind: 'block-outcome', line: 2, outcome: 'pass', title: secret });
      writer.diagnostic({ kind: 'login-outcome', outcome: 'refused', message: secret });
      for (const payload of [
        { kind: 'metric', stage: secret, edge: 'end', outcome: 'ok', at: 1 },
        {
          kind: 'timing',
          stage: 'dispatch',
          code: secret,
          line: 2,
          at: 1,
          acquisitionMs: 0,
          observationAgeMs: 0,
        },
        { kind: 'block-outcome', line: secret, outcome: 'pass' },
        { kind: 'login-outcome', outcome: secret },
        { kind: 'metric', stage: 'capture', edge: 'end', outcome: 'ok', at: NaN },
      ])
        writer.diagnostic(payload);
      writer.result({
        verdict: 'REFUSED',
        code: 'CORE_REFUSED',
        message: 'stopped',
        lease: 'lease',
      });
      writer.diagnostic({ kind: 'login-outcome', outcome: 'pass' });
    });
    const events = lines.map((line) => JSON.parse(line));
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((event) => event.seq),
      [2, 3, 4, 5, 6],
    );
    assert.deepEqual(events[1].payload, {
      kind: 'timing',
      stage: 'dispatch',
      code: 'ACTION_INTERRUPTED',
      line: 2,
      at: 220,
      acquisitionMs: 100,
      observationAgeMs: 120,
      authorizations: 1,
      nativeCode: 'RUNNER_TIMEOUT',
      nativeMutation: 'possible',
    });
    const output = lines.join('');
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes(Buffer.from(secret).toString('hex')));
    return output;
  });
  assert.equal(outputs[0], outputs[1]);
});

test('slot blocks emit their existing pass, fail and refusal outcomes without identities or values', async () => {
  for (const outcome of ['pass', 'fail', 'refused'] as const) {
    for (const secret of ['first-private-value', 'second-private-value']) {
      const privacy = new ObservedPrivacy();
      const inputs = new RunInputs({ PASSWORD: secret }, ['PASSWORD'], privacy);
      const field = screen([element('@field', 'Field', { kind: 'input', testID: 'field' })]);
      const f = walker(
        [field],
        scriptedJudge(() => ({})),
      );
      const events: unknown[] = [];
      f.deps.privacy = privacy;
      f.deps.blockOutcome = (event) => events.push(event);
      if (outcome === 'fail')
        f.deps.fill = async () => ({ ok: false, proven: false, mutation: 'none' });
      if (outcome === 'refused')
        f.deps.captureScreen = async () => {
          throw new PrivateInputCaptureError(secret);
        };
      const result = await withInputs(inputs, () =>
        runPlan(parsePlan('# Private form\n1. Fill "field" with input PASSWORD').blocks!, f.deps),
      );
      assert.equal(result.verdict, { pass: 'PASS', fail: 'FAIL', refused: 'REFUSED' }[outcome]);
      assert.deepEqual(events, [{ kind: 'block-outcome', line: 2, outcome }]);
      assert.ok(!JSON.stringify({ events, result }).includes(secret));
    }
  }
});

test('slot block diagnostics are passive and absent for literal-only blocks', async () => {
  const field = screen([element('@field', 'Field', { kind: 'input', testID: 'field' })]);
  for (const slot of [false, true]) {
    const f = walker(
      [field],
      scriptedJudge(() => ({})),
    );
    let calls = 0;
    f.deps.blockOutcome = () => {
      calls++;
      throw Error('sink failed');
    };
    const result = await withInputs(
      new RunInputs({ PASSWORD: 'private-value' }, ['PASSWORD']),
      () =>
        runPlan(
          parsePlan(`1. Fill "field" with ${slot ? 'input PASSWORD' : '"literal"'}`).blocks!,
          f.deps,
        ),
    );
    assert.equal(result.verdict, 'PASS');
    assert.equal(calls, slot ? 1 : 0);
  }
});

test('a thrown input-privacy refusal reports the block refusal and preserves the original exception', async () => {
  const f = walker(
    [screen([element('@field', 'Field', { kind: 'input', testID: 'field' })])],
    scriptedJudge(() => ({})),
  );
  const error = new InputPrivacyRefusal();
  const events: unknown[] = [];
  f.deps.fill = async () => {
    throw error;
  };
  f.deps.blockOutcome = (event) => events.push(event);
  await assert.rejects(
    withInputs(new RunInputs({ PASSWORD: 'private-value' }, ['PASSWORD']), () =>
      runPlan(parsePlan('1. Fill "field" with input PASSWORD').blocks!, f.deps),
    ),
    (caught) => caught === error,
  );
  assert.deepEqual(events, [{ kind: 'block-outcome', line: 1, outcome: 'refused' }]);
});

test('slot dispatches emit measured timing and outcomes through the wire, independent of the input value', async () => {
  const outputs: string[] = [];
  for (const value of ['first-private-value', 'other-private-value']) {
    const lines: string[] = [];
    const writer = createWriter((line) => lines.push(line), 'run');
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs({ PASSWORD: value }, ['PASSWORD'], privacy);
    const field = screen([element('@field', 'Field', { kind: 'input', testID: 'field' })]);
    const f = walker(
      [field],
      scriptedJudge(() => ({})),
    );
    f.deps.privacy = privacy;
    f.deps.timing = createTimingObserver((event) =>
      writer.diagnostic({ kind: 'metric', ...event }),
    );
    f.deps.diagnostic = (event) => writer.diagnostic({ kind: 'timing', ...event });
    f.deps.blockOutcome = writer.diagnostic;
    f.deps.fill = async (_ref, text, context) => {
      assert.equal(text, value);
      context.authorize();
      return { ok: true, proven: true };
    };
    const result = await withInputs(inputs, () =>
      runPlan(parsePlan('1. Fill "field" with input PASSWORD').blocks!, f.deps),
    );
    assert.equal(result.verdict, 'PASS');
    const events = lines.map((line) => JSON.parse(line).payload);
    assert.ok(events.some((event) => event.kind === 'metric' && event.stage === 'capture'));
    assert.ok(
      events.some(
        (event) =>
          event.kind === 'timing' && event.stage === 'dispatch' && event.code === 'ACCEPTED',
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.kind === 'timing' && event.stage === 'dispatch' && event.code === 'COMPLETED',
      ),
    );
    assert.ok(events.some((event) => event.kind === 'block-outcome' && event.outcome === 'pass'));
    assert.ok(!lines.join('').includes(value));
    outputs.push(lines.join(''));
  }
  assert.equal(outputs[0], outputs[1]);
});

test('timing volume cannot suppress block and login outcomes, and ordinary runs emit no extra wire events', () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'run');
  writer.diagnostic({ kind: 'login-outcome', outcome: 'pass' });
  assert.equal(lines.length, 0);
  withInputs(new RunInputs({ PASSWORD: 'private-value' }, ['PASSWORD']), () => {
    for (let i = 0; i < 20_010; i++)
      writer.diagnostic({ kind: 'metric', stage: 'capture', edge: 'end', outcome: 'ok', at: i });
    writer.diagnostic({ kind: 'block-outcome', line: 1, outcome: 'pass' });
    writer.diagnostic({ kind: 'login-outcome', outcome: 'pass' });
  });
  assert.equal(lines.length, 20_002);
  assert.equal(JSON.parse(lines.at(-2)!).payload.kind, 'block-outcome');
  assert.equal(JSON.parse(lines.at(-1)!).payload.kind, 'login-outcome');
});
