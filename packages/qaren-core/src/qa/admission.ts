import { randomUUID } from 'node:crypto';
import { loadavg } from 'node:os';
import {
  interruptible,
  withCancellation,
  withDeadline,
  isAbort,
  sleep,
} from '../domain/cancellation.js';
import { TargetReadinessTimeoutError } from '../cdp/discovery.js';
import { CDPProbeTimeoutError, CDPHandshakeTimeoutError } from '../cdp/connect.js';
import { REACT_READY_POLL_MS } from '../cdp/setup.js';
import { REACT_READY_PROBE_JS } from '../injected-helpers.js';
import { HandlerError, describeError } from './adapt.js';
import type { ProveOutcome } from './prove.js';

export const LOAD_ENVELOPE = 10;

export interface AdmissionSteps {
  metroPort: number;
  readinessMs: number;
  remainingMs(): number;
  attach(deadline: number): Promise<void>;
  // Inside the attach deadline: the attached client must have run its bundle before anything reads it.
  bundleReady?(deadline: number): Promise<void>;
  // A launch stuck on the dev-launcher never recovers by waiting: the one retry relaunches first.
  relaunch?(): Promise<void>;
  foreignDriver(): Promise<string | undefined>;
  open(): Promise<void>;
  prove(): Promise<ProveOutcome>;
  close(): Promise<void>;
  load?(): number;
}

type Proven = Extract<ProveOutcome, { ok: true }>;

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
      if (isAbort(error)) throw error;
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
  // The admission readiness deadline, taken when the reload starts.
  deadline(): number;
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
      const deadline = steps.deadline();
      try {
        await withDeadline(
          deadline,
          new TargetReadinessTimeoutError('the reload did not finish before the attach deadline'),
          async () => {
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
    return await withCancellation(stop.signal, async () => {
      await attach(steps);
      await refuseForeignDriver(steps);
      await interruptible(steps.open);
      const proof = await interruptible(steps.prove);
      if (!proof.ok) throw new HandlerError(proof.code, proof.message);
      return proof;
    });
  } catch (error) {
    await withCancellation(undefined, steps.close);
    stop.signal.throwIfAborted();
    throw error;
  }
}

async function attachReady(steps: AdmissionSteps, deadline: number): Promise<void> {
  await steps.attach(deadline);
  await steps.bundleReady?.(deadline);
}

async function refuseForeignDriver(steps: AdmissionSteps): Promise<void> {
  const foreign = await interruptible(steps.foreignDriver);
  if (foreign !== undefined) throw new HandlerError('BUSY_FOREIGN_FLOW', foreign);
}

async function attach(steps: AdmissionSteps): Promise<void> {
  let failure: unknown;
  try {
    const deadline = performance.now() + steps.remainingMs();
    await withDeadline(deadline, new CDPProbeTimeoutError('CDP attach deadline exceeded'), () =>
      attachReady(steps, deadline),
    );
    return;
  } catch (error) {
    if (isAbort(error)) throw error;
    failure = error;
  }
  const load = (steps.load ?? (() => loadavg()[0]))();
  const loaded = load > LOAD_ENVELOPE;
  const timedOut = (error: unknown) =>
    error instanceof TargetReadinessTimeoutError ||
    error instanceof CDPProbeTimeoutError ||
    error instanceof CDPHandshakeTimeoutError;
  const retry = loaded && timedOut(failure) && steps.remainingMs() >= steps.readinessMs;
  let relaunchFailure: string | undefined;
  if (retry && steps.relaunch) {
    await refuseForeignDriver(steps);
    try {
      await interruptible(steps.relaunch);
    } catch (error) {
      if (isAbort(error)) throw error;
      relaunchFailure = describeError(error).message;
    }
  }
  if (retry && relaunchFailure === undefined) {
    try {
      const deadline = performance.now() + steps.remainingMs();
      await withDeadline(deadline, new CDPProbeTimeoutError('CDP attach deadline exceeded'), () =>
        attachReady(steps, deadline),
      );
      return;
    } catch (error) {
      if (isAbort(error)) throw error;
      failure = error;
    }
  }
  const environment = loaded && timedOut(failure);
  const measured = `host 1-minute load ${load.toFixed(1)} is ${loaded ? 'above' : 'within'} the envelope ${LOAD_ENVELOPE}`;
  throw new HandlerError(
    'CDP_NOT_CONNECTED',
    `cannot attach to the dev client through Metro ${steps.metroPort}: ${describeError(failure).message} (${measured}${environment ? `; an environment refusal ${retry ? 'after one retry' : 'without enough budget for another readiness wait'}` : ''}${relaunchFailure === undefined ? '' : `; relaunch failed: ${relaunchFailure}`})`,
  );
}
