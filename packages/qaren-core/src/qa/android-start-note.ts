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

const AFTER_CONNECT: readonly AdmissionRefusalFacts['lastStarted'][] = [
  'foreign_driver',
  'open',
  'prove',
];

function bundle(facts: AdmissionRefusalFacts): string {
  if (facts.bundleRequest === 'not_received')
    return '; at the count check Metro had recorded no bundle request on this port since the launch';
  if (facts.bundleRequest !== 'received') return '';
  const built = facts.bundleBuilt === undefined ? undefined : BUILT[facts.bundleBuilt];
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
  return (PROCESS[facts.liveness] ?? '') + bundle(facts) + stage + gateNote;
}
