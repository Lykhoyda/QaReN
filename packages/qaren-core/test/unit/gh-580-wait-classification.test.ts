// GH #580 — maestro-runner 1.1.16/1.1.20 renders an ID wait miss as
// `Element '#X' not visible within Ns`, a wording the parser did not know, so an
// ordinary missing-selector failure was classified UNKNOWN and refused repair
// with NOT_REPAIRABLE_KIND. These tests pin the new classification, the shapes it
// must NOT claim, and the head+tail output contract that replaced the head-only
// slice which only ever showed the WDA preamble.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaestroFailure, isAutoRepairable } from '../../dist/domain/maestro-error-parser.js';
import { buildStepSummary, buildTerminalEvidence } from '../../dist/domain/maestro-step-parser.js';
import { boundedOutput } from '../../dist/handlers/run-action.js';

// The exact live capture from the issue, at the runner's real 4-space indent.
const RUNNER_1_1_20_STDOUT = [
  'maestro-runner 1.1.20',
  'Starting WDA on device 1234-ABCD',
  '    ✓ launchApp (2.7s)',
  '    ✗ extendedWaitUntil: visible id="fixture_never_exists" (1.2s)',
  "      ╰─ Element '#fixture_never_exists' not visible within 1s (cause: context deadline exceeded)",
].join('\n');

test('gh-580: raw 1.1.20 ID-wait stdout classifies SELECTOR_NOT_FOUND with the exact id', () => {
  const failure = parseMaestroFailure(RUNNER_1_1_20_STDOUT);
  assert.equal(failure.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(failure.selector, 'fixture_never_exists');
  assert.equal(failure.selectorKind, 'id');
  assert.equal(isAutoRepairable(failure), true);
});

test('gh-580: the same wording survives buildTerminalEvidence as kind + exact selector', () => {
  const terminal = buildTerminalEvidence(RUNNER_1_1_20_STDOUT);
  assert.equal(terminal.exitClass, 'step-failure');
  assert.equal(terminal.failureKind, 'SELECTOR_NOT_FOUND');
  assert.equal(terminal.failureSelector, 'fixture_never_exists');
  assert.equal(terminal.failedStep, 'extendedWaitUntil: visible id="fixture_never_exists"');

  // …and the caller-side parse agrees when it reads terminal evidence instead
  // of the (possibly truncated) stdout.
  const failure = parseMaestroFailure('', terminal);
  assert.equal(failure.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(failure.selector, 'fixture_never_exists');
});

test('gh-580: double-quoted rendering and ids containing quotes/# still extract exactly', () => {
  const dq = parseMaestroFailure(
    [
      '    ✗ extendedWaitUntil: visible id="user\'s-tasks" (15.0s)',
      '      ╰─ Element "#user\'s-tasks" not visible within 15s',
    ].join('\n'),
  );
  assert.equal(dq.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(dq.selector, "user's-tasks");

  const hashInside = parseMaestroFailure(
    [
      "    ✗ extendedWaitUntil: visible id='tag#42' (2.0s)",
      "      ╰─ Element '#tag#42' not visible within 2s",
    ].join('\n'),
  );
  assert.equal(hashInside.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(hashInside.selector, 'tag#42');
});

test('gh-580: text and regex waits are NOT reclassified — #334 owns that grammar', () => {
  // No `#` marker → a text selector. Must stay UNKNOWN, not become a fake id.
  const text = parseMaestroFailure("  ╰─ Element 'Continue' not visible within 15s");
  assert.equal(text.kind, 'UNKNOWN');

  const regex = parseMaestroFailure('  ╰─ Element ".*" not visible within 15s');
  assert.equal(regex.kind, 'UNKNOWN');

  // A selector-less deadline stays UNKNOWN too.
  assert.equal(
    parseMaestroFailure('  ╰─ Wait timed out (cause: context deadline exceeded)').kind,
    'UNKNOWN',
  );

  // An empty id renders no selector to extract — refuse rather than invent one.
  assert.equal(parseMaestroFailure("  ╰─ Element '#' not visible within 1s").kind, 'UNKNOWN');
});

test('gh-580: a killed process outranks a matching wait line — process TIMEOUT precedence', () => {
  const terminal = buildTerminalEvidence(RUNNER_1_1_20_STDOUT, { timedOut: true });
  assert.equal(terminal.exitClass, 'timed-out');
  // The wait wording IS present and classified inside the terminal evidence…
  assert.equal(terminal.failureKind, 'SELECTOR_NOT_FOUND');

  // …but exitClass wins, so the run stays a non-repairable TIMEOUT and can never
  // reach the YAML-rewriting repair path.
  const failure = parseMaestroFailure(RUNNER_1_1_20_STDOUT, terminal);
  assert.equal(failure.kind, 'TIMEOUT');
  assert.equal(isAutoRepairable(failure), false);
});

test('gh-580: duplicated staged runner output does not change the classified selector', () => {
  // Authority staging re-invokes the runner with the same argv, so a passing
  // stage's narration is concatenated ahead of the failing stage's.
  const staged = [
    'maestro-runner 1.1.20',
    '    ✓ launchApp (2.7s)',
    'maestro-runner 1.1.20',
    '    ✓ launchApp (1.1s)',
    '    ✗ extendedWaitUntil: visible id="otp_field" (1.2s)',
    "      ╰─ Element '#otp_field' not visible within 15s (cause: context deadline exceeded)",
  ].join('\n');
  const terminal = buildTerminalEvidence(staged);
  assert.equal(terminal.failureKind, 'SELECTOR_NOT_FOUND');
  assert.equal(terminal.failureSelector, 'otp_field');
  assert.equal(parseMaestroFailure(staged).selector, 'otp_field');
});

// Captured verbatim from maestro-runner 1.1.20 driving a dedicated iOS 26.4
// simulator (PR #665 live validation): the runner renders ONE failure as a
// detailed ID-bearing block followed by a selector-less summary that repeats the
// identical reason. `findFailedStep` takes the LAST step, so the terse summary
// became the failed step and the exact ID was lost to UNKNOWN.
const RUNNER_1_1_20_DUPLICATE_SUMMARY = [
  'maestro-runner 1.1.20',
  '    ✗ extendedWaitUntil: visible id="rn580_terminal_missing" (1.2s)',
  "      ╰─ Element '#rn580_terminal_missing' not visible within 1.1s (cause: context deadline exceeded)",
  '',
  '    ✗ extendedWaitUntil (1.4s)',
  "      ╰─ Element '#rn580_terminal_missing' not visible within 1.1s (cause: context deadline exceeded)",
].join('\n');

test('gh-580: a selector-less duplicate summary does not erase the real terminal ID', () => {
  const terminal = buildTerminalEvidence(RUNNER_1_1_20_DUPLICATE_SUMMARY);
  assert.equal(terminal.exitClass, 'step-failure');
  assert.equal(terminal.failureKind, 'SELECTOR_NOT_FOUND');
  assert.equal(terminal.failureSelector, 'rn580_terminal_missing');

  const failure = parseMaestroFailure(RUNNER_1_1_20_DUPLICATE_SUMMARY, terminal);
  assert.equal(failure.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(failure.selector, 'rn580_terminal_missing');
  assert.equal(isAutoRepairable(failure), true);

  // …and from raw stdout alone, with no terminal evidence supplied.
  const fromRaw = parseMaestroFailure(RUNNER_1_1_20_DUPLICATE_SUMMARY);
  assert.equal(fromRaw.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(fromRaw.selector, 'rn580_terminal_missing');
  assert.equal(fromRaw.selectorKind, 'id');
});

test('gh-580: a killed process still outranks the duplicate-summary rendering', () => {
  const terminal = buildTerminalEvidence(RUNNER_1_1_20_DUPLICATE_SUMMARY, { timedOut: true });
  assert.equal(terminal.exitClass, 'timed-out');
  const failure = parseMaestroFailure(RUNNER_1_1_20_DUPLICATE_SUMMARY, terminal);
  assert.equal(failure.kind, 'TIMEOUT');
  assert.equal(isAutoRepairable(failure), false);
});

test('gh-580: only a byte-identical repeated reason counts as a duplicate rendering', () => {
  // Different ID in the terminal reason → the earlier block is a DIFFERENT
  // failure, so nothing binds and the stale ID cannot be promoted.
  const mismatched = [
    '    ✗ extendedWaitUntil: visible id="stale_id" (1.2s)',
    "      ╰─ Element '#stale_id' not visible within 1.1s",
    '    ✗ extendedWaitUntil (1.4s)',
    "      ╰─ Element '#different_id' not visible within 1.1s",
  ].join('\n');
  assert.equal(parseMaestroFailure(mismatched).kind, 'UNKNOWN');

  // Same ID but a different reason line (different timeout) is likewise not a
  // duplicate rendering — refuse rather than assume.
  const differentReason = [
    '    ✗ extendedWaitUntil: visible id="otp" (1.2s)',
    "      ╰─ Element '#otp' not visible within 1.1s",
    '    ✗ extendedWaitUntil (9.0s)',
    "      ╰─ Element '#otp' not visible within 9s",
  ].join('\n');
  assert.equal(parseMaestroFailure(differentReason).kind, 'UNKNOWN');

  // A passing step between the blocks ends the duplicate chain.
  const interrupted = [
    '    ✗ extendedWaitUntil: visible id="otp" (1.2s)',
    "      ╰─ Element '#otp' not visible within 1.1s",
    '    ✓ tapOn: retry (0.4s)',
    '    ✗ extendedWaitUntil (1.4s)',
    "      ╰─ Element '#otp' not visible within 1.1s",
  ].join('\n');
  assert.equal(parseMaestroFailure(interrupted).kind, 'UNKNOWN');
});

test('gh-580: a selector-less summary cannot borrow an unrelated earlier ID wait', () => {
  // The terminal reason is text-shaped, so no ID may bind even though an
  // ID-bearing block appears earlier in the stream.
  const output = [
    '    ✗ extendedWaitUntil: visible id="stale_id" (1.2s)',
    "      ╰─ Element '#stale_id' not visible within 1.1s",
    '    ✗ extendedWaitUntil (1.4s)',
    "      ╰─ Element 'Continue' not visible within 1.1s",
  ].join('\n');
  assert.equal(parseMaestroFailure(output).kind, 'UNKNOWN');
  assert.equal(buildTerminalEvidence(output).failureKind, undefined);
});

test('gh-580: a terminal text wait cannot borrow a duplicate ID-shaped reason', () => {
  const output = [
    '    ✗ extendedWaitUntil: visible id="otp" (1.2s)',
    "      ╰─ Element '#otp' not visible within 1.1s",
    '    ✗ extendedWaitUntil: visible text="#otp" (1.4s)',
    "      ╰─ Element '#otp' not visible within 1.1s",
  ].join('\n');
  assert.equal(parseMaestroFailure(output).kind, 'UNKNOWN');
  assert.equal(buildTerminalEvidence(output).failureKind, undefined);
});

test('gh-580: exact long IDs survive bounded display projection', () => {
  const selector = `terminal_${'x'.repeat(220)}`;
  const output = [
    `    ✗ extendedWaitUntil: visible id="${selector}" (1.2s)`,
    `      ╰─ Element '#${selector}' not visible within 1.1s`,
  ].join('\n');
  const summary = buildStepSummary(output, { failed: true });
  assert.equal(summary.failedStep?.name.length, 201);
  assert.equal(summary.reason?.selector?.length, 201);

  const terminal = buildTerminalEvidence(output);
  assert.equal(terminal.failureKind, 'SELECTOR_NOT_FOUND');
  assert.equal(terminal.failureSelector, selector);
  assert.equal(terminal.failedStep, `extendedWaitUntil: visible id="${selector}"`);

  const failure = parseMaestroFailure('', terminal);
  assert.equal(failure.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(failure.selector, selector);
});

test('gh-580: an earlier transient wait miss loses to the terminal one (GH #118 ordering)', () => {
  const retried = [
    "    ╰─ Element '#stale_transient' not visible within 1s",
    '    ✗ extendedWaitUntil: visible id="real_terminal_target" (15.0s)',
    "    ╰─ Element '#real_terminal_target' not visible within 15s",
  ].join('\n');
  assert.equal(parseMaestroFailure(retried).selector, 'real_terminal_target');
});

test('gh-580: an earlier ID wait cannot outrank a terminal text or regex wait', () => {
  for (const terminalSelector of ["'Continue'", '".*"']) {
    const output = [
      "      ╰─ Element '#stale_transient' not visible within 1s",
      '    ✗ extendedWaitUntil: visible text="Continue" (15.0s)',
      `      ╰─ Element ${terminalSelector} not visible within 15s`,
    ].join('\n');
    assert.equal(parseMaestroFailure(output).kind, 'UNKNOWN');
    assert.equal(buildTerminalEvidence(output).failureKind, undefined);
  }
});

test('gh-580: an earlier ID wait cannot cross a selector-less timeout barrier', () => {
  const output = [
    "      ╰─ Element '#stale_transient' not visible within 1s",
    '    ✗ extendedWaitUntil: visible text="Continue" (15.0s)',
    '      ╰─ Wait timed out (cause: context deadline exceeded)',
  ].join('\n');
  const failure = parseMaestroFailure(output);
  assert.equal(failure.kind, 'UNKNOWN');
  assert.equal(isAutoRepairable(failure), false);
  assert.equal(buildTerminalEvidence(output).failureKind, undefined);
});

test('gh-580: an earlier ID wait cannot outrank a terminal assertion or timeout', () => {
  const cases = [
    {
      terminal: '      ╰─ Assertion failed: "ready" not visible',
      kind: 'ASSERTION_FAILED',
      selector: 'ready',
    },
    {
      terminal: '      ╰─ Timed out waiting for element "spinner"',
      kind: 'TIMEOUT',
      selector: 'spinner',
    },
  ] as const;
  for (const { terminal, kind, selector } of cases) {
    const output = [
      "      ╰─ Element '#stale_transient' not visible within 1s",
      '    ✗ assertVisible: id="ready" (15.0s)',
      terminal,
    ].join('\n');
    const failure = parseMaestroFailure(output);
    assert.equal(failure.kind, kind);
    assert.equal(failure.selector, selector);
    const evidence = buildTerminalEvidence(output);
    assert.equal(evidence.failureKind, kind);
    assert.equal(evidence.failureSelector, selector);
  }
});

test('gh-580: mismatched terminal step and reason IDs stay UNKNOWN', () => {
  const output = [
    '    ✗ extendedWaitUntil: visible id="expected" (15.0s)',
    "      ╰─ Element '#other' not visible within 15s",
  ].join('\n');
  assert.equal(parseMaestroFailure(output).kind, 'UNKNOWN');
  assert.equal(buildTerminalEvidence(output).failureKind, undefined);
});

test('gh-580: an unrelated trailing app timeout log cannot hide terminal ID evidence', () => {
  const output = [
    '    ✗ extendedWaitUntil: visible id="expected" (15.0s)',
    "      ╰─ Element '#expected' not visible within 15s",
    'console: Wait timed out while refreshing analytics',
  ].join('\n');
  const failure = parseMaestroFailure(output);
  assert.equal(failure.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(failure.selector, 'expected');
});

test('gh-580: ANSI-colored terminal step and reason preserve raw evidence', () => {
  const esc = String.fromCharCode(27);
  const output = [
    `${esc}[31m    ✗ extendedWaitUntil: visible id="colored" (15.0s)${esc}[0m`,
    `${esc}[31m      ╰─ Element '#colored' not visible within 15s${esc}[0m`,
  ].join('\n');
  const failure = parseMaestroFailure(output);
  assert.equal(failure.kind, 'SELECTOR_NOT_FOUND');
  assert.equal(failure.selector, 'colored');
  assert.equal(failure.raw, output);
  const terminal = buildTerminalEvidence(output);
  assert.equal(terminal.failureKind, 'SELECTOR_NOT_FOUND');
  assert.equal(terminal.failureSelector, 'colored');
});

test('gh-580: boundedOutput keeps head AND tail inside one 500-char budget', () => {
  const short = 'maestro-runner 1.1.20\n    ✓ launchApp (2.7s)';
  assert.equal(boundedOutput(short), short, 'output within budget is returned verbatim');
  assert.equal(boundedOutput(''), '');

  const head = 'H'.repeat(400);
  const tail = "  ╰─ Element '#otp_field' not visible within 15s".padStart(400, 'T');
  const long = head + tail;
  const bounded = boundedOutput(long);

  assert.equal(bounded.length, 500, 'exactly the budget, never more');
  assert.equal(bounded.slice(0, 249), long.slice(0, 249), 'first 249 chars are the head');
  assert.equal(bounded.slice(-248), long.slice(-248), 'last 248 chars are the tail');
  assert.equal(bounded.slice(249, 252), '\n…\n', 'the elision is explicit');
  assert.ok(
    bounded.includes("Element '#otp_field' not visible within 15s"),
    'the terminal failure at the tail now survives the bound (defect 3)',
  );
});
