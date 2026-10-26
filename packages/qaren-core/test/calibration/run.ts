import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { assertCheck } from '../../../../scripts/assert-qaren-check.ts';
import type { WalkResult } from '../../dist/qa/ledger.js';
import { analyze, readMetrics } from './analyze.ts';
import { hash, planPath, policy, schedule, target } from './schedule.ts';

const root = realpathSync(fileURLToPath(new URL('../../../..', import.meta.url)));
const cli = join(root, 'packages/qaren-cli/target/debug/qaren');
const runtime = join(root, 'packages/qaren-core/dist');
const native = join(root, 'packages/rn-fast-runner/build/DerivedData/Build/Products');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

function fileHash(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return 'missing';
  return stat.isSymbolicLink() ? hash(`symlink:${readlinkSync(path)}`) : hash(readFileSync(path));
}

function treeHash(path: string): string {
  const entries = readdirSync(path)
    .sort()
    .map((name) => {
      const child = join(path, name);
      return [name, lstatSync(child).isDirectory() ? treeHash(child) : fileHash(child)];
    });
  return hash(JSON.stringify(entries));
}

function worktreeHash(path: string): string {
  const paths = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: path, maxBuffer: 16 * 1024 * 1024 },
  )
    .toString()
    .split('\0')
    .filter(Boolean);
  return hash(
    JSON.stringify([...new Set(paths)].sort().map((name) => [name, fileHash(join(path, name))])),
  );
}

export function command(): string[] {
  return [
    'check',
    '--plan-file',
    planPath,
    '--fresh-install',
    '--json',
    '--device',
    target.device,
    '--boot-device',
  ];
}

function environment(): NodeJS.ProcessEnv {
  if (
    Object.keys(process.env).some(
      (key) =>
        key.startsWith('QAREN_') ||
        (key.startsWith('RN_') && key !== 'RN_RUNNER_BUILD') ||
        key === 'NODE_OPTIONS' ||
        key === 'NODE_PATH',
    )
  )
    throw new Error('CALIBRATION_ENV_OVERRIDE');
  const env: NodeJS.ProcessEnv = { ...process.env, RN_RUNNER_BUILD: 'local' };
  for (const key of [
    'COREPACK_ROOT',
    'COREPACK_ENABLE_DOWNLOAD_PROMPT',
    'COREPACK_ENABLE_AUTO_PIN',
  ])
    delete env[key];
  return env;
}

function snapshot(app: string) {
  for (const path of [cli, runtime, native, join(app, '.qaren/config.yaml')]) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink())
      throw new Error('CALIBRATION_PREREQUISITE_MISSING');
  }
  if (parseYaml(readFileSync(join(app, '.qaren/config.yaml'), 'utf8'))?.appId !== target.appId)
    throw new Error('CALIBRATION_APP_MISMATCH');
  return {
    source: worktreeHash(root),
    app: worktreeHash(app),
    config: fileHash(join(app, '.qaren/config.yaml')),
    cli: fileHash(cli),
    runtime: treeHash(runtime),
    native: treeHash(native),
  };
}

interface FrozenManifest {
  version: 1;
  root: string;
  app: string;
  target: typeof target;
  policy: typeof policy;
  schedule: ReturnType<typeof schedule>;
  snapshot: ReturnType<typeof snapshot>;
  command: string[];
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function freeze(appPath: string, output: string): void {
  environment();
  const app = realpathSync(appPath);
  const directory = resolve(output);
  const parent = realpathSync(dirname(directory));
  if (
    inside(root, join(parent, basename(directory))) ||
    inside(app, join(parent, basename(directory)))
  )
    throw new Error('CALIBRATION_OUTPUT_MUST_BE_EXTERNAL');
  const manifest: FrozenManifest = {
    version: 1,
    root,
    app,
    target,
    policy,
    schedule: schedule(),
    snapshot: snapshot(app),
    command: command(),
  };
  mkdirSync(directory, { mode: 0o700 });
  write(join(directory, 'manifest.json'), manifest);
}

function load(directory: string): FrozenManifest {
  const manifest: FrozenManifest = json(join(directory, 'manifest.json'));
  if (
    manifest.version !== 1 ||
    manifest.root !== root ||
    !isAbsolute(manifest.app) ||
    JSON.stringify(manifest.schedule) !== JSON.stringify(schedule()) ||
    JSON.stringify(manifest.policy) !== JSON.stringify(policy) ||
    JSON.stringify(manifest.target) !== JSON.stringify(target) ||
    JSON.stringify(manifest.command) !== JSON.stringify(command())
  )
    throw new Error('CALIBRATION_MANIFEST_CHANGED');
  return manifest;
}

export function run(directory: string): number {
  const manifest = load(directory);
  const env = environment();
  if (!env.TYPESAFE_API_KEY) throw new Error('CALIBRATION_KEY_MISSING');
  if (JSON.stringify(manifest.snapshot) !== JSON.stringify(snapshot(manifest.app)))
    throw new Error('CALIBRATION_INPUT_DRIFT');
  write(join(directory, 'started.json'), { manifest: fileHash(join(directory, 'manifest.json')) });
  const receipt = openSync(join(directory, 'receipt.json'), 'wx', 0o600);
  const stderr = openSync(join(directory, 'stderr.log'), 'wx', 0o600);
  try {
    const result = spawnSync(cli, manifest.command, {
      cwd: manifest.app,
      env,
      stdio: ['ignore', receipt, stderr],
    });
    write(join(directory, 'finished.json'), {
      status: result.status,
      signal: result.signal,
      spawnError: !!result.error,
      snapshot: snapshot(manifest.app),
    });
    return result.status ?? 1;
  } finally {
    closeSync(receipt);
    closeSync(stderr);
  }
}

export function analyzeRun(directory: string) {
  const failures: string[] = [];
  let metrics: ReturnType<typeof analyze> | undefined;
  try {
    const manifest = load(directory);
    const started = json(join(directory, 'started.json'));
    const finished = json(join(directory, 'finished.json'));
    if (started.manifest !== fileHash(join(directory, 'manifest.json')))
      failures.push('MANIFEST_DRIFT');
    if (finished.status !== 0 || finished.signal !== null || finished.spawnError !== false)
      failures.push('CHECK_FAILED');
    if (JSON.stringify(manifest.snapshot) !== JSON.stringify(finished.snapshot))
      failures.push('INPUT_DRIFT');
    const receipt = json(join(directory, 'receipt.json'));
    const ledger: WalkResult = json(receipt.artifacts.ledger);
    const record = json(receipt.artifacts.run_record);
    if (receipt.device?.ios_udid !== target.device || receipt.candidate?.app_id !== target.appId)
      failures.push('TARGET_MISMATCH');
    try {
      assertCheck(receipt, ledger, true, record);
    } catch {
      failures.push('RECEIPT_OR_CLEANUP_INCOMPLETE');
    }
    const shot = ledger.steps.find((row) => row.line === manifest.schedule.cachedCheck)?.screenshot;
    const runDir = dirname(receipt.artifacts.run_record);
    if (
      !shot ||
      isAbsolute(shot) ||
      !inside(runDir, resolve(runDir, shot)) ||
      !existsSync(join(runDir, shot)) ||
      !lstatSync(join(runDir, shot)).isFile() ||
      !inside(realpathSync(runDir), realpathSync(join(runDir, shot))) ||
      readFileSync(join(runDir, shot)).subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    )
      failures.push('CACHED_SCREENSHOT_FILE_MISSING');
    metrics = analyze(
      readMetrics(
        readFileSync(join(dirname(receipt.artifacts.run_record), 'logs/core.log'), 'utf8'),
      ),
      ledger,
    );
  } catch {
    failures.push('CAMPAIGN_EVIDENCE_MISSING_OR_INVALID');
  }
  return {
    pass: failures.length === 0 && metrics?.pass === true,
    failures,
    metrics,
    expected: schedule(),
  };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const [action, first, second] = process.argv.slice(2);
    if (action === 'freeze' && first && second && process.argv.length === 5) freeze(first, second);
    else if (action === 'run' && first && process.argv.length === 4) process.exitCode = run(first);
    else if (action === 'analyze' && first && process.argv.length === 4) {
      const report = analyzeRun(first);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.pass ? 0 : 1;
    } else
      throw new Error(
        'usage: run.ts freeze <app> <new-external-directory> | run <directory> | analyze <directory>',
      );
  } catch {
    console.error('CALIBRATION_COMMAND_FAILED');
    process.exitCode = 1;
  }
}
