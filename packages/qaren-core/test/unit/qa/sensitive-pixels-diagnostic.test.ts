import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen, emitCaptureDiagnostics } from '../../../dist/qa/capture.js';
import {
  capturePrivateScreen,
  formatSensitivePixels,
  inputValues,
  ObservedPrivacy,
  sensitivePixelsReasons,
} from '../../../dist/qa/privacy.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

const SECRET = 'SECRET-MARKER-123';
const SINK_PREFIX = 'qaren-core: ';
const rect = { x: 0, y: 0, width: 400, height: 800 };
const verdict = { state: 'ok', path: 'interactive', complete: true };
const react = async () => ({
  interactive: [],
  verdict,
  hostEvidence: { hosts: [], complete: true },
});

type Spec = Partial<NativeNode> & { type: string };

function tree(specs: Spec[]): NativeNode[] {
  return [
    { type: 'Application', label: 'Test app' },
    { type: 'Window', parentIndex: 0 },
    ...specs.map((spec) => ({ parentIndex: 1, ...spec })),
  ].map((spec, index) => ({ ref: `@e${index}`, index, rect, ...spec }) as NativeNode);
}

const parse = (line: string) => {
  assert.ok(line.startsWith('sensitive-pixels {'), line);
  return JSON.parse(line.slice('sensitive-pixels '.length));
};

function privacyView(screen: Screen) {
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  return {
    canScreenshot: privacy.canScreenshot(),
    modelValues: privacy.modelValues(),
    redacted: privacy.redact(JSON.stringify(screen)),
    inputValues: inputValues(screen),
  };
}

// The fields every line carried before per-carrier shapes were added.
const legacy = ({ shapes: _shapes, omittedShapes: _omitted, ...rest }: Record<string, unknown>) =>
  rest;

const outcome = (value: unknown) => JSON.parse(JSON.stringify(value));

async function capture(
  nodes: NativeNode[],
  options: {
    observation?: unknown;
    requirePrivateInputs?: boolean;
    react?: typeof react;
    warn?: (message: string) => void;
  } = {},
) {
  try {
    const screen = await captureScreen({
      appId: 'com.test',
      requirePrivateInputs: options.requirePrivateInputs ?? true,
      native: async () => options.observation ?? attested(nodes),
      react: options.react ?? react,
      warn: options.warn,
    });
    emitCaptureDiagnostics(screen);
    return screen;
  } catch (error) {
    return { refused: (error as Error).name };
  }
}

// Captures with and without a sink, proves the sink changed nothing, and returns every warning.
async function observe(specs: Spec[], options: Parameters<typeof capture>[1] = {}) {
  const nodes = tree(specs);
  const lines: string[] = [];
  const logged = await capture(nodes, { ...options, warn: (message) => lines.push(message) });
  const silent = await capture(nodes, options);
  assert.deepEqual(outcome(logged), outcome(silent));
  if (!('refused' in logged))
    assert.deepEqual(privacyView(logged as Screen), privacyView(silent as Screen));
  const sensitive = lines.filter((line) => line.startsWith('sensitive-pixels'));
  return {
    nodes,
    screen: logged,
    lines,
    line: sensitive.length === 1 ? parse(sensitive[0]) : undefined,
    count: sensitive.length,
    canScreenshot: 'refused' in logged ? undefined : privacyView(logged as Screen).canScreenshot,
  };
}

const text = (label: string): Spec => ({ type: 'StaticText', label });

test('a valued paging ScrollView is reported as the only carrier', async () => {
  const run = await observe([
    { type: 'ScrollView', value: 'page 1 of 3' },
    text('Welcome'),
    text('Next'),
  ]);
  assert.equal(run.canScreenshot, false);
  assert.deepEqual(run.line, {
    v: 1,
    r1: 1,
    secure: 0,
    r3: 1,
    types: [['ScrollView', 1]],
    omittedTypes: 0,
    shapes: [['ScrollView', 'none', 'text', '9+', 400, 800, 'Window', 0, 'native']],
    omittedShapes: 0,
  });
});

test('an empty secure input is reported through the secure count alone', async () => {
  const run = await observe([{ type: 'SecureTextField' }, text('Sign in')]);
  assert.equal(run.canScreenshot, false);
  assert.deepEqual(run.line, {
    v: 1,
    r1: 0,
    secure: 1,
    r3: 0,
    types: [],
    omittedTypes: 0,
    shapes: [],
    omittedShapes: 0,
  });
});

test('a real input value is reported as a TextField carrier', async () => {
  const run = await observe([
    { type: 'TextField', label: 'Email', value: 'person@example.test' },
    text('Sign in'),
  ]);
  assert.equal(run.canScreenshot, false);
  assert.equal(run.line.secure, 0);
  assert.ok(run.line.r3 >= 1);
  assert.deepEqual(run.line.types, [['TextField', 1]]);
});

test('a valued Other custom input is reported as an Other carrier', async () => {
  const run = await observe([{ type: 'Other', value: '42 kg' }, text('Weight')]);
  assert.equal(run.canScreenshot, false);
  assert.deepEqual(run.line.types, [['Other', 1]]);
  assert.equal(run.line.r1, 1);
});

test('one value on several carriers counts once in r1 and once per carrier in types', async () => {
  const run = await observe([
    { type: 'Other', value: 'same' },
    { type: 'Other', value: '  same  ' },
    { type: 'ScrollView', value: 'same' },
    { type: 'Slider', value: '50%' },
  ]);
  assert.equal(run.canScreenshot, false);
  assert.equal(run.line.r1, 2);
  assert.deepEqual(run.line.types, [
    ['Other', 2],
    ['ScrollView', 1],
    ['Slider', 1],
  ]);

  const screen = run.screen as Screen;
  capturePrivateScreen(screen, [
    {
      values: [' padded '],
      secure: false,
      elements: [screen.elements[0]],
      associationUnique: true,
    },
  ]);
  const stored = parse(sensitivePixelsReasons(screen, run.nodes)!);
  assert.equal(stored.r1, 2, 'a stored trimmed variant is its own unique string');
  assert.deepEqual(stored.types, [], 'neither variant is shown by an element');
});

test('a texts-only screen is not sensitive and logs no line', async () => {
  const run = await observe([text('Welcome'), { type: 'Button', label: 'Continue' }]);
  assert.equal(run.canScreenshot, true);
  assert.equal(run.count, 0);
  assert.equal(sensitivePixelsReasons(run.screen as Screen, run.nodes), undefined);
});

test('incomplete or unattested native captures log no line, whatever requirePrivateInputs says', async () => {
  const specs: Spec[] = [{ type: 'ScrollView', value: 'page 1 of 3' }];
  const nodes = tree(specs);
  for (const requirePrivateInputs of [true, false]) {
    for (const observation of [{ ...attested(nodes), truncated: true }, { nodes }]) {
      const run = await observe(specs, { observation, requirePrivateInputs });
      assert.equal(run.count, 0, `require=${requirePrivateInputs}`);
      if (requirePrivateInputs)
        assert.deepEqual(run.screen, { refused: 'PrivateInputCaptureError' });
      else assert.notEqual((run.screen as Screen).captureCoverage?.native, 'complete');
    }
  }
});

test('a complete snapshot whose presence validation failed still logs its line', async () => {
  const source = nativeCapture();
  const nodes = source.nodes.map((node) =>
    node.type === 'Button' ? { ...node, type: 'ScrollView', value: 'page 2 of 3' } : node,
  ) as unknown as NativeNode[];
  const lines: string[] = [];
  const screen = await captureScreen({
    appId: 'com.test',
    requirePrivateInputs: true,
    native: async () => ({
      ...source,
      nodes,
      presenceCapture: { ...source.presenceCapture, complete: false },
    }),
    react,
    warn: (message) => lines.push(message),
  });
  emitCaptureDiagnostics(screen);
  assert.equal(screen.captureCoverage?.native, 'complete');
  assert.equal(screen.coverage?.native, 'incomplete');
  const sensitive = lines.filter((line) => line.startsWith('sensitive-pixels'));
  // Without a presence verdict the label may be a value too: two stored strings, one carrier.
  assert.deepEqual(sensitive.map(parse).map(legacy), [
    { v: 1, r1: 2, secure: 0, r3: 2, types: [['ScrollView', 1]], omittedTypes: 0 },
  ]);
});

test('a slow or throwing sink at the budget edge cannot change the capture', async () => {
  for (const elapsed of [21_999, 22_001]) {
    for (const sink of ['slow', 'throw'] as const) {
      const run = async (logging: boolean) => {
        let clock = 0;
        const lines: string[] = [];
        const screen = await captureScreen({
          appId: 'com.test',
          requirePrivateInputs: true,
          now: () => clock,
          native: async () => attested(tree([{ type: 'ScrollView', value: 'page 1 of 3' }])),
          react: async () => {
            clock = elapsed;
            return react();
          },
          ...(logging
            ? {
                warn: (message: string) => {
                  lines.push(message);
                  clock += 10;
                  if (sink === 'throw') throw new Error(SECRET);
                },
              }
            : {}),
        });
        emitCaptureDiagnostics(screen);
        return { screen, lines, clock };
      };
      const silent = await run(false);
      const logged = await run(true);
      assert.deepEqual(outcome(logged.screen), outcome(silent.screen));
      assert.deepEqual(privacyView(logged.screen), privacyView(silent.screen));
      assert.equal(privacyView(logged.screen).canScreenshot, false);
      const sensitive = logged.lines.filter((line) => line.startsWith('sensitive-pixels'));
      if (elapsed < 22_000) {
        assert.equal(logged.screen.nativeCaptureCauses, undefined);
        assert.equal(logged.lines.length, 2, sink);
        assert.equal(sensitive.length, 1);
        assert.equal(logged.clock, elapsed + 20);
      } else {
        assert.equal(logged.screen.coverage?.native, 'incomplete');
        assert.ok(logged.screen.nativeCaptureCauses?.includes('capture-over-budget'));
        assert.deepEqual(logged.lines, []);
        assert.equal(logged.clock, elapsed);
      }
    }
  }
});

test('walker admission precedes both passive diagnostics at the acquisition budget edge', async () => {
  for (const scenario of [
    'admitted',
    'capture-expired',
    'admission-expired',
    'incomplete',
    'presence-refused',
  ] as const) {
    for (const sink of ['slow', 'throw'] as const) {
      const run = async (logging: boolean) => {
        let clock = 0;
        const lines: string[] = [];
        let captured: Screen | undefined;
        const source = nativeCapture();
        const native = {
          ...source,
          truncated: scenario === 'incomplete',
          snapshotVerdict: { ...source.snapshotVerdict, nodeCount: 3 },
          nodes: [
            ...source.nodes,
            {
              ...source.nodes[1],
              ref: '@pager',
              index: 2,
              type: 'ScrollView',
              identifier: undefined,
              label: undefined,
              value: 'page 1 of 3',
              presence: { ...source.nodes[1].presence, nodeIndex: 2 },
            },
          ],
          presenceCapture: {
            ...source.presenceCapture,
            complete: scenario !== 'presence-refused',
          },
        };
        const walk = walker(
          [],
          scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.99 } })),
        );
        walk.deps.now = () => clock;
        walk.deps.captureScreen = async () => {
          captured = await captureScreen({
            appId: 'com.test',
            requirePrivateInputs: true,
            now: () => clock,
            native: async () => native,
            react: async () => {
              clock = scenario === 'capture-expired' ? 22_001 : 21_999;
              return react();
            },
            ...(logging
              ? {
                  warn: (message: string) => {
                    lines.push(message);
                    clock += 10;
                    if (sink === 'throw') throw new Error(SECRET);
                  },
                }
              : {}),
          });
          assert.deepEqual(lines, [], 'capture itself must not compute or emit diagnostics');
          if (scenario === 'admission-expired') clock += 1;
          return captured;
        };
        const plan = parsePlan(scenario === 'presence-refused' ? '✓ Save is visible' : '✓ "Save"');
        assert.ok(plan.blocks);
        const result = await runPlan(plan.blocks, walk.deps);
        return { result, captured, lines, clock };
      };
      const silent = await run(false);
      const logged = await run(true);
      assert.equal(logged.result.verdict, silent.result.verdict);
      assert.deepEqual(logged.result.failure, silent.result.failure);
      assert.deepEqual(
        logged.result.verdict === 'REFUSED'
          ? [logged.result.code, logged.result.message]
          : undefined,
        silent.result.verdict === 'REFUSED'
          ? [silent.result.code, silent.result.message]
          : undefined,
      );
      assert.deepEqual(
        logged.captured && outcome(logged.captured),
        silent.captured && outcome(silent.captured),
      );
      if (scenario === 'admitted') {
        assert.equal(logged.result.verdict, 'PASS');
        assert.equal(logged.captured?.nativeCaptureCauses, undefined);
        assert.equal(logged.lines.length, 2);
        assert.ok(logged.lines[0].startsWith('viewport-diagnostic '));
        assert.ok(logged.lines[1].startsWith('sensitive-pixels '));
        assert.equal(logged.clock, 22_019);
        emitCaptureDiagnostics(logged.captured!);
        assert.equal(logged.lines.length, 2, 'the same screen emits only once');
      } else {
        assert.notEqual(logged.result.verdict, 'PASS', scenario);
        assert.deepEqual(logged.lines, [], scenario);
      }
    }
  }
});

test('the full sink line stays within 512 UTF-8 bytes and trims whole keys deterministically', () => {
  assert.equal(Buffer.byteLength(SINK_PREFIX, 'utf8'), 12);
  const allowed = [
    'Application',
    'Window',
    'Other',
    'Group',
    'StaticText',
    'Button',
    'Link',
    'Image',
    'Icon',
    'Cell',
    'Table',
    'CollectionView',
    'ScrollView',
    'TextField',
    'SecureTextField',
    'SearchField',
    'TextView',
    'Switch',
    'Toggle',
    'Slider',
    'Stepper',
    'Picker',
    'PickerWheel',
    'DatePicker',
    'SegmentedControl',
    'PageIndicator',
    'ProgressIndicator',
    'ActivityIndicator',
    'NavigationBar',
    'TabBar',
    'Toolbar',
    'Keyboard',
    'Key',
    'WebView',
    'Map',
    'Alert',
    'Sheet',
  ];
  const unknown = Array.from({ length: 50 }, (_, i) => [`Custom${i}${SECRET}`, 9_999_999]);
  const max = Number.MAX_SAFE_INTEGER;
  const histogram = [...allowed.map((type) => [type, 9_999_999]), ...unknown] as [string, number][];
  const message = formatSensitivePixels(max, max, max, histogram);
  assert.ok(Buffer.byteLength(`${SINK_PREFIX}${message}\n`, 'utf8') <= 512, message);
  assert.equal(message.includes(SECRET) || message.includes('Custom'), false);
  const line = parse(message);
  assert.deepEqual([line.r1, line.secure, line.r3], [max, max, max]);
  assert.deepEqual(line.types[0], ['Other', 9_999_999 * 51], 'unknown types collapse into Other');
  assert.equal(line.omittedTypes, allowed.length - line.types.length, 'one per omitted key');
  assert.ok(line.omittedTypes > 0);
  const sorted = allowed.filter((type) => type !== 'Other').sort();
  assert.deepEqual(
    line.types.slice(1).map(([type]: [string]) => type),
    sorted.slice(0, line.types.length - 1),
  );
  assert.equal(formatSensitivePixels(max, max, max, histogram), message);

  const longest = [...allowed].sort((a, b) => b.length - a.length);
  const wide = formatSensitivePixels(
    max,
    max,
    max,
    longest.map((type) => [type, max]),
  );
  assert.ok(Buffer.byteLength(`${SINK_PREFIX}${wide}\n`, 'utf8') <= 512, wide);
  assert.equal(parse(wide).omittedTypes + parse(wide).types.length, allowed.length);

  const empty = formatSensitivePixels(max, max, max, []);
  assert.ok(Buffer.byteLength(`${SINK_PREFIX}${empty}\n`, 'utf8') <= 512);
  assert.deepEqual(parse(empty).types, []);
});

test('no warning carries a value, label, identifier, testID, placeholder or raw native type', async () => {
  const field = `${SECRET}-field`;
  const run = await observe(
    [
      { type: 'SECRET-TYPE', value: SECRET, label: SECRET, identifier: `${SECRET}-custom` },
      { type: 'TextField', value: SECRET, label: SECRET, identifier: field },
      { type: 'SecureTextField', value: SECRET, label: SECRET, identifier: `${SECRET}-pin` },
      { type: 'StaticText', label: SECRET, identifier: `${SECRET}-text` },
    ],
    {
      react: async () => ({
        ...(await react()),
        interactive: [
          {
            role: 'textbox',
            testID: field,
            label: SECRET,
            placeholder: SECRET,
            value: SECRET,
            capabilities: { press: false, fill: true },
          },
        ],
      }),
    },
  );
  const screen = run.screen as Screen;
  assert.ok(screen.elements.some((element) => element.placeholder === SECRET));
  assert.ok(screen.elements.some((element) => element.testID === field));
  assert.equal(run.canScreenshot, false);
  assert.ok(run.lines.length >= 2);
  for (const line of run.lines) {
    assert.equal(line.includes(SECRET), false, line);
    assert.equal(line.includes('SECRET-TYPE'), false, line);
  }
  assert.equal(run.line.secure, 1);
  for (const [type] of run.line.types)
    assert.ok(['Other', 'TextField', 'SecureTextField'].includes(type));
});

test('a walk over a sensitive screen persists the same ledger and screenshots with or without the line', async () => {
  const source = nativeCapture();
  const observed = source.nodes[1];
  const native = {
    ...source,
    snapshotVerdict: { ...source.snapshotVerdict, nodeCount: 3 },
    nodes: [
      source.nodes[0],
      {
        ...observed,
        ref: '@pager',
        type: 'ScrollView',
        identifier: undefined,
        label: undefined,
        value: 'page 1 of 3',
      },
      {
        ...observed,
        ref: '@welcome',
        index: 2,
        type: 'StaticText',
        identifier: undefined,
        label: 'Welcome',
        presence: { ...observed.presence, nodeIndex: 2 },
      },
    ],
  };
  for (const [source, expected] of [
    ['✓ Welcome is visible', 'PASS'],
    ['✓ "Absent confirmation"', 'FAIL'],
  ]) {
    const walkWith = async (warn?: (message: string) => void) => {
      const judge = scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.99 } }));
      const walk = walker([], judge);
      const shots: string[] = [];
      walk.deps.captureScreen = () =>
        captureScreen({
          appId: 'com.test',
          requirePrivateInputs: true,
          native: async () => native,
          react,
          warn,
        });
      walk.deps.screenshot = async (name) => {
        shots.push(name);
        return name;
      };
      const plan = parsePlan(source);
      assert.ok(plan.blocks);
      const result = await runPlan(plan.blocks, walk.deps);
      return outcome({ result, rows: walk.rows, actions: walk.actions, shots });
    };
    const lines: string[] = [];
    const logged = await walkWith((message) => lines.push(message));
    assert.deepEqual(logged, await walkWith());
    assert.equal(logged.result.verdict, expected, JSON.stringify(logged.result));
    assert.deepEqual(logged.shots, []);
    assert.deepEqual(
      lines
        .filter((line) => line.startsWith('sensitive-pixels'))
        .map(parse)
        .map(legacy)[0],
      {
        v: 1,
        r1: 1,
        secure: 0,
        r3: 1,
        types: [['ScrollView', 1]],
        omittedTypes: 0,
      },
    );
  }
});

// Accepted residual: an app element mimicking this label with a bare percent shows it.
test('iOS system scroll-bar indicators with a percent value do not withhold pixels', async () => {
  for (const specs of [
    [{ type: 'Other', label: 'Vertical scroll bar, 1 page', value: '0%' }, text('Welcome')],
    ...['5\u00a0%', '5\u202f%', '50 %', '100\u00a0%', '12.5%', '0,5%', '12.5\u202f%'].map(
      (value) => [{ type: 'Other', label: 'Vertical scroll bar, 1 page', value }, text('Welcome')],
    ),
    [
      { type: 'Other', label: 'Vertical scroll bar, 3 pages', value: '0%' },
      { type: 'Other', label: ' Horizontal scroll bar, 2 pages ', value: ' 0% ' },
      { type: 'Other', label: 'vertical scroll bar', value: '100%' },
      text('Home'),
    ],
  ] as Spec[][]) {
    const run = await observe(specs);
    assert.equal(run.canScreenshot, true, JSON.stringify(specs));
    assert.equal(run.count, 0);
    assert.equal(sensitivePixelsReasons(run.screen as Screen, run.nodes), undefined);
    const bar = (run.screen as Screen).elements.find((e) => e.label?.includes('scroll bar'));
    assert.ok(bar?.label, 'the system label is kept');
    assert.equal(bar.value, undefined);
  }
});

test('anything short of an exact system scroll-bar Other with a bare percent stays withheld', async () => {
  for (const spec of [
    { type: 'Other', label: 'Vertical scroll bar, 1 page', value: SECRET },
    { type: 'Other', label: 'Progress', value: '42%' },
    { type: 'Other', value: '42%' },
    { type: 'Other', value: '42 kg' },
    { type: 'Other', label: 'Vertical scroll bar, 2 pages done', value: '42%' },
    { type: 'Other', label: 'My vertical scroll bar', value: '42%' },
    { type: 'Other', label: 'Diagonal scroll bar', value: '42%' },
    { type: 'Other', label: 'Vertical scroll bar', value: '42  %' },
    { type: 'Other', label: 'Vertical scroll bar', value: '50 %x' },
    { type: 'Other', label: 'Vertical scroll bar', value: 'abc %' },
    { type: 'Other', label: 'Vertical scroll bar', value: '5x%' },
    { type: 'Other', label: 'Vertical scroll bar', value: '1000\u00a0%' },
    { type: 'Other', label: 'Vertical scroll bar', value: '4\u00a02%' },
    { type: 'Other', label: 'Vertical scroll bar', value: '42.55%' },
    { type: 'Other', label: 'Vertical scroll bar', value: '42.%' },
    { type: 'Other', label: 'Vertical scroll bar', value: '.5%' },
    { type: 'Other', label: 'Vertical scroll bar', value: '1000.5%' },
    { type: 'Other', label: 'Vertical scroll bar', value: '4.5.%' },
    { type: 'Other', label: 'Vertical scroll bar', value: '%42' },
    { type: 'Other', label: 'Vertical scroll bar', value: '1000%' },
    { type: 'Element(35)', label: 'Vertical scroll bar, 1 page', value: '50%' },
    { type: 'Slider', label: 'Vertical scroll bar, 1 page', value: '50%' },
    { type: 'TextField', label: 'Vertical scroll bar, 1 page', value: '50%' },
  ] as Spec[]) {
    const run = await observe([spec, text('Welcome')]);
    assert.equal(run.canScreenshot, false, JSON.stringify(spec));
    assert.equal(run.count, 1, JSON.stringify(spec));
  }
});

test('a scroll-bar indicator beside a secure field or a real input leaves them withheld', async () => {
  const bar: Spec = { type: 'Other', label: 'Vertical scroll bar, 1 page', value: '0%' };
  const secure = await observe([bar, { type: 'SecureTextField' }]);
  assert.equal(secure.canScreenshot, false);
  assert.deepEqual(legacy(secure.line), {
    v: 1,
    r1: 0,
    secure: 1,
    r3: 0,
    types: [],
    omittedTypes: 0,
  });
  const input = await observe([bar, { type: 'TextField', label: 'Email', value: 'a@b.test' }]);
  assert.equal(input.canScreenshot, false);
  assert.deepEqual(input.line.types, [['TextField', 1]]);
  assert.equal(input.line.r1, 1);
});

const shapesOf = async (specs: Spec[], options: Parameters<typeof capture>[1] = {}) =>
  (await observe(specs, options)).line?.shapes;

test('each carrier is described by a value-free shape', async () => {
  const bar = 'Vertical scroll bar, 1 page';
  const cases: [Spec, unknown[]][] = [
    [
      {
        type: 'Other',
        label: 'Weight',
        value: '0\u00a0%',
        rect: { x: 397, y: 9, width: 2.6, height: 779.4 },
      },
      ['Other', 'other', 'pct-loose', '2-3', 3, 779, 'Window', 0, 'native'],
    ],
    [
      { type: 'Other', label: 'Vertical Scroll Bar', value: '0' },
      ['Other', 'sb-exact', 'int', '1', 400, 800, 'Window', 0, 'native'],
    ],
    [
      { type: 'Other', label: 'Progress', value: '12.5%' },
      ['Other', 'other', 'pct-loose', '4-8', 400, 800, 'Window', 0, 'native'],
    ],
    [
      { type: 'Other', label: 'Scrollbar', value: '0.5' },
      ['Other', 'sb-loose', 'dec', '2-3', 400, 800, 'Window', 0, 'native'],
    ],
    [
      { type: 'Other', label: 'Weight', value: '42 kg', identifier: 'weight' },
      ['Other', 'other', 'text', '4-8', 400, 800, 'Window', 1, 'native'],
    ],
    [
      { type: 'Element(47)', label: bar, value: '0%' },
      ['Element(47)', 'sb-exact', 'pct', '2-3', 400, 800, 'Window', 0, 'native'],
    ],
    [
      { type: 'Element(35)', value: '50%' },
      ['Element(35)', 'none', 'pct', '2-3', 400, 800, 'Window', 0, 'native'],
    ],
    [
      { type: 'com.vendor.Gauge', value: 'abcdefghijk' },
      ['unlisted', 'none', 'text', '9+', 400, 800, 'Window', 0, 'native'],
    ],
  ];
  for (const [spec, shape] of cases)
    assert.deepEqual(await shapesOf([spec, text('Welcome')]), [shape], JSON.stringify(spec));
});

test('a carrier shape names its parent type and whether React supplied the value', async () => {
  for (const [parent, code] of [
    ['ScrollView', 'ScrollView'],
    ['Element(99)', 'Element(99)'],
    ['SECRET-PARENT', 'unlisted'],
  ])
    assert.deepEqual(
      await shapesOf([{ type: parent }, { type: 'Other', parentIndex: 2, value: '0' }]),
      [['Other', 'none', 'int', '1', 400, 800, code, 0, 'native']],
    );

  const toggle = await shapesOf([{ type: 'Other', identifier: 'toggle', value: '1' }], {
    react: async () => ({
      ...(await react()),
      interactive: [{ role: 'switch', testID: 'toggle', value: true }],
    }),
  });
  assert.deepEqual(toggle, [['Other', 'none', 'text', '2-3', 400, 800, 'Window', 1, 'react']]);
});

test('shapes never carry label, value or type text', async () => {
  const run = await observe([
    { type: 'Other', label: `Vertical scroll bar ${SECRET}`, value: `${SECRET}%` },
    { type: 'Element(47)', label: SECRET, value: `12${SECRET}` },
    { type: `${SECRET}-TYPE`, label: SECRET, value: SECRET, identifier: SECRET },
  ]);
  assert.equal(run.line.shapes.length, 3);
  for (const line of run.lines) assert.equal(line.includes(SECRET), false, line);
});

test('at most four shapes are listed and the rest are counted', async () => {
  const run = await observe(
    Array.from({ length: 10 }, (_, i) => ({ type: 'Element(47)', value: `value-${i}` })),
  );
  assert.equal(run.line.shapes.length, 4);
  assert.equal(run.line.omittedShapes, 6);
  for (const line of run.lines.filter((line) => line.startsWith('sensitive-pixels ')))
    assert.ok(Buffer.byteLength(`${SINK_PREFIX}${line}\n`, 'utf8') <= 512, line);
});

test('the byte cap drops shapes before any type key', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const wide = [
    'Element(999)',
    'sb-loose',
    'pct-loose',
    '2-3',
    max,
    max,
    'Element(999)',
    1,
    'native',
  ];
  const shapes = [wide, wide, wide, wide];
  const few: [string, number][] = [
    ['Other', max],
    ['ScrollView', max],
  ];
  const kept = parse(formatSensitivePixels(max, max, max, few, shapes));
  assert.deepEqual(kept.types, few);
  assert.equal(kept.omittedTypes, 0);
  assert.ok(kept.shapes.length >= 1 && kept.shapes.length < 4, JSON.stringify(kept));
  assert.equal(kept.shapes.length + kept.omittedShapes, 4);

  const many = ['Application', 'Window', 'Group', 'StaticText', 'Button', 'Link', 'Image', 'Icon']
    .concat(['Cell', 'Table', 'CollectionView', 'TextField', 'SecureTextField', 'SearchField'])
    .map((type) => [type, max] as [string, number]);
  const message = formatSensitivePixels(max, max, max, many, shapes);
  assert.ok(Buffer.byteLength(`${SINK_PREFIX}${message}\n`, 'utf8') <= 512, message);
  const line = parse(message);
  assert.deepEqual([line.shapes, line.omittedShapes], [[], 4]);
  assert.ok(line.omittedTypes > 0);
});
