import { assertInputHashSafe, maskFilledEcho } from '../qa/inputs.js';
import { createHash } from 'node:crypto';
import type { FlatNode } from '../fast-runner-ref-map.js';

// Quantize geometry without changing identity, label, enabled or checked operands.
const BOUNDS_QUANTUM_PX = 4;

export function normalizeNodeForHash(node: FlatNode): string {
  const q = (v: number): number => Math.round(v / BOUNDS_QUANTUM_PX);
  return JSON.stringify([
    node.identifier ?? '',
    node.type,
    node.label ?? '',
    q(node.rect.x),
    q(node.rect.y),
    q(node.rect.width),
    q(node.rect.height),
    node.enabled ?? null,
    node.checked ?? null,
  ]);
}

export function hashSnapshotNodes(nodes: FlatNode[]): string {
  // Guard observation/input operands; repository and host provenance hashes retain their exact bytes.
  const projected = nodes.map(maskFilledEcho);
  for (const node of projected) {
    for (const text of [node.identifier, node.type, node.label])
      if (typeof text === 'string') assertInputHashSafe(text);
  }
  const tuples = projected.map(normalizeNodeForHash);
  const h = createHash('sha256');
  for (const tuple of tuples) {
    h.update(tuple);
    h.update('\n');
  }
  return h.digest('hex');
}
