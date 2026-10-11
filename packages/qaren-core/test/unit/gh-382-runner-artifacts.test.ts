import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, basename } from 'node:path';
import {
  resolveArtifactDecision,
  assertNoTraversal,
  verifyChecksums,
  releaseAssetUrl,
  cacheDirFor,
  formatArtifactSize,
  artifactProvenanceToState,
  resolveIosRunnerArtifacts,
  resolveAndroidRunnerArtifacts,
  RUNNER_REPO,
} from '../../dist/runners/runner-artifacts.js';

// --- Pure helpers ---

test('resolveArtifactDecision: env override forces build-local', () => {
  assert.equal(
    resolveArtifactDecision({ envOverride: true, hasManifestAssets: true, cacheValid: true }),
    'build-local',
  );
});

test('resolveArtifactDecision: no manifest assets -> build-local', () => {
  assert.equal(
    resolveArtifactDecision({ envOverride: false, hasManifestAssets: false, cacheValid: false }),
    'build-local',
  );
});

test('resolveArtifactDecision: valid cache -> cache', () => {
  assert.equal(
    resolveArtifactDecision({ envOverride: false, hasManifestAssets: true, cacheValid: true }),
    'cache',
  );
});

test('resolveArtifactDecision: manifest assets but no cache -> download', () => {
  assert.equal(
    resolveArtifactDecision({ envOverride: false, hasManifestAssets: true, cacheValid: false }),
    'download',
  );
});

test('assertNoTraversal: allows plain relative entries', () => {
  assert.doesNotThrow(() =>
    assertNoTraversal(['Build/Products/Foo.app', 'app-debug.apk', 'a/b/c.bin']),
  );
});

test('assertNoTraversal: rejects parent-dir escape', () => {
  assert.throws(() => assertNoTraversal(['../evil.sh']), /traversal|unsafe/i);
  assert.throws(() => assertNoTraversal(['a/../../b']), /traversal|unsafe/i);
});

test('assertNoTraversal: rejects absolute paths (posix + windows)', () => {
  assert.throws(() => assertNoTraversal(['/etc/passwd']), /traversal|unsafe/i);
  assert.throws(() => assertNoTraversal(['C:\\Windows\\x']), /traversal|unsafe/i);
  assert.throws(() => assertNoTraversal(['\\\\server\\share']), /traversal|unsafe/i);
});

test('verifyChecksums: ok when every expected asset matches', () => {
  const expected = [{ name: 'a.zip', sha256: 'AAA', bytes: 1 }];
  const r = verifyChecksums(expected, { 'a.zip': 'AAA' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.mismatched, []);
  assert.deepEqual(r.missing, []);
});

test('verifyChecksums: flags mismatch and missing', () => {
  const expected = [
    { name: 'a.zip', sha256: 'AAA', bytes: 1 },
    { name: 'b.zip', sha256: 'BBB', bytes: 1 },
  ];
  const r = verifyChecksums(expected, { 'a.zip': 'WRONG' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatched, ['a.zip']);
  assert.deepEqual(r.missing, ['b.zip']);
});

test('releaseAssetUrl: builds a v-prefixed release download URL', () => {
  assert.equal(
    releaseAssetUrl('Lykhoyda/rn-dev-agent', '0.62.3', 'rn-fast-runner-0.62.3-sim.zip'),
    'https://github.com/Lykhoyda/rn-dev-agent/releases/download/v0.62.3/rn-fast-runner-0.62.3-sim.zip',
  );
});

test('cacheDirFor: every platform caches runners under ~/.qaren/runtime', () => {
  assert.equal(
    cacheDirFor('/Users/x', 'darwin', '0.62.3', 'ios'),
    '/Users/x/.qaren/runtime/runners/0.62.3/ios',
  );
  assert.equal(
    cacheDirFor('/home/x', 'linux', '0.62.3', 'android'),
    '/home/x/.qaren/runtime/runners/0.62.3/android',
  );
});

test('formatArtifactSize: rounds to whole MB with a floor of 1', () => {
  assert.equal(formatArtifactSize(4_200_000), '~4 MB');
  assert.equal(formatArtifactSize(1), '~1 MB');
});

test('artifactProvenanceToState: cache/downloaded -> prebuilt, build-local -> local', () => {
  assert.equal(artifactProvenanceToState('cache'), 'prebuilt');
  assert.equal(artifactProvenanceToState('downloaded'), 'prebuilt');
  assert.equal(artifactProvenanceToState('build-local'), 'local');
});

test('RUNNER_REPO points at the plugin repo', () => {
  assert.equal(RUNNER_REPO, 'Lykhoyda/rn-dev-agent');
});

// --- Fake ArtifactDeps for orchestrator tests ---

function makeDeps(cfg = {}) {
  const files = new Set(cfg.files ?? []);
  const shas = new Map(Object.entries(cfg.shas ?? {}));
  const calls = { fetch: [], unzip: [], rm: [] };
  const cacheRoot = cfg.cacheRoot ?? '/cache';
  const deps = {
    env: cfg.env ?? {},
    readManifest: () => cfg.manifest ?? null,
    cacheDir: (version, platform) => join(cacheRoot, version, platform),
    existsSync: (p) => files.has(p) || [...files].some((f) => f.startsWith(p + '/')),
    sha256File: (p) => {
      if (!shas.has(p)) throw new Error('no sha registered for ' + p);
      return shas.get(p);
    },
    listFiles: (d) => [...files].filter((f) => dirname(f) === d).map((f) => basename(f)),
    fetchToFile: async (url, dest, opts) => {
      calls.fetch.push({ url, dest, opts });
      if (cfg.fetchImpl) return cfg.fetchImpl({ url, dest, opts, files, shas });
      files.add(dest);
      shas.set(dest, cfg.downloadSha ?? 'GOOD');
    },
    unzip: (zip, destDir) => {
      calls.unzip.push({ zip, destDir });
      if (cfg.unzipImpl) return cfg.unzipImpl({ zip, destDir, files, shas });
      for (const rel of cfg.extractProduces ?? []) files.add(join(destDir, rel));
    },
    mkdirp: (p) => files.add(join(p, '.dir')),
    rm: (p) => {
      calls.rm.push(p);
      for (const f of files) if (f === p || f.startsWith(p + '/')) files.delete(f);
    },
  };
  return { deps, files, shas, calls };
}

const IOS_MANIFEST = {
  version: '0.62.3',
  assets: {
    ios: [{ name: 'rn-fast-runner-0.62.3-sim.zip', sha256: 'GOOD', bytes: 4_200_000 }],
    android: [{ name: 'rn-android-runner-0.62.3.zip', sha256: 'GOOD', bytes: 5_100_000 }],
  },
};
// Paths are relative to the extraction (products) dir the fake unzip receives.
const IOS_EXTRACT = ['Build/Products/RnFastRunner.xctestrun'];
const LOCAL_DD = '/plugin/scripts/rn-fast-runner/build/DerivedData';
const LOCAL_APKS = {
  appApk: '/plugin/.../app-debug.apk',
  testApk: '/plugin/.../app-debug-androidTest.apk',
};

// --- iOS orchestrator ---

test('iOS: RN_RUNNER_BUILD=local -> build-local, uses local DD, no network', async () => {
  const { deps, calls } = makeDeps({ env: { RN_RUNNER_BUILD: 'local' }, manifest: IOS_MANIFEST });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'build-local');
  assert.equal(r.derivedDataPath, LOCAL_DD);
  assert.equal(calls.fetch.length, 0);
});

test('iOS: null version -> build-local', async () => {
  const { deps, calls } = makeDeps({ manifest: IOS_MANIFEST });
  const r = await resolveIosRunnerArtifacts(null, LOCAL_DD, deps);
  assert.equal(r.provenance, 'build-local');
  assert.equal(r.derivedDataPath, LOCAL_DD);
  assert.equal(calls.fetch.length, 0);
});

test('iOS: manifest version mismatch -> build-local', async () => {
  const { deps } = makeDeps({ manifest: { ...IOS_MANIFEST, version: '0.61.0' } });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'build-local');
});

test('iOS: no manifest at all -> build-local', async () => {
  const { deps } = makeDeps({ manifest: null });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'build-local');
});

test('iOS: valid cache -> cache, uses cached DD, no network', async () => {
  const cacheDir = join('/cache', '0.62.3', 'ios');
  const zip = join(cacheDir, 'rn-fast-runner-0.62.3-sim.zip');
  const { deps, calls } = makeDeps({
    manifest: IOS_MANIFEST,
    files: [zip, join(cacheDir, 'products/Build/Products/RnFastRunner.xctestrun')],
    shas: { [zip]: 'GOOD' },
  });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'cache');
  assert.equal(r.derivedDataPath, join(cacheDir, 'products'));
  assert.equal(calls.fetch.length, 0);
});

test('iOS: corrupt cache (wrong sha) -> falls to download', async () => {
  const cacheDir = join('/cache', '0.62.3', 'ios');
  const zip = join(cacheDir, 'rn-fast-runner-0.62.3-sim.zip');
  const { deps, calls } = makeDeps({
    manifest: IOS_MANIFEST,
    files: [zip, join(cacheDir, 'products/Build/Products/RnFastRunner.xctestrun')],
    shas: { [zip]: 'CORRUPT' },
    downloadSha: 'GOOD',
    extractProduces: IOS_EXTRACT,
  });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'downloaded');
  assert.equal(calls.fetch.length, 1);
});

test('iOS: download ok -> downloaded, cached DD, fetch+unzip called, size-cap passed', async () => {
  const { deps, calls } = makeDeps({
    manifest: IOS_MANIFEST,
    downloadSha: 'GOOD',
    extractProduces: IOS_EXTRACT,
  });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'downloaded');
  assert.equal(r.derivedDataPath, join('/cache', '0.62.3', 'ios', 'products'));
  assert.match(r.note ?? '', /~4 MB/);
  assert.equal(calls.fetch.length, 1);
  assert.equal(
    calls.fetch[0].url,
    'https://github.com/Lykhoyda/rn-dev-agent/releases/download/v0.62.3/rn-fast-runner-0.62.3-sim.zip',
  );
  assert.ok(calls.fetch[0].opts.maxBytes >= 4_200_000);
  assert.ok(calls.fetch[0].opts.timeoutMs > 0);
  assert.equal(calls.unzip.length, 1);
});

test('iOS: download 404/offline (fetch throws) -> build-local with note', async () => {
  const { deps, calls } = makeDeps({
    manifest: IOS_MANIFEST,
    fetchImpl: () => {
      throw new Error('HTTP 404');
    },
  });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'build-local');
  assert.equal(r.derivedDataPath, LOCAL_DD);
  assert.match(r.note ?? '', /404|unavailable|local/i);
  assert.equal(calls.unzip.length, 0);
});

test('iOS: bad checksum after download -> build-local, note mentions checksum', async () => {
  const { deps, calls } = makeDeps({
    manifest: IOS_MANIFEST,
    downloadSha: 'TAMPERED',
    extractProduces: IOS_EXTRACT,
  });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'build-local');
  assert.equal(r.derivedDataPath, LOCAL_DD);
  assert.match(r.note ?? '', /checksum|local/i);
  assert.equal(calls.unzip.length, 0);
});

test('iOS: corrupt/unsafe zip (unzip throws) -> build-local, partial cache cleaned', async () => {
  const { deps, calls } = makeDeps({
    manifest: IOS_MANIFEST,
    downloadSha: 'GOOD',
    unzipImpl: () => {
      throw new Error('path traversal detected');
    },
  });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'build-local');
  assert.match(r.note ?? '', /traversal|local/i);
  assert.ok(calls.rm.length >= 1);
});

test('iOS: unzip leaves no xctestrun -> build-local', async () => {
  const { deps } = makeDeps({
    manifest: IOS_MANIFEST,
    downloadSha: 'GOOD',
    extractProduces: [], // nothing usable extracted
  });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps);
  assert.equal(r.provenance, 'build-local');
});

// --- Android orchestrator ---

test('Android always uses the runner built from the shipped source, never a published one', () => {
  assert.deepEqual(resolveAndroidRunnerArtifacts(LOCAL_APKS), {
    provenance: 'build-local',
    ...LOCAL_APKS,
  });
});

// --- forceLocalBuild: recovery must bypass prebuilt (Codex P1: stale-artifact heal) ---

test('iOS: forceLocalBuild bypasses a valid cache -> build-local, no network', async () => {
  const cacheDir = join('/cache', '0.62.3', 'ios');
  const zip = join(cacheDir, 'rn-fast-runner-0.62.3-sim.zip');
  const { deps, calls } = makeDeps({
    manifest: IOS_MANIFEST,
    files: [zip, join(cacheDir, 'products/Build/Products/RnFastRunner.xctestrun')],
    shas: { [zip]: 'GOOD' },
  });
  const r = await resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps, true);
  assert.equal(r.provenance, 'build-local');
  assert.equal(r.derivedDataPath, LOCAL_DD);
  assert.equal(calls.fetch.length, 0);
});

test('the iOS artifact resolver stops ambient cancellation before mutation and after download', async () => {
  const { withCancellation, RunCancelledError } = await import('../../dist/domain/cancellation.js');
  {
    for (const phase of ['before', 'download'] as const) {
      const controller = new AbortController();
      const reason = new RunCancelledError();
      const { deps, calls, files } = makeDeps({
        manifest: IOS_MANIFEST,
        fetchImpl: async () => {
          controller.abort(reason);
          throw new Error('wrapped fetch failure');
        },
      });
      let mutations = 0;
      const mkdirp = deps.mkdirp;
      deps.mkdirp = (path) => {
        mutations++;
        mkdirp(path);
      };
      if (phase === 'before') controller.abort(reason);
      const pending = withCancellation(controller.signal, () =>
        resolveIosRunnerArtifacts('0.62.3', LOCAL_DD, deps),
      );
      await assert.rejects(pending, (error) => error === reason);
      assert.equal(mutations, phase === 'before' ? 0 : 1);
      assert.equal(calls.fetch.length, phase === 'before' ? 0 : 1);
      assert.deepEqual(calls.unzip, []);
      assert.equal(calls.rm.length, phase === 'before' ? 0 : 1);
      assert.ok(![...files].some((path) => path.includes('/products/')));
    }
  }
});
