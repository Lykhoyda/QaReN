import { INPUT_HOST_TYPES } from '../../qa/input-host-types.js';
import type { FiberLike } from './types.js';

// Known host kinds use platform view names, not composite component names.
const HOST_KIND_NAMES: Record<string, readonly string[]> = {
  text: ['Text', 'RCTText'],
  textinput: INPUT_HOST_TYPES,
  image: ['Image', 'RCTImageView', 'RCTImage'],
  switch: ['Switch', 'RCTSwitch'],
  scrollview: ['ScrollView', 'RCTScrollView'],
  modal: ['Modal', 'RCTModalHostView'],
};

// A plain object, as before: lookups of prototype keys resolve through Object.prototype.
export const HOST_KIND_LOOKUP: Record<string, string> = (function () {
  const map: Record<string, string> = {};
  const kinds = Object.keys(HOST_KIND_NAMES);
  for (let ki = 0; ki < kinds.length; ki++) {
    const names = HOST_KIND_NAMES[kinds[ki]!]!;
    for (let ni = 0; ni < names.length; ni++) map[names[ni]!] = kinds[ki]!;
  }
  return map;
})();

export function isHostFiber(fiber: FiberLike | null | undefined): boolean {
  return !!fiber && (fiber.tag === 5 || typeof fiber.type === 'string');
}

export function hostKind(fiber: FiberLike | null | undefined): string | null {
  if (!fiber || !fiber.type) return null;
  if (fiber.tag === 6) return null;
  const name =
    typeof fiber.type === 'string'
      ? fiber.type
      : (fiber.type as { displayName?: unknown }).displayName ||
        (fiber.type as { name?: unknown }).name ||
        null;
  if (!name) return null;
  const kind = HOST_KIND_LOOKUP[name as string];
  return kind || null;
}
