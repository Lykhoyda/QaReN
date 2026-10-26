import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

type MatrixEntry = { language?: string; 'config-file'?: string };

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, string>;
};

function readYaml<T>(relativePath: string): T {
  return parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as T;
}

const GLOBSTAR_SLASH = '\u0001';
const GLOBSTAR = '\u0002';
const STAR = '\u0003';
const QUESTION = '\u0004';

function codeqlGlobToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, STAR)
    .replace(/\?/g, QUESTION)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll(GLOBSTAR_SLASH, '(?:.*/)?')
    .replaceAll(GLOBSTAR, '.*')
    .replaceAll(STAR, '[^/]*')
    .replaceAll(QUESTION, '[^/]');
  return new RegExp(`^${body}$`);
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

function analyzeJob(): {
  strategy: { matrix: { include: MatrixEntry[] } };
  steps: WorkflowStep[];
} {
  return readYaml<{
    jobs: {
      analyze: { strategy: { matrix: { include: MatrixEntry[] } }; steps: WorkflowStep[] };
    };
  }>('.github/workflows/codeql.yml').jobs.analyze;
}

function jsMatrixEntry(): MatrixEntry {
  const entry = analyzeJob().strategy.matrix.include.find(
    (candidate) => candidate.language === 'javascript-typescript',
  );
  assert.ok(entry, 'the CodeQL matrix must still analyze javascript-typescript');
  return entry;
}

function condition(step: WorkflowStep): string {
  return (step.if ?? '')
    .replace(/^\s*\$\{\{/, '')
    .replace(/\}\}\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

test('GH-783 CodeQL scope: the javascript-typescript leg loads an existing config file', () => {
  const configFile = jsMatrixEntry()['config-file'];
  assert.ok(configFile, 'the javascript-typescript matrix leg must declare a CodeQL config-file');
  assert.ok(
    existsSync(join(repoRoot, configFile)),
    `declared CodeQL config-file ${configFile} does not exist`,
  );
});

test('GH-783 CodeQL scope: generated bundles are excluded, hand-written sources are not', () => {
  const configFile = jsMatrixEntry()['config-file']!;
  const config = readYaml<{ 'paths-ignore'?: string[] }>(configFile);
  const ignored = (config['paths-ignore'] ?? []).map(codeqlGlobToRegExp);
  assert.ok(ignored.length > 0, 'the CodeQL config must declare paths-ignore entries');

  const isIgnored = (path: string) => ignored.some((matcher) => matcher.test(path));
  const analyzable = /\.(js|mjs|cjs|jsx|ts|tsx)$/;
  const scanned = trackedFiles().filter((path) => analyzable.test(path) && !isIgnored(path));

  const generated = scanned.filter((path) => path.includes('/dist/') || path.startsWith('.yarn/'));
  assert.deepEqual(generated, [], 'committed build output must stay out of the CodeQL database');

  for (const source of [
    'packages/qaren-core/src/handlers/device-session.ts',
    'packages/qaren-core/src/injected-helpers.ts',
  ]) {
    assert.ok(scanned.includes(source), `${source} must still be analyzed by CodeQL`);
  }
});

// Contract under test: the `analyze` job definition consumed by the GitHub
// Actions runner. A transient 5xx from the SARIF ingest API must not discard a
// completed analysis, so uploading is a separate step that is retried once.
test('GH-783 CodeQL upload: a failed SARIF upload is retried with the same results', () => {
  const steps = analyzeJob().steps;
  const analyze = steps.find((step) => step.uses?.includes('codeql-action/analyze'));
  assert.ok(analyze, 'the analyze job must still run codeql-action/analyze');

  const sarifPath = analyze.with?.output;
  assert.ok(sarifPath, 'codeql-action/analyze must write its SARIF to a declared output path');
  assert.equal(
    analyze.with?.upload,
    'never',
    'codeql-action/analyze must not own the upload, so the upload can be retried on its own',
  );

  const uploads = steps.filter((step) => step.uses?.includes('codeql-action/upload-sarif'));
  assert.equal(uploads.length, 2, 'the SARIF upload must have exactly one retry attempt');

  const [first, retry] = uploads;
  assert.equal(
    first['continue-on-error'],
    true,
    'the first upload attempt must not fail the job before the retry runs',
  );
  assert.ok(first.id, 'the first upload attempt needs an id so the retry can gate on its outcome');
  assert.equal(
    condition(retry),
    `steps.${first.id}.outcome == 'failure'`,
    'the retry must run only when the first upload attempt failed',
  );

  for (const upload of uploads) {
    assert.equal(
      upload.with?.sarif_file,
      sarifPath,
      'every upload attempt must send the SARIF that codeql-action/analyze produced',
    );
    assert.equal(
      upload.with?.category,
      analyze.with?.category,
      'every upload attempt must keep the analysis category so results replace, not duplicate',
    );
  }

  assert.notEqual(
    retry['continue-on-error'],
    true,
    'a failed retry must still fail the check — the upload is not optional',
  );
});
