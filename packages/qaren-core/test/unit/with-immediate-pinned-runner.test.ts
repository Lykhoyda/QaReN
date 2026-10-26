import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAESTRO_RUNNER_PIN,
  RunnerCacheUnavailableError,
  assertRunnerSnapshotCacheBinding,
  buildReplayEngineStatus,
  withImmediatePinnedRunner,
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
  _setPinnedRunnerAttestationForTest,
} from '../../dist/domain/engine-pin.js';

const publicationHelperSupported =
  process.platform === 'darwin' ||
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'));

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native');
const fixtureBinary =
  process.platform === 'darwin'
    ? join(nativeDir, 'darwin-process-birth')
    : join(nativeDir, `linux-conditional-publication-${process.arch}`);

test(
  'withImmediatePinnedRunner starts the copied publication helper after hardening',
  { skip: publicationHelperSupported ? false : 'POSIX publication helper is unavailable' },
  async () => {
    const cache = mkdtempSync(join(tmpdir(), 'mr-runner-exec-'));
    const previousCache = process.env.QAREN_RUNNER_CACHE;
    process.env.QAREN_RUNNER_CACHE = relative(process.cwd(), cache);
    try {
      const packed = join(cache, 'packed', 'maestro-runner');
      mkdirSync(join(packed, 'bin'), { recursive: true });
      const renameFrom = join(cache, 'rename-from');
      const renameTo = join(cache, 'rename-to');
      mkdirSync(renameFrom);
      // Copy the committed native helper, not a shebang or /bin/sh: Linux
      // execveat(CLOEXEC) cannot reopen a script, and Darwin kills copied arm64e
      // system binaries. Production maestro-runner is a native binary.
      copyFileSync(fixtureBinary, join(packed, 'bin', 'maestro-runner'));
      chmodSync(join(packed, 'bin', 'maestro-runner'), 0o755);
      mkdirSync(join(packed, 'Scripts'));
      writeFileSync(join(packed, 'Scripts', 'embed.sh'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(packed, 'Scripts', 'embed.sh'), 0o755);
      writeFileSync(join(packed, 'plain.txt'), 'data');
      chmodSync(join(packed, 'plain.txt'), 0o644);
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
      mkdirSync(join(pinRoot, 'Scripts'));
      copyFileSync(join(packed, 'Scripts', 'embed.sh'), join(pinRoot, 'Scripts', 'embed.sh'));
      chmodSync(join(pinRoot, 'Scripts', 'embed.sh'), 0o755);
      copyFileSync(join(packed, 'plain.txt'), join(pinRoot, 'plain.txt'));
      chmodSync(join(pinRoot, 'plain.txt'), 0o644);
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

      let successfulSnapshot = '';
      let successfulCache = '';

      const launched = await withImmediatePinnedRunner(
        runnerPath,
        async () => status,
        async (boundPath, prefixArgs = []) => {
          assert.equal(boundPath.endsWith('.runner-exec'), true);
          successfulSnapshot = dirname(boundPath);
          const cacheLink = join(successfulSnapshot, 'cache');
          successfulCache = readlinkSync(cacheLink);
          assertRunnerSnapshotCacheBinding(successfulSnapshot, successfulCache);
          assert.equal(statSync(successfulCache).mode & 0o777, 0o700);
          assert.equal(statSync(successfulSnapshot).mode & 0o777, 0o500);
          assert.equal(
            statSync(join(successfulSnapshot, 'bin', 'maestro-runner')).mode & 0o777,
            0o500,
          );
          assert.equal(statSync(join(successfulSnapshot, '.payload.tar.gz')).mode & 0o777, 0o400);
          const sealedScript = join(successfulSnapshot, 'Scripts', 'embed.sh');
          assert.equal(statSync(sealedScript).mode & 0o777, 0o500);
          assert.equal(statSync(join(successfulSnapshot, 'plain.txt')).mode & 0o777, 0o400);
          assert.equal(spawnSync(sealedScript).status, 0);
          assert.equal(
            createHash('sha256')
              .update(readFileSync(join(successfulSnapshot, 'bin', 'maestro-runner')))
              .digest('hex'),
            createHash('sha256').update(readFileSync(runnerPath)).digest('hex'),
          );
          if (process.getuid?.() !== 0) {
            assert.throws(
              () => writeFileSync(join(successfulSnapshot, '.payload.tar.gz'), 'mutation'),
              /EACCES|EPERM/,
            );
            assert.throws(() => writeFileSync(sealedScript, 'mutation'), /EACCES|EPERM/);
          }
          mkdirSync(join(cacheLink, 'wda-build'));
          writeFileSync(join(cacheLink, 'wda-build', 'ready'), 'ok');
          return spawnSync(
            boundPath,
            [...prefixArgs, '--rename-no-replace', renameFrom, renameTo],
            { encoding: 'utf8' },
          );
        },
        'ios',
      );

      assert.equal(launched.error, undefined, launched.error?.stack ?? launched.error?.message);
      assert.notEqual(launched.error?.code, 'EACCES');
      assert.equal(launched.status, 0, `${launched.stdout}${launched.stderr}`);
      assert.equal(existsSync(renameTo), true);
      assert.equal(existsSync(renameFrom), false);
      assert.equal(existsSync(successfulSnapshot), false);
      assert.equal(existsSync(successfulCache), false);

      const androidRenameFrom = join(cache, 'android-rename-from');
      const androidRenameTo = join(cache, 'android-rename-to');
      mkdirSync(androidRenameFrom);
      let androidSnapshot = '';
      let androidCacheHookCalled = false;
      const androidExecution = await withImmediatePinnedRunner(
        runnerPath,
        async () => status,
        async (boundPath, prefixArgs = []) => {
          androidSnapshot = dirname(boundPath);
          assert.equal(existsSync(join(androidSnapshot, 'cache')), false);
          return spawnSync(
            boundPath,
            [...prefixArgs, '--rename-no-replace', androidRenameFrom, androidRenameTo],
            { encoding: 'utf8' },
          );
        },
        'android',
        {
          beforeCacheProvision: () => {
            androidCacheHookCalled = true;
          },
        },
      );
      assert.equal(
        androidExecution.error,
        undefined,
        androidExecution.error?.stack ?? androidExecution.error?.message,
      );
      assert.equal(
        androidExecution.status,
        0,
        `${androidExecution.stdout}${androidExecution.stderr}`,
      );
      assert.equal(androidCacheHookCalled, false);
      assert.equal(existsSync(androidRenameTo), true);
      assert.equal(existsSync(androidRenameFrom), false);
      assert.equal(existsSync(androidSnapshot), false);

      let failedSnapshot = '';
      let failedCache = '';
      const failedExecution = await withImmediatePinnedRunner(
        runnerPath,
        async () => status,
        async (boundPath) => {
          failedSnapshot = dirname(boundPath);
          failedCache = readlinkSync(join(failedSnapshot, 'cache'));
          return { status: 1 };
        },
        'ios',
      );
      assert.equal(failedExecution.status, 1);
      assert.equal(existsSync(failedSnapshot), false);
      assert.equal(existsSync(failedCache), false);

      let thrownSnapshot = '';
      let thrownCache = '';
      await assert.rejects(
        withImmediatePinnedRunner(
          runnerPath,
          async () => status,
          async (boundPath) => {
            thrownSnapshot = dirname(boundPath);
            thrownCache = readlinkSync(join(thrownSnapshot, 'cache'));
            throw new Error('execute failed');
          },
          'ios',
        ),
        /execute failed/,
      );
      assert.equal(existsSync(thrownSnapshot), false);
      assert.equal(existsSync(thrownCache), false);

      let executeCalled = false;
      let refusedCache = '';
      await assert.rejects(
        withImmediatePinnedRunner(
          runnerPath,
          async () => status,
          async () => {
            executeCalled = true;
          },
          'ios',
          {
            beforeCacheProvision: (expectedCacheRoot) => {
              refusedCache = expectedCacheRoot;
              mkdirSync(expectedCacheRoot, { mode: 0o700 });
            },
          },
        ),
        (error: unknown) =>
          error instanceof RunnerCacheUnavailableError &&
          error.code === 'RUNNER_CACHE_UNAVAILABLE' &&
          error.relativePath === 'cache' &&
          error.errno === 'EEXIST',
      );
      assert.equal(executeCalled, false);
      assert.equal(existsSync(refusedCache), true);

      let partialCache = '';
      await assert.rejects(
        withImmediatePinnedRunner(
          runnerPath,
          async () => status,
          async () => {
            executeCalled = true;
          },
          'ios',
          {
            beforeCacheBinding: (ownedCacheRoot) => {
              partialCache = ownedCacheRoot;
              const cachePrefix = `.wda-cache-${MAESTRO_RUNNER_PIN.version}-`;
              const suffix = basename(ownedCacheRoot).slice(cachePrefix.length);
              const snapshotRoot = join(
                dirname(ownedCacheRoot),
                `.spawn-${MAESTRO_RUNNER_PIN.version}-${suffix}`,
              );
              writeFileSync(join(snapshotRoot, 'cache'), 'occupied');
            },
          },
        ),
        (error: unknown) =>
          error instanceof RunnerCacheUnavailableError && error.errno === 'EEXIST',
      );
      assert.equal(existsSync(partialCache), false);

      const versionsRoot = join(cache, 'maestro-runner');
      const foreignSnapshot = join(versionsRoot, `.spawn-${MAESTRO_RUNNER_PIN.version}-foreign`);
      const expectedCache = join(versionsRoot, `.wda-cache-${MAESTRO_RUNNER_PIN.version}-foreign`);
      const foreignCache = join(cache, 'foreign-cache');
      mkdirSync(foreignSnapshot);
      mkdirSync(expectedCache, { mode: 0o700 });
      mkdirSync(foreignCache, { mode: 0o700 });
      symlinkSync(foreignCache, join(foreignSnapshot, 'cache'), 'dir');
      assert.throws(
        () => assertRunnerSnapshotCacheBinding(foreignSnapshot, expectedCache),
        (error: unknown) =>
          error instanceof RunnerCacheUnavailableError && error.errno === 'FOREIGN_PATH',
      );
    } finally {
      _resetEngineStatusForTest();
      if (previousCache === undefined) delete process.env.QAREN_RUNNER_CACHE;
      else process.env.QAREN_RUNNER_CACHE = previousCache;
      rmSync(cache, { recursive: true, force: true });
    }
  },
);

test(
  'the sealed pre-fix snapshot shape cannot create the WDA cache',
  { skip: process.getuid?.() === 0 ? 'root bypasses mode-bit write restrictions' : false },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'mr-runner-prefixed-cache-'));
    try {
      chmodSync(root, 0o500);
      assert.throws(() => mkdirSync(join(root, 'cache')), /EACCES|EPERM/);
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
