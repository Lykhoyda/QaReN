import { androidAppProcess } from '../handlers/device-session.js';
import {
  buildAndroidDevClientStartArgv,
  isAndroidDevClientLaunchUrl,
  startAndroidDevClient,
  terminateApp,
} from '../handlers/app-lifecycle.js';
import { isAbort, throwIfCancelled } from '../domain/cancellation.js';
import {
  probeAndroidExternalRunnerAdmission,
  type AndroidStrictRunnerStatus,
} from '../runners/external-runner-detect.js';
import {
  StartRelaunchError,
  type AdmissionSteps,
  type AndroidStartRecovery,
  type BundleBuilt,
  type StartCounts,
} from './admission.js';
import { androidStartNote } from './android-start-note.js';

// The launch URL, only when it is the CLI's own for this Metro port and the app id and serial pass the start's checks.
function recoveryUrl(
  appId: string,
  serial: string,
  launchUrl: string | undefined,
  metroPort: number | undefined,
): string | undefined {
  if (metroPort === undefined || !isAndroidDevClientLaunchUrl(launchUrl, metroPort))
    return undefined;
  try {
    buildAndroidDevClientStartArgv(appId, serial, launchUrl);
    return launchUrl;
  } catch {
    return undefined;
  }
}

// Android's admission steps: Metro's counts and the app's process, read only when asked; with the CLI's
// launch URL, also the one restart. No state is held here.
export function androidStartSteps({
  appId,
  serial,
  metroPort,
  launchUrl,
  bundleRequests,
  gate,
  process = androidAppProcess,
  driver = async (serial: string) => (await probeAndroidExternalRunnerAdmission(serial)).status,
  stop = (appId: string, serial: string) => terminateApp(appId, 'android', serial),
  start = startAndroidDevClient,
  log = () => undefined,
  at = () => 0,
}: {
  appId: string;
  serial: string;
  metroPort?: number;
  launchUrl?: string;
  bundleRequests?: { requested(): boolean | undefined; built(): BundleBuilt; relaunching?(): void };
  gate?: { note(): string; state?(): string; restart?(): void };
  process?: (appId: string, serial: string) => Promise<boolean>;
  driver?: (serial: string) => Promise<AndroidStrictRunnerStatus>;
  stop?: (appId: string, serial: string) => Promise<void>;
  start?: (appId: string, serial: string, url: string) => Promise<'sent' | 'timed_out'>;
  log?: (line: string) => void;
  at?: () => number;
}): Required<Pick<AdmissionSteps, 'startCounts' | 'startProcess' | 'startHeld' | 'refusalNote'>> &
  Pick<AdmissionSteps, 'startRecovery'> {
  const recovery = (url: string): AndroidStartRecovery => ({
    driver: () => driver(serial),
    relaunch: async () => {
      const failed =
        (words: string) =>
        (error: unknown): never => {
          if (isAbort(error)) throw error;
          throw new StartRelaunchError(words);
        };
      await stop(appId, serial).catch(failed('the force-stop command failed'));
      const running = await process(appId, serial).catch(
        failed("the app's process could not be read after the force-stop"),
      );
      if (running)
        throw new StartRelaunchError("the app's process was running after the force-stop");
      bundleRequests?.relaunching?.();
      throwIfCancelled();
      log(`android start: restart: the app was stopped at ${at()} ms; sending the same start once`);
      const sent = await start(appId, serial, url).catch(failed('the start command failed'));
      gate?.restart?.();
      log(
        `android start: restart: ${sent === 'sent' ? 'start sent' : 'start command timed out'} at ${at()} ms`,
      );
    },
  });
  const url = recoveryUrl(appId, serial, launchUrl, metroPort);
  return {
    startCounts: (outcomes): StartCounts => {
      const requested = bundleRequests?.requested();
      if (requested === undefined || !bundleRequests) return { bundleRequest: 'unknown' };
      if (!requested) return { bundleRequest: 'not_received' };
      return {
        bundleRequest: 'received',
        ...(outcomes ? { bundleBuilt: bundleRequests.built() } : {}),
      };
    },
    startProcess: () => process(appId, serial),
    startHeld: () => gate?.state?.() === 'holding',
    refusalNote: (facts) => androidStartNote(facts, gate?.note() ?? ''),
    ...(url === undefined ? {} : { startRecovery: recovery(url) }),
  };
}
