import { renderReason } from '../../../dist/qa/untrusted.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, parseStep } from '../../../dist/qa/plan.js';
import type { Block } from '../../../dist/qa/plan.js';
import { serializeBlock, type StoredBlock } from '../../../dist/qa/blocks.js';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import {
  decideTarget,
  judgeCheck,
  prepareTarget,
  visibleSelector,
} from '../../../dist/qa/resolve.js';
import { literalEvidence } from '../../../dist/qa/evidence.js';
import { replayBlock, runPlan, walkBlock } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import type { TargetMissDiagnostic } from '../../../dist/qa/target-miss.js';

const app = { x: 0, y: 0, width: 402, height: 874 };
const complete = { native: 'complete', react: 'complete' } as const;

type Spec = {
  type: string;
  parent?: number;
  rect?: NativeNode['rect'];
  label?: string;
  hittable?: boolean;
  identifier?: string;
};

function tree(specs: Spec[]): NativeNode[] {
  return specs.map((spec, index) => ({
    ref: `@e${index}`,
    index,
    type: spec.type,
    enabled: true,
    hittable: spec.hittable ?? false,
    ...(spec.parent === undefined ? {} : { parentIndex: spec.parent }),
    ...(spec.rect ? { rect: spec.rect } : {}),
    ...(spec.label === undefined ? {} : { label: spec.label }),
    ...(spec.identifier === undefined ? {} : { identifier: spec.identifier }),
  }));
}

const observed = (specs: Spec[], coverage: Screen['coverage'] = complete): Screen =>
  join(tree(specs), [], 'app', coverage);
const check = (screen: Screen, text: string) =>
  judgeCheck({ kind: 'check', text, literal: true }, screen);
const at = (x: number, y: number, width = 300, height = 30) => ({ x, y, width, height });

// Application, app Window, a pager strip, page titles at x = 16 / 418 / 820 (fixtures A-F).
function pager(options: { window?: boolean; pagesUnder?: 'strip' | 'application' } = {}): Screen {
  const specs: Spec[] = [{ type: 'Application', rect: app, label: 'Test App', hittable: true }];
  const windowIndex = options.window === false ? 0 : 1;
  if (options.window !== false) specs.push({ type: 'Window', parent: 0, rect: app });
  const strip = specs.length;
  specs.push({ type: 'Other', parent: windowIndex, rect: at(0, 100, 1206, 70) });
  ['Page one', 'Page two', 'Page three'].forEach((label, page) =>
    specs.push({
      type: 'StaticText',
      parent: options.pagesUnder === 'application' ? 0 : strip,
      rect: at(16 + page * 402, 120),
      label,
    }),
  );
  return observed(specs);
}

// The wizard after the keyboard moved to page 2: page 1 keeps a stale multiline input frame.
function k2(): Screen {
  return observed([
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Other', parent: 1, rect: at(-402, 180, 402, 600) },
    { type: 'TextView', parent: 2, rect: at(24, 20, 354, 100), label: 'Describe the issue' },
    { type: 'StaticText', parent: 2, rect: at(-378, 190, 120, 20), label: 'STEP 1 OF 3' },
    { type: 'StaticText', parent: 1, rect: at(16, 120), label: 'STEP 2 OF 3' },
  ]);
}

// K2 with the same placeholder text also painted on the current page.
function k2WithVisibleTwin(): Screen {
  return observed([
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Other', parent: 1, rect: at(-402, 180, 402, 600) },
    { type: 'TextView', parent: 2, rect: at(24, 20, 354, 100), label: 'Describe the issue' },
    { type: 'StaticText', parent: 1, rect: at(16, 400), label: 'Describe the issue' },
  ]);
}

// Home #1: a container left with a stale off-screen rect after a sheet closed; its rows are on screen.
function home1(type = 'Other', rect = at(0, 900, 402, 600)): Screen {
  return observed([
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type, parent: 1, rect },
    { type: 'StaticText', parent: 2, rect: at(16, 300, 370, 44), label: 'Order history' },
    { type: 'StaticText', parent: 2, rect: at(16, 350, 370, 44), label: 'Saved addresses' },
  ]);
}

// Company home: accessible rows whose labels merge their painted children, with no text descendants.
function companyHome(coverage: Screen['coverage'] = complete): Screen {
  return observed(
    [
      { type: 'Application', rect: app, label: 'Test App', hittable: true },
      { type: 'Window', parent: 0, rect: app },
      { type: 'ScrollView', parent: 1, rect: at(0, 100, 402, 700) },
      {
        type: 'Other',
        parent: 2,
        rect: at(0, 100, 402, 72),
        label: 'Item 2, Status 2',
        hittable: true,
      },
      {
        type: 'Other',
        parent: 2,
        rect: at(0, 180, 402, 72),
        label: 'Item 3, Status 3',
        hittable: true,
      },
      { type: 'Other', parent: 2, rect: at(16, 260, 120, 44), label: 'Reschedule', hittable: true },
      { type: 'Other', parent: 2, rect: at(350, 260, 44, 44), label: 'Close', hittable: true },
      { type: 'Image', parent: 6, rect: at(360, 270, 24, 24) },
      {
        type: 'Other',
        parent: 2,
        rect: at(0, 1200, 402, 72),
        label: 'Item 12, Status 12',
        hittable: true,
      },
      { type: 'Other', parent: 2, rect: at(0, 320, 402, 72), label: 'Decorative banner' },
      { type: 'Other', parent: 2, rect: at(0, 400, 402, 72), label: 'Card, Renew', hittable: true },
      { type: 'StaticText', parent: 10, rect: at(16, 410, 200, 20), label: 'Card' },
      {
        type: 'Other',
        parent: 2,
        rect: at(396, 100, 4, 700),
        label: 'Vertical scroll bar, 2 pages',
        hittable: true,
      },
    ],
    coverage,
  );
}

// A long list: rows past the fold are ordinary offscreen content, never contradictions.
function longList(): Screen {
  const specs: Spec[] = [
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'ScrollView', parent: 1, rect: at(0, 100, 402, 774) },
  ];
  for (let row = 1; row <= 30; row++)
    specs.push({ type: 'StaticText', parent: 2, rect: at(16, 60 + row * 50), label: `Row ${row}` });
  return observed(specs);
}

test('V1: consistent pager shapes keep their verdicts; the K2 stale input is unsure, never PASS', () => {
  for (const screen of [pager(), pager({ window: false }), pager({ pagesUnder: 'application' })]) {
    assert.equal(check(screen, 'Page one'), 'pass');
    assert.equal(check(screen, 'Page two'), 'fail');
    assert.equal(check(screen, 'Page three'), 'fail');
  }
  const wizard = k2();
  assert.equal(check(wizard, 'Describe the issue'), 'unsure');
  assert.equal(check(wizard, 'STEP 1 OF 3'), 'fail');
  assert.equal(check(wizard, 'STEP 2 OF 3'), 'pass');
  const input = wizard.elements.find((e) => e.label === 'Describe the issue')!;
  assert.equal(input.visibilityEvidence, 'unresolved');
  assert.equal(input.offscreen, true, 'press and fill targeting keep treating it as not shown');
});

test('K1: later pages chained to no Window stay FAIL through the Application clip', () => {
  const screen = observed([
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Other', parent: 0, rect: at(0, 100, 1206, 700) },
    { type: 'StaticText', parent: 1, rect: at(16, 120), label: 'First page' },
    { type: 'StaticText', parent: 3, rect: at(402, 120), label: 'Second page' },
    { type: 'StaticText', parent: 3, rect: at(804, 120), label: 'Third page' },
    { type: 'Keyboard', parent: 2, rect: at(0, 538, 402, 336) },
  ]);
  assert.equal(check(screen, 'First page'), 'pass');
  assert.equal(check(screen, 'Second page'), 'fail');
  assert.equal(check(screen, 'Third page'), 'fail');
});

test('V2: home #1 rows under a stale off-screen container PASS; only the container is unresolved', () => {
  const screen = home1();
  assert.equal(check(screen, 'Order history'), 'pass');
  assert.equal(check(screen, 'Saved addresses'), 'pass');
  assert.equal(check(screen, 'Payment methods'), 'fail');
  assert.deepEqual(
    screen.elements.map((e) => e.visibilityEvidence),
    ['visible', 'visible', 'unresolved', 'visible', 'visible'],
  );
});

test('V3: merged-label rows PASS from their accessibility label, with a sentinel FAIL', () => {
  const screen = companyHome();
  for (const text of ['Item 2', 'Status 3', 'Reschedule'])
    assert.deepEqual(
      literalEvidence(screen, text, 'contains'),
      { verdict: 'pass', label: true },
      text,
    );
  assert.equal(check(screen, 'Item 2'), 'pass');
  assert.equal(
    check(screen, 'Close'),
    'pass',
    'the accepted residual: an icon-only labelled control',
  );
  assert.equal(check(screen, 'Item 12'), 'fail', 'a merged row below the fold');
  assert.equal(check(screen, 'Nowhere to be found'), 'fail');
  assert.equal(check(screen, 'Decorative banner'), 'fail', 'not hittable');
  assert.equal(
    check(screen, 'Renew'),
    'fail',
    'a container with a text descendant contributes only that text',
  );
  assert.equal(check(screen, 'Card'), 'pass');
  assert.equal(check(screen, 'Test App'), 'fail', 'the Application is structural');
  assert.equal(check(screen, 'scroll bar'), 'fail', 'system scroll bars are not app text');
  assert.deepEqual(literalEvidence(screen, 'Card', 'contains'), { verdict: 'pass' });
  assert.ok(!screen.visibleText.includes('Reschedule'), 'painted text stays painted text only');
});

test('absence needs a complete native snapshot; otherwise a miss is unsure', () => {
  const partial = companyHome({ native: 'incomplete', react: 'complete' });
  assert.equal(check(partial, 'Item 2'), 'pass');
  assert.equal(check(partial, 'Nowhere to be found'), 'unsure');
  const fromCapture = {
    ...companyHome(),
    captureCoverage: complete,
    coverage: { native: 'unknown', react: 'unknown' },
  } as Screen;
  assert.equal(
    check(fromCapture, 'Nowhere to be found'),
    'fail',
    'literal checks read the snapshot coverage',
  );
});

test('V4: below-the-fold rows are offscreen, never unresolved', () => {
  const screen = longList();
  assert.equal(check(screen, 'Row 3'), 'pass');
  for (const row of [20, 25, 30]) assert.equal(check(screen, `Row ${row}`), 'fail');
  assert.equal(screen.elements.filter((e) => e.visibilityEvidence === 'unresolved').length, 0);
  assert.ok(screen.elements.some((e) => e.visibilityEvidence === 'offscreen'));
});

function blockOf(markdown: string): Block[] {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks;
}

const noJev = () => scriptedJudge(() => assert.fail('a literal target must never ask Jev'));

async function consumers(screen: Screen, text: string, exact: 'text' | 'id' = 'text') {
  const plan = (line: string) => `## QA\n\n### Literal\n1. ${line}\n`;
  const outcome = async (line: string) => {
    const f = walker([screen], noJev());
    const diagnostics: TargetMissDiagnostic[] = [];
    f.deps.targetMiss = (event) => diagnostics.push(event);
    const result = await runPlan(blockOf(plan(line)), f.deps);
    assert.notEqual(result.verdict, 'REFUSED', JSON.stringify(result));
    return {
      verdict: result.verdict,
      seen: 'failure' in result ? renderReason(result.failure?.seen ?? '', (text) => text) : '',
      reason: 'steps' in result ? result.steps.at(-1)?.reason : undefined,
      actions: f.actions,
      diagnostics,
    };
  };
  const [block] = blockOf(plan(`Wait for "${text}"`));
  const stored: StoredBlock = {
    header: { appId: 'com.example.app', plan: 'plan.md', planHash: 'x', platform: 'ios' },
    steps: [
      { raw: block.items[0].raw, kind: 'wait', selector: exact === 'id' ? { id: text } : { text } },
    ],
  };
  const f = walker([screen], noJev());
  const replay = await walkBlock(replayBlock(block, stored), f.deps, 0, [], undefined, undefined, {
    mode: 'replay',
  });
  return {
    wait: await outcome(`Wait for "${text}"`),
    scroll: await outcome(`Scroll down until "${text}"`),
    replay: {
      failed: replay.failure !== undefined,
      seen: renderReason(replay.failure?.seen ?? '', (text) => text),
      miss: replay.miss,
      line: block.items[0].line,
    },
  };
}

async function checkRow(screen: Screen, text: string) {
  const f = walker([screen], noJev());
  const result = await runPlan(blockOf(`## QA\n\n### Literal\n✓ "${text}"\n`), f.deps);
  assert.notEqual(result.verdict, 'REFUSED', JSON.stringify(result));
  return result as Extract<typeof result, { steps: unknown }>;
}

test('V5: check, wait, scroll-until and replay share one rule on the same screen', async (t) => {
  await t.test('pass', async () => {
    for (const [screen, text] of [
      [home1(), 'Order history'],
      [companyHome(), 'Reschedule'],
      [longList(), 'Row 3'],
    ] as const) {
      const row = await checkRow(screen, text);
      assert.equal(row.verdict, 'PASS', text);
      const c = await consumers(screen, text);
      assert.equal(c.wait.verdict, 'PASS', text);
      assert.equal(c.scroll.verdict, 'PASS', text);
      assert.deepEqual(c.scroll.actions, [], text);
      assert.equal(c.replay.failed, false, `${text}: ${c.replay.seen}`);
    }
  });
  await t.test('a label-source pass is annotated on the check row', async () => {
    const labelled = await checkRow(companyHome(), 'Item 2');
    assert.equal(labelled.verdict, 'PASS');
    assert.match(labelled.steps[0].reason ?? '', /matched an accessibility label/);
    const painted = await checkRow(home1(), 'Order history');
    assert.equal(painted.steps[0].reason, undefined);
  });
  await t.test('unsure is never a plain FAIL and never a PASS', async () => {
    const screen = k2();
    const row = await checkRow(screen, 'Describe the issue');
    assert.equal(row.verdict, 'FAIL');
    assert.match(
      renderReason(row.failure?.seen ?? '', (text) => text),
      /CHECK_UNSURE/,
    );
    assert.equal(row.failure?.kind, undefined);
    const c = await consumers(screen, 'Describe the issue');
    for (const consumer of [c.wait, c.scroll]) {
      assert.equal(consumer.verdict, 'FAIL');
      assert.match(consumer.seen, /VISIBILITY_UNSURE: "Describe the issue" stayed unresolved/);
      assert.doesNotMatch(consumer.seen, /target visibility:/);
      assert.equal(consumer.diagnostics.length, 1);
      assert.equal(consumer.diagnostics[0].reason, 'evidence-incomplete');
      assert.equal(consumer.diagnostics[0].truncated, false);
      assert.deepEqual(consumer.diagnostics[0].candidates, []);
    }
    assert.equal(c.replay.failed, true);
    assert.equal(c.replay.miss, undefined, 'an unresolved occurrence is not a missing selector');
    assert.match(c.replay.seen, /VISIBILITY_UNSURE: "Describe the issue" stayed unresolved/);
  });
  await t.test('fail', async () => {
    const screen = longList();
    const row = await checkRow(screen, 'Row 25');
    assert.match(
      renderReason(row.failure?.seen ?? '', (text) => text),
      /"Row 25" is not satisfied on screen/,
    );
    assert.equal(row.failure?.kind, 'step');
    const c = await consumers(screen, 'Row 25');
    assert.match(c.wait.seen, /"Row 25" did not appear within 15s; the screen did not change/);
    assert.match(c.scroll.seen, /did not come into view/);
    assert.equal(c.replay.miss, c.replay.line);
  });
});

test('a visible occurrence wins over the same text on an unresolved frame, for every consumer', async () => {
  const screen = k2WithVisibleTwin();
  assert.deepEqual(screen.unresolvedText, ['Describe the issue']);
  assert.equal(check(screen, 'Describe the issue'), 'pass');
  assert.equal((await checkRow(screen, 'Describe the issue')).verdict, 'PASS');
  const c = await consumers(screen, 'Describe the issue');
  assert.equal(c.wait.verdict, 'PASS');
  assert.equal(c.scroll.verdict, 'PASS');
  assert.equal(c.replay.failed, false, c.replay.seen);
});

test('an incomplete snapshot never turns a miss into a definite absence in any consumer', async () => {
  const partial = companyHome({ native: 'incomplete', react: 'complete' });
  const row = await checkRow(partial, 'Nowhere to be found');
  assert.match(
    renderReason(row.failure?.seen ?? '', (text) => text),
    /CHECK_UNSURE/,
  );
  assert.equal(row.failure?.kind, undefined);
  const c = await consumers(partial, 'Nowhere to be found');
  for (const consumer of [c.wait, c.scroll]) {
    assert.equal(consumer.verdict, 'FAIL');
    assert.match(consumer.seen, /SCREEN_EVIDENCE_INCOMPLETE: NATIVE_ACQUISITION_UNUSABLE/);
  }
  assert.equal(c.replay.miss, undefined);
  assert.match(c.replay.seen, /SCREEN_EVIDENCE_INCOMPLETE: NATIVE_ACQUISITION_UNUSABLE/);
});

test('excluded company labels never satisfy or persist any literal consumer', async () => {
  const screen = companyHome();
  for (const text of [
    'Test App',
    'Decorative banner',
    'Card, Renew',
    'Vertical scroll bar, 2 pages',
  ]) {
    assert.equal(check(screen, text), 'fail', text);
    assert.equal(visibleSelector({ quoted: text, phrase: text }, screen), undefined, text);
    assert.equal((await checkRow(screen, text)).verdict, 'FAIL', text);
    const c = await consumers(screen, text);
    assert.equal(c.wait.verdict, 'FAIL', text);
    assert.equal(c.scroll.verdict, 'FAIL', text);
    assert.equal(c.replay.miss, c.replay.line, text);
    assert.equal(c.replay.failed, true, text);
    assert.match(c.replay.seen, /REPLAY_SELECTOR/);
  }
  for (const text of ['Reschedule', 'Card'])
    assert.deepEqual(visibleSelector({ quoted: text, phrase: text }, screen), { text });
});

test('contradicted clipping containers preserve rows and unresolved inputs in every direction', async () => {
  for (const type of ['ScrollView', 'Table', 'CollectionView', 'Window']) {
    for (const rect of [
      at(-402, 100, 402, 600),
      at(402, 100, 402, 600),
      at(0, -600, 402, 600),
      at(0, 900, 402, 600),
    ]) {
      const screen = home1(type, rect);
      assert.equal(screen.elements[2].visibilityEvidence, 'unresolved', type);
      for (const text of ['Order history', 'Saved addresses']) {
        assert.equal(check(screen, text), 'pass', type);
        assert.equal((await checkRow(screen, text)).verdict, 'PASS', type);
        const c = await consumers(screen, text);
        assert.equal(c.wait.verdict, 'PASS', type);
        assert.equal(c.scroll.verdict, 'PASS', type);
        assert.deepEqual(c.scroll.actions, [], type);
        assert.equal(c.replay.failed, false, c.replay.seen);
      }
      for (const inputType of ['TextView', 'TextField', 'SecureTextField', 'SearchField']) {
        const input = observed([
          { type: 'Application', rect: app },
          { type: 'Window', parent: 0, rect: app },
          { type, parent: 1, rect },
          { type: inputType, parent: 2, rect: at(16, 300), label: 'Stale input' },
        ]);
        assert.equal(check(input, 'Stale input'), 'unsure', `${type}/${inputType}`);
        assert.equal(input.elements[3].offscreen, true);
      }
      const outside = observed([
        { type: 'Application', rect: app },
        { type: 'Window', parent: 0, rect: app },
        { type, parent: 1, rect },
        { type: 'StaticText', parent: 2, rect: at(16, 300), label: 'Current row' },
        { type: 'StaticText', parent: 2, rect: at(16, 1200), label: 'Later row' },
      ]);
      assert.equal(check(outside, 'Later row'), 'fail', type);
    }
    const trustedClip = observed([
      { type: 'Application', rect: app },
      { type: 'Window', parent: 0, rect: at(0, 100, 402, 200) },
      { type, parent: 1, rect: at(0, 900, 402, 600) },
      { type: 'StaticText', parent: 2, rect: at(16, 350), label: 'Outside window' },
    ]);
    assert.equal(check(trustedClip, 'Outside window'), 'fail', type);
  }
});

test('quoted testIDs retain identity evidence and ID-preferred persistence', async () => {
  const screen = companyHome();
  for (const [label, id] of [
    ['Test App', 'app-id'],
    ['Decorative banner', 'banner-id'],
  ]) {
    screen.elements.find((e) => e.label === label)!.testID = id;
    assert.equal(check(screen, label), 'fail');
    assert.equal(check(screen, id), 'fail');
    assert.deepEqual(visibleSelector({ quoted: id, phrase: id }, screen), { id });
    assert.equal(visibleSelector({ quoted: label, phrase: label }, screen), undefined);
    const c = await consumers(screen, id, 'id');
    assert.equal(c.wait.verdict, 'PASS');
    assert.equal(c.scroll.verdict, 'PASS');
    assert.deepEqual(c.scroll.actions, []);
    assert.equal(c.replay.failed, false, c.replay.seen);
  }
});

test('independent trusted clips exclude stale input witnesses before contradiction admission', async () => {
  for (const trusted of ['Window', 'ScrollView', 'Table', 'CollectionView']) {
    for (const type of ['Other', 'Window', 'ScrollView', 'Table', 'CollectionView']) {
      for (const inputType of ['TextView', 'TextField', 'SecureTextField', 'SearchField']) {
        for (const [clipRect, inputRect] of [
          [at(0, 100, 402, 200), at(16, 350)],
          [at(0, 400, 402, 200), at(16, 300)],
          [at(0, 100, 100, 600), at(150, 300, 100, 30)],
          [at(250, 100, 100, 600), at(16, 300, 100, 30)],
        ]) {
          const screen = observed([
            { type: 'Application', rect: app },
            { type: trusted, parent: 0, rect: clipRect },
            { type, parent: 1, rect: at(0, 900, 402, 600) },
            { type: inputType, parent: 2, rect: inputRect, label: 'Stale input' },
          ]);
          assert.equal(check(screen, 'Stale input'), 'fail', `${trusted}/${type}/${inputType}`);
          assert.equal(screen.elements[3].visibilityEvidence, 'offscreen');
          assert.equal(screen.elements[3].offscreen, true);
          assert.deepEqual(screen.unresolvedText ?? [], []);
        }
      }
    }
  }
  const screen = observed([
    { type: 'Application', rect: app },
    { type: 'Window', parent: 0, rect: at(0, 100, 402, 200) },
    { type: 'ScrollView', parent: 1, rect: at(0, 900, 402, 600) },
    { type: 'TextView', parent: 2, rect: at(16, 350), label: 'Stale input' },
  ]);
  assert.equal((await checkRow(screen, 'Stale input')).verdict, 'FAIL');
  const c = await consumers(screen, 'Stale input');
  assert.match(c.wait.seen, /"Stale input" did not appear within 15s; the screen did not change/);
  assert.match(c.scroll.seen, /did not come into view/);
  assert.equal(c.replay.miss, c.replay.line);
});

test('literal consumers reject zero-area frames and retain frameless text without changing press eligibility', async () => {
  for (const rect of [
    at(16, 120, 0, 0),
    at(16, 120, 0, 30),
    at(16, 120, 100, 0),
    at(16, 120, 100, 30),
    undefined,
  ]) {
    const screen = observed([
      { type: 'Application', rect: app },
      {
        type: 'StaticText',
        parent: 0,
        rect,
        label: 'Done',
        hittable: true,
      },
    ]);
    const positive = !rect || (rect.width > 0 && rect.height > 0);
    assert.equal(check(screen, 'Done'), positive ? 'pass' : 'fail');
    assert.deepEqual(screen.paintedText, positive ? ['Done'] : []);
    assert.equal(
      visibleSelector({ quoted: 'Done', phrase: 'Done' }, screen) !== undefined,
      positive,
    );
    const c = await consumers(screen, 'Done');
    assert.equal(c.wait.verdict, positive ? 'PASS' : 'FAIL');
    assert.equal(c.scroll.verdict, positive ? 'PASS' : 'FAIL');
    assert.equal(c.replay.failed, !positive);
    const step = parseStep('Press "Done"');
    assert.ok(step && !('refuse' in step));
    assert.ok('ref' in prepareTarget(step, screen));
  }
  for (const type of ['Button', 'Other', 'StaticText']) {
    const screen = observed([
      { type: 'Application', rect: app },
      { type, parent: 0, rect: at(16, 120, 0, 30), label: 'Done', hittable: true },
    ]);
    assert.equal(check(screen, 'Done'), 'fail', type);
    assert.deepEqual(screen.labelText ?? [], [], type);
  }
});

test('quoted and semantic targets scroll relative to every trusted clipping viewport', () => {
  for (const type of ['Window', 'ScrollView', 'Table', 'CollectionView']) {
    for (const [y, direction] of [
      [50, 'up'],
      [350, 'down'],
      [110, undefined],
    ] as const) {
      const nodes = tree([
        { type: 'Application', rect: app },
        { type, parent: 0, rect: at(0, 100, 402, 200) },
        { type: 'Button', parent: 1, rect: at(16, y), label: 'Earlier', hittable: true },
      ]);
      nodes[1].enabled = false;
      const screen = join(nodes, [], 'app', complete, undefined, {
        source: 'xcui-live',
        nodes: nodes.map((_, i) => ({
          status: i === 2 && !direction ? 'observed' : 'unknown',
          labelSource: 'direct',
        })),
      });
      const step = parseStep('Press "Earlier"');
      assert.ok(step && !('refuse' in step) && step.kind === 'press');
      const exact = prepareTarget(step, screen);
      const earlier = screen.elements[2];
      if (direction) assert.deepEqual(exact, { scroll: direction, element: earlier }, type);
      else assert.ok('ref' in exact, type);
      const semantic = prepareTarget({ ...step, target: { phrase: 'the earlier button' } }, screen);
      if (direction) {
        assert.deepEqual(
          semantic,
          { scroll: direction, element: earlier, origin: 'named-offscreen' },
          type,
        );
        continue;
      }
      assert.ok('question' in semantic, type);
      const index = semantic.shown.findIndex((e) => e.label === 'Earlier');
      assert.notEqual(index, -1);
      const choice = `e${index}`;
      const chosen = decideTarget(semantic, {
        type: 'choice',
        choice,
        confidence: 1,
        probabilities: { [choice]: 1, none: 0 },
      });
      assert.ok('ref' in chosen, type);
    }
  }
});

test('nested clips and absent clips retain the correct scroll boundary', () => {
  const step = parseStep('Press "Earlier"');
  assert.ok(step && !('refuse' in step));
  for (const [specs, direction] of [
    [
      [
        { type: 'Application', rect: app },
        { type: 'Window', parent: 0, rect: at(0, 100, 402, 400) },
        { type: 'ScrollView', parent: 1, rect: at(0, 200, 402, 200) },
        { type: 'Button', parent: 2, rect: at(16, 150), label: 'Earlier' },
      ],
      'up',
    ],
    [[{ type: 'Button', rect: at(16, -50), label: 'Earlier', hittable: true }], 'up'],
    [[{ type: 'Button', label: 'Earlier', hittable: false }], 'down'],
  ] as const) {
    const screen = observed([...specs]);
    if (screen.elements.length === 1) screen.elements[0].offscreen = true;
    assert.deepEqual(prepareTarget(step, screen), {
      scroll: direction,
      element: screen.elements.find((e) => e.label === 'Earlier'),
    });
  }
});

test('same-frame sibling text witnesses cannot become an ambiguous saved selector', async () => {
  for (const identifiers of [
    ['left', 'right'],
    [undefined, undefined],
    ['same', 'same'],
  ]) {
    const screen = observed([
      { type: 'Application', rect: app },
      { type: 'Window', parent: 0, rect: app },
      {
        type: 'StaticText',
        parent: 1,
        rect: at(16, 120),
        label: 'Done',
        identifier: identifiers[0],
      },
      {
        type: 'StaticText',
        parent: 1,
        rect: at(16, 120),
        label: 'Done',
        identifier: identifiers[1],
      },
    ]);
    assert.deepEqual(screen.paintedText, ['Done', 'Done']);
    assert.equal(check(screen, 'Done'), 'pass');
    assert.equal(visibleSelector({ quoted: 'Done', phrase: 'Done' }, screen), undefined);
    const [block] = blockOf('## QA\n\n### Literal\n1. Wait for "Done"\n');
    const f = walker([screen], noJev());
    const discovery = await runPlan([block], f.deps);
    assert.equal(discovery.verdict, 'PASS');
    assert.ok('steps' in discovery);
    assert.equal(discovery.steps[0].selector, undefined);
    const saved = serializeBlock(block, discovery.steps, {
      appId: 'com.example.app',
      platform: 'ios',
    });
    assert.ok('unsavable' in saved);
    const c = await consumers(screen, 'Done');
    assert.equal(c.wait.verdict, 'PASS');
    assert.equal(c.scroll.verdict, 'PASS');
    assert.equal(c.replay.failed, true);
    assert.match(c.replay.seen, /TARGET_AMBIGUOUS/);
    assert.deepEqual(f.actions, []);
  }
});

for (const [y, direction, opposite] of [
  [50, 'up', 'down'],
  [350, 'down', 'up'],
] as const) {
  test(`quoted scroll-until and ID replay move ${direction} relative to an inset clip`, async () => {
    const targetScreen = (y: number) =>
      observed([
        { type: 'Application', rect: app },
        { type: 'ScrollView', parent: 0, rect: at(0, 100, 402, 200) },
        {
          type: 'StaticText',
          parent: 1,
          rect: at(16, y),
          label: 'Destination',
          identifier: 'destination',
        },
      ]);
    const before = targetScreen(y);
    const after = targetScreen(150);
    const [block] = blockOf(`## QA\n\n### Scroll\n1. Scroll ${opposite} until "Destination"\n`);
    const f = walker([before, after], noJev());
    const result = await runPlan([block], f.deps);
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(f.actions, [`scroll ${direction}`]);
    assert.ok('steps' in result);
    assert.deepEqual(result.steps[0].selector, { id: 'destination' });
    const stored: StoredBlock = {
      header: { appId: 'com.example.app', plan: 'plan.md', planHash: 'x', platform: 'ios' },
      steps: [
        {
          kind: 'scroll',
          raw: block.items[0].raw,
          direction: opposite,
          until: { id: 'destination' },
        },
      ],
    };
    const replay = walker([before, after], noJev());
    const replayResult = await walkBlock(
      replayBlock(block, stored),
      replay.deps,
      0,
      [],
      undefined,
      undefined,
      { mode: 'replay' },
    );
    assert.equal(replayResult.failure, undefined);
    assert.deepEqual(replay.actions, [`scroll ${direction}`]);
  });
}

// D5 keyboard form with the keyboard up: XCUI's Keyboard frame stops at 816, its chrome paints to 874.
function keyboardForm(keyboardVisible?: boolean): Screen {
  const screen = observed([
    { type: 'Application', rect: app, label: 'Test App', hittable: true },
    { type: 'Window', parent: 0, rect: app },
    { type: 'StaticText', parent: 1, rect: at(24, 300, 354, 18), label: 'Field 1' },
    { type: 'Button', parent: 1, rect: at(21, 545, 360, 38), label: 'Submit', hittable: true },
    { type: 'StaticText', parent: 1, rect: at(24, 640, 354, 18), label: 'Field 7' },
    { type: 'StaticText', parent: 1, rect: at(24, 855, 354, 18), label: 'Field 8' },
    { type: 'Window', parent: 0, rect: app },
    { type: 'Keyboard', parent: 6, rect: at(0, 583, 402, 233), hittable: true },
    { type: 'Button', parent: 7, rect: at(300, 780, 90, 30), label: 'return', hittable: true },
    { type: 'Button', parent: 6, rect: at(330, 830, 40, 30), label: 'Dictate', hittable: true },
  ]);
  if (keyboardVisible !== undefined) screen.keyboardVisible = keyboardVisible;
  return screen;
}

test('literal text under a visible keyboard is not on screen', () => {
  const screen = keyboardForm(true);
  assert.equal(check(screen, 'Field 7'), 'fail', 'inside the keyboard frame');
  assert.equal(
    check(screen, 'Field 8'),
    'fail',
    'below the frame, under the docked keyboard chrome',
  );
  assert.equal(check(screen, 'Field 1'), 'pass');
  assert.equal(check(screen, 'Submit'), 'pass', 'a sticky footer above the keyboard stays visible');
  assert.equal(check(screen, 'return'), 'pass', 'the keyboard paints its own keys');
  assert.equal(check(screen, 'Dictate'), 'pass', 'and the chrome in its own window');
  assert.ok(screen.visibleText.includes('Field 8'), 'privacy and history keep the full text');
});

test('a keyboard reported hidden keeps literal text visible', () => {
  assert.equal(check(keyboardForm(false), 'Field 8'), 'pass');
});

// Android: React Native exposes header-role text as android.view.View and reports the heading fact.
const display = { x: 0, y: 0, width: 1080, height: 2400 };
function androidScreen(leaf: Partial<NativeNode>): Screen {
  return join(
    [
      { ref: '@e0', index: 0, type: 'Application', rect: display, enabled: true },
      { ref: '@e1', index: 1, parentIndex: 0, type: 'Window', rect: display, enabled: true },
      {
        ref: '@e2',
        index: 2,
        parentIndex: 1,
        type: 'android.widget.TextView',
        label: 'Focused tab: one',
        rect: { x: 16, y: 200, width: 600, height: 60 },
        enabled: true,
        visibleToUser: true,
      },
      {
        ref: '@e3',
        index: 3,
        parentIndex: 1,
        type: 'android.view.View',
        label: 'Capture list one',
        identifier: 'qa-capture-heading-one',
        rect: { x: 16, y: 300, width: 600, height: 80 },
        enabled: true,
        visibleToUser: true,
        ...leaf,
      },
    ],
    [],
    'app',
    complete,
  );
}

test('an Android heading reported by the runner is literal text', async () => {
  const screen = androidScreen({ heading: true });
  assert.equal(screen.elements[3].kind, 'text');
  assert.ok(screen.visibleText.includes('Capture list one'));
  assert.deepEqual(literalEvidence(screen, 'Capture list one', 'contains'), { verdict: 'pass' });
  const row = await checkRow(screen, 'Capture list one');
  assert.equal(row.verdict, 'PASS');
  assert.equal(row.steps[0].reason, undefined);
});

test('an Android View without the heading fact stays out of literal text and names the near miss', async () => {
  const screen = androidScreen({});
  assert.equal(screen.elements[3].kind, 'other');
  assert.equal(screen.visibleText.includes('Capture list one'), false);
  assert.deepEqual(literalEvidence(screen, 'Capture list one', 'contains'), {
    verdict: 'fail',
    nearMiss: 'not-literal-kind',
  });
  const row = await checkRow(screen, 'Capture list one');
  assert.equal(row.verdict, 'FAIL');
  assert.equal(
    row.steps[0].reason,
    '"Capture list one" is not satisfied on screen (not-literal-kind: a node with this text exists but is not counted as literal text)',
  );
});

test('a heading fact never re-kinds a typed node', () => {
  const screen = androidScreen({ type: 'android.widget.Button', heading: true });
  assert.equal(screen.elements[3].kind, 'button');
});

test('a literal on a node not visible to the user names the near miss', async () => {
  const hidden = { type: 'android.widget.TextView', visibleToUser: false };
  const screen = androidScreen(hidden);
  assert.deepEqual(literalEvidence(screen, 'list one', 'contains'), {
    verdict: 'fail',
    nearMiss: 'not-visible',
  });
  const row = await checkRow(screen, 'list one');
  assert.equal(
    row.steps[0].reason,
    '"list one" is not satisfied on screen (not-visible: a node with this text exists but is reported not visible or is outside the viewport)',
  );
  const below = androidScreen({
    type: 'android.widget.TextView',
    rect: { x: 16, y: 2600, width: 600, height: 80 },
  });
  assert.equal(literalEvidence(below, 'Capture list one', 'contains').nearMiss, 'not-visible');
});

test('the near miss names the fact that kept a node out, whatever the tree order', () => {
  const nodes = (hidden: 'text' | 'view'): NativeNode[] => [
    { ref: '@e0', index: 0, type: 'Application', rect: display, label: 'Card one' },
    { ref: '@e1', index: 1, parentIndex: 0, type: 'Window', rect: display },
    {
      ref: '@e2',
      index: 2,
      parentIndex: 1,
      type: hidden === 'text' ? 'android.widget.TextView' : 'android.view.View',
      label: 'Card one',
      rect: { x: 16, y: 300, width: 600, height: 80 },
      visibleToUser: false,
    },
  ];
  const text = join(nodes('text'), [], 'app', complete);
  assert.equal(literalEvidence(text, 'Card one', 'contains').nearMiss, 'not-visible');
  const view = join(nodes('view'), [], 'app', complete);
  assert.equal(literalEvidence(view, 'Card one', 'contains').nearMiss, 'not-literal-kind');
  const [root, ...rest] = nodes('view');
  const onlyHidden = join([{ ...root, label: undefined }, ...rest], [], 'app', complete);
  assert.equal(literalEvidence(onlyHidden, 'Card one', 'contains').nearMiss, 'not-visible');
});

test('a plain miss or an unsure literal carries no near miss', async () => {
  const screen = androidScreen({ heading: true });
  assert.deepEqual(literalEvidence(screen, 'Capture list two', 'contains'), { verdict: 'fail' });
  const row = await checkRow(screen, 'Capture list two');
  assert.equal(row.steps[0].reason, '"Capture list two" is not satisfied on screen');
  const partial = { ...androidScreen({}), coverage: { native: 'incomplete', react: 'complete' } };
  assert.deepEqual(literalEvidence(partial as Screen, 'Capture list one', 'contains'), {
    verdict: 'unsure',
  });
});
