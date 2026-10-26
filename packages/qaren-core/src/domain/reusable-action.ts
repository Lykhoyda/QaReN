// D1206 Tier 2 Sprint C / Phase 127 — ReusableAction domain entity.
//
// Single source of truth for L3 reusable actions: the immutable contract
// (M7 metadata header in the YAML), the mutable runtime state (sidecar
// JSON), and the lifecycle transitions between them.
//
// YAML stays in <project>/.qaren/actions; mutable state follows the current
// session state directory, with .qaren/state as the unfenced fallback.
//
// This file is the ONLY place that defines the schema. Emitters
// (test-recorder-generators, maestro-generate), parsers (learned-actions),
// and runtime tools (run-action, future self-repair) all import from here.
// Schema drift becomes a compile error.

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle + classification enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Action lifecycle. Transitions:
 *   experimental → active        when first replay passes clean
 *   active → experimental         when self-repair patches the YAML
 *                                 (re-validation needed before re-promotion)
 *   * → deprecated                manual archival; do NOT auto-route or replay
 */
export type ActionLifecycle = 'experimental' | 'active' | 'deprecated';

/**
 * Failure codes returned by /run-action. Drives the recovery path:
 *   SELECTOR_NOT_FOUND   → repair-eligible (UI drift, L3→L2 self-repair)
 *   STATE_MISMATCH       → real regression (escalate to user / debug session)
 *   MUTATE_PRECONDITION  → state setup needed (e.g. user not logged in)
 *   ENV_UNREACHABLE      → app/CDP/Metro down (out-of-band)
 *   TIMEOUT              → flaky (flag for review; bounded retries)
 *   UNKNOWN              → un-classified Maestro error (surface raw stderr)
 */
export type ActionFailureCode =
  | 'SELECTOR_NOT_FOUND'
  // GH #186: the live route diverged from the action's expectedRouteSequence
  // (a screen was inserted/changed) — structural drift, distinct from selector
  // churn, so it must NOT trigger fuzzy selector repair.
  | 'ROUTE_DRIFT'
  | 'STATE_MISMATCH'
  | 'MUTATE_PRECONDITION_FAILED'
  | 'ENV_UNREACHABLE'
  | 'TIMEOUT'
  | 'WDA_BOOTSTRAP_FAILED'
  | 'NATIVE_SURFACE_BLIND'
  // Exact active-session target differed from direct maestro-runner/WDA evidence.
  | 'DEVICE_AUTHORITY_MISMATCH'
  // GH #317 Phase 2: a CDP/JS transport-blind replay ran and the flow failed —
  // distinct from a generic UNKNOWN error so run-history/MTTR can tell them apart.
  | 'TRANSPORT_BLIND'
  // GH #397 Phase 2: a PROBE-ROUTED CDP/JS replay failed. Maestro was never
  // attempted, so no transport blindness was observed — the failure may be app
  // drift or a stale anchor. Non-decisive for the blind-probe latch (it must
  // not self-sustain).
  | 'FALLBACK_REPLAY_FAILED'
  | 'UNKNOWN';

/**
 * Author of the action — drives diff-noise expectations and trust.
 *   auto      — emitted by L2→L3 auto-emission (LLM walk → cdp_record_test_save)
 *   human     — hand-authored YAML
 *   imported  — landed from a foreign corpus (foreign provenance)
 */
export type ActionAuthor = 'auto' | 'human' | 'imported';

// ─────────────────────────────────────────────────────────────────────────────
// M7 metadata — IMMUTABLE contract, lives in the YAML header
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The M7 metadata header (D1203). Lives as `# key: value` comments above
 * the Maestro YAML body; the YAML executor ignores them but
 * learned-actions.ts (dist/learned-actions.js) and the run-action pre-flight parse them.
 *
 * Required: id, intent, status. The rest are optional.
 */
export interface M7Metadata {
  /**
   * Stable slug. Default: filename without `.yaml`. Set explicitly only
   * when you want to rename the file later without breaking references
   * to the action.
   */
  id: string;

  /** Human-readable goal. Surfaced verbatim by /list-learned-actions. */
  intent: string;

  /**
   * Filterable lower-case kebab-case keywords. Conventions:
   *   feature-area: tasks, auth, profile
   *   operation:    create, update, delete, search
   *   markers:      smoke, regression
   */
  tags?: string[];

  /**
   * `true` if the flow leaves persistent residue (created/deleted rows,
   * toggled settings, anything a subsequent test would need to clean
   * up). Read-only flows are `false`. Consumed by /run-action to require
   * confirmation before replay.
   */
  mutates?: boolean;

  status: ActionLifecycle;

  /**
   * `${VAR}` placeholders the YAML expects via -e KEY=VAL when running
   * via the maestro-runner CLI. Auto-extracted from the body if absent.
   */
  params?: string[];

  /**
   * App bundle ID this action was authored against. Pre-flight rejects
   * replay if the connected target's bundleId differs. Optional but
   * strongly recommended for cross-app safety.
   */
  appId?: string;

  /**
   * ISO timestamp of action creation. Optional — older flows may not
   * carry this; in that case fall back to file ctime.
   */
  createdAt?: string;

  author?: ActionAuthor;

  /**
   * D1209 — state postconditions this action establishes when it runs
   * cleanly. A flat map of primitive-valued state assertions (e.g.
   * `{ authenticated: true, route: 'home' }`). Used by the agent for
   * hybrid composition: when the user's task requires a state the
   * current app doesn't satisfy, the agent scans for an action whose
   * `produces` covers the gap and replays it as a deterministic
   * prologue before continuing with interactive tools.
   *
   * Optional — actions without `produces` continue to work; the agent
   * falls back to intent-string matching for them.
   *
   * v1 supports primitive values only (string | number | boolean).
   * The inline YAML serialization rules out commas + newlines inside
   * values.
   */
  produces?: Record<string, string | number | boolean>;

  /**
   * GH #186 — ordered list of screen/route names this action walked when it was
   * recorded (captured from nav events at save_as_action time). run-action uses
   * it for structural drift detection: a pre-flight check against the live nav
   * graph (definite-mismatch fail-fast) and a post-failure check that
   * reclassifies a SELECTOR_NOT_FOUND as ROUTE_DRIFT when the live route is off
   * this sequence (a screen was inserted). Optional — actions without it skip
   * the drift checks.
   */
  expectedRouteSequence?: string[];
  /** `maestro-runner@<semver>`; replay refuses any other value. */
  enginePin?: string;
  /** Slug of the plan block this action was discovered from. */
  plan?: string;
  planHash?: string;
  platform?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime state — MUTABLE, lives in the sidecar JSON
// ─────────────────────────────────────────────────────────────────────────────

/** Why an auto-repair was refused (when `autoRepair.outcome === 'refused'`). */
export type AutoRepairRefusedReason =
  | 'BUDGET_EXHAUSTED'
  | 'EXTERNAL_EDIT'
  | 'NO_MATCH'
  | 'SNAPSHOT_FAILED'
  | 'NOT_REPAIRABLE_KIND'
  | 'WDA_BOOTSTRAP'
  // GH #186: refused because the failure was structural route-drift, not a
  // stale selector — fuzzy repair would be wrong here.
  | 'ROUTE_DRIFT'
  // PR #115 multi-LLM review: distinguish user-driven opt-outs from
  // genuine refusals so MTTR analysis (#105) can see "user disabled
  // repair" as operationally healthy vs. budget/edit/match refusals.
  | 'USER_DISABLED'
  // GH #317: rn-fast-runner saw the selector but Maestro/WDA reported it not
  // visible (empty a11y tree). A transport limitation, not testID drift —
  // repair is correctly refused and replay is blocked on this runtime.
  | 'TRANSPORT_BLIND'
  // Internal/unexpected: parseEnvelope failed, repair-action returned
  // an unmapped error code, or the orchestrator hit a defensive path.
  // Keep separate from NO_MATCH so MTTR doesn't conflate transport
  // bugs with "screen state legitimately doesn't have the testID".
  | 'INTERNAL_ERROR';

/**
 * Phase-level timing breakdown for an auto-repair attempt. Issue #120:
 * MTTR analysis (#105) needs to distinguish "fast detection + slow
 * repair" from "slow detection + fast repair" — the orchestration's
 * total `RunRecord.durationMs` collapses both, so we surface each phase
 * here. All fields optional so plain `maestro_run` calls outside the
 * orchestrator (which don't go through these phases) still produce
 * valid RunRecords.
 */
export interface AutoRepairPhases {
  /** Time from orchestration start until first maestro_run returned. */
  firstAttemptMs: number;
  /** Time from first-attempt fail until repair handler returned (snapshot + match + saveAction). */
  repairMs?: number;
  /** Time from repair-patched until retry maestro_run returned. */
  retryMs?: number;
}

/**
 * Outcome of an auto-repair attempt orchestrated by `cdp_run_action`.
 * Embedded in RunRecord so MTTR analysis (#105) can classify cleanly.
 */
export interface AutoRepairOutcome {
  /** Did the orchestrator reach the repair step at all? */
  attempted: boolean;
  /** What happened: passed / failed / refused (skipped / never tried). */
  outcome: 'passed' | 'failed' | 'refused' | 'skipped';
  /** Populated when outcome === 'refused' or 'skipped'. */
  refusedReason?: AutoRepairRefusedReason;
  /**
   * Populated when outcome === 'passed' or 'failed' — what got patched.
   * Issue #120 extension: optional `score` from the fuzzy-match engine.
   * (cdp_repair_action already returns this; we now pipe it through.)
   */
  diff?: {
    selector: {
      from: string;
      to: string;
      /** Levenshtein-derived similarity score 0..1 returned by the repair engine. */
      score?: number;
    };
  };
  /**
   * Phase-level timing breakdown. Issue #120: MTTR experiments need
   * this to compute "median seconds saved" and to spot pathological
   * phase distributions (e.g. a slow snapshot dominating repair time).
   */
  phases?: AutoRepairPhases;
  /**
   * ISO timestamp linking this AutoRepairOutcome to the matching
   * RepairRecord in `state.repairHistory`. RepairRecord.timestamp is
   * the natural primary key — no separate id field. Populated only
   * when outcome === 'passed' or 'failed' (i.e. a repair actually ran
   * and emitted a RepairRecord).
   */
  repairTimestamp?: string;
  /**
   * GH #119: when outcome === 'failed' AND the post-repair retry failed
   * on a DIFFERENT selector than the one just patched, record it here
   * so MTTR analysis can distinguish "patch didn't work" from
   * "cascading failure — patch worked, next selector broke." Absent
   * when the retry failed on the same selector or didn't run.
   */
  nextFailedSelector?: string;
}

/** A single replay attempt's outcome. Append-only; oldest dropped at limit. */
export interface RunRecord {
  /** Bounded closed-vocabulary projection of runner failures; text, images, and terminal output are withheld. */
  runnerFailureEvidence?: import('./runner-failure-evidence.js').RunnerFailureEvidence;
  /** Unique replay identity, used to prove that a prologue produced a fresh record. */
  runId?: string;
  timestamp: string; // ISO
  durationMs: number;
  status: 'pass' | 'fail';
  failureCode?: ActionFailureCode;
  failureDetail?: string; // raw stderr summary, max ~500 chars
  trigger: 'agent' | 'ci' | 'human';
  /**
   * Populated by `cdp_run_action` when auto-repair was either attempted
   * or considered. Absent on plain `maestro_run` calls outside the
   * run-action orchestrator.
   */
  autoRepair?: AutoRepairOutcome;
  /**
   * GH #623: ledger-derived qualifier — present only when the canonical run
   * ledger proved every authored mutation and only trailing verification
   * failed. The run stays status 'fail'; this block preserves the distinction.
   */
  trailingVerification?: import('./maestro-run-ledger.js').TrailingVerificationQualifier;
  /** React-tree transport passes never promote an action to Maestro-certified active. */
  transport?: 'cdp-js';
  proofDomain?: 'react-tree' | 'xctest-native' | 'partitioned';
  /** GH #397: simulator UDID / device serial the run targeted (additive, optional). */
  deviceId?: string;
  /** GH #397 Phase 2: set when the proactive blind-probe routed this run. */
  blindProbe?: { atRisk: 'ios26' | 'prior-transport-blind'; skippedMaestro: boolean };
  /** Wall-clock orchestration phases for separating agent overhead from replay time. */
  timing?: {
    startedAt: string;
    endedAt: string;
    elapsedMs: number;
    steps: Array<{
      name: string;
      startedAt: string;
      endedAt: string;
      elapsedMs: number;
    }>;
  };
}

/** A single self-repair attempt (only emitted on successful repair). */
export interface RepairRecord {
  timestamp: string;
  failureCode: ActionFailureCode;
  /** Concrete change made. Only fields that changed are populated. */
  diff: {
    selector?: { from: string; to: string };
    step?: { from: string; to: string };
  };
  durationMs: number;
  /** Free-form one-liner the agent recorded; max ~200 chars. */
  agentReasoning?: string;
}

export interface ActionStats {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  /** Mean duration over successful runs only. */
  avgDurationMs: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

/** High-churn sidecar JSON stored in the current session state directory. */
export interface ActionRuntimeState {
  /** Schema version — bump when ActionRuntimeState shape changes. */
  schemaVersion: 1;
  /** Incremented on every YAML edit (manual or auto-repair). */
  revision: number;
  updatedAt: string;
  /**
   * Last YAML mtime the agent saw. Used to detect human-edits-since-
   * last-write and abort auto-repair before clobbering them.
   */
  lastSeenMtimeMs: number;
  runHistory: RunRecord[];
  repairHistory: RepairRecord[];
  stats: ActionStats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite — the full entity loaded at runtime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full `ReusableAction` — composed from disk at load time by
 * combining the YAML header + body with the sidecar JSON.
 *
 * Consumers should treat `metadata` and `body` as immutable for the
 * lifetime of an in-memory copy; mutating means rewriting the YAML.
 * `state` is the only mutable field — all updates go through the
 * helpers below to ensure schema invariants.
 */
export interface ReusableAction {
  metadata: M7Metadata;
  body: string; // raw YAML body, post-header
  filePath: string; // absolute path to the .yaml
  state: ActionRuntimeState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded constants (single source for repair budgets, history limits)
// ─────────────────────────────────────────────────────────────────────────────

export const REPAIR_BUDGET = {
  /** Max successful self-repairs allowed in a rolling 24h window. */
  ATTEMPTS_PER_24H: 3,
  /** Max repair attempts per run before escalating to user. */
  ATTEMPTS_PER_RUN: 1,
} as const;

export const HISTORY_LIMITS = {
  /** Cap runHistory at this many records; oldest dropped on append. */
  RUN_HISTORY_MAX: 50,
  /** Cap repairHistory at this many records; oldest dropped on append. */
  REPAIR_HISTORY_MAX: 25,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure constructors + transitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an empty runtime state for a brand-new action. Caller passes the
 * file's mtime so subsequent edits-vs-self-repair detection works.
 */
export function freshRuntimeState(
  now: () => Date = () => new Date(),
  mtimeMs: number = 0,
): ActionRuntimeState {
  const ts = now().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    updatedAt: ts,
    lastSeenMtimeMs: mtimeMs,
    runHistory: [],
    repairHistory: [],
    stats: {
      totalRuns: 0,
      successCount: 0,
      failureCount: 0,
      avgDurationMs: 0,
    },
  };
}

/**
 * Append a RunRecord and recompute stats. Bounded by HISTORY_LIMITS.
 * Pure function — caller persists the returned state.
 */
export function appendRunRecord(state: ActionRuntimeState, record: RunRecord): ActionRuntimeState {
  const newHistory = [...state.runHistory, record];
  while (newHistory.length > HISTORY_LIMITS.RUN_HISTORY_MAX) newHistory.shift();

  const totalRuns = state.stats.totalRuns + 1;
  const successCount = state.stats.successCount + (record.status === 'pass' ? 1 : 0);
  const failureCount = state.stats.failureCount + (record.status === 'fail' ? 1 : 0);

  // Recompute avg over successful records only.
  const successDurations = newHistory.filter((r) => r.status === 'pass').map((r) => r.durationMs);
  const avgDurationMs = successDurations.length
    ? Math.round(successDurations.reduce((s, n) => s + n, 0) / successDurations.length)
    : state.stats.avgDurationMs;

  return {
    ...state,
    updatedAt: record.timestamp,
    runHistory: newHistory,
    stats: {
      totalRuns,
      successCount,
      failureCount,
      avgDurationMs,
      lastSuccessAt: record.status === 'pass' ? record.timestamp : state.stats.lastSuccessAt,
      lastFailureAt: record.status === 'fail' ? record.timestamp : state.stats.lastFailureAt,
    },
  };
}

/**
 * Append a RepairRecord, bump revision. Bounded by HISTORY_LIMITS.
 * Caller is responsible for actually patching the YAML body separately
 * — this only updates the runtime state.
 */
export function appendRepairRecord(
  state: ActionRuntimeState,
  record: RepairRecord,
): ActionRuntimeState {
  const newHistory = [...state.repairHistory, record];
  while (newHistory.length > HISTORY_LIMITS.REPAIR_HISTORY_MAX) newHistory.shift();
  return {
    ...state,
    updatedAt: record.timestamp,
    revision: state.revision + 1,
    repairHistory: newHistory,
  };
}

/**
 * Check whether a self-repair attempt is within the rolling-24h budget.
 * Pure function — `now` is injectable for tests.
 */
export function recentRepairCount(
  state: ActionRuntimeState,
  now: () => Date = () => new Date(),
): number {
  const cutoff = now().getTime() - 24 * 60 * 60 * 1000;
  return state.repairHistory.filter((r) => new Date(r.timestamp).getTime() >= cutoff).length;
}

export function repairBudgetAvailable(
  state: ActionRuntimeState,
  now: () => Date = () => new Date(),
): boolean {
  return recentRepairCount(state, now) < REPAIR_BUDGET.ATTEMPTS_PER_24H;
}

/**
 * Promote `experimental → active` after a clean replay.
 * Used by /run-action when an experimental flow passes; also used after
 * a self-repair's verification replay succeeds.
 */
export function shouldAutoPromoteToActive(
  metadata: M7Metadata,
  lastRun: RunRecord | undefined,
): boolean {
  if (
    lastRun?.transport === 'cdp-js' ||
    lastRun?.proofDomain === 'react-tree' ||
    lastRun?.proofDomain === 'partitioned'
  )
    return false;
  return metadata.status === 'experimental' && lastRun?.status === 'pass';
}

/**
 * Demote `active → experimental` after a self-repair patches the body.
 * Forces a re-validation pass before treating the flow as production-quality
 * again.
 */
export function shouldDemoteAfterRepair(metadata: M7Metadata): boolean {
  return metadata.status === 'active';
}

// ─────────────────────────────────────────────────────────────────────────────
// M7 header parsing/serialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the M7 metadata block from a YAML file's header — the comment
 * lines above the body that look like `# key: value`. Robust to extra
 * whitespace and missing fields. Returns null if no `id` or `intent` is
 * found (the two required keys).
 *
 * Pure function — pass the file's text. Mirrors the parsing rules in
 * so they stay in sync.
 */
export function parseM7Header(yamlText: string, fallbackId?: string): M7Metadata | null {
  const lines = yamlText.split('\n');
  const meta: Record<string, unknown> = {};
  let inComment = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      inComment = true;
      const stripped = line.replace(/^#\s?/, '').trim();
      if (!stripped) continue;
      const kv = stripped.match(/^([a-zA-Z][\w-]*)\s*:\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1];
      const raw = kv[2].trim();
      if (key === 'tags') {
        meta.tags = raw
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      } else if (key === 'mutates') {
        meta.mutates = /^true$/i.test(raw);
      } else if (key === 'params') {
        meta.params = raw
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      } else if (key === 'produces') {
        meta.produces = parseProducesMap(raw);
      } else if (key === 'expectedRouteSequence') {
        meta.expectedRouteSequence = raw
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      } else if (
        key === 'id' ||
        key === 'intent' ||
        key === 'status' ||
        key === 'appId' ||
        key === 'createdAt' ||
        key === 'author' ||
        key === 'enginePin' ||
        key === 'plan' ||
        key === 'planHash' ||
        key === 'platform'
      ) {
        meta[key] = raw;
      }
    } else if (inComment && line.trim() === '') {
      // First blank line after a comment block — stop parsing header.
      if (Object.keys(meta).length > 0) break;
    } else if (inComment) {
      break;
    }
  }
  const id = (meta.id as string) ?? fallbackId;
  const intent = meta.intent as string | undefined;
  if (!id || !intent) return null;
  const status = (meta.status as ActionLifecycle | undefined) ?? 'experimental';
  return {
    id,
    intent,
    tags: meta.tags as string[] | undefined,
    mutates: meta.mutates as boolean | undefined,
    status,
    params: meta.params as string[] | undefined,
    appId: meta.appId as string | undefined,
    createdAt: meta.createdAt as string | undefined,
    author: meta.author as ActionAuthor | undefined,
    produces: meta.produces as Record<string, string | number | boolean> | undefined,
    expectedRouteSequence: meta.expectedRouteSequence as string[] | undefined,
    enginePin: meta.enginePin as string | undefined,
    ...(meta.plan ? { plan: meta.plan as string } : {}),
    ...(meta.planHash ? { planHash: meta.planHash as string } : {}),
    ...(meta.platform ? { platform: meta.platform as string } : {}),
  };
}

/**
 * D1209 — parse the inline `produces` map: `{ key: value, key: value }`.
 * Values are typed as boolean (`true`/`false`), number (digits + optional
 * dot + optional sign), or string (everything else, with surrounding
 * single/double quotes stripped). Returns undefined when the input is
 * empty or ANY segment is malformed (GH #525) so the caller can omit
 * the field rather than carry a half-parsed object. Single-line only;
 * commas + newlines inside values are not supported in v1.
 */
function parseProducesMap(raw: string): Record<string, string | number | boolean> | undefined {
  const inner = raw
    .trim()
    .replace(/^\{|\}$/g, '')
    .trim();
  if (!inner) return undefined;
  const result: Record<string, string | number | boolean> = {};
  for (const part of inner.split(',')) {
    const kv = part.match(/^\s*([a-zA-Z_][\w.-]*)\s*:\s*(.+?)\s*$/);
    if (!kv) return undefined;
    const key = kv[1];
    const valueRaw = kv[2].trim();
    if (/^(true|false)$/i.test(valueRaw)) {
      result[key] = /^true$/i.test(valueRaw);
    } else if (/^-?\d+(\.\d+)?$/.test(valueRaw)) {
      result[key] = Number(valueRaw);
    } else {
      result[key] = valueRaw.replace(/^['"]|['"]$/g, '');
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Serialize an M7Metadata object as YAML comment lines. Output is
 * suitable for prepending to a Maestro YAML body. Stable field order.
 */
export function serializeM7Header(metadata: M7Metadata): string {
  const lines: string[] = [];
  const stripNewlines = (s: string) => String(s).replace(/[\r\n]+/g, ' ');
  lines.push(`# id: ${stripNewlines(metadata.id)}`);
  lines.push(`# intent: ${stripNewlines(metadata.intent)}`);
  if (metadata.tags && metadata.tags.length) {
    lines.push(`# tags: [${metadata.tags.map(stripNewlines).join(', ')}]`);
  }
  if (typeof metadata.mutates === 'boolean') {
    lines.push(`# mutates: ${metadata.mutates}`);
  }
  if (metadata.status) lines.push(`# status: ${stripNewlines(metadata.status)}`);
  if (metadata.enginePin) lines.push(`# enginePin: ${stripNewlines(metadata.enginePin)}`);
  if (metadata.params && metadata.params.length) {
    lines.push(`# params: [${metadata.params.map(stripNewlines).join(', ')}]`);
  }
  if (metadata.appId) lines.push(`# appId: ${stripNewlines(metadata.appId)}`);
  if (metadata.createdAt) lines.push(`# createdAt: ${stripNewlines(metadata.createdAt)}`);
  if (metadata.author) lines.push(`# author: ${stripNewlines(metadata.author)}`);
  if (metadata.produces && Object.keys(metadata.produces).length > 0) {
    const pairs = Object.keys(metadata.produces)
      .sort()
      .map((k) => {
        const v = metadata.produces![k];
        const formatted = typeof v === 'string' ? stripNewlines(v) : String(v);
        return `${k}: ${formatted}`;
      });
    lines.push(`# produces: { ${pairs.join(', ')} }`);
  }
  if (metadata.expectedRouteSequence && metadata.expectedRouteSequence.length) {
    lines.push(
      `# expectedRouteSequence: [${metadata.expectedRouteSequence.map(stripNewlines).join(', ')}]`,
    );
  }
  return lines.join('\n');
}
