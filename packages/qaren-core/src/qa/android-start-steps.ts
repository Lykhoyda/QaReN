import { androidAppProcess } from '../handlers/device-session.js';
import type { AdmissionSteps, BundleBuilt, StartCounts } from './admission.js';
import { androidStartNote } from './android-start-note.js';

// Android's admission steps: Metro's counts and the app's process, read only when asked; no state is held.
export function androidStartSteps({
  appId,
  serial,
  bundleRequests,
  gate,
  process = androidAppProcess,
}: {
  appId: string;
  serial: string;
  bundleRequests?: { requested(): boolean | undefined; built(): BundleBuilt };
  gate?: { note(): string };
  process?: (appId: string, serial: string) => Promise<boolean>;
}): Required<Pick<AdmissionSteps, 'startCounts' | 'startProcess' | 'refusalNote'>> {
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
    refusalNote: (facts) => androidStartNote(facts, gate?.note() ?? ''),
  };
}
