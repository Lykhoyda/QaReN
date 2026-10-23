import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import {
  defaultArtifactDeps,
  resolveIosRunnerArtifacts,
} from '../../dist/runners/runner-artifacts.js';
import { loadWorkflow } from '../helpers/workflow-job-runner.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const VERSION = '2.0.0-beta.3';

test('the installed runtime supplies its full version despite a legacy host-plugin override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qaren-runtime-identity-'));
  const runtime = join(root, 'runtime');
  const legacy = join(root, 'legacy-plugin.json');
  try {
    mkdirSync(join(runtime, 'qa'), { recursive: true });
    writeFileSync(
      join(runtime, 'package.json'),
      JSON.stringify({ name: 'qaren-runtime', version: VERSION }),
    );
    writeFileSync(legacy, JSON.stringify({ version: '1.0.13' }));
    await build({
      entryPoints: [join(ROOT, 'packages/qaren-core/src/runners/protocol.ts')],
      outfile: join(runtime, 'qa', 'protocol.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
    });
    const observed = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {getPluginVersion} from './runtime/qa/protocol.mjs'; console.log(getPluginVersion());",
      ],
      { cwd: root, env: { ...process.env, QAREN_PLUGIN_MANIFEST: legacy }, encoding: 'utf8' },
    );
    assert.equal(observed.trim(), VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const platform of ['ios', 'android'] as const) {
  test(`the ${platform} producer records the full build identity inside the actual zip`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qaren runner identity '));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const ref = 'a'.repeat(40);
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' '${ref}'\n`);
      chmodSync(join(bin, 'git'), 0o755);
      for (const path of [
        'build/dd/Build/Products/RnFastRunner.xctestrun',
        'packages/rn-android-runner/app/build/outputs/apk/debug/app-debug.apk',
        'packages/rn-android-runner/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk',
      ]) {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), 'fixture product');
      }
      const workflow = loadWorkflow(join(ROOT, '.github/workflows/runner-artifacts.yml'));
      const step = workflow.jobs[`build-${platform}`].steps.find(
        (candidate) => candidate.id === 'zip',
      );
      assert.ok(step?.run);
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          VERSION,
          REF: ref,
          GITHUB_WORKSPACE: root,
          GITHUB_OUTPUT: join(root, 'producer-output'),
        },
      });
      const name =
        platform === 'ios'
          ? `rn-fast-runner-${VERSION}-sim.zip`
          : `rn-android-runner-${VERSION}.zip`;
      const zip = join(root, name);
      const deps = defaultArtifactDeps();
      assert.deepEqual(deps.readArchiveIdentity(zip), {
        schemaVersion: 1,
        version: VERSION,
        platform,
      });
      if (platform === 'ios') {
        const requests: string[] = [];
        deps.env = {};
        deps.cacheDir = () => join(root, 'cache');
        deps.readManifest = () => ({
          version: VERSION,
          assets: {
            ios: [{ name, sha256: deps.sha256File(zip), bytes: readFileSync(zip).length }],
            android: [],
          },
        });
        deps.fetchToFile = async (url, dest) => {
          requests.push(url);
          copyFileSync(zip, dest);
        };
        const downloaded = await resolveIosRunnerArtifacts(VERSION, join(root, 'local'), deps);
        assert.equal(downloaded.provenance, 'downloaded');
        const cached = await resolveIosRunnerArtifacts(VERSION, join(root, 'local'), deps);
        assert.equal(cached.provenance, 'cache');
        assert.deepEqual(requests, [
          `https://github.com/Lykhoyda/rn-dev-agent/releases/download/v${VERSION}/${name}`,
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
