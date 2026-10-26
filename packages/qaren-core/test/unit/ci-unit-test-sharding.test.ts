import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');

type WorkflowJob = {
  name?: string;
  needs?: string[];
  if?: string;
  strategy?: {
    'fail-fast'?: boolean;
    matrix?: { batch?: number[]; node?: string[] };
  };
  steps?: Array<{
    name?: string;
    env?: Record<string, string | number>;
    run?: string;
    uses?: string;
    with?: Record<string, string | number>;
  }>;
};

type WorkflowCommand = {
  executable: string;
  arguments: string[];
};

const workflowRoot = join(repositoryRoot, '.github', 'workflows');
const nodeExecutables = new Set(['node', 'corepack', 'npm', 'npx', 'yarn']);
const nodeExecutingScripts = new Set(['scripts/sync-versions.sh', './scripts/sync-versions.sh']);
const shellKeywords = new Set(['!', 'do', 'elif', 'else', 'if', 'then', 'until', 'while']);

function loadWorkflowJobs(fileName: string): Record<string, WorkflowJob> {
  const workflow = parse(readFileSync(join(workflowRoot, fileName), 'utf8')) as {
    jobs?: Record<string, WorkflowJob>;
  };

  assert.ok(workflow.jobs);
  return workflow.jobs;
}

function loadCiJobs(): Record<string, WorkflowJob> {
  return loadWorkflowJobs('ci.yml');
}

function loadCoverageScript(): string {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, 'packages', 'qaren-core', 'package.json'), 'utf8'),
  ) as { scripts?: { 'test:coverage'?: string } };

  assert.ok(packageJson.scripts?.['test:coverage']);
  return packageJson.scripts['test:coverage'];
}

function withShardFixtures(run: (files: string[]) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'unit-test-sharding-'));
  try {
    const files = Array.from({ length: 13 }, (_, index) => {
      const id = String(index + 1).padStart(2, '0');
      const file = join(directory, `fixture-${id}.test.js`);
      writeFileSync(
        file,
        `const test = require('node:test');\nconsole.log('SHARD_FIXTURE:${id}');\ntest('fixture ${id}', () => {});\n`,
      );
      return file;
    });
    run(files);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runAllShards(files: string[]): string[][] {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;

  return Array.from({ length: 5 }, (_, index) => {
    const result = spawnSync(
      process.execPath,
      ['--test', `--test-shard=${index + 1}/5`, ...files],
      { encoding: 'utf8', env: environment },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const selected = [...result.stdout.matchAll(/SHARD_FIXTURE:(\d+)/g)].map((match) => match[1]!);
    assert.notEqual(selected.length, 0, result.stdout);
    return selected;
  });
}

function executeBatchStep(run: string, batch: number): { args: string; stdout: string } {
  const repository = mkdtempSync(join(tmpdir(), 'unit-test-batch-step-'));
  try {
    const tests = join(repository, 'packages', 'qaren-core', 'test', 'unit');
    const bin = join(repository, 'bin');
    const argsFile = join(repository, 'corepack-args');
    mkdirSync(tests, { recursive: true });
    mkdirSync(bin);
    for (let index = 1; index <= 13; index += 1) {
      writeFileSync(join(tests, `fixture-${index}.test.ts`), '');
    }
    writeFileSync(
      join(bin, 'corepack'),
      '#!/usr/bin/env sh\nprintf \'%s\\n\' "$*" > "$COREPACK_ARGS"\n',
    );
    chmodSync(join(bin, 'corepack'), 0o755);

    const result = spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', run], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COREPACK_ARGS: argsFile,
        UNIT_TEST_BATCH: String(batch),
        UNIT_TEST_BATCHES: '5',
        UNIT_TEST_SHARD: `${batch}/5`,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    return { args: readFileSync(argsFile, 'utf8').trim(), stdout: result.stdout.trim() };
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

function captureCoverageArguments(shard?: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'unit-test-coverage-script-'));
  try {
    const bin = join(directory, 'bin');
    const argsFile = join(directory, 'node-args');
    mkdirSync(bin);
    writeFileSync(join(bin, 'yarn'), '#!/usr/bin/env sh\nexit 0\n');
    writeFileSync(join(bin, 'node'), '#!/usr/bin/env sh\nprintf \'%s\\n\' "$@" > "$NODE_ARGS"\n');
    chmodSync(join(bin, 'yarn'), 0o755);
    chmodSync(join(bin, 'node'), 0o755);

    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_ARGS: argsFile,
    };
    delete environment.UNIT_TEST_SHARD;
    if (shard) environment.UNIT_TEST_SHARD = shard;

    const result = spawnSync('sh', ['-eu', '-c', loadCoverageScript()], {
      encoding: 'utf8',
      env: environment,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    return readFileSync(argsFile, 'utf8').trim().split('\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function tokenizeWorkflowRun(run: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let comment = false;

  const pushToken = () => {
    if (token) tokens.push(token);
    token = '';
  };

  for (let index = 0; index < run.length; index += 1) {
    const character = run[index]!;
    if (comment) {
      if (character === '\n') {
        comment = false;
        pushToken();
        tokens.push('\n');
      }
      continue;
    }
    if (escaped) {
      if (character !== '\n') token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '#' && token === '') {
      comment = true;
      continue;
    }
    if (character === '\n' || character === ';' || character === '|' || character === '&') {
      pushToken();
      tokens.push('\n');
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      continue;
    }
    token += character;
  }
  pushToken();
  return tokens;
}

function normalizeWorkflowCommands(run: string): WorkflowCommand[] {
  const commands: WorkflowCommand[] = [];
  let words: string[] = [];

  const pushCommand = () => {
    let index = 0;
    while (
      index < words.length &&
      (shellKeywords.has(words[index]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!))
    ) {
      index += 1;
    }
    if (words[index] === 'env') {
      index += 1;
      while (
        index < words.length &&
        (words[index]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!))
      ) {
        index += 1;
      }
    }
    const executable = words[index];
    if (executable) commands.push({ executable, arguments: words.slice(index + 1) });
    words = [];
  };

  for (const token of tokenizeWorkflowRun(run)) {
    if (token === '\n') pushCommand();
    else words.push(token);
  }
  pushCommand();
  return commands;
}

function jobExecutesNode(job: WorkflowJob): boolean {
  return (job.steps ?? []).some((step) =>
    normalizeWorkflowCommands(step.run ?? '').some((command) => {
      const executable = command.executable.split('/').at(-1)!;
      return (
        nodeExecutables.has(executable) ||
        ((executable === 'bash' || executable === 'sh') &&
          command.arguments.some((argument) => nodeExecutingScripts.has(argument)))
      );
    }),
  );
}

test('CI exposes five non-cancelling unit-test batches behind Build & Test', () => {
  const jobs = loadCiJobs();
  const unitTests = jobs['unit-tests'];
  const aggregate = jobs.test;

  assert.ok(unitTests);
  assert.equal(unitTests.name, 'Unit tests (batch ${{ matrix.batch }}/5)');
  assert.equal(unitTests.strategy?.['fail-fast'], false);
  assert.deepEqual(unitTests.strategy?.matrix?.batch, [1, 2, 3, 4, 5]);

  const batchStep = unitTests.steps?.find((step) => step.env?.UNIT_TEST_SHARD);
  assert.deepEqual(batchStep?.env, {
    UNIT_TEST_BATCH: '${{ matrix.batch }}',
    UNIT_TEST_BATCHES: 5,
    UNIT_TEST_SHARD: '${{ matrix.batch }}/5',
  });
  assert.ok(batchStep?.run);
  const firstBatch = executeBatchStep(batchStep.run, 1);
  const lastBatch = executeBatchStep(batchStep.run, 5);
  assert.equal(firstBatch.stdout, 'Unit-test batch 1/5: discovered 13 files; selected 3 files');
  assert.equal(lastBatch.stdout, 'Unit-test batch 5/5: discovered 13 files; selected 2 files');
  assert.equal(firstBatch.args, 'yarn test:coverage');
  assert.equal(lastBatch.args, 'yarn test:coverage');

  assert.ok(aggregate);
  assert.equal(aggregate.name, 'Build & Test');
  assert.deepEqual(aggregate.needs, ['core-tests', 'unit-tests', 'cargo-test', 'qaren-tarball']);
  assert.equal(aggregate.if, '${{ always() }}');
});

test('workflow Node runtimes satisfy the supported floor', () => {
  const workflowFiles = readdirSync(workflowRoot).filter(
    (fileName) => fileName.endsWith('.yml') || fileName.endsWith('.yaml'),
  );

  for (const fileName of workflowFiles) {
    for (const [jobName, job] of Object.entries(loadWorkflowJobs(fileName))) {
      const setupSteps = (job.steps ?? []).filter((step) =>
        step.uses?.startsWith('actions/setup-node@'),
      );
      if (jobExecutesNode(job)) {
        assert.notEqual(
          setupSteps.length,
          0,
          `${fileName}:${jobName} executes Node without selecting a runtime`,
        );
      }
      for (const step of setupSteps) {
        const nodeVersion = step.with?.['node-version'];
        assert.notEqual(nodeVersion, undefined, `${fileName}:${jobName} must select Node`);
        const versions =
          nodeVersion === '${{ matrix.node }}' ? (job.strategy?.matrix?.node ?? []) : [nodeVersion];
        assert.notEqual(versions.length, 0, `${fileName}:${jobName} must define its Node matrix`);
        for (const version of versions) {
          const major = Number.parseInt(String(version), 10);
          assert.ok(
            Number.isSafeInteger(major) && major >= 24,
            `${fileName}:${jobName} selects unsupported Node ${String(version)}`,
          );
        }
      }
    }
  }
});

test('coverage command inserts the native shard option before authoritative discovery globs', () => {
  const fullArguments = captureCoverageArguments();
  const shardedArguments = captureCoverageArguments('3/5');
  const shardIndex = shardedArguments.indexOf('--test-shard=3/5');
  const firstPatternIndex = shardedArguments.findIndex((argument) =>
    argument.startsWith('test/unit/'),
  );

  assert.equal(
    fullArguments.some((argument) => argument.startsWith('--test-shard=')),
    false,
  );
  assert.notEqual(shardIndex, -1);
  assert.ok(shardIndex < firstPatternIndex);
  assert.deepEqual(
    shardedArguments.filter((argument) => argument !== '--test-shard=3/5'),
    fullArguments,
  );
});

test('Node native sharding covers every test file exactly once and deterministically', () => {
  withShardFixtures((files) => {
    const firstRun = runAllShards(files);
    const secondRun = runAllShards(files);
    const expected = files.map((file) => file.match(/fixture-(\d+)\.test\.js$/)?.[1]);

    assert.deepEqual(secondRun, firstRun);
    assert.deepEqual(
      firstRun.map((shard) => shard.length),
      [3, 3, 3, 2, 2],
    );
    assert.deepEqual(firstRun.flat().sort(), expected.sort());
    assert.equal(new Set(firstRun.flat()).size, files.length);
  });
});
