import { hostPath } from './host-association.js';
import type { Target } from './plan.js';
import { MASK, type ObservedPrivacy } from './privacy.js';
import {
  associatedHostOf,
  frameLocatedOf,
  frameMatchedHostOf,
  semanticDisabled,
  type Element,
  type Screen,
} from './screen.js';
import { MISS_TEXT } from './target-miss.js';

type Rect = { x: number; y: number; width: number; height: number };

export interface HiddenText {
  // React host indices hidden from accessibility that carry the quoted text or test id.
  hosts: number[];
  via: 'text' | 'id';
  // The pressable nearest every such host, when they share one that is not itself hidden.
  // `labelled` is absent when the capture could not tell whether the app authored a label.
  button?: { host: number; testID?: string; rect?: Rect; labelled?: boolean };
}

// iOS drops a subtree hidden from accessibility from its elements and from the parent's composed label,
// so only React's per-host text, carried by the fuller read, still holds such a text.
export function hiddenFromAccessibility(
  target: Target,
  screen: Screen,
  match: 'exact' | 'contains',
): HiddenText | undefined {
  const quoted = target.quoted;
  const evidence = screen.reactHostEvidence;
  const typography = evidence?.typography;
  if (!quoted || !evidence || !typography?.complete) return;
  let via: HiddenText['via'] = 'text';
  const candidates: number[] = [];
  evidence.hosts.forEach((host, index) => {
    if (host.hidden !== true) return;
    const text = typography.nodes[index]?.text;
    const byText =
      target.exact !== 'id' &&
      text?.kind === 'block' &&
      (match === 'exact' ? text.content === quoted : text.content.includes(quoted));
    const byId = target.exact !== 'text' && host.testID === quoted;
    if (!byText && !byId) return;
    if (byId) via = 'id';
    candidates.push(index);
  });
  if (!candidates.length) return;
  // The nearest pressable, the hidden host itself included, is what a touch reaches; a hidden one is
  // never passed over for an outer one.
  const buttons = new Set(
    candidates.map((index) => {
      const nearest = hostPath(typography, index)?.find(
        (ancestor) => evidence.hosts[ancestor]?.capabilities.press,
      );
      return nearest === undefined || evidence.hosts[nearest].hidden ? undefined : nearest;
    }),
  );
  const [host] = buttons;
  if (buttons.size !== 1 || host === undefined) return { hosts: candidates, via };
  const node = typography.nodes[host];
  const testID = evidence.hosts[host].testID;
  const label = node.accessibility?.authoredLabel;
  return {
    hosts: candidates,
    via,
    button: {
      host,
      ...(testID !== undefined ? { testID } : {}),
      ...(node.rect ? { rect: node.rect } : {}),
      ...(label === 'present' || label === 'absent' ? { labelled: label === 'present' } : {}),
    },
  };
}

// Layout sums such as 161.66666793823242 + 90 can differ from a child's edge in the last bits.
const EDGE = 0.01;

const within = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - EDGE &&
  inner.y >= outer.y - EDGE &&
  inner.x + inner.width <= outer.x + outer.width + EDGE &&
  inner.y + inner.height <= outer.y + outer.height + EDGE;

// The one native element tied to the button host, when it is a button a tap can reach and the hidden
// text lies inside that host.
function provenButton(
  found: HiddenText,
  button: NonNullable<HiddenText['button']>,
  screen: Screen,
  tied: (element: Element) => boolean,
  located = false,
): Element | undefined {
  const typography = screen.reactHostEvidence?.typography;
  const elements = screen.elements.filter(tied);
  const [element] = elements;
  if (
    !typography ||
    elements.length !== 1 ||
    element.ref.startsWith('react:') ||
    element.kind !== 'button' ||
    (!located && (!element.hittable || element.offscreen)) ||
    semanticDisabled(element)
  )
    return;
  // Both rects are React's, in window points; a native frame lives in another space.
  const text = typography.nodes[found.hosts[0]]?.rect;
  return text && button.rect && within(text, button.rect) ? element : undefined;
}

// The native button a quoted Tap may press for a hidden text, only when this one read proves every link.
export function hiddenTextButton(target: Target, screen: Screen): Element | undefined {
  const found = hiddenFromAccessibility(target, screen, 'exact');
  const button = found?.hosts.length === 1 ? found.button : undefined;
  const evidence = screen.reactHostEvidence;
  if (!found || !button?.testID || !evidence) return;
  // Hidden hosts count too: a repeated test id names no single button.
  if (evidence.hosts.filter((host) => host.testID === button.testID).length !== 1) return;
  return provenButton(found, button, screen, (e) => associatedHostOf(e) === button.host);
}

// The same for a button with neither label nor test id: the join's frame match is its only tie, and
// only the hidden text's own words, never a hidden child's test id, name it.
export function hiddenTextUnnamedButton(target: Target, screen: Screen): Element | undefined {
  const tie = unnamedTie(target, screen);
  return (
    tie &&
    provenButton(tie.found, tie.button, screen, (e) => frameMatchedHostOf(e) === tie.button.host)
  );
}

export function hiddenTextUnnamedLocated(
  target: Target,
  screen: Screen,
): { element: Element; cutOff: boolean; covered: boolean } | undefined {
  const tie = unnamedTie(target, screen);
  const element =
    tie &&
    provenButton(
      tie.found,
      tie.button,
      screen,
      (e) => frameLocatedOf(e)?.host === tie.button.host,
      true,
    );
  if (!element) return;
  const match = frameLocatedOf(element);
  if (!match || (!match.cutOff && !match.covered)) return;
  return { element, cutOff: match.cutOff, covered: match.covered };
}

// One hidden text with these exact words inside a pressable host that has neither test id nor label.
function unnamedTie(target: Target, screen: Screen) {
  const found = hiddenFromAccessibility(target, screen, 'exact');
  const button = found?.hosts.length === 1 ? found.button : undefined;
  const evidence = screen.reactHostEvidence;
  const text = found && evidence?.typography?.nodes[found.hosts[0]]?.text;
  if (
    !found ||
    !button ||
    target.exact === 'id' ||
    text?.kind !== 'block' ||
    text.content !== target.quoted ||
    button.testID !== undefined ||
    button.labelled !== false ||
    // No test id carries React's disabled state to the native element here.
    evidence?.hosts[button.host]?.disabled
  )
    return;
  return { found, button };
}

const point = (n: number) => String(Math.round(n * 10) / 10);

// A frame for output, as x,y,width,height to a tenth of a point.
export const frameText = (rect: Rect): string =>
  [rect.x, rect.y, rect.width, rect.height].map(point).join(',');

// A button's test id for output, quoted; as in failure.screen, one holding any private value is masked whole.
export function buttonId(testID: string, privacy: ObservedPrivacy): string {
  return privacy.redactIdentifier(testID) === testID
    ? `"${testID.slice(0, MISS_TEXT).replace(/[\uD800-\uDFFF]/gu, '�')}"`
    : MASK;
}

// The failure clause for a quoted target only hidden text carries; it holds no app text but the button's id.
export function hiddenTextClause(
  found: HiddenText,
  quoted: string,
  privacy: ObservedPrivacy,
): string {
  const shown = (text: string) =>
    privacy
      .redact(text)
      .slice(0, MISS_TEXT)
      .replace(/[\uD800-\uDFFF]/gu, '�');
  const literal = `"${shown(quoted)}"`;
  const single = found.hosts.length === 1;
  const lead = single
    ? `${literal} is`
    : `${found.hosts.length} texts hidden from accessibility carry ${literal}`;
  const button = found.button;
  if (!button)
    return single
      ? `; ${literal} exists only inside a view the app hides from accessibility, so no element carries it`
      : `; ${lead}, so no element carries it`;
  const id = button.testID === undefined ? undefined : buttonId(button.testID, privacy);
  const inside = `; ${lead}${single ? '' : ','} inside a button that hides its children from accessibility`;
  const at = button.rect
    ? ` (the button at ${frameText(button.rect)}${id ? `, testID ${id}` : ''})`
    : id
      ? ` (testID ${id})`
      : '';
  if (button.labelled === true)
    return `${inside}${at}; the button is reached by its own label${id ? ` or its testID ${id}` : ''}, not by this text`;
  if (button.labelled === false)
    return `${inside} and has no accessibilityLabel${at}, so no element carries it. Give the button an accessibilityLabel${id ? `, or target ${id}` : ''}`;
  return `${inside}${at}, so no element carries it${id ? `; target ${id}` : ''}`;
}
