import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBundleId } from '../../dist/project-config.js';

// resolveBundleId reads app.json/app.config.js from cwd to extract the bundle ID.
// In the test environment (cdp-bridge dir), there's no app.json, so it should
// return null gracefully.

test('resolveBundleId returns null when no app.json exists', () => {
  const result = resolveBundleId('ios');
  assert.equal(result, null);
});

test('resolveBundleId returns null for android when no app.json exists', () => {
  const result = resolveBundleId('android');
  assert.equal(result, null);
});

test('resolveBundleId accepts string platform argument', () => {
  // Should not throw even with valid platform strings
  assert.doesNotThrow(() => resolveBundleId('ios'));
  assert.doesNotThrow(() => resolveBundleId('android'));
});
