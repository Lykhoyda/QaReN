import type { Element, Screen } from './screen.js';
import type { CentreCoverageDiagnostic } from './resolve.js';

export const HIT_PROBE_RESULTS = ['hittable', 'not-hittable', 'moved', 'unavailable'] as const;
export type HitProbeResult = (typeof HIT_PROBE_RESULTS)[number];

export interface HitProbeIdentity {
  identifier?: string;
  label?: string;
  rect: { x: number; y: number; width: number; height: number };
}

export class OverlayHits {
  private readonly generation: number | undefined;
  private readonly results = new Map<Element, HitProbeResult>();

  constructor(private readonly screen: Screen) {
    this.generation = screen.nativeGeneration;
  }

  get(element: Element, screen: Screen): HitProbeResult | undefined {
    return screen === this.screen && screen.nativeGeneration === this.generation
      ? this.results.get(element)
      : undefined;
  }

  set(element: Element, result: HitProbeResult): void {
    if (this.screen.elements.includes(element))
      this.results.set(
        element,
        result === 'hittable' && !Number.isSafeInteger(this.generation) ? 'unavailable' : result,
      );
  }
}

export interface OverlayHitReceipt {
  observation: number;
  liveHit: HitProbeResult;
  predicate: Readonly<CentreCoverageDiagnostic>;
}

export function hitProbeNote(result: HitProbeResult): string {
  return result === 'hittable'
    ? ''
    : result === 'not-hittable'
      ? '; the live hit read found no hit point'
      : '; no live hit read was available';
}
