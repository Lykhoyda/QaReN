import { throwIfInputPrivacyRefused } from './qa/inputs.js';
import { throwIfCancelled } from './domain/cancellation.js';
import { exactIdentities } from './qa/identity.js';
import { join } from './qa/screen.js';
import { hashSnapshotNodes } from './lifecycle/settle-hash.js';

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SnapshotNode {
  ref: string;
  rect: ElementRect;
  label?: string;
  identifier?: string;
  type?: string;
  packageName?: string;
  checked?: boolean;
  enabled?: boolean;
  hittable?: boolean;
}

export interface FlatNode {
  ref: string;
  presence?: unknown;
  index?: number;
  parentIndex?: number;
  depth?: number;
  type: string;
  label?: string;
  identifier?: string;
  packageName?: string;
  checked?: boolean;
  rect: ElementRect;
  enabled?: boolean;
  hittable?: boolean;
  selected?: boolean;
  /** Android QA reads: the accessibility visible-to-user fact. */
  visibleToUser?: boolean;
  /** Android QA reads: the accessibility heading fact, present only when true. */
  heading?: boolean;
  /** GH #581: Android password fields; never cached beyond the snapshot nodes. */
  secure?: boolean;
}

interface XCUITreeNode {
  type?: string;
  identifier?: string;
  label?: string;
  frame?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  hittable?: boolean;
  children?: XCUITreeNode[];
}

interface RefMetadata {
  type: string;
  label?: string;
  identifier?: string;
}

export interface RefSignature {
  type: string;
  label?: string;
  identifier?: string;
  rect?: ElementRect;
}

interface StoredRefRecord extends RefMetadata {
  packageName?: string;
  snapshotNodeIndex: number;
  snapshotGeneration: number;
  keyboardStateAtSnapshot: boolean | null;
}

let refMap = new Map<string, ElementRect>();
let metadataMap = new Map<string, StoredRefRecord>();
let screenRect: ElementRect | null = null;
let screenPointScale = 1;
let lastUpdated = 0;
let lastSnapshotHash: string | null = null;
const lastPackageSnapshotHashes = new Map<string, string>();
let snapshotGeneration = 0;
let keyboardStateAtSnapshot: boolean | null = null;
let keyboardTop: number | null = null;

// Screen-rect derivation: hittable-seeded union GROWN BY OVERLAP.
//
// Two device/review-proven failure modes bound the problem from both sides:
//  - An ALL-nodes union over-covers: both runners keep OFF-SCREEN content in
//    the snapshot with real out-of-viewport coords (RN FlatList windowing
//    mounts rows screens past the fold; non-virtualized ScrollView children)
//    marked hittable:false — including them inflates the rect, pushes
//    direction gestures off the physical screen, and false-passes
//    scrollintoview's isInViewport.
//  - A hittable-ONLY union under-covers: container/window nodes can be
//    hittable:false while only a small control is hittable, collapsing the
//    "viewport" to that control's extent (short top-of-screen drags).
// The rule: seed with the union of hittable nodes (a visible element is
// hittable, so it contributes its own rect), then repeatedly extend by any
// node whose rect INTERSECTS the current estimate. On-screen containers
// overlap the seed and pull the extent to the true window; off-screen rows
// past the fold are disjoint and stay excluded. (Residual accepted risk: a
// content-sized container rect overlapping the viewport would re-inflate —
// both runners report frame-bounded container rects, so this is theoretical.)
// Snapshots with no usable hittable data fall back to the all-nodes union
// (pre-hittable behavior). A (0,0)-anchored heuristic is NOT usable at all:
// on some Android snapshots (#387 Phase B device-proven) no node spans the
// full window and the tallest (0,0) node is a ~128px top-chrome strip.
interface ExtentEntry {
  rect: ElementRect;
  hittable: boolean | undefined;
  type?: string;
}

// #519 review: honest hittable (#395) guarantees only the CENTER is on-screen,
// so a straddling card (x=250..550 on a 402pt viewport) is legitimately
// hittable and would seed the union past the physical screen. Application/Window
// extents cap the estimate for iOS and Android QA snapshots. Android device-tool
// snapshots retain Java class names and therefore use the uncapped estimate.
const WINDOW_TYPES = new Set(['Application', 'Window']);

// width > 300 keeps the same sanity floor the old heuristic used (ignore
// degenerate all-tiny snapshots rather than emit a bogus rect).
function extentToRect(right: number, bottom: number): ElementRect | null {
  return right > 300 && bottom > 0 ? { x: 0, y: 0, width: right, height: bottom } : null;
}

function windowCap(entries: ExtentEntry[]): { right: number; bottom: number } | null {
  let right = 0;
  let bottom = 0;
  for (const e of entries) {
    if (e.type === undefined || !WINDOW_TYPES.has(e.type)) continue;
    const { x, y, width, height } = e.rect;
    if (width <= 0 || height <= 0) continue;
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }
  return right > 300 && bottom > 0 ? { right, bottom } : null;
}

function resolveScreenRect(entries: ExtentEntry[]): ElementRect | null {
  const cap = windowCap(entries);
  let allRight = 0;
  let allBottom = 0;
  let hitRight = 0;
  let hitBottom = 0;
  const usable: ExtentEntry[] = [];
  for (const e of entries) {
    const { x, y, width, height } = e.rect;
    if (width <= 0 || height <= 0) continue;
    usable.push(e);
    allRight = Math.max(allRight, x + width);
    allBottom = Math.max(allBottom, y + height);
    if (e.hittable === true) {
      hitRight = Math.max(hitRight, x + width);
      hitBottom = Math.max(hitBottom, y + height);
    }
  }
  if (cap !== null) {
    allRight = Math.min(allRight, cap.right);
    allBottom = Math.min(allBottom, cap.bottom);
    hitRight = Math.min(hitRight, cap.right);
    hitBottom = Math.min(hitBottom, cap.bottom);
  }
  if (hitRight <= 0 || hitBottom <= 0) return extentToRect(allRight, allBottom);

  // Grow the hittable seed by overlap until stable (bounded — each pass only
  // ever extends, and stops as soon as nothing new intersects).
  let right = hitRight;
  let bottom = hitBottom;
  for (let pass = 0; pass < 10; pass++) {
    let grew = false;
    for (const e of usable) {
      const { x, y, width, height } = e.rect;
      const intersects = x < right && y < bottom && x + width > 0 && y + height > 0;
      if (!intersects) continue;
      if (x + width > right) {
        right = x + width;
        grew = true;
      }
      if (y + height > bottom) {
        bottom = y + height;
        grew = true;
      }
    }
    if (!grew) break;
  }
  // Re-apply the window cap: growth extends by ANY intersecting rect, so a
  // straddling node re-inflates past the seed clamp without this.
  if (cap !== null) {
    right = Math.min(right, cap.right);
    bottom = Math.min(bottom, cap.bottom);
  }
  return extentToRect(right, bottom) ?? extentToRect(allRight, allBottom);
}

export function updateRefMap(nodes: SnapshotNode[]): void {
  refMap.clear();
  screenRect = null;
  screenPointScale = 1;
  keyboardTop = null;

  const entries: ExtentEntry[] = [];
  for (const node of nodes) {
    if (!node.ref || !node.rect) continue;
    refMap.set(node.ref, node.rect);
    entries.push({ rect: node.rect, hittable: node.hittable, type: node.type });
  }
  screenRect = resolveScreenRect(entries);

  lastUpdated = Date.now();
}

/** Printed form for a snapshot id: `e3` → `@e3`; testIDs pass through. */
export function pinnedElementRef(ref: string): string {
  return /^e\d+$/.test(ref) ? `@${ref}` : ref;
}

export function lookupRef(ref: string): ElementRect | null {
  const clean = ref.startsWith('@') ? ref.slice(1) : ref;
  return refMap.get(clean) ?? null;
}

export function refCenter(ref: string): { x: number; y: number } | null {
  const rect = lookupRef(ref);
  if (!rect) return null;
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

export function getScreenRect(): ElementRect | null {
  return screenRect;
}

export function getScreenPointScale(): number {
  return screenPointScale;
}

export function getKeyboardTop(): number | null {
  return keyboardTop;
}

export function getRefMapAge(): number {
  return lastUpdated ? Date.now() - lastUpdated : Infinity;
}

// A @ref resolves to fixed coordinates captured at snapshot time. If the
// snapshot is old, the UI may have scrolled/re-rendered and those coordinates
// now point at a different element — a wrong-element tap that STALE_REF (which
// only fires on absent refs) would not catch. Callers gate coordinate
// resolution on this so an over-age map is treated like a stale ref.
export const MAX_REF_MAP_AGE_MS = 60_000;

export function isRefMapFresh(maxAgeMs: number = MAX_REF_MAP_AGE_MS): boolean {
  return getRefMapAge() <= maxAgeMs;
}

export function clearRefMap(): void {
  refMap.clear();
  metadataMap.clear();
  screenRect = null;
  screenPointScale = 1;
  lastUpdated = 0;
  lastSnapshotHash = null;
  lastPackageSnapshotHashes.clear();
  snapshotGeneration = 0;
  keyboardStateAtSnapshot = null;
  keyboardTop = null;
}

export function hasRefMap(): boolean {
  return refMap.size > 0;
}

export function flattenXCUITree(tree: XCUITreeNode): {
  nodes: FlatNode[];
  refMap: Map<string, ElementRect>;
} {
  const nodes: FlatNode[] = [];
  const localRefMap = new Map<string, ElementRect>();
  let counter = 0;

  const walk = (node: XCUITreeNode | undefined | null): void => {
    if (!node || typeof node !== 'object') return;
    if (node.frame) {
      const id = `e${counter}`;
      counter++;
      const rect: ElementRect = {
        x: node.frame.x,
        y: node.frame.y,
        width: node.frame.width,
        height: node.frame.height,
      };
      const flat: FlatNode = {
        ref: `@${id}`,
        type: node.type ?? '',
        rect,
      };
      if (node.label !== undefined) flat.label = node.label;
      if (node.identifier !== undefined) flat.identifier = node.identifier;
      if (node.enabled !== undefined) flat.enabled = node.enabled;
      if (node.hittable !== undefined) flat.hittable = node.hittable;
      nodes.push(flat);
      localRefMap.set(id, rect);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  };

  walk(tree);
  return { nodes, refMap: localRefMap };
}

export interface RefMapUpdateOutcome {
  applied: boolean;
  reason?: 'empty-capture' | 'snapshot-ref-freshness-unknown';
}

// GH #409 (Story 16): a snapshot quality verdict for the runner capture path,
// computed once where the ref-map decision is made so meta.snapshotVerdict and
// the actual overwrite behavior can never disagree.
export interface SnapshotQualityVerdict {
  state: 'ok' | 'degraded';
  source: string;
  nodeCount: number;
  refMapUpdated: boolean;
  reasons: string[];
}

export function buildSnapshotVerdict(
  source: string,
  nodeCount: number,
  outcome: RefMapUpdateOutcome,
): SnapshotQualityVerdict {
  const reasons: string[] = [];
  if (nodeCount === 0) reasons.push('empty-capture');
  if (outcome.reason && !reasons.includes(outcome.reason)) reasons.push(outcome.reason);
  return {
    state: reasons.length > 0 ? 'degraded' : 'ok',
    source,
    nodeCount,
    refMapUpdated: outcome.applied,
    reasons,
  };
}

export function updateRefMapFromFlat(
  nodes: FlatNode[],
  freshness: { snapshotGeneration?: number; keyboardVisible?: boolean; pointScale?: unknown } = {},
): RefMapUpdateOutcome {
  // GH #409: a zero-node capture is indistinguishable from a degraded walk
  // (AX failure, wedged runner, mid-transition screen). It must never wipe the
  // last-known-good map — refs stay bound to the last verified capture, and a
  // genuinely emptied screen surfaces as STALE_REF on the next tap instead of
  // silently serving nothing.
  let validCount = 0;
  for (const node of nodes) {
    if (node.ref && node.rect) validCount++;
  }
  if (validCount === 0 && refMap.size > 0) {
    return { applied: false, reason: 'empty-capture' };
  }

  refMap.clear();
  screenRect = null;
  screenPointScale =
    typeof freshness.pointScale === 'number' &&
    Number.isFinite(freshness.pointScale) &&
    freshness.pointScale > 0
      ? freshness.pointScale
      : 1;
  snapshotGeneration = freshness.snapshotGeneration ?? snapshotGeneration + 1;
  keyboardStateAtSnapshot = freshness.keyboardVisible ?? null;
  keyboardTop = null;

  const hashed: FlatNode[] = [];
  // Screen rect: hittable-first union with an all-nodes fallback — same
  // rationale as updateRefMap (off-screen mounted rows must not inflate the
  // viewport; a (0,0)-anchored pick is fragile when no node spans the window).
  const entries: ExtentEntry[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.ref || !node.rect) continue;
    const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
    refMap.set(key, node.rect);

    const numericRef = /^e(\d+)$/.exec(key);
    const meta: StoredRefRecord = {
      type: node.type,
      snapshotNodeIndex: numericRef ? Number(numericRef[1]) : i,
      snapshotGeneration,
      keyboardStateAtSnapshot,
    };
    if (node.label !== undefined) meta.label = node.label;
    if (node.identifier !== undefined) meta.identifier = node.identifier;
    if (node.packageName !== undefined) meta.packageName = node.packageName;
    metadataMap.set(key, meta);
    hashed.push(node);

    entries.push({ rect: node.rect, hittable: node.hittable, type: node.type });
    if (keyboardStateAtSnapshot && node.type === 'Keyboard' && node.rect.height > 0)
      keyboardTop = Math.min(keyboardTop ?? node.rect.y, node.rect.y);
  }
  screenRect = resolveScreenRect(entries);

  // Hash only the nodes that passed the ref/rect filter: hashSnapshotNodes
  // dereferences node.rect.* unconditionally, and a malformed entry must not
  // throw mid-update. For real runner data the filtered subset equals the full
  // array (both mappers pre-filter !rect), so comparability with the settle
  // probes is preserved. Privacy cancellation invalidates every rejected ref.
  try {
    lastSnapshotHash = hashSnapshotNodes(hashed);
    lastPackageSnapshotHashes.clear();
    const byPackage = new Map<string, FlatNode[]>();
    for (const node of hashed) {
      if (!node.packageName) continue;
      const packageNodes = byPackage.get(node.packageName) ?? [];
      packageNodes.push(node);
      byPackage.set(node.packageName, packageNodes);
    }
    for (const [packageName, packageNodes] of byPackage) {
      lastPackageSnapshotHashes.set(packageName, hashSnapshotNodes(packageNodes));
    }
  } catch {
    lastSnapshotHash = null;
    lastPackageSnapshotHashes.clear();
    try {
      throwIfInputPrivacyRefused();
      throwIfCancelled();
    } catch (error) {
      clearRefMap();
      throw error;
    }
  }
  lastUpdated = Date.now();
  return { applied: true };
}

export interface FreshRefTarget {
  rect: ElementRect;
  snapshotGeneration: number;
  snapshotNodeIndex: number;
  snapshotElementType: string;
  snapshotLabel?: string;
  snapshotIdentifier?: string;
  keyboardStateAtSnapshot: boolean | null;
}

export function getFreshRefTarget(
  ref: string,
  opts: { allowUnknownKeyboardState?: boolean } = {},
): FreshRefTarget | null {
  if (!isRefMapFresh()) return null;
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  const rect = refMap.get(key);
  const record = metadataMap.get(key);
  if (
    !rect ||
    !record ||
    record.snapshotGeneration !== snapshotGeneration ||
    (record.keyboardStateAtSnapshot === null && opts.allowUnknownKeyboardState !== true)
  )
    return null;
  return {
    rect,
    snapshotGeneration: record.snapshotGeneration,
    snapshotNodeIndex: record.snapshotNodeIndex,
    snapshotElementType: record.type,
    ...(record.label !== undefined ? { snapshotLabel: record.label } : {}),
    ...(record.identifier !== undefined ? { snapshotIdentifier: record.identifier } : {}),
    keyboardStateAtSnapshot: record.keyboardStateAtSnapshot,
  };
}

export function getCachedMetadata(ref: string): RefMetadata | null {
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  const rec = metadataMap.get(key);
  if (!rec) return null;
  const meta: RefMetadata = { type: rec.type };
  if (rec.label !== undefined) meta.label = rec.label;
  if (rec.identifier !== undefined) meta.identifier = rec.identifier;
  return meta;
}

export function getCachedPackageName(ref: string): string | null {
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  return metadataMap.get(key)?.packageName ?? null;
}

export function getCachedSignature(ref: string): RefSignature | null {
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  const rec = metadataMap.get(key);
  if (!rec) return null;
  const sig: RefSignature = {
    type: rec.type,
  };
  if (rec.label !== undefined) sig.label = rec.label;
  if (rec.identifier !== undefined) sig.identifier = rec.identifier;
  return sig;
}

export function getLastSnapshotHash(): string | null {
  return lastSnapshotHash;
}

export function getLastSnapshotHashForPackage(packageName: string): string | null {
  return lastPackageSnapshotHashes.get(packageName) ?? null;
}

// Story 05 (#386): called when a mutating verb settles without any hash
// observation — the screen may have changed unobserved, so the baseline must
// not be compared against. Fail-open beats fail-wrong.
export function invalidateLastSnapshotHash(): void {
  lastSnapshotHash = null;
  lastPackageSnapshotHashes.clear();
}

function metadataMatches(a: RefMetadata, b: RefMetadata): boolean {
  return a.type === b.type && a.label === b.label && a.identifier === b.identifier;
}

function flatNodeMetadata(node: FlatNode): RefMetadata {
  const meta: RefMetadata = { type: node.type };
  if (node.label !== undefined) meta.label = node.label;
  if (node.identifier !== undefined) meta.identifier = node.identifier;
  return meta;
}

export function isRefStale(ref: string, newNodes: FlatNode[]): boolean {
  const cached = getCachedMetadata(ref);
  if (!cached) return true;
  const target = ref.startsWith('@') ? ref : `@${ref}`;
  const fresh = newNodes.find((n) => n.ref === target);
  if (!fresh) return true;
  return !metadataMatches(cached, flatNodeMetadata(fresh));
}

export function findNewRefByMetadata(oldRef: string, newNodes: FlatNode[]): string | null {
  const cached = getCachedMetadata(oldRef);
  if (!cached) return null;
  for (const node of newNodes) {
    if (metadataMatches(cached, flatNodeMetadata(node))) {
      return node.ref;
    }
  }
  return null;
}

export function flattenAndroidAccessibilityTree(nodes: FlatNode[]): {
  nodes: FlatNode[];
  refMap: Map<string, { x: number; y: number; width: number; height: number }>;
} {
  const localRefMap = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const node of nodes) {
    if (!node.ref || !node.rect) continue;
    const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
    localRefMap.set(key, node.rect);
  }
  return { nodes, refMap: localRefMap };
}

export type RefreshOutcome =
  | { kind: 'unique'; node: FlatNode }
  | { kind: 'ambiguous'; candidates: FlatNode[] }
  | { kind: 'absent' };

export function refreshRef(sig: RefSignature, nodes: FlatNode[]): RefreshOutcome {
  // Android reports identifier="" for nodes without a resource id; join treats that as no id.
  const identifier = sig.identifier?.trim() ? sig.identifier : undefined;
  const quoted = identifier ?? sig.label;
  if (quoted === undefined) return { kind: 'absent' };
  const identities = exactIdentities(
    join(nodes, []),
    { quoted, phrase: quoted, exact: identifier !== undefined ? 'id' : 'text' },
    'press',
    'refresh',
  );
  const matches = identities.map(({ element }) => nodes.find((node) => node.ref === element.ref)!);
  if (matches.length === 0) return { kind: 'absent' };
  if (matches.length === 1) return { kind: 'unique', node: matches[0] };
  return { kind: 'ambiguous', candidates: matches };
}
