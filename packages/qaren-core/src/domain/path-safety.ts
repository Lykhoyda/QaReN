/**
 * Phase 134.3: path containment helpers (deepsec scan 2026-05-12).
 *
 * Closes HIGH/MEDIUM path-traversal findings where caller-controlled
 * actionId / outputDir / scanDir / screenshot path flowed into fs.write*
 * / fs.read* / shell-style discovery without containment.
 *
 * Two primitives:
 *   - isValidActionId(s): strict regex for IDs used as path segments
 *     under `.qaren/actions/`. Rejects path traversal, control
 *     characters, absolute-path-ish inputs, and over-long values.
 *   - assertWithinDir(child, baseDir): defense-in-depth containment
 *     check on a resolved path. Throws PathTraversalError if the
 *     resolved child escapes baseDir.
 *
 * Designed to be reused at every site where caller-derived strings
 * cross into the filesystem boundary — same chokepoint discipline as
 * Phase 134.1/134.2 (isValidBundleId for adb shell args).
 */
import { resolve, sep } from 'node:path';

// ── Errors ──────────────────────────────────────────────────────────

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

// ── Action ID validation ────────────────────────────────────────────
// Action IDs flow into `.qaren/actions/<id>.yaml` and the matching sidecar in
// the current runtime state directory. They must start with an alphanumeric
// character, then accept hyphen/underscore/dot/alphanumeric (dots support
// versioned flow names like `v2.0-login`). We deliberately exclude `..`, `/`,
// `\`, and control characters so the ID can never escape its parent directory.

const ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const ACTION_ID_MAX_LEN = 64;

export function isValidActionId(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > ACTION_ID_MAX_LEN) return false;
  // Belt-and-suspenders: even though `<id>.yaml` has no path separator, never
  // allow a `..` segment in the slug — keeps the "deliberately exclude `..`"
  // contract literally true regardless of how the id is later joined.
  if (s.includes('..')) return false;
  return ACTION_ID_RE.test(s);
}

export function assertValidActionId(s: unknown, context: string): asserts s is string {
  if (!isValidActionId(s)) {
    const preview = JSON.stringify(s).slice(0, 80);
    throw new PathTraversalError(`Invalid action ID for ${context}: ${preview}`);
  }
}

// ── Directory containment ───────────────────────────────────────────
// Resolves `child` against `baseDir` and rejects anything that doesn't
// land inside baseDir. Defense in depth — the action-ID regex prevents
// the common attack, but this catches any future call site that forgot
// to validate.
//
// Implementation note: a naive `resolvedChild.startsWith(resolvedBase)`
// check is broken — `/tmp/foo-extra` starts with `/tmp/foo`, but they're
// sibling directories. We require either an exact match or a match with
// the separator appended.

export function assertWithinDir(child: string, baseDir: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedChild = resolve(baseDir, child);
  if (resolvedChild === resolvedBase) return;
  const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (!resolvedChild.startsWith(baseWithSep)) {
    throw new PathTraversalError(
      `Path "${child}" escapes containment dir "${baseDir}" (resolved to ${resolvedChild})`,
    );
  }
}

export function isWithinDir(child: string, baseDir: string): boolean {
  try {
    assertWithinDir(child, baseDir);
    return true;
  } catch {
    return false;
  }
}

// ── Screenshot/output path safety ───────────────────────────────────
// Less strict than action IDs — users legitimately pass absolute paths
// like `/Users/me/Desktop/foo.jpg`. But we still reject `..` traversal
// segments anywhere in the path. Cheap defense against an LLM passing a
// crafted relative path that escapes the project dir.

export function pathHasTraversal(p: unknown): boolean {
  if (typeof p !== 'string') return false;
  // POSIX `..` segment, Windows `..` segment, URL-encoded `..`.
  return /(^|[\\/])\.\.([\\/]|$)/.test(p) || /%2e%2e/i.test(p);
}
