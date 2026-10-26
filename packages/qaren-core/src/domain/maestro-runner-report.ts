import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import type { LedgerObservationStatus, StructuredFlowArtifact } from './maestro-run-ledger.js';

export type ReportDeviceIdStrength = 'strong' | 'weak' | 'none';

export interface DirectMaestroRunnerEvidence {
  output: string;
  reportDeviceIds: string[];
  reportDeviceIdStrength: ReportDeviceIdStrength;
}

const DIRECT_DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

// maestro-runner renders the executing device either as a nested object or as a
// bare identifier, and names the identity field differently across its report
// writers. Each list is a precedence order, not a harvest set: one object
// describes one device, so the most authoritative present key wins and `id` is
// the last resort — it also spells model/device-type names ("iPhone-16-Pro").
const DEVICE_ID_KEYS = ['udid', 'deviceId', 'serial'] as const;
// `id` is the last resort ACROSS the whole report, not just within one object:
// mixing an authoritative `udid` from one writer with an `id` from another
// manufactures two identities for a single device.
const WEAK_DEVICE_ID_KEYS = ['id'] as const;
// `id` is deliberately absent here: on a run/flow container it names the run or
// flow, and harvesting it would inject a foreign identity into the evidence set.
const CONTAINER_DEVICE_ID_KEYS = ['udid', 'deviceId', 'deviceSerial'] as const;

function idsFrom(value: unknown, keys: readonly string[]): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const id = record[key];
    if (typeof id === 'string') return [id];
  }
  return [];
}

function deviceIdsFrom(value: unknown): string[] {
  return idsFrom(value, DEVICE_ID_KEYS);
}

// A bare string carries no key asserting it is an identity, and this writer
// also spells model names there ("iPhone-16-Pro" satisfies DIRECT_DEVICE_ID_RE).
// Treating it as strong made one such writer a permanent mismatch lockout, so
// it joins `id` in the last-resort tier the other two variants already use.
function weakDeviceIdsFrom(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return idsFrom(value, WEAK_DEVICE_ID_KEYS);
}

function containerDeviceIdsFrom(value: unknown): string[] {
  return idsFrom(value, CONTAINER_DEVICE_ID_KEYS);
}

function reportDeviceIds(reportDir: string): {
  ids: string[];
  strength: ReportDeviceIdStrength;
} {
  const reportPath = join(reportDir, 'report.json');
  if (!existsSync(reportPath)) return { ids: [], strength: 'none' };
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      device?: unknown;
      flows?: unknown;
    };
    const flows = Array.isArray(report.flows) ? report.flows : [];
    const devices = [report.device, ...flows.map((flow) => (flow as { device?: unknown })?.device)];
    const strong = [
      ...devices.flatMap((device) => deviceIdsFrom(device)),
      ...[report, ...flows].flatMap((container) => containerDeviceIdsFrom(container)),
    ];
    const usingStrong = strong.length > 0;
    const ids = usingStrong ? strong : devices.flatMap((device) => weakDeviceIdsFrom(device));
    const accepted = [
      ...new Set(ids.map((id) => id.trim()).filter((id) => DIRECT_DEVICE_ID_RE.test(id))),
    ];
    return {
      ids: accepted,
      strength: accepted.length === 0 ? 'none' : usingStrong ? 'strong' : 'weak',
    };
  } catch {
    return { ids: [], strength: 'none' };
  }
}

export function createRunnerReportDir(runner: string, prefix: string): string | null {
  if (runner !== 'maestro-runner') return null;
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

export function runnerReportArgs(reportDir: string | null): string[] {
  return reportDir ? ['--output', reportDir, '--flatten'] : [];
}

export function collectDirectRunnerEvidence(
  reportDir: string | null,
  output: string,
): DirectMaestroRunnerEvidence {
  if (!reportDir) return { output, reportDeviceIds: [], reportDeviceIdStrength: 'none' };
  const report = reportDeviceIds(reportDir);
  const evidence: DirectMaestroRunnerEvidence = {
    output,
    reportDeviceIds: report.ids,
    reportDeviceIdStrength: report.strength,
  };
  const logPath = join(reportDir, 'maestro-runner.log');
  if (!existsSync(logPath)) return evidence;
  try {
    evidence.output = `${output}\n${readFileSync(logPath, 'utf8')}`;
  } catch {
    // Structured report evidence remains available when the log is unreadable.
  }
  return evidence;
}

const OBSERVATION_STATUSES: ReadonlySet<string> = new Set([
  'passed',
  'failed',
  'skipped',
  'running',
  'pending',
]);

function observationStatus(value: unknown): LedgerObservationStatus {
  return typeof value === 'string' && OBSERVATION_STATUSES.has(value)
    ? (value as LedgerObservationStatus)
    : 'unknown';
}

/** Relative path → sha256 of content, for report.json and every flows/ file. */
export type RunnerReportFingerprint = Record<string, string>;

export const FINGERPRINT_INCONCLUSIVE = 'unreadable';

function contentHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    // Absent is conclusive (nothing existed); unreadable is not.
    return (error as { code?: string })?.code === 'ENOENT' ? null : FINGERPRINT_INCONCLUSIVE;
  }
}

export function runnerReportFingerprint(reportDir: string | null): RunnerReportFingerprint {
  const fingerprint: RunnerReportFingerprint = {};
  if (!reportDir) return fingerprint;
  const reportHash = contentHash(join(reportDir, 'report.json'));
  if (reportHash) fingerprint['report.json'] = reportHash;
  let flowEntries: string[] = [];
  try {
    flowEntries = readdirSync(join(reportDir, 'flows'));
  } catch (error) {
    if ((error as { code?: string })?.code !== 'ENOENT') {
      fingerprint['flows'] = FINGERPRINT_INCONCLUSIVE;
    }
    return fingerprint;
  }
  for (const entry of flowEntries.sort()) {
    const flowHash = contentHash(join(reportDir, 'flows', entry));
    if (flowHash) fingerprint[`flows/${entry}`] = flowHash;
  }
  return fingerprint;
}

// GH #623: producer per-command artifact for ONE invocation (report.json +
// flows/*.json). Fail-closed: null when nothing was written, finalized:false on
// any inconsistency. `previous` = pre-invocation fingerprint — stages share the
// report dir, so evidence not rewritten by THIS invocation is never attributed.
export function readStructuredFlowArtifact(
  reportDir: string | null,
  previous?: RunnerReportFingerprint,
  readText: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): StructuredFlowArtifact | null {
  if (!reportDir) return null;
  const reportPath = join(reportDir, 'report.json');
  if (!existsSync(reportPath)) return null;
  const unfinalized: StructuredFlowArtifact = {
    finalized: false,
    flowStatus: 'unknown',
    commands: [],
  };
  try {
    const reportText = readText(reportPath);
    if (previous) {
      // An inconclusive baseline can prove nothing about freshness.
      if (Object.values(previous).includes(FINGERPRINT_INCONCLUSIVE)) return unfinalized;
      const reportHash = createHash('sha256').update(reportText).digest('hex');
      if (previous['report.json'] === reportHash) return null; // nothing written this invocation
    }
    const report = JSON.parse(reportText) as {
      status?: unknown;
      flows?: unknown;
    };
    const flows = Array.isArray(report.flows) ? report.flows : [];
    if (flows.length !== 1) return unfinalized;
    const flow = flows[0] as {
      status?: unknown;
      dataFile?: unknown;
      commands?: { total?: unknown };
    };
    const flowStatus =
      flow.status === 'passed' || flow.status === 'failed' ? flow.status : 'unknown';
    if (flowStatus === 'unknown') return unfinalized;
    if (typeof flow.dataFile !== 'string' || flow.dataFile.length === 0) return unfinalized;
    // The dataFile must be exactly flows/<name> — the shape the fingerprint
    // records — so its pre-invocation state is always conclusively known and
    // it can never resolve outside the report tree.
    const normalizedDataFile = flow.dataFile;
    if (isAbsolute(normalizedDataFile) || !/^flows\/[^/\\]+$/.test(normalizedDataFile)) {
      return unfinalized;
    }
    // Symlink containment: the resolved file must live under the resolved
    // report tree, not merely have a clean lexical path.
    const realDataFile = realpathSync(join(reportDir, normalizedDataFile));
    if (!realDataFile.startsWith(realpathSync(reportDir) + sep)) return unfinalized;
    const dataText = readText(realDataFile);
    if (previous) {
      const dataHash = createHash('sha256').update(dataText).digest('hex');
      // A fresh report.json referencing a data file the invocation did NOT
      // rewrite is mixed-generation evidence — refuse to attribute it.
      if (previous[normalizedDataFile] === dataHash) return unfinalized;
    }
    const data = JSON.parse(dataText) as {
      commands?: unknown;
    };
    if (!Array.isArray(data.commands)) return unfinalized;
    let malformedRow = false;
    const seenIndices = new Set<number>();
    const commands = data.commands.map((entry) => {
      const record = (entry ?? {}) as {
        index?: unknown;
        type?: unknown;
        status?: unknown;
        error?: unknown;
      };
      const error = (record.error ?? undefined) as { message?: unknown } | undefined;
      const status = observationStatus(record.status);
      // The producer's own index must be a unique non-negative integer; array
      // position never substitutes for a missing or malformed one.
      const producerIndex =
        typeof record.index === 'number' && Number.isInteger(record.index) && record.index >= 0
          ? record.index
          : null;
      if (producerIndex === null || seenIndices.has(producerIndex)) {
        malformedRow = true;
      } else {
        seenIndices.add(producerIndex);
      }
      if (typeof record.type !== 'string' || record.type.length === 0 || status === 'unknown') {
        malformedRow = true;
      }
      return {
        index: producerIndex ?? -1,
        type: typeof record.type === 'string' ? record.type : 'unknown',
        status,
        ...(error && typeof error.message === 'string'
          ? { error: error.message.slice(0, 500) }
          : {}),
      };
    });
    // A malformed row poisons the whole inventory: no fabricated identity may
    // reach ledger consumers, even as diagnostics.
    if (malformedRow) return { finalized: false, flowStatus, commands: [] };
    const counts = (flow.commands ?? {}) as Record<string, unknown>;
    const statusCount = (status: string): number =>
      commands.filter((command) => command.status === status).length;
    // Fail-closed: the pinned producer always writes all six aggregates, so a
    // missing or contradictory one reads as unfinalized rather than tolerated.
    const countExact = (key: string, actual: number): boolean => counts[key] === actual;
    // A flow verdict must agree with its own rows: 'failed' requires a failed
    // row, 'passed' forbids one. Producer indices must be exactly 0..n-1.
    const anyFailedRow = commands.some((command) => command.status === 'failed');
    const contiguousIndices = Array.from({ length: commands.length }, (_, i) => i).every((i) =>
      seenIndices.has(i),
    );
    const finalized =
      (report.status === 'passed' || report.status === 'failed') &&
      report.status === flowStatus &&
      (flowStatus === 'failed') === anyFailedRow &&
      !malformedRow &&
      contiguousIndices &&
      commands.length > 0 &&
      countExact('total', commands.length) &&
      countExact('passed', statusCount('passed')) &&
      countExact('failed', statusCount('failed')) &&
      countExact('skipped', statusCount('skipped')) &&
      countExact('running', 0) &&
      countExact('pending', 0) &&
      commands.every((command) => command.status !== 'running' && command.status !== 'pending');
    return { finalized, flowStatus, commands };
  } catch {
    return unfinalized;
  }
}

// The report tree is scratch space for direct device/WDA evidence only; keeping it
// would leak one full tree (log, html, json, screenshots) per flow into tmpdir.
export function disposeRunnerReportDir(reportDir: string | null): void {
  if (!reportDir) return;
  try {
    rmSync(reportDir, { recursive: true, force: true });
  } catch {
    // Best effort: a stale tmp tree must never fail a flow.
  }
}
