import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';
import { RunInputs, withInputs, withEchoScope, declareEcho } from '../../dist/qa/inputs.js';

const node = (over = {}) => ({
  ref: '@e0',
  type: 'Button',
  label: 'Save',
  identifier: 'save-btn',
  rect: { x: 100, y: 200, width: 120, height: 44 },
  ...over,
});

test('identical node lists hash identically', () => {
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([node()]));
});

test('same-quantization-bucket jitter (±1px within a 4px bucket) does NOT change the hash', () => {
  const jittered = node({ rect: { x: 101, y: 201, width: 120, height: 44 } });
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([jittered]));
});

test('bucket-crossing movement registers (quantization is bucketed, not a distance threshold)', () => {
  const crossed = node({ rect: { x: 102, y: 200, width: 120, height: 44 } });
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([crossed]));
});

test('delimiter-lookalike content in labels cannot alias node boundaries', () => {
  const tricky = [node({ label: 'a\nb', identifier: '' })];
  const split = [node({ label: 'a', identifier: '' }), node({ label: 'b', identifier: '' })];
  assert.notEqual(hashSnapshotNodes(tricky), hashSnapshotNodes(split));
});

test('raw control bytes in app-controlled strings cannot alias field/node boundaries', () => {
  const controlBytes = [node({ label: 'a\0b\x01c', identifier: '' })];
  const shifted = [node({ label: 'a', identifier: 'b\x01c' })];
  assert.notEqual(hashSnapshotNodes(controlBytes), hashSnapshotNodes(shifted));
});

test('enabled state flips register as UI change', () => {
  assert.notEqual(
    hashSnapshotNodes([node({ enabled: true, hittable: true })]),
    hashSnapshotNodes([node({ enabled: false, hittable: true })]),
  );
});

// #519 review: hittable is derived from enabled + rect + viewport, and its
// center-vs-edge comparison is UNquantized — hashing it would let sub-bucket
// jitter at the viewport edge defeat the 4px quantization (settle timeouts,
// phantom "UI changed" suppressing the Story 05 re-tap). enabled and the
// quantized rect are already hashed, so dropping it loses no real signal.
test('hittable flips alone do NOT change the hash (excluded from settle identity)', () => {
  assert.equal(
    hashSnapshotNodes([node({ enabled: true, hittable: true })]),
    hashSnapshotNodes([node({ enabled: true, hittable: false })]),
  );
});

test('a real transition (moved element) DOES change the hash', () => {
  const moved = node({ rect: { x: 100, y: 420, width: 120, height: 44 } });
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([moved]));
});

test('label/text change registers', () => {
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([node({ label: 'Saving…' })]));
});

test('synthetic ref churn alone does NOT change the hash', () => {
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([node({ ref: '@e7' })]));
});

test('node added/removed changes the hash', () => {
  assert.notEqual(
    hashSnapshotNodes([node()]),
    hashSnapshotNodes([node(), node({ identifier: 'x' })]),
  );
});

test('empty list hashes deterministically', () => {
  assert.equal(hashSnapshotNodes([]), hashSnapshotNodes([]));
});

test('a registered field label echo does not change the digest between two values', () => {
  const digest = (value) => {
    const inputs = new RunInputs({ EMAIL: value }, ['EMAIL']);
    inputs.expectEcho('login_email');
    return withInputs(inputs, () =>
      hashSnapshotNodes([node(), node({ identifier: 'login_email', label: value })]),
    );
  };
  assert.equal(digest('qa-synth-1234@example.test'), digest('other-user@example.test'));
});

test('a declared label echo does not change the digest between two values', () => {
  const digest = (value) =>
    withInputs(new RunInputs({ EMAIL: value }, ['EMAIL']), () =>
      withEchoScope(() => {
        declareEcho('EMAIL');
        return hashSnapshotNodes([
          node(),
          node({ identifier: 'code_hint', label: `Sent to ${value}` }),
        ]);
      }),
    );
  assert.equal(digest('qa-synth-1234@example.test'), digest('other-user@example.test'));
});

test('a code that only spans adjacent quantized coordinates still hashes', () => {
  const coded = (value, label = 'Code') =>
    withInputs(new RunInputs({ OTP: value }, ['OTP']), () =>
      hashSnapshotNodes([node({ rect: { x: 232, y: 156, width: 40, height: 20 }, label })]),
    );
  assert.equal(coded('5839'), coded('2468'));
  assert.equal(coded('5839', '58 39'), coded('2468', '24 68'));
});
