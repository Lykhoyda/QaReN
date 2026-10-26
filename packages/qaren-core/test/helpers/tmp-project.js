// Issue #103 — tmp project root fixture for handler integration tests.
//
// Spins up a disposable directory under os.tmpdir() laid out the way a
// real RN project under cdp-bridge expects:
//
//   <tmpRoot>/
//     .qaren/
//       actions/   ← YAML files for ReusableAction
//       state/     ← <id>.state.json sidecar files
//
// Tests build a tmp project, drop fixture YAML/state files in, invoke a
// handler with `projectRoot: <tmpRoot>`, assert on disk + envelope, then
// dispose of the tmp tree.

import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReplayEngineStatus, MAESTRO_RUNNER_PIN } from '../../dist/domain/engine-pin.js';
import { createRunActionHandler } from '../../dist/handlers/run-action.js';

const PINNED_ENGINE_STATUS = buildReplayEngineStatus(
  'pinned-ok',
  MAESTRO_RUNNER_PIN.version,
  false,
  {
    selectedPath: `/test/pin-cache/${MAESTRO_RUNNER_PIN.version}/bin/maestro-runner`,
    provenance: 'pin-cache',
  },
);

export function createPinnedRunActionHandler(deps = {}) {
  return createRunActionHandler({
    ...deps,
    engineStatus: deps.engineStatus ?? (async () => PINNED_ENGINE_STATUS),
  });
}

export function createTmpProject() {
  const root = mkdtempSync(join(tmpdir(), 'rn-agent-test-'));
  const actionsDir = join(root, '.qaren', 'actions');
  const stateDir = join(root, '.qaren', 'state');
  mkdirSync(actionsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  return {
    root,
    actionsDir,
    stateDir,

    /** Resolve absolute path for a fixture YAML by id. */
    yamlPath(id) {
      return join(actionsDir, `${id}.yaml`);
    },

    /** Resolve absolute path for the sidecar JSON by id. */
    sidecarPath(id) {
      return join(stateDir, `${id}.state.json`);
    },

    /**
     * Write a fixture YAML + sidecar pair atomically (no atomicity bug,
     * since we're seeding the test, not exercising the production write).
     * `state` may include lastSeenMtimeMs sentinel — pass null to seed
     * with the YAML's actual mtime AFTER write.
     */
    seedAction(id, yamlText, state) {
      if (!/#\s*enginePin\s*:/.test(yamlText)) {
        yamlText = yamlText.replace(
          /(#\s*status\s*:\s*.+)$/m,
          `$1\n# enginePin: maestro-runner@1.1.28`,
        );
        if (!/#\s*enginePin\s*:/.test(yamlText)) {
          yamlText = `${yamlText.replace(/\s*$/, '')}\n# enginePin: maestro-runner@1.1.28\n`;
        }
      }
      const yamlPath = join(actionsDir, `${id}.yaml`);
      const statePath = join(stateDir, `${id}.state.json`);
      writeFileSync(yamlPath, yamlText, 'utf8');
      const yamlMtimeMs = statSync(yamlPath).mtimeMs;
      const stateBlob = state ?? freshFixtureState(yamlMtimeMs);
      // If caller passed state without an explicit lastSeenMtimeMs (or
      // with the placeholder 0), align it to the YAML's actual mtime so
      // `yamlEditedSinceLastSeen` returns false by default. Tests that
      // want to simulate a human edit should call simulateHumanEdit().
      if (!stateBlob.lastSeenMtimeMs) {
        stateBlob.lastSeenMtimeMs = yamlMtimeMs;
      }
      writeFileSync(statePath, JSON.stringify(stateBlob, null, 2) + '\n', 'utf8');
      return { yamlPath, statePath, mtimeMs: yamlMtimeMs };
    },

    /**
     * Rewrite the YAML on disk WITHOUT touching the sidecar — simulates
     * a human edit. Bumps mtime explicitly via utimesSync so the test
     * doesn't race the filesystem's coarse mtime resolution.
     */
    simulateHumanEdit(id, newYaml) {
      const yamlPath = join(actionsDir, `${id}.yaml`);
      writeFileSync(yamlPath, newYaml, 'utf8');
      // Force mtime forward by 5 seconds — defeats fs mtime granularity.
      const future = new Date(Date.now() + 5_000);
      utimesSync(yamlPath, future, future);
    },

    readYaml(id) {
      return readFileSync(join(actionsDir, `${id}.yaml`), 'utf8');
    },

    readSidecar(id) {
      const path = join(stateDir, `${id}.state.json`);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },

    yamlExists(id) {
      return existsSync(join(actionsDir, `${id}.yaml`));
    },

    sidecarExists(id) {
      return existsSync(join(stateDir, `${id}.state.json`));
    },

    /** Tear down the entire tmp tree. Idempotent. */
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Already gone or in use — best-effort.
      }
    },
  };
}

/**
 * Minimal valid M7 YAML body — appId top section, --- separator, M7
 * header comment block, then a tiny tap action. Used as the "before"
 * fixture for repair tests; callers pick which selectors to embed.
 */
export function fixtureYaml({
  id = 'test-action',
  intent = 'test fixture',
  bundleId = 'com.test.app',
  status = 'experimental',
  selectors = ['fab-create-task'],
  tags = ['fixture'],
} = {}) {
  const tapLines = selectors.map((sel) => `- tapOn:\n    id: "${sel}"`).join('\n');
  return [
    `appId: ${bundleId}`,
    '---',
    `# id: ${id}`,
    `# intent: ${intent}`,
    `# tags: [${tags.join(', ')}]`,
    '# mutates: false',
    `# status: ${status}`,
    '# enginePin: maestro-runner@1.1.28',
    '',
    '- launchApp',
    tapLines,
    '',
  ].join('\n');
}

/**
 * Fresh sidecar JSON shape matching reusable-action.ts schemaVersion 1.
 * Tests can override fields after the fact.
 */
export function freshFixtureState(lastSeenMtimeMs = 0) {
  return {
    schemaVersion: 1,
    revision: 1,
    updatedAt: '2026-05-04T00:00:00.000Z',
    lastSeenMtimeMs,
    runHistory: [],
    repairHistory: [],
    stats: {
      totalRuns: 0,
      successCount: 0,
      failureCount: 0,
      avgDurationMs: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    },
  };
}
