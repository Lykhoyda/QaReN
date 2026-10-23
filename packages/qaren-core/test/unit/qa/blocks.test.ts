import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parsePlan, planTitle, slugify } from '../../../dist/qa/plan.js';
import type { Block } from '../../../dist/qa/plan.js';
import type { LedgerRow, Selector } from '../../../dist/qa/ledger.js';
import {
  loadBlock,
  readBlock,
  recipeMarkdown,
  serializeBlock,
  storedMatches,
  storedFits,
  writeBlock,
} from '../../../dist/qa/blocks.js';
import { compileFlow } from '../../../dist/flow/compile.js';
import { parseM7Header } from '../../../dist/domain/reusable-action.js';
import { ObservedPrivacy, type PrivateSet } from '../../../dist/qa/privacy.js';
import { loginBlock } from '../../../dist/qa/walker.js';

const secrets = (...values: string[]): PrivateSet => ({
  values: values.map((text) => ({ text, provenance: 'secret' })),
});

const literal = readFileSync(new URL('../../fixtures/plans/literal.md', import.meta.url), 'utf8');

function blockOf(markdown: string): Block {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks[0];
}

function passRows(block: Block, selectors: Record<number, Selector>): LedgerRow[] {
  return block.items.map((item) => ({
    block: block.slug,
    line: item.line,
    text: item.raw,
    attempt: 1,
    kind: item.kind === 'check' ? 'check' : 'step',
    resolvedBy: 'exact',
    t: 1,
    outcome: 'pass',
    ...(selectors[item.line] ? { selector: selectors[item.line] } : {}),
  }));
}

const ios = { appId: 'com.example.app', platform: 'ios' as const };

test('a block whose rows carry a React coverage gap is withheld even after a healthy retry', () => {
  const block = blockOf('### Confirm\n1. Tap "Save"');
  const healthy = passRows(block, { [block.items[0].line]: { id: 'save' } });
  for (const reactCoverage of ['unknown', 'incomplete'] as const) {
    const degraded = { ...healthy[0], outcome: 'retry' as const, reactCoverage };
    assert.deepEqual(serializeBlock(block, [degraded, ...healthy], ios), {
      unsavable: `line ${block.items[0].line}: React coverage was ${reactCoverage}`,
    });
  }
  assert.ok('yaml' in serializeBlock(block, healthy, ios));
});
const literalSelectors: Record<number, Selector> = {
  9: { id: 'onboarding-skip' },
  10: { id: 'onboarding-done' },
  11: { text: 'Welcome' },
  13: { id: 'tab-tasks' },
  14: { id: 'task-header' },
};

function serialized(block: Block, rows: LedgerRow[], meta = ios): string {
  const result = serializeBlock(block, rows, meta);
  assert.ok('yaml' in result, JSON.stringify(result));
  return result.yaml;
}

test('a saved block keeps its start screen as the first wait and matches only that plan', () => {
  const markdown = '### Continue\nstarts on: Profile\n1. Tap "Back"';
  const block = blockOf(markdown);
  const yaml = serialized(block, passRows(block, { 2: { text: 'Profile' }, 3: { id: 'back' } }));
  assert.match(
    yaml,
    /# starts on: Profile\n- extendedWaitUntil: \{ visible: \{ text: "Profile" \}, timeout: 15000 \}/,
  );
  const stored = readBlock(yaml);
  assert.ok(!('invalid' in stored));
  assert.equal(stored.steps[0].kind, 'wait');
  assert.equal(stored.steps[0].raw, 'starts on: Profile');
  assert.deepEqual(stored.steps[0].selector, { text: 'Profile' });
  assert.ok(storedMatches(block, stored));
  assert.ok(!storedMatches(blockOf(markdown.replace('starts on: Profile\n', '')), stored));
  const oldBlock = blockOf(markdown.replace('starts on: Profile\n', ''));
  const oldStored = readBlock(serialized(oldBlock, passRows(oldBlock, { 2: { id: 'back' } })));
  assert.ok(!('invalid' in oldStored));
  assert.ok(!storedMatches(block, oldStored));
});

test('serialization withholds protected semantic values before YAML escaping', () => {
  for (const value of ['"quoted"', 'line\nbreak', '\\escaped', '7']) {
    const block = blockOf('## QA\n\n### Confirm\n✓ "Saved"\n');
    const check = block.items[0];
    assert.equal(check.kind, 'check');
    if (check.kind === 'check') check.text = value;
    assert.deepEqual(serializeBlock(block, passRows(block, {}), ios, secrets(value)), {
      unsavable: 'contains a protected plan-typed value',
    });
    assert.ok('yaml' in serializeBlock(block, passRows(block, {}), ios));
  }
});

test('serialization preserves unrelated fragments in metadata, plan text and selectors', () => {
  for (const field of ['appId', 'slug', 'title', 'planHash', 'raw', 'text', 'id', 'label']) {
    for (const [secret, fragment] of [
      ['existing-secret', 'secr'],
      ['1234', '2 3'],
    ]) {
      const block = blockOf('## QA\n\n### Confirm\n1. Tap "Save"\n✓ "Saved"\n');
      const meta = { ...ios };
      const rows = passRows(block, { [block.items[0].line]: { id: 'save-button' } });
      if (field === 'appId') meta.appId = fragment;
      else if (field === 'slug' || field === 'title' || field === 'planHash')
        block[field] = fragment;
      else if (field === 'raw') block.items[0].raw = fragment;
      else if (field === 'text') {
        const check = block.items[1];
        assert.equal(check.kind, 'check');
        if (check.kind === 'check') check.text = fragment;
      } else rows[0].selector = field === 'id' ? { id: fragment } : { text: fragment };
      if (field === 'slug') rows.forEach((row) => (row.block = block.slug));
      const before = structuredClone({ block, rows, meta });
      assert.ok(
        'yaml' in serializeBlock(block, rows, meta, secrets(secret)),
        `${field}: ${secret}`,
      );
      assert.deepEqual({ block, rows, meta }, before);
      assert.ok('yaml' in serializeBlock(block, rows, meta), `${field}: ${secret}`);
    }
  }
});

test('serialization admission checks the final emitted YAML', () => {
  const block = blockOf('## QA\n\n### Confirm\n1. Wait for "Saved" to appear\n');
  const rows = passRows(block, { [block.items[0].line]: { text: 'Saved' } });
  assert.deepEqual(serializeBlock(block, rows, ios, secrets('15000')), {
    unsavable: 'contains a protected plan-typed value',
  });
  assert.ok('yaml' in serializeBlock(block, rows, ios));
});

test('serialization checks embedded fragments in values without rejecting generated syntax', () => {
  const privacy = new ObservedPrivacy(['hunter-canary-77']);
  privacy.concealFallback('hunter-canary-77', true);
  privacy.didFill('hunter-canary-77');
  const block = blockOf('### Confirm\n1. Tap "Save"\n✓ "Ready"');
  const rows = passRows(block, { [block.items[0].line]: { id: 'save-button' } });
  const result = serializeBlock(block, rows, ios, privacy.privateSet());
  assert.ok('yaml' in result, JSON.stringify(result));
  const stored = readBlock(result.yaml);
  assert.ok(!('invalid' in stored));
  assert.deepEqual(stored.steps[0].selector, { id: 'save-button' });
  rows[0].selector = { id: 'xhunx' };
  assert.ok('unsavable' in serializeBlock(block, rows, ios, privacy.privateSet()));
});

test('serialization preserves isolated short fragments of long secrets', () => {
  const block = blockOf('## QA\n\n### is\n✓ "is"\n');
  assert.ok('yaml' in serializeBlock(block, passRows(block, {}), ios, secrets('existing-secret')));
});

test('serialization withholds filled-secret fragments in every saved content field', () => {
  for (const [secret, fragments] of [
    ['4815', ['4', '48', '81', '15', 'row-48']],
    ['48-15', ['4', '48', '81', '15', 'row-48']],
    ['p@s@word', ['p@s', 's@w', 'xs@wx']],
    ['hunter-canary-77', ['hun', 'hunter', 'canary', 'r-c', 'xhunx']],
  ] as const) {
    const privacy = new ObservedPrivacy([secret]);
    privacy.concealFallback(secret, true);
    privacy.didFill(secret);
    for (const fragment of fragments) {
      for (const field of ['appId', 'slug', 'title', 'raw', 'text', 'id', 'label']) {
        const block = blockOf('### Confirm\n1. Tap "Save"\n✓ "Ready"');
        const rows = passRows(block, { [block.items[0].line]: { id: 'save-button' } });
        const meta = { ...ios };
        if (field === 'appId') meta.appId = fragment;
        else if (field === 'slug' || field === 'title' || field === 'planHash')
          block[field] = fragment;
        else if (field === 'raw') block.items[0].raw = `1. Tap "${fragment}"`;
        else if (field === 'text') {
          const check = block.items[1];
          assert.equal(check.kind, 'check');
          if (check.kind === 'check') check.text = fragment;
        } else rows[0].selector = field === 'id' ? { id: fragment } : { text: fragment };
        if (field === 'slug') rows.forEach((row) => (row.block = block.slug));
        assert.deepEqual(
          serializeBlock(block, rows, meta, privacy.privateSet()),
          { unsavable: 'contains a protected plan-typed value' },
          `${field}: ${fragment}`,
        );
        assert.ok('yaml' in serializeBlock(block, rows, meta), `${field}: ${fragment}`);
      }
    }
  }
});

test('a derived planHash sharing digits with a filled code does not withhold an ordinary block', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('482916');
  privacy.didFill('482916');
  const block = blockOf(
    '### Back to the start\n1. Go back\n2. Wait for "Welcome" to appear\n✓ "0"',
  );
  const rows = passRows(block, { [block.items[1].line]: { text: 'Welcome' } });
  block.planHash = 'ab29cdef4891ab';
  const result = serializeBlock(block, rows, ios, privacy.privateSet());
  assert.ok('yaml' in result, JSON.stringify(result));
  assert.match(result.yaml, /# planHash: ab29cdef4891ab/);
  block.planHash = 'ab482916cd';
  assert.ok('unsavable' in serializeBlock(block, rows, ios, privacy.privateSet()));
  block.planHash = 'ab29cdef4891ab';
  for (const field of ['appId', 'slug', 'title', 'id', 'label', 'fill'] as const) {
    const copy = blockOf(
      '### Back to the start\n1. Go back\n2. Wait for "Welcome" to appear\n3. Fill "Code" with "x"\n',
    );
    copy.planHash = block.planHash;
    const meta = { ...ios };
    const copyRows = passRows(copy, {
      [copy.items[1].line]: { text: 'Welcome' },
      [copy.items[2].line]: { id: 'code-field' },
    });
    if (field === 'appId') meta.appId = 'app29';
    else if (field === 'slug' || field === 'title') copy[field] = 'step-29';
    else if (field === 'id') copyRows[1].selector = { id: 'row-29' };
    else if (field === 'label') copyRows[1].selector = { text: 'Row 29' };
    else {
      const fill = copy.items[2];
      if (fill.kind === 'fill') fill.text = '29';
    }
    if (field === 'slug') copyRows.forEach((row) => (row.block = copy.slug));
    assert.deepEqual(
      serializeBlock(copy, copyRows, meta, privacy.privateSet()),
      { unsavable: 'contains a protected plan-typed value' },
      field,
    );
  }
});

test('plan list numbers that are digits of a protected code do not withhold the block', () => {
  const block = blockOf(
    '## QA\n\n### Open the code screen\n1. Tap "qa-otp-entry"\n2. Fill "qa-otp-email" with "qa@example.test"\n3. Tap "qa-otp-continue"\n4. Wait for "Enter the code" to appear\n5. Tap "qa-otp-help"\n',
  );
  const selectors = Object.fromEntries(
    block.items.map((item) => [item.line, { text: item.kind === 'wait' ? 'Enter the code' : 'x' }]),
  );
  const result = serializeBlock(block, passRows(block, selectors), ios, secrets('12345'));
  assert.ok('yaml' in result, JSON.stringify(result));
  assert.match(result.yaml, /# 3\. Tap "qa-otp-continue"/);
});

test('literal.md round-trips: plan lines, planHash and selectors survive', () => {
  const block = blockOf(literal);
  const yaml = serialized(block, passRows(block, literalSelectors));
  assert.equal(
    yaml,
    [
      'appId: com.example.app',
      '---',
      '# id: onboarding-to-the-tasks-tab',
      '# intent: Onboarding to the tasks tab',
      '# status: active',
      '# appId: com.example.app',
      '# plan: onboarding-to-the-tasks-tab',
      `# planHash: ${block.planHash}`,
      '# platform: ios',
      '',
      '# 1. Tap "onboarding-skip"',
      '- tapOn: { id: "onboarding-skip" }',
      '# 2. Tap "onboarding-done"',
      '- tapOn: { id: "onboarding-done" }',
      '# 3. Wait for "Welcome" to appear',
      '- extendedWaitUntil: { visible: { text: "Welcome" }, timeout: 15000 }',
      '# ✓ "Welcome"',
      '- assertVisible: { text: "Welcome" }',
      '# 4. Tap "tab-tasks"',
      '- tapOn: { id: "tab-tasks" }',
      '# 5. Wait for "task-header" to appear',
      '- extendedWaitUntil: { visible: { id: "task-header" }, timeout: 15000 }',
      '# ✓ "Tasks ("',
      '- assertVisible: { text: "Tasks (" }',
      '',
    ].join('\n'),
  );
  const read = readBlock(yaml);
  assert.ok(!('invalid' in read), JSON.stringify(read));
  assert.deepEqual(read.header, {
    appId: 'com.example.app',
    plan: block.slug,
    planHash: block.planHash,
    platform: 'ios',
  });
  assert.deepEqual(
    read.steps.map((s) => s.raw),
    block.items.map((i) => i.raw),
  );
  assert.deepEqual(
    read.steps.map((s) => s.selector),
    [
      { id: 'onboarding-skip' },
      { id: 'onboarding-done' },
      { text: 'Welcome' },
      undefined,
      { id: 'tab-tasks' },
      { id: 'task-header' },
      undefined,
    ],
  );
  assert.ok(storedMatches(block, read));
});

test('every command form serializes canonically and reads back', () => {
  const block = blockOf(
    [
      '### Forms',
      '1. Tap "Login"',
      '2. Type "ada@example.com" into "email-input"',
      '3. Scroll down until "Footer"',
      '4. Scroll up until "Header"',
      '5. Scroll down',
      '6. Scroll up',
      '7. Wait for "Done" to appear',
      '8. Go back',
      '9. Accept the permission dialog',
      '10. Dismiss the alert',
      '✓ "Saved"',
      '✓ The summary lists one item',
    ].join('\n'),
  );
  const at = (n: number) => block.items[n - 1].line;
  const selectors = {
    [at(1)]: { text: 'Login' },
    [at(2)]: { id: 'email-input' },
    [at(3)]: { id: 'footer' },
    [at(4)]: { text: 'Header' },
    [at(7)]: { id: 'done' },
  };
  const rows = passRows(block, selectors);
  const android = serialized(block, rows, { appId: 'com.example.app', platform: 'android' });
  const body = android.split('\n').slice(10).join('\n');
  assert.equal(
    body,
    [
      '# 1. Tap "Login"',
      '- tapOn: { text: "Login" }',
      '# 2. Type "ada@example.com" into "email-input"',
      '- tapOn: { id: "email-input" }',
      '- inputText: "ada@example.com"',
      '# 3. Scroll down until "Footer"',
      '- scrollUntilVisible: { element: { id: "footer" }, direction: DOWN }',
      '# 4. Scroll up until "Header"',
      '- scrollUntilVisible: { element: { text: "Header" }, direction: UP }',
      '# 5. Scroll down',
      '- scroll',
      '# 6. Scroll up',
      '- swipe: { direction: DOWN }',
      '# 7. Wait for "Done" to appear',
      '- extendedWaitUntil: { visible: { id: "done" }, timeout: 15000 }',
      '# 8. Go back',
      '- back',
      '# 9. Accept the permission dialog',
      '# qaren: dialog accept',
      '# 10. Dismiss the alert',
      '# qaren: dialog dismiss',
      '# ✓ "Saved"',
      '- assertVisible: { text: "Saved" }',
      '# ✓ The summary lists one item',
      '',
    ].join('\n'),
  );
  const iosYaml = serialized(block, rows);
  assert.match(iosYaml, /# 8\. Go back\n# qaren: back\n/);
  for (const text of [android, iosYaml]) {
    const read = readBlock(text);
    assert.ok(!('invalid' in read), JSON.stringify(read));
    assert.ok(storedMatches(block, read));
    assert.deepEqual(read.steps[1], {
      raw: block.items[1].raw,
      kind: 'fill',
      selector: { id: 'email-input' },
      text: 'ada@example.com',
    });
    assert.deepEqual(
      read.steps.slice(2, 6).map((s) => [s.direction, s.until]),
      [
        ['down', { id: 'footer' }],
        ['up', { text: 'Header' }],
        ['down', undefined],
        ['up', undefined],
      ],
    );
    assert.deepEqual(
      read.steps.slice(8, 10).map((s) => s.action),
      ['accept', 'dismiss'],
    );
  }
});

test('the selector rule: a step without a stored identity makes the block unsavable', () => {
  const block = blockOf(literal);
  const { 10: _missing, ...rest } = literalSelectors;
  assert.deepEqual(serializeBlock(block, passRows(block, rest), ios), {
    unsavable: 'line 10: element has no testID or label',
  });
  const phraseWait = blockOf('### W\n1. Wait for the welcome heading to appear\n');
  assert.match(
    (serializeBlock(phraseWait, passRows(phraseWait, {}), ios) as { unsavable: string }).unsavable,
    /^line 2: the visible target has no testID or label/,
  );
});

test('only pass rows of the block and line supply a stored selector; the latest pass wins', () => {
  const block = blockOf('### A\n1. Tap "Go"\n2. Tap "Next"\n');
  const [go, next] = block.items.map((item) => item.line);
  const row = (line: number, id: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({
    ...passRows(block, { [line]: { id } }).find((r) => r.line === line)!,
    ...extra,
  });
  const rows = [
    row(go, 'go-first'),
    row(next, 'next'),
    row(go, 'go-latest'),
    row(go, 'retried', { outcome: 'retry' }),
    row(go, 'failed', { outcome: 'fail' }),
    row(go, 'foreign-block', { block: 'other' }),
    row(next, 'foreign-line'),
  ];
  const yaml = serialized(block, rows);
  assert.match(yaml, /# 1\. Tap "Go"\n- tapOn: \{ id: "go-latest" \}\n/);
  assert.match(yaml, /# 2\. Tap "Next"\n- tapOn: \{ id: "foreign-line" \}\n/);
});

test('every ✓ line appears as its exact item.raw comment', () => {
  const block = blockOf(literal);
  const yaml = serialized(block, passRows(block, literalSelectors));
  for (const item of block.items.filter((i) => i.kind === 'check'))
    assert.ok(yaml.split('\n').includes(`# ${item.raw}`), item.raw);
});

test('Android keyboard dismissal is always settled first; iOS never emits it', () => {
  const block = blockOf('### K\n1. Type "ada" into "name-input"\n2. Tap "Save"\n');
  const rows = passRows(block, {
    [block.items[0].line]: { id: 'name-input' },
    [block.items[1].line]: { text: 'Save' },
  });
  const android = serialized(block, rows, { appId: 'a', platform: 'android' }).split('\n');
  android.forEach((line, i) => {
    if (line.includes('hideKeyboard')) assert.equal(android[i - 1], '- waitForAnimationToEnd');
  });
  assert.ok(!serialized(block, rows).includes('hideKeyboard'));
});

test('a hand-edited non-canonical command is invalid', () => {
  const block = blockOf(literal);
  const yaml = serialized(block, passRows(block, literalSelectors));
  for (const [from, to] of [
    ['- tapOn: { id: "onboarding-done" }', '- tapOn: "onboarding-done"'],
    ['- tapOn: { id: "onboarding-done" }', '- tapOn: { id: "onboarding-done", index: 1 }'],
    ['- tapOn: { id: "onboarding-done" }', '- longPressOn: { id: "onboarding-done" }'],
    ['timeout: 15000 }', 'timeout: 5000 }'],
    ['# platform: ios', '# platform: web'],
  ])
    assert.ok('invalid' in readBlock(yaml.replace(from, to)), to);
  const extra = readBlock(yaml.replace('# 2. Tap', '- launchApp\n# 2. Tap'));
  assert.ok('invalid' in extra);
});

test('a stored block whose lines differ from the plan does not match it', () => {
  const block = blockOf(literal);
  const read = readBlock(serialized(block, passRows(block, literalSelectors)));
  assert.ok(!('invalid' in read));
  const edited = blockOf(literal.replace('4. Tap "tab-tasks"', '4. Tap "tab-home"'));
  assert.ok(!storedMatches(edited, read));
});

function appRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qaren-blocks-'));
  mkdirSync(join(root, '.qaren'));
  return root;
}

function concurrentWriter(appRoot: string, slug: string, text: string, pause: boolean) {
  const child = fork(
    new URL('./block-write-child.ts', import.meta.url),
    [JSON.stringify({ appRoot, slug, text, pause })],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += data;
  });
  const message = (kind: string): Promise<string> =>
    new Promise((resolve, reject) => {
      child.on('message', (data: { kind: string; value?: string }) => {
        if (data.kind === kind) resolve(data.value ?? '');
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        reject(new Error(`writer exited ${code} before ${kind}: ${stderr}`));
      });
    });
  return {
    child,
    ready: message('ready'),
    publishing: pause ? message('publishing') : Promise.resolve(''),
    result: message('result'),
  };
}

for (const extension of ['yaml', 'yml']) {
  test(
    `concurrent colliding saves serialize ownership and publication for .${extension}`,
    { timeout: 5000 },
    async (t) => {
      const root = appRoot();
      const longTitle = 'a'.repeat(65);
      const short = blockOf(`### ${slugify(longTitle)}\n1. Tap "Save"\n✓ "Saved"\n`);
      const long = blockOf(`### ${longTitle}\n1. Tap "Save"\n✓ "Saved"\n`);
      const winner = serialized(short, passRows(short, { 2: { id: 'save' } }));
      const loser = serialized(long, passRows(long, { 2: { id: 'save' } }));
      const path = join(root, '.qaren/actions', `${short.slug}.${extension}`);
      if (extension === 'yml') {
        mkdirSync(join(root, '.qaren/actions'));
        writeFileSync(path, winner.replace('id: "save"', 'id: "old-save"'));
      }
      const first = concurrentWriter(root, short.slug, winner, true);
      t.after(() => first.child.kill());
      await first.publishing;
      const second = concurrentWriter(root, long.slug, loser, false);
      t.after(() => second.child.kill());
      let finishedWhilePublishing: boolean;
      try {
        await second.ready;
        finishedWhilePublishing = await Promise.race([
          second.result.then(() => true),
          delay(200).then(() => false),
        ]);
      } finally {
        writeFileSync(join(root, 'release'), '');
      }
      const results = await Promise.all([first.result, second.result]);
      assert.equal(finishedWhilePublishing, false);
      assert.equal(results[0], 'written');
      assert.match(results[1], /BLOCK_SLUG_COLLISION/);
      assert.equal(readFileSync(path, 'utf8'), winner);
      assert.deepEqual(readdirSync(join(root, '.qaren/actions')), [`${short.slug}.${extension}`]);
      const patched = serialized(short, passRows(short, { 2: { id: 'new-save' } }));
      assert.equal(writeBlock(root, short.slug, patched), 'written');
      assert.equal(readFileSync(path, 'utf8'), patched);
    },
  );
}

test('overflowing headings use one ID for the saved path, M7 header and replay lookup', () => {
  const root = appRoot();
  const title = 'Verify the payment confirmation screen after selecting a different policy';
  for (const heading of ['#', '###']) {
    const markdown = `${heading} ${title}\n1. Tap "Save"\n✓ "Saved"\n`;
    const block = blockOf(markdown);
    const yaml = serialized(block, passRows(block, { [block.items[0].line]: { id: 'save' } }));
    assert.equal(block.slug.length, 64);
    assert.equal(writeBlock(root, block.slug, yaml), heading === '#' ? 'written' : 'unchanged');
    assert.deepEqual(readdirSync(join(root, '.qaren', 'actions')), [`${block.slug}.yaml`]);
    assert.equal(readFileSync(join(root, '.qaren', 'actions', `${block.slug}.yaml`), 'utf8'), yaml);
    assert.equal(parseM7Header(yaml)?.id, block.slug);
    assert.equal(parseM7Header(yaml)?.plan, block.slug);
    const rerun = blockOf(markdown);
    assert.equal(loadBlock(root, rerun.slug), yaml);
    const stored = readBlock(yaml);
    assert.ok(!('invalid' in stored));
    assert.ok(storedFits(rerun, stored, yaml, ios));
  }
});

test('writeBlock writes once, then reports unchanged', () => {
  const root = appRoot();
  const block = blockOf(literal);
  const yaml = serialized(block, passRows(block, literalSelectors));
  assert.equal(writeBlock(root, block.slug, yaml), 'written');
  assert.equal(readFileSync(join(root, '.qaren', 'actions', `${block.slug}.yaml`), 'utf8'), yaml);
  assert.equal(writeBlock(root, block.slug, yaml), 'unchanged');
});

test('writeBlock refuses a symlinked corpus and a slug collision', () => {
  const root = appRoot();
  const block = blockOf(literal);
  const yaml = serialized(block, passRows(block, literalSelectors));
  const elsewhere = mkdtempSync(join(tmpdir(), 'qaren-elsewhere-'));
  symlinkSync(elsewhere, join(root, '.qaren', 'actions'));
  assert.throws(() => writeBlock(root, block.slug, yaml), /symlink/);

  const other = appRoot();
  mkdirSync(join(other, '.qaren', 'actions'));
  const path = join(other, '.qaren', 'actions', `${block.slug}.yaml`);
  writeFileSync(path, '# id: onboarding-to-the-tasks-tab\n# intent: recorded\n- launchApp\n');
  assert.throws(() => writeBlock(other, block.slug, yaml), /BLOCK_SLUG_COLLISION/);
  assert.match(readFileSync(path, 'utf8'), /recorded/);
});

for (const extension of ['yaml', 'yml']) {
  test(`overflow title collision preserves the existing .${extension} action`, () => {
    const root = appRoot();
    mkdirSync(join(root, '.qaren/actions'));
    const longTitle = 'a'.repeat(65);
    const shortTitle = slugify(longTitle);
    const short = blockOf(`### ${shortTitle}\n1. Tap "Save"\n✓ "Saved"\n`);
    const long = blockOf(`### ${longTitle}\n1. Tap "Save"\n✓ "Saved"\n`);
    assert.equal(short.slug, long.slug);
    const before = serialized(short, passRows(short, { 2: { id: 'save' } }));
    const incoming = serialized(long, passRows(long, { 2: { id: 'save' } }));
    const path = join(root, '.qaren/actions', `${short.slug}.${extension}`);
    writeFileSync(path, before);
    const stored = readBlock(before);
    assert.ok(!('invalid' in stored));
    assert.equal(storedFits(long, stored, before, ios), false);
    assert.throws(() => writeBlock(root, long.slug, incoming), /BLOCK_SLUG_COLLISION/);
    assert.equal(readFileSync(path, 'utf8'), before);
    const sameTitle = blockOf(`### ${shortTitle.toUpperCase()}!\n1. Tap "Save"\n✓ "Saved"\n`);
    const patched = serialized(sameTitle, passRows(sameTitle, { 2: { id: 'save-new' } }));
    assert.equal(writeBlock(root, sameTitle.slug, patched), 'written');
    assert.equal(readFileSync(path, 'utf8'), patched);
  });

  test(`blocks load and update existing .${extension} without creating an alias`, () => {
    const root = appRoot();
    mkdirSync(join(root, '.qaren/actions'));
    const block = blockOf(literal);
    const text = serialized(block, passRows(block, literalSelectors));
    const path = join(root, '.qaren/actions', `${block.slug}.${extension}`);
    writeFileSync(path, text);
    assert.equal(loadBlock(root, block.slug), text);
    assert.equal(
      writeBlock(root, block.slug, text.replace('com.example.app', 'other.app')),
      'written',
    );
    assert.equal(loadBlock(root, block.slug), readFileSync(path, 'utf8'));
    assert.deepEqual(readdirSync(join(root, '.qaren/actions')), [`${block.slug}.${extension}`]);
    writeFileSync(path, '# id: unrelated\n- launchApp\n');
    assert.throws(() => writeBlock(root, block.slug, text), /BLOCK_SLUG_COLLISION/);
    assert.equal(readFileSync(path, 'utf8'), '# id: unrelated\n- launchApp\n');
  });
}

test('preclassified fills withhold every semantic block field before typing', () => {
  for (const value of ['hunter-canary-77', 'Cafe\u0301']) {
    const privateSet: PrivateSet = {
      values: [{ text: value === 'Cafe\u0301' ? ' Café ' : value, provenance: 'typed' }],
    };
    for (const field of ['appId', 'slug', 'title', 'planHash', 'raw', 'text', 'id', 'label']) {
      const block = blockOf('## QA\n\n### Confirm\n1. Tap "Save"\n✓ "Saved"\n');
      const rows = passRows(block, { [block.items[0].line]: { id: 'save-button' } });
      const meta = { ...ios };
      if (field === 'appId') meta.appId = value;
      else if (field === 'slug' || field === 'title' || field === 'planHash') block[field] = value;
      else if (field === 'raw') block.items[0].raw = value;
      else if (field === 'text') {
        const check = block.items[1];
        if (check.kind === 'check') check.text = value;
      } else rows[0].selector = field === 'id' ? { id: value } : { text: value };
      if (field === 'slug') rows.forEach((row) => (row.block = block.slug));
      assert.ok('unsavable' in serializeBlock(block, rows, meta, privateSet), field);
    }
  }
});

test('box characters do not affect admission of unrelated blocks', () => {
  const privacy = new ObservedPrivacy();
  privacy.concealFallback('4815');
  privacy.concealFallback('1234');
  for (const text of ['8', '4 | 8', 'Step 1 of 2']) {
    const block = blockOf(`## QA\n\n### Confirm\n✓ "${text}"\n`);
    const result = serializeBlock(block, passRows(block, {}), ios, privacy.privateSet());
    assert.ok('yaml' in result, text);
  }
  // A plan that spells out the private value in any separator form is withheld; the walk is unaffected.
  const spelled = blockOf(`## QA\n\n### Confirm\n✓ "4 | 8 | 1 | 5"\n`);
  assert.ok(
    'unsavable' in serializeBlock(spelled, passRows(spelled, {}), ios, privacy.privateSet()),
  );
});

test('short preclassified fills withhold quoted plan slots only', () => {
  const privateSet: PrivateSet = { values: [{ text: '47', provenance: 'typed' }] };
  for (const text of ['47', 'Step 47 of 50']) {
    const block = blockOf(`## QA\n\n### Confirm\n✓ "${text}"\n`);
    assert.equal(
      'unsavable' in serializeBlock(block, passRows(block, {}), ios, privateSet),
      text === '47',
    );
  }
});

test('secure single-character values never withhold structural step numbers', () => {
  for (const prefix of ['1.', '1)']) {
    const block = blockOf(`### Ordinary\n${prefix} Tap "Continue"\n✓ "Ready"`);
    const rows = passRows(block, { [block.items[0].line]: { id: 'continue' } });
    const result = serializeBlock(block, rows, ios, secrets('1'));
    assert.ok('yaml' in result, JSON.stringify(result));
    const stored = readBlock(result.yaml);
    assert.ok(!('invalid' in stored));
    assert.equal(stored.steps[0].raw, `${prefix} Tap "Continue"`);
    assert.deepEqual(stored.steps[0].selector, { id: 'continue' });
    rows[0].selector = { text: '1' };
    assert.ok('unsavable' in serializeBlock(block, rows, ios, secrets('1')));
    rows[0].selector = { id: 'continue' };
    const check = block.items[1];
    if (check.kind === 'check') check.text = '1';
    assert.ok('unsavable' in serializeBlock(block, rows, ios, secrets('1')));
  }
});

test('explicit keyboard key and submit serialize as exactly two canonical presses', () => {
  const block = blockOf('### Explicit key\n1. Tap "Return"\n2. Tap "login_submit"\n');
  const selectors = [{ text: 'Return' }, { id: 'login_submit' }];
  const rows = passRows(
    block,
    Object.fromEntries(block.items.map((item, i) => [item.line, selectors[i]])),
  );
  const yaml = serialized(block, rows);
  assert.deepEqual(
    yaml.split('\n').filter((line) => line.startsWith('- ')),
    ['- tapOn: { text: "Return" }', '- tapOn: { id: "login_submit" }'],
  );
  const stored = readBlock(yaml);
  assert.ok(!('invalid' in stored), JSON.stringify(stored));
  assert.deepEqual(
    stored.steps,
    block.items.map((item, i) => ({ raw: item.raw, kind: 'press', selector: selectors[i] })),
  );
  assert.equal(storedMatches(block, stored), true);
  const dir = mkdtempSync(join(tmpdir(), 'qaren-key-compile-'));
  const file = join(dir, 'explicit-key.yaml');
  writeFileSync(file, yaml);
  const compiled = compileFlow({ file, params: {}, platform: 'ios' });
  assert.deepEqual(
    compiled.steps.map((step) => [step.op, step.selector]),
    [
      ['tapOn', { text: 'Return' }],
      ['tapOn', { id: 'login_submit' }],
    ],
  );
  assert.deepEqual(serializeBlock(block, rows, ios, secrets('Return')), {
    unsavable: 'contains a protected plan-typed value',
  });
});

test('a declared echo saves as its plan line and a name-only marker', () => {
  const block = blockOf(
    '### Login\n1. Fill "email" with input EMAIL\n2. Expect input EMAIL on screen\n3. Tap "next"\n',
  );
  const rows = passRows(block, {
    [block.items[0].line]: { id: 'email' },
    [block.items[2].line]: { id: 'next' },
  });
  const yamls = ['qa-synth-1234@example.test', 'other-user@example.test'].map((value) => {
    const privacy = new ObservedPrivacy();
    privacy.classifyInputs([value]);
    const result = serializeBlock(block, rows, ios, privacy.privateSet('persisted'));
    assert.ok('yaml' in result, JSON.stringify(result));
    assert.ok(!result.yaml.includes(value));
    return result.yaml;
  });
  assert.equal(yamls[0], yamls[1]);
  const yaml = yamls[0];
  assert.match(yaml, /# 2\. Expect input EMAIL on screen\n# qaren: echo EMAIL\n/);
  const read = readBlock(yaml);
  assert.ok(!('invalid' in read), JSON.stringify(read));
  assert.deepEqual(read.steps[1], { raw: block.items[1].raw, kind: 'echo', input: 'EMAIL' });
  assert.ok(storedMatches(block, read));
  assert.ok(storedFits(block, read, yaml, ios));
  assert.deepEqual(
    loginBlock('login', read).items.map((item) => [
      item.kind,
      'input' in item ? item.input : undefined,
    ]),
    [
      ['fill', 'EMAIL'],
      ['echo', 'EMAIL'],
      ['press', undefined],
    ],
  );
  for (const marker of ['# qaren: echo email', '# qaren: echo OTP']) {
    assert.ok('invalid' in readBlock(yaml.replace('# qaren: echo EMAIL', marker)), marker);
  }
});

const recipeSource = [
  '# Add a task',
  '',
  'Prose the walk never reads: "Hunter2" stays out.',
  '<!-- reviewer note -->',
  '',
  '## QA',
  '',
  '### Open tasks',
  'starts on: "Home"',
  '1. Tap "Tasks"',
  '✓ "Tasks"',
  '',
  '### Add one',
  '1. Type "Milk" into "New task"',
  '2. Fill "Password" with input PASSWORD',
  '✓ "Milk"',
  '',
  '## Notes',
  'anything',
  '',
].join('\n');

function recipeOf(markdown: string, set: PrivateSet = { values: [] }) {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return recipeMarkdown(planTitle(markdown), parsed.blocks, set);
}

test('a recipe keeps only the title, block titles and raw plan lines', () => {
  assert.deepEqual(recipeOf(recipeSource), {
    slug: 'add-a-task',
    markdown: [
      '# Add a task',
      '',
      '## QA',
      '',
      '### Open tasks',
      'starts on: "Home"',
      '1. Tap "Tasks"',
      '✓ "Tasks"',
      '',
      '### Add one',
      '1. Type "Milk" into "New task"',
      '2. Fill "Password" with input PASSWORD',
      '✓ "Milk"',
      '',
    ].join('\n'),
  });
});

test('a recipe re-parses to the same blocks, slugs and plan hashes', () => {
  for (const source of [recipeSource, '# Login\n1. Tap "Sign in"\n✓ "Welcome"\n']) {
    const recipe = recipeOf(source);
    assert.ok('markdown' in recipe);
    const again = parsePlan(recipe.markdown);
    assert.ok(again.blocks);
    assert.deepEqual(
      again.blocks.map(({ slug, title, planHash }) => ({ slug, title, planHash })),
      parsePlan(source).blocks!.map(({ slug, title, planHash }) => ({ slug, title, planHash })),
    );
  }
  assert.deepEqual(recipeOf('# Login\n1. Tap "Sign in"\n'), {
    slug: 'login',
    markdown: '# Login\n\n## QA\n\n### Login\n1. Tap "Sign in"\n',
  });
});

test('a recipe with a protected value anywhere is withheld', () => {
  const withheld = { unsavable: 'contains a protected plan-typed value' };
  for (const value of ['Add a task', 'Open tasks', 'Milk', 'Tasks']) {
    assert.deepEqual(recipeOf(recipeSource, secrets(value)), withheld, value);
  }
  assert.ok('markdown' in recipeOf(recipeSource, secrets('Hunter2')));
});
