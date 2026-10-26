import { stripAnsi } from './ansi.js';

// Issue #104 — pure parser for Maestro CLI / maestro-runner failure output.
//
// `maestro_run` returns the combined stdout+stderr in `data.output`. To
// auto-repair, we need to classify the failure and extract the failed
// selector. This module owns that classification — pure regex over the
// raw output text, no I/O, fully unit-testable.
//
// Maestro emits failures in a few canonical shapes (verified against
// Maestro 1.40+ output, maestro-runner 0.x, and maestro-runner 1.0.9):
//
//   - "Element with id 'X' not found"
//   - "Element with text 'X' not found"
//   - 'Assertion failed: "X" not visible'
//   - "Timed out waiting for element 'X'"
//   - "Element 'X' is not visible"  (assertion variant)
//   - "Element not found: id='X'"   (maestro-runner 1.0.x shape — issue #105)
//
// The parser tries each known shape in order and returns the first
// match. If none match, returns `{ kind: 'UNKNOWN', raw }` so the caller
// can decide whether to surface it verbatim or escalate to the user.

export type MaestroFailure =
  | {
      kind: 'SELECTOR_NOT_FOUND';
      selectorKind: 'id' | 'text' | 'unknown';
      selector: string;
      raw: string;
    }
  | { kind: 'TIMEOUT'; selector: string | null; raw: string }
  | { kind: 'ASSERTION_FAILED'; selector: string | null; raw: string }
  | { kind: 'WDA_BOOTSTRAP_FAILED'; detail: string; raw: string }
  | { kind: 'UNKNOWN'; raw: string };

export interface MaestroTerminalClassification {
  exitClass?: 'before-first-step' | 'step-failure' | 'timed-out' | 'spawn-error';
  failedStep?: string;
  bootstrapEvidence?: string;
  failureKind?: 'SELECTOR_NOT_FOUND' | 'TIMEOUT' | 'ASSERTION_FAILED';
  failureSelector?: string | null;
}

interface Pattern {
  re: RegExp;
  build: (m: RegExpExecArray, raw: string) => MaestroFailure;
}

// Order matters: more-specific patterns first.
//
// Matched-quote pattern `(['"])((?:(?!\1).)+)\1` captures a testID
// surrounded by quotes (single OR double) AND allows the OPPOSITE quote
// inside the captured value. Multi-LLM review of PR #115 caught that
// the prior `[^'"]+` capture broke on testIDs like "user's-tasks" or
// `say-"hi"` — Maestro outputs the literal id verbatim, and React
// Native testIDs are not constrained to kebab-case ASCII. The new
// pattern uses a back-reference to require the same opening + closing
// quote, with `(?!\1).` allowing every character that isn't the
// matching closer.
//
// Group 1 = the quote character (consumed but unused);
// Group 2 = the actual selector value.
const PATTERNS: Pattern[] = [
  {
    re: /Element with id (['"])((?:(?!\1).)+)\1 (?:was )?not found/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'id', selector: m[2], raw }),
  },
  {
    re: /Element with text (['"])((?:(?!\1).)+)\1 (?:was )?not found/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'text', selector: m[2], raw }),
  },
  // maestro-runner 1.0.x shape — issue #105.
  // "Element not found: id='X'" or "Element not found: text='X'".
  {
    re: /Element not found:\s*id=(['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'id', selector: m[2], raw }),
  },
  {
    re: /Element not found:\s*text=(['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'text', selector: m[2], raw }),
  },
  {
    re: /Element (['"])((?:(?!\1).)+)\1 (?:was )?not found/i,
    build: (m, raw) => ({
      kind: 'SELECTOR_NOT_FOUND',
      selectorKind: 'unknown',
      selector: m[2],
      raw,
    }),
  },
  {
    re: /Timed out waiting for element with id (['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: 'TIMEOUT', selector: m[2], raw }),
  },
  {
    re: /Timed out waiting for element (['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: 'TIMEOUT', selector: m[2], raw }),
  },
  {
    re: /Assertion failed: (['"])((?:(?!\1).)+)\1 (?:is )?not visible/i,
    build: (m, raw) => ({ kind: 'ASSERTION_FAILED', selector: m[2], raw }),
  },
  {
    re: /Element (['"])((?:(?!\1).)+)\1 is not visible/i,
    build: (m, raw) => ({ kind: 'ASSERTION_FAILED', selector: m[2], raw }),
  },
];

const RUNNER_STEP_RE = /^[ \t]+([✓✗])\s+(\S.*\S|\S)\s*\(([\d.]+)s\)\s*$/;
const REASON_LINE_RE = /^[ \t]+╰─\s+/;
const ID_WAIT_STEP_RE = /^extendedWaitUntil:\s+visible\s+id=(['"])((?:(?!\1).)+)\1$/i;
const SELECTOR_LESS_ID_WAIT_SUMMARY_RE = /^extendedWaitUntil$/;
const ID_WAIT_REASON_RE = /^[ \t]+╰─\s+Element (['"])#((?:(?!\1).)+)\1 not visible within\b/i;

// The reason lines belonging to one step block: everything up to the next step line.
function blockReasons(lines: string[], stepIndex: number): string[] {
  const reasons: string[] = [];
  for (let i = stepIndex + 1; i < lines.length; i++) {
    if (RUNNER_STEP_RE.test(lines[i])) break;
    if (REASON_LINE_RE.test(lines[i])) reasons.push(lines[i]);
  }
  return reasons;
}

// GH #580: maestro-runner 1.1.20 can render ONE failure as two blocks — a detailed
// step naming the id, then a selector-less summary repeating the identical reason.
// Requiring a byte-identical reason is what makes borrowing that id safe.
function idWaitStepAmongDuplicates(
  lines: string[],
  terminalIndex: number,
  terminalReason: string,
): RegExpExecArray | null {
  for (let i = terminalIndex - 1; i >= 0; i--) {
    const step = RUNNER_STEP_RE.exec(lines[i]);
    if (!step) continue;
    // A passing step, or a failure whose own reason differs, ends the duplicate
    // chain: only a block repeating this exact reason is the same failure.
    if (step[1] !== '✗') return null;
    if (!blockReasons(lines, i).includes(terminalReason)) return null;
    const stepMatch = ID_WAIT_STEP_RE.exec(step[2]);
    if (stepMatch) return stepMatch;
  }
  return null;
}

function parseTerminalIdWait(
  output: string,
  suppliedFailedStep: string | undefined,
): MaestroFailure | null {
  const lines = stripAnsi(output).split('\n');
  let terminalStep: { index: number; status: string; name: string } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const match = RUNNER_STEP_RE.exec(lines[index]);
    if (match) terminalStep = { index, status: match[1], name: match[2] };
  }
  if (terminalStep?.status === '✓') return null;
  if (suppliedFailedStep && terminalStep && terminalStep.name !== suppliedFailedStep) return null;
  const failedStep = suppliedFailedStep ?? terminalStep?.name;
  if (!failedStep || (terminalStep && terminalStep.status !== '✗')) return null;
  const reasonLine = lines
    .slice(terminalStep ? terminalStep.index + 1 : 0)
    .filter((line) => REASON_LINE_RE.test(line))
    .at(-1);
  if (!reasonLine) return null;
  const reasonMatch = ID_WAIT_REASON_RE.exec(reasonLine);
  if (!reasonMatch) return null;
  const stepMatch =
    ID_WAIT_STEP_RE.exec(failedStep) ??
    (terminalStep && SELECTOR_LESS_ID_WAIT_SUMMARY_RE.test(failedStep)
      ? idWaitStepAmongDuplicates(lines, terminalStep.index, reasonLine)
      : null);
  if (!stepMatch || reasonMatch[2] !== stepMatch[2]) return null;
  return {
    kind: 'SELECTOR_NOT_FOUND',
    selectorKind: 'id',
    selector: stepMatch[2],
    raw: output,
  };
}

export function parseMaestroFailure(
  output: string,
  terminal?: MaestroTerminalClassification,
): MaestroFailure {
  const raw = typeof output === 'string' ? output : '';
  if (terminal?.exitClass === 'timed-out') {
    return { kind: 'TIMEOUT', selector: terminal.failureSelector ?? null, raw };
  }
  // A terminal step classification, derived from the full uncapped stream,
  // always outranks an earlier WDA banner.
  if (terminal?.failureKind === 'SELECTOR_NOT_FOUND') {
    return {
      kind: 'SELECTOR_NOT_FOUND',
      selectorKind: 'unknown',
      selector: terminal.failureSelector ?? '',
      raw,
    };
  }
  if (terminal?.failureKind === 'TIMEOUT') {
    return { kind: 'TIMEOUT', selector: terminal.failureSelector ?? null, raw };
  }
  if (terminal?.failureKind === 'ASSERTION_FAILED') {
    return { kind: 'ASSERTION_FAILED', selector: terminal.failureSelector ?? null, raw };
  }
  if (terminal?.exitClass === 'before-first-step' && terminal.bootstrapEvidence) {
    return {
      kind: 'WDA_BOOTSTRAP_FAILED',
      detail: terminal.bootstrapEvidence.slice(0, 500),
      raw,
    };
  }
  if (!raw) {
    return { kind: 'UNKNOWN', raw: '' };
  }
  output = raw;
  const terminalIdWait = parseTerminalIdWait(output, terminal?.failedStep);
  if (terminalIdWait) return terminalIdWait;
  const lines = output.split('\n');
  for (const { re, build } of PATTERNS) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const m = line.match(re);
      if (m) return build(m as RegExpExecArray, output);
    }
  }
  // Fallback: whole-buffer scan for inputs without line breaks or for
  // any pattern that happens to straddle a `\n`.
  for (const { re, build } of PATTERNS) {
    const m = output.match(re);
    if (m) return build(m as RegExpExecArray, output);
  }
  return { kind: 'UNKNOWN', raw: output };
}

/**
 * Convenience predicate: is this a failure shape we know how to auto-
 * repair? Currently only `SELECTOR_NOT_FOUND` is in scope (per #104's
 * stated phase-1 contract).
 */
export function isAutoRepairable(failure: MaestroFailure): boolean {
  return failure.kind === 'SELECTOR_NOT_FOUND';
}

/**
 * GH#249/B193: exit-0 secondary guard for "flow failed despite a zero exit".
 * The previous bare `output.includes('FAILED')` scanned combined stdout+stderr
 * — which carries app/console logs — so a passing flow whose app logged
 * FETCH_FAILED (or any *_FAILED token) was flagged failed and triggered
 * pointless auto-repair. Key on Maestro's own terminal status LINES instead:
 * `Test FAILED` / `Flow FAILED` (JVM Maestro), a `[FAILED]` step marker, or a
 * line that IS the bare token. maestro-runner emits no uppercase FAILED at all
 * (verified against the binary), so app-log content is the only thing a
 * substring match could ever catch there.
 */
export function outputIndicatesFlowFailure(output: string): boolean {
  return /^\s*(?:\[FAILED\]|(?:Test|Flow) FAILED\b|FAILED\s*$)/m.test(output);
}
