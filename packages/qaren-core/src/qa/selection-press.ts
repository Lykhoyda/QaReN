import {
  ancestorsOf,
  elementFrame,
  insideAlert,
  isScrollContainer,
  screenSignature,
  type Element,
  type Screen,
} from './screen.js';

export interface PressEvidence {
  subreason: 'selection_unverified' | 'target_identity_unavailable';
  heldPress: 'not_tried_unsafe';
  outsideTargetChange: boolean;
  captures: 1 | 2;
}

const nearestScroll = (element: Element) => ancestorsOf(element).find(isScrollContainer);
const frame = (element: Element) => {
  const rect = elementFrame(element);
  return rect && Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0
    ? rect
    : undefined;
};

export function selectionPressCandidate(element: Element, screen: Screen): boolean {
  if (
    element.kind !== 'button' ||
    element.nativeKind === undefined ||
    element.ref.startsWith('react:') ||
    element.selected === true ||
    insideAlert(element)
  )
    return false;
  const container = nearestScroll(element);
  const target = frame(element);
  const row = container && frame(container);
  if (!row || !target || row.height > 3 * target.height) return false;
  return screen.elements.some((peer) => {
    if (
      peer === element ||
      peer.kind !== 'button' ||
      !peer.hittable ||
      peer.disabled ||
      peer.offscreen ||
      nearestScroll(peer) !== container
    )
      return false;
    const rect = frame(peer);
    return (
      rect !== undefined &&
      Math.min(target.y + target.height, rect.y + rect.height) > Math.max(target.y, rect.y) &&
      (target.x + target.width <= rect.x || rect.x + rect.width <= target.x)
    );
  });
}

// These semantic tuples stay in memory and never become diagnostic values or hashes.
const subtree = (screen: Screen, target: Element) =>
  JSON.stringify(
    screen.elements
      .filter((element) => element === target || ancestorsOf(element).includes(target))
      .map((element) => [
        element.kind,
        element.label,
        element.testID,
        element.secure ? null : element.value,
        element.hittable,
        element.disabled,
        element.selected === true,
        element.offscreen,
        element.where,
        element.side,
      ]),
  );

export function outsideTargetChange(
  before: Screen,
  after: Screen,
  target: Element,
  current: Element | undefined,
): boolean {
  return (
    current !== undefined &&
    screenSignature(before) !== screenSignature(after) &&
    subtree(before, target) === subtree(after, current)
  );
}

export const PRESS_NOT_REGISTERED_REASON =
  'Selection could not be verified; no second press was sent because the first press may already have changed an unobservable selection.';
export const PRESS_OUTSIDE_CHANGE_REASON =
  'Selection could not be verified; captured target semantics were unchanged while other captured screen semantics changed; no second press was sent.';

export const selectionPressGuidance = (captures: 1 | 2, elapsedMs: number): string =>
  `The tap did not change the control's selected state (${captures} observations over ${Math.max(0, Math.round(elapsedMs))} ms); the control sits in a row-shaped scrolling list, which can swallow synthetic taps. Next: re-run once; if it repeats on the same control, ask the app team to make the selection reachable for automated taps (for example by disabling the list's own scrolling for this set) or to expose the selected state another way.`;
