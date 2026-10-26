import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReadySignal,
  createReadySignalParser,
} from '../../dist/runners/rn-fast-runner-client.js';

// The imported rn-fast-runner XCTest replaced the legacy single-line
// `FASTXCT_READY {"port":N}` JSON signal with a two-line NSLog handshake:
//   RN_FAST_RUNNER_LISTENER_READY
//   RN_FAST_RUNNER_PORT=<port>
// These tests exercise the pure parser without spawning xcodebuild.

test('parseReadySignal returns null when input is empty', () => {
  assert.equal(parseReadySignal(''), null);
});

test('parseReadySignal returns null when only READY seen, no port yet', () => {
  assert.equal(parseReadySignal('RN_FAST_RUNNER_LISTENER_READY\n'), null);
});

test('parseReadySignal resolves with port on full two-line handshake', () => {
  const buf =
    'Test Suite started\n' + 'RN_FAST_RUNNER_LISTENER_READY\n' + 'RN_FAST_RUNNER_PORT=22088\n';
  const result = parseReadySignal(buf);
  assert.deepEqual(result, { ready: true, port: 22088 });
});

test('parseReadySignal handles NSLog timestamp/process prefix on marker lines', () => {
  const buf =
    '2026-05-15 12:00:00.123 xctest[12345:67890] RN_FAST_RUNNER_LISTENER_READY\n' +
    '2026-05-15 12:00:00.124 xctest[12345:67890] RN_FAST_RUNNER_PORT=33001\n';
  const result = parseReadySignal(buf);
  assert.deepEqual(result, { ready: true, port: 33001 });
});

test('parseReadySignal rejects with error on LISTENER_FAILED marker', () => {
  const buf =
    'RN_FAST_RUNNER_DESIRED_PORT=22088\n' +
    'RN_FAST_RUNNER_LISTENER_FAILED=POSIXErrorCode(rawValue: 48): Address in use\n';
  const result = parseReadySignal(buf);
  assert.deepEqual(result, { error: 'RN_FAST_RUNNER_LISTENER_FAILED' });
});

test('parseReadySignal rejects with error on PORT_NOT_SET marker', () => {
  const buf = 'RN_FAST_RUNNER_LISTENER_READY\n' + 'RN_FAST_RUNNER_PORT_NOT_SET\n';
  const result = parseReadySignal(buf);
  assert.deepEqual(result, { error: 'RN_FAST_RUNNER_PORT_NOT_SET' });
});

test('parseReadySignal ignores legacy FASTXCT_READY signal', () => {
  // Defensive: if a stale runner ever speaks the old shape, we should not
  // misinterpret it. Parser stays in "waiting for READY" state.
  const buf = 'FASTXCT_READY {"port":22088}\n';
  assert.equal(parseReadySignal(buf), null);
});

test('createReadySignalParser handles chunked input across feed calls', () => {
  const parser = createReadySignalParser();
  // Chunk 1: noise + partial READY line (no newline yet).
  assert.equal(parser.feed('xcodebuild noise here\nRN_FAST_RUN'), null);
  // Chunk 2: completes the READY line. Still no port.
  assert.equal(parser.feed('NER_LISTENER_READY\n'), null);
  // Chunk 3: port arrives split across two feeds.
  assert.equal(parser.feed('RN_FAST_RUNNER_PORT='), null);
  // Chunk 4: closes the port line — resolves.
  const result = parser.feed('22088\nmore output\n');
  assert.deepEqual(result, { ready: true, port: 22088 });
});

test('createReadySignalParser detects LISTENER_FAILED before READY', () => {
  const parser = createReadySignalParser();
  const result = parser.feed('Test Case started\n' + 'RN_FAST_RUNNER_LISTENER_FAILED=Some error\n');
  assert.deepEqual(result, { error: 'RN_FAST_RUNNER_LISTENER_FAILED' });
});

test('createReadySignalParser handles CRLF line endings', () => {
  const parser = createReadySignalParser();
  const result = parser.feed('RN_FAST_RUNNER_LISTENER_READY\r\n' + 'RN_FAST_RUNNER_PORT=44444\r\n');
  assert.deepEqual(result, { ready: true, port: 44444 });
});
