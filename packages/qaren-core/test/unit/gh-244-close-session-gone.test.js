import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDeviceSession,
  isBenignSessionGoneError,
} from '../../dist/handlers/device-session-close.js';

const okClose = () => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { closed: true } }) }],
});
// Mirror the real runAgentDevice failure envelope: failResult(message, { code, hint }) puts the
// code under meta (utils.ts:67-73), so meta.code — not a top-level code — is authoritative.
const errClose = (error, code) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({ ok: false, error, ...(code ? { meta: { code } } : {}) }),
    },
  ],
  isError: true,
});

// Base deps factory: stopAndroidRunner is a no-op async spy by default.
function makeDeps(overrides = {}) {
  const calls = { clear: 0, stop: 0, stopAndroid: 0, finalize: 0, close: 0 };
  const deps = {
    hasActiveSession: () => true,
    closeUnderlyingSession: async () => {
      calls.close++;
      return okClose();
    },
    clearActiveSession: () => {
      calls.clear++;
    },
    stopFastRunner: () => {
      calls.stop++;
    },
    stopAndroidRunner: async () => {
      calls.stopAndroid++;
    },
    finalizeSuccessfulClose: async () => {
      calls.finalize++;
    },
    ...overrides,
  };
  return { deps, calls };
}

test('#244 no in-memory session → finalizes authority without underlying close', async () => {
  const { deps, calls } = makeDeps({ hasActiveSession: () => false });
  const r = await closeDeviceSession(deps);
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /No active session to close/);
  assert.equal(calls.close, 0);
  assert.equal(calls.finalize, 1);
});

test('#244 close succeeds → ok; cleanup all called once', async () => {
  const { deps, calls } = makeDeps();
  const r = await closeDeviceSession(deps);
  assert.equal(r.isError, undefined);
  assert.equal(calls.clear, 1);
  assert.equal(calls.stop, 1);
  assert.equal(calls.stopAndroid, 1);
  assert.equal(calls.finalize, 1);
  assert.equal(calls.close, 1);
});

test('#244 close finalization failure preserves session context', async () => {
  const { deps, calls } = makeDeps({
    finalizeSuccessfulClose: async () => {
      calls.finalize++;
      throw new Error('RUNNER_AUTHORITY_RELEASE_FAILED');
    },
  });

  await assert.rejects(() => closeDeviceSession(deps), /RUNNER_AUTHORITY_RELEASE_FAILED/);
  assert.equal(calls.finalize, 1);
  assert.equal(calls.clear, 0);
});

test('#244 failed runner teardown preserves session context and lock', async () => {
  const { deps, calls } = makeDeps({
    stopFastRunner: async () => {
      calls.stop++;
      throw new Error('RUNNER_ADOPTION_REQUIRED: identity unknown');
    },
  });

  await assert.rejects(() => closeDeviceSession(deps), /RUNNER_ADOPTION_REQUIRED/);
  assert.equal(calls.clear, 0);
  assert.equal(calls.stopAndroid, 0);
});

test('#244 SESSION_NOT_FOUND after a flow → ok with sessionAlreadyGone; cleanup all called', async () => {
  const { deps, calls } = makeDeps({
    closeUnderlyingSession: async () => {
      calls.close++;
      return errClose('No active session', 'SESSION_NOT_FOUND');
    },
  });
  const r = await closeDeviceSession(deps);
  assert.equal(r.isError, undefined);
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.data.sessionAlreadyGone, true);
  assert.equal(calls.clear, 1);
  assert.equal(calls.stop, 1);
  assert.equal(calls.stopAndroid, 1);
  assert.equal(calls.finalize, 1);
  assert.equal(calls.close, 1);
});

test('#244 unrelated close error → surfaced as-is; cleanup NOT called', async () => {
  const { deps, calls } = makeDeps({
    closeUnderlyingSession: async () => {
      calls.close++;
      return errClose('adb: device offline', 'BAD_RESPONSE');
    },
  });
  const r = await closeDeviceSession(deps);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /device offline/);
  assert.equal(calls.clear, 0);
  assert.equal(calls.stop, 0);
  assert.equal(calls.stopAndroid, 0);
  assert.equal(calls.close, 1);
});

test('#244 isBenignSessionGoneError matches only gone-session shapes', () => {
  assert.equal(isBenignSessionGoneError(errClose('No active session', 'SESSION_NOT_FOUND')), true); // meta.code
  assert.equal(isBenignSessionGoneError(errClose('session not found')), true); // message fallback
  assert.equal(isBenignSessionGoneError(errClose('adb: device offline', 'BAD_RESPONSE')), false);
  assert.equal(isBenignSessionGoneError(okClose()), false);
  // precision: an unrelated failure whose HINT mentions the phrase must NOT be swallowed
  const withHint = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          error: 'adb: device offline',
          meta: { code: 'BAD_RESPONSE', hint: 'no active session? call open first' },
        }),
      },
    ],
    isError: true,
  };
  assert.equal(isBenignSessionGoneError(withHint), false);
});

// B192: an UNPARSEABLE (non-JSON) payload is an unexpected upstream shape — there is no
// error field to scope the match to, so it must never classify as benign, even when the
// raw text mentions the phrase (e.g. a multi-line adb error). Surfacing it is the safe path.
test('#244/B192 non-JSON payload mentioning the phrase is NOT benign', async () => {
  const plainText = {
    content: [
      {
        type: 'text',
        text: 'adb: error: failed to close; no active session on device emulator-5554',
      },
    ],
    isError: true,
  };
  assert.equal(isBenignSessionGoneError(plainText), false);

  // and closeDeviceSession must surface it unchanged, leaving local state intact
  const { deps, calls } = makeDeps({
    closeUnderlyingSession: async () => plainText,
  });
  const r = await closeDeviceSession(deps);
  assert.equal(r.isError, true);
  assert.equal(calls.clear, 0);
  assert.equal(calls.stop, 0);
  assert.equal(calls.stopAndroid, 0);
});

// Finding 1a: stopAndroidRunner must be called on a normal successful close (dep-injection proof).
test('android close teardown: stopAndroidRunner is called on successful close', async () => {
  let androidStopCalled = false;
  const { deps } = makeDeps({
    stopAndroidRunner: async () => {
      androidStopCalled = true;
    },
  });
  const r = await closeDeviceSession(deps);
  assert.equal(r.isError, undefined);
  assert.equal(androidStopCalled, true, 'stopAndroidRunner must be called on a normal close');
});

// Finding 1a: stopAndroidRunner must also be called when the session is already gone (benign path).
test('android close teardown: stopAndroidRunner is called on SESSION_NOT_FOUND (benign gone path)', async () => {
  let androidStopCalled = false;
  const { deps } = makeDeps({
    closeUnderlyingSession: async () => errClose('No active session', 'SESSION_NOT_FOUND'),
    stopAndroidRunner: async () => {
      androidStopCalled = true;
    },
  });
  const r = await closeDeviceSession(deps);
  assert.equal(r.isError, undefined);
  assert.equal(
    androidStopCalled,
    true,
    'stopAndroidRunner must be called even when the underlying session was already gone',
  );
});

// Task 5 (Phase 2): no runAgentDevice(['close']) / runNative(['close']) literal may remain
// in device-session.ts or device-interact.ts — session close is now fully native.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(import.meta.dirname, '..', '..', 'src', 'handlers');

function sourceOf(filename) {
  return readFileSync(join(SRC_ROOT, filename), 'utf8');
}

test("Task5: no runAgentDevice(['close']) literal in device-session.ts", () => {
  const src = sourceOf('device-session.ts');
  assert.ok(
    !src.includes("runAgentDevice(['close'])") && !src.includes("runNative(['close'])"),
    'device-session.ts must not call runAgentDevice/runNative with "close"',
  );
});

test("Task5: no runAgentDevice(['close']) literal in device-interact.ts", () => {
  const src = sourceOf('device-interact.ts');
  assert.ok(
    !src.includes("runAgentDevice(['close'])") && !src.includes("runNative(['close'])"),
    'device-interact.ts must not call runAgentDevice/runNative with "close"',
  );
});

test('Task5: device-session.ts closeUnderlyingSession wired to okResult no-op (not agent-device)', () => {
  const src = sourceOf('device-session.ts');
  // The call site must NOT delegate to runAgentDevice/runNative for close
  assert.ok(
    !src.includes("closeUnderlyingSession: () => runAgentDevice(['close'])"),
    'closeUnderlyingSession must not call runAgentDevice — it should be a no-op okResult',
  );
  assert.ok(
    !src.includes("closeUnderlyingSession: () => runNative(['close'])"),
    'closeUnderlyingSession must not call runNative',
  );
});
