import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunIOSArgs } from '../../dist/agent-device-wrapper.js';

test('buildRunIOSArgs type forwards --delay-ms', () => {
  const a = buildRunIOSArgs(['fill', '@email', 'hello', '--delay-ms', '40'], 'com.x.app');
  assert.equal(a.command, 'type');
  assert.equal(a.text, 'hello');
  assert.equal(a.delayMs, 40);
});
test('buildRunIOSArgs type forwards --clear-first (presence flag)', () => {
  const a = buildRunIOSArgs(
    ['fill', '@email', 'hello', '--clear-first', '--delay-ms', '40'],
    'com.x.app',
  );
  assert.equal(a.clearFirst, true);
  assert.equal(a.delayMs, 40);
  assert.equal(a.text, 'hello');
});
test('buildRunIOSArgs type without flags omits both', () => {
  const a = buildRunIOSArgs(['fill', '@email', 'hello'], 'com.x.app');
  assert.equal(a.delayMs, undefined);
  assert.equal(a.clearFirst, undefined);
  assert.equal(a.text, 'hello');
});
