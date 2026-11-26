// AI-711: an unavailable read-only hit probe records one fixed word saying why it gave no answer (walker side).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QaDispatchError } from '../../../dist/domain/qa-dispatch.js';
import { covered, fake, walked } from './live-hit-reason-fixtures.ts';

test('control: the later full-width node cuts the bottom of the visible band', async () => {
  const { checks } = await walked(fake(async () => 'unavailable'));
  assert.deepEqual(checks[0].predicate.cutter, {
    ref: '@e9',
    kind: 'other',
    frame: { x: 0, y: 116, width: 402, height: 758 },
    edge: 'bottom',
    before: { top: 0, bottom: 782 },
    after: { top: 0, bottom: 116 },
  });
});

for (const word of [
  'deadline',
  'ambiguous',
  'absent',
  'stale-ref',
  'runner-refused',
  'unreported',
] as const) {
  test(`B1: an unavailable read reported as ${word} is recorded with that word`, async () => {
    const { outcome, checks } = await walked(
      fake(async () => ({ result: 'unavailable', reason: word })),
    );
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].liveHit, 'unavailable');
    assert.equal(checks[0].liveCheckReason, word);
  });
}

test('B2: two same-label titles are not identifiable; no read is asked and the word says so', async () => {
  let asked = 0;
  const { checks } = await walked(
    fake(
      async () => {
        asked++;
        return 'hittable';
      },
      () => covered({ titles: 2 }),
    ),
  );
  assert.equal(asked, 0);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((check) => check.liveCheckReason === 'not-identifiable'));
});

test('B3: an older adapter answering a bare word records no reason', async () => {
  const { checks } = await walked(fake(async () => 'unavailable'));
  assert.equal(checks.length, 1);
  assert.ok(!('liveCheckReason' in checks[0]));
  // A malformed bare answer is kept as given, so the hit cache and the decision see what they saw before.
  const odd = await walked(fake(async () => 'bogus' as never));
  assert.equal(odd.checks[0].liveHit, 'bogus');
  assert.ok(!('liveCheckReason' in odd.checks[0]));
});

test('B4: an unlisted word, a non-word and a word on an answered read are not recorded', async () => {
  for (const reason of ['private-text', 42]) {
    const r = await walked(fake(async () => ({ result: 'unavailable', reason: reason as never })));
    assert.ok(r.checks.length === 1 && !('liveCheckReason' in r.checks[0]));
    assert.ok(!JSON.stringify(r.outcome.rows).includes('private-text'));
  }
  for (const result of ['hittable', 'not-hittable', 'moved'] as const) {
    const answered = await walked(fake(async () => ({ result, reason: 'deadline' })));
    assert.equal(answered.checks[0].liveHit, result);
    assert.ok(!('liveCheckReason' in answered.checks[0]), result);
  }
  const odd = await walked(fake(async () => ({ result: 'bogus' as never, reason: 'deadline' })));
  assert.deepEqual(
    [odd.checks[0].liveHit, odd.checks[0].liveCheckReason],
    ['unavailable', 'deadline'],
  );
});

test('B5: a positive read still passes the Wait and records no word', async () => {
  const { outcome, checks } = await walked(fake(async () => ({ result: 'hittable' })));
  assert.equal(outcome.block.outcome, 'pass');
  assert.ok(
    checks.length === 1 && checks[0].liveHit === 'hittable' && !('liveCheckReason' in checks[0]),
  );
});

test('B6: a read that throws, or outlives its deadline, is threw or late', async () => {
  const thrown = await walked(
    fake(async () => {
      throw new Error('reset');
    }),
  );
  assert.equal(thrown.checks[0].liveCheckReason, 'threw');
  let now = 0;
  const after = fake(async (_ref, context) => {
    now = context.deadline + 1;
    return 'hittable';
  });
  after.deps.now = () => (now += 100);
  assert.equal((await walked(after)).checks[0].liveCheckReason, 'late');
  // the timer wins: the read never answers; the first capture ends 100 ms before the Wait's 15 s deadline
  let clock = 0;
  let jumped = false;
  const hung = fake(() => new Promise(() => undefined));
  const capture = hung.deps.captureScreen;
  hung.deps.captureScreen = async (options) => {
    if (!jumped) {
      jumped = true;
      clock += 14_700;
    }
    return capture(options);
  };
  hung.deps.now = () => (clock += 10);
  const started = Date.now();
  const timed = await walked(hung);
  assert.ok(Date.now() - started < 5_000, 'the read was cut off by its own short timer');
  assert.ok(
    timed.checks.length >= 1 && timed.checks.every((check) => check.liveCheckReason === 'late'),
  );
});

test('B7: no adapter on iOS, and a capture without a native generation, name themselves', async () => {
  assert.equal((await walked(fake())).checks[0].liveCheckReason, 'no-reader');
  const unversioned = await walked(
    fake(
      async () => assert.fail('no read'),
      () => covered({ generation: null }),
    ),
  );
  assert.equal(unversioned.checks[0].liveCheckReason, 'no-generation');
});

test('B8: an inferred-overlay Fill whose read is unavailable keeps its refusal, mutates nothing, and records the word', async () => {
  const f = fake(
    async () => ({ result: 'unavailable', reason: 'deadline' }),
    () => covered({ type: 'TextField' }),
  );
  const { outcome, checks } = await walked(f, '1. Fill "field" with "x"\n');
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(
    f.calls.filter((c) => c !== 'capture'),
    [],
  );
  assert.ok(checks.length >= 1 && checks.every((check) => check.liveCheckReason === 'deadline'));
});

test('B9: a runner-gate refusal is runner-refused even after the deadline, thrown or recorded', async () => {
  let now = 0;
  const thrown = fake(async (_ref, context) => {
    now = context.deadline + 1;
    throw new QaDispatchError('ACTION_CONTEXT_CHANGED');
  });
  thrown.deps.now = () => (now += 100);
  assert.equal((await walked(thrown)).checks[0].liveCheckReason, 'runner-refused');
  const recorded = fake(async (_ref, context) => {
    assert.throws(() => context.invalidate());
    return 'hittable';
  });
  assert.equal((await walked(recorded)).checks[0].liveCheckReason, 'runner-refused');
});

test('B10: a reason word changes no decision: Wait, scroll-until and Fill rows equal a bare unavailable read but for the word', async () => {
  const strip = (value: unknown) =>
    JSON.parse(JSON.stringify(value, (key, v) => (key === 'liveCheckReason' ? undefined : v)));
  for (const [line, type] of [
    ['1. Wait for "Heading"\n', 'StaticText'],
    ['1. Scroll down until "Heading"\n', 'StaticText'],
    ['1. Fill "field" with "x"\n', 'TextField'],
  ] as const) {
    const run = async (probe: Parameters<typeof fake>[0]) => {
      const f = fake(probe, () => covered({ type }));
      const { outcome } = await walked(f, line);
      return { outcome, calls: f.calls };
    };
    const bare = await run(async () => 'unavailable');
    const worded = await run(async () => ({ result: 'unavailable', reason: 'deadline' }));
    assert.ok(JSON.stringify(worded.outcome.rows).includes('"liveCheckReason":"deadline"'));
    assert.deepEqual(strip(worded), strip(bare));
  }
});
