import {
  type Element,
  type Screen,
  ancestorsOf,
  elementFrame,
  isScrollContainer,
  scrollContainerType,
} from './screen.js';

function identities(values: (string | undefined)[]): string {
  return JSON.stringify([...new Set(values.flatMap((value) => (value ? [value] : [])))].sort());
}

export function scrollNavigationChange(
  before: Screen,
  after: Screen,
  container?: Element,
): string | undefined {
  const selected = (screen: Screen) =>
    identities(
      screen.elements
        .filter(
          (element) =>
            element.selected &&
            !isScrollContainer(element) &&
            !ancestorsOf(element).some(isScrollContainer),
        )
        .map((element) => (element.testID ? `id:${element.testID}` : element.label)),
    );
  if (selected(before) !== selected(after))
    return 'selected element outside the scroll list changed';
  if (container) {
    const frame = elementFrame(container);
    const tolerance = 2 * (before.pointScale ?? 1);
    const present = after.elements.some((element) => {
      if (
        !isScrollContainer(element) ||
        scrollContainerType(element) !== scrollContainerType(container)
      )
        return false;
      if (container.testID) return element.testID === container.testID;
      const next = elementFrame(element);
      return (
        frame &&
        next &&
        (['x', 'y', 'width', 'height'] as const).every(
          (axis) => Math.abs(frame[axis] - next[axis]) <= tolerance,
        )
      );
    });
    if (!present) return 'scrolled list disappeared or changed';
  }
}
