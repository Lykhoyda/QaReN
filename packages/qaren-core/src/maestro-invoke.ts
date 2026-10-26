import { writeFileSync } from 'node:fs';
import type { QaDispatchContext } from './domain/qa-dispatch.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBundleId, readExpoSlug } from './project-config.js';
import {
  buildMaestroFlow,
  parseAndValidateFlow,
  isValidBundleId,
  MaestroValidationError,
} from './domain/maestro-validator.js';
import { chooseMaestroDispatch } from './handlers/maestro-dispatch.js';
import { outputIndicatesFlowFailure } from './domain/maestro-error-parser.js';
import {
  exactPinRefusal,
  getEngineStatus,
  getMaestroRunnerPath,
  isOlderSdkInstallFailure,
  olderSdkInstallDiagnosis,
  RunnerCacheUnavailableError,
  runnerCacheBootstrapFailure,
  withImmediatePinnedRunner,
  type ReplayEngineStatus,
} from './domain/engine-pin.js';
import { replayCompatibilityPreflight } from './domain/action-engine-compat.js';
import { resolveAppFileForClearState } from './handlers/resolve-ios-app-file.js';
import { assembleMaestroArgs } from './handlers/maestro-run.js';
import { getActiveSession } from './agent-device-wrapper.js';
import {
  maestroAuthorityRefusal,
  sameDevice,
  verifyMaestroDeviceAuthority,
  type MaestroDeviceAuthority,
} from './domain/maestro-device-authority.js';
import {
  collectDirectRunnerEvidence,
  createRunnerReportDir,
  disposeRunnerReportDir,
  runnerReportArgs,
} from './domain/maestro-runner-report.js';
import {
  type AutomationCleanupRefusal,
  removeTemporaryInlineFlow,
  spawnManagedProcessGroup,
} from './lifecycle/managed-automation.js';
import { failResult, type ToolResult } from './utils.js';

export interface MaestroInvokeOptions {
  qaContext?: QaDispatchContext;
  platform: 'ios' | 'android';
  appId?: string;
  timeoutMs?: number;
  slug?: string;
  /** Exact UDID/serial. Defaults only from a matching active device session. */
  deviceId?: string;
}

export function yamlEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export interface MaestroInvokeResult {
  passed: boolean;
  output: string;
  flowFile: string;
  error?: string;
  errorCode?: 'AUTOMATION_CLEANUP_UNPROVEN' | 'BUSY_FLOW_ACTIVE' | 'WDA_BOOTSTRAP_FAILED';
  timedOut?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  cleanupEscalated?: boolean;
  cleanupRefusal?: AutomationCleanupRefusal;
  deviceAuthority?: MaestroDeviceAuthority;
}

export function maestroRefusalResult(
  result: MaestroInvokeResult,
  fallbackMessage: string,
  meta: Record<string, unknown>,
): ToolResult | null {
  if (!result.errorCode) return null;
  return failResult(result.error ?? fallbackMessage, result.errorCode, {
    ...meta,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    signal: result.signal,
    cleanupEscalated: result.cleanupEscalated,
    ...(result.cleanupRefusal ? { cleanupRefusal: result.cleanupRefusal } : {}),
  });
}

export { getMaestroRunnerPath };

let maestroInlineObserverForTest: (() => void) | null = null;

export function _setMaestroInlineObserverForTest(observer: (() => void) | null): void {
  maestroInlineObserverForTest = observer;
}

export async function runMaestroInline(
  yaml: string,
  opts: MaestroInvokeOptions,
  dependencies: {
    chooseDispatch?: typeof chooseMaestroDispatch;
    spawnManaged?: typeof spawnManagedProcessGroup;
    resolveEngineStatus?: () => Promise<ReplayEngineStatus | null>;
  } = {},
): Promise<MaestroInvokeResult> {
  maestroInlineObserverForTest?.();
  const dispatch = (dependencies.chooseDispatch ?? chooseMaestroDispatch)({
    platform: opts.platform,
  });
  if ('error' in dispatch) {
    return { passed: false, output: '', flowFile: '', error: dispatch.error };
  }
  const resolveEngineStatus =
    dependencies.resolveEngineStatus ?? (() => getEngineStatus().catch(() => null));
  const engineStatus = await resolveEngineStatus();
  const pinRefusal = exactPinRefusal(engineStatus);
  if (pinRefusal) {
    return { passed: false, output: '', flowFile: '', error: pinRefusal };
  }

  const rawAppId = opts.appId ?? resolveBundleId(opts.platform) ?? readExpoSlug() ?? '';
  const flowFile = join(
    tmpdir(),
    `rn-maestro-invoke-${opts.slug ?? 'flow'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`,
  );

  let content: string;
  let headerAppId: string | undefined;
  try {
    const parsed = parseAndValidateFlow(yaml, { rejectHeader: true });
    const selectorRefusal = replayCompatibilityPreflight({
      commands: parsed.commands,
      engineStatus,
      requireEnginePin: false,
    });
    if (selectorRefusal) {
      return { passed: false, output: '', flowFile, error: selectorRefusal };
    }
    const appIdOpts: { appId?: string } = {};
    if (rawAppId && isValidBundleId(rawAppId)) {
      appIdOpts.appId = rawAppId;
      headerAppId = rawAppId;
    } else if (rawAppId) {
      return {
        passed: false,
        output: '',
        flowFile,
        error: `Refusing to run Maestro: invalid bundle ID '${rawAppId.slice(0, 80)}' from project config (Phase 134.1)`,
      };
    }
    content = buildMaestroFlow(appIdOpts, parsed.commands);
  } catch (err) {
    if (err instanceof MaestroValidationError) {
      return {
        passed: false,
        output: '',
        flowFile,
        error: `Refusing to run Maestro: ${err.message} (Phase 134.1)`,
      };
    }
    throw err;
  }

  try {
    writeFileSync(flowFile, content, 'utf-8');
  } catch (err) {
    return {
      passed: false,
      output: '',
      flowFile,
      error: `Failed to write flow file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let runnerReportDir: string | null = null;
  try {
    const timeout = opts.timeoutMs ?? 120_000;
    const session = getActiveSession();
    const matchingSessionDeviceId =
      session?.platform === opts.platform && session.deviceId ? session.deviceId : undefined;
    if (
      opts.deviceId &&
      matchingSessionDeviceId &&
      !sameDevice(opts.deviceId, matchingSessionDeviceId)
    ) {
      return {
        passed: false,
        output: '',
        flowFile,
        error: `Refusing Maestro target ${opts.deviceId}: active ${opts.platform} session is bound to ${matchingSessionDeviceId}.`,
      };
    }
    const requestedDeviceId = opts.deviceId ?? matchingSessionDeviceId;
    if (
      requestedDeviceId !== undefined &&
      (requestedDeviceId.length === 0 ||
        requestedDeviceId.length > 256 ||
        /\s/.test(requestedDeviceId))
    ) {
      return {
        passed: false,
        output: '',
        flowFile,
        error: 'Refusing Maestro: deviceId must be 1-256 non-whitespace characters.',
      };
    }

    const appFileResolution = resolveAppFileForClearState(
      opts.platform,
      content,
      headerAppId,
      undefined,
    );
    if (!appFileResolution.ok) {
      return { passed: false, output: '', flowFile, error: appFileResolution.error };
    }

    runnerReportDir = createRunnerReportDir(dispatch.runner, 'rn-maestro-inline-report');
    const baseArgs = dispatch.buildArgs(
      opts.platform,
      flowFile,
      appFileResolution.appFile,
      requestedDeviceId,
    );
    const finalArgs = assembleMaestroArgs(baseArgs, runnerReportArgs(runnerReportDir));
    const executionDeadline = Date.now() + timeout;
    const flowAbort = new AbortController();
    const abortTimer = setTimeout(
      () => {
        flowAbort.abort(new Error(`Maestro timed out after ${timeout}ms`));
      },
      Math.max(0, executionDeadline - Date.now()),
    );
    abortTimer.unref?.();
    const execute = async () => {
      const spawn = (runnerPath: string, prefixArgs: readonly string[] = []) => {
        const remainingTimeout = executionDeadline - Date.now();
        if (remainingTimeout <= 0) {
          const error = new Error('Maestro flow timeout exhausted before runner execution');
          Object.assign(error, { code: 'ETIMEDOUT' });
          throw error;
        }
        return (dependencies.spawnManaged ?? spawnManagedProcessGroup)(
          runnerPath,
          [...prefixArgs, ...finalArgs],
          {
            ...(opts.qaContext ? { beforeSpawn: () => opts.qaContext!.authorize() } : {}),
            timeoutMs: remainingTimeout,
            platform: opts.platform,
            deviceId: requestedDeviceId,
            tool: opts.slug ?? 'inline-maestro',
          },
        );
      };
      if (dependencies.spawnManaged) {
        const immediateStatus = await resolveEngineStatus();
        const refusal = exactPinRefusal(immediateStatus);
        if (refusal) throw new Error(`RUNNER_PIN_CHANGED: ${refusal}`);
        return spawn(dispatch.binPath);
      }
      return withImmediatePinnedRunner(dispatch.binPath, resolveEngineStatus, spawn, opts.platform);
    };

    let execution;
    try {
      execution = await execute();
    } catch (err) {
      if (opts.qaContext) opts.qaContext.refuse('ACTION_OUTCOME_UNCERTAIN');
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RunnerCacheUnavailableError) {
        return {
          passed: false,
          output: '',
          flowFile,
          error: runnerCacheBootstrapFailure(err),
          errorCode: 'WDA_BOOTSTRAP_FAILED',
        };
      }
      if (message.startsWith('RUNNER_PIN_CHANGED:')) {
        return { passed: false, output: '', flowFile, error: message };
      }
      throw err;
    } finally {
      clearTimeout(abortTimer);
    }

    const output = (execution.stdout + '\n' + execution.stderr).trim();
    if (!execution.cleanupProven) {
      const guidance = execution.cleanupRefusal
        ? ` Process group: ${execution.cleanupRefusal.processGroup}. Run ${execution.cleanupRefusal.manualCommand}, then retry in this bridge process.`
        : '';
      return {
        passed: false,
        output,
        flowFile,
        error: `AUTOMATION_CLEANUP_UNPROVEN: Maestro ended, but owned process-group absence could not be confirmed.${guidance}`,
        errorCode: 'AUTOMATION_CLEANUP_UNPROVEN',
        timedOut: execution.timedOut,
        exitCode: execution.code,
        signal: execution.signal,
        cleanupEscalated: execution.cleanupEscalated,
        ...(execution.cleanupRefusal ? { cleanupRefusal: execution.cleanupRefusal } : {}),
      };
    }
    // GH #741: a pre-O install reject is a capability gap, not a flow failure —
    // report it truthfully instead of the opaque runner error.
    if (opts.platform === 'android' && isOlderSdkInstallFailure(output)) {
      return {
        passed: false,
        output,
        flowFile,
        error: olderSdkInstallDiagnosis(dispatch.runner),
        exitCode: execution.code,
        signal: execution.signal,
      };
    }
    if (execution.timedOut) {
      return {
        passed: false,
        output,
        flowFile,
        error: `Maestro timed out after ${timeout}ms`,
        timedOut: true,
        exitCode: execution.code,
        signal: execution.signal,
        cleanupEscalated: execution.cleanupEscalated,
      };
    }
    if (execution.error) {
      return {
        passed: false,
        output,
        flowFile,
        error: execution.error.slice(0, 500),
        exitCode: execution.code,
        signal: execution.signal,
      };
    }

    const passed = execution.code === 0 && !outputIndicatesFlowFailure(output);
    const directEvidence = collectDirectRunnerEvidence(runnerReportDir, output);
    const deviceAuthority = verifyMaestroDeviceAuthority({
      runner: dispatch.runner,
      platform: opts.platform,
      requestedDeviceId,
      output: directEvidence.output,
      directReportDeviceIds: directEvidence.reportDeviceIds,
      directReportIdentityStrength: directEvidence.reportDeviceIdStrength,
      requireWdaProvenance: passed,
    });
    const authorityRefusal = maestroAuthorityRefusal(deviceAuthority, execution.error);
    return {
      passed: authorityRefusal ? false : passed,
      output,
      flowFile,
      ...(authorityRefusal ? { error: authorityRefusal } : {}),
      exitCode: execution.code,
      signal: execution.signal,
      cleanupEscalated: execution.cleanupEscalated,
      deviceAuthority,
    };
  } finally {
    disposeRunnerReportDir(runnerReportDir);
    removeTemporaryInlineFlow(flowFile);
  }
}
