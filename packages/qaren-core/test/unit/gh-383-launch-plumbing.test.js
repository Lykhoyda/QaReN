// GH #383: the bridge passes its plugin version to the runner at launch so the
// runner can echo it in /health (runnerVersion). Pure-builder test — the env
// half (iOS xcodebuild spawn) is a one-line spread checked by review + device
// verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstrumentVersionArgs } from '../../dist/runners/rn-android-runner-client.js';

test('gh-383: buildInstrumentVersionArgs emits -e RN_PLUGIN_VERSION when known', () => {
  assert.deepEqual(buildInstrumentVersionArgs('0.58.0'), ['-e', 'RN_PLUGIN_VERSION', '0.58.0']);
});

test('gh-383: buildInstrumentVersionArgs is empty when version unknown (fail-open)', () => {
  assert.deepEqual(buildInstrumentVersionArgs(null), []);
});
