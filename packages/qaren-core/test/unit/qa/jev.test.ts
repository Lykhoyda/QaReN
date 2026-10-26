import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  createJev,
  JEV_ENDPOINT,
  JEV_MODEL,
  MAX_STATE_QUESTION_BYTES,
  MAX_RESPONSE_BYTES,
  retryDelay,
} from '../../../dist/qa/jev.js';
import { JevError } from '../../../dist/qa/questions.js';
import { redactApiKey } from '../../../dist/util/redact.js';

const questions = { ready: { type: 'noul' as const, instructions: 'Is ready true?' } };
const valid = {
  model: JEV_MODEL,
  answers: { ready: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 25 },
};
const key = 'fake-private-credential';
const code = (expected: string) => (error: unknown) =>
  error instanceof JevError && error.code === expected && !error.message.includes(key);

test('native HTTP contract and retry table through a local server, never the live endpoint', async (t) => {
  for (const [statuses, expected, delays] of [
    [[429, 200], undefined, [2000]],
    [[500, 503, 200], undefined, [500, 1000]],
    [[408, 529, 200], undefined, [500, 1000]],
    [[500, 500, 500], 'JEV_UNAVAILABLE', [500, 1000]],
    [[401], 'JEV_AUTH_FAILED', []],
    [[403], 'JEV_AUTH_FAILED', []],
    [[422], 'JEV_REQUEST_INVALID', []],
    [[400], 'JEV_REQUEST_INVALID', []],
    [[404], 'JEV_UNAVAILABLE', []],
  ] as const) {
    await t.test(statuses.join(','), async () => {
      let hits = 0;
      const bodies: unknown[] = [];
      const server = createServer(async (req, res) => {
        assert.equal(req.method, 'POST');
        assert.equal(req.headers.authorization, `Bearer ${key}`);
        assert.equal(req.headers['content-type'], 'application/json');
        let body = '';
        for await (const chunk of req) body += chunk;
        bodies.push(JSON.parse(body));
        const status = statuses[hits++];
        if (status === 429) res.setHeader('Retry-After', '2');
        res.writeHead(status).end(JSON.stringify(status === 200 ? valid : { secret: key }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const slept: number[] = [];
      let clock = 0;
      const judge = createJev({
        apiKey: key,
        now: () => clock,
        random: () => 0.5,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
        fetch: async (url, init) => {
          assert.equal(url, JEV_ENDPOINT);
          assert.equal(init?.redirect, 'error');
          clock += 23;
          return fetch(`http://127.0.0.1:${address.port}`, init);
        },
      });
      try {
        if (expected) await assert.rejects(judge.ask({ ready: true }, questions), code(expected));
        else assert.deepEqual(await judge.ask({ ready: true }, questions), valid.answers);
        assert.equal(hits, statuses.length);
        assert.deepEqual(slept, delays);
        assert.ok(
          bodies.every(
            (b) =>
              JSON.stringify(b) ===
              JSON.stringify({ state: { ready: true }, questions, model: JEV_MODEL }),
          ),
        );
        assert.equal(judge.calls.length, hits);
        assert.equal(judge.elapsedMs, clock);
        assert.ok(judge.calls.every((c) => c.ms === 23 && c.questionIds.join(',') === 'ready'));
        assert.equal(judge.calls.at(-1)?.inputTokens, expected ? null : 25);
        assert.ok(!JSON.stringify(judge.calls).includes(key));
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});

test('elapsed Jev time accumulates whole asks including retry backoff', async () => {
  let now = 0;
  let attempts = 0;
  const judge = createJev({
    apiKey: key,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    fetch: async () => {
      now += 100;
      return attempts++ === 0
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : Response.json(valid);
    },
  });
  assert.equal(judge.elapsedMs, 0);
  await judge.ask({}, questions);
  assert.equal(judge.elapsedMs, 2_200);
  assert.deepEqual(
    judge.calls.map((call) => call.ms),
    [100, 100],
  );
  now += 500;
  await judge.ask({}, questions);
  assert.equal(judge.elapsedMs, 2_300);
});

test('timeout covers headers and streaming body and counts every attempt', async () => {
  for (const streaming of [false, true]) {
    let attempts = 0;
    const signals: AbortSignal[] = [];
    const judge = createJev({
      apiKey: key,
      timeoutMs: 5,
      sleep: async () => {},
      fetch: async (_url, init) => {
        attempts++;
        signals.push(init!.signal!);
        if (!streaming) return new Promise<Response>(() => {});
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{'));
            },
          }),
        );
      },
    });
    await assert.rejects(judge.ask({}, questions), code('JEV_UNAVAILABLE'));
    assert.equal(attempts, 3);
    assert.equal(judge.calls.length, 3);
    assert.ok(judge.calls.every((c) => c.outcome === 'timeout'));
    assert.ok(signals.every((s) => s.aborted));
  }
});

test('network failures retry but never echo the transport error', async () => {
  const judge = createJev({
    apiKey: key,
    sleep: async () => {},
    fetch: async () => {
      throw new Error(key);
    },
  });
  await assert.rejects(judge.ask({}, questions), code('JEV_UNAVAILABLE'));
  assert.equal(judge.calls.length, 3);
});

test('invalid responses fail closed without retry', async () => {
  for (const data of [
    'not json',
    {},
    { ...valid, model: 'jev-latest' },
    { ...valid, answers: {} },
    { ...valid, usage: { input_tokens: -1 } },
    { ...valid, answers: { ...valid.answers, unexpected: {} } },
    { ...valid, answers: { ready: { type: 'noul', noul: null } } },
    { ...valid, answers: { ready: { type: 'noul', noul: 2 } } },
    { ...valid, answers: { ready: { type: 'choice', choice: 'x' } } },
    'x'.repeat(MAX_RESPONSE_BYTES + 1),
  ]) {
    const judge = createJev({
      apiKey: key,
      fetch: async () => new Response(typeof data === 'string' ? data : JSON.stringify(data)),
    });
    await assert.rejects(judge.ask({}, questions), code('JEV_RESPONSE_INVALID'));
    assert.equal(judge.calls.length, 1);
    assert.equal(judge.calls[0].outcome, 'invalid');
  }
});

test('local key, state and question budgets refuse before HTTP', async () => {
  let hits = 0;
  const fetcher: typeof fetch = async () => {
    hits++;
    throw new Error('unexpected');
  };
  await assert.rejects(
    createJev({ apiKey: '', fetch: fetcher }).ask({}, questions),
    code('JEV_AUTH_FAILED'),
  );
  const judge = createJev({ apiKey: key, fetch: fetcher });
  await assert.rejects(
    judge.ask('x'.repeat(MAX_STATE_QUESTION_BYTES), questions),
    code('JEV_REQUEST_INVALID'),
  );
  await assert.rejects(judge.ask({}, {}), code('JEV_REQUEST_INVALID'));
  const tooMany = Object.fromEntries(
    Array.from({ length: 65 }, (_, i) => [`q${i}`, questions.ready]),
  );
  await assert.rejects(judge.ask({}, tooMany), code('JEV_REQUEST_INVALID'));
  const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`e${i}`, 'element']));
  await assert.rejects(
    judge.ask({}, { t: { type: 'choice', instructions: 'Select', criteria } }),
    code('JEV_REQUEST_INVALID'),
  );
  assert.equal(hits, 0);
  assert.deepEqual(judge.calls, []);
});

test('Retry-After supports seconds and dates, is capped, and invalid headers use bounded jitter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(retryDelay('9999', 0, now, 0), 60_000);
  assert.equal(retryDelay('0', 0, now, 0), 0);
  assert.equal(retryDelay('Thu, 01 Jan 2026 00:00:03 GMT', 0, now, 0), 3000);
  for (const header of [null, '', 'garbage', '-1']) {
    assert.equal(retryDelay(header, 0, now, 0), 500);
    assert.equal(retryDelay(header, 10, now, 1), 5000);
  }
});

test('the pinned model honors Retry-After through 60 seconds and caps longer seconds and dates', async () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  for (const [header, delay] of [
    ['0', 0],
    ['2', 2000],
    ['60', 60_000],
    ['61', 60_000],
    ['9999', 60_000],
    ['Thu, 01 Jan 2026 00:00:03 GMT', 3000],
    ['Thu, 01 Jan 2026 00:01:00 GMT', 60_000],
    ['Thu, 01 Jan 2026 01:00:00 GMT', 60_000],
  ] as const) {
    const slept: number[] = [];
    let attempts = 0;
    let clock = 0;
    const judge = createJev({
      apiKey: key,
      now: () => clock,
      wallNow: () => now,
      random: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      fetch: async (url, init) => {
        assert.equal(url, JEV_ENDPOINT);
        assert.equal(JSON.parse(String(init?.body)).model, 'jev-1.13.0');
        attempts++;
        clock += 7;
        return attempts === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': header } })
          : Response.json(valid);
      },
    });
    assert.deepEqual(await judge.ask({ ready: true }, questions), valid.answers);
    assert.deepEqual(slept, [delay], header);
    assert.equal(attempts, 2);
    assert.deepEqual(
      judge.calls.map((call) => call.ms),
      [7, 7],
    );
  }
});

test('retry-after-ms takes precedence and falls back to Retry-After or backoff when invalid', async (t) => {
  for (const [milliseconds, seconds, delay] of [
    ['1500', null, 1500],
    ['125.5', null, 125.5],
    ['1500', '7', 1500],
    ['0', '7', 0],
    ['60000', '7', 60_000],
    ['999999', '7', 60_000],
    ['', '2', 2000],
    ['   ', '2', 2000],
    ['garbage', '2', 2000],
    ['100ms', '2', 2000],
    ['-1', '2', 2000],
    ['NaN', '2', 2000],
    ['Infinity', '2', 2000],
    ['1e309', '2', 2000],
    ['garbage', 'Thu, 01 Jan 2026 00:00:03 GMT', 3000],
    ['garbage', null, 500],
    ['-1', 'garbage', 500],
  ] as const) {
    await t.test(
      `${JSON.stringify(milliseconds)} ms, ${JSON.stringify(seconds)} seconds`,
      async () => {
        const slept: number[] = [];
        let attempts = 0;
        const judge = createJev({
          apiKey: key,
          wallNow: () => Date.parse('2026-01-01T00:00:00Z'),
          random: () => 0.5,
          sleep: async (ms) => {
            slept.push(ms);
          },
          fetch: async () => {
            attempts++;
            const headers = new Headers({ 'retry-after-ms': milliseconds });
            if (seconds !== null) headers.set('Retry-After', seconds);
            return attempts === 1
              ? new Response('', { status: 429, headers })
              : Response.json(valid);
          },
        });
        assert.deepEqual(await judge.ask({}, questions), valid.answers);
        assert.deepEqual(slept, [delay]);
        assert.equal(attempts, 2);
      },
    );
  }
});

test('literal API key redaction handles both plain and JSON-encoded secrets', () => {
  const secret = 'opaque"key\\value';
  assert.ok(!redactApiKey(`secret=${secret}`, secret).includes(secret));
  assert.ok(!redactApiKey(JSON.stringify({ secret }), secret).includes('opaque'));
});
