import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export function isRnProject(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return !!(deps['react-native'] || deps['expo']);
  } catch {
    return false;
  }
}

// B134: scan one directory for an RN project, recursing up to maxDepth into
// subdirectories. Used as the last resort when the standard cwd + walk-up cascade
// fails — handles the plugin-repo ↔ sibling-workspace/test-app layout where cwd
// is the plugin repo but the RN project lives as a sibling's child (common when
// Claude Code is launched from a plugin directory without --plugin-dir override).
//
// Traversal is **breadth-first with sorted entries**:
// - All direct children at each level are checked before any recursion, so a
//   direct-sibling RN project always wins over a grandchild RN project of
//   another sibling (per review finding — prevents "aaa-unrelated/demo-rn/"
//   beating "zzz-real-rn/" when both exist as siblings).
// - `entries.sort()` makes the pick deterministic across filesystems whose
//   readdirSync ordering differs (APFS sorts, ext4 doesn't). When multiple RN
//   projects exist, alphabetical order is a stable default.
function scanForRnProject(rootDir: string, maxDepth: number): string | null {
  if (maxDepth < 0) return null;
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return null;
  }
  entries.sort();

  // Pass 1 at this level: check all direct children for an RN project.
  const subdirs: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(rootDir, name);
    try {
      const stat = lstatSync(full);
      if (!(stat.isDirectory() || stat.isSymbolicLink())) continue;
    } catch {
      continue;
    }
    if (isRnProject(full)) return full;
    subdirs.push(full);
  }

  // Pass 2 at this level: recurse into non-matching subdirs (breadth-first).
  if (maxDepth > 0) {
    for (const dir of subdirs) {
      const deeper = scanForRnProject(dir, maxDepth - 1);
      if (deeper) return deeper;
    }
  }
  return null;
}

// B144: collect ALL RN projects reachable from rootDir up to maxDepth. Same
// breadth-first traversal as scanForRnProject but does not short-circuit —
// used by the bundleId-aware path in findProjectRoot which needs every
// candidate to pick the matching one.
function collectRnProjects(rootDir: string, maxDepth: number, out: string[]): void {
  if (maxDepth < 0) return;
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return;
  }
  entries.sort();
  const subdirs: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(rootDir, name);
    try {
      const stat = lstatSync(full);
      if (!(stat.isDirectory() || stat.isSymbolicLink())) continue;
    } catch {
      continue;
    }
    if (isRnProject(full)) {
      out.push(full);
    } else {
      subdirs.push(full);
    }
  }
  if (maxDepth > 0) {
    for (const dir of subdirs) collectRnProjects(dir, maxDepth - 1, out);
  }
}

// B144: extract the declared bundleId from a project's app.json. Covers the
// two common Expo/RN shapes: expo.ios.bundleIdentifier (iOS) and
// expo.android.package (Android). Returns the iOS bundleIdentifier when both
// are present (matches the platform Metro typically reports as the Hermes
// target's description). Bare RN apps with native Xcode configs aren't
// covered — parsing pbxproj is fragile and those apps won't gain
// bundleId-matching. They gracefully fall back to the current alphabetical
// sibling pick.
export function readProjectBundleId(projectRoot: string): string | null {
  const appJsonPath = join(projectRoot, 'app.json');
  if (!existsSync(appJsonPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(appJsonPath, 'utf-8')) as {
      expo?: { ios?: { bundleIdentifier?: string }; android?: { package?: string } };
      ios?: { bundleIdentifier?: string };
      android?: { package?: string };
    };
    const iosId = raw.expo?.ios?.bundleIdentifier ?? raw.ios?.bundleIdentifier;
    const androidId = raw.expo?.android?.package ?? raw.android?.package;
    if (typeof iosId === 'string' && iosId.length > 0) return iosId;
    if (typeof androidId === 'string' && androidId.length > 0) return androidId;
    return null;
  } catch {
    return null;
  }
}

export interface FindProjectRootOpts {
  /**
   * B144: when provided, prefer the candidate RN project whose app.json
   * declares this bundleId. Disambiguates the common sibling-scan pitfall
   * where the plugin CWD has multiple RN project siblings (e.g. the
   * alphabetically-first one wins even though it's a different app from
   * the one Metro is currently hosting). If no candidate matches, falls
   * back to the legacy ordering (first-found wins by walk-up then
   * alphabetical sibling scan).
   */
  bundleId?: string;
}

export function findProjectRoot(opts: FindProjectRootOpts = {}): string | null {
  const targetBundleId = opts.bundleId;

  // B144 Codex #1 (conf ≥80): RN_PROJECT_ROOT is user-explicit config and
  // MUST be absolute priority. Return immediately when it points at an RN
  // project, regardless of bundleId. Bundle disambiguation only applies
  // to heuristic sources (CLAUDE_USER_CWD, cwd, sibling scans). If env and
  // the requested bundleId conflict, the user-explicit env wins — if the
  // user wants a different app, they should update env or unset it.
  const envRoot = process.env.RN_PROJECT_ROOT;
  if (envRoot && isRnProject(envRoot)) return envRoot;

  // Cascade 1: non-env starts + walk-up. If bundleId is provided and any
  // cascade hit matches it, return immediately. Otherwise remember the
  // first hit as a fallback for when no sibling matches either.
  let walkupHit: string | null = null;
  const starts = [process.env.CLAUDE_USER_CWD, process.cwd()].filter(Boolean) as string[];

  for (const start of starts) {
    if (isRnProject(start)) {
      if (targetBundleId && readProjectBundleId(start) === targetBundleId) return start;
      walkupHit = walkupHit ?? start;
      continue;
    }
    let dir = start;
    for (let i = 0; i < 10; i++) {
      if (isRnProject(dir)) {
        if (targetBundleId && readProjectBundleId(dir) === targetBundleId) return dir;
        walkupHit = walkupHit ?? dir;
        break;
      }
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }

  if (!targetBundleId && walkupHit) return walkupHit;

  // Cascade 2: scan cwd subdirs and sibling + grandchildren. If bundleId
  // is provided, collect all candidates and prefer the match. Otherwise
  // stop at the first hit (legacy behavior).
  const cwd = process.cwd();
  const parentOfCwd = join(cwd, '..');

  if (targetBundleId) {
    const all: string[] = [];
    collectRnProjects(cwd, 0, all);
    if (parentOfCwd !== cwd) collectRnProjects(parentOfCwd, 1, all);
    for (const candidate of all) {
      if (readProjectBundleId(candidate) === targetBundleId) return candidate;
    }
    // No match — fall back to first candidate from cascade 1 or 2.
    if (walkupHit) return walkupHit;
    return all[0] ?? null;
  }

  // Legacy path (no bundleId): preserve current behavior exactly.
  const cwdScan = scanForRnProject(cwd, 0);
  if (cwdScan) return cwdScan;
  if (parentOfCwd !== cwd) {
    const siblingScan = scanForRnProject(parentOfCwd, 1);
    if (siblingScan) return siblingScan;
  }
  return null;
}
