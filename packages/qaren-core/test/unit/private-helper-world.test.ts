import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { CDPClient } from '../../dist/cdp-client.js';
import { HELPERS_VERSION } from '../../dist/injected-helpers.js';

const sentinel = 'PRIVATE_TEST_VALUE_DO_NOT_LOG';
const failure = 'Private helper world unavailable';
type Request = {
  id: number;
  method: string;
  params: {
    expression: string;
    contextId?: number;
    returnByValue?: boolean;
    awaitPromise?: boolean;
  };
};

function connected(respond: (request: Request, reply: (result: unknown) => void) => void) {
  const client = new CDPClient();
  client.setLifecycleAuthority(() => false);
  const requests: Request[] = [];
  const receive = (response: unknown) =>
    Reflect.get(client, 'handleMessage').call(client, Buffer.from(JSON.stringify(response)));
  const ws = {
    readyState: 1,
    send(text: string) {
      const request = JSON.parse(text) as Request;
      requests.push(request);
      respond(request, (result) => receive({ id: request.id, result }));
    },
  };
  Reflect.set(client, 'ws', ws);
  Reflect.set(client, '_state', 'connected');
  Reflect.set(client, '_connectedTarget', { id: 'fake-target' });
  const replace = (id = 7, uniqueId = 'first') => {
    Reflect.get(client, 'handleExecutionContextCreated').call(client, {
      context: { id, uniqueId },
    });
    Reflect.set(client, '_helpersInjected', true);
  };
  replace();
  return { client, requests, receive, replace, ws };
}

function sanitized(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message, failure);
  assert.equal(error.cause, undefined);
  assert.equal(inspect(error).includes(sentinel), false);
  return true;
}

test('private port pins freshness and synchronous values to one context across delay', async () => {
  const { client, requests } = connected((request, reply) => {
    setTimeout(
      () =>
        reply({
          result: {
            value: request.params.expression.includes('__v')
              ? HELPERS_VERSION
              : { facts: [sentinel] },
          },
        }),
      2,
    );
  });
  const value = await client.withPrivateHelperWorld(async (evaluate) => {
    const start = await evaluate('begin()', 50);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await evaluate('poll()', 40);
    return start;
  });
  assert.deepEqual(value, { facts: [sentinel] });
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.method, 'Runtime.evaluate');
    assert.equal(request.params.contextId, 7);
    assert.equal(request.params.returnByValue, true);
    assert.equal(request.params.awaitPromise, undefined);
    assert.equal(request.params.expression.includes('__rn_agent_async_'), false);
    assert.equal(request.params.expression.includes(sentinel), false);
  }
  assert.equal(inspect(client, { depth: 8 }).includes(sentinel), false);
  assert.equal(Reflect.get(client, 'pending').size, 0);
});

test('private evaluator cannot escape its operation lifetime', async () => {
  const { client, requests } = connected((_, reply) =>
    reply({ result: { value: HELPERS_VERSION } }),
  );
  const evaluate = await client.withPrivateHelperWorld(async (evaluate) => evaluate);
  await assert.rejects(evaluate('late()', 20), sanitized);
  assert.equal(requests.length, 1);
});

test('not connected or not injected refuses before any dispatch', async () => {
  for (const field of ['_state', '_helpersInjected']) {
    const { client, requests } = connected(() => assert.fail('no dispatch'));
    Reflect.set(client, field, field === '_state' ? 'disconnected' : false);
    await assert.rejects(
      client.withPrivateHelperWorld(async () => assert.fail('no operation')),
      sanitized,
    );
    assert.equal(requests.length, 0);
  }
});

test('freshness requires the exact helper version without reinjection', async () => {
  for (const value of [null, HELPERS_VERSION - 1, HELPERS_VERSION + 1, String(HELPERS_VERSION)]) {
    const { client, requests } = connected((_, reply) => reply({ result: { value } }));
    await assert.rejects(
      client.withPrivateHelperWorld(async () => assert.fail('no operation')),
      sanitized,
    );
    assert.equal(requests.length, 1);
  }
});

test('context replacement during freshness or evaluation rejects late old-world success', async () => {
  for (const replaceAt of [1, 2]) {
    let release!: () => void;
    const { client, requests, replace } = connected((request, reply) => {
      const value = request.params.expression.includes('__v') ? HELPERS_VERSION : sentinel;
      if (request.id === replaceAt) release = () => reply({ result: { value } });
      else reply({ result: { value } });
    });
    const operation = client.withPrivateHelperWorld(async (evaluate) => evaluate('begin()', 100));
    while (!release) await Promise.resolve();
    replace(7, 'replacement-same-numeric-id');
    release();
    await assert.rejects(operation, sanitized);
    assert.equal(requests.length, replaceAt);
  }
});

test('world replacement between polls and after operation never commits stale evidence', async () => {
  for (const pollAfter of [false, true]) {
    const { client, requests, replace } = connected((request, reply) =>
      reply({ result: { value: request.id === 1 ? HELPERS_VERSION : sentinel } }),
    );
    await assert.rejects(
      client.withPrivateHelperWorld(async (evaluate) => {
        await evaluate('begin()', 30);
        replace(9);
        if (pollAfter) await evaluate('poll()', 30);
        return sentinel;
      }),
      sanitized,
    );
    assert.equal(requests.length, 2);
  }
});

test('socket or target replacement refuses without dispatching into the new world', async () => {
  for (const replace of [
    (client: CDPClient) => Reflect.set(client, 'ws', { readyState: 1 }),
    (client: CDPClient) => Reflect.set(client, '_connectedTarget', { id: 'different-target' }),
  ]) {
    const { client, requests } = connected((_, reply) =>
      reply({ result: { value: HELPERS_VERSION } }),
    );
    await assert.rejects(
      client.withPrivateHelperWorld(async (evaluate) => {
        replace(client);
        return evaluate('begin()', 30);
      }),
      sanitized,
    );
    assert.equal(requests.length, 1);
  }
});

test('a failed private evaluation poisons the operation even if its caller catches it', async () => {
  const { client, requests } = connected((request, reply) =>
    reply(
      request.id === 1
        ? { result: { value: HELPERS_VERSION } }
        : { exceptionDetails: { text: sentinel } },
    ),
  );
  await assert.rejects(
    client.withPrivateHelperWorld(async (evaluate) => {
      await evaluate('begin()', 30).catch(() => {});
      return sentinel;
    }),
    sanitized,
  );
  assert.equal(requests.length, 2);
});

test('exceptions and malformed evaluation envelopes never escape as raw details', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  for (const response of [
    { result: { value: sentinel }, exceptionDetails: { text: sentinel } },
    { result: { value: sentinel }, exceptionDetails: null },
    { result: { value: sentinel }, error: sentinel },
    { result: { error: sentinel } },
    null,
    [],
    { result: null },
  ]) {
    const { client } = connected((request, reply) =>
      reply(request.id === 1 ? { result: { value: HELPERS_VERSION } } : response),
    );
    await assert.rejects(
      client.withPrivateHelperWorld((evaluate) => evaluate('begin()', 30)),
      sanitized,
    );
    assert.equal(inspect(client, { depth: 8 }).includes(sentinel), false);
  }
  assert.equal(log.mock.callCount(), 0);
});

test('protocol errors including malformed error fields are fixed private refusals', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  for (const error of [
    { code: -1, message: sentinel },
    sentinel,
    null,
    false,
    { message: { private: sentinel } },
  ]) {
    const { client, receive } = connected((request, reply) => {
      if (request.id === 1) reply({ result: { value: HELPERS_VERSION } });
      else
        queueMicrotask(() =>
          receive({ id: request.id, error, result: { result: { value: sentinel } } }),
        );
    });
    await assert.rejects(
      client.withPrivateHelperWorld((evaluate) => evaluate('begin()', 30)),
      sanitized,
    );
    assert.equal(Reflect.get(client, 'pending').size, 0);
    assert.equal(inspect(client, { depth: 8 }).includes(sentinel), false);
  }
  assert.equal(log.mock.callCount(), 0);
});

test('malformed JSON logs only a constant diagnostic and times out safely', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const { client } = connected((request, reply) => {
    if (request.id === 1) reply({ result: { value: HELPERS_VERSION } });
    else
      Reflect.get(client, 'handleMessage').call(
        client,
        Buffer.from(`{"private":"${sentinel}" BROKEN`),
      );
  });
  await assert.rejects(
    client.withPrivateHelperWorld((evaluate) => evaluate('begin()', 10)),
    sanitized,
  );
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [['CDP: malformed message, ignoring']],
  );
  assert.equal(Reflect.get(client, 'pending').size, 0);
});

test('socket failure and operation errors have no raw cause and no retry', async () => {
  const { client, requests, ws } = connected((_, reply) =>
    reply({ result: { value: HELPERS_VERSION } }),
  );
  await assert.rejects(
    client.withPrivateHelperWorld(async (evaluate) => {
      ws.send = () => {
        throw new Error(sentinel);
      };
      await evaluate('begin()', 30);
    }),
    sanitized,
  );
  assert.equal(requests.length, 1);
  assert.equal(Reflect.get(client, 'pending').size, 0);
  const other = connected((_, reply) => reply({ result: { value: HELPERS_VERSION } }));
  await assert.rejects(
    other.client.withPrivateHelperWorld(async () => {
      throw new Error(sentinel);
    }),
    sanitized,
  );
});
