import { readFileSync } from 'node:fs';
import {
  frontFromSurface,
  join,
  validateReactHostEvidence,
  type Screen,
} from '../../../dist/qa/screen.js';
import { validateNativePresence } from '../../../dist/qa/native-presence.js';
import { reactCoverage } from '../../../dist/qa/acquisition-coverage.js';

export type CaptureFixture = {
  mode: 'ordinary' | 'platform-presence';
  presenceBudgetMs: number;
  rawBeforeValidation: {
    presenceCapture?: unknown;
    snapshotGeneration: number;
    surface: string;
    reactHostEvidence: NonNullable<Parameters<typeof join>[4]>;
  };
  captureCoverage: NonNullable<Screen['captureCoverage']>;
  joinArgs: {
    nodes: Parameters<typeof join>[0];
    digest: Parameters<typeof join>[1];
    front: Parameters<typeof join>[2];
    coverage: Parameters<typeof join>[3];
    reactHostEvidence: NonNullable<Parameters<typeof join>[4]>;
    nativePresence?: Parameters<typeof join>[5];
    nativeAcquisition: Parameters<typeof join>[6];
  };
};

// Replays a real iOS device capture of the Test App through production admission and join().
export function replayCapture(fixture: URL, edit?: (fixture: CaptureFixture) => void): Screen {
  const f: CaptureFixture = JSON.parse(readFileSync(fixture, 'utf8'));
  // Negative fixtures edit the same raw host envelope that production validates.
  f.joinArgs.reactHostEvidence = f.rawBeforeValidation.reactHostEvidence;
  edit?.(f);
  const a = f.joinArgs;
  const raw = f.rawBeforeValidation;
  // The dump retains production's acquisition verdict, not the original snapshotVerdict fields.
  // Restore that exact envelope, then recompute presence admission and projection independently.
  const captureCoverage = { ...f.captureCoverage };
  const hostEvidence = validateReactHostEvidence(raw.reactHostEvidence);
  const nativePresence =
    f.mode === 'platform-presence' && captureCoverage.native === 'complete'
      ? validateNativePresence(
          raw.presenceCapture,
          a.nodes,
          raw.snapshotGeneration,
          'com.rndevagent.testapp',
          f.presenceBudgetMs,
        )
      : undefined;
  const coverage: NonNullable<Screen['coverage']> = {
    native: nativePresence
      ? 'complete'
      : captureCoverage.native === 'incomplete' ||
          (f.mode === 'platform-presence' && raw.presenceCapture !== undefined)
        ? 'incomplete'
        : 'unknown',
    react: reactCoverage(
      { interactive: a.digest, hostEvidence: raw.reactHostEvidence },
      captureCoverage.react,
      hostEvidence,
    ),
  };
  return {
    ...join(
      a.nodes,
      a.digest,
      frontFromSurface(raw.surface, a.nodes),
      coverage,
      hostEvidence,
      nativePresence ??
        (f.mode === 'platform-presence' && raw.presenceCapture !== undefined
          ? 'unknown'
          : undefined),
      captureCoverage.native,
    ),
    captureCoverage,
  };
}
