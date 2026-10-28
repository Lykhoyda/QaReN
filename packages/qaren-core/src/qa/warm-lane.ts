import type { Screen } from './screen.js';

const NOT_FOREGROUND = /^presence-failure=(initial|final)-eligibility:ineligible$/;

// Counts only: screen text never leaves this module, so runtime inputs stay out of the record.
export function firstScreenFacts(screen: Screen): string {
  const text = screen.visibleText.length + (screen.labelText?.length ?? 0);
  return `front ${screen.front}, ${text} text item(s), native coverage ${screen.coverage?.native ?? 'unknown'}`;
}

export function warmLaneRefusal(screen: Screen): string | undefined {
  if (screen.front !== 'app') return `the app's first screen is covered by a ${screen.front}`;
  if (screen.nativeCaptureCauses?.some((cause) => NOT_FOREGROUND.test(cause)))
    return 'the app is not in the foreground on its first screen';
  if (screen.coverage?.native !== 'complete')
    return `the native capture of the first screen is ${screen.coverage?.native ?? 'unknown'}, so the foreground app is unproven`;
  if (screen.visibleText.length + (screen.labelText?.length ?? 0) === 0)
    return "no text was observed on the app's first screen";
  return undefined;
}
