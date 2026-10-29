import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type NativeRunnerName = 'qaren-ios-runner' | 'rn-android-runner';

const LEGACY_NATIVE_RUNNER_NAMES: Partial<Record<NativeRunnerName, string>> = {
  'qaren-ios-runner': 'rn-fast-runner',
};

function compactUnique(paths: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!path || out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function candidateDirsFor(runnerName: string, baseDir: string): string[] {
  const runnerRoot = process.env.QAREN_NATIVE_RUNNER_ROOT;
  const repoRoot = process.env.QAREN_ROOT;

  return compactUnique([
    runnerRoot ? join(runnerRoot, runnerName) : undefined,
    repoRoot ? join(repoRoot, 'packages', runnerName) : undefined,
    // Installed runtime: <runtime>/runners/<runner>.
    join(baseDir, '..', 'runners', runnerName),
    // Source checkout: packages/qaren-core/dist/runners → packages/<runner>.
    join(baseDir, '..', '..', '..', runnerName),
  ]);
}

export function candidateNativeRunnerDirs(
  runnerName: NativeRunnerName,
  baseDir = import.meta.dirname,
): string[] {
  return candidateDirsFor(runnerName, baseDir);
}

export function legacyNativeRunnerDirHint(
  runnerName: NativeRunnerName,
  baseDir = import.meta.dirname,
): string | undefined {
  const legacyName = LEGACY_NATIVE_RUNNER_NAMES[runnerName];
  if (!legacyName) return undefined;
  const legacyDir = candidateDirsFor(legacyName, baseDir).find(isDirectory);
  return legacyDir
    ? `found pre-2.0.4 runner directory ${legacyDir}; this version cannot use it: install the current runner (qaren update, or a fresh source checkout) or unset QAREN_NATIVE_RUNNER_ROOT/QAREN_ROOT`
    : undefined;
}

export function resolveNativeRunnerDir(
  runnerName: NativeRunnerName,
  baseDir = import.meta.dirname,
): string {
  const candidates = candidateNativeRunnerDirs(runnerName, baseDir);
  return candidates.find(isDirectory) ?? candidates[0];
}

export function candidateRunnerManifestFiles(baseDir = import.meta.dirname): string[] {
  const repoRoot = process.env.QAREN_ROOT;

  return compactUnique([
    process.env.QAREN_RUNNER_MANIFEST,
    repoRoot ? join(repoRoot, 'runner-manifest.json') : undefined,
    // Installed runtime: <runtime>/runner-manifest.json.
    join(baseDir, '..', 'runner-manifest.json'),
    // Source checkout: packages/qaren-core/dist/runners → repository root.
    join(baseDir, '..', '..', '..', '..', 'runner-manifest.json'),
  ]);
}

export function candidatePluginManifestFiles(baseDir = import.meta.dirname): string[] {
  return compactUnique([
    // Installed runtime identity takes precedence over host-plugin overrides.
    join(baseDir, '..', 'package.json'),
    process.env.QAREN_PLUGIN_MANIFEST,
    // Source checkout: packages/qaren-core/dist/runners → packages/qaren-plugin.
    join(baseDir, '..', '..', '..', 'qaren-plugin', '.claude-plugin', 'plugin.json'),
  ]);
}

export function firstExistingFile(candidates: string[]): string | null {
  return candidates.find((path) => existsSync(path)) ?? null;
}
