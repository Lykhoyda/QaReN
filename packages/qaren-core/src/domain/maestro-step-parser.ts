// src/domain/maestro-step-parser.ts
// GH #211: structure maestro_run results from maestro-runner stdout. Pure, no
// I/O, fail-open: unparseable output yields []. Generalizes the #263 step-line
// parser (tap-latency.ts derives parseTapLatencies from parseSteps).

import { parseMaestroFailure } from './maestro-error-parser.js';
import { stripAnsi } from './ansi.js';

export { stripAnsi } from './ansi.js';

export interface MaestroStep {
  index: number;
  name: string;
  verb: string;
  status: 'pass' | 'fail';
  durationMs: number;
}

// `<indent>{✓|✗} <name> (N.Ns)` — the leading `[ \t]+` anchors on the runner's
// line shape: real steps are indented with spaces (live renderer: 4 spaces,
// nested runFlow sub-steps 6+), so an unindented (column-0) line shaped like a
// step — an app log in the combined stdout+stderr — is rejected and can't poison
// the parsed steps (B212). The anchor is HORIZONTAL whitespace only: `\s` would
// also match `\r`/`\v`/`\f`/NBSP, which routinely lead terminal/progress/app-log
// lines and would re-open the column-0 vector. The trailing (N.Ns) is REQUIRED,
// which also excludes the `✗ rn-maestro-run 23.8s` summary and `N steps passing`
// count lines. The name is `\S.*\S|\S` (must start AND end non-whitespace), which
// keeps a duration-looking token inside the selector value (`text="took (2.0s)"`)
// losing to the real trailing `$`-anchored duration; the non-overlapping
// quantifiers (vs a `\s+(.*?)\s*` pattern) avoid catastrophic backtracking
// (ReDoS) on the untrusted multi-MB combined output.
const STEP_RE = /^[ \t]+([✓✗])\s+(\S.*\S|\S)\s*\(([\d.]+)s\)\s*$/;

// Bound any text interpolated into results/headline so a pathological step name
// or selector (e.g. a multi-KB inputText value) can't balloon the failure
// message and defeat the sliced `output` field.
const MAX_FIELD = 200;
function cap(s: string): string {
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + '…' : s;
}

// Cap the returned steps so a pathological run (a multi-MB stdout/stderr with
// many step-shaped log lines) can't bloat the MCP response past the `output`
// slice. Keep the most recent steps — failures and partial-progress live at the
// tail — with their true `index` preserved (a gap signals truncation).
const MAX_STEPS = 1000;

// Combine runner stdout+stderr for parsing WITHOUT destroying per-line leading
// indentation. parseSteps anchors on the runner's space indent (B212), so a
// blanket `.trim()` would strip the FIRST line's indent and drop the first step
// (typically `launchApp`) from the result. Trailing whitespace uses native
// `.trimEnd()` (linear — a `/\s+$/` regex is O(n²) on multi-MB non-whitespace-
// terminated output); leading BLANK LINES are stripped with a start-anchored
// `^[\r\n]+` that cannot backtrack and never touches a content line's indent.
export function combineRunnerOutput(stdout: string, stderr: string): string {
  return (stdout + '\n' + stderr).replace(/^[\r\n]+/, '').trimEnd();
}

function parseExactSteps(output: string): MaestroStep[] {
  if (!output || typeof output !== 'string') return [];
  const steps: MaestroStep[] = [];
  let index = 0;
  for (const raw of stripAnsi(output).split('\n')) {
    const m = STEP_RE.exec(raw);
    if (!m) continue;
    const name = m[2];
    const verb = cap(name.split(/\s+/)[0].replace(/:$/, ''));
    if (verb === 'rn-maestro-run') continue; // belt-and-suspenders vs a future summary format
    const seconds = Number(m[3]);
    if (!Number.isFinite(seconds)) continue;
    steps.push({
      index: index++,
      name,
      verb,
      status: m[1] === '✓' ? 'pass' : 'fail',
      durationMs: Math.round(seconds * 1000),
    });
  }
  return steps.length > MAX_STEPS ? steps.slice(-MAX_STEPS) : steps;
}

function boundStep(step: MaestroStep): MaestroStep {
  return { ...step, name: cap(step.name) };
}

export function parseSteps(output: string): MaestroStep[] {
  return parseExactSteps(output).map(boundStep);
}

// The TERMINAL failed step: the last parsed step iff it failed. maestro-runner
// stops at the first real failure, so the terminal ✗ is the last parsed step; a
// transient ✗ that was retried-✓ before a later timeout is NOT reported, because
// the last parsed step is then the recovery ✓.
export function findFailedStep(steps: MaestroStep[]): MaestroStep | null {
  const last = steps.length ? steps[steps.length - 1] : null;
  return last && last.status === 'fail' ? last : null;
}

export function lastObservedStep(steps: MaestroStep[]): MaestroStep | null {
  return steps.length ? steps[steps.length - 1] : null;
}

export interface ReasonSummary {
  kind: 'SELECTOR_NOT_FOUND' | 'TIMEOUT' | 'ASSERTION_FAILED';
  selector: string | null;
}

// Project parseMaestroFailure to {kind, selector}, DROPPING its `raw` field —
// every MaestroFailure variant carries `raw` = the full unsliced output, which
// must not be re-embedded into the result (it would defeat the output slice).
function summarizeExactReason(output: string, failedStep?: string): ReasonSummary | null {
  const f = parseMaestroFailure(output, failedStep ? { failedStep } : undefined);
  if (f.kind === 'UNKNOWN' || f.kind === 'WDA_BOOTSTRAP_FAILED') return null;
  const selector = 'selector' in f ? (f.selector ?? null) : null;
  return { kind: f.kind, selector };
}

export function summarizeReason(output: string, failedStep?: string): ReasonSummary | null {
  const reason = summarizeExactReason(output, failedStep);
  if (!reason) return null;
  return { ...reason, selector: reason.selector === null ? null : cap(reason.selector) };
}

export interface StepSummary {
  steps: MaestroStep[];
  failedStep: MaestroStep | null;
  reason: ReasonSummary | null;
  lastStep: MaestroStep | null;
}

// failedStep/reason are populated ONLY when the run's terminal verdict is fail
// (opts.failed). maestro-runner logs transient retries; a fail-then-retry-✓ on
// a PASSED run must not report a failedStep (mirrors parseMaestroFailure GH#118).
export function buildStepSummary(output: string, opts: { failed: boolean }): StepSummary {
  const exactSteps = parseExactSteps(output);
  const exactFailedStep = opts.failed ? findFailedStep(exactSteps) : null;
  const exactReason = opts.failed ? summarizeExactReason(output, exactFailedStep?.name) : null;
  const steps = exactSteps.map(boundStep);
  return {
    steps,
    failedStep: exactFailedStep ? boundStep(exactFailedStep) : null,
    reason: exactReason
      ? {
          ...exactReason,
          selector: exactReason.selector === null ? null : cap(exactReason.selector),
        }
      : null,
    lastStep: lastObservedStep(steps),
  };
}

export type MaestroTerminalExitClass =
  | 'before-first-step'
  | 'step-failure'
  | 'timed-out'
  | 'spawn-error';

export interface MaestroTerminalEvidence {
  completedSteps: number;
  failedStep?: string;
  exitClass: MaestroTerminalExitClass;
  bootstrapEvidence?: string;
  /** Full-output classification projected before the human output is capped. */
  failureKind?: ReasonSummary['kind'];
  failureSelector?: string | null;
}

// Every healthy iOS run narrates WDA ("Building WebDriverAgent for the first
// time...", "Starting WDA on device ..."), so a bare WDA mention proves nothing.
// Bootstrap evidence must carry failure semantics, otherwise an unrelated
// pre-step death (app not installed, locked device, simctl error) gets reported
// as a WDA bootstrap failure and auto-repair is refused for the wrong reason.
const WDA_TOKEN_RE = /\bWDA\b|WebDriverAgent/i;
const WDA_FAILURE_RE =
  /\b(?:fail(?:ed|ure|s)?|error|unable|cannot|can't|could not|timed out|timeout|refused|denied|crash(?:ed)?|panic|aborted)\b/i;

function isWdaFailureLine(line: string): boolean {
  return WDA_TOKEN_RE.test(line) && WDA_FAILURE_RE.test(line);
}

export function buildTerminalEvidence(
  output: string,
  opts: { timedOut?: boolean; spawnError?: boolean } = {},
): MaestroTerminalEvidence {
  const exactSteps = parseExactSteps(output);
  const failedStep = findFailedStep(exactSteps);
  const reason = summarizeExactReason(output, failedStep?.name);
  const bootstrapEvidence = stripAnsi(output)
    .split('\n')
    .filter((line) => isWdaFailureLine(line))
    .join('\n')
    .slice(0, 500);
  const exitClass: MaestroTerminalExitClass = opts.timedOut
    ? 'timed-out'
    : opts.spawnError
      ? 'spawn-error'
      : exactSteps.length === 0
        ? 'before-first-step'
        : 'step-failure';
  return {
    completedSteps: exactSteps.filter((step) => step.status === 'pass').length,
    ...(failedStep ? { failedStep: failedStep.name } : {}),
    exitClass,
    ...(bootstrapEvidence ? { bootstrapEvidence } : {}),
    ...(reason
      ? {
          failureKind: reason.kind,
          failureSelector: reason.selector,
        }
      : {}),
  };
}

export interface ExecErrorClass {
  timedOut: boolean;
  outputTruncated: boolean;
}

// execFile timeout kills the child (killed===true, signal 'SIGTERM', code null).
// A 10MB maxBuffer overflow ALSO rejects with killed===true but code
// 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' — that's truncation, not a timeout, so it
// must not be mislabeled. `killed` is authoritative; `code` only subtracts the
// overflow case (a SIGTERM-trapping child can leave a non-null exit code).
export function classifyExecError(err: unknown): ExecErrorClass {
  const e = err as { killed?: unknown; code?: unknown } | null;
  const killed = e?.killed === true;
  const overflow = e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  return { timedOut: (killed || e?.code === 'ETIMEDOUT') && !overflow, outputTruncated: overflow };
}

// Headline for a failed maestro_run, built from STRUCTURED data so it never
// re-embeds raw runner/app output. The raw fallbackMsg (err.message, which
// execFile populates with stderr) is used ONLY when there is no structured
// signal — e.g. a spawn/system error with no step output. Raw output still
// lives in the bounded `output` field.
export function formatFailureHeadline(
  summary: StepSummary,
  cls: ExecErrorClass,
  fallbackMsg: string,
): string {
  if (cls.timedOut) {
    return `Maestro flow timed out${summary.lastStep ? ` after step "${summary.lastStep.name}"` : ''}`;
  }
  if (cls.outputTruncated) {
    return 'Maestro flow output exceeded the 10MB buffer';
  }
  if (summary.failedStep) {
    const r = summary.reason;
    const reasonStr = r ? ` (${r.kind}${r.selector ? `: ${r.selector}` : ''})` : '';
    return `Maestro flow failed at step "${summary.failedStep.name}"${reasonStr}`;
  }
  // No terminal ✗ step line (e.g. it was truncated) but a recognizable error
  // string survived — prefer the structured, raw-free reason over the raw msg.
  if (summary.reason) {
    const r = summary.reason;
    return `Maestro flow failed (${r.kind}${r.selector ? `: ${r.selector}` : ''})`;
  }
  return `Maestro flow failed: ${fallbackMsg.slice(0, 500)}`;
}
