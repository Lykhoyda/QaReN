// GH #111: regression tests for the atomic-writer unique-tmp-suffix
// hardening. The fix replaces fixed `.tmp` suffixes with unique
// `.tmp.<pid>.<base36-time>.<base36-rand>` stamps so two concurrent
// pairWrite calls against the same action don't unlink each other's
// in-flight tmp files. cleanupOrphans now scans the dir for matching
// prefixes and only deletes files older than ORPHAN_MAX_AGE_MS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MOD_PATH = '../../dist/domain/atomic-writer.js';

function makeFreshDir() {
  return mkdtempSync(join(tmpdir(), 'gh111-'));
}

function makeSidecarState() {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: new Date().toISOString(),
    lastSeenMtimeMs: 0,
    runHistory: [],
    repairHistory: [],
    stats: {},
  };
}

test('pairWrite uses unique tmp suffixes — two back-to-back calls have different stamps', async () => {
  const { atomicWriter } = await import(MOD_PATH);
  const dir = makeFreshDir();
  try {
    // Capture every _writeFile path the writer used
    const observed = [];
    const realWrite = atomicWriter._writeFile.bind(atomicWriter);
    atomicWriter._writeFile = (path, content) => {
      observed.push(path);
      return realWrite(path, content);
    };
    try {
      const yamlA = join(dir, 'alpha.yaml');
      const sidecarA = join(dir, 'state', 'alpha.state.json');
      atomicWriter.pairWrite(yamlA, 'body: a\n', sidecarA, makeSidecarState());

      const yamlB = join(dir, 'beta.yaml');
      const sidecarB = join(dir, 'state', 'beta.state.json');
      atomicWriter.pairWrite(yamlB, 'body: b\n', sidecarB, makeSidecarState());

      const yamlTmps = observed.filter((p) => /\.yaml\.tmp\./.test(p));
      // Two pairWrites × 1 YAML tmp each = 2 distinct paths
      assert.equal(
        yamlTmps.length,
        2,
        `expected 2 yaml tmp writes; got ${yamlTmps.length}: ${JSON.stringify(yamlTmps)}`,
      );
      assert.notEqual(yamlTmps[0], yamlTmps[1], 'two pairWrites must use distinct tmp stamps');
      // Each tmp path should match the .yaml.tmp.<stamp> shape
      for (const p of yamlTmps) {
        assert.match(
          p,
          /\.yaml\.tmp\.\d+\.[a-z0-9]+\.[a-z0-9]+$/,
          `tmp path shape unexpected: ${p}`,
        );
      }
    } finally {
      atomicWriter._writeFile = realWrite;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupOrphans deletes stale (>5min) orphans matching prefix', async () => {
  const { atomicWriter, ORPHAN_MAX_AGE_MS } = await import(MOD_PATH);
  const dir = makeFreshDir();
  try {
    const yamlPath = join(dir, 'target.yaml');
    // Plant a stale orphan with backdated mtime
    const staleOrphan = `${yamlPath}.tmp.99999.aged.deadbe`;
    writeFileSync(staleOrphan, 'stale content');
    const staleMtime = (Date.now() - ORPHAN_MAX_AGE_MS - 60_000) / 1000; // 6 minutes ago
    utimesSync(staleOrphan, staleMtime, staleMtime);
    assert.ok(existsSync(staleOrphan));

    // Trigger cleanup by calling pairWrite (cleanupOrphans runs first)
    const sidecarPath = join(dir, 'state', 'target.state.json');
    atomicWriter.pairWrite(yamlPath, 'body: real\n', sidecarPath, makeSidecarState());

    assert.ok(!existsSync(staleOrphan), 'stale orphan should be cleaned up');
    // Final files exist
    assert.ok(existsSync(yamlPath));
    assert.ok(existsSync(sidecarPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupOrphans does NOT delete fresh orphans (< 5min) — concurrent writer protection', async () => {
  const { atomicWriter } = await import(MOD_PATH);
  const dir = makeFreshDir();
  try {
    const yamlPath = join(dir, 'target.yaml');
    // Plant a fresh orphan simulating a concurrent writer's in-flight tmp
    const freshOrphan = `${yamlPath}.tmp.55555.fresh.cafe01`;
    writeFileSync(freshOrphan, 'concurrent-writer-content');

    // Run a second pairWrite on the same target — must NOT touch freshOrphan
    const sidecarPath = join(dir, 'state', 'target.state.json');
    atomicWriter.pairWrite(yamlPath, 'body: B\n', sidecarPath, makeSidecarState());

    assert.ok(existsSync(freshOrphan), 'fresh concurrent-writer orphan must be preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupOrphans does NOT delete non-matching .tmp files in the same dir', async () => {
  const { atomicWriter, ORPHAN_MAX_AGE_MS } = await import(MOD_PATH);
  const dir = makeFreshDir();
  try {
    const yamlPath = join(dir, 'target.yaml');
    // Plant a stale .tmp file for a DIFFERENT action — must NOT be touched
    const unrelated = join(dir, 'other.yaml.tmp.11111.aged.beef02');
    writeFileSync(unrelated, 'unrelated content');
    const staleMtime = (Date.now() - ORPHAN_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(unrelated, staleMtime, staleMtime);

    const sidecarPath = join(dir, 'state', 'target.state.json');
    atomicWriter.pairWrite(yamlPath, 'body: x\n', sidecarPath, makeSidecarState());

    assert.ok(existsSync(unrelated), 'non-matching prefix must be preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupOrphans tolerates missing target directory (no throw)', async () => {
  const { atomicWriter } = await import(MOD_PATH);
  const dir = makeFreshDir();
  try {
    // Target is in a deeply nested dir that doesn't exist yet — pairWrite
    // must create it via ensureDir and not bail at cleanupOrphans.
    const yamlPath = join(dir, 'deeper', 'nested', 'target.yaml');
    const sidecarPath = join(dir, 'deeper', 'state', 'target.state.json');
    atomicWriter.pairWrite(yamlPath, 'body: nested\n', sidecarPath, makeSidecarState());
    assert.ok(existsSync(yamlPath));
    assert.ok(existsSync(sidecarPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ORPHAN_MAX_AGE_MS is exported and is 5 minutes', async () => {
  const { ORPHAN_MAX_AGE_MS } = await import(MOD_PATH);
  assert.equal(ORPHAN_MAX_AGE_MS, 5 * 60 * 1000);
});

test('pairWrite is idempotent under repeated calls without orphan accumulation', async () => {
  // Each pairWrite produces a fresh stamp, so the dir doesn't accumulate
  // stamps across normal (non-crashed) runs — each pairWrite's tmp gets
  // renamed away cleanly. After 5 calls, the dir contains exactly the
  // YAML + sidecar (no orphans).
  const { atomicWriter } = await import(MOD_PATH);
  const dir = makeFreshDir();
  try {
    const yamlPath = join(dir, 'iter.yaml');
    const sidecarPath = join(dir, 'state', 'iter.state.json');
    for (let i = 0; i < 5; i++) {
      atomicWriter.pairWrite(yamlPath, `body: iter${i}\n`, sidecarPath, makeSidecarState());
    }
    // YAML dir contains only `iter.yaml`
    const yamlEntries = readdirSync(dir).filter((e) => e.startsWith('iter.'));
    assert.deepEqual(yamlEntries.sort(), ['iter.yaml']);
    // Sidecar dir contains only `iter.state.json`
    const sidecarEntries = readdirSync(join(dir, 'state')).filter((e) => e.startsWith('iter.'));
    assert.deepEqual(sidecarEntries.sort(), ['iter.state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
