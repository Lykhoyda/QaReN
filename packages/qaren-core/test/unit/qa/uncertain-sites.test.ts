import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every product refusal with this code, in source order, with the reason it must name.
const SITES: Record<string, string[]> = {
  'runners/keyboard-guard.ts': ['keyboard-visible'],
  'runners/qaren-ios-runner-client.ts': [
    'dispatch-unconfirmed',
    'alert-blocked',
    'dispatch-unconfirmed',
    'dispatch-unconfirmed',
    'dispatch-unconfirmed',
    'keyboard-visible',
    'dispatch-unconfirmed',
    'dispatch-unconfirmed',
  ],
  'runners/qaren-android-runner-client.ts': ['dispatch-unconfirmed'],
  'handlers/device-interact.ts': Array(6).fill('dispatch-unconfirmed'),
  'handlers/device-system-dialog.ts': Array(3).fill('dispatch-unconfirmed'),
  'maestro-invoke.ts': ['dispatch-unconfirmed'],
};

test('every ACTION_OUTCOME_UNCERTAIN refusal site names its reason', () => {
  for (const [file, expected] of Object.entries(SITES)) {
    const source = readFileSync(new URL(`../../../src/${file}`, import.meta.url), 'utf8');
    const found = [
      ...source.matchAll(/refuse\(\s*'ACTION_OUTCOME_UNCERTAIN'\s*(?:,\s*'([a-z-]+)'\s*)?\)/g),
    ].map((match) => match[1] ?? 'none');
    assert.deepEqual(found, expected, file);
  }
});
