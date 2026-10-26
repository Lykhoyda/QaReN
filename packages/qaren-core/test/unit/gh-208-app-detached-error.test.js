import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { discover, AppDetachedError } from '../../dist/cdp/discovery.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// metroPort: the port whose /status returns `packager-status:running` (null = none).
// targets: the array returned by that port's /json/list.
function mockFetch({ metroPort, targets }) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/status')) {
      const isMetro = metroPort != null && u.includes(`:${metroPort}/`);
      return { ok: true, text: async () => (isMetro ? 'packager-status:running' : '') };
    }
    if (u.endsWith('/json/list')) {
      return { ok: true, json: async () => targets };
    }
    throw new Error('unexpected fetch url: ' + u);
  };
}

// RC2 (GH #208): Metro up but 0 Hermes targets must throw a distinct, typed
// AppDetachedError — NOT the generic "No Hermes debug target found" and
// crucially NOT "Metro not found" (the reporter's misleading symptom: the
// real cause was a detached app, while the error claimed Metro was missing).
test('discover throws AppDetachedError when Metro is up but advertises 0 targets', async () => {
  mockFetch({ metroPort: 8081, targets: [] });
  await assert.rejects(
    () => discover(8081),
    (err) => {
      assert.ok(err instanceof AppDetachedError, 'error should be an AppDetachedError instance');
      assert.equal(err.name, 'AppDetachedError', 'error name should be AppDetachedError');
      assert.equal(err.port, 8081, 'should carry the Metro port it found');
      assert.match(err.message, /0 Hermes|not attached|detached/i);
      assert.doesNotMatch(err.message, /Metro not found/i, 'must NOT claim Metro is missing');
      return true;
    },
  );
});

// Regression guard: the genuine "no Metro on any port" case keeps its message.
test('discover still throws "Metro not found" when no port serves Metro', async () => {
  mockFetch({ metroPort: null, targets: [] });
  await assert.rejects(() => discover(8081), /Metro not found on ports/);
});
