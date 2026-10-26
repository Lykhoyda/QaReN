import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJev, JEV_MODEL } from '../../../dist/qa/jev.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { element, screen, walker } from './judgment-fixtures.ts';

const questions = { ready: { type: 'noul' as const, instructions: 'Is ready true?' } };
const valid = {
  model: JEV_MODEL,
  answers: { ready: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 25 },
};

test('an expired operation sends nothing and fabricates no call', async () => {
  let sends = 0;
  const judge = createJev({
    apiKey: 'test',
    now: () => 10,
    fetch: async () => {
      sends++;
      return Response.json(valid);
    },
  });
  await assert.rejects(judge.ask({}, questions, 'walk', 10), { code: 'JEV_DEADLINE_EXCEEDED' });
  assert.equal(sends, 0);
  assert.deepEqual(judge.calls, []);
});

test('a successful HTTP judgment completing at the deadline is not usable', async () => {
  let now = 1;
  const judge = createJev({
    apiKey: 'test',
    now: () => now,
    fetch: async () => {
      now = 10;
      return Response.json(valid);
    },
  });
  await assert.rejects(judge.ask({}, questions, 'walk', 10), { code: 'JEV_DEADLINE_EXCEEDED' });
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.calls[0].outcome, 'ok');
});

test('deadline clipping covers headers and body without retry', async () => {
  for (const body of [false, true]) {
    let sends = 0;
    let signal: AbortSignal | undefined;
    const judge = createJev({
      apiKey: 'test',
      now: () => 0,
      fetch: async (_url, init) => {
        sends++;
        signal = init!.signal!;
        return body
          ? new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode('{'));
                },
              }),
            )
          : new Promise<Response>(() => {});
      },
    });
    await assert.rejects(judge.ask({}, questions, 'walk', 5), { code: 'JEV_DEADLINE_EXCEEDED' });
    assert.equal(sends, 1);
    assert.equal(judge.calls[0].outcome, 'deadline');
    assert.equal(signal?.aborted, true);
  }
});

test('all attempts and backoff share one unchanged deadline', async () => {
  let now = 0;
  let sends = 0;
  const sleeps: number[] = [];
  const judge = createJev({
    apiKey: 'test',
    now: () => now,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    fetch: async () => {
      sends++;
      now += 100;
      return sends === 3 ? Response.json(valid) : new Response('', { status: 503 });
    },
  });
  assert.deepEqual(await judge.ask({}, questions, 'walk', 2000), valid.answers);
  assert.deepEqual(sleeps, [500, 1000]);
  assert.equal(sends, 3);
  assert.equal(now, 1800);
});

test('a server backoff that cannot fit is unavailable, not a freshness refresh', async () => {
  for (const headers of [{ 'Retry-After': '10' }, { 'retry-after-ms': '10000' }]) {
    let sends = 0;
    const judge = createJev({
      apiKey: 'test',
      now: () => 0,
      sleep: async () => assert.fail('must not sleep'),
      fetch: async () => {
        sends++;
        return new Response('', { status: 429, headers });
      },
    });
    await assert.rejects(judge.ask({}, questions, 'walk', 10_000), { code: 'JEV_UNAVAILABLE' });
    assert.equal(sends, 1);
    assert.equal(judge.calls[0].diagnostic, 'retry-after-outside-window');
    assert.equal(judge.calls[0].outcome, 'http');
  }
});

test('overslept retry delay ends before another fetch with no extra call', async () => {
  let now = 0;
  const judge = createJev({
    apiKey: 'test',
    now: () => now,
    random: () => 0.5,
    sleep: async () => {
      now = 1000;
    },
    fetch: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(judge.ask({}, questions, 'walk', 1000), { code: 'JEV_DEADLINE_EXCEEDED' });
  assert.equal(judge.calls.length, 1);
});

test('a rate-limit response crossing the deadline cannot authorize recapture', async () => {
  let now = 0;
  let sends = 0;
  const judge = createJev({
    apiKey: 'test',
    now: () => now,
    sleep: async () => assert.fail('must not sleep'),
    fetch: async () => {
      sends++;
      now = 10_000;
      return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
    },
  });
  await assert.rejects(judge.ask({}, questions, 'walk', 10_000), { code: 'JEV_UNAVAILABLE' });
  assert.equal(sends, 1);
  assert.equal(judge.calls[0].outcome, 'http');
  assert.equal(judge.calls[0].diagnostic, 'retry-after-outside-window');
});

test('the real walker and transport do not refresh around a late rate limit', async () => {
  let now = 0;
  let sends = 0;
  const judge = createJev({
    apiKey: 'test',
    now: () => now,
    fetch: async () => {
      sends++;
      now += 10_000;
      return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
    },
  });
  const fixture = walker([screen([element('@ready', 'Ready')])], judge);
  fixture.deps.now = () => now;
  const result = await runPlan(parsePlan('✓ The screen is ready').blocks!, fixture.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /JEV_UNAVAILABLE/);
  assert.equal(fixture.captures(), 1);
  assert.equal(sends, 1);
});
