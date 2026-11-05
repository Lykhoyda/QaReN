// shortcut: 48px clears touch slop up to 6x density; prefer runner-provided slop when available.
export const MIN_DRAG_TRAVEL = 48;
export const MIN_SCROLL_BAND_HEIGHT = MIN_DRAG_TRAVEL + 2;

export type ScrollBand = { x?: number; y?: number; width: number; height: number };

export function trimScrollBand(
  within: ScrollBand | undefined,
  screen: { width: number; height: number },
  keyboardTop: number | null,
  androidInset?: number,
): ScrollBand {
  const height =
    keyboardTop !== null && keyboardTop > 0 && keyboardTop < screen.height
      ? keyboardTop
      : screen.height;
  if (!within) return { width: screen.width, height };
  const bandTop = Math.max(within.y ?? 0, 0);
  const bandBottom = Math.min((within.y ?? 0) + within.height, height);
  if (bandBottom <= bandTop) return { ...within, height: 0 };
  const top = Math.max(bandTop, androidInset ?? 20);
  const bottom = Math.min(bandBottom, screen.height - (androidInset ?? 34));
  return { x: within.x, y: top, width: within.width, height: Math.max(0, bottom - top) };
}

export function scrollBandTooSmall(band: ScrollBand): string | undefined {
  return band.width < 2 || band.height < MIN_SCROLL_BAND_HEIGHT
    ? `the ${Math.round(band.height)}px band cannot host a ${MIN_DRAG_TRAVEL}px drag`
    : undefined;
}

export function computeScrollFromDirection(
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number,
  screen: ScrollBand,
  distance?: number,
): { x1: number; y1: number; x2: number; y2: number } | undefined {
  const cx = Math.round((screen.x ?? 0) + screen.width / 2);
  const cy = Math.round((screen.y ?? 0) + screen.height / 2);
  const caller = screen.x !== undefined || screen.y !== undefined;
  const deadZone = Math.max(1, Math.min(screen.height * 0.1, screen.height - MIN_DRAG_TRAVEL - 1));
  const span = caller ? Math.floor(screen.height - deadZone - 1) : screen.height * 0.6;
  const dy = Math.round(
    distance !== undefined && Number.isFinite(distance) && distance > 0
      ? caller
        ? Math.max(Math.min(distance, span), Math.min(MIN_DRAG_TRAVEL, span))
        : Math.min(distance, span)
      : caller
        ? span
        : screen.height * 0.4 * amount,
  );
  const dx = Math.round(screen.width * 0.4 * amount);
  if (caller && (direction === 'down' || direction === 'up')) {
    const start =
      direction === 'down'
        ? Math.floor((screen.y ?? 0) + screen.height - deadZone)
        : Math.ceil((screen.y ?? 0) + deadZone);
    const end =
      direction === 'down'
        ? Math.max(start - dy, Math.ceil((screen.y ?? 0) + 1))
        : Math.min(start + dy, Math.floor((screen.y ?? 0) + screen.height - 1));
    if (Math.abs(end - start) < MIN_DRAG_TRAVEL) return undefined;
    return { x1: cx, y1: start, x2: cx, y2: end };
  }
  // Rounding the centre and the half-span up together can land an end on the band's edge row.
  const top = Math.max(cy - Math.round(dy / 2), Math.ceil((screen.y ?? 0) + 1));
  const bottom = Math.min(cy + Math.round(dy / 2), Math.floor((screen.y ?? 0) + screen.height - 1));
  switch (direction) {
    case 'down':
      return { x1: cx, y1: bottom, x2: cx, y2: top };
    case 'up':
      return { x1: cx, y1: top, x2: cx, y2: bottom };
    case 'left':
      return { x1: cx + Math.round(dx / 2), y1: cy, x2: cx - Math.round(dx / 2), y2: cy };
    case 'right':
      return { x1: cx - Math.round(dx / 2), y1: cy, x2: cx + Math.round(dx / 2), y2: cy };
  }
}
