// D1206 Tier 2 Sprint C / Phase 127 — Sidecar JSON I/O for ReusableAction.
//
// Read/write per-action state under the fenced session runtime root, or under
// project-local .qaren/state only for an unfenced compatibility process.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { type ActionRuntimeState, freshRuntimeState } from './reusable-action.js';
import { sessionStateDirectory } from '../util/runtime-paths.js';

/** Return the canonical sidecar path for a given action YAML path. */
export function sidecarPathFor(yamlFilePath: string): string {
  // Action YAML maps to <current-runtime-state-directory>/<id>.state.json.
  // A fenced process uses its configured session runtime state directory;
  // only the unfenced fallback derives sibling .qaren/state from the YAML.
  //
  // GH #112: split on BOTH POSIX and Windows separators. The original
  // `split('/').pop()` returned the entire backslash-containing path as a
  // single segment on Windows, leading `join(parent, 'state', base)` to
  // produce a deeply-nested broken directory tree. Using `path.basename`
  // alone isn't enough because on a POSIX runtime `path.basename` doesn't
  // recognize `\` as a separator, so a Windows-style input passed through
  // unrelated code (e.g. cross-platform test fixtures) would still
  // misbehave. Explicit `[/\\]` split is platform-agnostic at the source.
  const dir = dirname(yamlFilePath);
  const parent = dirname(dir);
  const filename = yamlFilePath.replace(/\.ya?ml$/i, '.state.json');
  const base = filename.split(/[\\/]/).pop()!;
  const stateDirectory = process.env.QAREN_SESSION_RUNTIME_ROOT
    ? sessionStateDirectory(dirname(parent))
    : join(parent, 'state');
  return join(stateDirectory, base);
}

/**
 * Load a sidecar from disk. If absent or unreadable/corrupt, returns a
 * fresh state seeded from the YAML's mtime (so the first auto-repair
 * run won't immediately fire a false "human edited" alarm).
 */
export function loadOrInitSidecar(
  yamlFilePath: string,
  now: () => Date = () => new Date(),
): ActionRuntimeState {
  const path = sidecarPathFor(yamlFilePath);
  if (existsSync(path)) {
    try {
      const text = readFileSync(path, 'utf8');
      const parsed = JSON.parse(text) as ActionRuntimeState;
      // Minimal schema validation — required scalars present.
      if (
        parsed &&
        parsed.schemaVersion === 1 &&
        typeof parsed.revision === 'number' &&
        typeof parsed.updatedAt === 'string' &&
        Array.isArray(parsed.runHistory) &&
        Array.isArray(parsed.repairHistory) &&
        typeof parsed.stats === 'object'
      ) {
        // A sidecar missing lastSeenMtimeMs (e.g. written before the field
        // existed) would silently disable the human-edit guard, since
        // yamlEditedSinceLastSeen compares against undefined. Re-seed just that
        // field from the YAML's mtime — preserves run/repair history.
        if (typeof parsed.lastSeenMtimeMs !== 'number') {
          try {
            parsed.lastSeenMtimeMs = statSync(yamlFilePath).mtimeMs;
          } catch {
            parsed.lastSeenMtimeMs = 0;
          }
        }
        return parsed;
      }
      // Fall through — corrupted; return fresh.
    } catch {
      // Fall through — corrupted; return fresh.
    }
  }
  // No sidecar yet — seed with YAML's mtime so the first auto-repair
  // attempt won't think a human edited it since "last seen".
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(yamlFilePath).mtimeMs;
  } catch {
    /* ignore */
  }
  return freshRuntimeState(now, mtimeMs);
}

/**
 * Persist a sidecar to the current runtime state directory, creating it when
 * missing. The YAML supplies the action id; callers cannot override the path.
 */
export function saveSidecar(yamlFilePath: string, state: ActionRuntimeState): { path: string } {
  const path = sidecarPathFor(yamlFilePath);
  const parentDir = dirname(path);
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return { path };
}

/**
 * Detect whether the YAML has been edited since the sidecar's
 * `lastSeenMtimeMs`. Used by self-repair to abort before clobbering
 * a human edit.
 */
export function yamlEditedSinceLastSeen(yamlFilePath: string, state: ActionRuntimeState): boolean {
  try {
    const current = statSync(yamlFilePath).mtimeMs;
    return current > state.lastSeenMtimeMs;
  } catch {
    return false; // Can't stat — treat as unchanged; downstream errors will surface elsewhere.
  }
}

/** Update the sidecar's lastSeenMtimeMs after a successful read or write. */
export function markSeen(state: ActionRuntimeState, mtimeMs: number): ActionRuntimeState {
  return { ...state, lastSeenMtimeMs: mtimeMs };
}
