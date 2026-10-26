import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAESTRO_RUNNER_PIN,
  buildReplayEngineStatus,
  isCompleteWdaBuild,
  persistentWdaStoreBuildsRoot,
  withImmediatePinnedRunner,
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
  _setPinnedRunnerAttestationForTest,
  _setWdaPlutilForTest,
  _setWdaToolchainFingerprintForTest,
} from '../../dist/domain/engine-pin.js';

const publicationHelperSupported =
  process.platform === 'darwin' ||
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'));

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native');
const fixtureBinary =
  process.platform === 'darwin'
    ? join(nativeDir, 'darwin-process-birth')
    : join(nativeDir, `linux-conditional-publication-${process.arch}`);

const WDA_KEY = 'sim-ios26.4-iphone';

function wdaTestHostExecutable(keyDir: string): string {
  return join(
    keyDir,
    'DerivedData',
    'Build',
    'Products',
    'Debug-iphonesimulator',
    'WebDriverAgentRunner-Runner.app',
    'WebDriverAgentRunner-Runner',
  );
}

function wdaTestHostApp(keyDir: string): string {
  return dirname(wdaTestHostExecutable(keyDir));
}

function wdaTestBundlePath(keyDir: string): string {
  return join(wdaTestHostApp(keyDir), 'PlugIns', 'WebDriverAgentRunner.xctest');
}

function wdaTestBundleExecutable(keyDir: string): string {
  return join(wdaTestBundlePath(keyDir), 'WebDriverAgentRunner');
}

function wdaXctestrunPath(keyDir: string): string {
  return join(
    keyDir,
    'DerivedData',
    'Build',
    'Products',
    'WebDriverAgentRunner_iphonesimulator26.5-arm64.xctestrun',
  );
}

function wdaXctestrun(port?: number): string {
  const environment =
    port === undefined ? '' : `\n\t\t\t<key>USE_PORT</key>\n\t\t\t<string>${port}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>WebDriverAgentRunner</key>
\t<dict>
\t\t<key>TestHostPath</key>
\t\t<string>__TESTROOT__/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app</string>
\t\t<key>TestBundlePath</key>
\t\t<string>__TESTHOST__/PlugIns/WebDriverAgentRunner.xctest</string>
\t\t<key>EnvironmentVariables</key>
\t\t<dict>${environment}
\t\t</dict>
\t</dict>
</dict>
</plist>
`;
}

function writeCompleteWdaBuild(keyDir: string, port?: number): void {
  const products = join(keyDir, 'DerivedData', 'Build', 'Products');
  const app = join(products, 'Debug-iphonesimulator', 'WebDriverAgentRunner-Runner.app');
  mkdirSync(app, { recursive: true });
  mkdirSync(wdaTestBundlePath(keyDir), { recursive: true });
  writeFileSync(wdaTestBundleExecutable(keyDir), 'binary');
  chmodSync(wdaTestBundleExecutable(keyDir), 0o755);
  writeFileSync(wdaXctestrunPath(keyDir), wdaXctestrun(port));
  const executable = wdaTestHostExecutable(keyDir);
  writeFileSync(executable, 'binary');
  chmodSync(executable, 0o755);
}

before(() => {
  if (process.platform === 'darwin') return;
  _setWdaPlutilForTest((args: ReadonlyArray<string>) => {
    const xctestrunPath = args.at(-1);
    if (!xctestrunPath) return { status: 1 };
    const source = readFileSync(xctestrunPath, 'utf8');
    if (args[1] === 'xml1') {
      try {
        JSON.parse(source);
        return { status: 0 };
      } catch {
        return { status: 1 };
      }
    }
    if (args[1] !== 'json' || source.includes('&#x110000;')) return { status: 1 };
    if (source.trimStart().startsWith('{')) {
      try {
        JSON.parse(source);
        return { status: 0, stdout: source };
      } catch {
        return { status: 1 };
      }
    }
    if (!source.includes('<plist') || !source.trimEnd().endsWith('</plist>')) {
      return { status: 1 };
    }
    if (!source.includes('<key>WebDriverAgentRunner</key>')) {
      return { status: 0, stdout: '{}' };
    }
    const port = /<key>USE_PORT<\/key>\s*<string>([^<]+)<\/string>/.exec(source)?.[1];
    return {
      status: 0,
      stdout: JSON.stringify({
        WebDriverAgentRunner: {
          TestHostPath: '__TESTROOT__/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app',
          TestBundlePath: '__TESTHOST__/PlugIns/WebDriverAgentRunner.xctest',
          EnvironmentVariables: port === undefined ? {} : { USE_PORT: port },
        },
      }),
    };
  });
});

after(() => {
  _setWdaPlutilForTest(undefined);
});

test('isCompleteWdaBuild requires runnable WDA host and bundle executables', () => {
  const root = mkdtempSync(join(tmpdir(), 'wda-complete-'));
  try {
    const keyDir = join(root, WDA_KEY);
    assert.equal(isCompleteWdaBuild(keyDir), false);
    writeCompleteWdaBuild(keyDir);
    assert.equal(isCompleteWdaBuild(keyDir), true);
    writeFileSync(wdaXctestrunPath(keyDir), '<plist version="1.0"><dict/></plist>');
    assert.equal(isCompleteWdaBuild(keyDir), false, 'an empty xctestrun is not reusable');
    writeFileSync(wdaXctestrunPath(keyDir), '<plist version="1.0"><dict>');
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a truncated xctestrun is not reusable');
    writeFileSync(
      wdaXctestrunPath(keyDir),
      wdaXctestrun().replace('</dict>', '<key>INVALID</key><string>&#x110000;</string></dict>'),
    );
    assert.equal(isCompleteWdaBuild(keyDir), false, 'an XML-invalid xctestrun is not reusable');
    writeFileSync(wdaXctestrunPath(keyDir), wdaXctestrun());
    assert.equal(isCompleteWdaBuild(keyDir), true);
    const testBundle = wdaTestBundlePath(keyDir);
    rmSync(testBundle, { recursive: true });
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a missing referenced product is incomplete');
    mkdirSync(testBundle, { recursive: true });
    assert.equal(isCompleteWdaBuild(keyDir), false, 'an empty test bundle is incomplete');
    rmSync(testBundle, { recursive: true });
    writeFileSync(testBundle, 'not a bundle');
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a regular file is not a test bundle');
    rmSync(testBundle);
    mkdirSync(testBundle);
    writeFileSync(wdaTestBundleExecutable(keyDir), 'binary');
    chmodSync(wdaTestBundleExecutable(keyDir), 0o644);
    assert.equal(
      isCompleteWdaBuild(keyDir),
      false,
      'a mode-stripped bundle runner is not runnable',
    );
    chmodSync(wdaTestBundleExecutable(keyDir), 0o755);
    assert.equal(isCompleteWdaBuild(keyDir), true);
    rmSync(wdaTestBundleExecutable(keyDir));
    mkdirSync(wdaTestBundleExecutable(keyDir));
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a directory is not a bundle runner');
    rmSync(wdaTestBundleExecutable(keyDir), { recursive: true });
    symlinkSync(
      relative(wdaTestBundlePath(keyDir), wdaTestHostExecutable(keyDir)),
      wdaTestBundleExecutable(keyDir),
    );
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a symlink is not a bundle runner');
    rmSync(wdaTestBundleExecutable(keyDir));
    writeFileSync(wdaTestBundleExecutable(keyDir), 'binary');
    chmodSync(wdaTestBundleExecutable(keyDir), 0o755);
    const linkedTestBundle = join(wdaTestHostApp(keyDir), 'LinkedWebDriverAgentRunner.xctest');
    renameSync(testBundle, linkedTestBundle);
    symlinkSync(relative(dirname(testBundle), linkedTestBundle), testBundle);
    assert.equal(isCompleteWdaBuild(keyDir), false, 'the test bundle must be a real directory');
    rmSync(testBundle);
    renameSync(linkedTestBundle, testBundle);
    assert.equal(isCompleteWdaBuild(keyDir), true);

    const frameworks = join(wdaTestHostApp(keyDir), 'Frameworks');
    mkdirSync(frameworks);
    const internalTarget = join(
      keyDir,
      'DerivedData',
      'Build',
      'Products',
      'InternalSupport',
      'payload',
    );
    mkdirSync(dirname(internalTarget), { recursive: true });
    writeFileSync(internalTarget, 'internal');
    const internalLink = join(frameworks, 'internal-link');
    symlinkSync(relative(frameworks, internalTarget), internalLink);
    assert.equal(isCompleteWdaBuild(keyDir), true, 'an internal relative symlink stays reusable');
    rmSync(internalLink);

    const absoluteEscape = join(frameworks, 'absolute-escape');
    symlinkSync('/usr/bin/true', absoluteEscape);
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a deep absolute symlink escapes the key');
    rmSync(absoluteEscape);
    const externalTarget = join(root, 'external-product');
    writeFileSync(externalTarget, 'external');
    const relativeEscape = join(frameworks, 'relative-escape');
    symlinkSync(relative(frameworks, externalTarget), relativeEscape);
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a deep relative symlink escapes the key');
    rmSync(relativeEscape);

    const app = wdaTestHostApp(keyDir);
    const externalApp = join(root, 'external-WDA.app');
    renameSync(app, externalApp);
    symlinkSync(externalApp, app);
    assert.equal(isCompleteWdaBuild(keyDir), false, 'the test-host app cannot escape the key');
    rmSync(app);
    renameSync(externalApp, app);
    assert.equal(isCompleteWdaBuild(keyDir), true);

    const executable = wdaTestHostExecutable(keyDir);
    chmodSync(executable, 0o644);
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a mode-stripped test host is not runnable');
    chmodSync(executable, 0o755);
    assert.equal(isCompleteWdaBuild(keyDir), true);
    rmSync(executable);
    assert.equal(isCompleteWdaBuild(keyDir), false);
    const unrelatedExecutable = join(dirname(dirname(executable)), 'Unrelated.app', 'Unrelated');
    mkdirSync(dirname(unrelatedExecutable), { recursive: true });
    writeFileSync(unrelatedExecutable, 'binary');
    chmodSync(unrelatedExecutable, 0o755);
    assert.equal(isCompleteWdaBuild(keyDir), false, 'an unrelated app is not the WDA test host');
    mkdirSync(executable);
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a directory is not an executable');
    rmSync(executable, { recursive: true });
    symlinkSync('/usr/bin/true', executable);
    assert.equal(isCompleteWdaBuild(keyDir), false, 'a symlink is not an executable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'a changed toolchain selects a different store slot on the very next probe',
  { skip: process.platform === 'win32' ? 'POSIX shell shim' : false },
  () => {
    const shim = mkdtempSync(join(tmpdir(), 'wda-xcb-shim-'));
    const cache = mkdtempSync(join(tmpdir(), 'wda-xcb-cache-'));
    const previousPath = process.env.PATH;
    const previousCache = process.env.QAREN_RUNNER_CACHE;
    _setWdaToolchainFingerprintForTest(undefined);
    try {
      process.env.QAREN_RUNNER_CACHE = cache;
      const fakeXcodebuild = join(shim, 'xcodebuild');
      writeFileSync(fakeXcodebuild, '#!/bin/sh\necho "Xcode 1.0"\necho "Build version AAA1"\n');
      chmodSync(fakeXcodebuild, 0o755);
      process.env.PATH = `${shim}:${previousPath ?? ''}`;
      const before = persistentWdaStoreBuildsRoot('darwin-arm64');
      assert.match(before ?? '', /xcode-1\.0-AAA1/);
      writeFileSync(fakeXcodebuild, '#!/bin/sh\necho "Xcode 2.0"\necho "Build version BBB2"\n');
      const after = persistentWdaStoreBuildsRoot('darwin-arm64');
      assert.match(after ?? '', /xcode-2\.0-BBB2/);
      assert.notEqual(before, after);
    } finally {
      process.env.PATH = previousPath;
      if (previousCache === undefined) delete process.env.QAREN_RUNNER_CACHE;
      else process.env.QAREN_RUNNER_CACHE = previousCache;
      _setWdaToolchainFingerprintForTest(undefined);
      rmSync(shim, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  },
);

test(
  'consecutive iOS spawns reuse the published WDA build and controls rebuild cold',
  { skip: publicationHelperSupported ? false : 'POSIX publication helper is unavailable' },
  async () => {
    const cache = mkdtempSync(join(tmpdir(), 'wda-store-reuse-'));
    const previousCache = process.env.QAREN_RUNNER_CACHE;
    process.env.QAREN_RUNNER_CACHE = cache;
    _setWdaToolchainFingerprintForTest('xcode-26.5-23F81a');
    try {
      const packed = join(cache, 'packed', 'maestro-runner');
      mkdirSync(join(packed, 'bin'), { recursive: true });
      copyFileSync(fixtureBinary, join(packed, 'bin', 'maestro-runner'));
      chmodSync(join(packed, 'bin', 'maestro-runner'), 0o755);
      const archive = join(cache, 'maestro-runner.tar.gz');
      const packedTar = spawnSync('tar', [
        '-czf',
        archive,
        '-C',
        join(cache, 'packed'),
        'maestro-runner',
      ]);
      assert.equal(packedTar.status, 0, String(packedTar.stderr));

      const pinRoot = join(cache, 'maestro-runner', MAESTRO_RUNNER_PIN.version);
      mkdirSync(join(pinRoot, 'bin'), { recursive: true });
      const runnerPath = join(pinRoot, 'bin', 'maestro-runner');
      copyFileSync(join(packed, 'bin', 'maestro-runner'), runnerPath);
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
      _setEngineStatusForTest(status);

      const runIos = (onCache: (cacheLink: string) => void): Promise<{ status: number | null }> =>
        withImmediatePinnedRunner(
          runnerPath,
          async () => status,
          async (boundPath) => {
            onCache(join(dirname(boundPath), 'cache'));
            return { status: 0 };
          },
          'ios',
        );

      const storeBuilds = persistentWdaStoreBuildsRoot();
      const arm64StoreBuilds = persistentWdaStoreBuildsRoot('darwin-arm64');
      const x64StoreBuilds = persistentWdaStoreBuildsRoot('darwin-x64');
      assert.ok(storeBuilds);
      assert.ok(arm64StoreBuilds);
      assert.ok(x64StoreBuilds);
      assert.notEqual(arm64StoreBuilds, x64StoreBuilds);
      assert.match(arm64StoreBuilds!, /darwin-arm64/);
      assert.match(x64StoreBuilds!, /darwin-x64/);
      assert.match(
        storeBuilds!,
        new RegExp(`\\.wda-store-${MAESTRO_RUNNER_PIN.version.replaceAll('.', '\\.')}`),
      );
      assert.match(storeBuilds!, /xcode-26\.5-23F81a/);

      // Cold run: cache starts unseeded, the "runner" builds, publish captures it.
      await runIos((cacheLink) => {
        assert.equal(existsSync(join(cacheLink, 'wda-builds')), false);
        const keyDir = join(cacheLink, 'wda-builds', WDA_KEY);
        writeCompleteWdaBuild(keyDir, 8447);
        mkdirSync(join(keyDir, 'logs'), { recursive: true });
        writeFileSync(join(keyDir, 'logs', 'runner.log'), 'device output');
        mkdirSync(join(keyDir, 'DerivedData', 'Logs', 'Test'), { recursive: true });
        writeFileSync(join(keyDir, 'DerivedData', 'Logs', 'Test', 'run.xcresult'), 'run output');
        writeFileSync(join(keyDir, 'session.json'), '{"device":"current"}');
      });
      const storeKey = join(storeBuilds!, WDA_KEY);
      assert.equal(isCompleteWdaBuild(storeKey), true);
      assert.notEqual(statSync(wdaTestHostExecutable(storeKey)).mode & 0o111, 0);
      assert.doesNotMatch(readFileSync(wdaXctestrunPath(storeKey), 'utf8'), /USE_PORT|8447/);
      assert.deepEqual(readdirSync(storeKey), ['DerivedData']);
      assert.equal(existsSync(join(storeKey, 'DerivedData', 'Logs')), false);

      // Warm run: the spawn cache is pre-seeded before the runner starts, and
      // the seeded xctestrun stays writable — the runner rewrites it to inject
      // the WDA port, and the snapshot seal walk must not have reached it. The
      // rewrite must land on the spawn copy only, never the store artifact.
      const xctestrunTail = [
        'DerivedData',
        'Build',
        'Products',
        'WebDriverAgentRunner_iphonesimulator26.5-arm64.xctestrun',
      ] as const;
      let warmSeeded = false;
      let warmSeedOmittedRunState = false;
      let warmSeedHasNoPriorPort = false;
      await runIos((cacheLink) => {
        const keyDir = join(cacheLink, 'wda-builds', WDA_KEY);
        warmSeeded = isCompleteWdaBuild(keyDir);
        warmSeedOmittedRunState =
          !existsSync(join(keyDir, 'logs')) && !existsSync(join(keyDir, 'DerivedData', 'Logs'));
        warmSeedHasNoPriorPort = !/USE_PORT|8447/.test(
          readFileSync(join(keyDir, ...xctestrunTail), 'utf8'),
        );
        writeFileSync(join(keyDir, ...xctestrunTail), wdaXctestrun(8558));
      });
      assert.equal(warmSeeded, true);
      assert.equal(warmSeedOmittedRunState, true);
      assert.equal(warmSeedHasNoPriorPort, true);
      assert.doesNotMatch(
        readFileSync(join(storeBuilds!, WDA_KEY, ...xctestrunTail), 'utf8'),
        /USE_PORT|8447|8558/,
      );

      // A toolchain change after seeding refuses publication under the new fingerprint.
      await runIos((cacheLink) => {
        assert.equal(isCompleteWdaBuild(join(cacheLink, 'wda-builds', WDA_KEY)), true);
        _setWdaToolchainFingerprintForTest('xcode-27.0-99Z99z');
      });
      const changedDuringSpawnStore = persistentWdaStoreBuildsRoot();
      assert.ok(changedDuringSpawnStore);
      assert.equal(existsSync(join(changedDuringSpawnStore!, WDA_KEY)), false);
      _setWdaToolchainFingerprintForTest('xcode-26.5-23F81a');

      // The per-spawn caches are still removed; only the store persists.
      const versionsRoot = join(cache, 'maestro-runner');
      const leftovers = readdirSync(versionsRoot).filter(
        (name) => name.startsWith('.wda-cache-') || name.startsWith('.spawn-'),
      );
      assert.deepEqual(leftovers, []);
      const storeEntries = readdirSync(storeBuilds!).filter((name) => name.startsWith('.stage-'));
      assert.deepEqual(storeEntries, []);

      // Control: an incompatible toolchain fingerprint does not consume the store.
      _setWdaToolchainFingerprintForTest('xcode-27.0-99Z99z');
      await runIos((cacheLink) => {
        assert.equal(existsSync(join(cacheLink, 'wda-builds', WDA_KEY)), false);
      });
      _setWdaToolchainFingerprintForTest('xcode-26.5-23F81a');

      // Control: an unknown toolchain refuses persistence entirely — no seed,
      // and the complete build is not published into any store location.
      _setWdaToolchainFingerprintForTest(null);
      const rootBefore = readdirSync(versionsRoot).sort();
      await runIos((cacheLink) => {
        assert.equal(existsSync(join(cacheLink, 'wda-builds')), false);
        writeCompleteWdaBuild(join(cacheLink, 'wda-builds', WDA_KEY));
      });
      assert.deepEqual(readdirSync(versionsRoot).sort(), rootBefore);
      _setWdaToolchainFingerprintForTest('xcode-26.5-23F81a');

      // A damaged bundle runner is replaced by the next complete cold build.
      chmodSync(wdaTestBundleExecutable(storeKey), 0o644);
      await runIos((cacheLink) => {
        assert.equal(existsSync(join(cacheLink, 'wda-builds', WDA_KEY)), false);
        writeCompleteWdaBuild(join(cacheLink, 'wda-builds', WDA_KEY));
      });
      assert.equal(isCompleteWdaBuild(join(storeBuilds!, WDA_KEY)), true);
      assert.notEqual(statSync(wdaTestBundleExecutable(storeKey)).mode & 0o111, 0);

      // Control: an unreadable store never masks the runner result — the run
      // still succeeds cold and best-effort persistence swallows the failure.
      if (process.getuid?.() !== 0) {
        const storeRoot = join(versionsRoot, `.wda-store-${MAESTRO_RUNNER_PIN.version}`);
        chmodSync(storeRoot, 0o000);
        try {
          await runIos((cacheLink) => {
            assert.equal(existsSync(join(cacheLink, 'wda-builds', WDA_KEY)), false);
            writeCompleteWdaBuild(join(cacheLink, 'wda-builds', WDA_KEY));
          });
        } finally {
          chmodSync(storeRoot, 0o700);
        }
      }

      // Control: a partial spawn build (no xctestrun) is never published.
      rmSync(join(storeBuilds!, WDA_KEY), { recursive: true, force: true });
      await runIos((cacheLink) => {
        const partial = join(cacheLink, 'wda-builds', WDA_KEY);
        writeCompleteWdaBuild(partial);
        rmSync(
          join(
            partial,
            'DerivedData',
            'Build',
            'Products',
            'WebDriverAgentRunner_iphonesimulator26.5-arm64.xctestrun',
          ),
        );
      });
      assert.equal(existsSync(join(storeBuilds!, WDA_KEY)), false);

      // Control (UID-independent): a store path occupied by a non-directory
      // trips the symlink/realness fence — no seed, no publish, result intact.
      const storePath = join(versionsRoot, `.wda-store-${MAESTRO_RUNNER_PIN.version}`);
      rmSync(storePath, { recursive: true, force: true });
      writeFileSync(storePath, 'occupied');
      const fenced = await runIos((cacheLink) => {
        assert.equal(existsSync(join(cacheLink, 'wda-builds')), false);
        writeCompleteWdaBuild(join(cacheLink, 'wda-builds', WDA_KEY));
      });
      assert.equal(fenced.status, 0);
      assert.equal(readFileSync(storePath, 'utf8'), 'occupied');
    } finally {
      _resetEngineStatusForTest();
      _setWdaToolchainFingerprintForTest(undefined);
      if (previousCache === undefined) delete process.env.QAREN_RUNNER_CACHE;
      else process.env.QAREN_RUNNER_CACHE = previousCache;
      rmSync(cache, { recursive: true, force: true });
    }
  },
);
