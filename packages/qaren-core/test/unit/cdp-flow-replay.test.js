import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSteps,
  ReplayDispatchError,
  UnsupportedStepError,
  replayFlow,
} from '../../dist/domain/cdp-flow-replay.js';

test('normalizeSteps maps the supported subset with ${VAR} interpolation', () => {
  const body = [
    { launchApp: { stopApp: false } },
    { tapOn: { id: 'wizard-title-input' } },
    { inputText: '${TITLE}' },
    { assertVisible: { id: 'wizard-step-1' } },
    { tapOn: { id: 'wizard-priority-${PRIORITY}' } },
    'waitForAnimationToEnd',
    {
      runFlow: {
        when: { visible: { id: 'onboarding-screen' } },
        commands: [{ tapOn: { id: 'onboarding-done' } }],
      },
    },
  ];
  const steps = normalizeSteps(body, { TITLE: 'Ship it', PRIORITY: 'high' });
  assert.deepEqual(steps, [
    { t: 'launch', stopApp: false },
    { t: 'tap', id: 'wizard-title-input' },
    { t: 'type', text: 'Ship it' },
    { t: 'waitVisible', id: 'wizard-step-1', timeoutMs: 17_000, evidenceType: 'assert' },
    { t: 'tap', id: 'wizard-priority-high' },
    { t: 'wait', timeoutMs: 400 },
    {
      t: 'runFlow',
      whenVisible: 'onboarding-screen',
      commands: [{ t: 'tap', id: 'onboarding-done' }],
    },
  ]);
});

test('normalizeSteps resolves Maestro-style nullish string defaults', () => {
  assert.deepEqual(normalizeSteps([{ inputText: "${LOGIN_EMAIL ?? 'safe@example.test'}" }], {}), [
    { t: 'type', text: 'safe@example.test' },
  ]);
  assert.deepEqual(
    normalizeSteps([{ inputText: "${LOGIN_EMAIL ?? 'safe@example.test'}" }], {
      LOGIN_EMAIL: 'bound@example.test',
    }),
    [{ t: 'type', text: 'bound@example.test' }],
  );
});

test('normalizeSteps throws UnsupportedStepError on an unknown step', () => {
  assert.throws(
    () => normalizeSteps([{ scroll: { direction: 'DOWN' } }], {}),
    (e) => {
      assert.ok(e instanceof UnsupportedStepError);
      assert.equal(e.stepKey, 'scroll');
      return true;
    },
  );
});

test('normalizeSteps rejects malformed supported steps (never a silent "undefined" target)', () => {
  assert.throws(() => normalizeSteps([{ tapOn: {} }], {}), UnsupportedStepError); // missing id
  assert.throws(() => normalizeSteps([{ tapOn: null }], {}), UnsupportedStepError); // null value
  assert.throws(() => normalizeSteps([{ inputText: { id: 'x' } }], {}), UnsupportedStepError); // not a string
  assert.throws(() => normalizeSteps([{ tapOn: { id: 'a' }, extra: 1 }], {}), UnsupportedStepError); // >1 key
  assert.throws(() => normalizeSteps([42], {}), UnsupportedStepError); // non-object
});

test('id visibility commands normalize to one timed wait operation', () => {
  assert.deepEqual(
    normalizeSteps(
      [
        { extendedWaitUntil: { visible: { id: 'otp' } } },
        { extendedWaitUntil: { visible: { id: 'slow-otp' }, timeout: 750 } },
        { assertVisible: { id: 'complete' } },
      ],
      {},
    ),
    [
      { t: 'waitVisible', id: 'otp', timeoutMs: 17_000 },
      { t: 'waitVisible', id: 'slow-otp', timeoutMs: 750 },
      { t: 'waitVisible', id: 'complete', timeoutMs: 17_000, evidenceType: 'assert' },
    ],
  );
});

test('unsupported extended wait variants remain loud refusals', () => {
  for (const command of [
    { extendedWaitUntil: { visible: { id: 'otp' }, timeout: -1 } },
    { extendedWaitUntil: { visible: { id: 'otp' }, timeout: Number.POSITIVE_INFINITY } },
    { extendedWaitUntil: { visible: { id: 'otp' }, timeout: '750' } },
    { extendedWaitUntil: { visible: { id: 'otp' }, timeout: 750, extra: true } },
    { extendedWaitUntil: { notVisible: { id: 'otp' }, timeout: 750 } },
    { extendedWaitUntil: { visible: { text: 'One-time code' }, timeout: 750 } },
    { extendedWaitUntil: { visible: { id: { regex: 'otp.*' } }, timeout: 750 } },
  ]) {
    assert.throws(() => normalizeSteps([command], {}), UnsupportedStepError);
  }
});

function mockDispatch(over = {}) {
  const calls = [];
  return {
    calls,
    press: async (id) => {
      calls.push(['press', id]);
      if (over.pressThrows?.includes(id)) throw new Error('disabled');
    },
    type: async (id, text) => {
      calls.push(['type', id, text]);
    },
    visibility: async (id) => {
      calls.push(['visibility', id]);
      return { visible: over.visible ? over.visible.includes(id) : true };
    },
    launch: async (stopApp) => {
      calls.push(['launch', stopApp]);
    },
    settle: async (timeoutMs) => {
      calls.push(['settle', timeoutMs]);
    },
  };
}

test('waitForAnimationToEnd preserves its configured timeout', async () => {
  const steps = normalizeSteps([{ waitForAnimationToEnd: { timeout: 2_500 } }], {});
  assert.deepEqual(steps, [{ t: 'wait', timeoutMs: 2_500 }]);
  const dispatch = mockDispatch();
  const result = await replayFlow(steps, dispatch);
  assert.equal(result.passed, true);
  assert.deepEqual(dispatch.calls, [['settle', 2_500]]);
});

test('replayFlow happy path: type routes to last tapped, all pass', async () => {
  const d = mockDispatch();
  const r = await replayFlow(
    [
      { t: 'tap', id: 'title' },
      { t: 'type', text: 'Hi' },
      { t: 'waitVisible', id: 'step-2', timeoutMs: 17_000 },
    ],
    d,
  );
  assert.equal(r.passed, true);
  assert.deepEqual(d.calls, [
    ['press', 'title'],
    ['type', 'title', 'Hi'],
    ['visibility', 'step-2'],
  ]);
});

test('replayFlow can resume a proven React focus across proof-domain segments', async () => {
  const d = mockDispatch();
  const r = await replayFlow([{ t: 'type', text: 'Hi' }], d, {
    initialFocusId: 'title',
  });
  assert.equal(r.passed, true);
  assert.deepEqual(d.calls, [['type', 'title', 'Hi']]);
});

test('replayFlow runFlow recurses only when whenVisible present', async () => {
  const d = mockDispatch({ visible: ['onboarding', 'tabs'] });
  const r = await replayFlow(
    [
      { t: 'runFlow', whenVisible: 'onboarding', commands: [{ t: 'tap', id: 'done' }] },
      { t: 'waitVisible', id: 'tabs', timeoutMs: 17_000 },
    ],
    d,
  );
  assert.equal(r.passed, true);
  assert.deepEqual(
    r.steps.map((step) => step.sourceIndex),
    [0, 1],
  );
});

test('replayFlow fails when a conditional visibility proof is ambiguous', async () => {
  let mutated = false;
  const dispatch = mockDispatch();
  dispatch.visibility = async () => ({
    visible: false,
    code: 'AMBIGUOUS_TESTID',
    reason: 'condition resolves to multiple elements',
  });
  dispatch.press = async () => {
    mutated = true;
  };
  const result = await replayFlow(
    [{ t: 'runFlow', whenVisible: 'condition', commands: [{ t: 'tap', id: 'nested' }] }],
    dispatch,
  );
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'AMBIGUOUS_TESTID');
  assert.equal(mutated, false);
});

test('replayFlow skips a conditional flow when its target is conclusively absent', async () => {
  let mutated = false;
  const dispatch = mockDispatch();
  dispatch.visibility = async () => ({
    visible: false,
    code: 'TESTID_NOT_FOUND',
    reason: 'condition is absent',
  });
  dispatch.press = async () => {
    mutated = true;
  };
  const result = await replayFlow(
    [{ t: 'runFlow', whenVisible: 'condition', commands: [{ t: 'tap', id: 'nested' }] }],
    dispatch,
  );
  assert.equal(result.passed, true);
  assert.equal(mutated, false);
});

test('replayFlow cannot pass when an awaited final dispatch exceeds its deadline', async () => {
  const controller = new AbortController();
  const dispatch = mockDispatch();
  dispatch.visibility = async () => {
    controller.abort(new Error('deadline'));
    return { visible: true };
  };
  const result = await replayFlow(
    [{ t: 'waitVisible', id: 'final', timeoutMs: 17_000 }],
    dispatch,
    {
      signal: controller.signal,
    },
  );
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'RUNNER_TIMEOUT');
});

test('waitVisible aborts a stalled visibility read at the outer replay deadline', async () => {
  const controller = new AbortController();
  const dispatch = mockDispatch();
  dispatch.visibility = async () => new Promise(() => {});
  const startedAt = Date.now();
  setTimeout(() => controller.abort(new Error('deadline')), 20);
  const result = await replayFlow(
    [{ t: 'waitVisible', id: 'stalled', timeoutMs: 17_000 }],
    dispatch,
    { signal: controller.signal },
  );
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'RUNNER_TIMEOUT');
  assert.ok(Date.now() - startedAt < 500);
});

test('replayFlow fails the step when a target is disabled (no false green)', async () => {
  const d = mockDispatch({ pressThrows: ['save'] });
  const r = await replayFlow([{ t: 'tap', id: 'save' }], d);
  assert.equal(r.passed, false);
  assert.equal(r.failedStepIndex, 0);
});

test('replayFlow fails a zero-budget visibility wait when the target is absent', async () => {
  const r = await replayFlow(
    [{ t: 'waitVisible', id: 'ghost', timeoutMs: 0 }],
    mockDispatch({ visible: [] }),
  );
  assert.equal(r.passed, false);
});

test('waitVisible polls readable absence, then continues without replaying a prefix', async () => {
  let reads = 0;
  const dispatch = mockDispatch();
  dispatch.visibility = async (id) => {
    dispatch.calls.push(['visibility', id]);
    reads += 1;
    return {
      visible: reads >= 3,
      code: reads >= 3 ? undefined : 'TESTID_NOT_FOUND',
      meta: { failedSelector: id },
    };
  };
  const result = await replayFlow(
    [
      { t: 'waitVisible', id: 'otp', timeoutMs: 1_000 },
      { t: 'tap', id: 'otp' },
    ],
    dispatch,
    { indexOffset: 4 },
  );
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.steps.map(({ sourceIndex, t, ok }) => ({ sourceIndex, t, ok })),
    [
      { sourceIndex: 4, t: 'waitVisible', ok: true },
      { sourceIndex: 5, t: 'tap', ok: true },
    ],
  );
  assert.deepEqual(dispatch.calls, [
    ['visibility', 'otp'],
    ['visibility', 'otp'],
    ['visibility', 'otp'],
    ['press', 'otp'],
  ]);
});

test('id-based assertVisible uses the same timed polling semantics', async () => {
  let reads = 0;
  const dispatch = mockDispatch();
  dispatch.visibility = async (id) => {
    reads += 1;
    return {
      visible: reads >= 2,
      code: reads >= 2 ? undefined : 'TESTID_NOT_FOUND',
      meta: { failedSelector: id },
    };
  };
  const result = await replayFlow(
    normalizeSteps([{ assertVisible: { id: 'complete' } }], {}),
    dispatch,
  );
  assert.equal(result.passed, true);
  assert.equal(reads, 2);
  assert.equal(result.steps[0].t, 'assert');
  assert.ok(result.steps[0].durationMs >= 150);
});

test('waitVisible reports no observation distinctly and does not dispatch its suffix', async () => {
  const dispatch = mockDispatch();
  dispatch.visibility = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { visible: false, code: 'TESTID_NOT_FOUND' };
  };
  const result = await replayFlow(
    [
      { t: 'waitVisible', id: 'unobserved', timeoutMs: 5 },
      { t: 'tap', id: 'must-not-dispatch' },
    ],
    dispatch,
  );
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'RUNNER_TIMEOUT');
  assert.equal(result.failureMeta?.failedSelector, 'unobserved');
  assert.equal(result.steps[0].ok, false);
  assert.equal(
    dispatch.calls.some((call) => call[0] === 'press'),
    false,
  );
});

test('failed waitVisible preserves source index, selector, elapsed wait, and stops the suffix', async () => {
  const dispatch = mockDispatch({ visible: [] });
  const result = await replayFlow(
    [
      { t: 'waitVisible', id: 'missing-otp', timeoutMs: 250 },
      { t: 'tap', id: 'must-not-dispatch' },
    ],
    dispatch,
    { indexOffset: 7 },
  );
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'TESTID_NOT_FOUND');
  assert.equal(result.failedStepIndex, 7);
  assert.equal(result.failureMeta?.failedSelector, 'missing-otp');
  assert.ok(result.failureMeta?.waitedMs >= 200);
  assert.ok(result.failureMeta?.waitedMs < 1_000);
  assert.deepEqual(
    result.steps.map(({ sourceIndex, t, ok }) => ({ sourceIndex, t, ok })),
    [{ sourceIndex: 7, t: 'waitVisible', ok: false }],
  );
  assert.equal(
    dispatch.calls.some((call) => call[0] === 'press'),
    false,
  );
});

test('waitVisible cannot pass from an oracle result completed after its deadline', async () => {
  let reads = 0;
  const dispatch = mockDispatch();
  dispatch.visibility = async () => {
    reads += 1;
    if (reads === 1) return { visible: false, code: 'TESTID_NOT_FOUND' };
    await new Promise((resolve) => setTimeout(resolve, 75));
    return { visible: true };
  };
  const startedAt = Date.now();
  const result = await replayFlow([{ t: 'waitVisible', id: 'late', timeoutMs: 250 }], dispatch);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'TESTID_NOT_FOUND');
  assert.equal(reads, 2);
  assert.ok(elapsedMs >= 225 && elapsedMs < 500, `deadline completed after ${elapsedMs}ms`);
});

test('waitVisible discards an oracle rejection completed after its deadline', async () => {
  const dispatch = mockDispatch();
  dispatch.visibility = async () => {
    const blockedUntil = Date.now() + 30;
    while (Date.now() < blockedUntil) {}
    throw new ReplayDispatchError('RECONNECT_TIMEOUT', 'stale transport refusal');
  };
  const result = await replayFlow([{ t: 'waitVisible', id: 'late-error', timeoutMs: 5 }], dispatch);
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'RUNNER_TIMEOUT');
  assert.doesNotMatch(result.reason ?? '', /stale transport refusal/);
});

test('waitVisible preserves an oracle rejection completed before its deadline', async () => {
  const dispatch = mockDispatch();
  dispatch.visibility = async () => {
    throw new ReplayDispatchError('RECONNECT_TIMEOUT', 'current transport refusal', {
      reconnectAttempted: true,
    });
  };
  const result = await replayFlow(
    [{ t: 'waitVisible', id: 'current-error', timeoutMs: 100 }],
    dispatch,
  );
  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'RECONNECT_TIMEOUT');
  assert.equal(result.reason, 'current transport refusal');
  assert.equal(result.failureMeta?.reconnectAttempted, true);
});

test('waitVisible preserves finite timeouts above Node timer range', async () => {
  const dispatch = mockDispatch();
  dispatch.visibility = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { visible: true };
  };
  const result = await replayFlow(
    [{ t: 'waitVisible', id: 'slow', timeoutMs: 3_000_000_000 }],
    dispatch,
  );
  assert.equal(result.passed, true);
  assert.ok(result.steps[0].durationMs >= 20);
});
