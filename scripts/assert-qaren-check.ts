import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface CoreCleanupEvidence {
  run_id?: string;
  pgid?: number;
  at?: string;
  outcome?: string;
}

interface FreshInstallEvidence {
  run_id?: string;
  app_id?: string;
  device_id?: string;
  proven_absent_at?: string;
  status?: string;
}

function timestamp(value: unknown): number {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    ? Date.parse(value)
    : NaN;
}

export function assertCheck(
  receipt: unknown,
  ledger: unknown,
  requireJevWalk: boolean,
  runRecord: unknown,
): void {
  const r = receipt as
    | {
        schema?: string;
        verb?: string;
        run_id?: string;
        phase?: string;
        failure?: unknown;
        emitted_at?: string;
        candidate?: { app_id?: string };
        core_cleanup?: CoreCleanupEvidence;
        fresh_install?: FreshInstallEvidence;
        result?: string;
        ledger?: { verdict?: string };
        device?: { ios_udid?: string };
        cleanup?: Record<string, unknown>;
        outcomes?: { fresh_install?: string };
      }
    | undefined;
  const record = runRecord as
    | {
        schema?: string;
        run_id?: string;
        phase?: string;
        failure?: unknown;
        created_at?: string;
        candidate?: { app_id?: string };
        resources?: Record<string, unknown> & {
          device_borrowed?: boolean;
          ios_simulator?: { udid?: string };
          core_cleanup?: CoreCleanupEvidence;
          fresh_install?: FreshInstallEvidence;
        };
      }
    | undefined;
  const l = ledger as
    | {
        verdict?: string;
        llmTurns?: number;
        escapes?: number;
        recoveries?: number;
        jev?: { calls?: number; callDetails?: { scope: string; outcome: string }[] };
        steps?: { resolvedBy: string }[];
      }
    | undefined;
  if (r?.result !== 'pass' || r?.ledger?.verdict !== 'PASS' || l?.verdict !== 'PASS')
    throw new Error('receipt and ledger must both say PASS');
  const removedOrAbsent = (value: unknown): boolean => value === 'removed' || value === 'absent';
  if (
    r.schema !== 'qaren/1' ||
    r.verb !== 'check' ||
    r.phase !== 'cleaned' ||
    r.failure != null ||
    !r.run_id ||
    r.run_id === 'none' ||
    !r.device?.ios_udid ||
    !r.cleanup ||
    !removedOrAbsent(r.cleanup.device_lease) ||
    !removedOrAbsent(r.cleanup.metro) ||
    !removedOrAbsent(r.cleanup.core) ||
    r.cleanup.simulator !== 'kept' ||
    Object.entries(r.cleanup).some(
      ([name, value]) => name !== 'simulator' && !removedOrAbsent(value),
    ) ||
    record?.schema !== 'qaren-run/1' ||
    record.run_id !== r.run_id ||
    record.phase !== 'cleaned' ||
    record.failure != null ||
    record.resources?.device_borrowed !== true ||
    record.resources.ios_simulator?.udid !== r.device.ios_udid ||
    Object.entries(record.resources).some(
      ([name, value]) =>
        !['device_borrowed', 'ios_simulator', 'core_cleanup', 'fresh_install'].includes(name) &&
        value != null,
    )
  )
    throw new Error(
      'the phase gate requires proven clean teardown in the receipt and matching run record',
    );
  const core = r.core_cleanup;
  const storedCore = record.resources.core_cleanup;
  if (
    !core ||
    !storedCore ||
    core.run_id !== r.run_id ||
    !Number.isInteger(core.pgid) ||
    (core.pgid ?? 0) < 2 ||
    core.outcome !== r.cleanup.core ||
    !(['run_id', 'pgid', 'at', 'outcome'] as const).every((key) => core[key] === storedCore[key]) ||
    !(
      timestamp(record.created_at) <= timestamp(core.at) &&
      timestamp(core.at) <= timestamp(r.emitted_at)
    )
  )
    throw new Error(
      'the phase gate requires positive, durable, run-bound core group cleanup proof',
    );
  const fresh = r.fresh_install;
  const storedFresh = record.resources.fresh_install;
  if (
    r.outcomes?.fresh_install !== 'proven_absent' ||
    !fresh ||
    !storedFresh ||
    fresh.status !== 'proven_absent' ||
    fresh.run_id !== r.run_id ||
    !fresh.app_id ||
    fresh.app_id !== r.candidate?.app_id ||
    fresh.app_id !== record.candidate?.app_id ||
    fresh.device_id !== r.device.ios_udid ||
    !(['run_id', 'app_id', 'device_id', 'proven_absent_at', 'status'] as const).every(
      (key) => fresh[key] === storedFresh[key],
    ) ||
    !(
      timestamp(record.created_at) <= timestamp(fresh.proven_absent_at) &&
      timestamp(fresh.proven_absent_at) <= timestamp(core.at)
    )
  )
    throw new Error(
      'the phase gate requires matching durable fresh-install absence for this run, app and device',
    );
  if (l.llmTurns !== 0 || l.escapes !== 0 || l.recoveries !== 0)
    throw new Error('the phase gate must not use recovery or an escape');
  if (
    requireJevWalk &&
    (!((l.jev?.calls ?? 0) > 0) ||
      !l.jev?.callDetails?.some((c) => c.scope === 'walk' && c.outcome === 'ok') ||
      !l.steps?.some((s) => s.resolvedBy === 'jev'))
  )
    throw new Error(
      'phrase gate needs a successful walk judgment; preflight alone is insufficient',
    );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const receipt = JSON.parse(readFileSync(0, 'utf8'));
    const ledger = JSON.parse(readFileSync(receipt.artifacts.ledger, 'utf8'));
    const record = JSON.parse(readFileSync(receipt.artifacts.run_record, 'utf8'));
    assertCheck(receipt, ledger, process.env.QAREN_REQUIRE_JEV_WALK === '1', record);
    console.log(
      `gate:qaren-check: PASS steps=${receipt.ledger.steps} jev.calls=${ledger.jev.calls} report=${receipt.artifacts.report}`,
    );
  } catch {
    console.error('gate:qaren-check: receipt, ledger or run record did not meet the phase gate');
    process.exitCode = 1;
  }
}
