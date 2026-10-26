// test/unit/gh-211-maestro-step-parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSteps,
  stripAnsi,
  findFailedStep,
  lastObservedStep,
  summarizeReason,
  buildStepSummary,
  classifyExecError,
  formatFailureHeadline,
  combineRunnerOutput,
} from '../../dist/domain/maestro-step-parser.js';

// Real maestro-runner format (same shape as the gh-263 fixtures).
const FAILED_RUN = `  ✓ launchApp (2.3s)
  ✓ tapOn: id="a" (2.8s)
  ✓ tapOn: id="b" (3.0s)
  ✓ assertVisible: text="x" (1.1s)
  ✗ tapOn: id="c" (12.7s)
✗ rn-maestro-run 23.8s`;

test('parseSteps: verb/status/durationMs/index; summary line excluded', () => {
  const steps = parseSteps(FAILED_RUN);
  assert.equal(steps.length, 5);
  assert.deepEqual(steps[0], {
    index: 0,
    name: 'launchApp',
    verb: 'launchApp',
    status: 'pass',
    durationMs: 2300,
  });
  assert.deepEqual(steps[1], {
    index: 1,
    name: 'tapOn: id="a"',
    verb: 'tapOn',
    status: 'pass',
    durationMs: 2800,
  });
  assert.deepEqual(steps[4], {
    index: 4,
    name: 'tapOn: id="c"',
    verb: 'tapOn',
    status: 'fail',
    durationMs: 12700,
  });
  assert.ok(!steps.some((s) => s.verb === 'rn-maestro-run')); // `✗ rn-maestro-run 23.8s` has no (N.Ns)
});

test('parseSteps: verb has trailing colon stripped', () => {
  assert.equal(parseSteps('  ✓ tapOn: id="a" (1.0s)')[0].verb, 'tapOn');
});

test('parseSteps: verb is first token — verb name inside a selector value is not the verb', () => {
  assert.equal(parseSteps('  ✓ assertVisible: text="tapOn now" (1.0s)')[0].verb, 'assertVisible');
});

test('parseSteps: count lines / bare text are not steps', () => {
  assert.deepEqual(parseSteps('  3 steps passing\n  1 steps failing\nRunning on iPhone'), []);
});

test('parseSteps: embedded (N.Ns) in a selector — trailing duration wins', () => {
  const steps = parseSteps('  ✓ assertVisible: text="took (2.0s)" (1.0s)');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].durationMs, 1000);
  assert.equal(steps[0].name, 'assertVisible: text="took (2.0s)"');
});

test('parseSteps: empty / garbage / non-string → [] (never throws)', () => {
  assert.deepEqual(parseSteps(''), []);
  assert.deepEqual(parseSteps('not maestro output'), []);
  assert.deepEqual(parseSteps(undefined), []);
});

test('stripAnsi: removes SGR codes; ANSI-wrapped glyph line still parses', () => {
  const ESC = String.fromCharCode(27); // ANSI escape byte (0x1b)
  const colored = `  ${ESC}[32m✓${ESC}[0m tapOn: id="a" (1.0s)`;
  assert.equal(stripAnsi(colored).includes(ESC), false);
  const steps = parseSteps(colored);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].verb, 'tapOn');
});

test('findFailedStep: last ✗ step; null when all pass', () => {
  assert.equal(findFailedStep(parseSteps(FAILED_RUN)).name, 'tapOn: id="c"');
  assert.equal(findFailedStep(parseSteps('  ✓ launchApp (1.0s)')), null);
});

test('lastObservedStep: steps.at(-1); null when empty', () => {
  assert.equal(lastObservedStep(parseSteps(FAILED_RUN)).name, 'tapOn: id="c"');
  assert.equal(lastObservedStep([]), null);
});

test('summarizeReason: sanitized {kind, selector}; NEVER carries raw', () => {
  const r = summarizeReason(`Element with id 'submit' not found`);
  assert.deepEqual(r, { kind: 'SELECTOR_NOT_FOUND', selector: 'submit' });
  assert.equal('raw' in r, false);
});

test('summarizeReason: unrecognized output → null', () => {
  assert.equal(summarizeReason('some unrecognized output'), null);
});

test('buildStepSummary: failed=false → failedStep/reason null even with a transient ✗', () => {
  const s = buildStepSummary(FAILED_RUN, { failed: false });
  assert.equal(s.failedStep, null);
  assert.equal(s.reason, null);
  assert.equal(s.steps.length, 5);
  assert.equal(s.lastStep.name, 'tapOn: id="c"');
});

test('buildStepSummary: failed=true → failedStep + reason populated', () => {
  const out = FAILED_RUN + `\nElement with id 'c' not found`;
  const s = buildStepSummary(out, { failed: true });
  assert.equal(s.failedStep.name, 'tapOn: id="c"');
  assert.deepEqual(s.reason, { kind: 'SELECTOR_NOT_FOUND', selector: 'c' });
});

test('buildStepSummary: timeout partial (no ✗) → failedStep null, lastStep = last ✓', () => {
  const partial = `  ✓ launchApp (2.0s)\n  ✓ tapOn: id="a" (2.5s)`;
  const s = buildStepSummary(partial, { failed: true });
  assert.equal(s.failedStep, null);
  assert.equal(s.lastStep.name, 'tapOn: id="a"');
});

test('classifyExecError: timeout (killed, no code) → timedOut, not truncated', () => {
  assert.deepEqual(classifyExecError({ killed: true, signal: 'SIGTERM', code: null }), {
    timedOut: true,
    outputTruncated: false,
  });
});

test('classifyExecError: maxBuffer overflow → truncated, not timedOut', () => {
  assert.deepEqual(classifyExecError({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), {
    timedOut: false,
    outputTruncated: true,
  });
});

test('classifyExecError: normal non-zero exit → neither; null safe', () => {
  assert.deepEqual(classifyExecError({ killed: false, code: 1 }), {
    timedOut: false,
    outputTruncated: false,
  });
  assert.deepEqual(classifyExecError(null), { timedOut: false, outputTruncated: false });
});

test('catch-path assembly: timeout → timedOut, partial steps, failedStep null', () => {
  const err = {
    killed: true,
    code: null,
    stdout: '  ✓ launchApp (2.0s)\n  ✓ tapOn: id="a" (2.5s)',
    stderr: '',
  };
  const combined = (err.stdout + '\n' + err.stderr).trim();
  const cls = classifyExecError(err);
  const summary = buildStepSummary(combined, { failed: true });
  assert.equal(cls.timedOut, true);
  assert.equal(cls.outputTruncated, false);
  assert.equal(summary.failedStep, null);
  assert.equal(summary.lastStep.name, 'tapOn: id="a"');
});

test('formatFailureHeadline: structured & raw-free; raw fallback only for system errors', () => {
  const t = buildStepSummary('  ✓ launchApp (2.0s)\n  ✓ tapOn: id="a" (2.5s)', { failed: true });
  assert.equal(
    formatFailureHeadline(t, { timedOut: true, outputTruncated: false }, 'Command failed: …'),
    'Maestro flow timed out after step "tapOn: id="a""',
  );
  const f = buildStepSummary('  ✗ tapOn: id="c" (12.7s)\nElement with id \'c\' not found', {
    failed: true,
  });
  assert.equal(
    formatFailureHeadline(f, { timedOut: false, outputTruncated: false }, 'x'),
    'Maestro flow failed at step "tapOn: id="c"" (SELECTOR_NOT_FOUND: c)',
  );
  const empty = { steps: [], failedStep: null, reason: null, lastStep: null };
  assert.equal(
    formatFailureHeadline(empty, { timedOut: false, outputTruncated: false }, 'spawn ENOENT'),
    'Maestro flow failed: spawn ENOENT',
  );
  assert.equal(
    formatFailureHeadline(empty, { timedOut: false, outputTruncated: true }, 'x'),
    'Maestro flow output exceeded the 10MB buffer',
  );
});

test('findFailedStep: transient ✗ retried-✓ then nothing → null (terminal-fail only)', () => {
  const out = '  ✗ tapOn: id="a" (12.0s)\n  ✓ tapOn: id="a" (1.0s)\n  ✓ tapOn: id="b" (1.0s)';
  assert.equal(findFailedStep(parseSteps(out)), null);
});

test('parseSteps: a pathologically long step name is capped', () => {
  const steps = parseSteps('  ✓ inputText: "' + 'x'.repeat(500) + '" (1.0s)');
  assert.equal(steps.length, 1);
  assert.ok(steps[0].name.length <= 201, `name len ${steps[0].name.length}`);
  assert.ok(steps[0].name.endsWith('…'));
  assert.equal(steps[0].verb, 'inputText'); // verb still derived from the uncapped first token
});

test('formatFailureHeadline: long parsed names stay bounded (no raw blowup)', () => {
  const s = buildStepSummary('  ✗ tapOn: id="' + 'y'.repeat(500) + '" (3.0s)', { failed: true });
  const h = formatFailureHeadline(s, { timedOut: false, outputTruncated: false }, 'x');
  assert.ok(h.length < 300, `headline len ${h.length}`);
});

test('parseSteps: pathological whitespace lines do not catastrophically backtrack (ReDoS)', () => {
  const start = process.hrtime.bigint();
  assert.deepEqual(parseSteps('✓ ' + ' '.repeat(8000) + 'x'), []); // leading whitespace run
  assert.deepEqual(parseSteps('✓ step' + ' '.repeat(8000) + 'x'), []); // trailing whitespace run
  assert.deepEqual(parseSteps('✗ ' + '\t'.repeat(8000) + 'y'), []); // tabs
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // Generous ceiling: the fixed (linear) parser runs in <1ms; a catastrophic-
  // backtracking regression measures 30s+. 2000ms cleanly separates the two
  // without flaking under CI/system load.
  assert.ok(ms < 2000, `parseSteps took ${ms.toFixed(1)}ms — possible ReDoS`);
});

test('formatFailureHeadline: reason without a failed step → structured (raw-free) headline', () => {
  const s = buildStepSummary("  ✓ launchApp (2.0s)\nElement with id 'missing' not found", {
    failed: true,
  });
  assert.equal(s.failedStep, null);
  assert.deepEqual(s.reason, { kind: 'SELECTOR_NOT_FOUND', selector: 'missing' });
  assert.equal(
    formatFailureHeadline(
      s,
      { timedOut: false, outputTruncated: false },
      'raw fallback should not appear',
    ),
    'Maestro flow failed (SELECTOR_NOT_FOUND: missing)',
  );
});

test('parseSteps: caps returned steps to the most recent 1000 (tail kept, true index)', () => {
  const lines = [];
  for (let i = 0; i < 1500; i++) lines.push(`  ✓ tapOn: id="s${i}" (1.0s)`);
  const steps = parseSteps(lines.join('\n'));
  assert.equal(steps.length, 1000); // capped
  assert.equal(steps[steps.length - 1].name, 'tapOn: id="s1499"'); // tail kept
  assert.equal(steps[steps.length - 1].index, 1499); // true index preserved
  assert.equal(steps[0].index, 500); // 1500 total → first kept index = 500 (gap = truncation signal)
});

// GH #312 / B211: MAX_FIELD bounds the step `name` but the `verb` (the name's
// first token) was stored uncapped — a step-shaped line whose first token is a
// multi-KB blob bloats the MCP response across up to 1000 steps. Cap the verb.
test('parseSteps: a pathologically long verb (first token) is capped (B211)', () => {
  const steps = parseSteps('  ✓ ' + 'x'.repeat(500) + ' (1.0s)');
  assert.equal(steps.length, 1);
  assert.ok(steps[0].verb.length <= 201, `verb len ${steps[0].verb.length}`);
});

// GH #312 / B212: real runner steps are indented (live renderer: 4 spaces;
// nested runFlow sub-steps: 6+). The combined stdout+stderr carries untrusted
// app logs — an UNINDENTED (column-0) line shaped `✓/✗ … (N.Ns)` must not be
// mistaken for a step, or a benign/crafted log line poisons lastStep/failedStep.
test('parseSteps: an unindented (column-0) app-log line is NOT a step (B212)', () => {
  assert.deepEqual(parseSteps('✓ App started successfully (1.2s)'), []);
  assert.deepEqual(parseSteps('✗ Background sync failed (3.4s)'), []);
});

// The anchor must require SOME indent, not an EXACT one — the live renderer
// prints top-level steps at 4 spaces and nested runFlow sub-steps at 6+, so a
// too-strict `^  ` (2-space) anchor would drop legit steps.
test('parseSteps: real 4-space top-level + 6-space nested steps still parse (B212)', () => {
  assert.equal(parseSteps('    ✓ launchApp (2.3s)')[0].verb, 'launchApp');
  assert.equal(parseSteps('      ✓ tapOn: id="nested" (2.0s)')[0].name, 'tapOn: id="nested"');
});

// The poisoning vector spelled out: a crafted column-0 ✗ line appended to a
// run's app logs must not become the terminal failedStep / lastStep.
test('parseSteps: an unindented crafted ✗ line cannot poison failedStep/lastStep (B212)', () => {
  const out = '    ✓ launchApp (2.3s)\n    ✓ tapOn: id="a" (2.8s)\n✗ fake step failed (9.9s)';
  const s = buildStepSummary(out, { failed: true });
  assert.equal(s.steps.length, 2); // only the two indented steps
  assert.equal(s.lastStep.name, 'tapOn: id="a"'); // not the crafted line
  assert.equal(s.failedStep, null); // the crafted column-0 ✗ is ignored
});

// The anchor must be HORIZONTAL whitespace only: JS `\s` also matches `\r`, `\v`,
// `\f`, and NBSP, which are common at the start of terminal/progress/app-log
// lines — admitting them would re-open the column-0 poisoning vector B212 closes.
test('parseSteps: a CR/NBSP/VT-prefixed column-0 line is NOT a step (B212)', () => {
  assert.deepEqual(parseSteps('\r✗ fake step failed (9.9s)'), []);
  assert.deepEqual(parseSteps('\u00a0✓ App started (1.2s)'), []); // NBSP
  assert.deepEqual(parseSteps('\v✓ App started (1.2s)'), []); // vertical tab
  const out = '    ✓ launchApp (2.3s)\n\r✗ fake step failed (9.9s)';
  const s = buildStepSummary(out, { failed: true });
  assert.equal(s.steps.length, 1); // only the real space-indented step
  assert.equal(s.failedStep, null); // CR-prefixed ✗ does not poison
  assert.equal(s.lastStep.name, 'launchApp');
});

test('parseSteps: indented pathological whitespace line does not backtrack (B212 ReDoS guard)', () => {
  const start = process.hrtime.bigint();
  assert.deepEqual(parseSteps('    ✓ ' + ' '.repeat(8000) + 'x'), []);
  assert.deepEqual(parseSteps('      ✗ step' + '\t'.repeat(8000) + 'y'), []);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 2000, `parseSteps took ${ms.toFixed(1)}ms — possible ReDoS`);
});

// GH #312: parseSteps anchors on the runner's leading indent (B212), so the
// stdout+stderr combiner must NOT strip per-line indentation the way a blanket
// .trim() did — else the FIRST step line (its indent eaten by the outer trim) is
// dropped from meta.steps. combineRunnerOutput trims trailing whitespace + leading
// BLANK LINES only, preserving the first content line's indent.
test('combineRunnerOutput: preserves the first step line indent so it is not dropped (B212/#312)', () => {
  const stdout = '  ✓ launchApp (2.3s)\n  ✓ tapOn: id="a" (2.8s)\n  ✗ tapOn: id="b" (12.7s)';
  const s = buildStepSummary(combineRunnerOutput(stdout, ''), { failed: true });
  assert.equal(s.steps.length, 3); // launchApp NOT dropped
  assert.equal(s.steps[0].name, 'launchApp');
});

test('combineRunnerOutput: strips leading blank lines + trailing whitespace, keeps indent', () => {
  assert.equal(combineRunnerOutput('\n\n  ✓ launchApp (2.3s)\n', ''), '  ✓ launchApp (2.3s)');
  assert.equal(combineRunnerOutput('  ✓ a (1.0s)', '  ✗ b (2.0s)'), '  ✓ a (1.0s)\n  ✗ b (2.0s)');
});

test('combineRunnerOutput: trailing-trim is linear on a huge non-whitespace-terminated blob (no ReDoS)', () => {
  const start = process.hrtime.bigint();
  combineRunnerOutput(' '.repeat(2_000_000) + 'x', '');
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `combineRunnerOutput took ${ms.toFixed(1)}ms — possible ReDoS`);
});
