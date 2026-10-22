import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen, emitCaptureDiagnostics } from '../../../dist/qa/capture.js';
import { outsideViewport, viewportDiagnostic } from '../../../dist/qa/native-presence.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

const SECRET = 'SECRET-MARKER-123';
const screenRect = { x: 0, y: 0, width: 402, height: 874 };

type Spec = { type: string; parent?: number; rect?: NativeNode['rect'] };

function tree(specs: Spec[]): NativeNode[] {
  return specs.map((spec, index) => ({
    ref: `@e${index}`,
    index,
    type: spec.type,
    ...(spec.parent === undefined ? {} : { parentIndex: spec.parent }),
    ...(spec.rect ? { rect: spec.rect } : {}),
    label: SECRET,
    identifier: SECRET,
    value: SECRET,
  }));
}

const title = (x: number) => ({ x, y: 120, width: 300, height: 30 });

// Application, app Window, a pager strip, then page titles at x = 16 / 418 / 820.
function pager(options: {
  windowRect?: NativeNode['rect'] | null;
  keyboardWindow?: boolean;
  pagesUnder?: 'strip' | 'application';
  pageRects?: NativeNode['rect'][];
}): NativeNode[] {
  const specs: Spec[] = [{ type: 'Application', rect: screenRect }];
  if (options.keyboardWindow) specs.push({ type: 'Window', parent: 0, rect: screenRect });
  const windowIndex = options.windowRect === null ? 0 : specs.length;
  if (options.windowRect !== null)
    specs.push({ type: 'Window', parent: 0, rect: options.windowRect ?? screenRect });
  const stripIndex = specs.length;
  specs.push({
    type: 'Other',
    parent: windowIndex,
    rect: { x: 0, y: 100, width: 1206, height: 70 },
  });
  const pageParent = options.pagesUnder === 'application' ? 0 : stripIndex;
  for (const rect of options.pageRects ?? [title(16), title(418), title(820)])
    specs.push({ type: 'StaticText', parent: pageParent, rect });
  return tree(specs);
}

const parse = (line: string) => {
  assert.ok(line.startsWith('viewport-diagnostic {'), line);
  return JSON.parse(line.slice('viewport-diagnostic '.length));
};
const diagnose = (nodes: NativeNode[]) => parse(viewportDiagnostic(nodes, outsideViewport(nodes)));
// The diagnostic alone, as if nothing were clipped, so its categories stay testable.
const unclipped = (nodes: NativeNode[]) => parse(viewportDiagnostic(nodes, new Set()));
const offscreenTitles = (nodes: NativeNode[]) =>
  [...outsideViewport(nodes)]
    .filter((i) => nodes[i].type === 'StaticText')
    .map((i) => nodes[i].rect!.x)
    .sort((a, b) => a - b);

test('the Application rect clips fixtures A-F regardless of Window ancestry', () => {
  const inside = [title(16), title(30), title(60)];
  assert.deepEqual(offscreenTitles(pager({})), [418, 820]);
  assert.deepEqual(offscreenTitles(pager({ keyboardWindow: true })), [418, 820]);
  assert.deepEqual(offscreenTitles(pager({ pagesUnder: 'application' })), [418, 820]);
  assert.deepEqual(offscreenTitles(pager({ windowRect: null })), [418, 820]);
  assert.deepEqual(
    offscreenTitles(pager({ windowRect: { x: 0, y: 0, width: 1206, height: 874 } })),
    [418, 820],
  );
  assert.deepEqual(offscreenTitles(pager({ pageRects: inside })), []);
});

test('keyboard-up capture: later pages chained to no Window are offscreen', () => {
  // Two app-sized Windows (app, keyboard); page 1 under the app Window, pages 2-3 orphaned from both.
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: 'Window', parent: 0, rect: screenRect },
    { type: 'Window', parent: 0, rect: screenRect },
    { type: 'Other', parent: 0, rect: { x: 0, y: 100, width: 1206, height: 700 } },
    { type: 'StaticText', parent: 1, rect: { x: 16, y: 120, width: 300, height: 30 } },
    { type: 'StaticText', parent: 3, rect: { x: 402, y: 120, width: 300, height: 30 } },
    { type: 'Button', parent: 3, rect: { x: 418, y: 600, width: 200, height: 44 } },
    { type: 'StaticText', parent: 3, rect: { x: 804, y: 120, width: 300, height: 30 } },
    { type: 'Button', parent: 0, rect: { x: 820, y: 600, width: 200, height: 44 } },
    { type: 'Keyboard', parent: 2, rect: { x: 0, y: 538, width: 402, height: 336 } },
  ]);
  assert.deepEqual([...outsideViewport(nodes)], [3, 5, 6, 7, 8]);
  assert.equal(diagnose(nodes).symptom, 0);
});

test('partly visible nodes whose centres lie outside the Application are offscreen without a Window', () => {
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: 'StaticText', parent: 0, rect: { x: 390, y: 120, width: 300, height: 30 } },
    { type: 'StaticText', parent: 0, rect: { x: -290, y: 120, width: 300, height: 30 } },
    { type: 'StaticText', parent: 0, rect: { x: 10, y: 860, width: 300, height: 30 } },
    { type: 'StaticText', parent: 0, rect: { x: 402, y: 120, width: 300, height: 30 } },
    { type: 'StaticText', parent: 0, rect: { x: -300, y: 120, width: 300, height: 30 } },
    { type: 'StaticText', parent: 0, rect: { x: 10, y: 874, width: 300, height: 30 } },
  ]);
  assert.deepEqual([...outsideViewport(nodes)], [1, 2, 3, 4, 5, 6]);
});

test('a missing or invalid Application rect keeps the Window-only clip', () => {
  const orphaned = (app: Spec) => tree([app, { type: 'StaticText', parent: 0, rect: title(820) }]);
  for (const app of [
    { type: 'Application' },
    { type: 'Application', rect: { x: 0, y: 0, width: 0, height: 874 } },
    { type: 'Application', rect: { x: 0, y: 0, width: 402, height: 0 } },
    { type: 'Other', rect: screenRect },
  ])
    assert.deepEqual([...outsideViewport(orphaned(app))], [], JSON.stringify(app));
  const noApp = pager({}).map((node) =>
    node.type === 'Application' ? { ...node, rect: undefined } : node,
  );
  assert.deepEqual(offscreenTitles(noApp), [418, 820]);
});

test('the line tells apart missing, invalid and wider Window anchors', () => {
  const underApp = unclipped(pager({ pagesUnder: 'application' }));
  assert.equal(underApp.symptom, 2);
  assert.equal(underApp.noWindow, 2);

  const noWindow = unclipped(pager({ windowRect: null }));
  assert.equal(noWindow.windowCount, 0);
  assert.equal(noWindow.noWindow, 2);

  const invalid = unclipped(pager({ windowRect: { x: 0, y: 0, width: 0, height: 874 } }));
  assert.equal(invalid.invalidWindowOnly, 2);
  assert.deepEqual(invalid.windows, [[1, 0, 0, 0, 874]]);

  const wider = unclipped(pager({ windowRect: { x: 0, y: 0, width: 1206, height: 874 } }));
  assert.equal(wider.symptom, 2);
  assert.deepEqual(wider.windows, [[1, 0, 0, 1206, 874]]);
  assert.deepEqual(wider.app, [0, 0, 402, 874]);
  for (const [, , w, wv, u] of wider.sample) assert.deepEqual([w, wv, u], [1, 1, 1]);

  for (const fixture of [
    pager({}),
    pager({ keyboardWindow: true }),
    pager({ pagesUnder: 'application' }),
    pager({ windowRect: null }),
    pager({ windowRect: { x: 0, y: 0, width: 0, height: 874 } }),
    pager({ windowRect: { x: 0, y: 0, width: 1206, height: 874 } }),
  ])
    assert.equal(diagnose(fixture).symptom, 0);
});

test('the observed keyboard-up order alone does not produce a symptom', () => {
  // Keyboard Window first, page content under the app Window, modal container emitted after its content.
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: 'Window', parent: 0, rect: screenRect },
    { type: 'Window', parent: 0, rect: screenRect },
    { type: 'StaticText', parent: 2, rect: title(16) },
    { type: 'StaticText', parent: 2, rect: title(418) },
    { type: 'StaticText', parent: 2, rect: title(820) },
    { type: 'Other', parent: 2, rect: screenRect },
  ]);
  assert.equal(diagnose(nodes).symptom, 0);
  const detached = nodes.map((node, i) => (i >= 3 && i <= 5 ? { ...node, parentIndex: 0 } : node));
  const shape = unclipped(detached);
  assert.equal(shape.symptom, 2);
  assert.equal(shape.noWindow, 2);
  assert.equal(diagnose(detached).symptom, 0);
});

test('a scroll-clipped symptom node names its clip ancestor and the raw Window', () => {
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: 'Window', parent: 0, rect: { x: 0, y: 0, width: 1206, height: 874 } },
    { type: 'ScrollView', parent: 1, rect: { x: 0, y: 0, width: 1206, height: 874 } },
    { type: 'StaticText', parent: 2, rect: title(820) },
  ]);
  const line = unclipped(nodes);
  assert.equal(line.scrollClipped, 1);
  assert.deepEqual(line.sample, [[3, 'StaticText', 1, 1, 1, 2, 820, 120]]);
  assert.deepEqual(line.windows, [[1, 0, 0, 1206, 874]]);
});

test('an Android scroll container names the clip ancestor of a symptom node', () => {
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: 'Window', parent: 0, rect: { x: 0, y: 0, width: 1206, height: 874 } },
    {
      type: 'android.widget.ScrollView',
      parent: 1,
      rect: { x: 0, y: 0, width: 1206, height: 874 },
    },
    { type: 'android.widget.TextView', parent: 2, rect: title(820) },
  ]);
  const line = unclipped(nodes);
  assert.equal(line.scrollClipped, 1);
  assert.deepEqual(line.sample, [[3, 'Other', 1, 1, 1, 2, 820, 120]]);
});

test('unknown geometry stays unknown and rectless nodes are counted', () => {
  const nodes = tree([
    { type: 'Window', rect: screenRect },
    { type: 'StaticText', parent: 0, rect: title(820) },
    { type: 'StaticText', parent: 0 },
  ]);
  const line = diagnose(nodes);
  assert.equal(line.app, null);
  assert.equal(line.outsideApp, null);
  assert.equal(line.symptom, null);
  assert.equal(line.rectless, 1);
});

test('the line carries no labels, identifiers, values or non-Window sizes', () => {
  const raw = viewportDiagnostic(pager({ pagesUnder: 'application' }), new Set());
  assert.equal(raw.includes(SECRET), false);
  for (const entry of parse(raw).sample) assert.equal(entry.length, 8);
  assert.equal(raw.includes('"300"') || /,300,30\]/.test(raw), false);
});

test('counts stay whole while listed Windows and samples are capped within 2 KB', () => {
  const specs: Spec[] = [{ type: 'Application', rect: screenRect }];
  for (let i = 0; i < 50; i++) specs.push({ type: 'Window', parent: 0, rect: screenRect });
  for (let i = 0; i < 50; i++) specs.push({ type: 'StaticText', parent: 0, rect: title(1000 + i) });
  const nodes = tree(specs);
  const raw = viewportDiagnostic(nodes, new Set());
  const line = parse(raw);
  assert.equal(line.windowCount, 50);
  assert.equal(line.windows.length, 8);
  assert.equal(line.symptom, 50);
  assert.equal(line.sample.length, 20);
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 2048, `${Buffer.byteLength(raw, 'utf8')} bytes`);
  const huge = tree([
    { type: 'Application', rect: screenRect },
    ...Array.from({ length: 30 }, () => ({
      type: 'Window',
      parent: 0,
      rect: { x: -1e20, y: -1e20, width: 1e20, height: 1e20 },
    })),
    ...Array.from({ length: 30 }, () => ({
      type: 'CollectionView',
      parent: 0,
      rect: { x: 1e20, y: 1e20, width: 1, height: 1 },
    })),
  ]);
  const bounded = viewportDiagnostic(huge, new Set());
  assert.ok(
    Buffer.byteLength(bounded, 'utf8') <= 2048,
    `${Buffer.byteLength(bounded, 'utf8')} bytes`,
  );
  const parsed = parse(bounded);
  assert.equal(parsed.windowCount, 30);
  assert.equal(parsed.symptom, 60);
  assert.ok(parsed.sample.length < 20 || parsed.windows.length < 8, 'the bound shrank the lists');
});

test('an unknown element type is written as Other', () => {
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: `Custom${SECRET}`, parent: 0, rect: title(820) },
  ]);
  assert.deepEqual(unclipped(nodes).sample[0].slice(0, 2), [1, 'Other']);
});

async function emitted(truncated: boolean | undefined, requirePrivateInputs: boolean) {
  const lines: string[] = [];
  const nodes = pager({ pagesUnder: 'application' });
  const native = attested(nodes);
  const observation =
    truncated === undefined
      ? { nodes }
      : { ...native, truncated, ...(truncated ? {} : { snapshotVerdict: native.snapshotVerdict }) };
  const react = async () => ({
    interactive: [],
    verdict: { state: 'ok', path: 'interactive', complete: true },
    hostEvidence: { hosts: [], complete: true },
  });
  const capture = async (warn?: (message: string) => void) => {
    const screen = await captureScreen({
      appId: 'com.test',
      requirePrivateInputs,
      native: async () => observation,
      react,
      warn,
    });
    emitCaptureDiagnostics(screen);
    return screen;
  };
  let outcome: unknown;
  let silent: unknown;
  try {
    outcome = await capture((message) => lines.push(message));
  } catch (error) {
    outcome = { refused: (error as Error).name };
  }
  try {
    silent = await capture();
  } catch (error) {
    silent = { refused: (error as Error).name };
  }
  assert.equal(JSON.stringify(lines).includes(SECRET), false, 'no warning carries a node string');
  return { lines: lines.filter((line) => line.startsWith('viewport-diagnostic')), outcome, silent };
}

test('only a complete native capture emits the line, and emitting changes nothing', async () => {
  for (const requirePrivateInputs of [true, false]) {
    const complete = await emitted(false, requirePrivateInputs);
    assert.equal(complete.lines.length, 1, `complete, require=${requirePrivateInputs}`);
    assert.deepEqual(
      JSON.parse(JSON.stringify(complete.outcome)),
      JSON.parse(JSON.stringify(complete.silent)),
    );
    for (const truncated of [true, undefined]) {
      const other = await emitted(truncated, requirePrivateInputs);
      assert.equal(
        other.lines.length,
        0,
        `truncated=${truncated}, require=${requirePrivateInputs}`,
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(other.outcome)),
        JSON.parse(JSON.stringify(other.silent)),
      );
    }
  }
  const refused = await emitted(true, true);
  assert.deepEqual(refused.outcome, { refused: 'PrivateInputCaptureError' });
});

test('a slow diagnostic sink cannot change the capture budget verdict', async () => {
  for (const elapsed of [21_999, 22_001]) {
    const run = async (logging: boolean) => {
      let clock = 0;
      const lines: string[] = [];
      const screen = await captureScreen({
        appId: 'com.test',
        requirePrivateInputs: true,
        now: () => clock,
        native: async () => nativeCapture(),
        react: async () => {
          clock = elapsed;
          return {
            interactive: [{ role: 'button', testID: 'save', capabilities: { press: true } }],
            verdict: { state: 'ok', path: 'interactive', complete: true },
            hostEvidence: {
              hosts: [
                {
                  testID: 'save',
                  role: 'button',
                  roleSource: 'role',
                  capabilities: { press: true },
                },
              ],
              complete: true,
            },
          };
        },
        ...(logging
          ? {
              warn: (message: string) => {
                lines.push(message);
                clock += 10;
              },
            }
          : {}),
      });
      emitCaptureDiagnostics(screen);
      return { screen, lines, clock };
    };
    const silent = await run(false);
    const logged = await run(true);
    assert.deepEqual(logged.screen, silent.screen);
    assert.deepEqual(logged.screen.captureCoverage, { native: 'complete', react: 'complete' });
    if (elapsed < 22_000) {
      assert.deepEqual(logged.screen.coverage, { native: 'complete', react: 'complete' });
      assert.equal(logged.screen.nativeCaptureCauses, undefined);
      assert.ok(logged.screen.elements.some((element) => element.semantic));
      assert.equal(logged.lines.length, 1);
      parse(logged.lines[0]);
      assert.equal(logged.clock, elapsed + 10);
    } else {
      assert.equal(logged.screen.coverage?.native, 'incomplete');
      assert.ok(logged.screen.nativeCaptureCauses?.includes('capture-over-budget'));
      assert.ok(logged.screen.elements.every((element) => element.semantic === undefined));
      assert.deepEqual(logged.lines, []);
      assert.equal(logged.clock, elapsed);
    }
  }
});

// Application, Window, a container wholly below the screen, then two children at on-screen rects.
function homeShape(childType: string): NativeNode[] {
  return tree([
    { type: 'Application', rect: screenRect },
    { type: 'Window', parent: 0, rect: screenRect },
    { type: 'Other', parent: 1, rect: { x: 0, y: 900, width: 402, height: 600 } },
    { type: childType, parent: 2, rect: { x: 16, y: 300, width: 370, height: 44 } },
    { type: childType, parent: 2, rect: { x: 16, y: 350, width: 370, height: 44 } },
  ]);
}

test('on-screen rows under a stale off-screen container stay visible', () => {
  const nodes = homeShape('StaticText');
  assert.deepEqual([...outsideViewport(nodes)], [2]);
  const line = diagnose(nodes);
  assert.deepEqual(line.excluded, []);
  assert.equal(line.excludedCount, 0);
});

test('text inputs under a wholly off-screen container are offscreen', () => {
  for (const type of ['TextView', 'TextField', 'SecureTextField', 'SearchField']) {
    const nodes = homeShape(type);
    assert.deepEqual([...outsideViewport(nodes)], [2, 3, 4], type);
    const line = diagnose(nodes);
    assert.equal(line.excludedCount, 2, type);
    assert.deepEqual(
      line.excluded.map((entry: unknown[]) => entry.slice(0, 5)),
      [
        [3, type, 'anc', 2, 'Other'],
        [4, type, 'anc', 2, 'Other'],
      ],
      type,
    );
    assert.deepEqual(line.excluded[0].slice(5), [0, 900, 402, 600], type);
  }
});

test('rows below the fold of a long list stay offscreen', () => {
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: 'Window', parent: 0, rect: screenRect },
    { type: 'Other', parent: 1, rect: { x: 0, y: 0, width: 402, height: 3000 } },
    { type: 'StaticText', parent: 2, rect: { x: 16, y: 300, width: 370, height: 44 } },
    { type: 'StaticText', parent: 2, rect: { x: 16, y: 1200, width: 370, height: 44 } },
  ]);
  assert.deepEqual([...outsideViewport(nodes)], [2, 4]);
  assert.deepEqual(
    diagnose(nodes).excluded.map((entry: unknown[]) => entry[0]),
    [2],
  );
});

test('excluded names the scroll or Window clip that removed an in-app node', () => {
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: 'Window', parent: 0, rect: { x: 0, y: 0, width: 402, height: 400 } },
    { type: 'ScrollView', parent: 1, rect: { x: 0, y: 100, width: 402, height: 100 } },
    { type: 'StaticText', parent: 2, rect: { x: 16, y: 300, width: 200, height: 30 } },
    { type: 'StaticText', parent: 1, rect: { x: 16, y: 600, width: 200, height: 30 } },
  ]);
  assert.deepEqual([...outsideViewport(nodes)], [3, 4]);
  const raw = viewportDiagnostic(nodes, outsideViewport(nodes));
  assert.equal(raw.includes(SECRET), false);
  const line = parse(raw);
  assert.equal(line.excludedCount, 2);
  assert.deepEqual(line.excluded, [
    [3, 'StaticText', 'scroll', 2, 'ScrollView', 0, 100, 402, 100],
    [4, 'StaticText', 'window', 1, 'Window', 0, 0, 402, 400],
  ]);
});

test('excluded lists at most ten entries while the count stays whole within 2 KB', () => {
  const specs: Spec[] = [
    { type: 'Application', rect: screenRect },
    { type: 'Window', parent: 0, rect: screenRect },
    { type: 'Other', parent: 1, rect: { x: 0, y: 900, width: 402, height: 600 } },
  ];
  for (let i = 0; i < 50; i++)
    specs.push({
      type: 'TextField',
      parent: 2,
      rect: { x: 16, y: 100 + i, width: 300, height: 30 },
    });
  const nodes = tree(specs);
  const raw = viewportDiagnostic(nodes, outsideViewport(nodes));
  const line = parse(raw);
  assert.equal(line.excludedCount, 50);
  assert.equal(line.excluded.length, 10);
  assert.deepEqual(
    line.excluded.map((entry: unknown[]) => entry[0]),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.equal(raw.includes(SECRET), false);
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 2048, `${Buffer.byteLength(raw, 'utf8')} bytes`);
});

test('the admitted diagnostic correlates the actual producer viewport and native join boundaries', async () => {
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: 'Window', parent: 0, rect: screenRect },
    { type: 'TextField', parent: 1, rect: title(820) },
    { type: 'StaticText', parent: 1, rect: title(16) },
  ]);
  nodes[2].enabled = false;
  nodes[2].hittable = false;
  const lines: string[] = [];
  const observation = {
    ...attested(nodes),
    snapshotDiagnostics: {
      viewportStatus: 'collected',
      viewportSource: 'first-nonempty-window',
      viewport: [-20, 30, 100, 200],
      emittedCount: 5,
      normalizedCount: 4,
      missingRectCount: 1,
      emittedByKind: [1, 0, 0, 1, 0, 0, 0, 0, 1, 2],
      normalizedByKind: [1, 0, 0, 0, 0, 0, 0, 0, 1, 2],
      missingRectByKind: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
      label: SECRET,
    },
  };
  const run = (warn?: (line: string) => void) =>
    captureScreen({
      observation: 17,
      platformPresence: false,
      native: async () => observation,
      react: async () => ({ interactive: [] }),
      warn,
    });
  const logged = await run((line) => lines.push(line));
  assert.deepEqual(lines, [], 'no emission before admission');
  emitCaptureDiagnostics(logged);
  const facts = parse(lines[0]);
  assert.equal(facts.observation, 17);
  assert.equal(facts.mode, 'ordinary');
  assert.equal(facts.native.acquisition, 'returned');
  assert.equal(facts.native.coverage, 'complete');
  assert.equal(facts.native.truncated, false);
  assert.equal(facts.native.normalizationDroppedNodes, 0);
  assert.deepEqual(facts.snapshot.viewport, [-20, 30, 100, 200]);
  assert.deepEqual(facts.snapshot.emittedByKind, [1, 0, 0, 1, 0, 0, 0, 0, 1, 2]);
  assert.deepEqual(facts.projection.joinedByKind, [1, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
  assert.deepEqual(facts.projection.duplicateByKind, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(facts.projection.offscreenCount, 1);
  assert.equal(facts.projection.disabledCount, 1);
  assert.equal(facts.projection.enabledKnownCount, 1);
  assert.equal(facts.projection.hittableKnownCount, 1);
  assert.equal(facts.projection.rectKnownCount, 4);
  assert.equal(JSON.stringify(lines).includes(SECRET), false);
  assert.deepEqual(logged, await run());
  assert.doesNotThrow(() => JSON.stringify(logged));
  assert.equal(JSON.stringify(logged).includes('joinedByKind'), false);
});

test('missing and malformed private diagnostics stay unknown without invoking getters or coercions', async () => {
  let reads = 0;
  const trap = () => {
    reads++;
    throw new Error(SECRET);
  };
  const malformed = {
    v: 1,
    viewportSource: 'app',
    get viewport() {
      return trap();
    },
    get emittedCount() {
      return trap();
    },
    toJSON: trap,
    toString: trap,
  };
  for (const [snapshotDiagnostics, status] of [
    [undefined, 'missing'],
    [null, 'invalid'],
    [malformed, 'invalid'],
    [{ viewportStatus: 'collected', viewportSource: SECRET, viewport: [0, 0, 1, 1] }, 'invalid'],
  ] as const) {
    const lines: string[] = [];
    const screen = await captureScreen({
      observation: 5,
      platformPresence: true,
      native: async () => ({ ...nativeCapture(), snapshotDiagnostics }),
      react: async () => ({ interactive: [] }),
      warn: (line) => lines.push(line),
    });
    emitCaptureDiagnostics(screen);
    const facts = parse(lines[0]);
    assert.equal(facts.snapshot.viewportStatus, status);
    assert.equal(facts.snapshot.viewportSource, null);
    assert.equal(facts.snapshot.viewport, null);
    assert.equal(facts.snapshot.emittedCount, null);
    assert.equal(facts.snapshot.emittedByKind, null);
    assert.equal(facts.mode, 'platform-presence');
    assert.equal(JSON.stringify(lines).includes(SECRET), false);
  }
  assert.equal(reads, 0);
});

test('correlated counts stay whole within the existing byte bound as geometry samples shrink', async () => {
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    ...Array.from({ length: 300 }, (_, i) => ({
      type: 'StaticText',
      parent: 0,
      rect: title(1000 + i * 400),
    })),
  ]);
  const lines: string[] = [];
  const screen = await captureScreen({
    observation: 9000,
    native: async () => attested(nodes),
    react: async () => ({}),
    warn: (line) => lines.push(line),
  });
  emitCaptureDiagnostics(screen);
  const facts = parse(lines[0]);
  assert.equal(facts.outsideApp, 300);
  assert.equal(facts.projection.joinedByKind[8], 300);
  assert.equal(facts.projection.offscreenCount, 300);
  assert.ok(Buffer.byteLength(lines[0], 'utf8') <= 2048);
});

test('slow or throwing sinks preserve the deadline result when React refuses generically', async () => {
  for (const elapsed of [21999, 22001]) {
    const run = async (logging: boolean) => {
      let clock = 0;
      const screen = await captureScreen({
        observation: 4,
        now: () => clock,
        native: async () => nativeCapture(),
        react: async () => {
          clock = elapsed;
          throw new Error(SECRET);
        },
        ...(logging
          ? {
              warn: (line: string) => {
                assert.equal(line.includes(SECRET), false);
                clock += 100;
                throw new Error(SECRET);
              },
            }
          : {}),
      });
      emitCaptureDiagnostics(screen);
      return screen;
    };
    assert.deepEqual(await run(true), await run(false));
  }
});

test('native duplicate removals and source collectedness do not become eligibility rules', async () => {
  const nodes = tree([
    { type: 'Application', rect: screenRect },
    { type: 'StaticText', parent: 0, rect: title(16) },
    { type: 'StaticText', parent: 1, rect: title(16) },
  ]);
  delete nodes[2].identifier;
  const lines: string[] = [];
  const screen = await captureScreen({
    native: async () => attested(nodes),
    react: async () => ({}),
    warn: (line) => lines.push(line),
  });
  emitCaptureDiagnostics(screen);
  const facts = parse(lines[0]);
  assert.deepEqual(facts.projection.joinedByKind, [0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual(facts.projection.duplicateByKind, [0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert.equal(facts.projection.enabledKnownCount, 0);
  assert.equal(facts.projection.hittableKnownCount, 0);
  assert.equal(facts.projection.rectKnownCount, 2);
  assert.equal(screen.elements.length, 2);
  assert.equal(screen.elements[1].disabled, false);
  assert.equal(screen.elements[1].offscreen, false);
});

test('an incomplete verdict leaves projection diagnostics uncollected', async () => {
  const native = nativeCapture();
  const lines: string[] = [];
  const screen = await captureScreen({
    native: async () => ({
      ...native,
      snapshotVerdict: { ...native.snapshotVerdict, reasons: Array(300).fill('empty-capture') },
    }),
    react: async () => ({}),
    warn: (line) => lines.push(line),
  });
  emitCaptureDiagnostics(screen);
  assert.deepEqual(lines, []);
  assert.equal(screen.captureCoverage?.native, 'incomplete');
});
