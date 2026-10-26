// CDP-013: Maestro generator must NOT YAML-inject when testID/label
// contain quotes, newlines, colons, leading hyphens, or other YAML-special
// characters. The fix routes user-controlled values through yaml.stringify
// (which picks the safest scalar form automatically) and emits label-only
// events as `text:` instead of the previously-misused `id:`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMaestro, maestroSelector } from '../../dist/handlers/test-recorder-generators.js';
import { parseAllDocuments } from 'yaml';

// The Maestro generator emits a multi-document YAML stream when bundleId
// is provided (header doc + flow doc). parseAllDocuments handles this.
function parseMaestroFlow(out) {
  const docs = parseAllDocuments(out);
  // The last doc is the flow steps array.
  return docs[docs.length - 1].toJS();
}

test('CDP-013: hostile testID with quotes does not break YAML', () => {
  const events = [{ type: 'tap', testID: 'evil"id', t: 1 }];
  const out = generateMaestro(events, { bundleId: 'com.x' });
  // Output must parse as YAML without throwing.
  assert.doesNotThrow(() => parseMaestroFlow(out));
});

test('CDP-013: hostile label with newline + injection attempt does not escape scalar', () => {
  const events = [{ type: 'tap', label: 'Bad"\n- launchApp', t: 1 }];
  const out = generateMaestro(events, { bundleId: 'com.x' });
  // The `- launchApp` injection should NOT appear as a separate top-level
  // step (it gets stripped of newlines via stripNewlines + yaml-quoted).
  // The generator already emits one `- launchApp` of its own — verify
  // there are no MORE than one.
  const launchAppOccurrences = (out.match(/^\s*- launchApp\s*$/gm) ?? []).length;
  assert.equal(
    launchAppOccurrences,
    1,
    'attacker-injected `- launchApp` must NOT appear as a sibling step',
  );
});

test("CDP-013: label-only events emit `text:` selector (Maestro's correct visible-text matcher)", () => {
  const sel = maestroSelector({ type: 'tap', label: 'Submit', t: 1 });
  assert.match(sel, /^text:\s/, 'label-only events must use Maestro `text:` selector, not `id:`');
});

test('CDP-013: testID with colon serializes safely', () => {
  const events = [{ type: 'tap', testID: 'foo:bar', t: 1 }];
  const out = generateMaestro(events, { bundleId: 'com.x' });
  // Colons are YAML-significant; the serializer must quote when needed.
  assert.doesNotThrow(() => parseMaestroFlow(out));
});

test('CDP-013: testID with leading hyphen serializes safely', () => {
  const events = [{ type: 'tap', testID: '-leading', t: 1 }];
  const out = generateMaestro(events, { bundleId: 'com.x' });
  assert.doesNotThrow(() => parseMaestroFlow(out));
});

test('CDP-013: round-trip parse extracts the original testID through the YAML scalar', () => {
  const events = [{ type: 'tap', testID: 'has spaces and "quotes"', t: 1 }];
  const out = generateMaestro(events, { bundleId: 'com.x' });
  const flow = parseMaestroFlow(out);
  // First step is launchApp; second is our tapOn.
  assert.ok(Array.isArray(flow));
  const tapStep = flow.find((s) => s && typeof s === 'object' && 'tapOn' in s);
  assert.ok(tapStep, 'tapOn step must be parseable');
  assert.equal(
    tapStep.tapOn.id,
    'has spaces and "quotes"',
    'original testID must survive serialization round-trip',
  );
});
