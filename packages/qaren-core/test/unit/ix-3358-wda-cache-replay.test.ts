import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  MAESTRO_RUNNER_PIN,
  _resetEngineStatusForTest,
  _setPinnedRunnerAttestationForTest,
  buildReplayEngineStatus,
  withImmediatePinnedRunner,
} from '../../dist/domain/engine-pin.js';
import {
  createPinnedRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

const publicationHelperSupported =
  process.platform === 'darwin' ||
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'));

let project: ReturnType<typeof createTmpProject>;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

test(
  'IX-3358: exact-ID replay reaches the first action step after runner bootstrap',
  { skip: publicationHelperSupported ? false : 'POSIX publication helper is unavailable' },
  async () => {
    const runnerCache = mkdtempSync(join(tmpdir(), 'ix-3358-runner-cache-'));
    const previousCache = process.env.QAREN_RUNNER_CACHE;
    process.env.QAREN_RUNNER_CACHE = runnerCache;
    try {
      const packedRoot = join(runnerCache, 'packed', 'maestro-runner');
      const packedRunner = join(packedRoot, 'bin', 'maestro-runner');
      mkdirSync(dirname(packedRunner), { recursive: true });
      writeFileSync(packedRunner, '#!/bin/sh\nexit 0\n');
      chmodSync(packedRunner, 0o755);
      const archive = join(runnerCache, 'maestro-runner.tar.gz');
      const packedTar = spawnSync('tar', [
        '-czf',
        archive,
        '-C',
        join(runnerCache, 'packed'),
        'maestro-runner',
      ]);
      assert.equal(packedTar.status, 0, String(packedTar.stderr));

      const pinRoot = join(runnerCache, 'maestro-runner', MAESTRO_RUNNER_PIN.version);
      const runnerPath = join(pinRoot, 'bin', 'maestro-runner');
      mkdirSync(dirname(runnerPath), { recursive: true });
      copyFileSync(packedRunner, runnerPath);
      chmodSync(runnerPath, 0o755);
      copyFileSync(archive, join(pinRoot, '.payload.tar.gz'));
      _setPinnedRunnerAttestationForTest({
        sha256: createHash('sha256').update(readFileSync(runnerPath)).digest('hex'),
        archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
      });
      const status = buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false, {
        selectedPath: runnerPath,
        provenance: 'pin-cache',
      });

      project.seedAction(
        'login-en',
        fixtureYaml({
          id: 'login-en',
          bundleId: 'com.rndevagent.testapp',
          status: 'active',
          selectors: ['home-welcome'],
        }),
        null,
      );
      let executions = 0;
      let snapshotRoot = '';
      let cacheRoot = '';
      const handler = createPinnedRunActionHandler({
        engineStatus: async () => status,
        maestroRun: async () =>
          withImmediatePinnedRunner(
            runnerPath,
            async () => status,
            async (boundPath) => {
              executions += 1;
              snapshotRoot = dirname(boundPath);
              cacheRoot = readlinkSync(join(snapshotRoot, 'cache'));
              mkdirSync(join(snapshotRoot, 'cache', 'wda-bootstrap'), { recursive: true });
              writeFileSync(join(snapshotRoot, 'cache', 'wda-bootstrap', 'ready'), 'ok');
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      ok: true,
                      data: {
                        passed: true,
                        platform: 'ios',
                        transport: 'maestro-runner',
                        transportVersion: MAESTRO_RUNNER_PIN.version,
                        output: '✓ launchApp (0.1s)\n✓ tapOn: home-welcome (0.2s)',
                        steps: [
                          { index: 0, name: 'launchApp', verb: 'launchApp', status: 'pass' },
                          {
                            index: 1,
                            name: 'tapOn: home-welcome',
                            verb: 'tapOn',
                            status: 'pass',
                          },
                        ],
                        deviceAuthority: {
                          requestedDeviceId: 'OWNED-DEVICE',
                          reportedDeviceId: 'OWNED-DEVICE',
                          observedDeviceIds: ['OWNED-DEVICE'],
                          wdaDeviceIds: ['OWNED-DEVICE'],
                          verified: true,
                          source: 'maestro-runner-report',
                          reason: 'exact-runner-and-wda-match',
                        },
                      },
                    }),
                  },
                ],
              };
            },
            'ios',
          ),
      });

      const result = await handler({
        actionId: 'login-en',
        projectRoot: project.root,
        platform: 'ios',
        autoRepair: false,
      });
      const envelope = JSON.parse(result.content[0].text);

      assert.equal(executions, 1);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data.passed, true);
      assert.match(envelope.data.firstAttemptOutput, /✓ launchApp/);
      assert.equal(project.readSidecar('login-en').runHistory.at(-1).status, 'pass');
      assert.equal(existsSync(snapshotRoot), false);
      assert.equal(existsSync(cacheRoot), false);
    } finally {
      _resetEngineStatusForTest();
      if (previousCache === undefined) delete process.env.QAREN_RUNNER_CACHE;
      else process.env.QAREN_RUNNER_CACHE = previousCache;
      rmSync(runnerCache, { recursive: true, force: true });
    }
  },
);
