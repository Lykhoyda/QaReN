import {
  cancellationSignal,
  interruptible,
  withCancellation,
  sleep,
} from '../domain/cancellation.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { createDeviceSnapshotHandler } from '../handlers/device-session.js';
import { relaunchIosDevClient } from '../handlers/app-lifecycle.js';
import {
  createDeviceAcceptSystemDialogHandler,
  createDeviceDismissSystemDialogHandler,
} from '../handlers/device-system-dialog.js';
import { foregroundSurfaceFromSnapshot } from '../handlers/expo-dev-menu.js';
import { compileFlow, FlowCompileError } from '../flow/compile.js';
import { foreignFlowGate } from '../lifecycle/foreign-flow-gate.js';
import { observeRunnerDrivers } from '../runners/rn-fast-runner-client.js';
import type { ToolResult } from '../utils.js';
import { HandlerError, adapt, describeError, fillEvidence, unwrap } from './adapt.js';
import {
  AppProcessGoneError,
  captureScreen,
  nativeDevOverlayUncleared,
  postAdmissionSnapshots,
  type NativeObservation,
} from './capture.js';
import { captureQaReact } from './react-capture.js';
import type { LedgerRow, StepStart } from './ledger.js';
import { parsePlanWithJev, readPreparedPlan } from './plan.js';
import { createJev } from './jev.js';
import { isRecord } from './questions.js';
import { createTimingObserver, formatTimingEvent, type TimingContext } from './timing.js';
import { preflightPlan } from './preflight.js';
import { summarizeJev } from './ledger.js';
import { redactApiKey } from '../util/redact.js';
import { createStop, watchOwnerPipe, watchParent } from './stop.js';
import { prove } from './prove.js';
import { admit, awaitBundleReady } from './admission.js';
import { type ActResult, type WalkerDeps, loginBlock, runPlan } from './walker.js';
import { loadBlock, readBlock } from './blocks.js';
import {
  type ResultPayload,
  type WireRequest,
  createWriter,
  missingResult,
  readRequest,
  resultForWalk,
  startupRow,
} from './wire.js';

const log = (message: string): void => {
  process.stderr.write(`qaren-core: ${redactApiKey(message)}\n`);
};

// stdout is a pipe: wait for it to drain before the process exits.
function exitAfterDrain(code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write('', () => process.exit(code));
  });
}

async function parseOnly(planFile: string, probe: boolean): Promise<never> {
  let markdown: string;
  try {
    markdown = readFileSync(planFile, 'utf8');
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: 'PLAN_UNPARSEABLE', refused: [{ line: 0, text: '', reason: `cannot read ${planFile}: ${describeError(error).message}` }] })}\n`,
    );
    return exitAfterDrain(4);
  }
  const judge = createJev();
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

function act(handler: () => Promise<ToolResult>, proven: boolean): Promise<ActResult> {
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
        logActionSettle(meta);
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
          ...(dialog ? { dialog } : {}),
          ...(kept ? { kept } : {}),
          ...(typeof chars === 'number' ? { caseNormalized: { chars } } : {}),
        };
      } catch (error) {
        logActionSettle(error instanceof HandlerError ? error.meta : undefined);
        const { code, message } = describeError(error);
        return {
          ok: false,
          proven: false,
          mutation: extractMutationDisposition(result),
          error: `${code}: ${message}`,
          ...(fillEvidence(error) ? { evidence: fillEvidence(error) } : {}),
          ...(code === 'TARGET_AMBIGUOUS' ? { ambiguous: true } : {}),
        };
      }
    },
    (error) => {
      logActionSettle(error instanceof HandlerError ? error.meta : undefined);
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

function logActionSettle(meta?: Record<string, unknown>): void {
  try {
    const settle = isRecord(meta?.settle) ? meta.settle : {};
    const ms = isRecord(meta?.timings_ms) ? meta.timings_ms.settle : undefined;
    log(
      `action-settle=${JSON.stringify({
        method:
          typeof settle.method === 'string' &&
          ['window-gate', 'screen-static', 'snapshot-eq', 'timeout'].includes(settle.method)
            ? settle.method
            : 'unknown',
        settled: typeof settle.settled === 'boolean' ? settle.settled : 'unknown',
        hierarchyChanged:
          typeof settle.hierarchyChanged === 'boolean' ? settle.hierarchyChanged : 'unknown',
        ms:
          typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER
            ? ms
            : 'unknown',
      })}`,
    );
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
): Promise<Session> {
  const { target, platform, appId } = request;
  // Run-relative ms on a monotonic clock, anchored once to the CLI's t0.
  const runOffset = Date.now() - request.t0;
  const perfStart = performance.now();
  const now = (): number => Math.round(runOffset + performance.now() - perfStart);
  const timing = createTimingObserver((event) =>
    process.stderr.write(redactApiKey(formatTimingEvent(event))),
  );
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
      if (deviceOpen) await snapshot({ action: 'close' }).catch(() => undefined);
      await cdp.disconnect().catch(() => undefined);
    }));
  onClose(close);
  const proof = await admit(
    {
      metroPort: target.metroPort,
      readinessMs: REACT_READY_TIMEOUT_MS,
      remainingMs: () => Math.max(0, request.walkBudgetMs - now() - 1000),
      attach: async (deadline) => {
        await waitForExactPortTargets(
          target.metroPort,
          Math.max(1, Math.min(REACT_READY_TIMEOUT_MS, request.walkBudgetMs - now() - 1000)),
          REACT_READY_POLL_MS,
          stop.signal,
        );
        await cdp.connectExact(
          target.metroPort,
          { platform, bundleId: appId },
          'default',
          5,
          undefined,
          deadline,
        );
      },
      bundleReady: (deadline) => awaitBundleReady((expr) => cdp.evaluate(expr), deadline),
      // Same launch the CLI made: terminate, then open the dev client on its Metro.
      ...(platform === 'ios'
        ? {
            relaunch: () =>
              relaunchIosDevClient(
                appId,
                target.deviceId,
                `${target.metroUrlForDevice}/?disableOnboarding=1`,
              ),
          }
        : {}),
      // The lease coordinates qaren processes only; a foreign Maestro or XCUITest driver is a probe.
      foreignDriver: async () => {
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
    },
    stop,
  );
  const admittedSnapshots = postAdmissionSnapshots(snapshot, appId);
  cancellationSignal();
  log(
    `bundle proven: ${proof.scriptURL} (${proof.appModules} app modules under ${target.worktree})`,
  );

  const rawSnapshot = async (
    platformPresence = false,
    presenceBudgetMs?: number,
    qaTiming?: TimingContext,
  ) => {
    const result = await admittedSnapshots.snapshot({
      action: 'snapshot',
      qaReadOnly: true,
      qaTiming,
      ...(platform === 'ios' && platformPresence
        ? { platformPresence: true, presenceBudgetMs }
        : {}),
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
  try {
    unwrap(await clearDevOverlays({ devSettings, devOverlayUncleared, log }));
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
    ? { marker: request.loginMarker, block: readLoginBlock(request) }
    : undefined;
  if (login && request.loginBlock && !login.block)
    log(`login block ${request.loginBlock} is missing or unreadable; a login wall fails the step`);

  const deps: WalkerDeps = {
    judge: createJev({ now, timing }),
    timing,
    publicationInterrupted: admittedSnapshots.interrupted,
    captureScreen: (options) =>
      stop.track(() =>
        captureScreen({
          appId,
          requirePrivateInputs: true,
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
          react: () => captureQaReact(cdp, options?.platformPresence === true),
        }),
      ),
    press: (ref, qaContext) => act(() => press({ ref, qaContext }), false),
    fill: (ref, text, qaContext) => act(() => fill({ ref, text, qaContext }), true),
    scroll: (direction, qaContext) =>
      act(() => scroll({ direction, amount: 0.6, qaContext }), false),
    back: (qaContext) => act(() => back({ qaContext }), false),
    dialog: (action, qaContext) =>
      act(
        () =>
          action === 'accept' ? accept({ platform, qaContext }) : dismiss({ platform, qaContext }),
        false,
      ),
    async screenshot(name) {
      if (stop.stopping) return undefined;
      const path = join(request.runDir, name);
      const shot = await stop.track(() =>
        captureQaScreenshot(platform, path, target.deviceId, appId),
      );
      if (!shot.ok) log(`screenshot ${name} failed: ${shot.reason}`);
      return shot.ok ? name : undefined;
    },
    now,
    cancelled: () => stop.stopping,
    diagnostic: (event) => log(`timing ${JSON.stringify(event)}`),
    hideDevMenu: () =>
      act(
        () =>
          recoverDevOverlays({
            devSettings,
            devOverlayUncleared,
            log,
          }),
        false,
      ),
    ...(login ? { login } : {}),
    sleep,
    row: emitRow,
    start: emitStart,
    ...(platform === 'ios'
      ? {
          appProcess: {},
          reactFocused: async (testID: string) =>
            (await readReactInputValue(cdpClientOrNull(getClient), testID))?.focused === true,
          note: log,
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
                }),
              false,
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

async function main(): Promise<void> {
  if (process.argv[2] === '--compile') return compileOnly(process.argv.slice(3));
  if (process.argv[2] === '--parse' || process.argv[2] === '--preflight')
    return parseOnly(process.argv[3] ?? '', process.argv[2] === '--preflight');
  const cliParent = process.ppid;
  const request = await readRequest(process.stdin);
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
    const code = (written = writer.result(
      stop.stopping
        ? {
            verdict: 'REFUSED',
            code: 'RUN_CANCELLED',
            message: 'the run was cancelled',
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
  try {
    opened = await stop.track(() =>
      openSession(request, emitRow, writer.start, (close) => {
        release = close;
      }),
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
      runPlan(blocks, opened.deps, request.preflightCalls, {
        appRoot: request.appRoot,
        platform: request.platform,
        appId: request.appId,
      }),
    );
    return finish(
      resultForWalk({ ...ledger, admittedAtMs: opened.admittedAtMs }, request.lease),
      () => opened.close(),
    );
  } catch (error) {
    const { code, message } = describeError(error);
    const ledger = missingResult(rows, `${code}: ${message}`);
    ledger.jev = summarizeJev([
      ...(request.preflightCalls ?? []),
      ...(opened.deps.judge?.calls ?? []),
    ]);
    ledger.admittedAtMs = opened.admittedAtMs;
    ledger.publicationInterrupted = opened.deps.publicationInterrupted?.() === true;
    return finish(ledger, () => opened.close());
  }
}

main().catch((error) => {
  log(`fatal before the wire was established: ${describeError(error).message}`);
  process.exit(1);
});
