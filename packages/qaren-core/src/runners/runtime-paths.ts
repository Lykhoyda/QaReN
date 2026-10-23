import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

export function candidateNativeRunnerDirs(
  runnerName: 'rn-fast-runner' | 'rn-android-runner',
  baseDir = import.meta.dirname,
): string[] {
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

export function resolveNativeRunnerDir(
  runnerName: 'rn-fast-runner' | 'rn-android-runner',
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
