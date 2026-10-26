import { test } from 'node:test';
import assert from 'node:assert/strict';

test('device_press handler forwards retryIfNoChange:false into runNative opts', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDevicePressHandler } = await import('../../dist/handlers/device-interact.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const calls = [];
  _setRunAgentDeviceForTest(async (cliArgs, opts) => {
    calls.push({ cliArgs, opts });
    return okResult({});
  });
  try {
    const handler = createDevicePressHandler();
    await handler({ ref: 'e3', retryIfNoChange: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.retryIfNoChange, false);
    await handler({ ref: 'e3' });
    assert.equal(calls[1].opts.retryIfNoChange, undefined);
    await handler({ x: 120, y: 700, retryIfNoChange: false });
    assert.deepEqual(calls[2].cliArgs, ['press', '120', '700']);
    assert.equal(calls[2].opts.retryIfNoChange, false);
    const invalid = await handler({ ref: 'e3', x: 120, y: 700 });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 3, 'ambiguous target must not dispatch');
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('device_longpress handler forwards retryIfNoChange:false', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceLongPressHandler } = await import('../../dist/handlers/device-interact.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const calls = [];
  _setRunAgentDeviceForTest(async (cliArgs, opts) => {
    calls.push({ cliArgs, opts });
    return okResult({});
  });
  try {
    await createDeviceLongPressHandler()({ ref: 'e3', retryIfNoChange: false });
    assert.equal(calls[0].opts.retryIfNoChange, false);
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});
