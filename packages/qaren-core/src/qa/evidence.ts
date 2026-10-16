import { keyboardCoversElement, type Screen } from './screen.js';

export type LiteralVerdict = 'pass' | 'unsure' | 'fail';

export interface LiteralEvidence {
  verdict: LiteralVerdict;
  // The occurrence was a merged accessibility label, not painted text.
  label?: true;
  // A failed literal whose text a node carries: why that node was not counted.
  nearMiss?: LiteralNearMiss;
}

export type LiteralNearMiss = 'not-visible' | 'not-literal-kind';

export function literalTextProjection(screen: Screen): Screen {
  if (screen.keyboardVisible === false || screen.uncoveredText === undefined) return screen;
  return {
    ...screen,
    elements: screen.elements.filter((e) => !keyboardCoversElement(e)),
    visibleText: screen.uncoveredText,
    paintedText: screen.uncoveredText,
    labelText: screen.uncoveredLabelText,
  };
}

// One rule for literal checks, quoted waits, scroll-until and replay text waits.
export function literalEvidence(
  screen: Screen,
  text: string,
  match: 'contains' | 'equals',
): LiteralEvidence {
  const hit = (line: string) => (match === 'contains' ? line.includes(text) : line === text);
  const projected = literalTextProjection(screen);
  if (projected.visibleText.some(hit)) return { verdict: 'pass' };
  if (projected.labelText?.some(hit)) return { verdict: 'pass', label: true };
  if (screen.unresolvedText?.some(hit)) return { verdict: 'unsure' };
  // Absence is proven only by a complete native snapshot.
  if ((screen.captureCoverage?.native ?? screen.coverage?.native) !== 'complete')
    return { verdict: 'unsure' };
  const nearMiss = nearMissOf(screen, hit);
  return nearMiss ? { verdict: 'fail', nearMiss } : { verdict: 'fail' };
}

// Prefer the node one fact kept out: literal text not visible, then visible text of another kind.
function nearMissOf(screen: Screen, hit: (line: string) => boolean): LiteralNearMiss | undefined {
  const carriers = screen.elements.filter((e) => !!e.label && hit(e.label));
  const hidden = (e: Screen['elements'][number]) => e.visibilityEvidence === 'offscreen';
  if (carriers.some((e) => hidden(e) && e.kind !== 'other')) return 'not-visible';
  if (carriers.some((e) => !hidden(e) && e.kind === 'other')) return 'not-literal-kind';
  return carriers.some(hidden) ? 'not-visible' : undefined;
}
