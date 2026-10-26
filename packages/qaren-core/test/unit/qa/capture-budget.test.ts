import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { validateNativePresence } from '../../../dist/qa/native-presence.js';
import { CAPTURE_BUDGET_MS, NATIVE_PRESENCE_BUDGET_MS } from '../../../dist/qa/timing.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { visibilityView } from '../../../dist/qa/screen.js';
import { nativeCapture } from './platform-presence-fixtures.ts';

test('V2 admits only the exact positive integer requested budget and strict native interval', () => {
  const source = nativeCapture();
  const validate = (patch: object, requested: unknown) =>
    validateNativePresence(
      { ...source.presenceCapture, ...patch },
      source.nodes,
      7,
      'com.test',
      requested,
    );
  for (const budget of [101, 1_000, 20_000, 25_000]) {
    assert.ok(validate({ appliedBudgetMs: budget, endedUptimeMs: 100 + budget - 0.01 }, budget));
    assert.equal(
      validate({ appliedBudgetMs: budget, endedUptimeMs: 100 + budget }, budget),
      undefined,
    );
    assert.equal(
      validate({ appliedBudgetMs: budget, endedUptimeMs: 101 + budget }, budget),
      undefined,
    );
  }
  for (const requested of [
    undefined,
    null,
    0,
    -1,
    1.5,
    '20000',
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(validate({}, requested), undefined);
  for (const patch of [
    { version: 1 },
    { version: undefined },
    { version: '2' },
    { appliedBudgetMs: undefined },
    { appliedBudgetMs: 19_999 },
    { appliedBudgetMs: 20_001 },
    { appliedBudgetMs: '20000' },
    { appliedBudgetMs: null },
    { appliedBudgetMs: NaN },
  ])
    assert.equal(validate(patch, NATIVE_PRESENCE_BUDGET_MS), undefined);
});

test('capture passes the domain budget and starts before native preparation', async () => {
  for (const elapsed of [CAPTURE_BUDGET_MS - 0.01, CAPTURE_BUDGET_MS, CAPTURE_BUDGET_MS + 1]) {
    let now = 1_000;
    const screen = await captureScreen({
      now: () => now,
      appId: 'com.test',
      native: async (budget) => {
        assert.equal(budget, NATIVE_PRESENCE_BUDGET_MS);
        now += elapsed;
        return nativeCapture();
      },
      react: async () => ({
        interactive: [],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence: { hosts: [], complete: true },
      }),
    });
    assert.equal(screen.coverage?.native, elapsed < CAPTURE_BUDGET_MS ? 'complete' : 'incomplete');
  }
});

test('late join/private finalization strips semantic facts without losing private observations', async () => {
  for (const expireDuring of ['join', 'react'] as const) {
    let now = 100;
    const secret = 'late-private@example.test';
    const source = nativeCapture();
    source.nodes.push({
      ...source.nodes[1],
      ref: '@email',
      index: 2,
      type: 'TextField',
      identifier: 'email',
      label: 'Email',
      value: secret,
      presence: { ...source.nodes[1].presence, nodeIndex: 2 },
    });
    source.snapshotVerdict.nodeCount = source.nodes.length;
    const label = source.nodes[1].label;
    Object.defineProperty(source.nodes[1], 'label', {
      get() {
        if (expireDuring === 'join') now = 100 + CAPTURE_BUDGET_MS;
        return label;
      },
    });
    const screen = await captureScreen({
      now: () => now,
      appId: 'com.test',
      requirePrivateInputs: true,
      native: async () => source,
      react: async () => {
        if (expireDuring === 'react') now = 100 + CAPTURE_BUDGET_MS;
        return {
          interactive: [],
          verdict: { state: 'ok', path: 'interactive', complete: true },
          hostEvidence: {
            hosts: [
              { testID: 'save', role: 'button', roleSource: 'role', capabilities: { press: true } },
            ],
            complete: true,
          },
        };
      },
    });
    assert.equal(screen.captureCoverage?.native, 'complete', expireDuring);
    assert.equal(screen.coverage?.native, 'incomplete', expireDuring);
    assert.ok(
      screen.elements.every((element) => element.semantic === undefined),
      expireDuring,
    );
    assert.ok(screen.nativeCaptureCauses?.includes('capture-over-budget'), expireDuring);
    assert.ok('refuse' in visibilityView(screen), expireDuring);
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact(`seen ${secret}`), 'seen •••', expireDuring);
    assert.equal(privacy.canScreenshot(), false, expireDuring);
  }
});

test('expired acquisition is never usable even without a React digest', async () => {
  let now = 0;
  const screen = await captureScreen({
    now: () => now,
    appId: 'com.test',
    requirePrivateInputs: true,
    native: async () => {
      now = CAPTURE_BUDGET_MS;
      return nativeCapture();
    },
    react: async () => ({}),
  });
  assert.equal(screen.coverage?.native, 'incomplete');
  assert.ok(screen.nativeCaptureCauses?.includes('capture-over-budget'));
  assert.ok('refuse' in visibilityView(screen));
});
