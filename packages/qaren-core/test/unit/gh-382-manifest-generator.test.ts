import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashAsset, assembleManifest } from '../../../../scripts/build-runner-manifest.mts';

function withTempFile(name, content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gh382-manifest-'));
  try {
    const p = join(dir, name);
    writeFileSync(p, content);
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hashAsset: name/bytes/sha256 reflect the file on disk', () => {
  const content = Buffer.from('rn-fast-runner prebuilt payload\n');
  withTempFile('rn-fast-runner-0.62.3-sim.zip', content, (p) => {
    const asset = hashAsset(p);
    assert.equal(asset.name, 'rn-fast-runner-0.62.3-sim.zip');
    assert.equal(asset.bytes, content.byteLength);
    assert.equal(asset.sha256, createHash('sha256').update(content).digest('hex'));
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  });
});

test('assembleManifest: version + per-platform assets + optional xcodeBuildVersion', () => {
  const content = Buffer.from('payload');
  withTempFile('rn-android-runner-0.62.3.zip', content, (androidZip) => {
    const manifest = assembleManifest({
      version: '0.62.3',
      xcodeBuildVersion: '15.4',
      androidZip,
    });
    assert.equal(manifest.version, '0.62.3');
    assert.equal(manifest.xcodeBuildVersion, '15.4');
    assert.deepEqual(manifest.assets.ios, []);
    assert.equal(manifest.assets.android.length, 1);
    assert.equal(manifest.assets.android[0].name, 'rn-android-runner-0.62.3.zip');
    assert.equal(
      manifest.assets.android[0].sha256,
      createHash('sha256').update(content).digest('hex'),
    );
  });
});

test('assembleManifest: omits xcodeBuildVersion when not provided', () => {
  const manifest = assembleManifest({ version: '0.62.3' });
  assert.equal('xcodeBuildVersion' in manifest, false);
  assert.deepEqual(manifest.assets, { ios: [], android: [] });
});

test('assembleManifest: qaren tarballs are keyed by macOS platform and omitted when absent', () => {
  const content = Buffer.from('tarball');
  withTempFile('qaren-0.62.3-darwin-arm64.tar.gz', content, (arm64) => {
    const manifest = assembleManifest({
      version: '0.62.3',
      qarenTarballs: { 'darwin-arm64': arm64 },
    });
    assert.deepEqual(Object.keys(manifest.assets.qaren), ['darwin-arm64']);
    assert.equal(manifest.assets.qaren['darwin-arm64'].name, 'qaren-0.62.3-darwin-arm64.tar.gz');
    assert.equal(manifest.assets.qaren['darwin-arm64'].bytes, content.byteLength);
  });
  assert.equal('qaren' in assembleManifest({ version: '0.62.3' }).assets, false);
});
