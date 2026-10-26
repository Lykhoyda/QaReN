// Story 05 (#386): cheap wedged-runtime detector. Taps that produce no hierarchy
// change on N DISTINCT targets in a row suggest the app runtime is swallowing
// touches (paused JS thread / wedged simulator). In-memory by design.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordNoUiChange,
  recordUiChange,
  WEDGED_DISTINCT_TARGETS,
  WEDGED_RUNTIME_HINT,
  _resetNoChangeStreakForTest,
} from '../../dist/lifecycle/no-change-tracker.js';

beforeEach(() => _resetNoChangeStreakForTest());

test('distinct targets accumulate; same target does not', () => {
  assert.equal(recordNoUiChange('tap@10,10'), 1);
  assert.equal(recordNoUiChange('tap@10,10'), 1);
  assert.equal(recordNoUiChange('tap@20,20'), 2);
  assert.equal(recordNoUiChange('tap@30,30'), 3);
  assert.equal(WEDGED_DISTINCT_TARGETS, 3);
});

test('a UI change resets the streak', () => {
  recordNoUiChange('tap@10,10');
  recordNoUiChange('tap@20,20');
  recordUiChange();
  assert.equal(recordNoUiChange('tap@30,30'), 1);
});

test('hint names the recovery tools', () => {
  assert.match(WEDGED_RUNTIME_HINT, /cdp_status/);
  assert.match(WEDGED_RUNTIME_HINT, /cdp_restart/);
});

test('clearActiveSession resets the no-change streak (source wiring)', () => {
  const agentDeviceWrapperPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'src',
    'agent-device-wrapper.ts',
  );
  const src = readFileSync(agentDeviceWrapperPath, 'utf8');

  // Extract the clearActiveSession function body — from the function declaration
  // to the closing brace of the function.
  const m = src.match(/export function clearActiveSession\(\):\s*void\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'clearActiveSession function not found in agent-device-wrapper.ts');
  const functionBody = m[1];

  assert.match(
    functionBody,
    /recordUiChange\(\)/,
    'clearActiveSession must call recordUiChange() to reset the no-change streak',
  );

  // Verify recordUiChange is called after or near clearRefMap to confirm wiring
  assert.match(
    functionBody,
    /clearRefMap\(\)[\s\S]*?recordUiChange\(\)|recordUiChange\(\)[\s\S]*?clearRefMap\(\)/,
    'recordUiChange() should be called alongside clearRefMap() to ensure proper cleanup',
  );
});
