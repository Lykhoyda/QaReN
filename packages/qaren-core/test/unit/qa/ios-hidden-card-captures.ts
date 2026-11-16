import { readFileSync } from 'node:fs';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';

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

// `edit` changes the device's join arguments before the join, as a changed screen would.
export function hiddenCard(
  name: HiddenCardRead,
  edit?: (args: { nodes: NativeNode[]; nativePresence: NativePresence }) => void,
): Screen {
  const { joinArgs: a } = JSON.parse(
    readFileSync(new URL(`../../fixtures/ios-hidden-card/${name}.json`, import.meta.url), 'utf8'),
  );
  edit?.(a);
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
