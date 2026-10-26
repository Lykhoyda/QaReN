import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const guard = resolve(import.meta.dirname, '..', 'check-document-ownership.ts');

function withRepository(run: (repository: string) => void): void {
  const repository = mkdtempSync(join(tmpdir(), 'document-ownership-'));
  try {
    run(repository);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

function check(repository: string) {
  return spawnSync(process.execPath, [guard], {
    env: { ...process.env, REPO_ROOT: repository },
    encoding: 'utf8',
  });
}

test('accepts product documentation in apps/docs-site', () => {
  withRepository((repository) => {
    const productDocs = join(repository, 'apps', 'docs-site', 'src', 'content', 'docs');
    mkdirSync(productDocs, { recursive: true });
    writeFileSync(join(productDocs, 'guide.md'), '# Guide\n');

    const result = check(repository);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /documentation ownership: ok/);
  });
});

test('rejects documents in the repository top-level docs tree', () => {
  withRepository((repository) => {
    const engineeringDocs = join(repository, 'docs', 'plans');
    mkdirSync(engineeringDocs, { recursive: true });
    writeFileSync(join(engineeringDocs, 'next-stage.md'), '# Plan\n');

    const result = check(repository);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/plans\/next-stage\.md/);
    assert.match(result.stderr, /sibling workspace repository docs\/ tree/);
  });
});

test('rejects every existing top-level docs entry type', () => {
  const entryCases: Array<[string, (repository: string) => void]> = [
    ['empty directory', (repository) => mkdirSync(join(repository, 'docs'))],
    ['file', (repository) => writeFileSync(join(repository, 'docs'), '# Docs\n')],
    [
      'live symlink',
      (repository) => {
        mkdirSync(join(repository, 'linked-docs'));
        symlinkSync('linked-docs', join(repository, 'docs'));
      },
    ],
    ['dangling symlink', (repository) => symlinkSync('missing-docs', join(repository, 'docs'))],
  ];

  for (const [entryType, createEntry] of entryCases) {
    withRepository((repository) => {
      createEntry(repository);

      const result = check(repository);

      assert.equal(result.status, 1, `${entryType}: ${result.stderr}`);
      assert.match(result.stderr, /Top-level docs\/ is not an owned documentation surface/);
      assert.match(result.stderr, /\sdocs\s/);
    });
  }
});
