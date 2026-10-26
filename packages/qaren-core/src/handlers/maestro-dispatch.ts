import {
  getMaestroRunnerPath,
  MAESTRO_RUNNER_PIN,
  PINNED_RUNNER_INSTALL_HINT,
} from '../domain/engine-pin.js';

export type MaestroRunner = 'maestro-runner' | 'maestro';

export interface MaestroDispatch {
  runner: MaestroRunner;
  binPath: string;
  buildArgs(
    platform: 'ios' | 'android',
    flowFile: string,
    appFile?: string,
    deviceId?: string,
  ): string[];
  fallbackReason?: string;
  degradedReason?: string;
}

export interface MaestroDispatchInputs {
  platform: 'ios' | 'android';
  flowHasHideKeyboard?: boolean;
  whichAdb?: () => string | null;
  whichMaestro?: () => string | null;
  maestroRunnerPath?: () => string | null;
}

export function _resetMaestroDispatchCache(): void {
  warnedFallbackReasons.clear();
}

const warnedFallbackReasons = new Set<string>();

export function shouldWarnFallback(reason: string): boolean {
  if (warnedFallbackReasons.has(reason)) return false;
  warnedFallbackReasons.add(reason);
  return true;
}

export interface MaestroDispatchError {
  error: string;
  hint: string;
}

export function flowContainsHideKeyboard(commands: readonly unknown[]): boolean {
  return commands.some(
    (c) =>
      c === 'hideKeyboard' ||
      (typeof c === 'object' && c !== null && 'hideKeyboard' in (c as Record<string, unknown>)),
  );
}

export function chooseMaestroDispatch(
  inputs: MaestroDispatchInputs,
): MaestroDispatch | MaestroDispatchError {
  const runnerPath = (inputs.maestroRunnerPath ?? getMaestroRunnerPath)();
  if (runnerPath) {
    return {
      runner: 'maestro-runner',
      binPath: runnerPath,
      buildArgs: (platform, flowFile, appFile, deviceId) => [
        ...(appFile ? ['--app-file', appFile] : []),
        '--platform',
        platform,
        ...(deviceId ? ['--device', deviceId] : []),
        'test',
        flowFile,
      ],
    };
  }

  return {
    error:
      `Session maestro-runner ${MAESTRO_RUNNER_PIN.version} is not installed in the pin-cache. ` +
      `Install attested ${MAESTRO_RUNNER_PIN.version} (floor >= ${MAESTRO_RUNNER_PIN.version}) via ${PINNED_RUNNER_INSTALL_HINT}. ` +
      `Ambient PATH maestro-runner, ~/.maestro-runner, and brew maestro are never used.`,
    hint: `run ensure-maestro-runner.sh for attested ${MAESTRO_RUNNER_PIN.version} (floor >= ${MAESTRO_RUNNER_PIN.version})`,
  };
}
