import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';
import { join, screenSignature, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { EVIDENCE_USE_MS, PHRASE_WAIT_BUDGET_MS } from '../../../dist/qa/timing.js';
import { buildDirectionalScrollCliArgs } from '../../../dist/handlers/device-interact.js';
import { clearRefMap, updateRefMapFromFlat } from '../../../dist/fast-runner-ref-map.js';
import { runPlan, WAIT_POLL_MS } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

for (const direction of ['up', 'down']) {
  for (const refresh of [false, true]) {
    test(`quoted scroll-until ${direction} captures navigation titles with refresh=${refresh}`, async () => {
      const f = walker(
        [],
        scriptedJudge(() => assert.fail('quoted visibility is model-free')),
      );
      const modes: boolean[] = [];
      let drags = 0;
      f.deps.captureScreen = async (options) => {
        modes.push(options?.platformPresence === true);
        const destination = modes.length === (refresh ? 3 : 2);
        const title = destination ? 'Claims' : 'Policies';
        const source = nativeCapture();
        const nodes: NativeNode[] = [
          { type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
          { type: 'Window', parentIndex: 0, rect: { x: 0, y: 0, width: 400, height: 800 } },
          { type: 'ScrollView', parentIndex: 1, rect: { x: 0, y: 100, width: 400, height: 600 } },
          {
            type: 'StaticText',
            parentIndex: 2,
            label: destination ? 'Footer' : 'Loading',
            rect: { x: 10, y: 200, width: 100, height: 30 },
          },
          {
            type: 'NavigationBar',
            parentIndex: 1,
            identifier: title,
            rect: { x: 0, y: 0, width: 400, height: 80 },
          },
          {
            type: 'StaticText',
            parentIndex: 4,
            label: title,
            rect: { x: 10, y: 20, width: 100, height: 30 },
          },
          {
            type: 'Button',
            parentIndex: 1,
            selected: true,
            label: 'Policies tab',
            rect: { x: 10, y: 740, width: 100, height: 40 },
          },
        ].map((node, index) => ({
          ...node,
          ref: `@e${index}`,
          index,
          depth: [0, 1, 2, 3, 2, 3, 2][index],
          enabled: true,
          hittable: true,
          ...(options?.platformPresence
            ? { presence: { ...source.nodes[1].presence, nodeIndex: index } }
            : {}),
        }));
        const captured = await captureScreen({
          appId: 'com.test',
          platformPresence: options?.platformPresence,
          now: f.deps.now,
          native: async () => ({
            ...attested(nodes),
            snapshotGeneration: source.snapshotGeneration,
            ...(options?.platformPresence ? { presenceCapture: source.presenceCapture } : {}),
          }),
          react: async () => ({ interactive: [], verdict: { state: 'ok', complete: true } }),
        });
        return captured;
      };
      const scroll = f.deps.scroll;
      f.deps.scroll = async (dir, context) => {
        if (refresh && drags === 1) {
          await f.deps.sleep(EVIDENCE_USE_MS);
          context!.check();
          assert.fail('expired evidence must refresh before another drag');
        }
        context!.authorize();
        drags += 1;
        return scroll(dir, context);
      };
      const result = await runPlan(
        parsePlan(`1. Scroll ${direction} until "Footer"`).blocks!,
        f.deps,
      );
      assert.equal(result.verdict, 'REFUSED', result.failure?.seen);
      assert.equal(result.code, 'SCROLL_NAVIGATED');
      assert.match(result.failure?.seen ?? '', /navigation title changed/);
      assert.equal(drags, 1);
      assert.deepEqual(f.actions, [`scroll ${direction}`]);
      assert.deepEqual(modes, Array(refresh ? 3 : 2).fill(true));
      assert.ok(result.steps.every((step) => step.outcome !== 'pass'));
    });
  }
}

const shown = (label: string): Screen => screen([element('@text', label, { kind: 'text' })]);

function fixture(initial: Screen) {
  const judge = scriptedJudge((questions, _index, state) =>
    Object.fromEntries(
      Object.keys(questions).map((id) => [
        id,
        { type: 'noul', noul: JSON.stringify(state).includes('Welcome') ? 0.9 : 0.1 },
      ]),
    ),
  );
  const f = walker([initial], judge);
  const modes: boolean[] = [];
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    modes.push(options?.platformPresence === true);
    return capture(options);
  };
  return { f, judge, modes };
}

function assertNextPoll(now: number, changedAt: number): void {
  assert.ok(now >= changedAt && now <= changedAt + WAIT_POLL_MS);
}

test('a transient title qualification is observed on the next heading poll', async () => {
  const body = shown('Welcome');
  const title = structuredClone(body);
  title.elements[0].semantic!.nativePresence = {
    kind: 'text',
    labelSource: 'direct',
    structural: false,
  };
  title.elements[0].semantic!.heading = {
    kind: 'typographic-title',
    hostIndex: 0,
    anchorRef: '@text',
    bodyRefs: [],
  };
  assert.equal(screenSignature(body), screenSignature(title));
  const { f, judge, modes } = fixture(body);
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    await capture(options);
    return f.deps.now() >= 1_000 && f.deps.now() < 8_000 ? title : body;
  };
  const result = await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assertNextPoll(f.deps.now(), 1_000);
  assert.deepEqual(modes, [true, true, true]);
  assert.equal(judge.calls.length, 1);
});

test('geometry-only scroll clipping changes are observed on the next phrase poll', async () => {
  const geometry = (y: number) => {
    const nodes: NativeNode[] = [
      { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
      {
        ref: '@window',
        type: 'Window',
        parentIndex: 0,
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        ref: '@scroll',
        type: 'ScrollView',
        parentIndex: 1,
        rect: { x: 0, y: 100, width: 400, height: 100 },
      },
      {
        ref: '@text',
        type: 'StaticText',
        parentIndex: 2,
        label: 'Welcome',
        hittable: true,
        rect: { x: 10, y, width: 100, height: 20 },
      },
      {
        ref: '@loading',
        type: 'StaticText',
        parentIndex: 1,
        label: 'Loading',
        hittable: true,
        rect: { x: 10, y: 400, width: 100, height: 20 },
      },
    ];
    const presence: NativePresence = {
      source: 'xcui-live',
      nodes: nodes.map((_, index) => ({
        status: index === 4 || (index === 3 && y === 150) ? 'observed' : 'unknown',
        labelSource: 'direct',
      })),
    };
    const coverage = { native: 'complete', react: 'complete' } as const;
    return {
      plain: join(nodes, [], 'app', coverage),
      observed: join(nodes, [], 'app', coverage, undefined, presence),
    };
  };
  const clipped = geometry(210);
  const visible = geometry(150);
  assert.notEqual(screenSignature(clipped.plain), screenSignature(visible.plain));
  assert.equal(clipped.observed.elements[3].semantic?.visibility, 'offscreen');
  assert.equal(visible.observed.elements[3].semantic?.visibility, 'visible');
  const { f, judge, modes } = fixture(clipped.observed);
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    await capture(options);
    const current = f.deps.now() >= 1_000 && f.deps.now() < 8_000 ? visible : clipped;
    return options?.platformPresence ? current.observed : current.plain;
  };
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assertNextPoll(f.deps.now(), 1_000);
  assert.deepEqual(modes, [true, true, true]);
  assert.equal(judge.calls.length, 3);
});

test('Welcome returning after a Loading capture is observed at the next poll', async () => {
  const { f, judge, modes } = fixture(shown('Welcome'));
  let presenceCaptures = 0;
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (options) => {
    await capture(options);
    if (!options?.platformPresence) return shown('Welcome');
    presenceCaptures++;
    return presenceCaptures === 1 || f.deps.now() >= 8_000 ? shown('Loading') : shown('Welcome');
  };
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assertNextPoll(f.deps.now(), WAIT_POLL_MS);
  assert.deepEqual(modes, [true, true]);
  assert.equal(judge.calls.length, 2);
  assert.ok(JSON.stringify(judge.requests[0].state).includes('Loading'));
  assert.ok(JSON.stringify(judge.requests[1].state).includes('Welcome'));
});

test('an unchanged screen receives one presence capture and judgment per poll', async () => {
  const { f, judge, modes } = fixture(shown('Loading'));
  const result = await runPlan(parsePlan('1. Wait for the welcome text').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /ITEM_DEADLINE_EXCEEDED/);
  assert.equal(f.deps.now(), PHRASE_WAIT_BUDGET_MS);
  assert.equal(f.captures(), PHRASE_WAIT_BUDGET_MS / WAIT_POLL_MS);
  assert.equal(judge.calls.length, f.captures());
  assert.deepEqual(modes, Array(f.captures()).fill(true));
});

for (const direction of ['up', 'down'] as const) {
  for (const navigation of [
    'none',
    'after-drag',
    'during-geometry',
    'after-drag-refresh',
  ] as const) {
    test(`scroll-until uses ordinary geometry and guards presence titles: ${direction}, ${navigation}`, async () => {
      const f = walker([], scriptedJudge(() => assert.fail('quoted visibility is model-free')));
      let drags = 0;
      let destination = false;
      const modes: boolean[] = [];
      const frame = { x: 0, y: 0, width: 402, height: 874 };
      const read: typeof f.deps.captureScreen = async (options) => {
        const presence = options?.platformPresence === true;
        modes.push(presence);
        if (!presence && navigation === 'during-geometry') destination = true;
        const title = destination ? 'Claims' : 'Policies';
        const source = nativeCapture();
        const nodes: NativeNode[] = [
          { type: 'Application', rect: frame },
          { type: 'Window', parentIndex: 0, rect: frame },
          { type: 'ScrollView', parentIndex: 1, rect: frame },
          { type: 'StaticText', parentIndex: 2, label: drags && (navigation !== 'after-drag-refresh' || destination)
              ? 'Footer'
              : 'Loading',
            rect: { x: 10, y: 200, width: 100, height: 30 } },
          { type: 'NavigationBar', parentIndex: 1, identifier: title,
            rect: { x: 0, y: 20, width: 402, height: 60 } },
          { type: 'StaticText', parentIndex: 4, label: title,
            rect: { x: 10, y: 30, width: 100, height: 30 } },
          { type: 'Button', parentIndex: 1, selected: true, label: 'Policies tab',
            rect: { x: 20, y: 780, width: 180, height: 60 } },
          ...(presence ? [
            { type: 'Window', parentIndex: 0, rect: frame },
            { type: 'Other', parentIndex: 7, rect: frame },
            { type: 'Button', parentIndex: 8, rect: frame },
          ] : []),
        ].map((node, index) => ({
          ...node, ref: `@e${index}`, index,
          depth: [0, 1, 2, 3, 2, 3, 2, 1, 2, 3][index],
          enabled: true, hittable: true,
          ...(presence ? { presence: { ...source.nodes[1].presence, nodeIndex: index } } : {}),
        }));
        updateRefMapFromFlat(nodes);
        return captureScreen({
          appId: 'com.test', platformPresence: presence, now: f.deps.now,
          native: async () => ({ ...attested(nodes), snapshotGeneration: source.snapshotGeneration,
            ...(presence ? { presenceCapture: source.presenceCapture } : {}) }),
          react: async () => ({ interactive: [], verdict: { state: 'ok', complete: true } }),
        });
      };
      f.deps.captureScreen = read;
      f.deps.captureOrdinaryScreen = (options) => read({ ...options, platformPresence: false });
      f.deps.scroll = async (dir, context, _distance, band) => {
        if (navigation === 'after-drag-refresh' && drags === 1) {
          destination = true;
          await f.deps.sleep(EVIDENCE_USE_MS);
          context!.check();
          assert.fail('expired evidence must refresh');
        }
        context!.authorize();
        assert.ok(band && band.height > 0);
        const [, , y1, , y2] = buildDirectionalScrollCliArgs(dir, 0.6, undefined, undefined, band).map(Number);
        assert.ok(y1 > 80 && y1 < 776 && y2 > 80 && y2 < 776);
        drags += 1;
        if (navigation === 'after-drag') destination = true;
        return { ok: true, proven: true };
      };
      try {
        const result = await runPlan(parsePlan(`1. Scroll ${direction} until "Footer"`).blocks!, f.deps);
        assert.equal(result.verdict, navigation === 'none' ? 'PASS' : 'REFUSED', result.failure?.seen);
        assert.equal(drags, navigation === 'during-geometry' ? 0 : 1);
        if (navigation !== 'none') {
          assert.equal(result.code, 'SCROLL_NAVIGATED');
          assert.match(result.failure?.seen ?? '', /navigation title changed/);
        }
        const batches = navigation === 'during-geometry'
          ? 1
          : navigation === 'after-drag-refresh' ? 3 : 2;
        assert.deepEqual(modes, Array.from({ length: batches }, () => [true, false, true]).flat());
      } finally {
        clearRefMap();
      }
    });
  }
}
