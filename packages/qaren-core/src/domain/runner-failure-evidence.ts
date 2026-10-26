import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import {
  readStructuredFlowArtifact,
  type RunnerReportFingerprint,
} from './maestro-runner-report.js';
import type { LedgerInvocationTermination, LedgerObservationStatus } from './maestro-run-ledger.js';

const MAX_CAPTURES = 8;
const MAX_ROWS = 64;
const MAX_REPORT_BYTES = 256 * 1024;
const STATUSES = ['passed', 'failed', 'skipped', 'running', 'pending', 'unknown'] as const;
const REPORT_STATES = ['missing', 'unavailable', 'oversized', 'unfinalized', 'finalized'] as const;

type FailureCapture = {
  attempt: number;
  stage: number;
  invocation: number;
  exitCode: number | null;
  signalPresent: boolean;
  timedOut: boolean;
  outputTruncated: boolean;
  bootstrapFailure: boolean;
  transportFailure: boolean;
  report: (typeof REPORT_STATES)[number];
  rowsTruncated: boolean;
  commands: { index: number; status: LedgerObservationStatus; errorPresent: boolean }[];
};

export type RunnerFailureEvidence = {
  version: 1;
  incomplete: true;
  withheld: 'text-images-terminal-output-and-original-artifacts';
  capturesTruncated: boolean;
  captures: FailureCapture[];
};

export function createRunnerFailureEvidence(): RunnerFailureEvidence {
  return {
    version: 1,
    incomplete: true,
    withheld: 'text-images-terminal-output-and-original-artifacts',
    capturesTruncated: false,
    captures: [],
  };
}

function append(evidence: RunnerFailureEvidence, capture: FailureCapture): void {
  evidence.captures.push(capture);
  if (evidence.captures.length > MAX_CAPTURES) {
    evidence.captures.splice(1, 1);
    evidence.capturesTruncated = true;
  }
}

export function captureRunnerFailure(
  evidence: RunnerFailureEvidence,
  reportDir: string | null,
  previous: RunnerReportFingerprint,
  stage: number,
  invocation: number,
  termination: Omit<LedgerInvocationTermination, 'artifactFinalized'>,
  attempt = 1,
): void {
  const capture: FailureCapture = {
    attempt,
    stage,
    invocation,
    exitCode: Number.isSafeInteger(termination.exitCode) ? termination.exitCode : null,
    signalPresent: termination.signal !== null,
    timedOut: termination.timedOut,
    outputTruncated: termination.outputTruncated,
    bootstrapFailure: termination.bootstrapFailure,
    transportFailure: termination.transportFailure,
    report: 'missing',
    rowsTruncated: false,
    commands: [],
  };
  try {
    if (reportDir) {
      if (!lstatSync(reportDir).isDirectory()) throw new Error();
      const root = realpathSync(reportDir);
      const reportPath = join(root, 'report.json');
      lstatSync(reportPath);
      let readFailure: 'unavailable' | 'oversized' | undefined;
      let remaining = MAX_REPORT_BYTES;
      const artifact = readStructuredFlowArtifact(root, previous, (path) => {
        let fd: number | undefined;
        try {
          if (!realpathSync(path).startsWith(root + sep)) throw new Error();
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = fstatSync(fd);
          if (!stat.isFile()) throw new Error();
          if (stat.size > remaining) {
            readFailure = 'oversized';
            throw new Error();
          }
          const bytes = Buffer.alloc(stat.size + 1);
          const size = readSync(fd, bytes, 0, bytes.length, 0);
          if (size !== stat.size || fstatSync(fd).size !== size) throw new Error();
          remaining -= size;
          return bytes.subarray(0, size).toString('utf8');
        } catch (error) {
          readFailure ??= 'unavailable';
          throw error;
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      });
      capture.report =
        readFailure ?? (artifact ? (artifact.finalized ? 'finalized' : 'unfinalized') : 'missing');
      if (artifact?.finalized && !readFailure) {
        capture.rowsTruncated = artifact.commands.length > MAX_ROWS;
        const rows = [...artifact.commands].sort(
          (a, b) => Number(b.status === 'failed') - Number(a.status === 'failed'),
        );
        capture.commands = rows.slice(0, MAX_ROWS).map((row) => ({
          index: row.index,
          status: row.status,
          errorPresent: row.error !== undefined,
        }));
      }
    }
  } catch (error) {
    capture.report = (error as { code?: string }).code === 'ENOENT' ? 'missing' : 'unavailable';
  }
  append(evidence, capture);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// Re-project at the action boundary; tool metadata is not a storage schema.
export function collectRunnerFailureEvidence(
  evidence: RunnerFailureEvidence,
  value: unknown,
): void {
  const input = record(value);
  if (input.version !== 1 || !Array.isArray(input.captures)) return;
  evidence.capturesTruncated ||=
    input.capturesTruncated === true || input.captures.length > MAX_CAPTURES;
  const captures =
    input.captures.length > MAX_CAPTURES
      ? [input.captures[0], ...input.captures.slice(-(MAX_CAPTURES - 1))]
      : input.captures;
  for (const item of captures) {
    const row = record(item);
    if (!Number.isSafeInteger(row.stage) || !Number.isSafeInteger(row.invocation)) continue;
    const state = REPORT_STATES.find((state) => state === row.report) ?? 'unavailable';
    const commands = Array.isArray(row.commands) ? row.commands : [];
    append(evidence, {
      attempt: Number.isSafeInteger(row.attempt) ? Number(row.attempt) : 1,
      stage: Number(row.stage),
      invocation: Number(row.invocation),
      exitCode: Number.isSafeInteger(row.exitCode) ? Number(row.exitCode) : null,
      signalPresent: row.signalPresent === true,
      timedOut: row.timedOut === true,
      outputTruncated: row.outputTruncated === true,
      bootstrapFailure: row.bootstrapFailure === true,
      transportFailure: row.transportFailure === true,
      report: state,
      rowsTruncated: row.rowsTruncated === true || commands.length > MAX_ROWS,
      commands: commands.slice(0, MAX_ROWS).flatMap((item) => {
        const command = record(item);
        if (!Number.isSafeInteger(command.index)) return [];
        return [
          {
            index: Number(command.index),
            status: STATUSES.find((status) => status === command.status) ?? 'unknown',
            errorPresent: command.errorPresent === true,
          },
        ];
      }),
    });
  }
}
