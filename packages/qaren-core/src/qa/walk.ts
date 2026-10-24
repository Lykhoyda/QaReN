import { QaDispatchError } from '../domain/qa-dispatch.js';
import { ownedLogin, parseInputPreflight } from './input-preflight.js';
import { ObservedPrivacy } from './privacy.js';
import { InputPrivacyRefusal, withInputs, currentInputs } from './inputs.js';
import {
  cancellationSignal,
  interruptible,
  withCancellation,
  sleep,
} from '../domain/cancellation.js';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CDPClient } from '../cdp-client.js';
import { waitForExactPortTargets } from '../cdp/discovery.js';
import { REACT_READY_POLL_MS, REACT_READY_TIMEOUT_MS } from '../cdp/setup.js';
import {
  clearDevOverlays,
  createDevSettingsHandler,
  recoverDevOverlays,
} from '../handlers/dev-settings.js';
import {
  cdpClientOrNull,
  createDeviceBackHandler,
  createDeviceFillHandler,
  extractMutationDisposition,
  createDevicePressHandler,
  createDeviceScrollHandler,
  readReactInputValue,
} from '../handlers/device-interact.js';
import { captureQaScreenshot } from './screenshot.js';
import {
  createDeviceSnapshotHandler,
  iosAppProcessId,
  isAppRunning,
} from '../handlers/device-session.js';
import { relaunchIosDevClient } from '../handlers/app-lifecycle.js';
import {
  createDeviceAcceptSystemDialogHandler,
  createDeviceDismissSystemDialogHandler,
} from '../handlers/device-system-dialog.js';
import { foregroundSurfaceFromSnapshot } from '../handlers/expo-dev-menu.js';
import { compileFlow, FlowCompileError } from '../flow/compile.js';
import { foreignFlowGate } from '../lifecycle/foreign-flow-gate.js';
import { androidForeignDriverMessage } from '../runners/external-runner-detect.js';
import {
  observeAppProcess,
  observeRunnerDrivers,
  observeRunnerRelaunches,
} from '../runners/rn-fast-runner-client.js';
import type { ToolResult } from '../utils.js';
import { HandlerError, adapt, describeError, fillEvidence, unwrap } from './adapt.js';
import {
  AppProcessGoneError,
  captureScreen,
  nativeDevOverlayUncleared,
  postAdmissionSnapshots,
  type NativeObservation,
} from './capture.js';
import { createQaReactCapture } from './react-capture.js';
import type { LedgerRow, StepStart } from './ledger.js';
import { parsePlanWithJev, planTitle, readPreparedPlan } from './plan.js';
import { createJev } from './jev.js';
import { isRecord } from './questions.js';
import {
  createTimingObserver,
  formatTimingEvent,
  observeDispatchPhases,
  observeTiming,
  type TimingContext,
  type TimingEvent,
} from './timing.js';
import { preflightPlan } from './preflight.js';
import { summarizeJev } from './ledger.js';
import { isSecretEnvName, redactApiKey, setRedactionKey } from '../util/redact.js';
import { createStop, watchOwnerPipe, watchParent } from './stop.js';
import { prove } from './prove.js';
import {
  admissionMetric,
  admit,
  awaitBundleReady,
  awaitDevClientManifest,
  launchBundleRequests,
  createBundleReload,
  devClientLaunchUrl,
  logAdmissionRefusal,
  metroDevicePin,
} from './admission.js';
import { type ActResult, type WalkerDeps, loginBlock, runPlan } from './walker.js';
import { loadBlock, readBlock } from './blocks.js';
import {
  type ResultPayload,
  type WireRequest,
  createWriter,
  missingResult,
  parsePrivateRequest,
  parsePublicRequest,
  readPrivateLine,
  resultForWalk,
  startupRow,
} from './wire.js';

const log = (message: string): void => {
  process.stderr.write(
    `qaren-core: ${redactApiKey(currentInputs()?.redact(message) ?? message)}\n`,
  );
};

export function scrollArgs(
  direction: Parameters<WalkerDeps['scroll']>[0],
  clearance?: number,
  within?: Parameters<WalkerDeps['scroll']>[3],
) {
  return {
    direction,
    amount: 0.6,
    ...(clearance !== undefined ? { distance: clearance } : {}),
    ...(within ? { within } : {}),
  };
}

// stdout is a pipe: wait for it to drain before the process exits.
function exitAfterDrain(code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write('', () => process.exit(code));
  });
}

async function parseOnly(planFile: string, probe: boolean, apiKey?: string): Promise<never> {
  let markdown: string;
  try {
    markdown = readFileSync(planFile, 'utf8');
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: 'PLAN_UNPARSEABLE', refused: [{ line: 0, text: '', reason: `cannot read ${planFile}: ${describeError(error).message}` }] })}\n`,
    );
    return exitAfterDrain(4);
  }
  const judge = createJev({ apiKey });
  if (probe) {
    const result = await preflightPlan(markdown, judge);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return exitAfterDrain(result.ok ? 0 : 4);
  }
  const parsed = await parsePlanWithJev(markdown, judge);
  if (parsed.refused) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: 'PLAN_UNPARSEABLE', refused: parsed.refused })}\n`,
    );
    return exitAfterDrain(4);
  }
  const items = parsed.blocks.reduce((n, b) => n + b.items.length, 0);
  process.stdout.write(`${JSON.stringify({ ok: true, blocks: parsed.blocks.length, items })}\n`);
  return exitAfterDrain(0);
}

function compileOnly(args: string[]): Promise<never> {
  const refuse = (code: string, refused: object): Promise<never> => {
    process.stdout.write(`${JSON.stringify({ ok: false, code, refused: [refused] })}\n`);
    return exitAfterDrain(4);
  };
  const usage = (): Promise<never> =>
    refuse('FLOW_USAGE', {
      line: 0,
      reason:
        'usage: --compile <action.yaml> --platform ios|android [--params <JSON object of strings>]',
    });
  const parse = () => {
    try {
      return parseArgs({
        args,
        options: { platform: { type: 'string' }, params: { type: 'string' } },
        allowPositionals: true,
      });
    } catch {
      return undefined;
    }
  };
  const parsed = parse();
  if (!parsed) return usage();
  const [file, ...extra] = parsed.positionals;
  const platform = parsed.values.platform;
  let params: unknown;
  try {
    params = JSON.parse(parsed.values.params ?? '{}');
  } catch {
    params = undefined;
  }
  const paramsValid =
    typeof params === 'object' &&
    params !== null &&
    !Array.isArray(params) &&
    Object.values(params).every((value) => typeof value === 'string');
  if (!file || extra.length > 0 || (platform !== 'ios' && platform !== 'android') || !paramsValid) {
    return usage();
  }
  try {
    const plan = compileFlow({ file, platform, params: params as Record<string, string> });
    process.stdout.write(`${JSON.stringify({ ok: true, plan })}\n`);
    return exitAfterDrain(0);
  } catch (error) {
    if (!(error instanceof FlowCompileError)) throw error;
    const { file: source, line, command, reason } = error;
    return refuse('FLOW_UNSUPPORTED', {
      ...(source ? { file: source } : {}),
      line,
      command,
      reason,
    });
  }
}

interface Session {
  deps: WalkerDeps;
  close(): Promise<void>;
  // Epoch ms once the bundle is proven and dev overlays are cleared; earlier frames are never published.
  admittedAtMs: number;
}

type Handler<A> = (args: A) => Promise<ToolResult>;

const stop = createStop();

function act(
  handler: () => Promise<ToolResult>,
  proven: boolean,
  timing?: TimingContext,
): Promise<ActResult> {
  if (stop.stopping)
    return Promise.resolve({
      ok: false,
      proven: false,
      mutation: 'none',
      error: 'RUN_CANCELLED: the device session is closing',
    });
  return stop.track(handler).then(
    (result) => {
      try {
        const { data, meta } = unwrap<{
          executed?: boolean;
          tapped?: boolean;
          typedLength?: number;
          observedLengths?: unknown;
          caseNormalizedChars?: unknown;
          tappedLabel?: unknown;
          tappedRect?: unknown;
        }>(result);
        logActionSettle(meta, timing);
        const keyboard = actionKeyboard(meta);
        if (data?.executed === false || data?.tapped === false)
          return {
            ok: false,
            proven: false,
            executed: false,
            mutation: 'none',
            error: 'the action did not execute',
          };
        const verified = meta?.verify === 'exact';
        const rect = data?.tappedRect as Record<string, unknown> | undefined;
        const dialog =
          verified &&
          typeof data?.tappedLabel === 'string' &&
          rect &&
          ['x', 'y', 'width', 'height'].every((k) => typeof rect[k] === 'number')
            ? {
                label: data.tappedLabel,
                rect: rect as { x: number; y: number; width: number; height: number },
              }
            : undefined;
        const observed = data?.observedLengths;
        const kept =
          typeof data?.typedLength === 'number' &&
          Array.isArray(observed) &&
          observed.length > 0 &&
          observed.every((n) => typeof n === 'number')
            ? { typed: data.typedLength, observed: observed as number[] }
            : undefined;
        const chars = data?.caseNormalizedChars;
        return {
          ok: true,
          proven: proven || verified,
          ...(keyboard !== undefined ? { keyboardShown: keyboard } : {}),
          ...(dialog ? { dialog } : {}),
          ...(kept ? { kept } : {}),
          ...(typeof chars === 'number' ? { caseNormalized: { chars } } : {}),
        };
      } catch (error) {
        logActionSettle(error instanceof HandlerError ? error.meta : undefined, timing);
        const keyboard = actionKeyboard(error instanceof HandlerError ? error.meta : undefined);
        const { code, message } = describeError(error);
        return {
          ok: false,
          proven: false,
          mutation: extractMutationDisposition(result),
          error: `${code}: ${message}`,
          ...(keyboard !== undefined ? { keyboardShown: keyboard } : {}),
          ...(fillEvidence(error) ? { evidence: fillEvidence(error) } : {}),
          ...(code === 'TARGET_AMBIGUOUS' ? { ambiguous: true } : {}),
        };
      }
    },
    (error) => {
      logActionSettle(
        error instanceof HandlerError
          ? error.meta
          : error instanceof QaDispatchError
            ? error.settleMeta
            : undefined,
        timing,
      );
      const { code, message } = describeError(error);
      return {
        ok: false,
        proven: false,
        mutation:
          error instanceof HandlerError && error.meta?.mutation === 'none'
            ? 'none'
            : error instanceof HandlerError && error.meta?.mutation === 'observed'
              ? 'observed'
              : 'possible',
        error: `${code}: ${message}`,
        ...(fillEvidence(error) ? { evidence: fillEvidence(error) } : {}),
        ...(code === 'TARGET_AMBIGUOUS' ? { ambiguous: true } : {}),
      };
    },
  );
}

// A missing, unreadable or foreign login block is configured but cannot replay.
function readLoginBlock(request: WireRequest): NonNullable<WalkerDeps['login']>['block'] {
  if (!request.loginBlock) return undefined;
  try {
    const text = loadBlock(request.appRoot, request.loginBlock);
    const stored = text === null ? undefined : readBlock(text);
    if (!stored || 'invalid' in stored) return undefined;
    if (stored.header.appId !== request.appId || stored.header.platform !== request.platform)
      return undefined;
    return loginBlock(request.loginBlock, stored);
  } catch {
    return undefined;
  }
}

// Whether the keyboard an exact Android tap waited for was shown; logged value-free.
function actionKeyboard(meta?: Record<string, unknown>): boolean | undefined {
  const shown = meta?.keyboardShown;
  if (typeof shown !== 'boolean') return undefined;
  try {
    log(`action-keyboard=${JSON.stringify({ shown })}`);
  } catch {
    // Diagnostics cannot change an action's outcome.
  }
  return shown;
}

function logActionSettle(meta?: Record<string, unknown>, timing?: TimingContext): void {
  try {
    const settle = isRecord(meta?.settle) ? meta.settle : {};
    const ms = isRecord(meta?.timings_ms) ? meta.timings_ms.settle : undefined;
    const summary: Pick<TimingEvent, 'method' | 'settled' | 'hierarchyChanged'> & {
      ms: number | 'unknown';
    } = {
      method:
        typeof settle.method === 'string' &&
        ['window-gate', 'screen-static', 'snapshot-eq', 'timeout'].includes(settle.method)
          ? (settle.method as TimingEvent['method'])
          : 'unknown',
      settled: typeof settle.settled === 'boolean' ? settle.settled : 'unknown',
      hierarchyChanged:
        typeof settle.hierarchyChanged === 'boolean' ? settle.hierarchyChanged : 'unknown',
      ms:
        typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER
          ? ms
          : 'unknown',
    };
    if (timing)
      observeTiming(timing.observe, {
        stage: 'settle',
        edge: 'end',
        outcome: summary.settled === true ? 'ok' : summary.settled === false ? 'failed' : 'unknown',
        at: timing.now(),
        method: summary.method,
        settled: summary.settled,
        hierarchyChanged: summary.hierarchyChanged,
        ...(typeof summary.ms === 'number' ? { ms: summary.ms } : {}),
      });
    log(`action-settle=${JSON.stringify(summary)}`);
  } catch {
    // Diagnostics cannot change an action's outcome.
  }
}

// Attach over CDP, prove the bundle, open the device session, then hand the walker plain functions.
async function openSession(
  request: WireRequest,
  emitRow: (row: LedgerRow) => void,
  emitStart: (start: StepStart) => void,
  onClose: (close: () => Promise<void>) => void,
  privacy: ObservedPrivacy,
  pinnedLogin: NonNullable<WalkerDeps['login']>['block'],
  diagnostic: (event: unknown) => void,
  apiKey: string | undefined,
): Promise<Session> {
  const { target, platform, appId } = request;
  // Run-relative ms on a monotonic clock, anchored once to the CLI's t0.
  const runOffset = Date.now() - request.t0;
  const perfStart = performance.now();
  const now = (): number => Math.round(runOffset + performance.now() - perfStart);
  let currentLine: number | undefined;
  const timing = createTimingObserver((event) => {
    if (
      currentLine !== undefined &&
      event.line === undefined &&
      ['type-call', 'type-readback', 'relayout-retap', 'settle', 'keyboard'].includes(event.stage)
    )
      event = { ...event, line: currentLine };
    if (currentInputs()?.hasInputs) diagnostic({ kind: 'metric', ...event });
    else process.stderr.write(redactApiKey(formatTimingEvent(event)));
  });
  const cdp = new CDPClient(target.metroPort);
  const getClient = (): CDPClient => cdp;
  const snapshot: Handler<{
    action: 'open' | 'close' | 'snapshot';
    appId?: string;
    deviceId?: string;
    platform?: string;
    attachOnly?: boolean;
    sessionName?: string;
    platformPresence?: boolean;
    presenceBudgetMs?: number;
    qaReadOnly?: boolean;
    qaTiming?: TimingContext;
  }> = createDeviceSnapshotHandler();
  let deviceOpen = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= withCancellation(undefined, async () => {
      observeRunnerRelaunches(undefined);
      observeDispatchPhases(undefined);
      observeAppProcess(undefined);
      if (deviceOpen) await snapshot({ action: 'close' }).catch(() => undefined);
      await cdp.disconnect().catch(() => undefined);
    }));
  onClose(close);
  const devicePin = metroDevicePin(platform, target.deviceName);
  const remainingMs = () => Math.max(0, request.walkBudgetMs - now() - 1000);
  const bundleRequests =
    target.metroBundleRequests && launchBundleRequests(target.metroBundleRequests);
  let attachStage: 'wait_targets' | 'connect_exact' | undefined;
  const logRefusal = (error: unknown): never => {
    logAdmissionRefusal(error, attachStage, log);
    throw error;
  };
  const proof = await cdp.withAttachDeadline(performance.now() + remainingMs(), () =>
    admit(
      {
        metroPort: target.metroPort,
        readinessMs: REACT_READY_TIMEOUT_MS,
        attachBudgetMs: request.attachBudgetMs,
        remainingMs,
        attach: async (deadline) => {
          attachStage = 'wait_targets';
          await waitForExactPortTargets(
            target.metroPort,
            Math.max(1, Math.min(REACT_READY_TIMEOUT_MS, remainingMs())),
            REACT_READY_POLL_MS,
            stop.signal,
            devicePin,
            appId,
          );
          attachStage = 'connect_exact';
          await cdp.connectExact(
            target.metroPort,
            { platform, bundleId: appId, ...(devicePin ? { deviceName: devicePin } : {}) },
            'default',
            1,
            undefined,
            deadline,
          );
        },
        bundleReady: (deadline) => awaitBundleReady((expr) => cdp.evaluate(expr), deadline),
        // Same launch the CLI made: once Metro answers the manifest in time, terminate and open the dev client on its Metro.
        ...(platform === 'ios'
          ? {
              relaunch: async (deadline: number) => {
                const url = devClientLaunchUrl(target);
                const manifest = await awaitDevClientManifest(url, deadline);
                log(
                  `relaunching after the manifest answered in ${manifest.ms} ms (attempt ${manifest.attempts})`,
                );
                bundleRequests?.relaunching();
                return relaunchIosDevClient(appId, target.deviceId, url);
              },
              appAlive: async () => {
                const alive = await isAppRunning('ios', appId, undefined, target.deviceId);
                if (alive) log('app alive without a target');
                return alive;
              },
              bundleRequested: async () => {
                if (!bundleRequests) {
                  log('no bundle request signal');
                  return undefined;
                }
                const requested = bundleRequests.requested();
                log(
                  requested === false
                    ? 'Metro received no bundle request since launch'
                    : requested
                      ? 'Metro received a bundle request'
                      : 'bundle request signal unknown',
                );
                return requested;
              },
            }
          : {}),
        // The lease coordinates qaren processes only; a foreign Maestro, XCUITest or UIAutomator driver is a probe.
        foreignDriver: async () => {
          if (platform === 'android')
            return interruptible(() => androidForeignDriverMessage(target.deviceId));
          if (platform !== 'ios') return undefined;
          const foreign = await interruptible(() => foreignFlowGate.check(target.deviceId));
          return foreign.active
            ? (foreign.warning?.message ?? 'another automation driver holds the device')
            : undefined;
        },
        open: async () => {
          deviceOpen = true;
          await adapt(snapshot)({
            action: 'open',
            appId,
            deviceId: target.deviceId,
            platform,
            attachOnly: false,
            sessionName: `qaren-${request.runId}`,
          });
        },
        // Opening the session may have relaunched the app: prove the bundle the walk will see.
        prove: () => prove({ evaluate: (expr) => cdp.evaluate(expr) }, target),
        close,
        observe: (decision, facts) => timing(admissionMetric(decision, facts, attachStage, now())),
      },
      stop,
    ).catch(logRefusal),
  );
  const admittedSnapshots = postAdmissionSnapshots(snapshot, appId);
  cancellationSignal();
  log(
    `bundle proven: ${proof.scriptURL} (${proof.appModules} app modules under ${target.worktree}) on device ${JSON.stringify(devicePin ?? target.deviceId)}`,
  );

  observeRunnerRelaunches({ now, observe: timing });
  observeDispatchPhases({ now, observe: timing });
  if (platform === 'ios') observeAppProcess(() => iosAppProcessId(appId, target.deviceId));

  const rawSnapshot = async (
    platformPresence = false,
    presenceBudgetMs?: number,
    qaTiming?: TimingContext,
  ) => {
    const result = await admittedSnapshots.snapshot({
      action: 'snapshot',
      qaReadOnly: true,
      qaTiming,
      ...(platformPresence ? { platformPresence: true, presenceBudgetMs } : {}),
    });
    const { data, meta } = unwrap<
      NativeObservation & { presenceCapture?: unknown; snapshotGeneration?: unknown }
    >(result);
    return {
      appProcessIdentifier: data.appProcessIdentifier,
      keyboardVisible: data.keyboardVisible,
      nodes: data.nodes,
      presenceCapture: data.presenceCapture,
      snapshotGeneration: data.snapshotGeneration,
      truncated: data.truncated,
      normalizationDroppedNodes: data.normalizationDroppedNodes,
      snapshotVerdict: meta?.snapshotVerdict,
      systemModal: meta?.systemModal,
      snapshotDiagnostics: data.snapshotDiagnostics,
      surface: typeof meta?.foregroundSurface === 'string' ? meta.foregroundSurface : undefined,
    };
  };
  const devSettings = createDevSettingsHandler(getClient, {
    probeForegroundSurface: async () =>
      foregroundSurfaceFromSnapshot(
        await admittedSnapshots.snapshot({ action: 'snapshot' }),
        appId,
      ),
  });
  const devOverlayUncleared = async (): Promise<boolean> =>
    nativeDevOverlayUncleared(await rawSnapshot());
  // Android reloads the bundle when hot loading is set: step 1 must read the reloaded, re-proven app.
  const reload =
    platform === 'android'
      ? createBundleReload({
          evaluate: (expr) => cdp.evaluate(expr),
          reinjectHelpers: (waitMs) => cdp.reinjectHelpers(waitMs, true),
          prove: () => prove({ evaluate: (expr) => cdp.evaluate(expr) }, target),
          remainingMs,
        })
      : undefined;
  const overlays = {
    devSettings,
    devOverlayUncleared,
    log,
    ...(reload
      ? {
          fastRefreshReload: {
            mark: reload.mark,
            settled: async () => {
              await reload.settled();
              log('Fast Refresh off: the reloaded bundle is proven');
            },
          },
        }
      : {}),
  };
  try {
    unwrap(await clearDevOverlays(overlays));
  } catch (error) {
    await close();
    throw error;
  }
  const admittedAtMs = Date.now();
  cancellationSignal();

  const press = createDevicePressHandler(getClient);
  const fill = createDeviceFillHandler(getClient);
  const scroll = createDeviceScrollHandler();
  const back = createDeviceBackHandler();
  const accept = createDeviceAcceptSystemDialogHandler();
  const dismiss = createDeviceDismissSystemDialogHandler();
  const login = request.loginMarker
    ? { marker: request.loginMarker, block: pinnedLogin }
    : undefined;
  if (login && request.loginBlock && !login.block)
    log(`login block ${request.loginBlock} is missing or unreadable; a login wall fails the step`);

  const captureReact = createQaReactCapture(cdp);
  const deps: WalkerDeps = {
    note: log,
    mediaWithheld: diagnostic,
    privacy,
    judge: createJev({ apiKey, now, timing }),
    interruptionVeto: !!apiKey,
    presenceUnavailable: platform === 'android',
    timing,
    publicationInterrupted: admittedSnapshots.interrupted,
    captureScreen: (options) =>
      stop.track(() =>
        captureScreen({
          appId,
          requirePrivateInputs: true,
          observation: options?.observation,
          platformPresence: options?.platformPresence,
          now,
          timing: options?.timing,
          warn: log,
          native: (presenceBudgetMs) =>
            rawSnapshot(
              options?.platformPresence,
              presenceBudgetMs,
              options?.timing ? { now, observe: options.timing } : undefined,
            ).catch((error: unknown) => {
              if (error instanceof HandlerError && error.meta?.reason === 'app-not-running')
                throw new AppProcessGoneError();
              throw error;
            }),
          react: () => captureReact(options?.platformPresence === true),
        }),
      ),
    press: (ref, qaContext) =>
      act(() => press({ ref, qaContext, qaTiming: { now, observe: timing } }), false, {
        now,
        observe: timing,
      }),
    fill: (ref, text, qaContext) =>
      act(() => fill({ ref, text, qaContext, qaTiming: { now, observe: timing } }), true, {
        now,
        observe: timing,
      }),
    scroll: (direction, qaContext, clearance, within) =>
      act(() => scroll({ ...scrollArgs(direction, clearance, within), qaContext }), false),
    back: (qaContext) => act(() => back({ qaContext }), false),
    dialog: (action, qaContext) =>
      act(
        () =>
          action === 'accept'
            ? accept({ platform, qaContext, note: log })
            : dismiss({ platform, qaContext, note: log }),
        false,
      ),
    async screenshot(name) {
      if (stop.stopping || currentInputs()?.hasInputs) return undefined;
      const path = join(request.runDir, name);
      const shot = await stop.track(() =>
        captureQaScreenshot(platform, path, target.deviceId, appId),
      );
      if (!shot.ok) log(`screenshot ${name} failed: ${shot.reason}`);
      return shot.ok ? name : undefined;
    },
    now,
    cancelled: () => stop.stopping,
    diagnostic: (event) => {
      if (currentInputs()?.hasInputs) diagnostic({ kind: 'timing', ...event });
      else log(`timing ${JSON.stringify(event)}`);
    },
    blockOutcome: diagnostic,
    targetMiss: diagnostic,
    loginOutcome: (outcome) => diagnostic({ kind: 'login-outcome', outcome }),
    hideDevMenu: () => act(() => recoverDevOverlays(overlays), false),
    ...(login ? { login } : {}),
    sleep,
    row: emitRow,
    start: (start) => {
      currentLine = start.line;
      emitStart(start);
    },
    ...(platform === 'ios'
      ? {
          appProcess: {},
          reactFocused: async (testID: string) =>
            (await readReactInputValue(cdpClientOrNull(getClient), testID))?.focused === true,
          typeFocused: (ref, text, testID, qaContext, requireFocused) =>
            act(
              () =>
                fill({
                  ref,
                  text,
                  ...(testID ? { testID } : {}),
                  focused: true,
                  vetoUnfocused: true,
                  requireFocused,
                  skipFinalValidation: true,
                  clearFirst: true,
                  qaContext,
                  qaTiming: { now, observe: timing },
                }),
              false,
              { now, observe: timing },
            ),
        }
      : {}),
  };
  return {
    deps,
    close,
    admittedAtMs,
  };
}

let privateRun = false;

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  setRedactionKey(apiKey);
  for (const key of Object.keys(process.env)) if (isSecretEnvName(key)) delete process.env[key];
  if (process.argv[2] === '--preflight-stdin') {
    try {
      const value: unknown = JSON.parse(await readPrivateLine(process.stdin));
      const result = await parseInputPreflight(value, createJev({ apiKey }));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return exitAfterDrain((result as { ok?: boolean }).ok ? 0 : 4);
    } catch (error) {
      const message =
        error instanceof InputPrivacyRefusal ? error.message : 'runtime input preflight refused';
      process.stdout.write(`${JSON.stringify({ ok: false, code: 'CORE_REFUSED', message })}\n`);
      return exitAfterDrain(4);
    }
  }
  if (process.argv[2] === '--compile') return compileOnly(process.argv.slice(3));
  if (process.argv[2] === '--parse' || process.argv[2] === '--preflight')
    return parseOnly(process.argv[3] ?? '', process.argv[2] === '--preflight', apiKey);
  const cliParent = process.ppid;
  const line = await readPrivateLine(process.stdin);
  let parsed: ReturnType<typeof parsePrivateRequest>;
  try {
    parsed = parsePrivateRequest(line);
  } catch {
    const publicRequest = parsePublicRequest(line);
    const writer = createWriter((line) => process.stdout.write(line), publicRequest.runId);
    return exitAfterDrain(
      writer.result({
        verdict: 'REFUSED',
        code: 'CORE_REFUSED',
        message: 'runtime inputs are invalid',
        lease: publicRequest.lease,
      }),
    );
  }
  privateRun = parsed.inputs.hasInputs;
  parsed.inputs.onRefusal((reason) => stop.begin(reason));
  return withInputs(parsed.inputs, () =>
    mainRequest(parsed.request, parsed.privacy, cliParent, apiKey),
  );
}

async function mainRequest(
  request: WireRequest,
  privacy: ObservedPrivacy,
  cliParent: number,
  apiKey: string | undefined,
): Promise<void> {
  let pinnedLogin = readLoginBlock(request);
  if (request.loginSnapshot) {
    const actual = ownedLogin(
      request.loginSnapshot.slug,
      request.appRoot,
      request.appId,
      request.platform,
    );
    if (actual.content !== request.loginSnapshot.content)
      throw new Error('CORE_REFUSED: login corpus changed during admission');
    pinnedLogin =
      actual.content === null
        ? undefined
        : loginBlock(actual.slug, readBlock(actual.content) as import('./blocks.js').StoredBlock);
  }
  const writer = createWriter((line) => process.stdout.write(redactApiKey(line)), request.runId);
  observeRunnerDrivers((pid) => writer.runnerDriver(pid));
  const rows: LedgerRow[] = [];
  const emitRow = (row: LedgerRow): void => {
    rows.push(row);
    writer.row(row);
  };
  // The one exit owner; once stopping, no verdict other than the cancellation is reported.
  let written: 0 | 1 | 4 | undefined;
  const finish = async (payload: ResultPayload, close?: () => Promise<void>): Promise<never> => {
    if (currentInputs()?.hasInputs && close) {
      try {
        await close();
      } catch {
        payload = {
          verdict: 'REFUSED',
          code: 'CORE_REFUSED',
          message: 'private run teardown refused',
          lease: request.lease,
          jev: payload.jev,
        };
      }
      close = undefined;
    }
    const code = (written = writer.result(
      stop.stopping
        ? {
            verdict: 'REFUSED',
            code:
              stop.signal.reason instanceof InputPrivacyRefusal ? 'CORE_REFUSED' : 'RUN_CANCELLED',
            message:
              stop.signal.reason instanceof InputPrivacyRefusal
                ? stop.signal.reason.message
                : 'the run was cancelled',
            lease: request.lease,
            jev: payload.jev,
          }
        : payload,
    ));
    if (close) await close();
    return exitAfterDrain(code);
  };
  const refuse = (code: string, message: string, close?: () => Promise<void>): Promise<never> =>
    finish(
      {
        verdict: 'REFUSED',
        code,
        message,
        lease: request.lease,
        jev: summarizeJev(request.preflightCalls ?? []),
      },
      close,
    );

  let release: (() => Promise<void>) | undefined;
  // Stopping makes the next device operation fail, so the walk ends through `finish`.
  // The fallback only covers a walk stuck inside one operation, within the CLI's grace.
  const halt = (why: string): void => {
    if (!stop.begin()) return;
    log(`${why}: stopping the walk`);
    setTimeout(() => {
      void stop
        .drained(1000)
        .then(() => release?.())
        .finally(() => process.exit(written ?? 1));
    }, 8000);
  };
  watchOwnerPipe(process.stdout, (code) =>
    halt(`the qaren CLI stopped reading the wire (${code})`),
  );
  emitRow(startupRow());

  if (process.env.QAREN_DEVICE_LEASE !== request.lease) {
    return refuse('LEASE_MISMATCH', 'QAREN_DEVICE_LEASE does not match the request lease');
  }
  const blocks = readPreparedPlan(request.plan, request.prepared);
  if (!blocks)
    return refuse(
      'PLAN_UNPARSEABLE',
      'the prepared plan is missing, invalid or does not match the preflight bytes',
    );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => halt(signal));
  watchParent(
    cliParent,
    () => process.ppid,
    () => halt('the qaren CLI exited'),
  );
  let opened: Session;
  let inFlight: number | undefined;
  try {
    opened = await stop.track(() =>
      openSession(
        request,
        emitRow,
        (start) => {
          inFlight = start.line;
          writer.start(start);
        },
        (close) => {
          release = close;
        },
        privacy,
        pinnedLogin,
        writer.diagnostic,
        apiKey,
      ),
    );
  } catch (error) {
    const { code, message } = describeError(error);
    return refuse(code, message);
  }
  if (stop.stopping)
    return refuse('RUN_CANCELLED', 'the run was cancelled before the walk started', () =>
      opened.close(),
    );
  writer.admitted();
  try {
    const ledger = await stop.track(() =>
      runPlan(
        blocks,
        opened.deps,
        request.preflightCalls,
        {
          appRoot: request.appRoot,
          platform: request.platform,
          appId: request.appId,
        },
        planTitle(request.plan),
      ),
    );
    return finish(
      resultForWalk(
        {
          ...ledger,
          admittedAtMs: opened.admittedAtMs,
          ...(ledger.publishFromMs !== undefined
            ? { publishFromMs: request.t0 + ledger.publishFromMs }
            : {}),
        },
        request.lease,
      ),
      () => opened.close(),
    );
  } catch (error) {
    const { code, message } = describeError(error);
    const ledger = missingResult(rows, `${code}: ${message}`, inFlight);
    ledger.jev = summarizeJev([
      ...(request.preflightCalls ?? []),
      ...(opened.deps.judge?.calls ?? []),
    ]);
    ledger.admittedAtMs = opened.admittedAtMs;
    ledger.publicationInterrupted = opened.deps.publicationInterrupted?.() === true;
    return finish(ledger, () => opened.close());
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    const detail = privateRun ? 'runtime request refused' : describeError(error).message;
    log(`fatal before the wire was established: ${detail}`);
    process.exit(1);
  });
}
