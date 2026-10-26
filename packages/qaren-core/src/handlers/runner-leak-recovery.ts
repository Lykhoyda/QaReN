import { sleep as cancellableSleep } from '../domain/cancellation.js';
import type { ToolResult } from '../utils.js';

export interface RunnerLeakNode {
  ref?: string;
  label?: string;
  identifier?: string;
  type?: string;
}

const RUNNER_APP_LABEL = 'AgentDeviceRunner';
const RUNNER_VISIBLE_TEXT = 'Agent Device Runner';
const RUNNER_FINGERPRINT_IDENTIFIERS = new Set(['Logo', 'PoweredBy']);
const SMALL_TREE_THRESHOLD = 12;

/**
 * B119/GH#35: detect when an iOS snapshot returned AgentDeviceRunner's own UI
 * tree instead of the session's target app. This happens when the agent-device
 * daemon dispatches a command to the Swift runner without `appBundleId`,
 * causing RunnerTests+CommandExecution.swift:111-122 to clear `currentApp`
 * and activate the runner itself. Snapshot succeeds but returns the wrong
 * tree (~6 nodes including the runner's splash UI).
 *
 * Heuristic — both must hold:
 *   1. Tree is small (<= 12 nodes) — real app trees are larger.
 *   2. Either: any node label === "AgentDeviceRunner" (the Application node),
 *      OR (visible "Agent Device Runner" text AND a fingerprint identifier).
 *
 * The double-check guards against rare false positives where a real app
 * happens to contain the literal string "AgentDeviceRunner" but has many
 * other elements.
 */
export function isAgentDeviceRunnerSentinel(nodes: RunnerLeakNode[] | null | undefined): boolean {
  if (!nodes || nodes.length === 0) return false;
  if (nodes.length > SMALL_TREE_THRESHOLD) return false;

  const hasRunnerAppLabel = nodes.some((n) => n.label === RUNNER_APP_LABEL);
  if (hasRunnerAppLabel) return true;

  const hasVisibleText = nodes.some((n) => n.label === RUNNER_VISIBLE_TEXT);
  const hasFingerprintId = nodes.some(
    (n) => n.identifier !== undefined && RUNNER_FINGERPRINT_IDENTIFIERS.has(n.identifier),
  );
  return hasVisibleText && hasFingerprintId;
}

export interface RecoveryContext {
  platform?: string;
  appId?: string;
  deviceId?: string;
  sessionName?: string;
  alreadyRecovered?: boolean;
}

export interface OpenSessionArgs {
  appId: string;
  platform: string;
  deviceId?: string;
  sessionName?: string;
  attachOnly: boolean;
}

export interface RecoveryDeps {
  closeSession: () => Promise<ToolResult>;
  openSession: (args: OpenSessionArgs) => Promise<ToolResult>;
  resnapshot: () => Promise<ToolResult>;
  parseNodes: (result: ToolResult) => RunnerLeakNode[] | null;
  sleep?: (ms: number) => Promise<void>;
  /**
   * GH #186: non-destructive reacquire — re-foreground the TARGET app via the
   * fast-runner (stopFastRunner → ensureFastRunner → activate) WITHOUT closing
   * the session or relaunching the app. When supplied, it's tried first: both
   * the daemon-leak and the maestro-eviction case surface as the same sentinel,
   * so rather than distinguishing them we attempt a cheap state-preserving
   * reacquire and only fall through to the destructive tiers if it doesn't
   * clear the sentinel. Optional so non-iOS / older callers are unaffected.
   */
  reacquire?: () => Promise<ToolResult>;
}

const DAEMON_SETTLE_MS = 600;

const defaultSleep = cancellableSleep;

export type RecoveryTier = 'reacquire' | 'attach-only' | 'full-relaunch';

export interface RecoveryOutcome {
  recovered: boolean;
  result: ToolResult;
  tier?: RecoveryTier;
  reason?:
    | 'no-session-context'
    | 'wrong-platform'
    | 'already-attempted'
    | 'still-sentinel'
    | 'reopen-failed';
}

/**
 * Recover by exact native reacquisition, then attach-only reopen, and only
 * then a state-destructive full relaunch.
 */
export async function recoverFromRunnerLeak(
  ctx: RecoveryContext,
  deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
  if (ctx.alreadyRecovered) {
    return { recovered: false, result: emptyResult(), reason: 'already-attempted' };
  }
  if ((ctx.platform ?? 'ios').toLowerCase() !== 'ios') {
    return { recovered: false, result: emptyResult(), reason: 'wrong-platform' };
  }
  if (!ctx.appId) {
    return { recovered: false, result: emptyResult(), reason: 'no-session-context' };
  }

  const sleep = deps.sleep ?? defaultSleep;

  // Tier 0 (GH #186): non-destructive reacquire — re-foreground the target app
  // via the fast-runner WITHOUT closing the session or relaunching. Most
  // state-preserving and fastest; strictly additive (falls through to the
  // existing tiers if it doesn't clear the sentinel).
  if (deps.reacquire) {
    const tier0 = await attemptReacquireCycle(deps, sleep);
    if (tier0.phase === 'success') {
      return { recovered: true, result: tier0.result, tier: 'reacquire' };
    }
  }

  // Tier 1: attachOnly reopen — preserves app state when it works.
  const tier1 = await attemptRecoveryCycle(ctx, deps, true, sleep);
  if (tier1.phase === 'success') {
    return { recovered: true, result: tier1.result, tier: 'attach-only' };
  }

  // Tier 2: full app relaunch — destructive but establishes fresh app state.
  const tier2 = await attemptRecoveryCycle(ctx, deps, false, sleep);
  if (tier2.phase === 'success') {
    return { recovered: true, result: tier2.result, tier: 'full-relaunch' };
  }

  if (tier2.phase === 'sentinel') {
    return { recovered: false, result: tier2.result, reason: 'still-sentinel' };
  }
  return { recovered: false, result: tier2.result, reason: 'reopen-failed' };
}

interface RecoveryCycleResult {
  phase: 'reopen-failed' | 'snapshot-failed' | 'sentinel' | 'success';
  result: ToolResult;
}

async function attemptReacquireCycle(
  deps: RecoveryDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<RecoveryCycleResult> {
  const reacqResult = await deps.reacquire!();
  if (reacqResult.isError) {
    return { phase: 'reopen-failed', result: reacqResult };
  }
  await sleep(DAEMON_SETTLE_MS);
  const retryResult = await deps.resnapshot();
  if (retryResult.isError) {
    return { phase: 'snapshot-failed', result: retryResult };
  }
  if (isAgentDeviceRunnerSentinel(deps.parseNodes(retryResult))) {
    return { phase: 'sentinel', result: retryResult };
  }
  return { phase: 'success', result: retryResult };
}

async function attemptRecoveryCycle(
  ctx: RecoveryContext,
  deps: RecoveryDeps,
  attachOnly: boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<RecoveryCycleResult> {
  await deps.closeSession();
  await sleep(DAEMON_SETTLE_MS);

  const reopenResult = await deps.openSession({
    appId: ctx.appId!,
    platform: 'ios',
    ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {}),
    sessionName: ctx.sessionName,
    attachOnly,
  });
  if (reopenResult.isError) {
    return { phase: 'reopen-failed', result: reopenResult };
  }

  const retryResult = await deps.resnapshot();
  if (retryResult.isError) {
    return { phase: 'snapshot-failed', result: retryResult };
  }

  if (isAgentDeviceRunnerSentinel(deps.parseNodes(retryResult))) {
    return { phase: 'sentinel', result: retryResult };
  }
  return { phase: 'success', result: retryResult };
}

function emptyResult(): ToolResult {
  return { content: [{ type: 'text' as const, text: '' }] };
}
