#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  doctorPinnedRunner,
  getEngineStatus,
  MAESTRO_RUNNER_PIN,
  nodePlatformKey,
  _resetEngineStatusForTest,
} from './domain/engine-pin.js';
import { diagnoseLearnedActions, migrateLearnedActions } from './domain/action-engine-compat.js';

const USAGE =
  'usage: maestro-runner-pin [diagnose|diagnose-actions|migrate-actions] [--json] [--root <app>]';

async function diagnose(json: boolean): Promise<number> {
  _resetEngineStatusForTest();
  const status = await getEngineStatus();
  const report = doctorPinnedRunner(status, nodePlatformKey());
  const runtimeProbe = spawnSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  let bootedIosRuntimeMajors: number[] | null = null;
  if (runtimeProbe.status === 0) {
    try {
      const parsed = JSON.parse(runtimeProbe.stdout) as { devices?: Record<string, unknown> };
      bootedIosRuntimeMajors = Object.entries(parsed.devices ?? {})
        .filter(
          ([, devices]) =>
            Array.isArray(devices) && devices.some((device) => device?.state === 'Booted'),
        )
        .map(([runtime]) => Number(runtime.match(/SimRuntime\.iOS-(\d+)/)?.[1]))
        .filter((major) => Number.isSafeInteger(major));
    } catch {
      bootedIosRuntimeMajors = null;
    }
  }
  const wdaNativeCompatibility = {
    status:
      bootedIosRuntimeMajors === null
        ? ('unknown' as const)
        : bootedIosRuntimeMajors.length === 0
          ? ('not-applicable' as const)
          : ('native-smoke-required' as const),
    bootedRuntimeMajors: bootedIosRuntimeMajors,
    runtimeVersionHeuristicIsProof: false as const,
    detail:
      'Runtime version alone never proves WDA blindness. A bounded native-selector comparison distinguishes NATIVE_SURFACE_BLIND from an ordinary selector miss.',
    nextAction:
      'Run the central native WDA smoke on the target runtime; exact React testIDs use the react-tree proof domain.',
  };
  if (json) {
    console.log(
      JSON.stringify(
        { ...report, pin: MAESTRO_RUNNER_PIN.version, wdaNativeCompatibility },
        null,
        2,
      ),
    );
  } else {
    console.log(
      report.ok
        ? `maestro-runner ${report.installedVersion} pinned-ok (${report.provenance}: ${report.selectedPath})`
        : `maestro-runner pin ${report.status}: ${report.correction}`,
    );
    console.log(
      `iOS proof policy: exact testID=${report.iosProofPolicy.exactTestId}; native=${report.iosProofPolicy.nativeSurface}; WDA compatibility=${wdaNativeCompatibility.status} (runtime heuristic is not proof)`,
    );
  }
  return report.ok ? 0 : 1;
}

function formatActionIds(ids: readonly string[]): string {
  return ids.length === 0 ? '0' : `${ids.length} [${ids.join(',')}]`;
}

function diagnoseActions(root: string, json: boolean): number {
  const report = diagnoseLearnedActions(root);
  const failed =
    report.counts.enginePin + report.counts.regexSelector + report.counts.unreadable > 0;
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      failed
        ? `learned-actions FAIL scanned=${report.scanned} compatible=${report.compatible} enginePin=${formatActionIds(report.actionIds.enginePin)} regexSelector=${formatActionIds(report.actionIds.regexSelector)} unreadable=${formatActionIds(report.actionIds.unreadable)}`
        : `learned-actions OK scanned=${report.scanned} compatible=${report.compatible}`,
    );
  }
  return failed ? 1 : 0;
}

function migrate(root: string, json: boolean): number {
  const results = migrateLearnedActions(root);
  const failed = results.filter((r) => r.status === 'incompatible' || r.status === 'unreadable');
  if (json) {
    console.log(JSON.stringify({ root, results }, null, 2));
  } else {
    for (const row of results) {
      console.log(`${row.status}\t${row.id}${row.reason ? `\t${row.reason}` : ''}`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}

function parseArgs(argv: string[]): {
  cmd: string;
  json: boolean;
  root: string;
} {
  const json = argv.includes('--json');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 ? (argv[rootIdx + 1] ?? process.cwd()) : process.cwd();
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--root');
  const cmd = positional[0] ?? 'diagnose';
  return { cmd, json, root };
}

const { cmd, json, root } = parseArgs(process.argv.slice(2));
if (cmd === 'diagnose') {
  process.exit(await diagnose(json));
} else if (cmd === 'diagnose-actions') {
  process.exit(diagnoseActions(root, json));
} else if (cmd === 'migrate-actions') {
  process.exit(migrate(root, json));
} else {
  console.error(USAGE);
  process.exit(2);
}
