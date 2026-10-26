import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';

test('expiry latches before dispatch and cannot be erased by a swallowed error', () => {
  let now = 10;
  const context = new QaDispatchContext(10, () => now);
  assert.throws(() => context.authorize(), { code: 'EVIDENCE_EXPIRED' });
  now = 5;
  assert.throws(() => context.authorize(), { code: 'EVIDENCE_EXPIRED' });
  assert.equal(context.authorizations, 0);
  assert.equal(context.refusal?.code, 'EVIDENCE_EXPIRED');
});

test('expiry after a send retains the authorization count', () => {
  let now = 1;
  const context = new QaDispatchContext(10, () => now);
  context.authorize();
  now = 10;
  assert.throws(() => context.authorize(), { code: 'EVIDENCE_EXPIRED' });
  assert.equal(context.authorizations, 1);
});

test('late completion does not retroactively refuse a fully dispatched command', () => {
  let now = 1;
  const context = new QaDispatchContext(10, () => now);
  context.authorize();
  now = 20;
  context.assertComplete();
  assert.equal(context.refusal, undefined);
});

test('cancellation and invalidation latch content-free refusals', () => {
  let cancelled = false;
  const context = new QaDispatchContext(
    10,
    () => 1,
    () => cancelled,
  );
  cancelled = true;
  assert.throws(() => context.check(), { code: 'RUN_CANCELLED' });
  cancelled = false;
  assert.throws(() => context.assertComplete(), { code: 'RUN_CANCELLED' });
  const changed = new QaDispatchContext(10, () => 1);
  assert.throws(() => changed.invalidate(), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.throws(() => changed.authorize(), { code: 'ACTION_CONTEXT_CHANGED' });
});

test('invalid clocks and deadlines refuse before dispatch', () => {
  for (const deadline of [NaN, Infinity, -1]) {
    const context = new QaDispatchContext(deadline, () => 0);
    assert.throws(() => context.authorize(), { code: 'ACTION_CONTEXT_CHANGED' });
  }
  const context = new QaDispatchContext(10, () => NaN);
  assert.throws(() => context.authorize(), { code: 'ACTION_CONTEXT_CHANGED' });
});

test('a runner-attested no-mutation invalidation of the only send is a refusal before mutation', () => {
  const attested = new QaDispatchContext(10, () => 1);
  attested.authorize();
  assert.throws(() => attested.invalidate(true), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.throws(() => attested.authorize(), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.equal(attested.refusedBeforeMutation, true);

  const unattested = new QaDispatchContext(10, () => 1);
  unattested.authorize();
  assert.throws(() => unattested.invalidate(), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.equal(unattested.refusedBeforeMutation, false);

  const twice = new QaDispatchContext(10, () => 1);
  twice.authorize();
  twice.authorize();
  assert.throws(() => twice.invalidate(true), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.equal(twice.refusedBeforeMutation, false);

  let now = 1;
  const expired = new QaDispatchContext(10, () => now);
  expired.authorize();
  now = 10;
  assert.throws(() => expired.authorize(), { code: 'EVIDENCE_EXPIRED' });
  assert.throws(() => expired.invalidate(true), { code: 'EVIDENCE_EXPIRED' });
  assert.equal(expired.refusedBeforeMutation, false);
});

test('expired probes the time budget like check() without recording a refusal', () => {
  let now = 0;
  const live = new QaDispatchContext(10, () => now);
  assert.equal(live.expired, false);
  now = 10;
  assert.equal(live.expired, true);
  assert.equal(live.refusal, undefined);
  for (const deadline of [Infinity, Number.NaN, -1])
    assert.equal(new QaDispatchContext(deadline, () => 0).expired, true);
  assert.equal(new QaDispatchContext(10, () => Number.NaN).expired, true);
  const cancelled = new QaDispatchContext(
    10,
    () => 0,
    () => true,
  );
  assert.equal(cancelled.expired, false);
  assert.throws(() => cancelled.check(), { code: 'RUN_CANCELLED' });
});

test('refusal diagnostics preserve only the first refusal and never infer attestation', () => {
  const context = new QaDispatchContext(10, () => 1);
  context.authorize();
  const facts = {
    stage: 'native-response',
    mutating: true,
    responseOk: false,
    nativeCode: 'KEYBOARD_TARGET_STALE',
    nativeReason: 'exact-target-missing',
    nativeMutation: 'none',
    probeState: 'failed',
    recovery: 'recovered-error',
    message: 'PRIVATE-message',
    commandId: 'PRIVATE-id',
    data: { value: 'PRIVATE-data' },
  };
  assert.throws(
    () =>
      context.diagnoseRefusal(
        () => facts,
        () => context.invalidate(),
      ),
    {
      code: 'ACTION_CONTEXT_CHANGED',
    },
  );
  const first = context.refusalDiagnostic;
  assert.deepEqual(first, {
    refusal: 'ACTION_CONTEXT_CHANGED',
    stage: 'native-response',
    mutating: true,
    responseOk: false,
    nativeCode: 'KEYBOARD_TARGET_STALE',
    nativeReason: 'exact-target-missing',
    nativeMutation: 'none',
    probeState: 'failed',
    recovery: 'recovered-error',
  });
  facts.nativeCode = 'PRIVATE-change';
  assert.throws(() =>
    context.diagnoseRefusal(
      () => ({ stage: 'dispatch-error', mutating: false }),
      () => context.refuse('ACTION_OUTCOME_UNCERTAIN'),
    ),
  );
  assert.equal(context.refusalDiagnostic, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(context.refusedBeforeMutation, false);
  assert.equal(context.authorizations, 1);
  assert.ok(!JSON.stringify(first).includes('PRIVATE-'));
});

test('missing, malformed and accessor diagnostic facts stay unknown without changing refusal', () => {
  let reads = 0;
  for (const facts of [
    undefined,
    null,
    'PRIVATE-canary',
    [],
    {},
    {
      stage: 'PRIVATE-stage',
      mutating: 0,
      responseOk: 'false',
      nativeCode: 'STALE_REF PRIVATE',
      nativeReason: 'exact-target-PRIVATE',
      nativeMutation: false,
      probeState: 'PRIVATE-probe',
      recovery: 'PRIVATE-recovery',
    },
    Object.defineProperty({}, 'nativeCode', {
      get() {
        reads++;
        throw Error('PRIVATE');
      },
    }),
    Object.create({ nativeCode: 'STALE_REF' }),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error('PRIVATE-proxy');
        },
      },
    ),
  ]) {
    const context = new QaDispatchContext(10, () => 1);
    assert.throws(
      () =>
        context.diagnoseRefusal(
          () => facts,
          () => context.refuse('ACTION_OUTCOME_UNCERTAIN'),
        ),
      { code: 'ACTION_OUTCOME_UNCERTAIN' },
    );
    assert.deepEqual(context.refusalDiagnostic, {
      refusal: 'ACTION_OUTCOME_UNCERTAIN',
      stage: null,
      mutating: null,
      responseOk: null,
      nativeCode: null,
      nativeReason: null,
      nativeMutation: null,
      probeState: null,
      recovery: null,
    });
  }
  assert.equal(reads, 0);
  const context = new QaDispatchContext(10, () => 1);
  assert.equal(
    context.diagnoseRefusal(
      () => assert.fail('no successful-path fact read'),
      () => 42,
    ),
    42,
  );
  assert.equal(context.refusalDiagnostic, undefined);
  const error = Error('PRIVATE-error');
  assert.throws(
    () =>
      context.diagnoseRefusal(
        () => ({}),
        () => {
          throw error;
        },
      ),
    (e) => e === error,
  );
  assert.equal(context.refusal, undefined);
  assert.throws(
    () =>
      context.diagnoseRefusal(
        () => {
          throw Error('PRIVATE-projection');
        },
        () => context.invalidate(),
      ),
    { code: 'ACTION_CONTEXT_CHANGED' },
  );
  assert.equal(context.refusalDiagnostic?.nativeCode, null);
});

test('a prior refusal without diagnostics cannot acquire a later cause', () => {
  const context = new QaDispatchContext(10, () => 10);
  assert.throws(() => context.authorize(), { code: 'EVIDENCE_EXPIRED' });
  assert.throws(
    () =>
      context.diagnoseRefusal(
        () => assert.fail('no later cause'),
        () => context.invalidate(true),
      ),
    { code: 'EVIDENCE_EXPIRED' },
  );
  assert.equal(context.refusalDiagnostic, undefined);
  assert.equal(context.refusedBeforeMutation, false);
});

test('diagnostics validate a runtime refusal code without altering the thrown error', () => {
  const context = new QaDispatchContext(10, () => 1);
  assert.throws(
    () =>
      context.diagnoseRefusal(
        () => ({}),
        () => Reflect.apply(context.refuse, context, ['PRIVATE-invalid-code']),
      ),
    { code: 'PRIVATE-invalid-code' },
  );
  assert.equal(context.refusalDiagnostic?.refusal, null);
  assert.ok(!JSON.stringify(context.refusalDiagnostic).includes('PRIVATE-'));
});
