import type { AdmissionRefusalFacts, BundleBuilt } from './admission.js';

const PROCESS: Partial<Record<AdmissionRefusalFacts['liveness'], string>> = {
  dead: "; the app's process was not running",
  alive: "; the app's process was running",
  probe_failed: "; the app's process could not be checked",
};

const BUILT: Partial<Record<BundleBuilt, string>> = {
  failed: 'a failed build',
  none: 'no completed build',
  completed: 'a completed build',
};

const RESTART: Record<NonNullable<AdmissionRefusalFacts['relaunchBlocked']>, string> = {
  driver_busy:
    "; QaReN did not restart the app: the device's process table matched another automation driver",
  device_unreadable:
    '; QaReN did not restart the app: the device did not answer the reads needed before a force-stop',
};

const AFTER_CONNECT: readonly AdmissionRefusalFacts['lastStarted'][] = [
  'foreign_driver',
  'open',
  'prove',
];

function bundle(facts: AdmissionRefusalFacts): string {
  if (facts.bundleRequest === 'not_received')
    return '; at the count check Metro had recorded no bundle request on this port since the launch';
  if (facts.bundleRequest !== 'received') return '';
  // A count-only read leaves the build outcome out: nothing was read, so nothing is claimed about it.
  if (facts.bundleBuilt === undefined)
    return '; a bundle request was recorded on this Metro port since the launch';
  const built = BUILT[facts.bundleBuilt];
  return built === undefined
    ? '; a bundle request was recorded on this Metro port since the launch; build outcomes could not be read'
    : `; a bundle request and ${built} were recorded on this Metro port since the launch`;
}

// What an Android refusal read: the process, Metro's counts and the step a deadline ended in, then the gate's own note.
export function androidStartNote(
  facts: AdmissionRefusalFacts | undefined,
  gateNote: string,
): string {
  if (!facts) return gateNote;
  const stage = AFTER_CONNECT.includes(facts.lastStarted)
    ? `; the debugger was attached and React was ready; the deadline ended at step ${facts.lastStarted}`
    : '';
  const restart =
    facts.relaunchBlocked !== undefined
      ? RESTART[facts.relaunchBlocked]
      : facts.relaunches > 0 && !facts.relaunchFailed
        ? '; QaReN stopped the app and issued one recovery start command'
        : '';
  return restart + (PROCESS[facts.liveness] ?? '') + bundle(facts) + stage + gateNote;
}
