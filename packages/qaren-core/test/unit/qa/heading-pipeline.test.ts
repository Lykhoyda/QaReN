import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import vm from 'node:vm';
import { createComponentTreeHandler } from '../../../dist/handlers/component-tree.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import {
  _setFetchForTest,
  _setRunnerStateForTest,
  _setCapabilitiesForTest,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { createMockClient } from '../../helpers/mock-cdp-client.js';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  clearRefMap();
});

async function observedTitle(
  mode = 'title',
  ownerOptions: {
    props?: object;
    hostType?: string;
    geometry?:
      | 'same'
      | 'different'
      | 'missing'
      | 'failed'
      | 'partial'
      | { x: number; y: number; width: number; height: number };
    typographyEvidence?: boolean;
  } = {},
) {
  const native = nativeCapture();
  const frame = { x: 20, y: 40, width: 400, height: 800 };
  const anchor = { x: 10, y: 10, width: 350, height: 400 };
  const title = { x: 20, y: 30, width: 250, height: 40 };
  const body = { x: 20, y: 90, width: 250, height: 20 };
  const rectangles = [frame, anchor, title, body];
  for (let i = 1; i <= 4; i++) {
    const rect = rectangles[i - 1];
    native.nodes[i] = {
      ...native.nodes[1],
      ref: `@e${i}`,
      index: i,
      depth: i < 3 ? i : 3,
      parentIndex: i < 3 ? i - 1 : 2,
      type: ['Window', 'Button', 'StaticText', 'StaticText'][i - 1],
      label: ['', 'Open panel', 'Welcome', 'Your workspace'][i - 1],
      identifier: i === 2 ? 'panel' : undefined,
      rect: { ...rect, x: rect.x + (i === 1 ? 0 : frame.x), y: rect.y + (i === 1 ? 0 : frame.y) },
      presence: {
        captureId: 'capture-7',
        generation: 7,
        nodeIndex: i,
        status: i === 1 ? 'unknown' : 'observed',
        labelSource: 'direct',
        ...(i > 1 ? { observedUptimeMs: 150 } : {}),
      },
    };
  }
  native.snapshotVerdict.nodeCount = native.nodes.length;
  const measured = (rect: typeof title) => ({
    measureInWindow(callback: (...values: number[]) => void) {
      callback(rect.x, rect.y, rect.width, rect.height);
    },
  });
  const root = buildFiber({
    hostType: 'RCTView',
    props: { testID: 'panel', onClick() {} },
    stateNode: measured(anchor),
    children: [
      {
        name: 'TitleWrapper',
        children: [
          {
            hostType: 'RCTText',
            props: { style: { fontSize: mode === 'bold-only' ? 14 : 24, fontWeight: 'bold' } },
            stateNode: measured(mode === 'geometry-mismatch' ? { ...title, x: 99 } : title),
            children: [
              { text: 'Wel' },
              {
                hostType: 'RCTVirtualText',
                props: { style: { fontSize: mode === 'bold-only' ? 14 : 22 } },
                children: [{ text: 'come' }],
              },
            ],
          },
        ],
      },
      {
        hostType: 'RCTText',
        props: {},
        stateNode: measured(body),
        children: [{ text: 'Your workspace' }],
      },
    ],
  });
  if (mode === 'accessible-view-owner' || mode === 'spacer') {
    const owner = buildFiber({
      hostType: ownerOptions.hostType ?? 'RCTView',
      props: ownerOptions.props ?? {
        accessible: true,
        accessibilityLabel: 'Welcome',
        accessibilityRole: 'text',
      },
      stateNode:
        ownerOptions.geometry === 'missing'
          ? {}
          : ownerOptions.geometry === 'failed'
            ? {
                measureInWindow() {
                  throw new Error('unmounted');
                },
              }
            : ownerOptions.geometry === 'partial'
              ? {
                  measureInWindow(callback: (...values: number[]) => void) {
                    callback(20, 30, 250);
                  },
                }
              : measured(
                  typeof ownerOptions.geometry === 'object'
                    ? ownerOptions.geometry
                    : ownerOptions.geometry === 'different'
                      ? anchor
                      : title,
                ),
    });
    owner.return = root;
    if (mode === 'spacer') root.child!.sibling!.sibling = owner;
    else {
      owner.child = root.child;
      for (let child = owner.child; child; child = child.sibling) child.return = owner;
      root.child = owner;
    }
  }
  const queue = [root];
  while (queue.length) {
    const fiber = queue.shift()!;
    fiber.tag =
      typeof fiber.memoizedProps === 'string' ? 6 : typeof fiber.type === 'string' ? 5 : 0;
    for (let child = fiber.child; child; child = child.sibling) queue.push(child);
  }
  const sandbox = createSandbox({ fiberRoot: root });
  const client = createMockClient({
    evaluate: async (expression: string, awaitPromise: boolean) => {
      if (expression.startsWith('__QAREN.getTree('))
        assert.equal(awaitPromise, ownerOptions.typographyEvidence ?? true);
      return { value: await vm.runInContext(expression, sandbox) };
    },
  });
  const tree = createComponentTreeHandler(() => client);
  _setRunnerStateForTest({
    port: 22088,
    pid: process.pid,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: 2,
        commands: REQUIRED_IOS_COMMANDS,
        capabilities: [...REQUIRED_IOS_FEATURES, 'HONEST_HITTABLE', 'PLATFORM_PRESENCE_V2'],
      });
    assert.equal(JSON.parse(String(init?.body)).platformPresence, true);
    assert.equal(JSON.parse(String(init?.body)).presenceBudgetMs, 20_000);
    return Response.json({ ok: true, data: native });
  });
  return captureScreen({
    appId: 'com.test',
    native: async (presenceBudgetMs) => {
      const { data, meta } = parseEnvelope(
        await runIOS({
          command: 'snapshot',
          platformPresence: true,
          bundleId: 'com.test',
          presenceBudgetMs,
        }),
      );
      return { ...data, snapshotVerdict: meta.snapshotVerdict };
    },
    react: async () => {
      const { ok, data, meta } = parseEnvelope(
        await tree({
          depth: 12,
          interactiveOnly: true,
          semanticEvidence: true,
          typographyEvidence: ownerOptions.typographyEvidence ?? true,
        }),
      );
      assert.equal(ok, true);
      return { ...data, verdict: meta.treeVerdict };
    },
  });
}

test('real asynchronous typography producer and handlers qualify an anonymous rich-text title for the walker', async () => {
  const screen = await observedTitle();
  assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
  assert.equal(screen.elements[3].semantic?.heading?.kind, 'typographic-title');
  assert.ok(screen.reactHostEvidence!.hosts.every((host) => host.role === null));
  const typography = screen.reactHostEvidence!.typography!;
  assert.equal(typography.complete, true);
  assert.equal(
    typography.nodes.find(
      (node) => node.text.kind === 'block' && node.text.content === 'Your workspace',
    )!.text.runs[0].fontSize,
    14,
  );
  const judge = scriptedJudge((questions, _index, state) => {
    assert.equal(questions.visibility_1.type, 'noul');
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    assert.equal(state.assertionEvidence.observed.length, 3);
    assert.deepEqual(state.assertionEvidence.unknown, []);
    assert.equal(state.assertionEvidence.unassociatedReact, 0);
    assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
      { contribution: 1, kind: 'typographic-title' },
    ]);
    assert.match(state.assertionEvidence.observed[1], /Welcome/);
    assert.match(state.assertionEvidence.observed[1], /not a declared accessibility role/);
    assert.equal(Object.hasOwn(state, 'hostEvidence'), false);
    return { visibility_1: { type: 'noul', noul: 0.99 } };
  });
  const f = walker([screen], judge);
  const outcome = await runPlan(
    parsePlan('1. Wait for the welcome heading to appear').blocks!,
    f.deps,
  );
  assert.equal(outcome.verdict, 'PASS', outcome.failure?.seen);
  assert.deepEqual(f.actions, []);
  assert.equal(judge.requests.length, 1);
});

test('the same real producer cannot promote bold-only text or a mismatched measurement to a heading', async () => {
  for (const mode of ['bold-only', 'geometry-mismatch']) {
    const screen = await observedTitle(mode);
    assert.equal(screen.elements[3].semantic?.heading, undefined);
    const judge = scriptedJudge(() => assert.fail('unsupported title must not reach Jev'));
    const f = walker([screen], judge);
    const outcome = await runPlan(
      parsePlan('1. Wait for the welcome heading to appear').blocks!,
      f.deps,
    );
    assert.equal(outcome.verdict, 'FAIL');
    assert.match(outcome.failure!.seen, /VISIBILITY_UNSURE/);
    assert.deepEqual(f.actions, []);
  }
});

test('producer → capture refuses a Text title when an accessible View can own the synthetic native StaticText', async () => {
  // The native snapshot is synthetic, not a device observation.
  const screen = await observedTitle('accessible-view-owner');
  assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
  assert.equal(screen.elements[3].semantic?.heading, undefined);
  assert.equal(screen.elements.length, 5, 'no native contributions are removed');
});

test('anonymous View owners need incompatible geometry, not a type name or absent accessibility props', async () => {
  for (const hostType of ['RCTView', 'View', 'RCTScrollView', 'ScrollView']) {
    for (const props of [
      {},
      { accessible: false },
      { accessible: true },
      { accessibilityLabel: 'Welcome' },
      { accessibilityRole: 'text' },
      { role: 'text', accessible: true, accessibilityLabel: 'Welcome' },
    ]) {
      for (const geometry of ['same', 'different', 'missing'] as const) {
        const screen = await observedTitle('accessible-view-owner', { hostType, props, geometry });
        assert.equal(screen.reactHostEvidence?.typography?.complete, true);
        assert.equal(
          screen.elements[3].semantic?.heading?.kind,
          geometry === 'different' ? 'typographic-title' : undefined,
          `${hostType}: ${JSON.stringify(props)} / ${geometry}`,
        );
        assert.equal(screen.elements.length, 5);
        assert.equal(
          screen.reactHostEvidence!.hosts.some((host) => host.role === 'heading'),
          false,
        );
      }
    }
  }
});

test('measured zero-area anonymous Views survive producer → handler → capture without vetoing a positive title', async () => {
  for (const [width, height] of [
    [0, 0],
    [0, 40],
    [250, 0],
  ]) {
    const rect = { x: 20, y: 30, width, height };
    const screen = await observedTitle('spacer', { props: {}, geometry: rect });
    assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
    const typography = screen.reactHostEvidence!.typography!;
    assert.equal(typography.complete, true);
    const spacer = typography.nodes.find(
      (node) => node.hostIndex !== 0 && node.hostType === 'RCTView',
    )!;
    assert.deepEqual(spacer.rect, rect);
    assert.equal(spacer.text.kind, 'none');
    assert.equal(screen.elements[3].semantic?.heading?.kind, 'typographic-title');
    assert.equal(screen.reactHostEvidence!.hosts.length, 5);
    assert.deepEqual(
      screen.elements.map((element) => element.ref),
      ['@e0', '@e1', '@e2', '@e3', '@e4'],
    );
    const judge = scriptedJudge((_, __, state) => {
      assert.equal(state.assertionEvidence.observed.length, 3);
      assert.deepEqual(state.assertionEvidence.unknown, []);
      assert.equal(state.assertionEvidence.unassociatedReact, 0);
      assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
        { contribution: 1, kind: 'typographic-title' },
      ]);
      return { visibility_1: { type: 'noul', noul: 0.99 } };
    });
    const f = walker([screen], judge);
    assert.equal(
      (await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, f.deps)).verdict,
      'PASS',
    );
    assert.deepEqual(f.actions, []);
  }
});

test('missing, failed and invalid spacer measurements stay unknown and cannot create title uniqueness', async () => {
  const invalid = [
    ...(['width', 'height'] as const).map((key) => ({
      x: 20,
      y: 30,
      width: 250,
      height: 40,
      [key]: -1,
    })),
    ...(['x', 'y', 'width', 'height'] as const).flatMap((key) =>
      [NaN, Infinity, -Infinity].map((value) => ({
        x: 20,
        y: 30,
        width: 250,
        height: 40,
        [key]: value,
      })),
    ),
  ];
  for (const geometry of ['missing', 'failed', 'partial', ...invalid] as const) {
    const screen = await observedTitle('spacer', { props: {}, geometry });
    assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
    const typography = screen.reactHostEvidence!.typography!;
    assert.equal(typography.complete, true);
    const spacer = typography.nodes.find(
      (node) => node.hostIndex !== 0 && node.hostType === 'RCTView',
    )!;
    assert.equal(spacer.rect, undefined);
    assert.equal(screen.elements[3].semantic?.heading, undefined);
    assert.equal(screen.reactHostEvidence!.hosts.length, 5);
    assert.equal(screen.elements.length, 5);
    const judge = scriptedJudge(() => assert.fail('unknown ownership must not reach Jev'));
    const f = walker([screen], judge);
    const result = await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /VISIBILITY_UNSURE/);
    assert.deepEqual(f.actions, []);
  }
});

test('authored-label facts carry presence only and require the typography opt-in', async () => {
  for (const typographyEvidence of [false, true]) {
    const screen = await observedTitle('accessible-view-owner', {
      props: { accessibilityLabel: 'private-owner-label', accessible: true },
      typographyEvidence,
    });
    assert.equal(JSON.stringify(screen.reactHostEvidence).includes('private-owner-label'), false);
    if (typographyEvidence) {
      assert.deepEqual(screen.reactHostEvidence!.typography!.nodes[1].accessibility, {
        accessible: 'true',
        authoredLabel: 'present',
      });
    } else assert.equal(screen.reactHostEvidence!.typography, undefined);
    assert.equal(screen.elements[3].semantic?.heading, undefined);
  }
});

test('opaque accessibility getters never execute or create a unique Text owner', async () => {
  for (const key of [
    'accessible',
    'accessibilityLabel',
    'aria-label',
    'accessibilityRole',
    'role',
  ]) {
    for (const inherited of [false, true]) {
      let reads = 0;
      const accessor = Object.defineProperty({}, key, {
        enumerable: true,
        get() {
          reads++;
          return undefined;
        },
      });
      const screen = await observedTitle('accessible-view-owner', {
        props: inherited ? Object.create(accessor) : accessor,
      });
      assert.equal(reads, 0, `${key} / inherited=${inherited}`);
      assert.equal(screen.elements[3].semantic?.heading, undefined);
      assert.equal(screen.elements.length, 5);
    }
  }
  for (const key of ['accessible', 'accessibilityLabel', 'accessibilityRole', 'role']) {
    const screen = await observedTitle('accessible-view-owner', {
      props: { [key]: { toString: () => assert.fail('opaque facts must not be coerced') } },
    });
    assert.equal(screen.elements[3].semantic?.heading, undefined, key);
  }
});
