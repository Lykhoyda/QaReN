import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCommandId,
  isMutatingCommand,
  isAmbiguousTransportFailure,
  parseStatusProbeReply,
  decideRecovery,
} from '../../dist/runners/transport-recovery.js';

test('generateCommandId returns unique non-empty ids', () => {
  const a = generateCommandId();
  const b = generateCommandId();
  assert.ok(a.length > 8);
  assert.notEqual(a, b);
});

test('mutating classification: every gesture/typing/lifecycle verb is mutating', () => {
  for (const c of [
    'tap',
    'type',
    'drag',
    'swipe',
    'scroll',
    'longPress',
    'pinch',
    'back',
    'keyboardDismiss',
    'dismissKeyboard',
    'keyboard',
    'press',
    'fill',
    'tapSeries',
    'dragSeries',
    'mouseClick',
    'remotePress',
    'home',
    'pressHome',
    'backInApp',
    'backSystem',
    'rotate',
    'appSwitcher',
    'systemAlertTap',
    'activate',
    'terminate',
    'shutdown',
  ]) {
    assert.equal(isMutatingCommand(c), true, `${c} must be mutating`);
  }
  for (const c of [
    'snapshot',
    'screenshot',
    'findText',
    'readText',
    'isScreenStatic',
    'isWindowUpdating',
    'appState',
    'uptime',
    'interactionFrame',
    'status',
  ]) {
    assert.equal(isMutatingCommand(c), false, `${c} must be read-only`);
  }
});

test('the removed positional alert verb is not a known mutating command', () => {
  assert.equal(isMutatingCommand('alert'), false);
});

test('ambiguity: pre-send and protocol failures are NOT ambiguous', () => {
  assert.equal(isAmbiguousTransportFailure('rn-android-runner not started'), false);
  assert.equal(
    isAmbiguousTransportFailure('rn-fast-runner not started — run device_snapshot'),
    false,
  );
  assert.equal(
    isAmbiguousTransportFailure('RUNNER_PROTOCOL_MISMATCH: runner replied with wire protocol v9'),
    false,
  );
  assert.equal(
    isAmbiguousTransportFailure(
      'RUNNER_TIMEOUT: rn-fast-runner did not respond to "tap" within 10000ms',
    ),
    true,
  );
  assert.equal(isAmbiguousTransportFailure('fetch failed'), true);
  assert.equal(isAmbiguousTransportFailure('socket hang up'), true);
  assert.equal(
    isAmbiguousTransportFailure('rn-android-runner returned a non-JSON response body'),
    true,
  );
});

test('parseStatusProbeReply extracts state and result from a status reply', () => {
  assert.deepEqual(
    parseStatusProbeReply(
      {
        ok: true,
        data: {
          commandId: 'c-1',
          state: 'completed',
          result: { ok: true, data: { tapped: true } },
        },
      },
      'c-1',
    ),
    { state: 'completed', result: { ok: true, data: { tapped: true } } },
  );
  assert.deepEqual(
    parseStatusProbeReply({ ok: true, data: { commandId: 'c-1', state: 'unknown' } }, 'c-1'),
    { state: 'unknown' },
  );
  assert.equal(
    parseStatusProbeReply(
      { ok: false, error: { code: 'UNSUPPORTED_COMMAND', message: 'x' } },
      'c-1',
    ),
    null,
  );
  assert.equal(parseStatusProbeReply({ ok: true, data: { state: 'sideways' } }, 'c-1'), null);
  assert.equal(parseStatusProbeReply(undefined, 'c-1'), null);
});

test('parseStatusProbeReply rejects mismatched commandId echo and malformed results', () => {
  assert.equal(
    parseStatusProbeReply({ ok: true, data: { commandId: 'c-OTHER', state: 'completed' } }, 'c-1'),
    null,
  );
  assert.deepEqual(
    parseStatusProbeReply(
      { ok: true, data: { commandId: 'c-1', state: 'completed', result: 'not-an-object' } },
      'c-1',
    ),
    { state: 'completed' },
  );
  assert.deepEqual(
    parseStatusProbeReply(
      { ok: true, data: { commandId: 'c-1', state: 'completed', result: { data: {} } } },
      'c-1',
    ),
    { state: 'completed' },
  );
});

test('decideRecovery: completed+retained returns recovered response, never resends', () => {
  const recorded = { ok: true, v: 1, data: { tapped: true } };
  assert.deepEqual(decideRecovery({ state: 'completed', result: recorded }, 'tap'), {
    action: 'return-recovered',
    response: recorded,
    outcome: 'recovered',
  });
});

test('decideRecovery: failed+retained surfaces the recorded runner error', () => {
  const recorded = { ok: false, v: 1, error: { code: 'RUNNER_ERROR', message: 'boom' } };
  assert.deepEqual(decideRecovery({ state: 'failed', result: recorded }, 'tap'), {
    action: 'return-recovered',
    response: recorded,
    outcome: 'recovered-error',
  });
});

test('decideRecovery: completed without retained body resends read-only, rethrows mutating', () => {
  assert.deepEqual(decideRecovery({ state: 'completed' }, 'snapshot'), { action: 'resend-once' });
  assert.deepEqual(decideRecovery({ state: 'completed' }, 'screenshot'), { action: 'resend-once' });
  assert.deepEqual(decideRecovery({ state: 'completed' }, 'tap'), { action: 'rethrow' });
});

test('decideRecovery: unknown/failed-unretained/null probes rethrow', () => {
  assert.deepEqual(decideRecovery({ state: 'unknown' }, 'snapshot'), { action: 'rethrow' });
  assert.deepEqual(decideRecovery({ state: 'failed' }, 'tap'), { action: 'rethrow' });
  assert.deepEqual(decideRecovery(null, 'tap'), { action: 'rethrow' });
});
