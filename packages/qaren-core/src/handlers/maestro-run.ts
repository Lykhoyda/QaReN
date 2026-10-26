import {
  captureRunnerFailure,
  createRunnerFailureEvidence,
  type RunnerFailureEvidence,
} from '../domain/runner-failure-evidence.js';
import { execFile as execFileCb } from '../domain/cancellation.js';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import {
  getEngineStatus,
  enginePinCaveat,
  exactPinRefusal,
  withImmediatePinnedRunner,
  preOAndroidApiRefusal,
  isOlderSdkInstallFailure,
  olderSdkInstallDiagnosis,
  MAESTRO_RUNNER_MIN_ANDROID_API,
  RunnerCacheUnavailableError,
  runnerCacheBootstrapFailure,
  type ReplayEngineStatus,
} from '../domain/engine-pin.js';
import { recordRunnerDiagnostic } from '../domain/runner-diagnostics.js';
import {
  actionReplayRefusal,
  classifyLearnedActionPath,
  replayCompatibilityRefusal,
} from '../domain/action-engine-compat.js';
import { parseM7Header, type M7Metadata } from '../domain/reusable-action.js';
import { captureActionFromPath, type CapturedActionReplay } from '../domain/action-store.js';
import { attachMeta, getActiveSession } from '../agent-device-wrapper.js';
import { resolveBundleId, readExpoSlug } from '../project-config.js';
import {
  chooseMaestroDispatch,
  shouldWarnFallback,
  flowContainsHideKeyboard,
  type MaestroDispatchInputs,
} from './maestro-dispatch.js';
import { flowUsesClearState, resolveAppFileForClearState } from './resolve-ios-app-file.js';
import {
  buildMaestroFlow,
  parseAndValidateFlow,
  isValidBundleId,
  MaestroValidationError,
} from '../domain/maestro-validator.js';
import { outputIndicatesFlowFailure } from '../domain/maestro-error-parser.js';
import { parseMaestroFailure } from '../domain/maestro-error-parser.js';
import {
  augmentFailureWithDegradation,
  formatRuntimeDegradedHint,
  resolveFloorMs,
  runtimeDegradationFromMetadata,
} from '../domain/tap-latency.js';
import {
  buildStepSummary,
  buildTerminalEvidence,
  classifyExecError,
  combineRunnerOutput,
  formatFailureHeadline,
  type ReasonSummary,
} from '../domain/maestro-step-parser.js';
import {
  fastHealthCheck as defaultFastHealthCheck,
  stopFastRunner as defaultStopFastRunner,
} from '../runners/rn-fast-runner-client.js';
import {
  ExactAndroidDeviceRequiredError,
  releaseAndroidInteractionSlot as defaultReleaseAndroidSlot,
} from '../runners/release-android-slot.js';
import { markCdpStale as defaultMarkCdpStale } from '../cdp/recovery.js';
import {
  maestroAuthorityRefusal,
  sameDevice,
  verifyMaestroDeviceAuthority,
} from '../domain/maestro-device-authority.js';
import {
  collectDirectRunnerEvidence,
  createRunnerReportDir,
  disposeRunnerReportDir,
  readStructuredFlowArtifact,
  runnerReportArgs,
  runnerReportFingerprint,
} from '../domain/maestro-runner-report.js';
import {
  buildMaestroRunLedger,
  classifyTrailingVerification,
  type LedgerAttemptInput,
  type LedgerInvocationTermination,
  type LedgerStageCaptureInput,
} from '../domain/maestro-run-ledger.js';
import { randomUUID } from 'node:crypto';
import type { SessionState } from '../types.js';
import { SessionAuthorityError, isProvenMetroOriginMismatch } from '../domain/authority-error.js';

export interface ManagedNativeOriginReproveOptions {
  readinessTimeoutMs?: number;
  signal?: AbortSignal;
}
import {
  planIosProofDomains,
  loginPostconditionId,
  nativeCommandMayChangeFocus,
  nativeSelectorsForCommands,
  soleComparableNativeSelectorForCommands,
  type NativeProofSelector,
} from '../domain/ios-proof-router.js';
import { runCdpReplayCommands, type CdpReplayDeps } from './cdp-replay-dispatch.js';
import type { ToolErrorCode } from '../types.js';

const defaultExecFile = promisify(execFileCb);

export interface AndroidSlotReleaseOutcome {
  deviceId?: string;
  warnings?: string[];
}

export interface FlowParkOpts {
  platform?: 'ios' | 'android';
  deviceId?: string;
  stopFastRunner?: (deviceId?: string, signal?: AbortSignal) => void | Promise<void>;
  markCdpStale?: () => void;
  releaseAndroidSlot?: (opts: {
    deviceId?: string;
    includeLegacy?: boolean;
    signal?: AbortSignal;
  }) => Promise<AndroidSlotReleaseOutcome | void>;
  onAndroidRelease?: (outcome: AndroidSlotReleaseOutcome | void) => void;
  completeRunnerPark?: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * GH#202 Phase 2a + GH#237: run a Maestro flow with L2 parked. iOS stops the
 * fast-runner (XCTest); Android releases the single UiAutomation slot (our
 * runner's instrumentation would otherwise block maestro-runner's UIAutomator2
 * server — #237). Mark CDP stale afterward (always — even on failure) so the
 * next read reconnects to post-flow state. The L2 runner lazily restarts on the
 * next device_* call. MUST run inside the held arbiter `flow` lease.
 */
export async function runFlowParked<T>(run: () => Promise<T>, opts: FlowParkOpts = {}): Promise<T> {
  const stale = opts.markCdpStale ?? defaultMarkCdpStale;
  const platform = opts.platform === 'android' ? 'android' : 'ios';
  try {
    recordRunnerDiagnostic('flow-park', { phase: 'begin', platform });
    if (opts.platform === 'android') {
      const release = opts.releaseAndroidSlot ?? defaultReleaseAndroidSlot;
      const outcome = opts.signal
        ? await release({ deviceId: opts.deviceId, signal: opts.signal })
        : await release({ deviceId: opts.deviceId });
      opts.onAndroidRelease?.(outcome);
    } else {
      if (opts.signal) {
        await (opts.stopFastRunner ?? defaultStopFastRunner)(opts.deviceId, opts.signal);
      } else {
        await (opts.stopFastRunner ?? defaultStopFastRunner)(opts.deviceId);
      }
    }
    recordRunnerDiagnostic('flow-park', { phase: 'released', platform });
    if (opts.completeRunnerPark) {
      if (opts.signal) await opts.completeRunnerPark(opts.signal);
      else await opts.completeRunnerPark();
      recordRunnerDiagnostic('flow-park', { phase: 'committed', platform });
    }
    return await run();
  } finally {
    stale();
  }
}

/**
 * Splice `-e KEY=VALUE` param pairs in just before the flow file. Both runners
 * treat args trailing the flow file as additional flow files (maestro-runner
 * then `stat`s `-e`/`KEY=VALUE` as paths and aborts), so params MUST precede
 * it. `buildArgs` always emits the flow file last.
 */
export function assembleMaestroArgs(baseArgs: string[], paramArgs: string[]): string[] {
  if (paramArgs.length === 0) return baseArgs;
  return [...baseArgs.slice(0, -1), ...paramArgs, baseArgs[baseArgs.length - 1]];
}

export interface MaestroRunArgs {
  flowPath?: string;
  inlineYaml?: string;
  actionMetadata?: Pick<M7Metadata, 'id' | 'enginePin' | 'tags' | 'expectedRouteSequence'>;
  platform?: 'ios' | 'android';
  appId?: string;
  appFile?: string;
  /** Exact UDID/serial. Android may fall back to an explicit ANDROID_SERIAL. */
  deviceId?: string;
  timeoutMs?: number;
  /**
   * GH #116: per-flow parameter bindings forwarded as `-e KEY=VALUE`
   * pairs to the maestro-runner subprocess. Keys must match
   * /^[A-Z_][A-Z0-9_]*$/ (Maestro's documented env-style convention) —
   * any other key shape is refused so a malformed/hostile payload can't
   * become a shell-injectable flag. Values are NOT quoted; they're
   * passed as separate argv entries so shell metacharacters are inert
   * by construction (execFile, not exec).
   */
  params?: Record<string, string>;
  claimNativeOrigin?: () => Promise<void>;
  completeNativeOrigin?: (targetExpected: boolean, signal?: AbortSignal) => Promise<void>;
  relaunchManagedApp?: (stopApp?: boolean) => Promise<void>;
  /** GH #708: re-prove the managed origin at flow end without relaunching. */
  reproveManagedOrigin?: (options?: ManagedNativeOriginReproveOptions) => Promise<void>;
  completeRunnerPark?: (signal?: AbortSignal) => Promise<void>;
  /** GH #705: commit a new install receipt after a clearState reinstall. */
  reissueInstallReceipt?: (() => Promise<void>) | null;
  /** GH #993: the partitioned parent's flow-wide relaunch tracker (nested native leg). */
  flowRelaunches?: FlowRelaunchTracker;
  /** GH #993: managed learned-action replay on a dev client; scopes flow-relaunch attribution. */
  devClientReplay?: boolean;
  /**
   * GH #623: attempt lineage for the canonical run ledger. cdp_run_action
   * passes kind 'repaired' + parentAttemptId on its post-repair retry so one
   * classifier sees both attempts; a plain call defaults to a fresh initial
   * attempt. Not part of the public MCP schema.
   */
  attempt?: LedgerAttemptInput;
}

export interface MaestroAuthorityCallbacks {
  claimNativeOrigin: () => Promise<void>;
  completeNativeOrigin: (targetExpected: boolean, signal?: AbortSignal) => Promise<void>;
  relaunchManagedApp: (stopApp?: boolean) => Promise<void>;
  reproveManagedOrigin: (options?: ManagedNativeOriginReproveOptions) => Promise<void>;
  completeRunnerPark: (signal?: AbortSignal) => Promise<void>;
  reissueInstallReceipt: (() => Promise<void>) | null;
}

// The walker passes its own callbacks through args or deps; the default is a no-op.
export function nestedMaestroAuthorityCallbacks(): MaestroAuthorityCallbacks {
  return {
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {},
    completeRunnerPark: async () => {},
    reissueInstallReceipt: null,
  };
}

interface AuthorityStage {
  commands: unknown[];
  requiresOrigin: boolean;
}

export class MaestroStageExecutionError<T> extends Error {
  readonly completedResults: readonly T[];
  readonly stageError: unknown;

  constructor(completedResults: readonly T[], stageError: unknown) {
    super(stageError instanceof Error ? stageError.message : String(stageError), {
      cause: stageError,
    });
    this.name = 'MaestroStageExecutionError';
    this.completedResults = [...completedResults];
    this.stageError = stageError;
  }
}

const lifecycleCommands = new Set(['launchApp', 'clearState', 'killApp', 'stopApp']);

function commandName(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  const keys = Object.keys(command as Record<string, unknown>);
  return keys.length === 1 ? keys[0]! : null;
}

function nestedLifecycleCommand(command: unknown): boolean {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
  const runFlow = (command as Record<string, unknown>).runFlow;
  if (!runFlow || typeof runFlow !== 'object' || Array.isArray(runFlow)) return false;
  const commands = (runFlow as Record<string, unknown>).commands;
  return Array.isArray(commands) && commands.some(nestedLifecycleCommandOrSelf);
}

function nestedLifecycleCommandOrSelf(command: unknown): boolean {
  const name = commandName(command);
  return (name !== null && lifecycleCommands.has(name)) || nestedLifecycleCommand(command);
}

/** GH #993: the launch options of a flow-owned `launchApp` stage. */
export interface FlowRelaunchFacts {
  stopApp: boolean;
}

function flowRelaunchFacts(command: unknown): FlowRelaunchFacts | null {
  if (commandName(command) !== 'launchApp') return null;
  const options =
    command && typeof command === 'object' && !Array.isArray(command)
      ? (command as { launchApp?: unknown }).launchApp
      : undefined;
  const launch =
    options && typeof options === 'object' && !Array.isArray(options)
      ? (options as { stopApp?: unknown })
      : {};
  return { stopApp: typeof launch.stopApp === 'boolean' ? launch.stopApp : true };
}

function diagnosticErrorDetail(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] ?? null,
    message,
    ...(cause !== undefined ? { cause } : {}),
  };
}

// Track only relaunches without a subsequent successful origin proof, across segments.
export interface FlowRelaunchTracker {
  launched(launch: FlowRelaunchFacts): void;
  claimed(): void;
  attribute(error: unknown): unknown;
}

export function createFlowRelaunchTracker(devClientReplay: boolean): FlowRelaunchTracker {
  let unclaimed: FlowRelaunchFacts | null = null;
  return {
    launched(launch) {
      if (devClientReplay && launch.stopApp) unclaimed = launch;
    },
    claimed() {
      unclaimed = null;
    },
    attribute(error) {
      return unclaimed ? attributeOriginFailureToFlowRelaunch(error, unclaimed) : error;
    },
  };
}

export const FLOW_RELAUNCH_NEXT_ACTION =
  'Do not relaunch a dev-client app from inside a learned action: start the action from the ' +
  'attached app with launchApp stopApp: false, and reset state with device_reset_state before ' +
  'cdp_run_action or cdp_login_prologue.';

// Preserve authority identity and proven foreign-Metro failures when adding flow context.
function attributeOriginFailureToFlowRelaunch(
  error: unknown,
  relaunch: FlowRelaunchFacts,
): unknown {
  if (!(error instanceof SessionAuthorityError) || error.code !== 'METRO_ORIGIN_MISMATCH') {
    return error;
  }
  if (isProvenMetroOriginMismatch(error)) return error;
  const meta = error.getSupplementalMeta();
  if ('flowRelaunch' in meta) return error;
  const cause =
    `The flow's own launchApp relaunched the app and it did not re-register on the ` +
    `authority-bound Metro within the readiness window; the axis is reporting that relaunch, ` +
    `not a broken binding.`;
  const prefix = `${error.code}: `;
  const detail = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
  const attributed = new SessionAuthorityError(
    error.code,
    `${detail} ${cause} ${FLOW_RELAUNCH_NEXT_ACTION}`,
    error.holder,
    error.details,
  );
  attributed.attachMeta({
    ...meta,
    flowRelaunch: {
      command: 'launchApp',
      stopApp: relaunch.stopApp,
    },
  });
  return attributed;
}

export function planMaestroAuthorityStages(commands: readonly unknown[]): {
  stages: AuthorityStage[];
  targetExpected: boolean;
} {
  const stages: AuthorityStage[] = [];
  let pending: unknown[] = [];
  let targetExpected = true;
  const flushPending = (): void => {
    if (pending.length === 0) return;
    stages.push({ commands: pending, requiresOrigin: true });
    pending = [];
  };

  for (const command of commands) {
    const name = commandName(command);
    if (nestedLifecycleCommand(command)) {
      throw new MaestroValidationError(
        'conditional runFlow commands cannot contain app lifecycle transitions',
      );
    }
    if (name !== null && lifecycleCommands.has(name)) {
      flushPending();
      stages.push({ commands: [command], requiresOrigin: false });
      targetExpected = name === 'launchApp';
      continue;
    }
    pending.push(command);
  }
  flushPending();
  return { stages, targetExpected };
}

export async function executeMaestroAuthorityStages<T>(
  commands: readonly unknown[],
  executeStage: (commands: readonly unknown[]) => Promise<T>,
  claimOrigin: () => Promise<void>,
  completeOrigin: (targetExpected: boolean, signal?: AbortSignal) => Promise<void>,
  relaunchManagedApp: (stopApp?: boolean) => Promise<void>,
  reproveManagedOrigin?: (options?: ManagedNativeOriginReproveOptions) => Promise<void>,
  options: {
    firstOriginClaimed?: boolean;
    signal?: AbortSignal;
    /** GH #993: the flow-wide relaunch tracker shared with earlier segments of this same flow. */
    relaunches?: FlowRelaunchTracker;
  } = {},
): Promise<T[]> {
  const plan = planMaestroAuthorityStages(commands);
  const results: T[] = [];
  // GH #708: a relaunched dev-client can need the flow's own post-launch steps
  // (dev-server picker) before it re-registers. Carry the failure to flow end
  // instead of aborting between stages; the origin is still proven before this
  // run can report success.
  let pendingOriginError: unknown;
  let originClaimed = options.firstOriginClaimed === true;
  const relaunches = options.relaunches ?? createFlowRelaunchTracker(false);
  for (const [stageIndex, stage] of plan.stages.entries()) {
    if (stage.requiresOrigin && pendingOriginError === undefined) {
      if (!originClaimed) {
        try {
          recordRunnerDiagnostic('flow-stage', {
            phase: 'origin-begin',
            role: 'claim',
            stage: stageIndex,
          });
          await claimOrigin();
          recordRunnerDiagnostic('flow-stage', {
            phase: 'origin-complete',
            role: 'claim',
            stage: stageIndex,
          });
        } catch (error) {
          recordRunnerDiagnostic('flow-stage', {
            phase: 'origin-failed',
            role: 'claim',
            stage: stageIndex,
            error: diagnosticErrorDetail(error),
          });
          throw relaunches.attribute(error);
        }
        relaunches.claimed();
      }
      originClaimed = false;
    }
    try {
      recordRunnerDiagnostic('flow-stage', { phase: 'execute-begin', stage: stageIndex });
      results.push(await executeStage(stage.commands));
      recordRunnerDiagnostic('flow-stage', { phase: 'execute-complete', stage: stageIndex });
      const launch = stage.commands.length === 1 ? flowRelaunchFacts(stage.commands[0]) : null;
      if (launch) {
        relaunches.launched(launch);
        try {
          recordRunnerDiagnostic('flow-stage', {
            phase: 'relaunch-begin',
            stage: stageIndex,
            stopApp: launch.stopApp,
          });
          await relaunchManagedApp(launch.stopApp);
          recordRunnerDiagnostic('flow-stage', {
            phase: 'relaunch-complete',
            stage: stageIndex,
            stopApp: launch.stopApp,
          });
          pendingOriginError = undefined;
        } catch (error) {
          const deferred =
            Boolean(reproveManagedOrigin) && !(error instanceof SessionAuthorityError);
          recordRunnerDiagnostic('flow-stage', {
            phase: 'relaunch-failed',
            stage: stageIndex,
            stopApp: launch.stopApp,
            deferred,
            error: diagnosticErrorDetail(error),
          });
          if (!deferred) throw error;
          pendingOriginError = error;
        }
      }
    } catch (error) {
      recordRunnerDiagnostic('flow-stage', {
        phase: 'stage-failed',
        stage: stageIndex,
        error: diagnosticErrorDetail(error),
      });
      recordRunnerDiagnostic('flow-stage', { phase: 'cleanup-begin', stage: stageIndex });
      try {
        await completeOrigin(false, options.signal);
      } catch (cleanupError) {
        recordRunnerDiagnostic('flow-stage', {
          phase: 'cleanup-failed',
          stage: stageIndex,
          error: diagnosticErrorDetail(cleanupError),
        });
        throw cleanupError;
      }
      recordRunnerDiagnostic('flow-stage', { phase: 'cleanup-complete', stage: stageIndex });
      throw new MaestroStageExecutionError(results, error);
    }
  }
  if (pendingOriginError !== undefined) {
    try {
      recordRunnerDiagnostic('flow-stage', { phase: 'origin-begin', role: 'reprove' });
      await reproveManagedOrigin!({ signal: options.signal });
      recordRunnerDiagnostic('flow-stage', { phase: 'origin-complete', role: 'reprove' });
    } catch (reproveError) {
      recordRunnerDiagnostic('flow-stage', {
        phase: 'origin-failed',
        role: 'reprove',
        error: diagnosticErrorDetail(reproveError),
      });
      recordRunnerDiagnostic('flow-stage', { phase: 'cleanup-begin' });
      try {
        await completeOrigin(false, options.signal);
      } catch (cleanupError) {
        recordRunnerDiagnostic('flow-stage', {
          phase: 'cleanup-failed',
          error: diagnosticErrorDetail(cleanupError),
        });
        throw cleanupError;
      }
      recordRunnerDiagnostic('flow-stage', { phase: 'cleanup-complete' });
      throw new MaestroStageExecutionError(results, pendingOriginError);
    }
    relaunches.claimed();
  }
  try {
    recordRunnerDiagnostic('flow-stage', { phase: 'origin-begin', role: 'complete' });
    await completeOrigin(plan.targetExpected, options.signal);
    recordRunnerDiagnostic('flow-stage', { phase: 'origin-complete', role: 'complete' });
  } catch (error) {
    recordRunnerDiagnostic('flow-stage', {
      phase: 'origin-failed',
      role: 'complete',
      error: diagnosticErrorDetail(error),
    });
    throw relaunches.attribute(error);
  }
  return results;
}

export function resolveMaestroFlowAppId(
  boundAppId: string | undefined,
  parsedAppId: string | undefined,
): string | undefined {
  if (boundAppId !== undefined && !isValidBundleId(boundAppId)) {
    throw new MaestroValidationError(
      `Invalid bundle ID for authority-bound app: ${JSON.stringify(boundAppId).slice(0, 80)}`,
    );
  }
  if (boundAppId && parsedAppId && parsedAppId !== boundAppId) {
    throw new MaestroValidationError(
      `Flow appId ${parsedAppId} does not match authority-bound appId ${boundAppId}`,
    );
  }
  return boundAppId ?? parsedAppId;
}

/** GH #116: Maestro env-style key pattern. Refuses anything that could
 *  syntactically be confused with a flag (`--`, `-e`) or break the
 *  KEY=VALUE join (`=`, space, control chars). Strict; documented. */
const PARAM_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

function resolvePlatform(override?: string): 'ios' | 'android' | null {
  if (override === 'ios' || override === 'android') return override;
  const session = getActiveSession();
  return (session?.platform as 'ios' | 'android' | undefined) ?? null;
}

function resolveAppId(override?: string, platform?: string): string {
  if (override) return override;
  if (platform) return resolveBundleId(platform) ?? readExpoSlug() ?? '';
  return readExpoSlug() ?? '';
}

export interface MaestroRunDeps {
  fastHealthCheck?: () => Promise<boolean>;
  stopFastRunner?: FlowParkOpts['stopFastRunner'];
  getActiveSession?: () => SessionState | null;
  chooseDispatch?: typeof chooseMaestroDispatch;
  parkFlow?: typeof runFlowParked;
  releaseAndroidSlot?: FlowParkOpts['releaseAndroidSlot'];
  claimNativeOrigin?: () => Promise<void>;
  completeNativeOrigin?: (targetExpected: boolean, signal?: AbortSignal) => Promise<void>;
  relaunchManagedApp?: () => Promise<void>;
  reproveManagedOrigin?: (options?: ManagedNativeOriginReproveOptions) => Promise<void>;
  reissueInstallReceipt?: () => Promise<void>;
  now?: () => number;
  execFile?: (
    file: string,
    args: string[],
    options: { timeout: number; encoding: 'utf8'; maxBuffer: number; signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** GH #741: null = unknown (probe failure fails open, never refuses). */
  probeAndroidApiLevel?: (deviceId: string) => Promise<number | null>;
  resolveEngineStatus?: () => Promise<ReplayEngineStatus | null>;
  createReportDir?: typeof createRunnerReportDir;
  replayDeps?: (args: MaestroRunArgs, signal: AbortSignal) => CdpReplayDeps | null;
  getLiveRoute?: () => Promise<string | null>;
  nativeVisionProbe?: (input: {
    deviceId: string;
    selectors: NativeProofSelector[];
    signal: AbortSignal;
  }) => Promise<NativeVisionEvidence | null>;
}

export interface NativeVisionEvidence {
  source: 'rn-fast-runner-snapshot';
  nodeCount: number;
  visibleSelectors: NativeProofSelector[];
  runtimeMajor: number | null;
}

interface ToolEnvelope {
  ok?: boolean;
  code?: ToolErrorCode;
  error?: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

interface PartitionedReplayStep {
  index: number;
  name: string;
  verb: string;
  focusOnly?: true;
  status: 'pass' | 'fail';
  durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function remapNativeStep(
  step: unknown,
  ordinal: number,
  sourceIndices: number[],
): PartitionedReplayStep | null {
  if (!isRecord(step)) return null;
  const reportedIndex = Number(step.index);
  const localIndex =
    Number.isSafeInteger(reportedIndex) && reportedIndex >= 0 ? reportedIndex : ordinal;
  return {
    index: sourceIndices[localIndex] ?? sourceIndices[ordinal] ?? localIndex,
    name: String(step.name ?? step.verb ?? 'native'),
    verb: String(step.verb ?? step.name ?? 'native'),
    status: step.status === 'fail' ? 'fail' : 'pass',
    durationMs: Number(step.durationMs ?? 0),
  };
}

function remapNativeSteps(steps: unknown, sourceIndices: number[]): PartitionedReplayStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step, ordinal) => {
    const mapped = remapNativeStep(step, ordinal, sourceIndices);
    return mapped ? [mapped] : [];
  });
}

function partialNativeFailureMessage(meta: Record<string, unknown>, nestedError?: string): string {
  const failedStep = remapNativeStep(meta.failedStep, 0, []);
  const lastStep = remapNativeStep(meta.lastStep, 0, []);
  const terminal = isRecord(meta.terminal) ? meta.terminal : null;
  const failureKind = terminal?.failureKind;
  const reason: ReasonSummary | null =
    failureKind === 'SELECTOR_NOT_FOUND' ||
    failureKind === 'TIMEOUT' ||
    failureKind === 'ASSERTION_FAILED'
      ? {
          kind: failureKind,
          selector: typeof terminal?.failureSelector === 'string' ? terminal.failureSelector : null,
        }
      : null;
  const headline = formatFailureHeadline(
    { steps: [], failedStep, lastStep, reason },
    { timedOut: meta.timedOut === true, outputTruncated: meta.outputTruncated === true },
    // Keep the nested envelope's own cause when no structured evidence exists.
    nestedError?.replace(/^Maestro flow failed: /, '') || 'Native replay segment failed.',
  );
  const runtimeDegradation = runtimeDegradationFromMetadata(meta.runtimeDegraded);
  return runtimeDegradation
    ? `${headline} — ${formatRuntimeDegradedHint(runtimeDegradation)}`
    : headline;
}

class ReactReplayFailure extends Error {
  constructor(
    readonly replay: Awaited<ReturnType<typeof runCdpReplayCommands>>,
    readonly sourceIndices: number[],
  ) {
    super(replay.reason ?? 'React-tree replay failed');
    this.name = 'ReactReplayFailure';
  }
}

function readToolEnvelope(result: ToolResult): ToolEnvelope {
  try {
    return JSON.parse(result.content[0]?.text ?? '{}') as ToolEnvelope;
  } catch {
    return { ok: false, error: 'Unparseable nested replay result' };
  }
}

function isLoginMetadata(metadata: MaestroRunArgs['actionMetadata'] | M7Metadata | null): boolean {
  if (!metadata) return false;
  return (
    /(^|[-_.])login($|[-_.])/.test(metadata.id) ||
    metadata.tags?.some((tag) => tag === 'login' || tag === 'auth') === true
  );
}

async function defaultProbeAndroidApiLevel(deviceId: string): Promise<number | null> {
  try {
    const { stdout } = await defaultExecFile(
      'adb',
      ['-s', deviceId, 'shell', 'getprop', 'ro.build.version.sdk'],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    const parsed = Number.parseInt(String(stdout).trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

const UIAUTOMATION_SESSION_CREATION_FAILURE =
  /^Error: failed to create driver: create session: session not created: java\.lang\.IllegalStateException: UiAutomation not connected(?:, UiAutomation@[^\r\n]+)?$/;

function attachCause(error: unknown, cause: unknown): unknown {
  if (error instanceof Error && error.cause === undefined) {
    try {
      Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
    } catch {
      // a frozen/sealed error keeps its own message; the warning already carries the cause
    }
  }
  return error;
}

function isExactDeviceIdShape(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\s/.test(value);
}

function isPreSpawnMaestroError(error: unknown): boolean {
  const candidate = error as { code?: unknown; stdout?: unknown; stderr?: unknown } | null;
  return typeof candidate?.code === 'string' && !candidate.stdout && !candidate.stderr;
}

export function isUiAutomationNotConnectedSessionCreationFailure(error: unknown): boolean {
  const candidate = error as { code?: unknown; stderr?: unknown } | null;
  if (
    typeof candidate?.code !== 'number' ||
    candidate.code === 0 ||
    typeof candidate.stderr !== 'string'
  ) {
    return false;
  }
  const records = candidate.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return records.length === 1 && UIAUTOMATION_SESSION_CREATION_FAILURE.test(records[0] as string);
}

export interface RunnerResumeEvidence {
  attempted: boolean;
  healthy: boolean;
}

/**
 * Read-only verification of the already-parked runner. The probe is the iOS
 * rn-fast-runner's, so on Android it would report an unhealthy runner that was
 * never involved in the run — omit the evidence there instead of lying.
 */
export async function buildRunnerResume(
  platform: 'ios' | 'android',
  probe: () => Promise<boolean>,
): Promise<RunnerResumeEvidence | undefined> {
  if (platform !== 'ios') return undefined;
  return { attempted: true, healthy: await probe().catch(() => false) };
}

export function createMaestroRunHandler(
  deps: MaestroRunDeps = {},
): (args: MaestroRunArgs) => Promise<ToolResult> {
  const fastHealthCheck = deps.fastHealthCheck ?? defaultFastHealthCheck;
  const stopFastRunner = deps.stopFastRunner ?? defaultStopFastRunner;
  const activeSession = deps.getActiveSession ?? getActiveSession;
  const selectDispatch = deps.chooseDispatch ?? chooseMaestroDispatch;
  const parkFlow = deps.parkFlow ?? runFlowParked;
  const execute = deps.execFile ?? defaultExecFile;
  const probeApiLevel = deps.probeAndroidApiLevel ?? defaultProbeAndroidApiLevel;
  const now = deps.now ?? Date.now;
  const resolveEngineStatus =
    deps.resolveEngineStatus ?? (() => getEngineStatus().catch(() => null));
  const replayFactory = deps.replayDeps;
  const nativeOnlyHandler = replayFactory
    ? createMaestroRunHandler({ ...deps, replayDeps: undefined })
    : null;
  const run = async (
    args: MaestroRunArgs,
    evidence: RunnerFailureEvidence,
  ): Promise<ToolResult> => {
    // GH #116: validate params shape FIRST so a malformed payload is rejected
    // regardless of platform / dispatch-tier availability. CI envs without
    // maestro-runner or Maestro CLI would otherwise short-circuit at
    // chooseMaestroDispatch before reaching the validator.
    if (args.params) {
      for (const [key, value] of Object.entries(args.params)) {
        if (!PARAM_KEY_RE.test(key)) {
          return failResult(
            `Refusing to run Maestro: invalid param key '${String(key).slice(0, 60)}' ` +
              `— must match ${PARAM_KEY_RE.source} (GH #116).`,
          );
        }
        if (typeof value !== 'string') {
          return failResult(
            `Refusing to run Maestro: param '${key}' has non-string value (GH #116).`,
          );
        }
      }
    }

    const platform = resolvePlatform(args.platform);
    if (!platform) {
      return failResult('Cannot determine platform. Pass platform or open a device session first.');
    }

    const session = activeSession();
    const matchingSessionDeviceId =
      session?.platform === platform && session.deviceId ? session.deviceId : undefined;
    if (
      args.deviceId &&
      matchingSessionDeviceId &&
      !sameDevice(args.deviceId, matchingSessionDeviceId)
    ) {
      return failResult(
        `Refusing Maestro target ${args.deviceId}: active ${platform} session is bound to ${matchingSessionDeviceId}.`,
        'TARGET_SESSION_MISMATCH',
        { requestedDeviceId: args.deviceId, activeSessionDeviceId: matchingSessionDeviceId },
      );
    }
    const envAndroidSerial =
      platform === 'android' && process.env.ANDROID_SERIAL ? process.env.ANDROID_SERIAL : undefined;
    if (envAndroidSerial !== undefined && !isExactDeviceIdShape(envAndroidSerial)) {
      return failResult(
        'Refusing Maestro: ANDROID_SERIAL must be 1-256 non-whitespace characters. ' +
          'Unset it or set an exact serial, then retry. No device was mutated.',
        'INVALID_ARGUMENT',
      );
    }
    const requestedDeviceId = args.deviceId ?? matchingSessionDeviceId ?? envAndroidSerial;
    if (requestedDeviceId !== undefined && !isExactDeviceIdShape(requestedDeviceId)) {
      return failResult(
        'Refusing Maestro: deviceId must be 1-256 non-whitespace characters.',
        'INVALID_ARGUMENT',
      );
    }

    // GH #356/B223: the dispatch tier depends on whether the validated flow
    // uses hideKeyboard on Android, so the runner is chosen AFTER parsing below.
    let flowHasHideKeyboard = false;

    // Phase 134.1 (deepsec CRITICAL #4): both inlineYaml and flowPath
    // are caller-controlled. Parse, validate against the command allowlist
    // (rejecting runScript and other host-executing directives by default),
    // and re-serialize through buildMaestroFlow before writing the temp
    // file we actually execute. flowPath additionally must exist and is
    // read + validated identically — no longer trusted as "vetted because
    // it's on disk" (deepsec CRITICAL #5 covers the same disk-trust gap
    // in maestro_test_all).
    let flowFile: string;
    let rawYaml: string;
    let validatedContent: string;
    let validatedCommands: unknown[];
    let headerAppId: string | undefined;
    let capturedAction: CapturedActionReplay | null = null;
    const flowPathClassification = args.flowPath
      ? classifyLearnedActionPath(args.flowPath)
      : 'outside';

    if (flowPathClassification === 'descendant') {
      return failResult(
        `Refusing to execute learned-action descendant ${args.flowPath} as a standalone flow.`,
        'BAD_RECORDING',
      );
    }
    if (flowPathClassification === 'action') {
      if (args.inlineYaml) {
        return failResult(
          'Refusing ambiguous learned-action replay with both flowPath and inlineYaml.',
          'BAD_RECORDING',
        );
      }
      try {
        capturedAction = captureActionFromPath(args.flowPath!);
      } catch (err) {
        return failResult(err instanceof Error ? err.message : String(err), 'BAD_RECORDING');
      }
      if (!capturedAction) {
        return failResult(`Action does not resolve uniquely to ${args.flowPath}.`, 'BAD_RECORDING');
      }
      if (!capturedAction.replay.ok) {
        return failResult(capturedAction.replay.error, 'BAD_RECORDING');
      }
      rawYaml = capturedAction.replay.yamlText;
    } else if (args.inlineYaml) {
      rawYaml = args.inlineYaml;
    } else if (args.flowPath) {
      if (!existsSync(args.flowPath)) {
        return failResult(`Flow file not found: ${args.flowPath}`);
      }
      try {
        rawYaml = readFileSync(args.flowPath, 'utf-8');
      } catch (err) {
        return failResult(`Failed to read flow file: ${(err as Error).message}`);
      }
    } else {
      return failResult('Provide either flowPath or inlineYaml.');
    }

    try {
      // GH #186: when running a saved flow FILE, resolve+inline any runFlow file
      // refs relative to that file's directory, contained within it. Inline YAML
      // has no on-disk root, so runFlow file refs stay rejected there.
      const runFlowOpts =
        args.flowPath && flowPathClassification === 'outside'
          ? { flowDir: dirname(args.flowPath), flowRoot: dirname(args.flowPath) }
          : {};
      const parsed = parseAndValidateFlow(rawYaml, runFlowOpts);
      planMaestroAuthorityStages(parsed.commands);
      validatedCommands = parsed.commands;
      flowHasHideKeyboard = flowContainsHideKeyboard(parsed.commands);
      const rawAppId = resolveAppId(args.appId, platform);
      headerAppId = resolveMaestroFlowAppId(rawAppId || undefined, parsed.appId);
      validatedContent = buildMaestroFlow(
        headerAppId ? { appId: headerAppId } : {},
        parsed.commands,
      );
      // Unique per-call path — multi-LLM review caught the fixed
      // `/tmp/rn-maestro-inline.yaml` racing on concurrent maestro_run
      // calls (parallel test invocations could overwrite each other's
      // validated content between writeFileSync and execFile).
      flowFile = join(
        tmpdir(),
        `rn-maestro-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`,
      );
    } catch (err) {
      if (err instanceof MaestroValidationError) {
        return failResult(`Refusing to run Maestro: ${err.message} (Phase 134.1)`);
      }
      throw err;
    }

    const iosProofPlan =
      platform === 'ios' ? planIosProofDomains(validatedCommands, args.params ?? {}) : null;
    if (iosProofPlan && !iosProofPlan.ok) {
      return failResult(
        `Refusing iOS proof-domain ambiguity at step ${iosProofPlan.sourceIndex}: ${iosProofPlan.reason}.`,
        'UNSUPPORTED_STEP',
        { sourceIndex: iosProofPlan.sourceIndex, proofDomains: ['react-tree', 'xctest-native'] },
      );
    }
    const semanticActionMeta =
      capturedAction?.metadata ??
      args.actionMetadata ??
      (args.flowPath
        ? parseM7Header(rawYaml, basename(args.flowPath).replace(/\.ya?ml$/i, ''))
        : null);
    if (
      replayFactory &&
      iosProofPlan?.ok &&
      iosProofPlan.segments.some((segment) => segment.domain === 'react-tree')
    ) {
      const reactOnlyProof = iosProofPlan.segments.every(
        (segment) => segment.domain === 'react-tree',
      );
      const reactEngineStatus = await resolveEngineStatus();
      const reactCompatibilityRefusal =
        capturedAction || semanticActionMeta
          ? actionReplayRefusal({
              enginePin: semanticActionMeta?.enginePin,
              commands: validatedCommands,
              engineStatus: reactEngineStatus,
              requireRuntimePin: !reactOnlyProof,
            })
          : replayCompatibilityRefusal({
              commands: validatedCommands,
              engineStatus: reactEngineStatus,
              requireEnginePin: false,
              requireRuntimePin: !reactOnlyProof,
            });
      if (reactCompatibilityRefusal) {
        return failResult(reactCompatibilityRefusal.message, 'ENGINE_PIN_MISMATCH', {
          refusalClass: reactCompatibilityRefusal.refusalClass,
          pin: reactEngineStatus?.pin,
          installedVersion: reactEngineStatus?.version ?? null,
          selectedPath: reactEngineStatus?.selectedPath ?? null,
          provenance: reactEngineStatus?.provenance ?? 'none',
          proofDomain: reactOnlyProof ? 'react-tree' : 'partitioned',
        });
      }
      writeFileSync(flowFile, validatedContent, 'utf-8');
      if (isLoginMetadata(semanticActionMeta) && !loginPostconditionId(validatedCommands)) {
        return failResult(
          'Refusing login replay without a final positive post-submit testID assertion. End the flow with assertVisible.id or extendedWaitUntil.visible.id.',
          'ASSERTION_FAILED',
          { proofDomain: 'react-tree', postcondition: 'missing' },
        );
      }
      const timeout = args.timeoutMs ?? 120_000;
      const deadline = now() + timeout;
      const controller = new AbortController();
      const deadlineTimer = setTimeout(
        () => controller.abort(new Error('iOS partitioned replay deadline exceeded')),
        timeout,
      );
      const managedAuthority = nestedMaestroAuthorityCallbacks();
      const claimOrigin =
        args.claimNativeOrigin ?? deps.claimNativeOrigin ?? managedAuthority.claimNativeOrigin;
      const completeOrigin =
        args.completeNativeOrigin ??
        deps.completeNativeOrigin ??
        managedAuthority.completeNativeOrigin;
      const relaunchManagedApp =
        args.relaunchManagedApp ?? deps.relaunchManagedApp ?? managedAuthority.relaunchManagedApp;
      const reproveManagedOrigin =
        args.reproveManagedOrigin ??
        deps.reproveManagedOrigin ??
        managedAuthority.reproveManagedOrigin;
      const completeRunnerPark = args.completeRunnerPark ?? managedAuthority.completeRunnerPark;
      const reissueInstallReceipt =
        args.reissueInstallReceipt ??
        deps.reissueInstallReceipt ??
        managedAuthority.reissueInstallReceipt;
      const flowRelaunches = createFlowRelaunchTracker(args.devClientReplay === true);
      const completeClaimedOrigin = async (
        targetExpected: boolean,
        signal?: AbortSignal,
      ): Promise<void> => {
        await completeOrigin(targetExpected, signal);
        if (targetExpected) flowRelaunches.claimed();
      };
      const combinedSteps: PartitionedReplayStep[] = [];
      const proofDomains: Array<'react-tree' | 'xctest-native'> = [];
      let nativeTransportVersion: unknown = null;
      let nativeOutput = '';
      let retainedReactFocusId: string | null | undefined;
      try {
        for (const segment of iosProofPlan.segments) {
          if (controller.signal.aborted || deadline - now() <= 0) {
            return failResult('Partitioned iOS replay exceeded its deadline.', 'RUNNER_TIMEOUT', {
              proofDomains,
            });
          }
          if (segment.domain === 'xctest-native') {
            proofDomains.push('xctest-native');
            const nested = await nativeOnlyHandler!({
              ...args,
              flowPath: undefined,
              inlineYaml: buildMaestroFlow(
                headerAppId ? { appId: headerAppId } : {},
                segment.commands,
              ),
              timeoutMs: Math.max(1, deadline - now()),
              claimNativeOrigin: claimOrigin,
              completeNativeOrigin: completeClaimedOrigin,
              relaunchManagedApp,
              reproveManagedOrigin,
              completeRunnerPark,
              reissueInstallReceipt,
              flowRelaunches,
            });
            const env = readToolEnvelope(nested);
            if (env.ok !== true || env.data?.passed !== true) {
              const nestedMeta: Record<string, unknown> = { ...env.meta, ...env.data };
              const nativeSegmentCoversAttempt =
                segment.sourceIndices.length === validatedCommands.length &&
                segment.sourceIndices.every((sourceIndex, index) => sourceIndex === index);
              let nestedError = env.error ?? 'Native replay segment failed.';
              if (!nativeSegmentCoversAttempt) {
                delete nestedMeta.trailingVerification;
                delete nestedMeta.ledger;
                nestedError = partialNativeFailureMessage(nestedMeta, env.error);
              }
              combinedSteps.push(...remapNativeSteps(nestedMeta.steps, segment.sourceIndices));
              const uniqueProofDomains = [...new Set(proofDomains)];
              const proofDomain =
                uniqueProofDomains.length === 1
                  ? (uniqueProofDomains.at(0) ?? 'partitioned')
                  : 'partitioned';
              const failedStep = remapNativeStep(
                nestedMeta.failedStep,
                Math.max(0, segment.sourceIndices.length - 1),
                segment.sourceIndices,
              );
              const lastStep = remapNativeStep(
                nestedMeta.lastStep,
                Math.max(0, segment.sourceIndices.length - 1),
                segment.sourceIndices,
              );
              const meta = {
                ...nestedMeta,
                flowFile,
                proofDomain,
                proofDomains: uniqueProofDomains,
                ...(proofDomain === 'partitioned'
                  ? { runner: 'partitioned', transport: 'partitioned' }
                  : {}),
                steps: combinedSteps,
                ...(failedStep ? { failedStep } : {}),
                ...(lastStep ? { lastStep } : {}),
              };
              return env.code
                ? failResult(nestedError, env.code, meta)
                : failResult(nestedError, meta);
            }
            nativeTransportVersion = env.data.transportVersion ?? nativeTransportVersion;
            if (typeof env.data.output === 'string') nativeOutput += env.data.output;
            combinedSteps.push(...remapNativeSteps(env.data.steps, segment.sourceIndices));
            if (segment.commands.some(nativeCommandMayChangeFocus)) {
              retainedReactFocusId = undefined;
            }
            continue;
          }

          proofDomains.push('react-tree');
          const replayDependencies = replayFactory(args, controller.signal);
          if (!replayDependencies) {
            const uniqueProofDomains = [...new Set(proofDomains)];
            const proofDomain =
              uniqueProofDomains.length === 1
                ? (uniqueProofDomains.at(0) ?? 'partitioned')
                : 'partitioned';
            return failResult(
              'React-tree replay requires the authority-bound bridgeless runtime. Reconnect the exact app bundle and retry.',
              'CDP_NOT_CONNECTED',
              {
                flowFile,
                proofDomain,
                proofDomains: uniqueProofDomains,
                failedProofDomain: 'react-tree',
                ...(proofDomain === 'partitioned'
                  ? { runner: 'partitioned', transport: 'partitioned' }
                  : {}),
                transportVersion: nativeTransportVersion,
                steps: combinedSteps,
                failedStepIndex: segment.sourceIndices.at(0),
                output: nativeOutput.slice(0, 2000),
                outputTruncated: nativeOutput.length > 2000,
              },
            );
          }
          let stageCursor = 0;
          let reactFocusId: string | null | undefined =
            retainedReactFocusId === undefined ? segment.initialReactFocusId : retainedReactFocusId;
          const stageResults = await executeMaestroAuthorityStages(
            segment.commands,
            async (commands) => {
              const sourceIndices = segment.sourceIndices.slice(
                stageCursor,
                stageCursor + commands.length,
              );
              stageCursor += commands.length;
              const replay = await runCdpReplayCommands(
                [...commands],
                args.params ?? {},
                {
                  ...replayDependencies,
                  launchApp: async () => {},
                },
                { signal: controller.signal, initialFocusId: reactFocusId ?? undefined },
              );
              if (!replay.passed) throw new ReactReplayFailure(replay, sourceIndices);
              for (const step of replay.steps) {
                if (step.t === 'launch') reactFocusId = undefined;
                if (step.t === 'tap' && step.target) {
                  reactFocusId = step.focusOnly ? null : step.target;
                }
              }
              if (replay.finalFocusId === null) reactFocusId = null;
              return { replay, sourceIndices };
            },
            claimOrigin,
            completeClaimedOrigin,
            relaunchManagedApp,
            reproveManagedOrigin,
            { signal: controller.signal, relaunches: flowRelaunches },
          );
          retainedReactFocusId = reactFocusId;
          for (const { replay, sourceIndices } of stageResults) {
            for (const step of replay.steps) {
              combinedSteps.push({
                index: sourceIndices[step.sourceIndex] ?? step.sourceIndex,
                name: step.t,
                verb: step.t,
                ...(step.focusOnly ? { focusOnly: true as const } : {}),
                status: step.ok ? 'pass' : 'fail',
                durationMs: step.durationMs,
              });
            }
          }
        }
        const uniqueDomains = [...new Set(proofDomains)];
        const proofDomain = uniqueDomains.length === 1 ? uniqueDomains[0] : 'partitioned';
        const expectedRoute = semanticActionMeta?.expectedRouteSequence?.at(-1);
        if (expectedRoute && deps.getLiveRoute) {
          const liveRoute = await deps.getLiveRoute().catch(() => null);
          if (controller.signal.aborted || deadline - now() <= 0) {
            return failResult(
              'Partitioned iOS replay exceeded its deadline during route verification.',
              'RUNNER_TIMEOUT',
              {
                proofDomain,
                proofDomains: uniqueDomains,
                ...(proofDomain === 'partitioned'
                  ? { runner: 'partitioned', transport: 'partitioned' }
                  : {}),
                transportVersion: nativeTransportVersion,
                steps: combinedSteps,
                expectedRoute,
                liveRoute,
              },
            );
          }
          if (liveRoute !== expectedRoute) {
            return failResult(
              `React-tree replay reached its final testID but route ${String(liveRoute)} does not match expected route ${expectedRoute}.`,
              'ASSERTION_FAILED',
              {
                proofDomain,
                proofDomains: uniqueDomains,
                ...(proofDomain === 'partitioned'
                  ? { runner: 'partitioned', transport: 'partitioned' }
                  : {}),
                transportVersion: nativeTransportVersion,
                steps: combinedSteps,
                output: nativeOutput.slice(0, 2000),
                outputTruncated: nativeOutput.length > 2000,
                expectedRoute,
                liveRoute,
              },
            );
          }
        }
        return okResult({
          passed: true,
          flowFile,
          platform,
          runner: uniqueDomains.length === 1 ? 'cdp-js' : 'partitioned',
          transport: uniqueDomains.length === 1 ? 'cdp-js' : 'partitioned',
          transportVersion: nativeTransportVersion,
          proofDomain: uniqueDomains.length === 1 ? uniqueDomains[0] : 'partitioned',
          proofDomains: uniqueDomains,
          maestroCertified: false,
          reactTreeProof: {
            nativeInteractionFidelity: false,
            covers: ['exact-react-identity', 'controlled-fiber-text-readback'],
            excludes: ['ime-composition', 'password-autofill', 'keyboard-occlusion'],
          },
          steps: combinedSteps,
          output: nativeOutput.slice(0, 2000),
          timedOut: false,
          outputTruncated: nativeOutput.length > 2000,
        });
      } catch (error) {
        const failure = error instanceof MaestroStageExecutionError ? error.stageError : error;
        if (error instanceof MaestroStageExecutionError) {
          for (const completed of error.completedResults) {
            if (!completed || typeof completed !== 'object' || !('replay' in completed)) continue;
            const result = completed as {
              replay?: { steps?: unknown };
              sourceIndices?: number[];
            };
            if (!result.replay || !Array.isArray(result.replay.steps)) continue;
            const sourceIndices = result.sourceIndices ?? [];
            for (const step of result.replay.steps) {
              if (!step || typeof step !== 'object') continue;
              const record = step as {
                sourceIndex?: number;
                t?: unknown;
                target?: unknown;
                focusOnly?: unknown;
                ok?: boolean;
                durationMs?: number;
              };
              combinedSteps.push({
                index:
                  sourceIndices[record.sourceIndex ?? -1] ??
                  record.sourceIndex ??
                  combinedSteps.length,
                name: String(record.t ?? 'unknown'),
                verb: String(record.t ?? 'unknown'),
                ...(record.target !== undefined ? { target: String(record.target) } : {}),
                ...(record.focusOnly === true ? { focusOnly: true as const } : {}),
                status: record.ok === false ? 'fail' : 'pass',
                durationMs: Number(record.durationMs ?? 0),
              });
            }
          }
        }
        if (failure instanceof ReactReplayFailure) {
          const replay = failure.replay;
          const failedStepIndex =
            replay.failedStepIndex === undefined
              ? undefined
              : (failure.sourceIndices[replay.failedStepIndex] ?? replay.failedStepIndex);
          for (const step of replay.steps) {
            combinedSteps.push({
              index: failure.sourceIndices[step.sourceIndex] ?? step.sourceIndex,
              name: step.t,
              verb: step.t,
              ...(step.focusOnly ? { focusOnly: true as const } : {}),
              status: step.ok ? 'pass' : 'fail',
              durationMs: step.durationMs,
            });
          }
          const uniqueProofDomains = [...new Set(proofDomains)];
          const proofDomain =
            uniqueProofDomains.length === 1
              ? (uniqueProofDomains.at(0) ?? 'partitioned')
              : 'partitioned';
          return failResult(
            `React-tree replay failed at step ${String(failedStepIndex)}: ${replay.reason ?? 'unknown failure'}`,
            (replay.failureCode as ToolErrorCode | undefined) ?? 'ASSERTION_FAILED',
            {
              ...replay.failureMeta,
              proofDomain,
              proofDomains: uniqueProofDomains,
              failedProofDomain: 'react-tree',
              ...(proofDomain === 'partitioned'
                ? { runner: 'partitioned', transport: 'partitioned' }
                : {}),
              steps: combinedSteps,
              failedStepIndex,
            },
          );
        }
        if (failure instanceof SessionAuthorityError) throw failure;
        return failResult(
          failure instanceof Error ? failure.message : String(failure),
          controller.signal.aborted ? 'RUNNER_TIMEOUT' : undefined,
          { proofDomains },
        );
      } finally {
        clearTimeout(deadlineTimer);
      }
    }

    writeFileSync(flowFile, validatedContent, 'utf-8');

    const dispatch = selectDispatch({ platform, flowHasHideKeyboard } as MaestroDispatchInputs);
    if ('error' in dispatch) {
      return failResult(dispatch.error);
    }

    const timeout = args.timeoutMs ?? 120_000;
    const flowDeadline = now() + timeout;

    // GH #116: build the final argv. Start with the dispatch tier's
    // base args, then append `-e KEY=VALUE` pairs for any supplied
    // params. Validation already ran at the top of the handler so by
    // this point every key matches PARAM_KEY_RE and every value is a
    // string — no need to re-check.
    const appFileResolution = resolveAppFileForClearState(
      platform,
      validatedContent,
      headerAppId,
      args.appFile,
      { deviceId: requestedDeviceId },
    );
    if (!appFileResolution.ok) {
      return failResult(appFileResolution.error);
    }
    // GH #705: only a clearState flow uninstalls and reinstalls; an --app-file
    // carried by any other flow is inert and must not re-issue the receipt.
    const reinstallsApp =
      Boolean(appFileResolution.appFile) && flowUsesClearState(validatedContent);
    const reissueInstallReceipt =
      args.reissueInstallReceipt ??
      deps.reissueInstallReceipt ??
      nestedMaestroAuthorityCallbacks().reissueInstallReceipt;
    let installReceiptCommitted = false;
    const commitReinstalledInstall = async (): Promise<void> => {
      if (!reinstallsApp || installReceiptCommitted || !reissueInstallReceipt) return;
      installReceiptCommitted = true;
      await reissueInstallReceipt();
    };
    const baseArgs = dispatch.buildArgs(
      platform,
      flowFile,
      appFileResolution.appFile,
      requestedDeviceId,
    );
    const paramArgs: string[] = [];
    if (args.params) {
      for (const [key, value] of Object.entries(args.params)) {
        paramArgs.push('-e', `${key}=${value}`);
      }
    }
    const releaseAndroidSlot = deps.releaseAndroidSlot ?? defaultReleaseAndroidSlot;
    const androidSlotReleaseWarnings: string[] = [];
    let releasedAndroidDeviceId: string | undefined;
    let uiAutomationRecoveryAttempted = false;
    let uiAutomationRecoveryRetried = false;
    const recordAndroidRelease = (outcome: AndroidSlotReleaseOutcome | void): void => {
      if (outcome?.deviceId) releasedAndroidDeviceId = outcome.deviceId;
      if (outcome?.warnings?.length) androidSlotReleaseWarnings.push(...outcome.warnings);
    };
    const androidReleaseMeta = (): Record<string, unknown> => ({
      ...(androidSlotReleaseWarnings.length > 0
        ? { androidSlotReleaseWarnings: [...androidSlotReleaseWarnings] }
        : {}),
      ...(uiAutomationRecoveryAttempted
        ? {
            androidUiAutomationRecovery: {
              retried: uiAutomationRecoveryRetried,
              retryCount: uiAutomationRecoveryRetried ? 1 : 0,
            },
          }
        : {}),
    });
    const androidReleaseCaveat = (): string | undefined =>
      androidSlotReleaseWarnings.length > 0
        ? `Android interaction-slot release warnings: ${androidSlotReleaseWarnings.join('; ')}`
        : undefined;

    const engineStatus = dispatch.runner === 'maestro-runner' ? await resolveEngineStatus() : null;
    const pinCaveat = engineStatus ? enginePinCaveat(engineStatus) : null;
    const exactRefusal = exactPinRefusal(engineStatus);
    if (exactRefusal) {
      return failResult(exactRefusal, 'ENGINE_PIN_MISMATCH', {
        refusalClass: 'runtimePin',
        pin: engineStatus?.pin,
        installedVersion: engineStatus?.version ?? null,
        selectedPath: engineStatus?.selectedPath ?? null,
        provenance: engineStatus?.provenance ?? 'none',
      });
    }
    const learnedAction = Boolean(capturedAction || args.actionMetadata);
    const actionMeta = semanticActionMeta;
    const compatibilityRefusal =
      learnedAction || actionMeta !== null
        ? actionReplayRefusal({
            enginePin: actionMeta?.enginePin,
            commands: validatedCommands,
            engineStatus,
          })
        : replayCompatibilityRefusal({
            commands: validatedCommands,
            engineStatus,
            requireEnginePin: false,
          });
    if (compatibilityRefusal) {
      return failResult(compatibilityRefusal.message, 'ENGINE_PIN_MISMATCH', {
        refusalClass: compatibilityRefusal.refusalClass,
        pin: engineStatus?.pin,
        installedVersion: engineStatus?.version ?? null,
        selectedPath: engineStatus?.selectedPath ?? null,
        provenance: engineStatus?.provenance ?? 'none',
      });
    }

    // GH #741: the pinned engine cannot drive pre-O Android — refuse with the
    // true capability gap up front instead of an opaque install error later.
    let probedAndroidApiLevel: number | null = null;
    if (platform === 'android' && dispatch.runner === 'maestro-runner' && requestedDeviceId) {
      const apiLevel = await probeApiLevel(requestedDeviceId).catch(() => null);
      probedAndroidApiLevel = apiLevel;
      const apiRefusal = apiLevel === null ? null : preOAndroidApiRefusal(apiLevel);
      if (apiRefusal) {
        return failResult(apiRefusal, 'ANDROID_API_UNSUPPORTED', {
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          androidApiLevel: apiLevel,
        });
      }
    }

    const nativeSelectors = platform === 'ios' ? nativeSelectorsForCommands(validatedCommands) : [];
    const flowAbort = new AbortController();
    const flowAbortTimer = setTimeout(
      () => flowAbort.abort(new Error('Maestro flow deadline exceeded')),
      Math.max(1, flowDeadline - now()),
    );
    // Allocate report evidence only after routing so refusal leaves no scratch tree.
    let runnerReportDir: ReturnType<typeof createRunnerReportDir>;
    try {
      runnerReportDir = (deps.createReportDir ?? createRunnerReportDir)(
        dispatch.runner,
        'rn-maestro-report',
      );
    } catch (error) {
      clearTimeout(flowAbortTimer);
      throw error;
    }
    const finalArgs = assembleMaestroArgs(baseArgs, [
      ...runnerReportArgs(runnerReportDir),
      ...paramArgs,
    ]);
    const directRunnerEvidence = (output: string) =>
      collectDirectRunnerEvidence(runnerReportDir, output);
    let nativeOriginPreclaimed = false;
    let deferredNativeOriginTarget = false;
    let completePreclaimedOrigin: ((targetExpected: boolean) => Promise<void>) | null = null;

    // GH #623: canonical ledger evidence, captured per stage invocation BEFORE
    // the next stage overwrites the shared report dir and before stage outputs
    // are flattened into one string. Hoisted above the try so the catch path
    // classifies the same attempt from the same ledger.
    const ledgerAttempt: LedgerAttemptInput = args.attempt ?? {
      attemptId: randomUUID(),
      ordinal: 1,
      maxAttempts: 1,
      kind: 'initial',
    };
    const authorityPlan = planMaestroAuthorityStages(validatedCommands);
    const plannedStageMeta = (() => {
      let cursor = 0;
      return authorityPlan.stages.map((stage) => {
        const sourceIndices = stage.commands.map((_, i) => cursor + i);
        cursor += stage.commands.length;
        return { sourceIndices, requiresOrigin: stage.requiresOrigin };
      });
    })();
    const stageCaptures: LedgerStageCaptureInput[] = [];
    let ledgerStageCursor = 0;
    let invocationOrdinal = 0;
    const stageTerminationFromError = (
      error: unknown,
    ): Omit<LedgerInvocationTermination, 'artifactFinalized'> => {
      const errorClass = classifyExecError(error);
      const raw = error as { code?: unknown; signal?: unknown } | null;
      return {
        exitCode: typeof raw?.code === 'number' ? raw.code : null,
        signal: typeof raw?.signal === 'string' ? raw.signal : null,
        timedOut: errorClass.timedOut,
        outputTruncated: errorClass.outputTruncated,
        bootstrapFailure: error instanceof RunnerCacheUnavailableError,
        transportFailure: isPreSpawnMaestroError(error),
      };
    };
    const buildAttemptLedger = () =>
      buildMaestroRunLedger({
        attempt: ledgerAttempt,
        sourceText: validatedContent,
        commands: validatedCommands,
        stages: plannedStageMeta.map(
          (meta, index) =>
            stageCaptures[index] ?? {
              sourceIndices: meta.sourceIndices,
              requiresOrigin: meta.requiresOrigin,
              invocation: null,
            },
        ),
      });

    try {
      // 10MB buffer: a multi-step flow with screenshots + app console/network
      // logs routinely exceeds Node's 1MB execFile default, which would kill
      // the child with ERR_CHILD_PROCESS_STDIO_MAXBUFFER and mask a passing
      // run as a failure.
      const managedAuthority = nestedMaestroAuthorityCallbacks();
      const claimOrigin =
        args.claimNativeOrigin ?? deps.claimNativeOrigin ?? managedAuthority.claimNativeOrigin;
      const completeOrigin =
        args.completeNativeOrigin ??
        deps.completeNativeOrigin ??
        managedAuthority.completeNativeOrigin;
      const relaunchManagedApp =
        args.relaunchManagedApp ?? deps.relaunchManagedApp ?? managedAuthority.relaunchManagedApp;
      const reproveManagedOrigin =
        args.reproveManagedOrigin ??
        deps.reproveManagedOrigin ??
        managedAuthority.reproveManagedOrigin;
      const flowRelaunches =
        args.flowRelaunches ?? createFlowRelaunchTracker(args.devClientReplay === true);
      if (platform === 'ios' && authorityPlan.stages[0]?.requiresOrigin) {
        try {
          await claimOrigin();
        } catch (error) {
          throw flowRelaunches.attribute(error);
        }
        flowRelaunches.claimed();
        nativeOriginPreclaimed = true;
      }
      const completeTrackedOrigin = async (
        targetExpected: boolean,
        signal?: AbortSignal,
      ): Promise<void> => {
        if (platform === 'ios' && targetExpected) {
          deferredNativeOriginTarget = true;
          return;
        }
        await completeOrigin(targetExpected, signal);
        nativeOriginPreclaimed = false;
      };
      completePreclaimedOrigin = completeTrackedOrigin;
      const stageResults = await parkFlow(
        () =>
          executeMaestroAuthorityStages(
            validatedCommands,
            async (commands) => {
              const ledgerStageIndex = ledgerStageCursor++;
              const preFingerprint = runnerReportFingerprint(runnerReportDir);
              let failedInvocationTermination: Omit<
                LedgerInvocationTermination,
                'artifactFinalized'
              > | null = null;
              const captureStageInvocation = (
                termination: Omit<LedgerInvocationTermination, 'artifactFinalized'>,
              ): void => {
                const meta = plannedStageMeta[ledgerStageIndex];
                stageCaptures[ledgerStageIndex] = {
                  sourceIndices: meta?.sourceIndices ?? [],
                  requiresOrigin: meta?.requiresOrigin ?? true,
                  invocation: {
                    termination,
                    // The pre-invocation fingerprint lets the reader refuse
                    // leftover or mixed-generation evidence for this stage.
                    artifact: readStructuredFlowArtifact(runnerReportDir, preFingerprint),
                  },
                };
              };
              try {
                const stageResult = await (async () => {
                  writeFileSync(
                    flowFile,
                    buildMaestroFlow(headerAppId ? { appId: headerAppId } : {}, [...commands]),
                    'utf-8',
                  );
                  const executeOnce = async (
                    beforeDispatch?: () => void,
                  ): Promise<{ stdout: string; stderr: string }> => {
                    if (flowDeadline - now() <= 0) {
                      const error = new Error(
                        'Maestro flow timeout exhausted before the next stage',
                      );
                      Object.assign(error, { code: 'ETIMEDOUT' });
                      throw error;
                    }
                    const executeRunner = async (
                      runnerPath: string,
                      prefixArgs: readonly string[] = [],
                    ) => {
                      const fingerprint = runnerReportFingerprint(runnerReportDir);
                      beforeDispatch?.();
                      const remainingTimeout = flowDeadline - now();
                      if (remainingTimeout <= 0) {
                        const error = new Error(
                          'Maestro flow timeout exhausted before runner execution',
                        );
                        Object.assign(error, { code: 'ETIMEDOUT' });
                        throw error;
                      }
                      const invocation = ++invocationOrdinal;
                      try {
                        const result = await execute(runnerPath, [...prefixArgs, ...finalArgs], {
                          timeout: remainingTimeout,
                          encoding: 'utf8',
                          maxBuffer: 10 * 1024 * 1024,
                          signal: flowAbort.signal,
                        });
                        if (
                          outputIndicatesFlowFailure(
                            combineRunnerOutput(result.stdout, result.stderr),
                          )
                        ) {
                          captureRunnerFailure(
                            evidence,
                            runnerReportDir,
                            fingerprint,
                            ledgerStageIndex,
                            invocation,
                            {
                              exitCode: 0,
                              signal: null,
                              timedOut: false,
                              outputTruncated: false,
                              bootstrapFailure: false,
                              transportFailure: false,
                            },
                            ledgerAttempt.ordinal,
                          );
                        }
                        return result;
                      } catch (error) {
                        captureRunnerFailure(
                          evidence,
                          runnerReportDir,
                          fingerprint,
                          ledgerStageIndex,
                          invocation,
                          stageTerminationFromError(error),
                          ledgerAttempt.ordinal,
                        );
                        throw error;
                      }
                    };
                    if (deps.execFile) {
                      const immediateStatus = await resolveEngineStatus();
                      const refusal = exactPinRefusal(immediateStatus);
                      const immediateRefusal = refusal ? `RUNNER_PIN_CHANGED: ${refusal}` : null;
                      if (immediateRefusal) throw new Error(immediateRefusal);
                      return executeRunner(dispatch.binPath);
                    }
                    return withImmediatePinnedRunner(
                      dispatch.binPath,
                      resolveEngineStatus,
                      executeRunner,
                      platform,
                    );
                  };
                  try {
                    return await executeOnce();
                  } catch (error) {
                    const initialFailureTermination = stageTerminationFromError(error);
                    const recoveryDeviceId = requestedDeviceId ?? releasedAndroidDeviceId;
                    if (
                      platform !== 'android' ||
                      uiAutomationRecoveryAttempted ||
                      !recoveryDeviceId ||
                      !isUiAutomationNotConnectedSessionCreationFailure(error)
                    ) {
                      failedInvocationTermination = initialFailureTermination;
                      throw error;
                    }
                    uiAutomationRecoveryAttempted = true;
                    const recoveryTimeout = flowDeadline - now();
                    if (recoveryTimeout <= 0) {
                      androidSlotReleaseWarnings.push(
                        'UiAutomation recovery skipped: Maestro flow timeout was exhausted',
                      );
                      failedInvocationTermination = initialFailureTermination;
                      throw error;
                    }
                    // NOTE: AbortSignal.timeout()'s timer is unref'd, so a cleanup
                    // awaiting only that signal never aborts once the loop drains.
                    const recoveryAbort = new AbortController();
                    const recoveryDeadlineTimer = setTimeout(() => {
                      recoveryAbort.abort(
                        new Error(
                          'UiAutomation recovery cleanup exceeded the remaining Maestro flow timeout',
                        ),
                      );
                    }, recoveryTimeout);
                    try {
                      recordAndroidRelease(
                        await releaseAndroidSlot({
                          deviceId: recoveryDeviceId,
                          includeLegacy: false,
                          signal: recoveryAbort.signal,
                        }),
                      );
                    } catch (releaseError) {
                      androidSlotReleaseWarnings.push(
                        `UiAutomation recovery release failed: ${
                          releaseError instanceof Error
                            ? releaseError.message
                            : String(releaseError)
                        }`,
                      );
                      failedInvocationTermination = {
                        ...initialFailureTermination,
                        transportFailure: true,
                      };
                      throw attachCause(error, releaseError);
                    } finally {
                      clearTimeout(recoveryDeadlineTimer);
                    }
                    try {
                      return await executeOnce(() => {
                        uiAutomationRecoveryRetried = true;
                      });
                    } catch (retryError) {
                      const retryFailureTermination = stageTerminationFromError(retryError);
                      if (uiAutomationRecoveryRetried && !isPreSpawnMaestroError(retryError)) {
                        failedInvocationTermination = retryFailureTermination;
                        throw retryError;
                      }
                      uiAutomationRecoveryRetried = false;
                      androidSlotReleaseWarnings.push(
                        `UiAutomation recovery retry did not start: ${
                          retryError instanceof Error ? retryError.message : String(retryError)
                        }`,
                      );
                      failedInvocationTermination = retryFailureTermination;
                      throw attachCause(error, retryError);
                    }
                  }
                })();
                captureStageInvocation({
                  exitCode: 0,
                  signal: null,
                  timedOut: false,
                  outputTruncated: false,
                  bootstrapFailure: false,
                  transportFailure: false,
                });
                return stageResult;
              } catch (stageInvocationError) {
                captureStageInvocation(
                  failedInvocationTermination ?? stageTerminationFromError(stageInvocationError),
                );
                throw stageInvocationError;
              }
            },
            claimOrigin,
            completeTrackedOrigin,
            relaunchManagedApp,
            reproveManagedOrigin,
            {
              firstOriginClaimed: nativeOriginPreclaimed,
              signal: flowAbort.signal,
              relaunches: flowRelaunches,
            },
          ),
        {
          platform,
          deviceId: requestedDeviceId,
          releaseAndroidSlot,
          onAndroidRelease: recordAndroidRelease,
          stopFastRunner: deps.stopFastRunner,
          completeRunnerPark: args.completeRunnerPark ?? managedAuthority.completeRunnerPark,
          signal: flowAbort.signal,
        },
      );
      if (deferredNativeOriginTarget) {
        try {
          // A caller-supplied reprove must run even without local replayDeps (nested native leg).
          if (nativeOriginPreclaimed && (args.reproveManagedOrigin || deps.reproveManagedOrigin)) {
            await reproveManagedOrigin({
              signal: flowAbort.signal,
              readinessTimeoutMs: Math.max(1, flowDeadline - now()),
            });
            flowRelaunches.claimed();
          }
          await completeOrigin(true, flowAbort.signal);
        } catch (error) {
          throw flowRelaunches.attribute(error);
        }
        flowRelaunches.claimed();
        nativeOriginPreclaimed = false;
      }
      await commitReinstalledInstall();
      const stdout = stageResults.map((result) => result.stdout).join('\n');
      const stderr = stageResults.map((result) => result.stderr).join('\n');

      // combineRunnerOutput (not .trim()) so the step parser's leading-indent
      // anchor (B212) still sees the FIRST step line's indent — see GH #312.
      const output = combineRunnerOutput(stdout, stderr);
      // Reaching here means the runner exited 0 — that exit code is the
      // authoritative pass signal (a real flow failure exits non-zero and is
      // handled in the catch below). The output scan is only a secondary guard,
      // keyed on Maestro's own status LINES (GH#249: the prior bare `FAILED`
      // substring false-flagged passing runs whose app logs contained the token).
      const passed = !outputIndicatesFlowFailure(output);
      const directEvidence = directRunnerEvidence(output);
      const deviceAuthority = verifyMaestroDeviceAuthority({
        runner: dispatch.runner,
        platform,
        requestedDeviceId,
        output: directEvidence.output,
        directReportDeviceIds: directEvidence.reportDeviceIds,
        directReportIdentityStrength: directEvidence.reportDeviceIdStrength,
        requireWdaProvenance: passed,
      });
      const authorityRefusal = maestroAuthorityRefusal(deviceAuthority);
      if (authorityRefusal) {
        return failResult(authorityRefusal, 'DEVICE_AUTHORITY_MISMATCH', {
          flowFile,
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          deviceAuthority,
          output: output.slice(0, 4000),
          ...androidReleaseMeta(),
        });
      }
      const summary = buildStepSummary(output, { failed: !passed });
      const runnerResume = !passed ? await buildRunnerResume(platform, fastHealthCheck) : undefined;
      const meta = {
        passed,
        flowFile,
        platform,
        runner: dispatch.runner,
        transport: dispatch.runner,
        proofDomain: 'xctest-native',
        transportVersion: engineStatus?.version ?? null,
        fallback: dispatch.fallbackReason ? dispatch.runner : 'none',
        deviceAuthority,
        output: output.slice(0, 2000),
        ...summary,
        ...(!passed
          ? { terminal: buildTerminalEvidence(output), ...(runnerResume ? { runnerResume } : {}) }
          : {}),
        timedOut: false,
        outputTruncated: false,
        ...(dispatch.fallbackReason ? { fallbackReason: dispatch.fallbackReason } : {}),
        ...(dispatch.degradedReason ? { degradedReason: dispatch.degradedReason } : {}),
        ...(engineStatus && engineStatus.pin.status !== 'pinned-ok'
          ? { enginePin: engineStatus.pin }
          : {}),
        ...androidReleaseMeta(),
      };

      // GH #356/B223: a degradedReason (Android hideKeyboard with no Maestro CLI)
      // is a caveat surfaced the same way as a fallbackReason. GH #397: so is
      // an engine-pin drift (warn-once via the same mechanism).
      const caveat = dispatch.fallbackReason ?? dispatch.degradedReason ?? pinCaveat ?? undefined;
      const releaseCaveat = androidReleaseCaveat();

      if (passed) {
        // B59 (Gemini review, conf 82): on success-with-fallback, only emit
        // a loud warning the FIRST time per process so a 100-flow loop
        // doesn't generate 100 identical warnings. Subsequent successes
        // carry the reason silently in meta.
        const warnCaveat = caveat && shouldWarnFallback(caveat) ? caveat : undefined;
        if (releaseCaveat) {
          return warnResult(meta, warnCaveat ? `${warnCaveat}; ${releaseCaveat}` : releaseCaveat);
        }
        if (warnCaveat) {
          return warnResult(meta, warnCaveat);
        }
        return okResult(meta);
      }
      const baseWarnMsg = [caveat, releaseCaveat, 'Flow completed with warnings or failures']
        .filter((part): part is string => Boolean(part))
        .join('; ');
      // GH #623: the canonical ledger (built from per-stage producer evidence,
      // never from the flattened output) is the only source of the qualifier.
      const warnLedger = buildAttemptLedger();
      const warnTrailingVerification = classifyTrailingVerification(warnLedger);
      // GH #263: classify on the FULL output (not the sliced meta.output).
      const warnAug = augmentFailureWithDegradation(
        output,
        resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS),
        baseWarnMsg,
        {
          ...meta,
          ledger: warnLedger,
          ...(warnTrailingVerification ? { trailingVerification: warnTrailingVerification } : {}),
        },
        { trailingVerification: warnTrailingVerification },
      );
      return warnResult(warnAug.meta, warnAug.message);
    } catch (err) {
      const stageError = err instanceof MaestroStageExecutionError ? err.stageError : err;
      const errorClass = classifyExecError(stageError);
      const processTerminationVeto = stageCaptures.some((capture) => {
        const termination = capture.invocation?.termination;
        if (!termination) return false;
        return (
          termination.timedOut ||
          termination.signal !== null ||
          termination.outputTruncated ||
          termination.bootstrapFailure ||
          termination.transportFailure
        );
      });
      if (nativeOriginPreclaimed && completePreclaimedOrigin) {
        try {
          await completePreclaimedOrigin(false);
        } catch (cleanupError) {
          return failResult(
            `Native replay cleanup could not settle the managed runtime after ${stageError instanceof Error ? stageError.message : String(stageError)}.`,
            'AUTOMATION_CLEANUP_UNPROVEN',
            {
              platform,
              proofDomain: 'xctest-native',
              runner: dispatch.runner,
              cleanupError:
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
          );
        }
      }
      if (stageError instanceof RunnerCacheUnavailableError) {
        recordRunnerDiagnostic('typed-failure', {
          code: stageError.code,
          errno: stageError.errno,
          path: stageError.relativePath,
        });
        return failResult(runnerCacheBootstrapFailure(stageError), 'WDA_BOOTSTRAP_FAILED', {
          flowFile,
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          proofDomain: 'xctest-native',
          passed: false,
          output: '',
          terminal: {
            exitClass: 'before-first-step',
            bootstrapEvidence: stageError.message,
          },
          ...androidReleaseMeta(),
        });
      }
      // A flow that died mid-way may still have reinstalled: re-issue before
      // reporting, so the failure is the flow's and not a broken axis I.
      await commitReinstalledInstall();
      if (err instanceof SessionAuthorityError) {
        err.attachMeta(androidReleaseMeta());
        throw err;
      }
      const msg = stageError instanceof Error ? stageError.message : String(stageError);
      if (stageError instanceof ExactAndroidDeviceRequiredError) {
        return failResult(stageError.message, stageError.code, {
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          ...androidReleaseMeta(),
        });
      }
      // Multi-LLM review of PR #115 (Codex conf 95): when execFile
      // throws on timeout (or kill), Node attaches the partial stdout
      // and stderr to the error object. Preserve them in `data.output`
      // so downstream parsers (notably `cdp_run_action`'s
      // `parseMaestroFailure`) can still classify the underlying
      // failure — e.g. a SELECTOR_NOT_FOUND emitted just before the
      // timeout boundary. Without this, auto-repair is silently
      // pessimised exactly when devices are slow / under load.
      const errAny = stageError as { stdout?: unknown; stderr?: unknown };
      const completed =
        err instanceof MaestroStageExecutionError
          ? (err.completedResults as ReadonlyArray<{ stdout?: unknown; stderr?: unknown }>)
          : [];
      const stdout = [
        ...completed.map((result) => (typeof result.stdout === 'string' ? result.stdout : '')),
        typeof errAny?.stdout === 'string' ? errAny.stdout : '',
      ].join('\n');
      const stderr = [
        ...completed.map((result) => (typeof result.stderr === 'string' ? result.stderr : '')),
        typeof errAny?.stderr === 'string' ? errAny.stderr : '',
      ].join('\n');
      const combined = combineRunnerOutput(stdout, stderr);
      // GH #741: an INSTALL_FAILED_OLDER_SDK reject is a capability gap, not a
      // flow failure — surface it before device-authority checks can mask it.
      // A probe that already proved this device is at/above the minimum vetoes
      // the mapping, so an echoed token can never mask a real flow failure.
      const apiLevelAllowsPreO =
        probedAndroidApiLevel === null || probedAndroidApiLevel < MAESTRO_RUNNER_MIN_ANDROID_API;
      if (platform === 'android' && apiLevelAllowsPreO && isOlderSdkInstallFailure(combined)) {
        return failResult(olderSdkInstallDiagnosis(dispatch.runner), 'ANDROID_API_UNSUPPORTED', {
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          output: combined.slice(0, 4000),
          ...androidReleaseMeta(),
        });
      }
      let timedOut = errorClass.timedOut || flowAbort.signal.aborted;
      const { outputTruncated } = errorClass;
      const directEvidence = directRunnerEvidence(combined);
      const deviceAuthority = verifyMaestroDeviceAuthority({
        runner: dispatch.runner,
        platform,
        requestedDeviceId,
        output: directEvidence.output,
        directReportDeviceIds: directEvidence.reportDeviceIds,
        directReportIdentityStrength: directEvidence.reportDeviceIdStrength,
      });
      const summary = buildStepSummary(combined, { failed: true });
      const spawnError = combined.length === 0 && isPreSpawnMaestroError(stageError);
      let terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
      const runnerResume = await buildRunnerResume(platform, fastHealthCheck);
      if (flowAbort.signal.aborted || now() >= flowDeadline) {
        timedOut = true;
        terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
      }
      // A run that produced no output never reached the device, so there is no
      // authority verdict to render — reporting one would mask the spawn/park
      // failure behind DEVICE_AUTHORITY_MISMATCH and refuse auto-repair.
      const catchRefusal =
        combined.length > 0 ? maestroAuthorityRefusal(deviceAuthority, msg) : null;
      if (catchRefusal) {
        return failResult(catchRefusal, 'DEVICE_AUTHORITY_MISMATCH', {
          flowFile,
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          deviceAuthority,
          output: combined.slice(0, 4000),
          ...summary,
          terminal,
          ...(runnerResume ? { runnerResume } : {}),
          timedOut,
          outputTruncated,
          ...androidReleaseMeta(),
        });
      }
      const nativeFailure = parseMaestroFailure(combined, terminal);
      if (nativeFailure.kind === 'TIMEOUT' && !timedOut) {
        timedOut = true;
        terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
      }
      const soleNativeSelector = soleComparableNativeSelectorForCommands(validatedCommands)?.value;
      const selectorLessAssertionFailure =
        nativeFailure.kind === 'UNKNOWN' &&
        terminal.exitClass === 'step-failure' &&
        terminal.failedStep?.split(/\s+/, 1)[0] === 'assertVisible';
      const failedNativeSelector =
        nativeFailure.kind === 'SELECTOR_NOT_FOUND'
          ? (nativeFailure.selector ?? soleNativeSelector)
          : nativeFailure.kind === 'ASSERTION_FAILED'
            ? (nativeFailure.selector ?? soleNativeSelector)
            : nativeFailure.kind === 'TIMEOUT'
              ? nativeFailure.selector
              : selectorLessAssertionFailure
                ? soleNativeSelector
                : null;
      const comparableNativeSelector = nativeSelectors.find(
        (selector) => selector.value === failedNativeSelector,
      );
      let nativeVisionEvidence: NativeVisionEvidence | null = null;
      let nativeVisionAttempted = false;
      if (
        requestedDeviceId &&
        comparableNativeSelector &&
        deps.nativeVisionProbe &&
        !timedOut &&
        !flowAbort.signal.aborted
      ) {
        nativeVisionAttempted = true;
        nativeVisionEvidence = await deps
          .nativeVisionProbe({
            deviceId: requestedDeviceId,
            selectors: [comparableNativeSelector],
            signal: flowAbort.signal,
          })
          .catch(() => null);
        if (flowAbort.signal.aborted || now() >= flowDeadline) {
          timedOut = true;
          terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
          nativeVisionEvidence = null;
        }
      }
      if (nativeVisionAttempted) {
        try {
          await stopFastRunner(requestedDeviceId, flowAbort.signal);
          await (args.completeRunnerPark ?? nestedMaestroAuthorityCallbacks().completeRunnerPark)(
            flowAbort.signal,
          );
        } catch {
          return failResult(
            'Native replay cleanup could not settle the failure-screen comparison runner.',
            'AUTOMATION_CLEANUP_UNPROVEN',
            {
              platform,
              proofDomain: 'xctest-native',
              runner: dispatch.runner,
              cleanup: {
                cleanupProven: false,
                wdaProcessSettled: true,
                runnerParkCommitted: false,
                managedOriginSettled: !nativeOriginPreclaimed,
              },
            },
          );
        }
      }
      if (flowAbort.signal.aborted || now() >= flowDeadline) {
        timedOut = true;
        terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
        nativeVisionEvidence = null;
      }
      const fastRunnerSawFailedSelector =
        failedNativeSelector !== null &&
        nativeVisionEvidence?.visibleSelectors.some(
          (selector) => selector.value === failedNativeSelector,
        ) === true;
      if (fastRunnerSawFailedSelector) {
        const selectorKind = nativeVisionEvidence!.visibleSelectors.find(
          (selector) => selector.value === failedNativeSelector,
        )!.kind;
        return failResult(
          'XCTest/WDA could not resolve a native-only selector that the bounded native snapshot saw on the failure screen. This is a blind native surface, not an ordinary selector miss. Use a WDA-healthy simulator/runtime for the native step, then retry; exact React testID steps should remain on cdp_run_action.',
          'NATIVE_SURFACE_BLIND',
          {
            platform,
            proofDomain: 'xctest-native',
            runner: dispatch.runner,
            transportVersion: engineStatus?.version ?? null,
            nativeVision: {
              source: nativeVisionEvidence!.source,
              nodeCount: nativeVisionEvidence!.nodeCount,
              visibleSelectorCount: nativeVisionEvidence!.visibleSelectors.length,
              failedSelectorKind: selectorKind,
              runtimeMajor: nativeVisionEvidence!.runtimeMajor,
              runtimeVersionHeuristicIsProof: false,
            },
            deviceAuthority,
            cleanup: {
              cleanupProven: true,
              wdaProcessSettled: true,
              runnerParkCommitted: true,
              managedOriginSettled: !nativeOriginPreclaimed,
              fastRunnerHealthy: runnerResume?.healthy ?? null,
            },
            nextAction:
              'Run the doctor compatibility report and the central native WDA smoke on a WDA-healthy runtime, then retry this native-only step.',
          },
        );
      }
      // Headline from structured data (raw-free); the raw err.message is the
      // fallback only for system errors with no step output (e.g. spawn ENOENT).
      const rawHeadline = formatFailureHeadline(summary, { timedOut, outputTruncated }, msg);
      const releaseCaveat = androidReleaseCaveat();
      const headline = releaseCaveat ? `${rawHeadline}; ${releaseCaveat}` : rawHeadline;
      // GH #623: the canonical ledger is the only source of the qualifier. A
      // process-level kill outranks it (gh-580 precedence), so a timed-out or
      // never-spawned run never classifies as trailing verification.
      const failLedger = buildAttemptLedger();
      const failTrailingVerification = processTerminationVeto
        ? null
        : classifyTrailingVerification(failLedger);
      // GH #263: a timeout/non-zero exit is also a failure surface — flag a
      // wedged runtime here too if the successful taps were degraded.
      const failAug = augmentFailureWithDegradation(
        combined,
        resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS),
        headline,
        {
          ledger: failLedger,
          ...(failTrailingVerification ? { trailingVerification: failTrailingVerification } : {}),
          flowFile,
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          proofDomain: 'xctest-native',
          transportVersion: engineStatus?.version ?? null,
          fallback: dispatch.fallbackReason ? dispatch.runner : 'none',
          deviceAuthority,
          passed: false,
          // `output` mirrors the success/warn shape so callers can read
          // it the same way regardless of which path they hit.
          output: combined.slice(0, 4000),
          ...summary,
          terminal,
          ...(runnerResume ? { runnerResume } : {}),
          timedOut,
          outputTruncated,
          // GH #397: a drifted/mismatched engine causing a real failure is
          // exactly when the pin state matters — carry it on this path too.
          ...(engineStatus && engineStatus.pin.status !== 'pinned-ok'
            ? { enginePin: engineStatus.pin }
            : {}),
          ...androidReleaseMeta(),
        },
        { trailingVerification: failTrailingVerification },
      );
      return failResult(failAug.message, failAug.meta);
    } finally {
      clearTimeout(flowAbortTimer);
      try {
        writeFileSync(flowFile, validatedContent, 'utf-8');
      } finally {
        disposeRunnerReportDir(runnerReportDir);
      }
    }
  };
  return async (args) => {
    const evidence = createRunnerFailureEvidence();
    try {
      const result = await run(args, evidence);
      return evidence.captures.length
        ? attachMeta(result, { runnerFailureEvidence: evidence })
        : result;
    } catch (error) {
      if (error instanceof SessionAuthorityError && evidence.captures.length) {
        error.attachMeta({ runnerFailureEvidence: evidence });
      }
      throw error;
    }
  };
}
