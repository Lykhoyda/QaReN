// Issue #102 A1 — splitYaml leading-blank-lines polish test.
//
// Pre-fix: a YAML with leading blank lines + no `---` separator put
// the M7 header into bodyLines instead of headerLines. Round-trip
// through saveAction would duplicate the header.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitYaml, joinYaml } from '../../dist/domain/action-store.js';

test('Issue #102 A1: leading blank line + comment header parses to headerLines, not bodyLines', () => {
  const yaml = '\n\n# id: foo\n# intent: bar\n\n- launchApp\n- tapOn:\n    id: "x"\n';
  const out = splitYaml(yaml);
  assert.equal(out.topSection, '');
  assert.ok(
    out.headerLines.some((l) => l.includes('id: foo')),
    `expected header to contain id: foo, got ${JSON.stringify(out.headerLines)}`,
  );
  assert.ok(
    out.headerLines.some((l) => l.includes('intent: bar')),
    `expected header to contain intent: bar`,
  );
  assert.ok(
    out.bodyLines.some((l) => l.includes('launchApp')),
    `expected body to contain launchApp`,
  );
  // The M7 header lines should NOT be in body.
  assert.ok(
    !out.bodyLines.some((l) => l.includes('id: foo')),
    `M7 header line leaked into body: ${JSON.stringify(out.bodyLines)}`,
  );
});

test('Issue #102 A1: round-trip through joinYaml preserves the body without duplicating the header', () => {
  const yaml = '\n# id: foo\n# intent: bar\n\n- launchApp\n';
  const split = splitYaml(yaml);
  const rejoined = joinYaml(split);
  // Header should appear exactly once.
  const headerOccurrences = (rejoined.match(/# id: foo/g) ?? []).length;
  assert.equal(
    headerOccurrences,
    1,
    `expected exactly one header occurrence, got ${headerOccurrences} in: ${rejoined}`,
  );
});

test('Issue #102 A1: pre-existing well-formed YAML (no leading blanks) is unaffected', () => {
  const yaml = '# id: foo\n# intent: bar\n\n- launchApp\n';
  const out = splitYaml(yaml);
  assert.ok(out.headerLines.some((l) => l.includes('id: foo')));
  assert.ok(out.bodyLines.some((l) => l.includes('launchApp')));
  assert.ok(!out.bodyLines.some((l) => l.includes('id: foo')));
});
