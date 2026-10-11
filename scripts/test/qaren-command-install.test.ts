import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..', '..');

test('installation exposes qaren on an unchanged user PATH and preserves foreign commands', () => {
  const dir = mkdtempSync(join(root, '.test-qaren-command-'));
  try {
    const home = join(dir, 'home');
    const userBin = join(dir, 'bin');
    const plugin = join(dir, 'plugin');
    const script = join(plugin, 'scripts', 'ensure-qaren.sh');
    mkdirSync(home, { recursive: true });
    mkdirSync(userBin, { recursive: true });
    mkdirSync(join(plugin, 'scripts'), { recursive: true });
    copyFileSync(join(root, 'packages/qaren-plugin/scripts/ensure-qaren.sh'), script);
    const version = '9.8.7';
    const name = `qaren-${version}-darwin-arm64.tar.gz`;
    const top = name.replace('.tar.gz', '');
    const bin = join(dir, top, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'qaren'), '#!/bin/sh\necho qaren 9.8.7\n');
    chmodSync(join(bin, 'qaren'), 0o755);
    const archive = join(dir, name);
    execFileSync('tar', ['--format', 'ustar', '-czf', archive, '-C', dir, top], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const bytes = readFileSync(archive);
    writeFileSync(join(plugin, 'runner-manifest.json'), JSON.stringify({
      version,
      assets: { qaren: { 'darwin-arm64': {
        name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      } } },
    }));
    const env = { ...process.env, HOME: home, PATH: `${userBin}:${process.env.PATH}` };
    const install = () => spawnSync('bash', [script, '--install', '--from-file', archive], {
      env, encoding: 'utf8',
    });
    let result = install();
    assert.equal(result.status, 0, result.stderr);
    const invoke = () => spawnSync('bash', ['-c', 'qaren --version'], { env, encoding: 'utf8' });
    const command = invoke();
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stdout, 'qaren 9.8.7\n');
    result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(invoke().stdout, 'qaren 9.8.7\n');

    const target = join(userBin, 'qaren');
    rmSync(target);
    symlinkSync(join(home, '.qaren/runtime/0.0.1/bin/qaren'), target);
    assert.equal(install().status, 0);
    assert.equal(invoke().stdout, 'qaren 9.8.7\n');

    rmSync(target);
    writeFileSync(target, '#!/bin/sh\necho operator-owned\n');
    chmodSync(target, 0o755);
    const original = readFileSync(target);
    assert.equal(install().status, 0);
    assert.deepEqual(readFileSync(target), original);
    assert.equal(invoke().stdout, 'operator-owned\n');

    rmSync(target);
    const foreignBin = join(dir, 'foreign-bin');
    mkdirSync(foreignBin);
    rmSync(userBin, { recursive: true });
    symlinkSync(foreignBin, userBin);
    assert.equal(install().status, 0);
    assert.equal(existsSync(join(foreignBin, 'qaren')), true);
    assert.equal(existsSync(join(home, '.local/bin/qaren')), false);
    assert.equal(install().status, 0);
    assert.equal(invoke().stdout, 'qaren 9.8.7\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
