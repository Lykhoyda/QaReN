import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultPorts } from '../../dist/cdp/discovery.js';

const savedDiscoveryPorts = process.env.RN_CDP_DISCOVERY_PORTS;
const savedMetroPort = process.env.RN_METRO_PORT;

beforeEach(() => {
  delete process.env.RN_CDP_DISCOVERY_PORTS;
  delete process.env.RN_METRO_PORT;
});

afterEach(() => {
  if (savedDiscoveryPorts === undefined) delete process.env.RN_CDP_DISCOVERY_PORTS;
  else process.env.RN_CDP_DISCOVERY_PORTS = savedDiscoveryPorts;
  if (savedMetroPort === undefined) delete process.env.RN_METRO_PORT;
  else process.env.RN_METRO_PORT = savedMetroPort;
});

// ── GH #577: lazily-resolved discovery port defaults ───────────────────

test('resolveDefaultPorts returns built-in defaults when no env is set', () => {
  assert.deepEqual(resolveDefaultPorts(), [8081, 8082, 19000, 19006]);
});

test('resolveDefaultPorts prepends RN_METRO_PORT, read lazily at call time', () => {
  process.env.RN_METRO_PORT = '9765';
  assert.deepEqual(resolveDefaultPorts(), [9765, 8081, 8082, 19000, 19006]);
});

test('resolveDefaultPorts ignores a non-numeric RN_METRO_PORT', () => {
  process.env.RN_METRO_PORT = 'not-a-port';
  assert.deepEqual(resolveDefaultPorts(), [8081, 8082, 19000, 19006]);
});

test('RN_CDP_DISCOVERY_PORTS replaces the built-in default list entirely', () => {
  process.env.RN_CDP_DISCOVERY_PORTS = '9123, 9124';
  assert.deepEqual(resolveDefaultPorts(), [9123, 9124]);
});

test('empty RN_CDP_DISCOVERY_PORTS yields no defaults (test isolation mode)', () => {
  process.env.RN_CDP_DISCOVERY_PORTS = '';
  assert.deepEqual(resolveDefaultPorts(), []);
});

test('RN_CDP_DISCOVERY_PORTS override beats RN_METRO_PORT', () => {
  process.env.RN_METRO_PORT = '9765';
  process.env.RN_CDP_DISCOVERY_PORTS = '9123';
  assert.deepEqual(resolveDefaultPorts(), [9123]);
});

test('RN_CDP_DISCOVERY_PORTS drops invalid entries', () => {
  process.env.RN_CDP_DISCOVERY_PORTS = '9123,abc,-1,0';
  assert.deepEqual(resolveDefaultPorts(), [9123]);
});

test('RN_CDP_DISCOVERY_PORTS rejects malformed entries with numeric prefixes (whole-value parse)', () => {
  // parseInt would accept these as 9123/8081 and probe an unintended Metro.
  process.env.RN_CDP_DISCOVERY_PORTS = '9123abc,8081.5, 9124 ';
  assert.deepEqual(resolveDefaultPorts(), [9124]);
});
