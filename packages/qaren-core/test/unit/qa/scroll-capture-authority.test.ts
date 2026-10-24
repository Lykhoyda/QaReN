import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

const frame = { x: 0, y: 0, width: 402, height: 874 };
type Snapshot = {
  footer?: boolean;
  footerY?: number;
  footerLabel?: string;
  terms?: boolean;
  termsY?: number;
  termsLabel?: string;
  footerMissing?: boolean;
  footerUnidentified?: boolean;
  loading?: boolean;
  loadingY?: number;
  loadingUnidentified?: boolean;
  keyboardY?: number;
  listID?: string;
  hideFooterLabel?: boolean;
  listFrame?: NonNullable<NativeNode['rect']>;
  tab?: string;
  title?: string;
  toolbarY?: number;
  toolbarHittable?: boolean;
  overlays?: NonNullable<NativeNode['rect']>[];
};

function fixture() {
  let drags = 0;
  let reads = 0;
  const modes: boolean[] = [];
  const endpoints: number[][] = [];
  const judge = scriptedJudge((questions, _index, state) =>
    Object.fromEntries(
      Object.keys(questions).map((id) => [
        id,
        { type: 'noul', noul: JSON.stringify(state).includes('Footer') ? 0.9 : 0.1 },
      ]),
    ),
  );
  const f = walker([], judge);
  let snapshot: (presence: boolean, read: number) => Promise<Snapshot> = async () => ({
    footer: drags > 0,
  });
  const read: typeof f.deps.captureScreen = async (options) => {
    const presence = options?.platformPresence === true;
    modes.push(presence);
    const state = await snapshot(presence, ++reads);
    const source = nativeCapture();
    const rawNodes: NativeNode[] = [
      { type: 'Application', rect: frame },
      { type: 'Window', parentIndex: 0, rect: frame },
      {
        type: 'ScrollView',
        parentIndex: 1,
        identifier: state.listID,
        rect: state.listFrame ?? frame,
      },
      {
        type: state.footerMissing ? 'Other' : 'StaticText',
        parentIndex: 2,
        label:
          state.footerMissing || state.hideFooterLabel
            ? undefined
            : state.footer
              ? (state.footerLabel ?? 'Footer')
              : 'Loading',
        identifier:
          state.footerMissing || state.footerUnidentified
            ? undefined
            : state.footer
              ? 'footer'
              : 'loading',
        rect: state.footerMissing
          ? undefined
          : { x: 10, y: state.footerY ?? 200, width: 100, height: 30 },
      },
      ...(presence
        ? [
            { type: 'Window', parentIndex: 0, rect: frame },
            { type: 'Other', parentIndex: 4, rect: frame },
            { type: 'Button', parentIndex: 5, rect: frame },
          ]
        : []),
      ...(state.toolbarY === undefined
        ? []
        : [
            { type: 'Window', parentIndex: 0, rect: frame },
            {
              type: 'Button',
              parentIndex: presence ? 7 : 4,
              hittable: state.toolbarHittable ?? true,
              rect: { x: 0, y: state.toolbarY, width: 402, height: 70 },
            },
          ]),
      ...(state.overlays ?? []).map((rect) => ({ type: 'Button', parentIndex: 1, rect })),
    ];
    if (state.loading)
      rawNodes.push({
        type: 'StaticText',
        parentIndex: 2,
        identifier: state.loadingUnidentified ? undefined : 'loading-extra',
        label: 'Loading',
        rect: { x: 10, y: state.loadingY ?? 300, width: 100, height: 30 },
      });
    if (state.terms)
      rawNodes.push({
        type: 'StaticText',
        parentIndex: 2,
        identifier: 'terms',
        label: state.termsLabel ?? 'Terms',
        rect: { x: 10, y: state.termsY ?? 350, width: 100, height: 30 },
      });
    if (state.keyboardY !== undefined)
      rawNodes.push({
        type: 'Keyboard',
        parentIndex: 1,
        rect: { x: 0, y: state.keyboardY, width: 402, height: 874 - state.keyboardY },
      });
    if (state.tab)
      rawNodes.push({
        type: 'Button',
        parentIndex: 1,
        selected: true,
        label: state.tab,
        rect: { x: 0, y: 820, width: 100, height: 40 },
      });
    if (state.title)
      rawNodes.push({
        type: 'NavigationBar',
        hittable: false,
        parentIndex: 1,
        identifier: 'main-navigation',
        label: state.title,
        rect: { x: 0, y: 0, width: 402, height: 60 },
      });
    const depth = (index: number): number => {
      const parent = rawNodes[index].parentIndex;
      return parent === undefined ? 0 : depth(parent) + 1;
    };
    const nodes = rawNodes.map((node, index) => ({
      ...node,
      ref: `@e${index}`,
      index,
      depth: depth(index),
      enabled: true,
      hittable: node.hittable ?? true,
      ...(presence ? { presence: { ...source.nodes[1].presence, nodeIndex: index } } : {}),
    }));
    updateRefMapFromFlat(nodes);
    return captureScreen({
      appId: 'com.test',
      platformPresence: presence,
      now: f.deps.now,
      native: async () => ({
        ...attested(nodes),
        snapshotGeneration: source.snapshotGeneration,
        ...(presence ? { presenceCapture: source.presenceCapture } : {}),
      }),
      react: async () => ({
        interactive: [],
        hostEvidence: { complete: true, hosts: [] },
        verdict: { state: 'ok', path: 'interactive', complete: true },
      }),
    });
  };
  f.deps.captureScreen = read;
  f.deps.scroll = async (direction, context, _distance, band) => {
    context!.authorize();
    endpoints.push(
      buildDirectionalScrollCliArgs(direction, 0.6, undefined, undefined, band)
        .slice(1, 5)
        .map(Number),
    );
    drags += 1;
    return { ok: true, proven: true };
  };
  return {
    f,
    modes,
    endpoints,
    drags: () => drags,
    setSnapshot: (next: typeof snapshot) => {
      snapshot = next;
    },
  };
}

async function run(
  f: ReturnType<typeof fixture>,
  direction: 'up' | 'down',
  mode: 'quoted' | 'phrase' | 'replay' | 'text-replay',
  phrase = 'the footer text',
) {
  const block = parsePlan(`1. Scroll ${direction} until ${mode === 'phrase' ? phrase : '"Footer"'}`)
    .blocks![0];
  if (mode === 'replay' || mode === 'text-replay') {
    const step = block.items[0];
    assert.ok(step.kind === 'scroll');
    step.until =
      mode === 'replay'
        ? { quoted: 'footer', phrase: 'footer', exact: 'id' }
        : { quoted: 'Footer', phrase: 'Footer', exact: 'text' };
  }
  return walkBlock(block, f.f.deps, 0, [], undefined, undefined, {
    mode: mode === 'replay' || mode === 'text-replay' ? 'replay' : 'walk',
  });
}

for (const direction of ['up', 'down'] as const) {
  for (const mode of ['quoted', 'phrase', 'replay'] as const) {
    for (const change of ['unrelated', 'label', 'unidentified-label', 'both'] as const) {
      if (mode === 'replay' && change === 'unidentified-label') continue;
      for (const expiry of [false, true]) {
        test(`stable target survives ordinary ${change}: ${direction}, ${mode}, expiry=${expiry}`, async () => {
          const f = fixture();
          let confirmations = 0;
          f.setSnapshot(async (presence) => {
            if (presence && ++confirmations === 1 && expiry) await f.f.deps.sleep(11_000);
            const changed = !presence && confirmations >= (expiry ? 2 : 1);
            return {
              footer: true,
              listID: 'policies',
              footerUnidentified: change === 'unidentified-label',
              hideFooterLabel: changed && change !== 'unrelated',
              loading: (change === 'unrelated' || change === 'both') && !changed,
            };
          });
          try {
            const result = await run(f, direction, mode);
            assert.equal(result.block.outcome, 'pass');
            assert.equal(result.failure, undefined);
            assert.equal(f.drags(), 0);
            assert.deepEqual(
              f.modes,
              expiry ? [false, true, false, true, false] : [false, true, false],
            );
          } finally {
            clearRefMap();
          }
        });
      }
    }

    for (const contradiction of ['outside-list', 'keyboard', 'overlay', 'disappeared'] as const) {
      test(`new ordinary ${contradiction} vetoes positive confirmation: ${direction}, ${mode}`, async () => {
        const f = fixture();
        let confirmed = false;
        f.setSnapshot(async (presence) => {
          if (presence) confirmed = true;
          const changed = confirmed && !presence;
          return {
            footer: true,
            tab: 'Policies',
            title: 'Policies',
            listID: 'policies',
            listFrame: { x: 0, y: 100, width: 402, height: 600 },
            footerY:
              changed && contradiction === 'outside-list' ? (direction === 'down' ? 750 : 50) : 200,
            footerMissing: changed && contradiction === 'disappeared',
            keyboardY: changed && contradiction === 'keyboard' ? 180 : undefined,
            overlays: changed && contradiction === 'overlay' ? [frame] : [],
          };
        });
        try {
          const result = await run(f, direction, mode);
          assert.equal(result.block.outcome, 'fail');
          assert.ok(result.rows.every((row) => row.outcome !== 'pass'));
          if (contradiction !== 'disappeared' || mode !== 'replay') {
            assert.equal(f.drags(), 0);
            assert.match(JSON.stringify(result.failure), /VISIBILITY_UNSURE/);
          }
        } finally {
          clearRefMap();
        }
      });
    }

    test(`expiry recovery still vetoes stale positive confirmation: ${direction}, ${mode}`, async () => {
      const f = fixture();
      let confirmations = 0;
      f.setSnapshot(async (presence) => {
        if (presence && ++confirmations === 1) await f.f.deps.sleep(11_000);
        return {
          footer: true,
          listID: 'policies',
          listFrame: { x: 0, y: 100, width: 402, height: 600 },
          footerY: !presence && confirmations > 1 ? (direction === 'down' ? 750 : 50) : 200,
        };
      });
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.block.outcome, 'fail');
        assert.equal(f.drags(), 0);
        assert.match(JSON.stringify(result.failure), /VISIBILITY_UNSURE/);
        assert.deepEqual(f.modes, [false, true, false, true, false]);
      } finally {
        clearRefMap();
      }
    });

    test(`presence wrappers cannot collapse ordinary geometry: ${direction}, ${mode}`, async () => {
      const f = fixture();
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.failure, undefined);
        assert.equal(result.block.outcome, 'pass');
        assert.equal(f.drags(), 1);
        assert.deepEqual(f.endpoints, [
          direction === 'down' ? [201, 758, 201, 102] : [201, 102, 201, 758],
        ]);
        assert.deepEqual(
          f.modes,
          mode === 'phrase'
            ? [false, true, false, false, true, false]
            : mode === 'replay'
              ? [false, false, false, true, false]
              : [false, false, true, false],
        );
      } finally {
        clearRefMap();
      }
    });

    test(`capture coherence uses only the ordinary toolbar frame: ${direction}, ${mode}`, async () => {
      const f = fixture();
      f.setSnapshot(async (presence) => ({
        footer: f.drags() > 0,
        toolbarY: presence ? 900 : 730,
      }));
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.failure, undefined);
        assert.equal(result.block.outcome, 'pass');
        assert.equal(f.drags(), 1);
        const [, start, , end] = f.endpoints[0];
        assert.ok(start < 726 && end < 726, JSON.stringify(f.endpoints));
        assert.ok(start > 0 && end > 0);
        assert.deepEqual(
          f.modes,
          mode === 'phrase'
            ? [false, true, false, false, true, false]
            : mode === 'replay'
              ? [false, false, false, true, false]
              : [false, false, true, false],
        );
      } finally {
        clearRefMap();
      }
    });

    test(`a genuine full-screen ordinary overlay still refuses: ${direction}, ${mode}`, async () => {
      const f = fixture();
      f.setSnapshot(async () => ({ overlays: [frame, frame] }));
      try {
        await assert.rejects(run(f, direction, mode), /SCROLL_BAND_TOO_SMALL/);
        assert.equal(f.drags(), 0);
        assert.deepEqual(f.endpoints, []);
      } finally {
        clearRefMap();
      }
    });

    test(`negative presence cannot replace ordinary geometry: ${direction}, ${mode}`, async () => {
      const f = fixture();
      f.setSnapshot(async (presence) => ({ footer: !presence, toolbarY: presence ? 900 : 730 }));
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.block.outcome, 'fail');
        assert.equal(f.drags(), 6);
        for (const [, start, , end] of f.endpoints)
          assert.ok(start < 726 && end < 726, JSON.stringify(f.endpoints));
        assert.ok(result.rows.every((row) => row.outcome !== 'pass'));
        assert.deepEqual(
          f.modes,
          Array.from({ length: 7 }, () =>
            mode === 'replay' ? [false, true, false, false] : [false, true, false],
          ).flat(),
        );
      } finally {
        clearRefMap();
      }
    });

    test(`stable navigation identifier cannot mask confirmation title changes: ${direction}, ${mode}`, async () => {
      const f = fixture();
      let navigated = false;
      f.setSnapshot(async (presence) => {
        if (presence) navigated = true;
        return { footer: true, tab: 'Policies', title: navigated ? 'Claims' : 'Policies' };
      });
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.refusal?.code, 'SCROLL_NAVIGATED');
        assert.equal(result.block.outcome, 'fail');
        assert.equal(f.drags(), 0);
        assert.ok(f.f.rows.every((row) => row.outcome !== 'pass'));
      } finally {
        clearRefMap();
      }
    });

    for (const refresh of [false, true]) {
      test(`confirmation navigation precedes target acceptance: ${direction}, ${mode}, refresh=${refresh}`, async () => {
        const f = fixture();
        let navigated = false;
        f.setSnapshot(async (presence) => {
          if (presence && f.drags() > 0) {
            navigated = true;
            if (refresh) await f.f.deps.sleep(11_000);
          }
          return { footer: f.drags() > 0, tab: navigated ? 'Claims' : 'Policies' };
        });
        try {
          const result = await run(f, direction, mode);
          assert.equal(result.refusal?.code, 'SCROLL_NAVIGATED');
          assert.equal(result.block.outcome, 'fail');
          assert.equal(f.drags(), 1);
          assert.ok(f.f.rows.every((row) => row.outcome !== 'pass'));
        } finally {
          clearRefMap();
        }
      });

      test(`negative confirmation refreshes new toolbar clearance: ${direction}, ${mode}, refresh=${refresh}`, async () => {
        const f = fixture();
        let appeared = false;
        f.setSnapshot(async (presence) => {
          if (presence) {
            appeared = true;
            if (refresh) await f.f.deps.sleep(1_000);
          }
          return { footer: !presence, toolbarY: appeared ? 730 : undefined };
        });
        try {
          const result = await run(f, direction, mode);
          assert.equal(result.block.outcome, 'fail');
          assert.equal(f.drags(), 6);
          for (const [, start, , end] of f.endpoints)
            assert.ok(start < 726 && end < 726, JSON.stringify(f.endpoints));
        } finally {
          clearRefMap();
        }
      });
    }

    test(`confirmation reveals a new full-screen blocker: ${direction}, ${mode}`, async () => {
      const f = fixture();
      let appeared = false;
      f.setSnapshot(async (presence) => {
        if (presence) appeared = true;
        return { footer: !presence, overlays: appeared ? [frame] : [] };
      });
      try {
        await assert.rejects(run(f, direction, mode), /SCROLL_BAND_TOO_SMALL/);
        assert.equal(f.drags(), 0);
      } finally {
        clearRefMap();
      }
    });

    test(`presence confirmation cannot renew expired ordinary geometry: ${direction}, ${mode}`, async () => {
      const f = fixture();
      const completed: number[] = [];
      f.setSnapshot(async (presence, read) => {
        if (read === 1) await f.f.deps.sleep(2_000);
        if (read === 2) await f.f.deps.sleep(11_000);
        completed.push(f.f.deps.now());
        return { footer: !presence || read > 2 };
      });
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.failure, undefined);
        assert.equal(result.block.outcome, 'pass');
        assert.equal(f.drags(), 0);
        assert.deepEqual(completed.slice(0, 2), [2_000, 13_000]);
        assert.deepEqual(f.modes, [false, true, false, true, false]);
      } finally {
        clearRefMap();
      }
    });
  }
}

test('quoted confirmation is requested only after an ordinary match', async () => {
  const f = fixture();
  f.setSnapshot(async (presence) => {
    if (presence)
      assert.equal(f.drags(), 1, 'no presence read may precede the ordinary target candidate');
    return { footer: f.drags() > 0, toolbarY: presence ? 730 : undefined };
  });
  try {
    const result = await run(f, 'down', 'quoted');
    assert.equal(result.block.outcome, 'pass');
    assert.equal(f.drags(), 1);
    assert.deepEqual(f.modes, [false, false, true, false]);
  } finally {
    clearRefMap();
  }
});

test('plain scroll keeps the centered window gesture and ordinary captures', async () => {
  const f = fixture();
  try {
    const result = await walkBlock(parsePlan('1. Scroll down').blocks![0], f.f.deps);
    assert.equal(result.block.outcome, 'pass');
    assert.equal(f.drags(), 1);
    assert.deepEqual(f.endpoints, [[201, 542, 201, 332]]);
    assert.ok(f.modes.every((presence) => !presence));
  } finally {
    clearRefMap();
  }
});

for (const direction of ['up', 'down'] as const) {
  test(`uncertainty re-ask still vetoes stale positive confirmation: ${direction}`, async () => {
    const f = fixture();
    let confirmations = 0;
    const judge = scriptedJudge((questions, index, state) =>
      Object.fromEntries(
        Object.keys(questions).map((id) => [
          id,
          {
            type: 'noul',
            noul: index === 0 ? 0.5 : JSON.stringify(state).includes('Footer') ? 0.9 : 0.1,
          },
        ]),
      ),
    );
    f.f.deps.judge = judge;
    f.setSnapshot(async (presence) => {
      if (presence) confirmations += 1;
      return {
        footer: true,
        listID: 'policies',
        listFrame: { x: 0, y: 100, width: 402, height: 600 },
        footerY: !presence && confirmations > 1 ? (direction === 'down' ? 750 : 50) : 200,
      };
    });
    try {
      const result = await run(f, direction, 'phrase');
      assert.equal(result.block.outcome, 'fail');
      assert.equal(f.drags(), 0);
      assert.equal(judge.requests.length, 3);
      assert.match(JSON.stringify(result.failure), /VISIBILITY_UNSURE/);
      assert.deepEqual(f.modes, [false, true, false, false, true, false]);
    } finally {
      clearRefMap();
    }
  });
}

for (const direction of ['up', 'down'] as const) {
  for (const mode of ['phrase', 'replay'] as const) {
    test(`unknown ordinary labels do not replace qualified presence: ${direction}, ${mode}`, async () => {
      const f = fixture();
      f.setSnapshot(async (presence) => ({ footer: true, hideFooterLabel: !presence }));
      try {
        const result = await run(f, direction, mode);
        assert.equal(result.block.outcome, 'pass');
        assert.equal(f.drags(), 0);
        assert.deepEqual(f.modes, [false, true, false]);
      } finally {
        clearRefMap();
      }
    });
  }
}

for (const direction of ['up', 'down'] as const) {
  for (const change of ['unrelated', 'unidentified-label'] as const) {
    test(`uncertainty re-ask keeps a stable target through ordinary ${change}: ${direction}`, async () => {
      const f = fixture();
      let confirmations = 0;
      const judge = scriptedJudge((questions, index) =>
        Object.fromEntries(
          Object.keys(questions).map((id) => [id, { type: 'noul', noul: index === 0 ? 0.5 : 0.9 }]),
        ),
      );
      f.f.deps.judge = judge;
      f.setSnapshot(async (presence) => {
        if (presence) confirmations += 1;
        const changed = !presence && confirmations >= 2;
        return {
          footer: true,
          listID: 'policies',
          footerUnidentified: change === 'unidentified-label',
          hideFooterLabel: changed && change === 'unidentified-label',
          loading: change === 'unrelated' && !changed,
        };
      });
      try {
        const result = await run(f, direction, 'phrase');
        assert.equal(result.block.outcome, 'pass');
        assert.equal(result.failure, undefined);
        assert.equal(f.drags(), 0);
        assert.equal(judge.requests.length, change === 'unrelated' ? 3 : 2);
        assert.deepEqual(f.modes, [false, true, false, false, true, false]);
      } finally {
        clearRefMap();
      }
    });
  }
}

for (const direction of ['up', 'down'] as const) {
  for (const mode of ['quoted', 'phrase', 'replay'] as const) {
    for (const expiry of [false, true]) {
      test(`identified offscreen target wins over its old frame occupant: ${direction}, ${mode}, expiry=${expiry}`, async () => {
        const f = fixture();
        let confirmations = 0;
        f.setSnapshot(async (presence) => {
          if (presence && ++confirmations === 1 && expiry) await f.f.deps.sleep(11_000);
          const changed = !presence && confirmations >= (expiry ? 2 : 1);
          return {
            footer: true,
            listID: 'policies',
            listFrame: { x: 0, y: 100, width: 402, height: 600 },
            footerY: changed ? (direction === 'down' ? 750 : 50) : 200,
            loading: changed,
            loadingY: 200,
            loadingUnidentified: true,
          };
        });
        try {
          const result = await run(f, direction, mode);
          assert.equal(result.block.outcome, 'fail');
          assert.match(JSON.stringify(result.failure), /VISIBILITY_UNSURE/);
          assert.equal(f.drags(), 0);
          assert.deepEqual(
            f.modes,
            expiry ? [false, true, false, true, false] : [false, true, false],
          );
        } finally {
          clearRefMap();
        }
      });
    }
  }
  for (const predicate of ['welcome', 'footer-and-terms', 'terms-and-footer'] as const) {
    for (const transition of ['initial', 'expiry', 'reask'] as const) {
      test(`semantic target contradiction: ${direction}, ${predicate}, ${transition}`, async () => {
        const f = fixture();
        let confirmations = 0;
        const judge = scriptedJudge((questions, index, state) => {
          const evidence = JSON.stringify(state);
          const present =
            predicate === 'welcome'
              ? evidence.includes('Welcome')
              : evidence.includes('Footer') && evidence.includes('Terms');
          return Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              {
                type: 'noul',
                noul: transition === 'reask' && index === 0 ? 0.5 : present ? 0.9 : 0.1,
              },
            ]),
          );
        });
        f.f.deps.judge = judge;
        f.setSnapshot(async (presence) => {
          if (presence && ++confirmations === 1 && transition === 'expiry')
            await f.f.deps.sleep(11_000);
          const changed = !presence && confirmations >= (transition === 'initial' ? 1 : 2);
          const outside = direction === 'down' ? 750 : 50;
          return {
            footer: true,
            footerLabel: predicate === 'welcome' ? 'Welcome' : 'Footer',
            footerY: changed && predicate !== 'terms-and-footer' ? outside : 200,
            terms: predicate !== 'welcome',
            termsY: changed && predicate === 'terms-and-footer' ? outside : 350,
            listID: 'policies',
            listFrame: { x: 0, y: 100, width: 402, height: 600 },
            loading: true,
            loadingY: 200,
            loadingUnidentified: true,
          };
        });
        try {
          const result = await run(
            f,
            direction,
            'phrase',
            predicate === 'welcome' ? 'the welcome message' : 'the footer and terms text',
          );
          assert.equal(result.block.outcome, 'fail');
          assert.match(JSON.stringify(result.failure), /VISIBILITY_UNSURE/);
          assert.equal(f.drags(), 0);
          assert.equal(judge.requests.length, transition === 'reask' ? 3 : 2);
          assert.deepEqual(
            f.modes,
            transition === 'reask'
              ? [false, true, false, false, true, false]
              : transition === 'expiry'
                ? [false, true, false, true, false]
                : [false, true, false],
          );
        } finally {
          clearRefMap();
        }
      });
    }
  }
}

for (const direction of ['up', 'down'] as const) {
  for (const predicate of ['welcome', 'footer-and-terms'] as const) {
    for (const change of ['unrelated', 'unknown-label'] as const) {
      test(`semantic confirmation preserves current target: ${direction}, ${predicate}, ${change}`, async () => {
        const f = fixture();
        let confirmed = false;
        f.f.deps.judge = scriptedJudge((questions, _index, state) => {
          const evidence = JSON.stringify(state);
          const present =
            predicate === 'welcome'
              ? evidence.includes('Welcome')
              : evidence.includes('Footer') && evidence.includes('Terms');
          return Object.fromEntries(
            Object.keys(questions).map((id) => [id, { type: 'noul', noul: present ? 0.9 : 0.1 }]),
          );
        });
        f.setSnapshot(async (presence) => {
          if (presence) confirmed = true;
          const changed = !presence && confirmed;
          return {
            footer: true,
            footerLabel: predicate === 'welcome' ? 'Welcome' : 'Footer',
            terms: predicate !== 'welcome',
            hideFooterLabel: changed && change === 'unknown-label',
            loading: change === 'unrelated' && !changed,
            listID: 'policies',
          };
        });
        try {
          const result = await run(
            f,
            direction,
            'phrase',
            predicate === 'welcome' ? 'the welcome message' : 'the footer and terms text',
          );
          assert.equal(result.block.outcome, 'pass');
          assert.equal(result.failure, undefined);
          assert.equal(f.drags(), 0);
          assert.deepEqual(f.modes, [false, true, false]);
        } finally {
          clearRefMap();
        }
      });
    }
  }
}

for (const direction of ['up', 'down'] as const) {
  for (const unidentified of [false, true]) {
    for (const change of ['offscreen', 'replacement'] as const) {
      if (!unidentified && change === 'offscreen') continue;
      for (const mode of ['quoted', 'text-replay', 'phrase', 'replay'] as const) {
        if (unidentified && mode === 'replay') continue;
        for (const transition of ['initial', 'expiry', 'reask'] as const) {
          if (transition === 'reask' && mode !== 'phrase') continue;
          test(`confirmation reconciles target ${change}: ${direction}, unidentified=${unidentified}, ${mode}, ${transition}`, async () => {
            const f = fixture();
            let confirmations = 0;
            f.f.deps.judge = scriptedJudge((questions, index, state) =>
              Object.fromEntries(
                Object.keys(questions).map((id) => [
                  id,
                  {
                    type: 'noul',
                    noul:
                      transition === 'reask' && index === 0
                        ? 0.5
                        : JSON.stringify(state).includes('Footer')
                          ? 0.9
                          : 0.1,
                  },
                ]),
              ),
            );
            f.setSnapshot(async (presence) => {
              if (presence && ++confirmations === 1 && transition === 'expiry')
                await f.f.deps.sleep(11_000);
              const changed = !presence && confirmations >= (transition === 'initial' ? 1 : 2);
              return {
                footer: true,
                footerUnidentified: unidentified,
                footerLabel: changed && change === 'replacement' ? 'Loading' : 'Footer',
                footerY:
                  changed && change === 'offscreen' ? (direction === 'down' ? 750 : 50) : 200,
                loading: changed && change === 'offscreen',
                loadingY: 200,
                loadingUnidentified: true,
                listID: 'policies',
                listFrame: { x: 0, y: 100, width: 402, height: 600 },
                tab: 'Policies',
                title: 'Policies',
              };
            });
            try {
              const result = await run(f, direction, mode);
              if (mode === 'replay') {
                assert.equal(result.block.outcome, 'pass');
                assert.equal(result.failure, undefined);
              } else {
                assert.equal(result.block.outcome, 'fail');
                assert.match(JSON.stringify(result.failure), /VISIBILITY_UNSURE/);
              }
              assert.equal(f.drags(), 0);
              assert.deepEqual(
                f.modes,
                transition === 'reask'
                  ? [false, true, false, false, true, false]
                  : transition === 'expiry'
                    ? [false, true, false, true, false]
                    : [false, true, false],
              );
            } finally {
              clearRefMap();
            }
          });
        }
      }
    }
  }
  for (const predicate of ['welcome', 'footer-and-terms', 'terms-and-footer'] as const) {
    for (const transition of ['initial', 'expiry', 'reask'] as const) {
      test(`whole semantic claim reconciles replacement content: ${direction}, ${predicate}, ${transition}`, async () => {
        const f = fixture();
        let confirmations = 0;
        f.f.deps.judge = scriptedJudge((questions, index, state) => {
          const evidence = JSON.stringify(state);
          const present =
            predicate === 'welcome'
              ? evidence.includes('Welcome')
              : evidence.includes('Footer') && evidence.includes('Terms');
          return Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              {
                type: 'noul',
                noul: transition === 'reask' && index === 0 ? 0.5 : present ? 0.9 : 0.1,
              },
            ]),
          );
        });
        f.setSnapshot(async (presence) => {
          if (presence && ++confirmations === 1 && transition === 'expiry')
            await f.f.deps.sleep(11_000);
          const changed = !presence && confirmations >= (transition === 'initial' ? 1 : 2);
          return {
            footer: true,
            footerLabel:
              changed && predicate !== 'terms-and-footer'
                ? 'Loading'
                : predicate === 'welcome'
                  ? 'Welcome'
                  : 'Footer',
            terms: predicate !== 'welcome',
            termsLabel: changed && predicate === 'terms-and-footer' ? 'Loading' : 'Terms',
            listID: 'policies',
            tab: 'Policies',
            title: 'Policies',
          };
        });
        try {
          const result = await run(
            f,
            direction,
            'phrase',
            predicate === 'welcome' ? 'the welcome message' : 'the footer and terms text',
          );
          assert.equal(result.block.outcome, 'fail');
          assert.match(JSON.stringify(result.failure), /VISIBILITY_UNSURE/);
          assert.equal(f.drags(), 0);
          assert.deepEqual(
            f.modes,
            transition === 'reask'
              ? [false, true, false, false, true, false]
              : transition === 'expiry'
                ? [false, true, false, true, false]
                : [false, true, false],
          );
        } finally {
          clearRefMap();
        }
      });
    }
  }
}

for (const direction of ['up', 'down'] as const) {
  for (const unidentified of [false, true]) {
    test(`unknown labels preserve text replay selector refusal: ${direction}, unidentified=${unidentified}`, async () => {
      const f = fixture();
      let confirmed = false;
      f.setSnapshot(async (presence) => {
        if (presence) confirmed = true;
        return {
          footer: true,
          footerUnidentified: unidentified,
          hideFooterLabel: !presence && confirmed,
          listID: 'policies',
        };
      });
      try {
        const result = await run(f, direction, 'text-replay');
        assert.equal(result.block.outcome, 'fail');
        assert.match(JSON.stringify(result.failure), /REPLAY_SELECTOR/);
        assert.doesNotMatch(JSON.stringify(result.failure), /VISIBILITY_UNSURE/);
        assert.equal(f.drags(), 0);
        assert.deepEqual(f.modes, [false, true, false]);
      } finally {
        clearRefMap();
      }
    });
  }
}

for (const direction of ['up', 'down'] as const) {
  for (const unidentified of [false, true]) {
    for (const predicate of ['welcome', 'footer-and-terms', 'terms-and-footer'] as const) {
      for (const transition of ['initial', 'expiry', 'reask'] as const) {
        test(`whole semantic claim accepts compatible content: ${direction}, unidentified=${unidentified}, ${predicate}, ${transition}`, async () => {
          const f = fixture();
          let confirmations = 0;
          const updatedLabel =
            predicate === 'welcome'
              ? 'Welcome back'
              : predicate === 'footer-and-terms'
                ? 'Footer details'
                : 'Terms of service';
          const judge = scriptedJudge((questions, index, state) => {
            const evidence = JSON.stringify(state);
            const present =
              predicate === 'welcome'
                ? evidence.includes('Welcome')
                : evidence.includes('Footer') && evidence.includes('Terms');
            return Object.fromEntries(
              Object.keys(questions).map((id) => [
                id,
                {
                  type: 'noul',
                  noul: transition === 'reask' && index === 0 ? 0.5 : present ? 0.9 : 0.1,
                },
              ]),
            );
          });
          f.f.deps.judge = judge;
          f.setSnapshot(async (presence) => {
            if (presence && ++confirmations === 1 && transition === 'expiry')
              await f.f.deps.sleep(11_000);
            const changed = !presence && confirmations >= (transition === 'initial' ? 1 : 2);
            return {
              footer: true,
              footerUnidentified: unidentified,
              footerLabel:
                changed && predicate !== 'terms-and-footer'
                  ? updatedLabel
                  : predicate === 'welcome'
                    ? 'Welcome'
                    : 'Footer',
              terms: predicate !== 'welcome',
              termsLabel: changed && predicate === 'terms-and-footer' ? updatedLabel : 'Terms',
              listID: 'policies',
              tab: 'Policies',
              title: 'Policies',
            };
          });
          try {
            const result = await run(
              f,
              direction,
              'phrase',
              predicate === 'welcome' ? 'the welcome message' : 'the footer and terms text',
            );
            assert.equal(result.block.outcome, 'pass', JSON.stringify(result.failure));
            assert.equal(result.failure, undefined);
            assert.equal(f.drags(), 0);
            assert.equal(judge.requests.length, transition === 'reask' ? 3 : 2);
            assert.ok(JSON.stringify(judge.requests.at(-1)?.state).includes(updatedLabel));
            assert.deepEqual(
              f.modes,
              transition === 'reask'
                ? [false, true, false, false, true, false]
                : transition === 'expiry'
                  ? [false, true, false, true, false]
                  : [false, true, false],
            );
          } finally {
            clearRefMap();
          }
        });
      }
    }
  }
}

test('updated assertion labels retain model masking and original native evidence', async () => {
  const f = fixture();
  f.setSnapshot(async () => ({ footer: true, footerLabel: 'Welcome' }));
  try {
    const observed = await f.f.deps.captureScreen({ platformPresence: true });
    const witness = observed.elements.find((element) => element.testID === 'footer');
    assert.ok(witness?.semantic?.nativePresence);
    const privateValue = 'private-marker-719';
    const privacy = new ObservedPrivacy([privateValue]);
    privacy.didFill(privateValue);
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.9 }])),
    );
    const item = parsePlan('1. Scroll down until the welcome message').blocks![0].items[0];
    assert.ok(item.kind === 'scroll');
    const decision = await decideScreen(
      observed,
      judge,
      undefined,
      item,
      privacy.modelValues(),
      privacy,
      Infinity,
      false,
      new Map([[witness, `Welcome ${privateValue}`]]),
    );
    assert.deepEqual(decision.visibility, { verdict: 'present' });
    const delivered = JSON.stringify(judge.requests[0].state);
    assert.ok(delivered.includes('Welcome [QAREN_VALUE_'));
    assert.ok(!delivered.includes(privateValue));
    assert.equal(witness.label, 'Welcome');
    assert.equal(witness.semantic.nativePresence.labelSource, 'direct');
  } finally {
    clearRefMap();
  }
});
