import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import {
  cancellableFetch,
  interruptible,
  withCancellation,
  withDeadline,
  isAbort,
  sleep,
} from '../domain/cancellation.js';
import {
  BundleReadinessTimeoutError,
  TargetReadinessTimeoutError,
  TargetListAttemptTimeoutError,
  TargetSelectionError,
  type PlatformInferenceSummary,
} from '../cdp/discovery.js';
import {
  CDPProbeTimeoutError,
  CDPHandshakeTimeoutError,
  CDPTargetClosedError,
} from '../cdp/connect.js';
import { REACT_READY_POLL_MS } from '../cdp/setup.js';
import { CDPRequestTimeoutError } from '../cdp/transport.js';
import { REACT_READY_PROBE_JS } from '../injected-helpers.js';
import { HandlerError, describeError } from './adapt.js';
import type { ProveOutcome } from './prove.js';
import {
  ADMISSION_BOUNDARIES,
  ADMISSION_DECISIONS,
  ADMISSION_INNER_CLASSES,
  ADMISSION_LIVENESS,
  ADMISSION_BUNDLE_REQUESTS,
  type TimingEvent,
} from './timing.js';

export interface AdmissionSteps {
  metroPort: number;
  readinessMs: number;
  // After this long, a stall from a dead app or with no bundle request since launch refuses.
  attachBudgetMs: number;
  remainingMs(): number;
  attach(deadline: number): Promise<void>;
  // Inside the attach deadline: the attached client must have run its bundle before anything reads it.
  bundleReady?(deadline: number): Promise<void>;
  // A no-target stall relaunches each readiness window until the attach budget, any other stall once; it may wait until the deadline.
  relaunch?(deadline: number): Promise<void>;
  // Before relaunching without a target, preserve a live app with a bundle request.
  appAlive?(): Promise<boolean>;
  // No request permits relaunch; a received request does not prove that a bundle finished loading.
  bundleRequested?(): Promise<boolean | undefined>;
  foreignDriver(): Promise<string | undefined>;
  open(): Promise<void>;
  prove(): Promise<ProveOutcome>;
  close(): Promise<void>;
  load?(): number;
  // Value-free facts at each retry decision and when admission ends without a proof.
  observe?(decision: AdmissionDecision, facts: AdmissionRefusalFacts): void;
}

type Proven = Extract<ProveOutcome, { ok: true }>;

export type AdmissionBoundary = (typeof ADMISSION_BOUNDARIES)[number];
export type AdmissionInnerClass = (typeof ADMISSION_INNER_CLASSES)[number];
export type AdmissionLiveness = (typeof ADMISSION_LIVENESS)[number];
export type AdmissionDecision = (typeof ADMISSION_DECISIONS)[number];

export type AdmissionRefusalFacts = {
  attempt: number;
  lastStarted: AdmissionBoundary;
  lastCompleted: AdmissionBoundary | 'none';
  inner: AdmissionInnerClass;
  relaunches: number;
  relaunchFailed: boolean;
  liveness: AdmissionLiveness;
  bundleRequest?: (typeof ADMISSION_BUNDLE_REQUESTS)[number];
  elapsedMs: number;
  remainingMs: number;
  budgetMs: number;
  inference?: PlatformInferenceSummary;
};

// Classified by type only; an error's message or name never reaches the record.
export function admissionInnerClass(error: unknown): AdmissionInnerClass {
  if (error instanceof TargetSelectionError) {
    switch (error.code) {
      case 'TARGET_PLATFORM_CONFLICT':
        return 'target_selection_platform_conflict';
      case 'DEVICE_TARGET_NOT_FOUND':
        return 'target_selection_device_not_found';
      case 'DEVICE_TARGET_AMBIGUOUS':
        return 'target_selection_device_ambiguous';
      case 'BUNDLE_TARGET_NOT_FOUND':
        return 'target_selection_bundle_not_found';
      case 'PLATFORM_TARGET_NOT_FOUND':
        return 'target_selection_platform_not_found';
    }
  }
  if (error instanceof TargetListAttemptTimeoutError) return 'target_list_attempt_timeout';
  if (error instanceof BundleReadinessTimeoutError) return 'bundle_readiness_timeout';
  if (error instanceof TargetReadinessTimeoutError && error.state === 'empty')
    return 'target_list_empty';
  if (error instanceof TargetReadinessTimeoutError && error.state === 'other_device')
    return 'target_other_device';
  if (error instanceof TargetReadinessTimeoutError) return 'target_readiness_timeout';
  if (error instanceof CDPProbeTimeoutError) return 'cdp_probe_timeout';
  if (error instanceof CDPHandshakeTimeoutError) return 'cdp_handshake_timeout';
  if (error instanceof CDPTargetClosedError) return 'cdp_target_closed';
  if (error instanceof CDPRequestTimeoutError) return 'cdp_request_timeout';
  return 'untyped';
}

const TARGET_FIELDS = {
  token: ['ios', 'android', 'none'],
  name: ['absent', 'neither', 'ios_only', 'android_only', 'both', 'not_reached'],
  identity: ['present', 'missing', 'not_reached'],
  packages: ['neither', 'ios_only', 'android_only', 'both', 'not_reached'],
  confidence: ['probed', 'defaulted', 'ambiguous'],
} as const;
const READER_OUTCOMES = ['not_consumed', 'null', 'empty', 'nonempty'] as const;
const READERS = [
  'androidPackages',
  'iosPackages',
  'iosDeviceNames',
  'androidDeviceModels',
] as const;
const MAX_RECORDED_TARGETS = 8;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const member = (value: unknown, allowed: readonly string[]): string =>
  typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
const count = (value: unknown): number | 'unknown' =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 'unknown';
const flag = (value: unknown): boolean | 'unknown' =>
  typeof value === 'boolean' ? value : 'unknown';

// Rebuilds the record from allowlisted keys and values only, so no producer can leak a string through it.
export function formatAdmissionRefusal(
  meta: unknown,
  attachStage?: 'wait_targets' | 'connect_exact',
): string {
  const facts = isObject(meta) ? meta : {};
  const lastStarted = member(facts.lastStarted, ADMISSION_BOUNDARIES);
  const record: Record<string, unknown> = {
    attempt: count(facts.attempt),
    lastStarted,
    lastCompleted: member(facts.lastCompleted, [...ADMISSION_BOUNDARIES, 'none']),
    ...(lastStarted === 'attach' && attachStage !== undefined
      ? { attachStage: member(attachStage, ['wait_targets', 'connect_exact']) }
      : {}),
    inner: member(facts.inner, ADMISSION_INNER_CLASSES),
    relaunches: count(facts.relaunches),
    relaunchFailed: flag(facts.relaunchFailed),
    liveness: member(facts.liveness, ADMISSION_LIVENESS),
    ...(facts.bundleRequest === undefined
      ? {}
      : { bundleRequest: member(facts.bundleRequest, ADMISSION_BUNDLE_REQUESTS) }),
    elapsedMs: count(facts.elapsedMs),
    remainingMs: count(facts.remainingMs),
    budgetMs: count(facts.budgetMs),
  };
  if (isObject(facts.inference)) {
    const readers = isObject(facts.inference.readers) ? facts.inference.readers : {};
    const targets = Array.isArray(facts.inference.targets) ? facts.inference.targets : [];
    record.inference = {
      readers: Object.fromEntries(
        READERS.map((key) => [key, member(readers[key], READER_OUTCOMES)]),
      ),
      targetsTotal: targets.length,
      targets: targets.slice(0, MAX_RECORDED_TARGETS).map((entry: unknown) => {
        const target = isObject(entry) ? entry : {};
        return {
          ...Object.fromEntries(
            Object.entries(TARGET_FIELDS).map(([key, allowed]) => [
              key,
              member(target[key], allowed),
            ]),
          ),
          ...(target.deviceMatch === undefined ? {} : { deviceMatch: flag(target.deviceMatch) }),
          ...(target.bundleMatch === undefined ? {} : { bundleMatch: flag(target.bundleMatch) }),
        };
      }),
    };
  }
  return JSON.stringify(record);
}

export function logAdmissionRefusal(
  error: unknown,
  attachStage: 'wait_targets' | 'connect_exact' | undefined,
  log: (message: string) => void,
): void {
  if (!(error instanceof HandlerError && error.meta)) return;
  try {
    log(`admission-refusal=${formatAdmissionRefusal(error.meta, attachStage)}`);
  } catch {
    // Diagnostics cannot change the refusal.
  }
}

export function admissionMetric(
  decision: AdmissionDecision,
  facts: AdmissionRefusalFacts,
  attachStage: 'wait_targets' | 'connect_exact' | undefined,
  at: number,
): TimingEvent {
  const { inference: _inference, ...rest } = facts;
  return {
    stage: 'admission',
    edge: 'point',
    outcome: decision === 'retry' ? 'unknown' : 'failed',
    at,
    admission: decision,
    ...(facts.lastStarted === 'attach' && attachStage !== undefined ? { attachStage } : {}),
    ...rest,
  };
}

function transientReadinessFailure(error: unknown): boolean {
  return (
    error instanceof TargetReadinessTimeoutError ||
    error instanceof CDPProbeTimeoutError ||
    error instanceof CDPHandshakeTimeoutError ||
    error instanceof CDPTargetClosedError ||
    error instanceof CDPRequestTimeoutError
  );
}

// iOS simulators share host loopback, so a sibling's runtime registers on the run's Metro; Android's Metro device name is a model, not the serial.
export function metroDevicePin(
  platform: 'ios' | 'android',
  deviceName: string,
): string | undefined {
  return platform === 'ios' ? deviceName.trim() : undefined;
}

// A first launch can attach while Metro still builds the bundle; React readiness, not a fixed wait, gates the proof.
export async function awaitBundleReady(
  evaluate: (expression: string) => Promise<{ value?: unknown }>,
  deadline: number,
  pollMs = REACT_READY_POLL_MS,
): Promise<void> {
  for (;;) {
    try {
      if ((await interruptible(() => evaluate(REACT_READY_PROBE_JS))).value === true) return;
    } catch (error) {
      if (isAbort(error) || error instanceof CDPTargetClosedError) throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new TargetReadinessTimeoutError('React never became ready on the attached client');
    await sleep(Math.min(pollMs, remaining));
  }
}

export interface BundleReloadSteps {
  evaluate(expression: string): Promise<{ value?: unknown; error?: string }>;
  // The walk's injected helpers, injected again into the replacement runtime within the deadline.
  reinjectHelpers(waitMs: number): Promise<boolean>;
  // The admission origin proof, read again on the reloaded bundle.
  prove(): Promise<ProveOutcome>;
  remainingMs(): number;
  pollMs?: number;
}

// The runtime a reload replaces carries the mark; its replacement starts without it.
// The mark is a hex nonce, so it needs no quoting inside the evaluated expression.
const markBundleExpression = (mark: string) =>
  `(function () { globalThis.__QAREN_BUNDLE_MARK = '${mark}'; return globalThis.__QAREN_BUNDLE_MARK; })()`;
const bundleMarkedExpression = (mark: string) => `globalThis.__QAREN_BUNDLE_MARK === '${mark}'`;

// A reload is over once the marked runtime is gone, React is ready in its replacement, the walk helpers are back and that bundle passes the origin proof.
export function createBundleReload(steps: BundleReloadSteps): {
  mark(): Promise<void>;
  settled(): Promise<void>;
} {
  const mark = randomUUID().replaceAll('-', '');
  const pollMs = steps.pollMs ?? REACT_READY_POLL_MS;
  const replaced = async (deadline: number): Promise<void> => {
    for (;;) {
      try {
        const answer = await interruptible(() => steps.evaluate(bundleMarkedExpression(mark)));
        if (answer.value === false) return;
      } catch (error) {
        if (isAbort(error)) throw error;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new TargetReadinessTimeoutError('the dev client never reloaded its bundle');
      await sleep(Math.min(pollMs, remaining));
    }
  };
  return {
    async mark() {
      const answer = await interruptible(() => steps.evaluate(markBundleExpression(mark)));
      if (answer.value !== mark)
        throw new HandlerError(
          'CDP_NOT_CONNECTED',
          `the running bundle could not be marked before Fast Refresh was turned off (${answer.error ?? 'no answer'})`,
        );
    },
    async settled() {
      const deadline = performance.now() + steps.remainingMs();
      try {
        await withDeadline(
          deadline,
          new TargetReadinessTimeoutError('the reload did not finish before the attach deadline'),
          async () => {
            for (;;) {
              try {
                await replaced(deadline);
                await awaitBundleReady(steps.evaluate, deadline, pollMs);
                const waitMs = Math.max(1, deadline - performance.now());
                if (!(await interruptible(() => steps.reinjectHelpers(waitMs))))
                  throw new HandlerError(
                    'HELPERS_NOT_INJECTED',
                    'the walk helpers could not be injected into the reloaded bundle',
                  );
                const proof = await interruptible(steps.prove);
                if (!proof.ok) throw new HandlerError(proof.code, proof.message);
                return;
              } catch (error) {
                const remaining = deadline - performance.now();
                if (isAbort(error) || !transientReadinessFailure(error) || remaining <= 0)
                  throw error;
                await sleep(Math.min(pollMs, remaining));
              }
            }
          },
        );
      } catch (error) {
        if (isAbort(error) || error instanceof HandlerError) throw error;
        throw new HandlerError(
          'CDP_NOT_CONNECTED',
          `the Fast Refresh reload was not proven finished: ${describeError(error).message}`,
        );
      }
    },
  };
}

export async function admit(
  steps: AdmissionSteps,
  stop: { readonly signal: AbortSignal },
): Promise<Proven> {
  try {
    return await withCancellation(stop.signal, () => attach(steps, stop.signal));
  } catch (error) {
    await withCancellation(undefined, steps.close);
    stop.signal.throwIfAborted();
    throw error;
  }
}

async function refuseForeignDriver(steps: AdmissionSteps): Promise<void> {
  const foreign = await interruptible(steps.foreignDriver);
  if (foreign !== undefined) throw new HandlerError('BUSY_FOREIGN_FLOW', foreign);
}

async function probeLiveness(steps: AdmissionSteps): Promise<AdmissionLiveness> {
  if (!steps.appAlive) return 'not_probed';
  try {
    return (await interruptible(steps.appAlive)) ? 'alive' : 'dead';
  } catch (error) {
    if (isAbort(error)) throw error;
    return 'probe_failed';
  }
}

type BundleRequest = 'not_probed' | 'received' | 'not_received' | 'unknown' | 'probe_failed';

async function probeBundleRequest(steps: AdmissionSteps): Promise<BundleRequest> {
  if (!steps.bundleRequested) return 'unknown';
  try {
    const requested = await interruptible(steps.bundleRequested);
    return requested === undefined ? 'unknown' : requested ? 'received' : 'not_received';
  } catch (error) {
    if (isAbort(error)) throw error;
    return 'probe_failed';
  }
}

type ReadCount = (path: string) => string;
const readCountFile: ReadCount = (path) => readFileSync(path, 'utf8');

function bundleRequestCount(path: string, read: ReadCount): number | undefined {
  let text: string;
  try {
    text = read(path).trim();
  } catch {
    return undefined;
  }
  if (!/^\d+$/.test(text)) return undefined;
  const count = Number(text);
  return Number.isSafeInteger(count) ? count : undefined;
}

export function bundleRequestedSinceLaunch(
  signal: { path: string; atLaunch: number },
  read: ReadCount = readCountFile,
): boolean | undefined {
  const count = bundleRequestCount(signal.path, read);
  if (count === undefined || count < signal.atLaunch) return undefined;
  return count > signal.atLaunch;
}

// Request evidence belongs to the latest launch; an unreadable count at relaunch leaves it unknown.
export function launchBundleRequests(
  signal: { path: string; atLaunch: number },
  read: ReadCount = readCountFile,
): { requested(): boolean | undefined; relaunching(): void } {
  let atLaunch: number | undefined = signal.atLaunch;
  return {
    requested: () =>
      atLaunch === undefined
        ? undefined
        : bundleRequestedSinceLaunch({ path: signal.path, atLaunch }, read),
    relaunching: () => {
      atLaunch = bundleRequestCount(signal.path, read);
    },
  };
}

// The dev client opens this run's own Metro, never a server its launcher remembers.
export const devClientLaunchUrl = (target: { metroUrlForDevice: string }): string =>
  `${target.metroUrlForDevice}/?disableOnboarding=1`;

// The dev client waits this long for each manifest answer, then stays on its launcher without requesting a bundle.
export const DEV_CLIENT_REQUEST_TIMEOUT_MS = 10_000;

// Like the CLI's launch: (re)launch only once Metro answers the dev client's own manifest request in time.
export async function awaitDevClientManifest(
  url: string,
  deadline: number,
): Promise<{ ms: number; attempts: number }> {
  let attempts = 0;
  let ms: number | undefined;
  while (performance.now() < deadline) {
    attempts++;
    const startedAt = performance.now();
    let response: Response | undefined;
    try {
      response = await cancellableFetch(fetch, url, {
        headers: { 'expo-platform': 'ios', accept: 'application/expo+json,application/json' },
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - startedAt))),
      });
      await response.arrayBuffer();
    } catch (error) {
      if (isAbort(error)) throw error;
      if ((error as { name?: unknown } | null)?.name !== 'TimeoutError')
        throw new Error(`dev client manifest request failed: ${describeError(error).message}`);
      response = undefined;
    }
    ms = Math.round(performance.now() - startedAt);
    if (response && !response.ok)
      throw new Error(`dev client manifest answered HTTP ${response.status}`);
    if (response && ms < DEV_CLIENT_REQUEST_TIMEOUT_MS) return { ms, attempts };
  }
  throw new Error(
    `dev client manifest never answered inside the dev client's ${DEV_CLIENT_REQUEST_TIMEOUT_MS / 1000}s request timeout: ${ms === undefined ? 'no request' : `last ${ms} ms`} after ${attempts} attempts`,
  );
}

async function attach(steps: AdmissionSteps, signal: AbortSignal): Promise<Proven> {
  const started = performance.now();
  const deadline = started + steps.remainingMs();
  const refuseStalledAt = started + steps.attachBudgetMs;
  const relaunchAt = started + steps.readinessMs;
  let relaunches = 0;
  let nextNoTargetProbe = started;
  // first probe/handshake timeout against a registered target; it gets a full readiness window before a relaunch
  let stallSeenAt: number | undefined;
  let liveness: AdmissionLiveness = 'not_probed';
  let bundleRequest: BundleRequest = 'not_probed';
  let opened = false;
  let attaching = true;
  let relaunchFailure: string | undefined;
  let attempt = 0;
  let lastStarted: AdmissionBoundary = 'attach';
  let lastCompleted: AdmissionBoundary | 'none' = 'none';
  let retried: unknown;
  const attachTimeout = new CDPProbeTimeoutError('CDP attach deadline exceeded');
  const facts = (inner: AdmissionInnerClass): AdmissionRefusalFacts => {
    const now = performance.now();
    return {
      attempt,
      lastStarted,
      lastCompleted,
      inner,
      relaunches,
      relaunchFailed: relaunchFailure !== undefined,
      liveness,
      ...(bundleRequest === 'not_probed' ? {} : { bundleRequest }),
      elapsedMs: Math.round(now - started),
      remainingMs: Math.max(0, Math.round(deadline - now)),
      budgetMs: Math.round(deadline - started),
    };
  };
  const observe = (decision: AdmissionDecision, recorded: AdmissionRefusalFacts): void => {
    try {
      steps.observe?.(decision, recorded);
    } catch {
      // Diagnostics cannot change the admission.
    }
  };
  let cancellationObserved = false;
  const observeCancellation = (): void => {
    if (cancellationObserved) return;
    cancellationObserved = true;
    observe('cancelled', facts(retried === undefined ? 'none' : admissionInnerClass(retried)));
  };
  signal.addEventListener('abort', observeCancellation, { once: true });
  try {
    if (signal.aborted) observeCancellation();
    return await withDeadline(deadline, attachTimeout, async () => {
      for (;;) {
        attempt++;
        try {
          attaching = true;
          lastStarted = 'attach';
          await steps.attach(deadline);
          lastCompleted = 'attach';
          if (steps.bundleReady) {
            lastStarted = 'bundle_ready';
            await steps.bundleReady(deadline);
            lastCompleted = 'bundle_ready';
          }
          attaching = false;
          if (!opened) {
            lastStarted = 'foreign_driver';
            await refuseForeignDriver(steps);
            lastCompleted = 'foreign_driver';
            lastStarted = 'open';
            await interruptible(steps.open);
            lastCompleted = 'open';
            opened = true;
          }
          lastStarted = 'prove';
          const proof = await interruptible(steps.prove);
          lastCompleted = 'prove';
          if (!proof.ok) throw new HandlerError(proof.code, proof.message);
          return proof;
        } catch (error) {
          if (isAbort(error)) throw error;
          const remaining = Math.min(deadline - performance.now(), steps.remainingMs());
          if (
            error instanceof BundleReadinessTimeoutError ||
            !transientReadinessFailure(error) ||
            remaining <= 0
          )
            throw error;
          retried = error;
          const stalledAttach =
            lastStarted === 'attach' && error instanceof TargetReadinessTimeoutError;
          const noTarget = stalledAttach && !(error instanceof TargetListAttemptTimeoutError);
          const probeStall =
            error instanceof CDPProbeTimeoutError || error instanceof CDPHandshakeTimeoutError;
          if (probeStall && stallSeenAt === undefined) stallSeenAt = performance.now();
          const recoveryWaitExpired =
            noTarget ||
            (probeStall &&
              stallSeenAt !== undefined &&
              performance.now() >= Math.max(relaunchAt, stallSeenAt + steps.readinessMs));
          let probed = false;
          if (
            !opened &&
            (relaunches === 0 || (noTarget && performance.now() < refuseStalledAt)) &&
            (!noTarget || performance.now() >= nextNoTargetProbe) &&
            steps.relaunch &&
            remaining >= steps.readinessMs &&
            recoveryWaitExpired
          ) {
            const completed = lastCompleted;
            lastStarted = 'foreign_driver';
            await refuseForeignDriver(steps);
            lastCompleted = 'foreign_driver';
            if (noTarget) {
              liveness = await probeLiveness(steps);
              if (liveness === 'alive') bundleRequest = await probeBundleRequest(steps);
              probed = true;
              nextNoTargetProbe = performance.now() + steps.readinessMs;
            }
            if (!noTarget || liveness !== 'alive' || bundleRequest === 'not_received') {
              relaunches++;
              try {
                lastStarted = 'relaunch';
                const relaunch = steps.relaunch;
                const until = Math.max(refuseStalledAt, performance.now() + steps.readinessMs);
                await interruptible(() => relaunch(until));
                lastCompleted = 'relaunch';
                bundleRequest = 'not_probed';
                nextNoTargetProbe = performance.now() + steps.readinessMs;
              } catch (relaunchError) {
                if (isAbort(relaunchError)) throw relaunchError;
                relaunchFailure = describeError(relaunchError).message;
                throw error;
              }
            } else {
              lastStarted = 'attach';
              lastCompleted = completed;
            }
          }
          if (stalledAttach && lastStarted !== 'relaunch' && performance.now() >= refuseStalledAt) {
            if (!probed) {
              liveness = await probeLiveness(steps);
              if (liveness !== 'dead' && bundleRequest !== 'received' && steps.bundleRequested)
                bundleRequest = await probeBundleRequest(steps);
            }
            if (liveness === 'dead' || bundleRequest === 'not_received') throw error;
          }
          observe('retry', facts(admissionInnerClass(error)));
          lastStarted = 'retry_wait';
          await sleep(Math.min(REACT_READY_POLL_MS, remaining));
          lastCompleted = 'retry_wait';
        }
      }
    });
  } catch (error) {
    if (isAbort(error)) {
      observeCancellation();
      throw error;
    }
    if (error instanceof HandlerError) throw error;
    if (!attaching && !transientReadinessFailure(error)) throw error;
    const load = (steps.load ?? (() => loadavg()[0]))();
    const boundary = facts('none').lastStarted;
    const inner = admissionInnerClass(
      error === attachTimeout && (boundary === 'attach' || boundary === 'retry_wait')
        ? (retried ?? error)
        : error,
    );
    let refusal: AdmissionRefusalFacts | undefined;
    try {
      refusal = {
        ...facts(inner),
        ...(error instanceof TargetSelectionError && error.inference
          ? { inference: error.inference }
          : {}),
      };
      observe('refused', refusal);
    } catch {
      // Diagnostics cannot change the refusal.
    }
    throw new HandlerError(
      'CDP_NOT_CONNECTED',
      `cannot attach to the dev client through Metro ${steps.metroPort}: ${describeError(error).message} (observed ${refusal?.lastStarted ?? lastStarted}: ${inner}; app ${liveness}; bundle request ${bundleRequest}; host 1-minute load ${load.toFixed(1)}${relaunchFailure === undefined ? '' : `; relaunch failed: ${relaunchFailure}`})`,
      refusal,
    );
  } finally {
    signal.removeEventListener('abort', observeCancellation);
  }
}
