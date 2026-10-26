/**
 * Phase 134.1: Central Maestro flow validator (deepsec scan 2026-05-12).
 *
 * Every Maestro-emitting code path constructs flows via `buildMaestroFlow`;
 * every Maestro-executing path ingests YAML through `parseAndValidateFlow`.
 * Both enforce:
 *   - `appId` against a strict reverse-DNS regex (no newlines, no shell metachars)
 *   - All scalar values free of CR/LF, YAML document separators, unicode line breaks
 *   - Command keys against an allowlist
 *   - Denied commands (`runScript`, `evalScript`, `startRecording`,
 *     `stopRecording`) rejected by default — the primary RCE vectors in the
 *     prompt-injection threat model
 *
 * Closes 7 CRITICAL deepsec findings (RCE via raw YAML interpolation).
 * for the Phase 134.1 default-deny rationale.
 */
import yaml from 'yaml';
import { join, dirname, isAbsolute, sep } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';

// ── Errors ──────────────────────────────────────────────────────────

export class MaestroValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaestroValidationError';
  }
}

// ── Bundle ID validation ────────────────────────────────────────────
// Reverse-DNS notation: each segment starts with a letter, then
// letters/digits/underscore. At least two segments. Matches both Android
// package IDs and iOS bundle identifiers in practice.

// Each segment starts with a letter and then [A-Za-z0-9_-]. Apple's
// CFBundleIdentifier docs allow hyphens; Expo apps commonly use them
// (e.g. `com.my-app.testapp`). Multi-LLM review caught the original
// hyphen-less regex as breaking real bundle IDs.
const BUNDLE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)+$/;
const BUNDLE_ID_MAX_LEN = 256;

export function isValidBundleId(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length >= BUNDLE_ID_MAX_LEN) return false;
  return BUNDLE_ID_RE.test(s);
}

export function assertValidBundleId(s: unknown, context: string): asserts s is string {
  if (!isValidBundleId(s)) {
    const preview = JSON.stringify(s).slice(0, 80);
    throw new MaestroValidationError(`Invalid bundle ID for ${context}: ${preview}`);
  }
}

// ── Scalar safety ───────────────────────────────────────────────────
// Rejects characters that would let a string escape its YAML scalar context
// (newlines, document separators, unicode line breaks, control characters).

// oxlint-disable-next-line no-control-regex -- intentional: security check rejects control chars to prevent YAML injection
const UNSAFE_SCALAR_RE = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/;
const SCALAR_MAX_LEN = 4096;

export function isSafeMaestroScalar(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length > SCALAR_MAX_LEN) return false;
  if (UNSAFE_SCALAR_RE.test(s)) return false;
  // NOTE: we don't reject `---` as a substring. The actual document-separator
  // attack requires a newline-anchored `---`, already caught by the CR/LF
  // check above. `yaml.stringify` quotes any scalar containing tricky chars,
  // so mid-scalar `---` (e.g. "section --- title") is harmless when emitted
  // through buildMaestroFlow. Multi-LLM review caught this as a false positive.
  return true;
}

// ── Command allowlist ───────────────────────────────────────────────

const ALLOWED_COMMANDS = new Set<string>([
  'launchApp',
  'tapOn',
  'doubleTapOn',
  'longPressOn',
  'assertVisible',
  'assertNotVisible',
  'inputText',
  'eraseText',
  'scroll',
  'scrollUntilVisible',
  'swipe',
  // Multi-LLM review caught these: test-recorder-generators emits the
  // shorthand `- swipeUp` / `- swipeDown` / `- swipeLeft` / `- swipeRight`
  // top-level commands. Without these in the allowlist, every recorded
  // action containing a swipe would be refused at replay time. The
  // deepsec attack vector (newline-injected direction) is already
  // mitigated by isSafeMaestroScalar catching the embedded newline.
  'swipeUp',
  'swipeDown',
  'swipeLeft',
  'swipeRight',
  'back',
  'pressKey',
  'openLink',
  'waitForAnimationToEnd',
  'extendedWaitUntil',
  'hideKeyboard',
  'takeScreenshot',
  'clearState',
  'addMedia',
  'copyTextFrom',
  'pasteText',
  'travel',
  'setLocation',
  'setAirplaneMode',
  'killApp',
  'stopApp',
  'tap',
  // GH #186: runFlow (conditional dialog handling — deep-link "Open in", Expo
  // dev-client picker). Validated specially (validateRunFlowValue) so nested
  // `commands` get full command-level allowlist checks, and {file} refs are
  // securely resolved + expanded inline (expandRunFlows) — they are NOT passed
  // through generic validateValue, which would miss nested denied commands.
  'runFlow',
]);

const DENIED_COMMANDS = new Set<string>([
  'runScript',
  'evalScript',
  'startRecording',
  'stopRecording',
]);

export function containsClearState(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((command: unknown) => {
    if (command === 'clearState') return true;
    if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
    if ('clearState' in command && command.clearState !== false) return true;
    if ('launchApp' in command) {
      const launch = command.launchApp;
      if (launch && typeof launch === 'object' && 'clearState' in launch) {
        return launch.clearState !== false;
      }
    }
    return containsClearState(asRunFlow(command)?.commands);
  });
}

// ── Builder ─────────────────────────────────────────────────────────

export interface MaestroFlowOptions {
  appId?: string;
}

export type MaestroCommand = Record<string, unknown>;

export function buildMaestroFlow(opts: MaestroFlowOptions, commands: unknown[]): string {
  if (opts.appId !== undefined) {
    assertValidBundleId(opts.appId, 'appId header');
  }
  for (const cmd of commands) {
    validateCommand(cmd);
  }
  const headerYaml = opts.appId ? yaml.stringify({ appId: opts.appId }) : '';
  const bodyYaml = yaml.stringify(commands);
  return `${headerYaml}---\n${bodyYaml}`;
}

export function validateCommand(cmd: unknown): void {
  if (cmd === null || cmd === undefined) {
    throw new MaestroValidationError('Command is null/undefined');
  }
  if (typeof cmd === 'string') {
    if (!isSafeMaestroScalar(cmd)) {
      throw new MaestroValidationError(
        `Unsafe shorthand command: ${JSON.stringify(cmd).slice(0, 80)}`,
      );
    }
    if (DENIED_COMMANDS.has(cmd)) {
      throw new MaestroValidationError(`Command not allowed (denied by default): ${cmd}`);
    }
    if (!ALLOWED_COMMANDS.has(cmd)) {
      throw new MaestroValidationError(`Command not in allowlist: ${cmd}`);
    }
    return;
  }
  if (typeof cmd !== 'object') {
    throw new MaestroValidationError(`Command is not an object or string: ${typeof cmd}`);
  }
  const keys = Object.keys(cmd as Record<string, unknown>);
  if (keys.length !== 1) {
    throw new MaestroValidationError(
      `Command must have exactly one root key, got ${keys.length}: ${keys.join(', ')}`,
    );
  }
  const key = keys[0];
  if (DENIED_COMMANDS.has(key)) {
    throw new MaestroValidationError(`Command not allowed (denied by default): ${key}`);
  }
  if (!ALLOWED_COMMANDS.has(key)) {
    throw new MaestroValidationError(`Command not in allowlist: ${key}`);
  }
  if (key === 'runFlow') {
    validateRunFlowValue((cmd as Record<string, unknown>)[key]);
    return;
  }
  validateValue((cmd as Record<string, unknown>)[key]);
}

/**
 * GH #186: validate a runFlow value. The string/`{file}` form is a sub-flow
 * file ref (a safe scalar here; secure resolution happens in expandRunFlows).
 * Inline `commands` are validated as COMMANDS (recursive allowlist check) — the
 * critical difference from generic validateValue, which would let a nested
 * `runScript` slip through as a plain scalar key/value.
 */
function validateRunFlowValue(v: unknown): void {
  if (typeof v === 'string') {
    if (!isSafeMaestroScalar(v)) {
      throw new MaestroValidationError(
        `Unsafe runFlow file ref: ${JSON.stringify(v).slice(0, 80)}`,
      );
    }
    return;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new MaestroValidationError(
      `runFlow value must be a file string or an object, got ${Array.isArray(v) ? 'array' : typeof v}`,
    );
  }
  const obj = v as Record<string, unknown>;
  if ('file' in obj && (typeof obj.file !== 'string' || !isSafeMaestroScalar(obj.file))) {
    throw new MaestroValidationError(`runFlow.file must be a safe scalar string`);
  }
  if ('when' in obj) validateValue(obj.when);
  if ('commands' in obj) {
    if (!Array.isArray(obj.commands)) {
      throw new MaestroValidationError(`runFlow.commands must be an array`);
    }
    for (const c of obj.commands) validateCommand(c);
  }
  // Any other keys (env/label/config) are validated as generic safe values.
  for (const [k, val] of Object.entries(obj)) {
    if (k === 'file' || k === 'when' || k === 'commands') continue;
    if (!isSafeMaestroScalar(k)) {
      throw new MaestroValidationError(`Unsafe runFlow key: ${JSON.stringify(k).slice(0, 80)}`);
    }
    validateValue(val);
  }
}

function validateValue(v: unknown): void {
  if (v === null || v === undefined) return;
  if (typeof v === 'boolean' || typeof v === 'number') return;
  if (typeof v === 'string') {
    if (!isSafeMaestroScalar(v)) {
      throw new MaestroValidationError(`Unsafe scalar value: ${JSON.stringify(v).slice(0, 80)}`);
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) validateValue(item);
    return;
  }
  if (typeof v === 'object') {
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (!isSafeMaestroScalar(key)) {
        throw new MaestroValidationError(`Unsafe scalar key: ${JSON.stringify(key).slice(0, 80)}`);
      }
      validateValue(value);
    }
    return;
  }
  throw new MaestroValidationError(`Unsupported value type: ${typeof v}`);
}

// ── Parser ──────────────────────────────────────────────────────────

export interface ParsedFlow {
  appId?: string;
  commands: unknown[];
  /** Canonical re-serialization through `buildMaestroFlow` — safe to write to disk. */
  raw: string;
}

export interface ParseAndValidateOptions {
  /** Reject flows that include an `appId` header. Default `false`. */
  rejectHeader?: boolean;
  // GH #186: runFlow {file} support. When flowDir + flowRoot are provided,
  // file refs are resolved relative to flowDir, required to canonicalize within
  // flowRoot (no `..`/absolute/symlink escape), recursively parsed+validated,
  // and EXPANDED INLINE so the serialized flow has no remaining file refs (the
  // flow is later written to /tmp, where a relative ref would break). A {file}
  // ref with no flowRoot context is rejected.
  flowDir?: string;
  flowRoot?: string;
  /** Max runFlow nesting depth. Default 5. */
  maxRunFlowDepth?: number;
  /** Test seam — defaults to fs.readFileSync(utf8). */
  readFileFn?: (path: string) => string;
  /** Test seam — defaults to fs.realpathSync. */
  realpathFn?: (path: string) => string;
  /** Internal: current recursion depth. */
  _depth?: number;
  /** Internal: canonical paths already on the resolution stack (cycle guard). */
  _visited?: Set<string>;
}

// GH #186: recognize a single-key `runFlow` command and extract its shape.
// Returns null for non-runFlow OR malformed runFlow (which validateCommand then
// rejects), so expandRunFlows passes those through untouched.
function asRunFlow(cmd: unknown): { file?: string; when?: unknown; commands?: unknown[] } | null {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return null;
  const keys = Object.keys(cmd as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'runFlow') return null;
  const v = (cmd as Record<string, unknown>).runFlow;
  if (typeof v === 'string') return { file: v };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return {
      file: typeof o.file === 'string' ? o.file : undefined,
      when: o.when,
      commands: Array.isArray(o.commands) ? o.commands : undefined,
    };
  }
  return null;
}

export function collectRunFlowFileReferences(yamlText: string): string[] {
  try {
    const docs = yaml.parseAllDocuments(yamlText, { strict: true });
    const body = docs.at(-1)?.toJS();
    if (!Array.isArray(body)) return [];
    const references = new Set<string>();
    const visit = (commands: unknown[]): void => {
      for (const command of commands) {
        const runFlow = asRunFlow(command);
        if (!runFlow) continue;
        if (runFlow.file !== undefined) references.add(runFlow.file);
        if (runFlow.commands) visit(runFlow.commands);
      }
    };
    visit(body);
    return [...references];
  } catch {
    return [];
  }
}

// GH #186: resolve a runFlow file ref to a canonical path, enforcing: relative
// only, no `..`, .yaml/.yml only, and containment within flowRoot after realpath
// (defeats symlink escape). Throws on any violation or missing root context.
export function resolveRunFlowTarget(file: string, opts: ParseAndValidateOptions): string {
  if (!opts.flowDir || !opts.flowRoot) {
    throw new MaestroValidationError(
      `runFlow file ref "${file}" requires a flow root context (flowDir + flowRoot)`,
    );
  }
  if (isAbsolute(file)) {
    throw new MaestroValidationError(`runFlow file ref must be relative, got absolute: ${file}`);
  }
  if (file.split(/[\\/]/).includes('..')) {
    throw new MaestroValidationError(`runFlow file ref must not contain '..': ${file}`);
  }
  if (!/\.ya?ml$/i.test(file)) {
    throw new MaestroValidationError(`runFlow file ref must be a .yaml/.yml file: ${file}`);
  }
  const realpath = opts.realpathFn ?? realpathSync;
  let resolved: string;
  let rootReal: string;
  try {
    resolved = realpath(join(opts.flowDir, file));
    rootReal = realpath(opts.flowRoot);
  } catch (err) {
    throw new MaestroValidationError(
      `runFlow file ref "${file}" could not be resolved: ${(err as Error).message}`,
    );
  }
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    throw new MaestroValidationError(`runFlow file ref "${file}" escapes the flow root`);
  }
  return resolved;
}

// GH #186: expand runFlow file refs inline so the serialized flow (written to
// /tmp) has no remaining file references. A `{file}` with a `when` becomes an
// inline conditional `{when, commands}` (semantics preserved); without `when`
// the sub-flow's commands are spliced flat. Inline runFlow is recursed into.
export function expandRunFlows(commands: unknown[], opts: ParseAndValidateOptions): unknown[] {
  const out: unknown[] = [];
  for (const cmd of commands) {
    const rf = asRunFlow(cmd);
    if (!rf) {
      out.push(cmd);
      continue;
    }

    if (rf.file !== undefined) {
      const depth = opts._depth ?? 0;
      const max = opts.maxRunFlowDepth ?? 5;
      if (depth >= max) {
        throw new MaestroValidationError(`runFlow nesting exceeded max depth ${max}`);
      }
      const resolved = resolveRunFlowTarget(rf.file, opts);
      const visited = opts._visited ?? new Set<string>();
      if (visited.has(resolved)) {
        throw new MaestroValidationError(`runFlow cycle detected at "${rf.file}"`);
      }
      const readFile = opts.readFileFn ?? ((p: string) => readFileSync(p, 'utf8'));
      let subText: string;
      try {
        subText = readFile(resolved);
      } catch (err) {
        throw new MaestroValidationError(
          `runFlow file "${rf.file}" could not be read: ${(err as Error).message}`,
        );
      }
      const sub = parseAndValidateFlow(subText, {
        ...opts,
        rejectHeader: true,
        flowDir: dirname(resolved),
        _depth: depth + 1,
        _visited: new Set([...visited, resolved]),
      });
      if (rf.when !== undefined) {
        out.push({ runFlow: { when: rf.when, commands: sub.commands } });
      } else {
        out.push(...sub.commands);
      }
    } else {
      // Inline runFlow (no file) — recurse into nested commands, keep the wrapper.
      const inner = rf.commands
        ? expandRunFlows(rf.commands, { ...opts, _depth: (opts._depth ?? 0) + 1 })
        : [];
      const wrapped: Record<string, unknown> = { commands: inner };
      if (rf.when !== undefined) wrapped.when = rf.when;
      out.push({ runFlow: wrapped });
    }
  }
  return out;
}

export function parseAndValidateFlow(
  yamlText: string,
  opts: ParseAndValidateOptions = {},
): ParsedFlow {
  let docs;
  try {
    docs = yaml.parseAllDocuments(yamlText, { strict: true });
  } catch (err) {
    throw new MaestroValidationError(`YAML parse error: ${(err as Error).message}`);
  }
  if (docs.length === 0) {
    throw new MaestroValidationError('Empty Maestro flow');
  }

  let appId: string | undefined;
  let body: unknown;
  if (docs.length === 1) {
    body = docs[0].toJS();
  } else {
    const header = docs[0].toJS() ?? {};
    if (header && typeof header === 'object' && 'appId' in header) {
      if (opts.rejectHeader) {
        throw new MaestroValidationError('Header (appId) not allowed in this context');
      }
      const rawAppId = (header as Record<string, unknown>).appId;
      assertValidBundleId(rawAppId, 'parsed flow header');
      appId = rawAppId;
    }
    body = docs[docs.length - 1].toJS();
  }

  if (body === null || body === undefined) {
    body = [];
  }
  if (!Array.isArray(body)) {
    throw new MaestroValidationError(`Flow body must be an array, got ${typeof body}`);
  }
  // GH #186: resolve + inline runFlow file refs FIRST, then validate the
  // expanded (file-ref-free) body so what we serialize is self-contained.
  const expanded = expandRunFlows(body, opts);
  for (const cmd of expanded) {
    validateCommand(cmd);
  }

  const raw = buildMaestroFlow(appId !== undefined ? { appId } : {}, expanded);
  return { appId, commands: expanded, raw };
}
