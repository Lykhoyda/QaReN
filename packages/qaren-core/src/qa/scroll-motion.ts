import {
  ancestorsOf,
  elementFrame,
  isScrollContainer,
  nativeTypeOf,
  reportsNotScrollable,
  type Element,
  type NativeNode,
  type Screen,
} from './screen.js';

type Frame = NonNullable<NativeNode['rect']>;
const sameFrame = (a: Frame, b: Frame) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const identity = (element: Element) =>
  JSON.stringify([
    nativeTypeOf(element),
    element.testID ?? null,
    element.testID === undefined ? (element.label ?? null) : null,
    element.testID === undefined ? (element.placeholder ?? null) : null,
  ]);

export function scrollMotion(
  container: Element,
  before: Screen,
  after: Screen,
  direction: 'up' | 'down',
): 'moved' | 'still' | 'still-overflow' | 'unknown' {
  const frame = elementFrame(container);
  if (!frame) return 'unknown';
  const containers = (screen: Screen) => {
    const matches = screen.elements.filter((e) => {
      const rect = elementFrame(e);
      return (
        isScrollContainer(e) &&
        nativeTypeOf(e) === nativeTypeOf(container) &&
        rect &&
        sameFrame(rect, frame)
      );
    });
    // A same-frame twin that reports it cannot scroll (a navigation wrapper) cannot hide the list.
    return matches.length <= 1 || reportsNotScrollable(container)
      ? matches
      : matches.filter((e) => !reportsNotScrollable(e));
  };
  const rebound = containers(after);
  if (containers(before).length !== 1 || rebound.length !== 1) return 'unknown';
  const descendants = (screen: Screen, parent: Element) =>
    screen.elements.filter(
      (e) => ancestorsOf(e).includes(parent) && elementFrame(e) && nativeTypeOf(e),
    );
  const previous = descendants(before, container);
  const current = descendants(after, rebound[0]);
  if (!previous.length || previous.length !== current.length) return 'unknown';
  const group = (elements: Element[]) => {
    const groups = new Map<string, Element[]>();
    for (const e of elements) {
      const key = identity(e);
      const matches = groups.get(key);
      if (matches) matches.push(e);
      else groups.set(key, [e]);
    }
    return groups;
  };
  const previousGroups = group(previous);
  const currentGroups = group(current);
  let moved = false;
  const frames = (elements: Element[]) =>
    new Set(
      elements.map((e) => {
        const r = elementFrame(e)!;
        return JSON.stringify([r.x, r.y, r.width, r.height]);
      }),
    );
  for (const [key, old] of previousGroups) {
    const current = currentGroups.get(key);
    if (!current || old.length !== current.length) return 'unknown';
    const oldFrames = frames(old);
    const newFrames = frames(current);
    if (oldFrames.size !== old.length || newFrames.size !== current.length) return 'unknown';
    const removed = [...oldFrames].filter((f) => !newFrames.has(f));
    const added = [...newFrames].filter((f) => !oldFrames.has(f));
    if (removed.length > 1 || added.length > 1) return 'unknown';
    if (removed.length === 1 && added.length === 1) moved = true;
  }
  if (moved) return 'moved';
  const overflow = current.some((e) => {
    const rect = elementFrame(e)!;
    return direction === 'down' ? rect.y + rect.height > frame.y + frame.height : rect.y < frame.y;
  });
  return overflow ? 'still-overflow' : 'still';
}
