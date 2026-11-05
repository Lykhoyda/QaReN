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

// The bound target's own captured semantics did not change.
export function targetUnchanged(
  before: Screen,
  after: Screen,
  target: Element,
  current: Element | undefined,
): boolean {
  return current !== undefined && subtree(before, target) === subtree(after, current);
}

export function outsideTargetChange(
  before: Screen,
  after: Screen,
  target: Element,
  current: Element | undefined,
): boolean {
  return (
    screenSignature(before) !== screenSignature(after) &&
    targetUnchanged(before, after, target, current)
  );
}

export const PRESS_NOT_REGISTERED_REASON =
  'Selection could not be verified; no second press was sent because the first press may already have changed an unobservable selection.';
export const PRESS_OUTSIDE_CHANGE_REASON =
  'Selection could not be verified; captured target semantics were unchanged while other captured screen semantics changed; no second press was sent.';

// `bound` is false when the final readback could not re-identify the tapped control, so its selection was never read.
export const selectionPressGuidance = (
  captures: 1 | 2,
  elapsedMs: number,
  bound: boolean,
): string => {
  const observed = `${captures} observations over ${Math.max(0, Math.round(elapsedMs))} ms`;
  return bound
    ? `The tapped control reported no selected state after the tap (${observed}); one tap was sent.`
    : `The tapped control could not be re-identified after the tap (${observed}), so its selected state was not read; one tap was sent.`;
};
