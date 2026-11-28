import { realpathSync } from 'node:fs';
import { execFile } from '../domain/cancellation.js';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  ADMISSION_SCAN_TIMEOUT_MS,
  isAndroidEmulatorSerial,
  isAndroidUsbSerial,
  isIosSimulatorUdid,
  probeAndroidExternalRunnerAdmission,
  probeAndroidForeignDriver,
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
  // Present only in the answer of the check before dependencies.
  check?: 'driver';
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
  if (![4, 6, 8, 10].includes(args.length)) return invalid;
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !['--platform', '--device', '--process-observer', '--scan-timeout-ms', '--check'].includes(
        key,
      ) ||
      options.has(key)
    )
      return invalid;
    options.set(key, args[i + 1]);
  }
  // The CLI owns the admission allowance; it may give a repeated scan a longer wait.
  const wait = options.get('--scan-timeout-ms');
  const scanTimeoutMs = wait === undefined ? ADMISSION_SCAN_TIMEOUT_MS.default : Number(wait);
  if (
    wait !== undefined &&
    (!/^[1-9]\d{3,4}$/.test(wait) ||
      scanTimeoutMs < ADMISSION_SCAN_TIMEOUT_MS.default ||
      scanTimeoutMs > ADMISSION_SCAN_TIMEOUT_MS.max)
  )
    return invalid;
  // `--check driver` asks for the check before dependencies instead of strict admission.
  const check = options.get('--check');
  if (check !== undefined && check !== 'driver') return invalid;
  const deviceId = options.get('--device');
  if (
    check === 'driver' &&
    options.get('--platform') === 'android' &&
    deviceId &&
    (isAndroidEmulatorSerial(deviceId) || isAndroidUsbSerial(deviceId)) &&
    !options.has('--process-observer')
  ) {
    const { status, reason, driver } = await probeAndroidForeignDriver(
      deviceId,
      undefined,
      scanTimeoutMs,
    );
    return {
      v: 1,
      platform: 'android',
      deviceId,
      check,
      status,
      ...(status === 'busy' && driver
        ? { evidence: { reason: 'driver_on_selected_device', driver } }
        : reason
          ? { evidence: { reason } }
          : {}),
    };
  }
  if (
    options.get('--platform') === 'android' &&
    deviceId &&
    (isAndroidEmulatorSerial(deviceId) || isAndroidUsbSerial(deviceId)) &&
    !options.has('--process-observer')
  ) {
    const { status, reason } = await probeAndroidExternalRunnerAdmission(
      deviceId,
      undefined,
      scanTimeoutMs,
    );
    return {
      v: 1,
      platform: 'android',
      deviceId,
      status,
      ...(reason ? { evidence: { reason } } : {}),
    };
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
    ...(check ? { check } : {}),
    ...(await probeIosExternalRunnerAdmission(
      undefined,
      deviceId,
      observer
        ? (pid, timeout, withArgv, inspection) =>
            observeProcess(observer, pid, timeout, withArgv, inspection)
        : undefined,
      scanTimeoutMs,
      check === 'driver',
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
