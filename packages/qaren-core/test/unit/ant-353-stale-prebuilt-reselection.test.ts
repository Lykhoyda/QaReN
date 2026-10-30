import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRunnerForCommand } from '../../dist/agent-device-wrapper.js';
import {
  markPrebuiltRunnerStale,
  resolveIosRunnerArtifacts,
} from '../../dist/runners/runner-artifacts.js';
import {
  _setFastRunnerStateForTest,
  markStalePrebuiltRunner,
} from '../../dist/runners/qaren-ios-runner-client.js';
import { getPluginVersion } from '../../dist/runners/protocol.js';

const V = '2.0.0-beta.3';
const LOCAL_DD = '/runtime/qaren-ios-runner/build/DerivedData';
const LOCAL_XCTESTRUN = join(LOCAL_DD, 'Build/Products/QarenIosRunner.xctestrun');
const MISSING_FEATURES = {
  liveness: 'stale',
  staleReason: 'missing-features',
  missingFeatures: ['FILL_EVIDENCE_V1', 'HIT_TESTED_DISPATCH_V1'],
};

function prebuiltCache() {
  const cacheDir = join('/cache', V, 'ios');
  const zip = join(cacheDir, `qaren-ios-runner-${V}-sim.zip`);
  const files = new Set<string>([
    zip,
    join(cacheDir, 'products/Build/Products/QarenIosRunner.xctestrun'),
  ]);
  const calls = { fetch: 0 };
  const deps = {
    env: {},
    readManifest: () => ({
      version: V,
      assets: {
        ios: [{ name: `qaren-ios-runner-${V}-sim.zip`, sha256: 'GOOD', bytes: 1 }],
        android: [],
      },
    }),
    cacheDir: (v: string, p: string) => join('/cache', v, p),
    existsSync: (p: string) => files.has(p) || [...files].some((f) => f.startsWith(p + '/')),
    sha256File: () => 'GOOD',
    listFiles: (d: string) =>
      [...files].filter((f) => f.startsWith(d + '/')).map((f) => f.slice(d.length + 1)),
    fetchToFile: async () => {
      calls.fetch++;
    },
    unzip: () => {},
    mkdirp: (p: string) => void files.add(join(p, '.dir')),
    rm: () => {},
  };
  return { deps, files, calls };
}

function openDeps(
  cache: ReturnType<typeof prebuiltCache>,
  probes: object[],
  overrides: Record<string, unknown> = {},
) {
  const budget = new Set<string>();
  const selected: string[] = [];
  return {
    selected,
    deps: {
      adopt: () => {},
      reap: async () => {},
      acquireBuildLock: () => true,
      releaseBuildLock: () => {},
      invalidateArtifact: () => {},
      prebuilt: () => true,
      allowArtifactRebuild: true,
      pluginVersion: V,
      rebuildBudget: {
        alreadyRebuiltFor: (v: string) => budget.has(v),
        recordRebuild: (v: string) => void budget.add(v),
      },
      markPrebuiltStale: () => markPrebuiltRunnerStale(V, 'ios', cache.deps),
      probe: async () => probes.shift(),
      ensure: async (_d: string, _b: string, opts?: { forceLocalBuild?: boolean }) => {
        const r = await resolveIosRunnerArtifacts(V, LOCAL_DD, cache.deps, opts?.forceLocalBuild);
        selected.push(r.derivedDataPath);
        if (r.derivedDataPath === LOCAL_DD) cache.files.add(LOCAL_XCTESTRUN);
      },
      ...overrides,
    },
  };
}

test('ANT-353: after the one-per-version local rebuild, later checks select the local build, not the stale prebuilt', async () => {
  const cache = prebuiltCache();
  const first = openDeps(cache, [MISSING_FEATURES, { liveness: 'alive' }]);
  const res = await ensureRunnerForCommand('U1', 'com.example', first.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(first.selected, [LOCAL_DD]);

  const later = await resolveIosRunnerArtifacts(V, LOCAL_DD, cache.deps);
  assert.equal(later.provenance, 'build-local');
  assert.equal(later.derivedDataPath, LOCAL_DD);
  assert.equal(cache.calls.fetch, 0);
});

test('ANT-353: a spent rebuild budget still refuses RN_FAST_RUNNER_STALE but rejects the stale prebuilt', async () => {
  const cache = prebuiltCache();
  const { deps } = openDeps(cache, [MISSING_FEATURES], {
    rebuildBudget: { alreadyRebuiltFor: () => true, recordRebuild: () => {} },
  });
  const res = await ensureRunnerForCommand('U1', 'com.example', deps);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RN_FAST_RUNNER_STALE');

  const later = await resolveIosRunnerArtifacts(V, LOCAL_DD, cache.deps);
  assert.equal(later.derivedDataPath, LOCAL_DD);
});

test('ANT-353: an authority mismatch does not reject the prebuilt', async () => {
  const cache = prebuiltCache();
  let marked = 0;
  const { deps } = openDeps(
    cache,
    [
      { liveness: 'stale', staleReason: 'authority-mismatch' },
      { liveness: 'stale', staleReason: 'authority-mismatch' },
      { liveness: 'alive' },
    ],
    { markPrebuiltStale: () => marked++ },
  );
  await ensureRunnerForCommand('U1', 'com.example', deps);
  assert.equal(marked, 0);
});

test('ANT-353: only a stale runner launched from the prebuilt marks that prebuilt stale', () => {
  const home = mkdtempSync(join(tmpdir(), 'ant-353-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const version = getPluginVersion();
  assert.ok(version);
  const marker = join(home, '.qaren', 'runtime', 'runners', version, 'ios', 'stale');
  const state = {
    schemaVersion: 1,
    port: 1,
    pid: process.pid,
    deviceId: 'U1',
    bundleId: 'com.example',
    startedAt: '',
    protocolVersion: 1,
  } as const;
  try {
    _setFastRunnerStateForTest({ ...state, provenance: 'local' });
    markStalePrebuiltRunner();
    assert.equal(existsSync(marker), false);

    _setFastRunnerStateForTest({ ...state, provenance: 'prebuilt' });
    markStalePrebuiltRunner();
    assert.equal(existsSync(marker), true);
  } finally {
    _setFastRunnerStateForTest(null);
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});
