import { readFileSync } from 'node:fs';
import { join, type Screen } from '../../../dist/qa/screen.js';

// Real iOS reads of the Test App's hidden-children card screen: the exact join() arguments the device
// produced. Alpha, Bravo (testID qa-hidden-card-b) and Echo (in a popup) are buttons with no label whose
// texts are hidden from accessibility; Charlie has an authored label; Delta's texts are not hidden.
export type HiddenCardRead =
  | 'p1-obs21-ordinary'
  | 'p1-obs22-presence'
  | 'p2-obs38-presence'
  | 'p3-obs22-presence'
  | 'p5-obs22-presence'
  | 'p9-obs27-presence';

export function hiddenCard(name: HiddenCardRead): Screen {
  const { joinArgs: a } = JSON.parse(
    readFileSync(new URL(`../../fixtures/ios-hidden-card/${name}.json`, import.meta.url), 'utf8'),
  );
  return {
    ...join(
      a.nodes,
      a.digest,
      a.front,
      a.coverage,
      a.reactHostEvidence,
      a.nativePresence,
      a.nativeAcquisition,
    ),
    // Production attaches the acquisition verdict beside the join, whose native side join() received.
    captureCoverage: { native: a.nativeAcquisition, react: a.coverage.react },
  };
}
