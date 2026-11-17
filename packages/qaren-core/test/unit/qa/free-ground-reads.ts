import { readFileSync } from 'node:fs';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, ReactHostEvidence, Screen } from '../../../dist/qa/screen.js';

// Real iOS reads of the Test App's unnamed-cards list after a scroll (run check-20261116T091029Z): the
// ordinary read holds one full-screen empty view outside the list (`app-root`), the presence read nine.
// Each is the exact join() input the device produced; `edit` changes it before the join.
export type UnnamedCardsRead = 'ordinary' | 'presence';

type Rect = NonNullable<NativeNode['rect']>;
export interface JoinArgs {
  nodes: NativeNode[];
  digest: unknown;
  front: unknown;
  coverage: { react: unknown } & Record<string, unknown>;
  reactHostEvidence: ReactHostEvidence;
  nativePresence?: { source: string; nodes: Record<string, unknown>[] };
  nativeAcquisition: unknown;
}

const FILE: Record<UnnamedCardsRead, string> = {
  ordinary: 'g5-obs25-ordinary',
  presence: 'g5-obs27-presence',
};

// Native node indexes of each read: the list, its content view and its three cards.
export const CARDS = {
  ordinary: { list: 15, content: 16, cards: [18, 19, 20] },
  presence: { list: 29, content: 30, cards: [34, 35, 36] },
} as const;
// React hosts, the same in both reads: the list's content view and its three cards.
const CONTENT_HOST = 27;
const CARD_HOSTS = [38, 39, 40];

export function unnamedCards(read: UnnamedCardsRead, edit?: (args: JoinArgs) => void): Screen {
  const { joinArgs: a } = JSON.parse(
    readFileSync(
      new URL(`../../fixtures/ios-hidden-card/${FILE[read]}.json`, import.meta.url),
      'utf8',
    ),
  ) as { joinArgs: JoinArgs };
  edit?.(a);
  const screen = join(
    a.nodes,
    a.digest as never,
    a.front as never,
    a.coverage as never,
    a.reactHostEvidence,
    a.nativePresence as never,
    a.nativeAcquisition as never,
  );
  const generation = a.nodes.find((node) => node.presence?.generation !== undefined)?.presence
    ?.generation;
  return {
    ...screen,
    // Production keeps the acquisition verdict, the keyboard state and the generation beside the join.
    // The join input keeps neither: no keyboard was shown on this screen, and only the presence read
    // carries its generation, on every node.
    captureCoverage: { native: a.nativeAcquisition as never, react: a.coverage.react as never },
    keyboardVisible: false,
    ...(generation !== undefined ? { nativeGeneration: generation } : {}),
  };
}

type InlinePresence = Record<string, unknown> & { nodeIndex?: number };
// A new node's own presence entry, as the device writes one beside every node of a presence read: the
// capture's id, generation and time from `parent`, its own index, not yet observed.
const presenceLike = (
  parent: NativeNode | undefined,
  index: number,
): { presence?: InlinePresence } => {
  const from = (parent as { presence?: InlinePresence } | undefined)?.presence;
  return from
    ? { presence: { ...from, nodeIndex: index, status: 'unknown', labelSource: 'none' } }
    : {};
};

const below = (nodes: NativeNode[], root: number): Set<number> => {
  const inside = new Set([root]);
  for (const node of nodes)
    if (node.parentIndex !== undefined && inside.has(node.parentIndex)) inside.add(node.index);
  return inside;
};

// The list scrolled `dy` points less: its content, native and React alike, moves down.
export function shiftContent(read: UnnamedCardsRead, dy: number): (args: JoinArgs) => void {
  return (a) => {
    for (const index of below(a.nodes, CARDS[read].content)) {
      const rect = a.nodes[index].rect;
      if (rect) a.nodes[index].rect = { ...rect, y: rect.y + dy };
    }
    const typography = a.reactHostEvidence.typography?.nodes ?? [];
    const hosts = new Set([CONTENT_HOST]);
    for (const node of typography)
      if (node.parentHostIndex !== null && hosts.has(node.parentHostIndex))
        hosts.add(node.hostIndex);
    for (const node of typography)
      if (hosts.has(node.hostIndex) && node.rect) node.rect = { ...node.rect, y: node.rect.y + dy };
  };
}

// Card 0, 1 or 2 gets a test id in its native node and in its React host and digest entry.
export function nameCard(
  read: UnnamedCardsRead,
  card: number,
  id: string,
): (args: JoinArgs) => void {
  return (a) => {
    a.nodes[CARDS[read].cards[card]].identifier = id;
    a.reactHostEvidence.hosts[CARD_HOSTS[card]].testID = id;
    for (const entry of a.digest as { hostIndex?: number; testID?: string }[])
      if (entry.hostIndex === CARD_HOSTS[card]) entry.testID = id;
  };
}

// One more native node at list position `at`, under `parent` (a position before the insertion), or a
// root when absent; later nodes move down one place. Apply after every edit that names an index.
export function insertNode(
  at: number,
  parent: number | undefined,
  node: Omit<NativeNode, 'index' | 'parentIndex' | 'depth' | 'ref'> & { rect: Rect },
): (args: JoinArgs) => number {
  return (a) => {
    const moved = (index: number) => (index >= at ? index + 1 : index);
    for (const old of a.nodes) {
      old.index = moved(old.index);
      old.ref = `@e${old.index}`;
      if (old.parentIndex !== undefined) old.parentIndex = moved(old.parentIndex);
      const inline = (old as { presence?: InlinePresence }).presence;
      if (inline?.nodeIndex !== undefined) inline.nodeIndex = old.index;
    }
    a.nodes.splice(at, 0, {
      enabled: true,
      hittable: true,
      ...presenceLike(a.nodes[parent ?? 0], at),
      ...node,
      ref: `@e${at}`,
      index: at,
      ...(parent !== undefined ? { parentIndex: parent } : {}),
      depth: parent !== undefined ? (a.nodes[parent].depth ?? 0) + 1 : 1,
    } as NativeNode);
    a.nativePresence?.nodes.splice(at, 0, { status: 'unknown', labelSource: 'none' });
    return at;
  };
}

// One more native node, appended last, under `parent`.
export function addNode(
  parent: number,
  node: Omit<NativeNode, 'index' | 'parentIndex' | 'depth' | 'ref'> & { rect: Rect },
): (args: JoinArgs) => number {
  return (a) => insertNode(a.nodes.length, parent, node)(a);
}

export const edits =
  (...steps: ((args: JoinArgs) => unknown)[]) =>
  (a: JoinArgs): void => {
    for (const step of steps) step(a);
  };
