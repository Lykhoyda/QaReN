import { HandlerError } from './adapt.js';
import { systemModalDiagnostic } from '../domain/system-modal-diagnostic.js';
import { sleep, withDeadline } from '../domain/cancellation.js';
import { SETTLE_DEFAULT_BUDGET_MS } from '../lifecycle/settle.js';
import { WAIT_POLL_MS } from './walker.js';
import { diagnosticField, privateSnapshotDiagnostics } from './snapshot-diagnostics.js';
import type { ToolResult } from '../utils.js';
import { foregroundSurfaceFromSnapshot } from '../handlers/expo-dev-menu.js';
import { isRecord } from './questions.js';
import {
  frontFromSurface,
  join,
  joinedSnapshotDiagnostics,
  validateReactHostEvidence,
} from './screen.js';
import type { DigestEntry, NativeNode, ReactHostEvidence, Screen } from './screen.js';
import {
  clippingViewport,
  outsideViewport,
  validateNativePresence,
  viewportDiagnostic,
} from './native-presence.js';
import { sensitivePixelsReasons } from './privacy.js';
import {
  CAPTURE_BUDGET_MS,
  NATIVE_PRESENCE_BUDGET_MS,
  measureTiming,
  observeTiming,
  type TimingObserver,
  type TimingStage,
} from './timing.js';
import {
  applyNativePrivateInputs,
  NativeSnapshotIncomplete,
  PrivateInputCaptureError,
  ReactCaptureIncomplete,
} from './private-input.js';

export class NativeCaptureError extends Error {
  readonly code = 'NATIVE_CAPTURE_UNAVAILABLE' as const;

  constructor() {
    super('Native capture is unavailable.');
    this.name = 'NativeCaptureError';
  }
}

// The runner saw the app process gone; content-free, so it may leave capture unmasked.
export class AppProcessGoneError extends Error {
  constructor() {
    super('the app process is not running');
    this.name = 'AppProcessGoneError';
  }
}

export interface NativeObservation {
  appProcessIdentifier?: unknown;
  keyboardVisible?: unknown;
  presenceCapture?: unknown;
  snapshotGeneration?: unknown;
  nodes?: NativeNode[];
  truncated?: unknown;
  normalizationDroppedNodes?: unknown;
  surface?: string;
  snapshotVerdict?: unknown;
  systemModal?: unknown;
  snapshotDiagnostics?: unknown;
}

export function postAdmissionSnapshots<A>(
  snapshot: (args: A) => Promise<ToolResult>,
  appId: string,
) {
  let interrupted = false;
  let appProcess: number | undefined;
  return {
    interrupted: () => interrupted,
    async snapshot(args: A): Promise<ToolResult> {
      const result = await snapshot(args);
      let envelope: unknown;
      try {
        envelope = JSON.parse(result.content[0]?.text ?? '');
      } catch {
        return result;
      }
      if (!isRecord(envelope)) return result;
      const meta = isRecord(envelope.meta) ? envelope.meta : undefined;
      const data = isRecord(envelope.data) ? envelope.data : undefined;
      const surface = meta?.foregroundSurface ?? foregroundSurfaceFromSnapshot(result, appId);
      if (
        surface === 'dev_client_picker' ||
        surface === 'first_run_tutorial' ||
        meta?.recovered !== undefined ||
        meta?.recoveryTier !== undefined ||
        meta?.recoveryReason !== undefined ||
        meta?.code === 'RUNNER_LEAK' ||
        meta?.reason === 'app-not-running'
      )
        interrupted = true;
      const observed = data?.appProcessIdentifier;
      const retryableRelaunchFailure =
        envelope.ok === false &&
        (envelope.code ?? meta?.code) === 'RN_FAST_RUNNER_DOWN' &&
        meta?.runnerRelaunch === true;
      if (
        appProcess !== undefined &&
        observed !== appProcess &&
        !(retryableRelaunchFailure && observed === undefined)
      )
        interrupted = true;
      if (typeof observed === 'number' && Number.isSafeInteger(observed) && observed > 0)
        appProcess = observed;
      return result;
    },
  };
}

export interface ReactObservation {
  renderError?: boolean;
  interactive?: DigestEntry[];
  truncated?: unknown;
  verdict?: unknown;
  hostEvidence?: unknown;
  reconnected?: true;
}

export interface CaptureDeps {
  observation?: number;
  platformPresence?: boolean;
  timing?: TimingObserver;
  requirePrivateInputs?: boolean;
  appId?: string;
  now?(): number;
  native(presenceBudgetMs: number): Promise<NativeObservation>;
  react(): Promise<ReactObservation>;
  warn?(message: string): void;
}

const captureDiagnostics = new WeakMap<Screen, () => void>();
const quotedTargetDiagnostics = new WeakMap<Screen, (quoted: string, line: number) => void>();

export function emitCaptureDiagnostics(screen: Screen): void {
  const emit = captureDiagnostics.get(screen);
  captureDiagnostics.delete(screen);
  emit?.();
}

export function emitQuotedTargetDiagnostic(screen: Screen, quoted: string, line: number): void {
  try {
    quotedTargetDiagnostics.get(screen)?.(quoted, line);
  } catch {
    // Diagnostics cannot change the failed step's outcome.
  }
}

type Coverage = NonNullable<Screen['coverage']>;

function nativeIncompleteCauses(observation: NativeObservation): string[] {
  const verdict = isRecord(observation.snapshotVerdict) ? observation.snapshotVerdict : undefined;
  const causes: string[] = [];
  if (observation.truncated === true) causes.push('truncated');
  if (
    typeof observation.normalizationDroppedNodes === 'number' &&
    observation.normalizationDroppedNodes > 0
  )
    causes.push(`dropped=${observation.normalizationDroppedNodes}`);
  if (verdict?.state === 'degraded' || verdict?.state === 'failed')
    causes.push(`verdict=${verdict.state}`);
  if (verdict?.refMapUpdated === false) causes.push('ref-map-not-updated');
  if (Array.isArray(verdict?.reasons))
    for (const reason of verdict.reasons)
      causes.push(`reason=${SNAPSHOT_REASONS.has(reason) ? reason : 'unrecognized'}`);
  if (
    Array.isArray(verdict?.reasons) &&
    verdict.reasons.includes('snapshot-ref-freshness-unknown')
  ) {
    if (typeof observation.keyboardVisible !== 'boolean') causes.push('keyboard-state-unknown');
    if (
      typeof observation.snapshotGeneration !== 'number' ||
      !Number.isSafeInteger(observation.snapshotGeneration) ||
      observation.snapshotGeneration < 0
    )
      causes.push('snapshot-generation-unknown');
    if (isRecord(observation.presenceCapture))
      causes.push(
        ...presenceDiagnostics(observation.presenceCapture.diagnostics).filter(
          (cause) =>
            cause.startsWith('presence-failure=') || cause.startsWith('presence-deadline='),
        ),
      );
  }
  if (
    Array.isArray(observation.nodes) &&
    typeof verdict?.nodeCount === 'number' &&
    (observation.nodes.length === 0 || verdict.nodeCount !== observation.nodes.length)
  )
    causes.push('node-count-mismatch');
  return causes;
}

const SNAPSHOT_REASONS = new Set<unknown>(['empty-capture', 'snapshot-ref-freshness-unknown']);

function retryableEmptyCapture(observation: NativeObservation): boolean {
  const verdict = observation.snapshotVerdict;
  return (
    Array.isArray(observation.nodes) &&
    observation.nodes.length === 0 &&
    observation.truncated === false &&
    observation.normalizationDroppedNodes === 0 &&
    isRecord(verdict) &&
    verdict.state === 'degraded' &&
    verdict.nodeCount === 0 &&
    typeof verdict.refMapUpdated === 'boolean' &&
    Array.isArray(verdict.reasons) &&
    verdict.reasons.length === 1 &&
    verdict.reasons[0] === 'empty-capture'
  );
}

function retryablePresenceCapture(observation: NativeObservation): boolean {
  const verdict = observation.snapshotVerdict;
  const presence = observation.presenceCapture;
  return (
    Array.isArray(observation.nodes) &&
    observation.truncated === false &&
    observation.normalizationDroppedNodes === 0 &&
    observation.keyboardVisible === undefined &&
    typeof observation.snapshotGeneration === 'number' &&
    Number.isSafeInteger(observation.snapshotGeneration) &&
    observation.snapshotGeneration >= 0 &&
    isRecord(presence) &&
    presence.version === 2 &&
    presence.complete === false &&
    presence.generation === observation.snapshotGeneration &&
    isRecord(verdict) &&
    verdict.state === 'degraded' &&
    verdict.nodeCount === observation.nodes.length &&
    verdict.refMapUpdated === false &&
    Array.isArray(verdict.reasons) &&
    verdict.reasons.length === (observation.nodes.length === 0 ? 2 : 1) &&
    verdict.reasons.at(-1) === 'snapshot-ref-freshness-unknown' &&
    (observation.nodes.length > 0 || verdict.reasons[0] === 'empty-capture')
  );
}

const PRESENCE_PHASES = [
  'initial-eligibility',
  'preparation',
  'enumeration',
  'observation',
  'final-eligibility',
  'revalidation',
];
const PRESENCE_FAILURE_PHASES = new Set<unknown>([...PRESENCE_PHASES, 'finalization']);
const PRESENCE_FAILURE_REASONS = new Set<unknown>([
  'deadline',
  'read-unavailable',
  'ineligible',
  'node-limit',
  'enumeration-changed',
]);
const PRESENCE_READS = new Set<unknown>([
  'app-state',
  'alerts',
  'sheets',
  'root-snapshot',
  'preparation-poll',
  'enumeration',
  'observation-loop',
  'observation',
  'first-match',
  'all-matches',
  'candidate-snapshot',
  'candidate-hit',
  'post-hit-snapshot',
  'revalidation',
  'finalization',
]);

const boundedPresenceInteger = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

function presenceGeometry(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    !boundedPresenceInteger(value.changedMask, 15) ||
    !boundedPresenceInteger(value.beforeFiniteMask, 15) ||
    !boundedPresenceInteger(value.afterFiniteMask, 15) ||
    !boundedPresenceInteger(value.deltaFiniteMask, 15) ||
    (value.deltaFiniteMask & value.beforeFiniteMask & value.afterFiniteMask) !==
      value.deltaFiniteMask
  )
    return undefined;
  const geometry: Record<string, number | boolean> = {
    changedMask: value.changedMask,
    beforeFiniteMask: value.beforeFiniteMask,
    afterFiniteMask: value.afterFiniteMask,
    deltaFiniteMask: value.deltaFiniteMask,
  };
  for (const [index, key] of ['dx', 'dy', 'dWidth', 'dHeight'].entries()) {
    const delta = value[key];
    const bit = 1 << index;
    if ((value.deltaFiniteMask & bit) === 0) {
      if (delta !== undefined) return undefined;
      continue;
    }
    if (
      typeof delta !== 'number' ||
      !Number.isFinite(delta) ||
      ((value.changedMask & bit) === 0 ? delta !== 0 : delta === 0)
    )
      return undefined;
    geometry[key] = delta;
  }
  for (const key of [
    'beforeNull',
    'afterNull',
    'beforeInfinite',
    'afterInfinite',
    'beforeInvalidSize',
    'afterInvalidSize',
  ]) {
    const flag = value[key];
    if (typeof flag !== 'boolean') return undefined;
    geometry[key] = flag;
  }
  return JSON.stringify(geometry);
}

function presenceMismatch(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    !['descriptor-count', 'added-node', 'missing-node', 'node'].includes(value.kind)
  )
    return undefined;
  // Bits mirror PlatformPresenceDiagnostics.Mismatch.Field; no descriptor content crosses this boundary.
  if (
    !boundedPresenceInteger(value.fieldMask, 511) ||
    (value.kind === 'node' ? value.fieldMask === 0 : value.fieldMask !== 0)
  )
    return undefined;
  if (
    value.kind === 'descriptor-count'
      ? value.index !== undefined
      : !boundedPresenceInteger(value.index, 599)
  )
    return undefined;
  const fields = [`kind=${value.kind}`];
  for (const [key, max] of [
    ['index', 599],
    ['fieldMask', 511],
    ['beforeType', 65535],
    ['afterType', 65535],
  ] as const) {
    if (value[key] === undefined) continue;
    if (!boundedPresenceInteger(value[key], max)) return undefined;
    fields.push(`${key}=${value[key]}`);
  }
  if (value.geometry !== undefined) {
    if (value.kind !== 'node' || value.beforeType === undefined || value.afterType === undefined)
      return undefined;
    const geometry = presenceGeometry(value.geometry);
    if (!geometry) return undefined;
    fields.push(`geometry=${geometry}`);
  }
  if (value.ancestorTypes !== undefined || value.ancestorsTruncated !== undefined) {
    if (
      value.kind !== 'node' ||
      !Array.isArray(value.ancestorTypes) ||
      value.ancestorTypes.length > 16 ||
      typeof value.ancestorsTruncated !== 'boolean'
    )
      return undefined;
    const types: number[] = [];
    for (const type of value.ancestorTypes) {
      if (!boundedPresenceInteger(type, 65535)) return undefined;
      types.push(type);
    }
    fields.push(
      `ancestorTypes=${JSON.stringify(types)}`,
      `ancestorsTruncated=${value.ancestorsTruncated}`,
    );
  }
  return `presence-mismatch=${fields.join(',')}`;
}

function preparationSampleCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function presenceDiagnostics(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const causes: string[] = [];
  const modal = systemModalDiagnostic(value.systemModal);
  if (modal) causes.push(`presence-system-modal=${JSON.stringify(modal)}`);
  const { failure, deadline, phaseMs } = value;
  const samples = preparationSampleCount(value.preparationSamples);
  if (samples !== undefined) causes.push(`presence-preparation-samples=${samples}`);
  const resets = preparationSampleCount(value.preparationResets);
  const quietElapsed = value.preparationQuietElapsedMs;
  const preparationMs = isRecord(phaseMs) ? phaseMs.preparation : undefined;
  if (
    value.preparationQuietWindowMs === 500 &&
    samples !== undefined &&
    resets !== undefined &&
    resets <= Math.max(0, samples - 1) &&
    typeof quietElapsed === 'number' &&
    Number.isFinite(quietElapsed) &&
    quietElapsed >= 0 &&
    quietElapsed < NATIVE_PRESENCE_BUDGET_MS &&
    (samples >= 2 || quietElapsed === 0) &&
    typeof preparationMs === 'number' &&
    preparationMs >= quietElapsed &&
    preparationMs <= Number.MAX_SAFE_INTEGER
  )
    causes.push(
      'presence-preparation-quiet-window-ms=500',
      `presence-preparation-resets=${resets}`,
      `presence-preparation-quiet-elapsed-ms=${quietElapsed}`,
    );
  if (
    isRecord(failure) &&
    PRESENCE_FAILURE_PHASES.has(failure.phase) &&
    PRESENCE_FAILURE_REASONS.has(failure.reason)
  ) {
    causes.push(`presence-failure=${failure.phase}:${failure.reason}`);
    if (failure.phase === 'revalidation' && failure.reason === 'enumeration-changed') {
      const mismatch = presenceMismatch(failure.mismatch);
      if (mismatch) causes.push(mismatch);
    }
  }
  if (
    isRecord(deadline) &&
    PRESENCE_FAILURE_PHASES.has(deadline.phase) &&
    PRESENCE_READS.has(deadline.read) &&
    (deadline.edge === 'before' || deadline.edge === 'after')
  )
    causes.push(`presence-deadline=${deadline.phase}:${deadline.read}:${deadline.edge}`);
  if (isRecord(phaseMs))
    for (const phase of PRESENCE_PHASES) {
      const ms = phaseMs[phase];
      if (typeof ms === 'number' && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER)
        causes.push(`presence-${phase}-ms=${Math.round(ms)}`);
    }
  return causes;
}

function presenceCauses(
  capture: unknown,
  nodes: NativeNode[],
  evaluated: boolean,
  withinBudget: boolean,
  elapsed: number,
): string[] {
  if (!isRecord(capture)) return [];
  const { startedUptimeMs: started, endedUptimeMs: ended } = capture;
  const measured = [
    ...(typeof started === 'number' && typeof ended === 'number' && Number.isFinite(ended - started)
      ? [`presence-ms=${Math.round(ended - started)}`]
      : []),
    `nodes=${nodes.length}`,
    `reported-observed=${nodes.filter((node) => isRecord(node.presence) && node.presence.status === 'observed').length}`,
    ...presenceDiagnostics(capture.diagnostics),
  ];
  if (capture.complete !== true) return ['presence-incomplete', ...measured];
  if (!evaluated) return [];
  return [
    withinBudget ? 'presence-rejected' : 'capture-over-budget',
    ...measured,
    `capture-ms=${Math.round(elapsed)}`,
  ];
}

export function nativeCaptureCoverage(observation: NativeObservation): Coverage['native'] {
  const verdict = isRecord(observation.snapshotVerdict) ? observation.snapshotVerdict : undefined;
  if (nativeIncompleteCauses(observation).length > 0) return 'incomplete';
  return Array.isArray(observation.nodes) &&
    observation.nodes.length > 0 &&
    observation.truncated === false &&
    observation.normalizationDroppedNodes === 0 &&
    verdict?.state === 'ok' &&
    verdict.nodeCount === observation.nodes.length &&
    verdict.refMapUpdated === true &&
    Array.isArray(verdict.reasons) &&
    verdict.reasons.length === 0
    ? 'complete'
    : 'unknown';
}

export function nativeDevOverlayUncleared(observation: NativeObservation): boolean {
  const front = frontFromSurface(observation.surface, observation.nodes ?? []);
  return (
    nativeCaptureCoverage(observation) !== 'complete' || front === 'dev-fab' || front === 'dev-menu'
  );
}

function reactCaptureCoverage(observation: ReactObservation): Coverage['react'] {
  const verdict = isRecord(observation.verdict) ? observation.verdict : undefined;
  if (
    observation.truncated === true ||
    verdict?.state === 'failed' ||
    verdict?.state === 'degraded' ||
    verdict?.complete === false ||
    (typeof verdict?.path === 'string' && verdict.path !== 'interactive') ||
    (Array.isArray(verdict?.reasons) && verdict.reasons.length > 0)
  )
    return 'incomplete';
  return Array.isArray(observation.interactive) &&
    (observation.truncated === undefined || observation.truncated === false) &&
    verdict?.state === 'ok' &&
    verdict.path === 'interactive' &&
    verdict.complete === true
    ? 'complete'
    : 'unknown';
}

function reactCoverage(
  observation: ReactObservation,
  acquired: Coverage['react'],
  hostEvidence: ReactHostEvidence | undefined,
): Coverage['react'] {
  if (
    acquired === 'incomplete' ||
    (observation.hostEvidence !== undefined && !hostEvidence) ||
    hostEvidence?.complete === false
  )
    return 'incomplete';
  return acquired === 'complete' && hostEvidence?.complete === true ? 'complete' : 'unknown';
}

export async function captureScreen(deps: CaptureDeps): Promise<Screen> {
  try {
    return await capture(deps);
  } catch (error) {
    if (
      error instanceof NativeCaptureError ||
      error instanceof NativeSnapshotIncomplete ||
      error instanceof AppProcessGoneError
    )
      throw error;
    if (deps.requirePrivateInputs || error instanceof PrivateInputCaptureError)
      throw new PrivateInputCaptureError();
    throw error;
  }
}

async function capture(deps: CaptureDeps): Promise<Screen> {
  const observation =
    typeof deps.observation === 'number' &&
    Number.isSafeInteger(deps.observation) &&
    deps.observation > 0
      ? deps.observation
      : null;
  const mode = deps.platformPresence === true ? 'platform-presence' : 'ordinary';
  const now = deps.now ?? (() => performance.now());
  const started = now();
  let presenceBudgetMs = NATIVE_PRESENCE_BUDGET_MS;
  let native: NativeObservation = {};
  let retryDeadline: number | undefined;
  for (;;) {
    let runnerDown = false;
    try {
      native = await measureTiming(deps.timing, now, 'native-total', () =>
        retryDeadline === undefined
          ? deps.native(presenceBudgetMs)
          : withDeadline(
              performance.now() + Math.max(0, retryDeadline - now()),
              new NativeCaptureError(),
              () => deps.native(presenceBudgetMs),
            ),
      );
    } catch (error) {
      if (error instanceof AppProcessGoneError) throw error;
      if (!deps.requirePrivateInputs) throw error;
      if (
        !(error instanceof HandlerError) ||
        error.code !== 'RN_FAST_RUNNER_DOWN' ||
        error.meta?.runnerRelaunch !== true
      )
        throw new NativeCaptureError();
      runnerDown = true;
    }
    if (
      !runnerDown &&
      (!deps.requirePrivateInputs ||
        !(
          retryableEmptyCapture(native) ||
          (deps.platformPresence === true && retryablePresenceCapture(native))
        ))
    )
      break;
    const at = now();
    retryDeadline ??= Math.min(at + SETTLE_DEFAULT_BUDGET_MS, started + CAPTURE_BUDGET_MS);
    const remaining = retryDeadline - at;
    if (!(remaining > 0)) {
      if (runnerDown) throw new NativeCaptureError();
      break;
    }
    await sleep(Math.min(WAIT_POLL_MS, remaining));
    const readBudget = Math.floor(retryDeadline - now());
    if (!(readBudget > 0)) {
      if (runnerDown) throw new NativeCaptureError();
      break;
    }
    presenceBudgetMs = Math.min(NATIVE_PRESENCE_BUDGET_MS, readBudget);
  }
  if (deps.timing) observeNativeTiming(native.presenceCapture, deps.timing, now());
  if (deps.warn) {
    try {
      for (const cause of presenceDiagnostics({ systemModal: native.systemModal }))
        deps.warn(cause);
    } catch {
      /* Diagnostics cannot change capture admission. */
    }
  }
  if (deps.warn && isRecord(native.presenceCapture)) {
    try {
      for (const cause of presenceDiagnostics(native.presenceCapture.diagnostics)) {
        if (
          cause.startsWith('presence-failure=') ||
          cause.startsWith('presence-deadline=') ||
          cause.startsWith('presence-mismatch=') ||
          cause.startsWith('presence-preparation-')
        )
          deps.warn(cause);
      }
    } catch {
      // Diagnostics cannot change capture admission or failure.
    }
  }
  let react: ReactObservation = {};
  let reactWarning: string | undefined;
  let reactConnection: Screen['reactConnection'];
  try {
    react = await measureTiming(deps.timing, now, 'react-private', () => deps.react());
    if (react.reconnected === true) reactConnection = 'reconnected';
  } catch (error) {
    if (error instanceof ReactCaptureIncomplete && error.reason === 'disconnected')
      reactConnection = 'lost';
    if (error instanceof ReactCaptureIncomplete && error.reason === 'reconnected')
      reactConnection = 'reconnected';
    // The native snapshot carries privacy, so a missing digest only loses semantics.
    const detail = error instanceof ReactCaptureIncomplete ? ` (${error.detail})` : '';
    reactWarning = `interactive digest unavailable${detail}; React coverage is unknown`;
  }
  const joinedAt = deps.timing ? now() : 0;
  observeTiming(deps.timing, { stage: 'join-private', edge: 'start', outcome: 'ok', at: joinedAt });
  let joined = false;
  try {
    const nodes = Array.isArray(native.nodes) ? native.nodes : [];
    const digest = Array.isArray(react.interactive) ? react.interactive : [];
    const captureCoverage: Coverage = {
      native: nativeCaptureCoverage(native),
      react: reactCaptureCoverage(react),
    };
    // Privacy comes from the native tree, so one not proven complete cannot be masked safely.
    if (deps.requirePrivateInputs && captureCoverage.native !== 'complete')
      throw new NativeSnapshotIncomplete(
        nodes.length,
        captureCoverage.native === 'unknown' ? ['unattested'] : nativeIncompleteCauses(native),
      );
    const hostEvidence = validateReactHostEvidence(react.hostEvidence);
    const nativePresence =
      captureCoverage.native === 'complete'
        ? validateNativePresence(
            native.presenceCapture,
            nodes,
            native.snapshotGeneration,
            deps.appId,
            presenceBudgetMs,
          )
        : undefined;
    if (deps.timing && isRecord(native.presenceCapture)) {
      observeTiming(deps.timing, {
        stage: 'native-presence-v2',
        edge: 'point',
        outcome: nativePresence ? 'ok' : 'unknown',
        at: now(),
        budgetMs: presenceBudgetMs,
        ...(typeof native.presenceCapture.appliedBudgetMs === 'number'
          ? { appliedBudgetMs: native.presenceCapture.appliedBudgetMs }
          : {}),
      });
    }
    const screen = applyNativePrivateInputs(
      {
        ...join(
          nodes,
          digest,
          frontFromSurface(native.surface, nodes),
          {
            native: nativePresence
              ? 'complete'
              : captureCoverage.native === 'incomplete' || native.presenceCapture !== undefined
                ? 'incomplete'
                : 'unknown',
            react: reactCoverage(react, captureCoverage.react, hostEvidence),
          },
          hostEvidence,
          nativePresence ?? (native.presenceCapture !== undefined ? 'unknown' : undefined),
        ),
        captureCoverage,
        ...(react.renderError === true ? { renderError: true } : {}),
        ...(reactConnection ? { reactConnection } : {}),
      },
      nodes,
    );
    const elapsed = now() - started;
    const withinBudget =
      Number.isFinite(started) && started >= 0 && elapsed >= 0 && elapsed < CAPTURE_BUDGET_MS;
    if (!withinBudget) {
      screen.coverage!.native = 'incomplete';
      // Preserve screen/element identities: private observations are weak-map bound.
      for (const element of screen.elements) delete element.semantic;
    }
    const nativeCaptureCauses = [
      ...nativeIncompleteCauses(native),
      ...(nativePresence && withinBudget
        ? []
        : presenceCauses(
            native.presenceCapture,
            nodes,
            captureCoverage.native === 'complete',
            withinBudget,
            elapsed,
          )),
    ];
    if (!withinBudget && !nativeCaptureCauses.includes('capture-over-budget'))
      nativeCaptureCauses.push('capture-over-budget');
    if (nativeCaptureCauses.length > 0) screen.nativeCaptureCauses = nativeCaptureCauses;
    if (
      Number.isSafeInteger(native.appProcessIdentifier) &&
      (native.appProcessIdentifier as number) > 0
    )
      screen.appProcessIdentifier = native.appProcessIdentifier as number;
    if (typeof native.keyboardVisible === 'boolean')
      screen.keyboardVisible = native.keyboardVisible;
    if (deps.warn) {
      const warn = deps.warn;
      quotedTargetDiagnostics.set(screen, (quoted, line) => {
        const outside = outsideViewport(nodes);
        const depth = (node: NativeNode) =>
          typeof node.depth === 'number' && Number.isSafeInteger(node.depth) && node.depth >= 0
            ? node.depth
            : null;
        const matches = nodes.flatMap((node, index) => {
          if (node.identifier !== quoted && node.label !== quoted) return [];
          const rect = node.rect;
          const frame =
            rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null;
          return [
            {
              index,
              identifier: node.identifier === quoted,
              label: node.label === quoted,
              frame,
              depth: depth(node),
              hittable: typeof node.hittable === 'boolean' ? node.hittable : null,
              insideTrustedViewport:
                frame && clippingViewport(outside, index) ? !outside.has(index) : null,
            },
          ];
        });
        warn(
          `quoted-target=${JSON.stringify({
            line,
            matches,
            deepestCapturedDepth: nodes.reduce<number | null>((deepest, node) => {
              const d = depth(node);
              return d === null ? deepest : Math.max(deepest ?? 0, d);
            }, null),
          })}`,
        );
      });
    }
    if (deps.warn && captureCoverage.native === 'complete' && withinBudget) {
      const warn = deps.warn;
      captureDiagnostics.set(screen, () => {
        try {
          const truncated = diagnosticField(native, 'truncated');
          const dropped = diagnosticField(native, 'normalizationDroppedNodes');
          const verdict = diagnosticField(native.snapshotVerdict, 'state');
          warn(
            viewportDiagnostic(nodes, outsideViewport(nodes), {
              observation,
              mode,
              native: {
                acquisition: 'returned',
                coverage: captureCoverage.native,
                truncated: typeof truncated === 'boolean' ? truncated : null,
                normalizationDroppedNodes:
                  typeof dropped === 'number' && Number.isSafeInteger(dropped) && dropped >= 0
                    ? dropped
                    : null,
                verdict:
                  verdict === 'ok' || verdict === 'degraded' || verdict === 'failed'
                    ? verdict
                    : null,
                reasons: nativeIncompleteCauses(native).filter((cause) =>
                  cause.startsWith('reason='),
                ),
              },
              snapshot: privateSnapshotDiagnostics(diagnosticField(native, 'snapshotDiagnostics')),
              projection: joinedSnapshotDiagnostics(screen),
            }),
          );
        } catch {}
        try {
          const reasons = sensitivePixelsReasons(screen, nodes);
          if (reasons) warn(reasons);
        } catch {}
      });
    }
    joined = true;
    return screen;
  } finally {
    if (deps.timing) {
      const at = now();
      observeTiming(deps.timing, {
        stage: 'join-private',
        edge: 'end',
        outcome: joined ? 'ok' : 'failed',
        at,
        ms: at - joinedAt,
      });
    }
    if (reactWarning && deps.warn) {
      try {
        deps.warn(`${reactWarning}; observation=${observation} mode=${mode}`);
      } catch {}
    }
  }
}

function observeNativeTiming(capture: unknown, observer: TimingObserver, at: number): void {
  if (!isRecord(capture)) return;
  const outcome = capture.complete === true ? 'ok' : 'failed';
  if (typeof capture.startedUptimeMs === 'number' && typeof capture.endedUptimeMs === 'number')
    observeTiming(observer, {
      stage: 'native-production',
      edge: 'point',
      outcome,
      at,
      ms: capture.endedUptimeMs - capture.startedUptimeMs,
    });
  const diagnostics = isRecord(capture.diagnostics) ? capture.diagnostics : undefined;
  const phases = isRecord(diagnostics?.phaseMs) ? diagnostics.phaseMs : {};
  const samples = preparationSampleCount(diagnostics?.preparationSamples);
  for (const phase of PRESENCE_PHASES) {
    if (typeof phases[phase] === 'number')
      observeTiming(observer, {
        stage: `native-${phase}` as TimingStage,
        edge: 'point',
        outcome,
        at,
        ms: phases[phase],
        ...(phase === 'preparation' && samples !== undefined ? { count: samples } : {}),
      });
  }
}
