import { realpathSync } from 'node:fs';
import { execFile } from '../domain/cancellation.js';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  isAndroidEmulatorSerial,
  isIosSimulatorUdid,
  probeAndroidExternalRunnerAdmission,
  probeIosExternalRunnerAdmission,
  type IosStrictRunnerStatus,
  type IosAdmissionProbeEvidence,
} from '../runners/external-runner-detect.js';

export interface FreshInstallPreflightResult {
  v: 1;
  platform: 'ios' | 'android';
  deviceId: string;
  status: IosStrictRunnerStatus;
  evidence?: IosAdmissionProbeEvidence;
}

async function observeProcess(
  executable: string,
  pid: number,
  timeout: number,
  withArgv = false,
  inspection?: 'ios-paths',
): Promise<unknown> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      executable,
      [
        '--internal-process-observation',
        String(pid),
        ...(withArgv ? ['--argv'] : inspection === 'ios-paths' ? ['--inspect-ios-paths'] : []),
      ],
      { timeout, maxBuffer: 32_768, encoding: 'utf8' },
    );
    if (stderr !== '') return { observationFailure: 'observer_stderr' };
    try {
      return JSON.parse(stdout);
    } catch {
      return { observationFailure: 'observer_invalid_json' };
    }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    return {
      observationFailure:
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'observer_output_oversize'
          : failure.killed || failure.code === 'ETIMEDOUT'
            ? 'observer_timeout'
            : 'observer_failed',
    };
  }
}

export async function freshInstallPreflight(args: string[]): Promise<FreshInstallPreflightResult> {
  const invalid: FreshInstallPreflightResult = {
    v: 1,
    platform: 'ios',
    deviceId: '',
    status: 'unknown',
  };
  if (args.length !== 4 && args.length !== 6) return invalid;
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--platform', '--device', '--process-observer'].includes(key) || options.has(key))
      return invalid;
    options.set(key, args[i + 1]);
  }
  const deviceId = options.get('--device');
  if (
    options.get('--platform') === 'android' &&
    deviceId &&
    isAndroidEmulatorSerial(deviceId) &&
    !options.has('--process-observer')
  ) {
    const { status } = await probeAndroidExternalRunnerAdmission(deviceId);
    return { v: 1, platform: 'android', deviceId, status };
  }
  if (options.get('--platform') !== 'ios' || !deviceId || !isIosSimulatorUdid(deviceId)) {
    return invalid;
  }
  const observer = options.get('--process-observer');
  if (observer !== undefined && !isAbsolute(observer)) return invalid;
  return {
    v: 1,
    platform: 'ios',
    deviceId,
    ...(await probeIosExternalRunnerAdmission(
      undefined,
      deviceId,
      observer
        ? (pid, timeout, withArgv, inspection) =>
            observeProcess(observer, pid, timeout, withArgv, inspection)
        : undefined,
    )),
  };
}

function invokedDirectly(): boolean {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const result = await freshInstallPreflight(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'clear' ? 0 : 4;
}
