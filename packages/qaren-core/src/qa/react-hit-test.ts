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
 * subtrees skipped, `box-none` passing to its children and `box-only` keeping them out.
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
  // Topmost first; undefined when a missing or repeated order leaves the paint order unknown.
  const painted = new Map<number | null, number[] | undefined>();
  const topmostFirst = (parent: number | null): number[] | undefined => {
    if (painted.has(parent)) return painted.get(parent);
    const siblings = children.get(parent) ?? [];
    const orders = siblings.map((i) => evidence.hosts[i]?.order);
    const known =
      orders.every((order) => order !== undefined) && new Set(orders).size === orders.length;
    const z = (i: number) => evidence.hosts[i].zIndex ?? 0;
    const sorted = known
      ? [...siblings].sort(
          (a, b) => z(b) - z(a) || evidence.hosts[b].order! - evidence.hosts[a].order!,
        )
      : undefined;
    painted.set(parent, sorted);
    return sorted;
  };
  return (x, y) => {
    const visit = (i: number): ReactHit => {
      const host = evidence.hosts[i];
      const pointerEvents = host.pointerEvents ?? 'auto';
      if (host.hidden || pointerEvents === 'none') return 'none';
      if (pointerEvents !== 'box-only') {
        const above = topmostFirst(i);
        if (!above) return 'unresolved';
        for (const child of above) {
          const hit = visit(child);
          if (hit !== 'none') return hit;
        }
      }
      const rect = nodes[i].rect;
      return pointerEvents !== 'box-none' && rect && inside(frame(rect), x, y) ? i : 'none';
    };
    // Separate roots carry no paint order between them.
    const roots = topmostFirst(null);
    return roots?.length === 1 ? visit(roots[0]) : 'unresolved';
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
