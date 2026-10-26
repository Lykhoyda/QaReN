// Issue #104 — unit tests for the Maestro failure parser.
//
// Covers each canonical failure shape, the unknown fallback, and the
// `isAutoRepairable` predicate. All tests are pure-function — no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaestroFailure, isAutoRepairable } from '../../dist/domain/maestro-error-parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// SELECTOR_NOT_FOUND variants
// ─────────────────────────────────────────────────────────────────────────────

test('parser: id-keyed selector, single-quoted', () => {
  const out = parseMaestroFailure(
    "INFO: starting flow\nElement with id 'fab-create-task' not found\nfailed.",
  );
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'fab-create-task');
});

test('parser: id-keyed selector, double-quoted', () => {
  const out = parseMaestroFailure('Element with id "btn-submit" not found');
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'btn-submit');
});

test('parser: id-keyed selector with "was not found" tense', () => {
  const out = parseMaestroFailure("Element with id 'foo' was not found");
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selector, 'foo');
});

test('parser: text-keyed selector', () => {
  const out = parseMaestroFailure("Element with text 'Save' not found");
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'text');
  assert.equal(out.selector, 'Save');
});

test("parser: generic Element 'X' not found falls back to selectorKind=unknown", () => {
  const out = parseMaestroFailure("Element 'mystery-tag' not found in current view");
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'unknown');
  assert.equal(out.selector, 'mystery-tag');
});

test('parser: id pattern wins over generic when both could match', () => {
  // "Element with id 'X'" must be preferred over the generic "Element 'X'"
  // pattern that comes later in PATTERNS.
  const out = parseMaestroFailure("Element with id 'specific-id' not found");
  assert.equal(out.selectorKind, 'id', 'specific id pattern should match before fallback');
  assert.equal(out.selector, 'specific-id');
});

// ─────────────────────────────────────────────────────────────────────────────
// TIMEOUT variants
// ─────────────────────────────────────────────────────────────────────────────

test('parser: timeout with id', () => {
  const out = parseMaestroFailure("Timed out waiting for element with id 'spinner-done'");
  assert.equal(out.kind, 'TIMEOUT');
  assert.equal(out.selector, 'spinner-done');
});

test('parser: timeout without id keyword', () => {
  const out = parseMaestroFailure("Timed out waiting for element 'check-mark'");
  assert.equal(out.kind, 'TIMEOUT');
  assert.equal(out.selector, 'check-mark');
});

// ─────────────────────────────────────────────────────────────────────────────
// ASSERTION_FAILED variants
// ─────────────────────────────────────────────────────────────────────────────

test('parser: assertion-failed prefix', () => {
  const out = parseMaestroFailure(`Assertion failed: 'header-title' not visible`);
  assert.equal(out.kind, 'ASSERTION_FAILED');
  assert.equal(out.selector, 'header-title');
});

test('parser: "X is not visible" variant', () => {
  const out = parseMaestroFailure(`Element 'modal-dialog' is not visible`);
  assert.equal(out.kind, 'ASSERTION_FAILED');
  assert.equal(out.selector, 'modal-dialog');
});

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN fallback
// ─────────────────────────────────────────────────────────────────────────────

test('parser: empty string returns UNKNOWN', () => {
  const out = parseMaestroFailure('');
  assert.equal(out.kind, 'UNKNOWN');
  assert.equal(out.raw, '');
});

test('parser: null/undefined input returns UNKNOWN', () => {
  assert.equal(parseMaestroFailure(null).kind, 'UNKNOWN');
  assert.equal(parseMaestroFailure(undefined).kind, 'UNKNOWN');
});

test('parser: non-matching error text returns UNKNOWN with raw preserved', () => {
  const raw = 'Some completely unrecognised Maestro error message';
  const out = parseMaestroFailure(raw);
  assert.equal(out.kind, 'UNKNOWN');
  assert.equal(out.raw, raw);
});

test('parser: case-insensitive — works on upper-case ELEMENT', () => {
  const out = parseMaestroFailure(`ELEMENT WITH ID 'foo' NOT FOUND`);
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selector, 'foo');
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal-match semantics (GH #118): when output contains MULTIPLE failure-
// shaped lines, the LAST one wins — within a single pattern. Pattern
// specificity outranks line position (covered by the 1.0.9 `id=` priority
// test further down). Earlier in-line matches are typically transient
// retries that maestro-runner reports as [INFO] before the auto-retry
// succeeds; only the terminal failure should drive auto-repair.
// ─────────────────────────────────────────────────────────────────────────────

// GH #118: when output contains multiple failure lines, return the LAST
// (terminal) one — not the first. Earlier matches are typically transient
// retries that maestro-runner reports as [INFO] before the auto-retry
// succeeds; the real failure is the last one before the run exits.
test('parser: returns LAST match when output contains multiple errors (GH #118)', () => {
  const out = parseMaestroFailure(
    [
      "Element with id 'first-failure' not found",
      "Element with id 'second-failure' not found",
    ].join('\n'),
  );
  assert.equal(out.selector, 'second-failure');
});

test('parser: GH #118 transient-retry-then-real-failure shape — picks the terminal ERROR not the INFO retry', () => {
  // Exact shape from the issue: an INFO-prefixed transient retry line
  // earlier in the buffer matches the SELECTOR_NOT_FOUND pattern, but
  // the run continues and ultimately fails on a different selector.
  // Pre-fix behavior would auto-repair the transient (already-resolved)
  // selector — wasting a budget slot and missing the real failure.
  const out = parseMaestroFailure(
    [
      '[INFO] Tapping on element with id "transient-foo"',
      '[INFO] Element with id "transient-foo" not found in current screen — retrying',
      '[INFO] Tapping on element with id "transient-foo"',
      '[ERROR] Element with id "real-failure" not found',
      'Test FAILED',
    ].join('\n'),
  );
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'real-failure');
});

test('parser: single-line output still parses (whole-buffer fallback works when no newlines)', () => {
  // The line-by-line scan returns nothing for a single-line input
  // (the line equals the whole buffer; same path), but verifying the
  // fallback whole-buffer scan still works for malformed-newline cases.
  const out = parseMaestroFailure("Element with id 'lonely-failure' not found");
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selector, 'lonely-failure');
});

// ─────────────────────────────────────────────────────────────────────────────
// isAutoRepairable predicate
// ─────────────────────────────────────────────────────────────────────────────

test('isAutoRepairable: SELECTOR_NOT_FOUND is repairable', () => {
  assert.equal(
    isAutoRepairable({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'id', selector: 'x', raw: '' }),
    true,
  );
});

test('isAutoRepairable: TIMEOUT is NOT auto-repairable in phase 1', () => {
  assert.equal(isAutoRepairable({ kind: 'TIMEOUT', selector: 'x', raw: '' }), false);
});

test('isAutoRepairable: ASSERTION_FAILED is NOT auto-repairable in phase 1', () => {
  assert.equal(isAutoRepairable({ kind: 'ASSERTION_FAILED', selector: 'x', raw: '' }), false);
});

test('isAutoRepairable: UNKNOWN is NOT auto-repairable', () => {
  assert.equal(isAutoRepairable({ kind: 'UNKNOWN', raw: '' }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Realistic maestro-runner outputs (smoke tests against actual stderr
// captures — keeps the regex grounded in real wire format).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Asymmetric-quote handling — multi-LLM review of PR #115 (Gemini conf 95):
// the previous `[^'"]+` capture rejected BOTH quote types, so a testID
// containing the OPPOSITE quote silently failed to parse. The
// `(['"])((?:(?!\1).)+)\1` pattern matches the same quote at both ends
// and allows the opposite inside.
// ─────────────────────────────────────────────────────────────────────────────

test('parser: id-keyed selector containing a single-quote (RN convention "user\'s-tasks") inside double-quotes', () => {
  const out = parseMaestroFailure(`Element with id "user's-tasks" not found`);
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, "user's-tasks");
});

test('parser: id-keyed selector containing a double-quote inside single-quotes', () => {
  const out = parseMaestroFailure(`Element with id 'say-"hi"' not found`);
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'say-"hi"');
});

test('parser: timeout selector containing the opposite quote', () => {
  const out = parseMaestroFailure(`Timed out waiting for element with id "don't-tap-me"`);
  assert.equal(out.kind, 'TIMEOUT');
  assert.equal(out.selector, "don't-tap-me");
});

test('parser: realistic maestro-runner failure output', () => {
  const realistic = `
=== Running ./.qaren/actions/wizard-create-task.yaml ===
[INFO] Launching app com.test.app
[INFO] Tapping on element with id "tab-tasks"
[INFO] Tapping on element with id "fab-create-task"
[ERROR] Element with id 'fab-create-task' not found
[INFO] Flow failed
exit code 1
  `.trim();
  const out = parseMaestroFailure(realistic);
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'fab-create-task');
});

// ─────────────────────────────────────────────────────────────────────────────
// GH #105 / B152: maestro-runner 1.0.9 stderr shape
// ─────────────────────────────────────────────────────────────────────────────
// The shape `Element not found: id='X'` (with colon + equals) is emitted by
// maestro-runner 1.0.9+. Before PR #159 the parser only recognized the
// classic `Element with id 'X' not found` shape and returned UNKNOWN for
// the modern form — silently disabling the L3 self-healing loop. These
// tests pin the new patterns so a regression would be immediately visible.

test("parser: 1.0.9 shape — id='X' single-quoted", () => {
  const out = parseMaestroFailure(
    '    ✗ tapOn: id="task-mark-all-done" (12.7s)\n      ╰─ Element not found: id=\'task-mark-all-done\'\n',
  );
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'task-mark-all-done');
});

test('parser: 1.0.9 shape — id="X" double-quoted', () => {
  const out = parseMaestroFailure('Element not found: id="btn-submit"');
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'btn-submit');
});

test("parser: 1.0.9 shape — text='X' single-quoted", () => {
  const out = parseMaestroFailure("Element not found: text='All done'");
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selectorKind, 'text');
  assert.equal(out.selector, 'All done');
});

test('parser: 1.0.9 shape — extra whitespace between : and id= tolerated', () => {
  // maestro-runner formatting could insert any amount of whitespace; the
  // pattern uses \s* so this must match.
  const out = parseMaestroFailure("Element not found:   id='spinner'");
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selector, 'spinner');
});

test("parser: 1.0.9 shape — embedded opposite quote in id (e.g. user\\'s-tasks)", () => {
  // Matched-quote backreference pattern allows the opposite quote inside
  // the value. Same invariant we test for the classic shape (line 176-189).
  const out = parseMaestroFailure(`Element not found: id="say-'hi'-btn"`);
  assert.equal(out.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(out.selector, "say-'hi'-btn");
});

test('parser: 1.0.9 shape — full realistic maestro-runner 1.0.9 stderr', () => {
  // Captured verbatim from the #105 MTTR experiment session. The earlier
  // classic patterns must NOT match (no "Element with id 'X' not found"
  // string), but the new 1.0.9 patterns must classify correctly.
  const realistic = `maestro-runner 1.0.9 - by DeviceLab.dev
  ✓ launchApp (2.3s)
  ✓ tapOn: id="tab-tasks" (2.8s)
  ✓ assertVisible: text="Tasks" (1.3s)
  ✗ tapOn: id="task-mark-all-done" (12.7s)
    ╰─ Element not found: id='task-mark-all-done'
  3 steps passing
  1 steps failing
✗ rn-maestro-run 23.8s`;
  const out = parseMaestroFailure(realistic);
  assert.equal(
    out.kind,
    'SELECTOR_NOT_FOUND',
    `expected SELECTOR_NOT_FOUND, got ${out.kind} — the 1.0.9 pattern MUST match this verbatim stderr`,
  );
  assert.equal(out.selectorKind, 'id');
  assert.equal(out.selector, 'task-mark-all-done');
});

test('parser: 1.0.9 id= shape has priority over the generic fallback', () => {
  // The 1.0.9 id= pattern is more specific than the catch-all "Element 'X' not found".
  // Pattern order in maestro-error-parser.ts MUST keep id-shape ahead of the fallback.
  // If a regression reorders patterns, this test catches it.
  const out = parseMaestroFailure(
    "Element not found: id='specific-id'\nAlso seen: Element 'fallback-id' not found",
  );
  assert.equal(out.selectorKind, 'id', 'id= shape must win over fallback when both present');
  assert.equal(out.selector, 'specific-id');
});
