import { hostPath } from './host-association.js';
import type { NativeNode, ReactHostEvidence } from './screen.js';

type Rect = NonNullable<NativeNode['rect']>;

// The host a touch at a point reaches, nothing, or unresolved when the evidence cannot order the hosts.
export type ReactHit = number | 'none' | 'unresolved';

function inside(rect: Rect, x: number, y: number): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
  );
}

/**
 * React Native's own hit test over one capture's hosts, at a point in [frame]'s space: siblings from the
 * top of their paint order (zIndex, then fiber order), children before their parent, `none` and hidden
 * subtrees skipped, `box-none` passing to its children and `box-only` keeping them out. A sibling without
 * a known paint position (a missing or repeated order) leaves the hit unresolved only when its subtree
 * holds a frame over the point; elsewhere it cannot take the touch.
 */
export function reactHitTest(
  evidence: ReactHostEvidence,
  frame: (rect: Rect) => Rect,
): (x: number, y: number) => ReactHit {
  const nodes = evidence.typography?.nodes ?? [];
  const children = new Map<number | null, number[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentHostIndex) ?? [];
    siblings.push(node.hostIndex);
    children.set(node.parentHostIndex, siblings);
  }
  // Topmost first among the siblings with a known paint position; a lone child needs none.
  const ranked = new Map<number, { painted: number[]; unknown: number[] }>();
  const rank = (parent: number) => {
    const cached = ranked.get(parent);
    if (cached) return cached;
    const siblings = children.get(parent) ?? [];
    const order = (i: number) => evidence.hosts[i]?.order;
    const placed = (i: number) =>
      siblings.length === 1 ||
      (order(i) !== undefined && siblings.filter((j) => order(j) === order(i)).length === 1);
    const z = (i: number) => evidence.hosts[i].zIndex ?? 0;
    const result = {
      painted: siblings.filter(placed).sort((a, b) => z(b) - z(a) || order(b)! - order(a)!),
      unknown: siblings.filter((i) => !placed(i)),
    };
    ranked.set(parent, result);
    return result;
  };
  return (x, y) => {
    const holds = new Map<number, boolean>();
    const holdsPoint = (i: number): boolean => {
      if (!holds.has(i)) {
        const rect = nodes[i].rect;
        holds.set(
          i,
          (!!rect && inside(frame(rect), x, y)) || (children.get(i) ?? []).some(holdsPoint),
        );
      }
      return holds.get(i)!;
    };
    const visit = (i: number): ReactHit => {
      const host = evidence.hosts[i];
      const pointerEvents = host.pointerEvents ?? 'auto';
      if (host.hidden || pointerEvents === 'none') return 'none';
      if (pointerEvents !== 'box-only') {
        const { painted, unknown } = rank(i);
        if (unknown.some(holdsPoint)) return 'unresolved';
        for (const child of painted) {
          const hit = visit(child);
          if (hit !== 'none') return hit;
        }
      }
      const rect = nodes[i].rect;
      return pointerEvents !== 'box-none' && rect && inside(frame(rect), x, y) ? i : 'none';
    };
    // Separate roots carry no paint order between them.
    const roots = children.get(null) ?? [];
    return roots.length === 1 ? visit(roots[0]) : 'unresolved';
  };
}

// The touch reaches a host when it lands on the host itself, one of its descendants or an ancestor.
export function touchReaches(evidence: ReactHostEvidence, target: number, hit: ReactHit): boolean {
  if (typeof hit !== 'number' || !evidence.typography) return false;
  return (
    !!hostPath(evidence.typography, hit)?.includes(target) ||
    !!hostPath(evidence.typography, target)?.includes(hit)
  );
}
