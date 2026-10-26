import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  replayFlow,
  type ReplayDispatch,
  type ReplayPressResult,
} from '../../dist/domain/cdp-flow-replay.js';

function dispatchFor(options: { designations?: string[]; nonInputs?: string[] } = {}): {
  dispatch: ReplayDispatch;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    dispatch: {
      async press(id): Promise<ReplayPressResult> {
        calls.push(['press', id]);
        return options.designations?.includes(id)
          ? { kind: 'designation', focusOnly: true, token: `designation-${id}` }
          : { kind: 'press' };
      },
      async type(id, text, context) {
        calls.push(['type', id, text, context?.designationToken ?? '']);
        if (options.nonInputs?.includes(id)) throw new Error('not a text input');
      },
      async releaseDesignation(token) {
        calls.push(['release', token]);
      },
      async visibility(id) {
        calls.push(['visibility', id]);
        return { visible: true };
      },
      async launch() {},
      async settle() {},
    },
  };
}

test('a TextInput designation is consumed only by the adjacent type step', async () => {
  const { dispatch, calls } = dispatchFor({ designations: ['email'] });
  const result = await replayFlow(
    [
      { t: 'tap', id: 'email' },
      { t: 'type', text: 'person@example.test' },
      { t: 'type', text: '.invalid' },
    ],
    dispatch,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 2);
  assert.match(result.reason ?? '', /designation for "email" was already consumed/);
  assert.equal(result.steps[0].focusOnly, true);
  assert.deepEqual(calls, [
    ['press', 'email'],
    ['type', 'email', 'person@example.test', 'designation-email'],
    ['release', 'designation-email'],
  ]);
});

test('an aborted designation remains focusOnly in the failed tap trace', async () => {
  const controller = new AbortController();
  const { dispatch, calls } = dispatchFor({ designations: ['email'] });
  const press = dispatch.press;
  dispatch.press = async (id) => {
    const result = await press(id);
    controller.abort();
    return result;
  };
  const result = await replayFlow([{ t: 'tap', id: 'email' }], dispatch, {
    signal: controller.signal,
  });

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'RUNNER_TIMEOUT');
  assert.equal(result.steps[0].ok, false);
  assert.equal(result.steps[0].focusOnly, true);
  assert.deepEqual(calls, [
    ['press', 'email'],
    ['release', 'designation-email'],
  ]);
});

test('a non-input tap invalidates an earlier TextInput designation', async () => {
  const { dispatch, calls } = dispatchFor({
    designations: ['email'],
    nonInputs: ['continue'],
  });
  const result = await replayFlow(
    [
      { t: 'tap', id: 'email' },
      { t: 'tap', id: 'continue' },
      { t: 'type', text: 'must-not-reach-email' },
    ],
    dispatch,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 2);
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(result.steps[1].focusOnly, undefined);
  assert.deepEqual(calls, [
    ['press', 'email'],
    ['release', 'designation-email'],
    ['press', 'continue'],
    ['type', 'continue', 'must-not-reach-email', ''],
  ]);
});

test('an unconsumed designation refuses instead of masquerading as a successful tap', async () => {
  const { dispatch, calls } = dispatchFor({ designations: ['email'] });
  const result = await replayFlow([{ t: 'tap', id: 'email' }], dispatch);

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /must be followed immediately by inputText/);
  assert.equal(result.steps[0].focusOnly, true);
  assert.deepEqual(calls, [
    ['press', 'email'],
    ['release', 'designation-email'],
  ]);
});

test('an assertion cannot clear an unconsumed TextInput designation', async () => {
  const { dispatch, calls } = dispatchFor({ designations: ['email'] });
  const result = await replayFlow(
    [
      { t: 'tap', id: 'email' },
      { t: 'waitVisible', id: 'continue', timeoutMs: 1_000, evidenceType: 'assert' },
    ],
    dispatch,
  );

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 0);
  assert.equal(result.failureCode, 'INTERACTION_NOT_ACTUATED');
  assert.match(result.reason ?? '', /must be followed immediately by inputText/);
  assert.equal(result.steps[0].focusOnly, true);
  assert.equal(result.steps[1].ok, true);
  assert.deepEqual(calls, [
    ['press', 'email'],
    ['release', 'designation-email'],
    ['visibility', 'continue'],
  ]);
});
