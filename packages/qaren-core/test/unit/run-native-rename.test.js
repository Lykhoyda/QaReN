import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as w from '../../dist/agent-device-wrapper.js';
test('runNative exported; transition alias runAgentDevice removed', () => {
  assert.equal(typeof w.runNative, 'function');
  assert.equal(w.runAgentDevice, undefined);
});
