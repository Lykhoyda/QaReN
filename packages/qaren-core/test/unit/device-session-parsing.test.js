import { test } from 'node:test';
import assert from 'node:assert/strict';

const UDID_RE = /^[0-9A-Fa-f-]{25,}$/;

function parseDeviceId(data) {
  const rawId =
    data?.deviceId ??
    data?.device_udid ??
    data?.id ??
    (typeof data?.device === 'object' ? data?.device?.id : undefined);
  return typeof rawId === 'string' && UDID_RE.test(rawId) ? rawId : undefined;
}

// ── agent-device v0.8.0 response shape (B107) ─────────────────────────

test('parses deviceId from agent-device v0.8.0 response (data.id + data.device as string)', () => {
  const data = {
    session: 'rn-agent-123',
    appName: 'com.example.app',
    appBundleId: 'com.example.app',
    platform: 'ios',
    device: 'iPhone 17 Pro',
    id: 'FC78646A-56D5-4737-9CD0-A360D622F3B3',
    device_udid: 'FC78646A-56D5-4737-9CD0-A360D622F3B3',
  };
  assert.equal(parseDeviceId(data), 'FC78646A-56D5-4737-9CD0-A360D622F3B3');
});

// ── Legacy agent-device response (data.deviceId) ──────────────────────

test('parses deviceId from legacy response (data.deviceId)', () => {
  const data = {
    deviceId: 'AAAA1111-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    device: { id: 'AAAA1111-BBBB-CCCC-DDDD-EEEEEEEEEEEE', name: 'iPhone 14' },
  };
  assert.equal(parseDeviceId(data), 'AAAA1111-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
});

// ── Older response with data.device as object ─────────────────────────

test('parses deviceId from data.device.id when device is an object', () => {
  const data = {
    device: { id: 'BBBB2222-CCCC-DDDD-EEEE-FFFFFFFFFFFF', name: 'iPad Air' },
  };
  assert.equal(parseDeviceId(data), 'BBBB2222-CCCC-DDDD-EEEE-FFFFFFFFFFFF');
});

// ── Priority: device_udid before id (R4 / multi-review consensus) ─────

test('prefers device_udid over id when both present', () => {
  const data = {
    id: 'SESSION-123',
    device_udid: 'CCCC3333-DDDD-EEEE-FFFF-000000000000',
  };
  assert.equal(parseDeviceId(data), 'CCCC3333-DDDD-EEEE-FFFF-000000000000');
});

// ── UDID validation (R4) ──────────────────────────────────────────────

test('rejects non-UDID id (session id, numeric, short string)', () => {
  assert.equal(parseDeviceId({ id: 'rn-agent-123' }), undefined);
  assert.equal(parseDeviceId({ id: '12345' }), undefined);
  assert.equal(parseDeviceId({ id: '' }), undefined);
  assert.equal(parseDeviceId({ device_udid: 'not-a-udid' }), undefined);
});

test('accepts 40-char hex physical device UDID', () => {
  const physicalUDID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  assert.equal(parseDeviceId({ id: physicalUDID }), physicalUDID);
});

// ── Edge cases ────────────────────────────────────────────────────────

test('returns undefined when data is null/undefined', () => {
  assert.equal(parseDeviceId(null), undefined);
  assert.equal(parseDeviceId(undefined), undefined);
  assert.equal(parseDeviceId({}), undefined);
});

test('returns undefined when data.device is a string (device name, not UDID)', () => {
  const data = { device: 'iPhone 17 Pro' };
  assert.equal(parseDeviceId(data), undefined);
});

test('returns undefined when data.id is a number', () => {
  const data = { id: 42 };
  assert.equal(parseDeviceId(data), undefined);
});
