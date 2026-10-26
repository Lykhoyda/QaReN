import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { compileFlow, FlowCompileError } from '../../../dist/flow/compile.js';

const fixtures = resolve(import.meta.dirname, '../../fixtures/rn-flow-1');
const walk = resolve(import.meta.dirname, '../../../dist/qa/walk.js');
const PARAMS = { TITLE: 'Ship it', DESC: 'From the plan', PRIORITY: 'high', TAG: 'bug' };

function withFlow(body: string, run: (file: string, dir: string) => void, name = 'a.yaml'): void {
  const dir = mkdtempSync(join(tmpdir(), 'rn-flow-'));
  try {
    const file = join(dir, name);
    writeFileSync(file, `appId: com.example.app\n---\n# id: sample\n# intent: t\n${body}`);
    run(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compile(body: string, platform: 'ios' | 'android' = 'ios', params = {}) {
  let plan;
  withFlow(body, (file) => {
    plan = compileFlow({ file, params, platform });
  });
  return plan!;
}

function refusal(body: string, params = {}): FlowCompileError {
  let error: unknown;
  withFlow(body, (file) => {
    try {
      compileFlow({ file, params, platform: 'ios' });
    } catch (caught) {
      error = caught;
    }
  });
  assert.ok(error instanceof FlowCompileError, `expected a refusal, got ${String(error)}`);
  return error;
}

test('an unsupported command refuses with its name and line', () => {
  const error = refusal('- launchApp:\n    stopApp: false\n- copyTextFrom:\n    id: x\n');
  assert.equal(error.command, 'copyTextFrom');
  assert.equal(error.line, 7);
});

test('commands outside the validator allowlist refuse with their line', () => {
  const denied = refusal('- back\n- runScript: evil.js\n');
  assert.deepEqual([denied.command, denied.line], ['runScript', 6]);
  const unknown = refusal('- repeat:\n    times: 2\n');
  assert.deepEqual([unknown.command, unknown.line], ['repeat', 5]);
  const unsafe = refusal('- inputText: "a\\u0007"\n');
  assert.match(unsafe.reason, /Unsafe scalar/);
  assert.deepEqual([unsafe.command, unsafe.line], ['inputText', 5]);
});

test('explicit null numeric fields refuse at their command', () => {
  const commands = [
    '- tapOn:\n    id: a\n    index: null',
    '- eraseText:\n    charactersToErase: null',
    '- swipe:\n    direction: DOWN\n    duration: null',
    '- extendedWaitUntil:\n    visible: A\n    timeout: null',
    '- scrollUntilVisible:\n    element: A\n    timeout: null',
    '- waitForAnimationToEnd:\n    timeout: null',
  ];
  for (const command of commands) {
    const error = refusal(`${command}\n`);
    assert.equal(error.line, 5);
    assert.ok(error.command);
    assert.match(error.reason, /integer/);
  }
});

test('poll commands refuse zero timeouts at their source line', () => {
  for (const [command, body] of [
    ['extendedWaitUntil', 'visible: A'],
    ['extendedWaitUntil', 'notVisible: A'],
    ['scrollUntilVisible', 'element: A'],
    ['waitForAnimationToEnd', ''],
  ]) {
    const fields = body ? `    ${body}\n` : '';
    const error = refusal(`- ${command}:\n${fields}    timeout: 0\n`);
    assert.deepEqual([error.command, error.line], [command, 5]);
    assert.match(error.reason, /positive integer/);
  }
});

test('malformed and cyclic runFlow refuse instead of crashing', () => {
  assert.match(refusal('- runFlow:\n    file: 12\n').reason, /must be a path/);
  assert.match(refusal('- runFlow:\n    commands: true\n').reason, /must be a list/);
  withFlow('- runFlow: sub.yaml\n', (file, dir) => {
    writeFileSync(join(dir, 'sub.yaml'), '- runFlow: sub.yaml\n');
    assert.throws(
      () => compileFlow({ file, params: {}, platform: 'ios' }),
      (error: unknown) =>
        error instanceof FlowCompileError && /nesting exceeds 5/.test(error.reason),
    );
  });
  assert.match(refusal('- runFlow: ../escape.yaml\n').reason, /must not contain/);
});

test('a regex-shaped text selector refuses; a param value is literal', () => {
  const error = refusal('- tapOn: "Log.n"\n');
  assert.equal(error.command, 'tapOn');
  assert.equal(error.line, 5);
  assert.match(error.reason, /regex/);
  assert.match(refusal('- assertVisible:\n    text: "(Continue|Weiter)"\n').reason, /regex/);
  assert.match(refusal('- tapOn: ${LABEL ?? "Log.n"}\n').reason, /regex/);
  assert.match(refusal('- tapOn:\n    id: ${ID}\n', { ID: '' }).reason, /empty/);
  const plan = compile('- assertVisible: ${TITLE}\n', 'ios', { TITLE: 'Done (1).' });
  assert.deepEqual(plan.steps[0]!.selector, { text: 'Done (1).' });
});

test('a selector mixing id and native text semantics refuses', () => {
  const error = refusal('- tapOn:\n    id: "save"\n    text: "Save"\n');
  assert.equal(error.command, 'tapOn');
  assert.match(error.reason, /both id and text/);
});

test('relative selectors and unknown keys refuse', () => {
  assert.match(refusal('- tapOn:\n    text: "A"\n    below: "B"\n').reason, /below/);
  assert.match(
    refusal('- tapOn:\n    id: "a"\n    retryTapIfNoChange: true\n').reason,
    /retryTapIfNoChange/,
  );
  assert.match(refusal('- launchApp:\n    permissions: {}\n').reason, /permissions/);
});

test('a missing param refuses; unknown expressions refuse', () => {
  assert.match(refusal('- inputText: ${TITLE}\n').reason, /TITLE/);
  assert.match(refusal('- inputText: ${output.x}\n').reason, /expression/);
  assert.equal(compile('- inputText: ${TITLE ?? "fallback"}\n').steps[0]!.text, 'fallback');
});

test('iOS routes only exact-id reads to the React tree; mutations stay native', () => {
  const plan = compile(
    [
      '- tapOn:\n    id: "a"',
      '- inputText: "x"',
      '- assertVisible:\n    id: "a"',
      '- assertNotVisible:\n    id: "a"',
      '- assertVisible:\n    id: "a"\n    index: 1',
      '- assertVisible: "Title"',
      '- swipe:\n    from:\n      id: "a"\n    direction: DOWN',
      '- scrollUntilVisible:\n    element:\n      id: "a"',
      '- hideKeyboard',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.domain]),
    [
      ['tapOn', 'native'],
      ['inputText', 'native'],
      ['assertVisible', 'react-tree'],
      ['assertNotVisible', 'native'],
      ['assertVisible', 'native'],
      ['assertVisible', 'native'],
      ['swipe', 'native'],
      ['scrollUntilVisible', 'native'],
      ['hideKeyboard', 'native'],
    ],
  );
  assert.equal(plan.steps.at(-1)!.fallbackDomain, 'react-tree');
});

test('absence reads stay native on iOS: a parked sheet keeps its fibers mounted', () => {
  const plan = compile(
    '- extendedWaitUntil:\n    notVisible:\n      id: "a"\n    timeout: 900\n- runFlow:\n    when:\n      notVisible:\n        id: "a"\n    commands:\n      - back\n- runFlow:\n    when:\n      visible:\n        id: "a"\n    commands:\n      - back\n',
  );
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.domain]),
    [
      ['assertNotVisible', 'native'],
      ['runFlow', 'native'],
      ['runFlow', 'react-tree'],
    ],
  );
});

test('all exact-id presence reads share the compile-time domain', () => {
  const plan = compile(
    '- assertVisible:\n    id: a\n- extendedWaitUntil:\n    visible:\n      id: a\n- runFlow:\n    when:\n      visible:\n        id: a\n    commands:\n      - back\n',
  );
  assert.deepEqual(
    plan.steps.map((step) => step.domain),
    ['react-tree', 'react-tree', 'react-tree'],
  );
});

test('compiled plans are deeply frozen, including nested runFlow steps', () => {
  const plan = compile(
    '- runFlow:\n    when:\n      visible:\n        id: a\n    commands:\n      - tapOn:\n          id: b\n',
  );
  const nested = plan.steps[0]!;
  assert.equal(nested.op, 'runFlow');
  if (nested.op !== 'runFlow') return;
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.steps));
  assert.ok(Object.isFrozen(nested.when));
  assert.ok(Object.isFrozen(nested.steps));
  assert.ok(Object.isFrozen(nested.steps[0]!.source));
  assert.ok(Object.isFrozen(nested.steps[0]!.selector));
  assert.throws(() => Object.assign(nested.steps[0]!.selector, { id: 'wrong' }), TypeError);
  assert.throws(() => Object.assign(plan, { appId: 'wrong' }), TypeError);
});

test('malformed YAML refuses with its line instead of throwing', () => {
  assert.match(refusal('- back\n- tapOn: *missing\n').reason, /^YAML:/);
  const syntax = refusal('- back\n- tapOn: "unterminated\n');
  assert.match(syntax.reason, /^YAML:/);
  assert.ok(syntax.line >= 6, `line ${syntax.line}`);
  assert.match(refusal('back: true\n').reason, /command list/);
  assert.match(refusal('- back\n---\n- tapOn: Save\n').reason, /one optional header/);
  let error: unknown;
  const dir = mkdtempSync(join(tmpdir(), 'rn-flow-'));
  try {
    writeFileSync(join(dir, 'a.yaml'), 'appId: *missing\n---\n- back\n');
    compileFlow({ file: join(dir, 'a.yaml'), params: {}, platform: 'ios' });
  } catch (caught) {
    error = caught;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(error instanceof FlowCompileError);
  assert.match(error.reason, /^YAML:/);
});

test('file-backed flow document shapes compile or refuse at their document', () => {
  const header = 'appId: com.example.app\n---\n';
  const cases = [
    { name: 'top-level header and commands', top: true, yaml: `${header}- back\n`, ok: true },
    { name: 'sub-flow commands', top: false, yaml: '- back\n', ok: true },
    { name: 'empty top-level file', top: true, yaml: '', line: 1 },
    { name: 'empty sub-flow file', top: false, yaml: '', line: 1 },
    { name: 'missing final commands', top: true, yaml: header, line: 2 },
    { name: 'missing sub-flow commands', top: false, yaml: '---\n', line: 1 },
    { name: 'null final commands', top: true, yaml: `${header}null\n`, line: 2 },
    { name: 'null sub-flow commands', top: false, yaml: 'null\n', line: 1 },
    { name: 'empty command list', top: true, yaml: `${header}[]\n`, line: 2 },
    { name: 'empty sub-flow command list', top: false, yaml: '[]\n', line: 1 },
    { name: 'scalar commands', top: true, yaml: `${header}back\n`, line: 2 },
    { name: 'scalar sub-flow commands', top: false, yaml: 'back\n', line: 1 },
    { name: 'mapping commands', top: true, yaml: `${header}back: true\n`, line: 2 },
    { name: 'mapping sub-flow commands', top: false, yaml: 'back: true\n', line: 1 },
    { name: 'preceding command list', top: true, yaml: '- tapOn: Save\n---\n- back\n', line: 1 },
    {
      name: 'preceding sub-flow command list',
      top: false,
      yaml: '- tapOn: Save\n---\n- back\n',
      line: 1,
    },
    { name: 'unexpected header', top: true, yaml: 'name: extra\n---\n- back\n', line: 1 },
    { name: 'unexpected sub-flow header', top: false, yaml: 'name: extra\n---\n- back\n', line: 1 },
    { name: 'third document', top: true, yaml: `${header}- back\n---\n- back\n`, line: 4 },
    {
      name: 'third sub-flow document',
      top: false,
      yaml: `${header}- back\n---\n- back\n`,
      line: 4,
    },
  ];
  for (const entry of cases) {
    withFlow('- runFlow: sub.yaml\n', (file, dir) => {
      const target = entry.top ? file : join(dir, 'sub.yaml');
      writeFileSync(target, entry.yaml);
      if (entry.ok) {
        assert.deepEqual(
          compileFlow({ file, params: {}, platform: 'ios' }).steps.map((step) => step.op),
          ['back'],
          entry.name,
        );
      } else {
        assert.throws(
          () => compileFlow({ file, params: {}, platform: 'ios' }),
          (error: unknown) => {
            assert.ok(error instanceof FlowCompileError);
            assert.equal(error.line, entry.line, entry.name);
            assert.equal(error.file, entry.top ? undefined : 'sub.yaml', entry.name);
            return true;
          },
        );
      }
    });
  }
});

test('Android keeps every read native; lifecycle and the keyboard tier stay', () => {
  const plan = compile('- launchApp\n- assertVisible:\n    id: "a"\n- hideKeyboard\n', 'android');
  assert.deepEqual(
    plan.steps.map((step) => step.domain),
    ['lifecycle', 'native', 'native'],
  );
  assert.equal(plan.steps[2]!.fallbackDomain, 'react-tree');
});

test('eraseText defaults to 50 characters when no count is given', () => {
  const plan = compile(
    '- eraseText\n- eraseText:\n- eraseText: {}\n- eraseText: 3\n- eraseText:\n    charactersToErase: 4\n',
  );
  assert.deepEqual(
    plan.steps.map((step) => step.characters),
    [50, 50, 50, 3, 4],
  );
});

test('launchApp defaults to stopApp; only an activation is native', () => {
  const plan = compile(
    '- launchApp\n- launchApp:\n    stopApp: false\n- launchApp:\n    stopApp: false\n    clearState: true\n- killApp\n- stopApp\n- clearState\n- openLink: "app://x"\n',
  );
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.domain, step.stopApp, step.clearState]),
    [
      ['launchApp', 'lifecycle', true, false],
      ['launchApp', 'native', false, false],
      ['launchApp', 'lifecycle', false, true],
      ['killApp', 'lifecycle', undefined, undefined],
      ['stopApp', 'lifecycle', undefined, undefined],
      ['clearState', 'lifecycle', undefined, undefined],
      ['openLink', 'lifecycle', undefined, undefined],
    ],
  );
});

test('budgets follow the contract', () => {
  const plan = compile(
    [
      '- tapOn: "A"',
      '- tapOn:\n    text: "A"\n    optional: true',
      '- assertNotVisible: "A"',
      '- extendedWaitUntil:\n    notVisible: "A"\n    timeout: 3000',
      '- scrollUntilVisible:\n    element: "A"',
      '- waitForAnimationToEnd:\n    timeout: 9000',
      '- waitForAnimationToEnd',
      '- swipeUp',
      '- runFlow:\n    when:\n      visible: "A"\n    commands:\n      - back',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.budgetMs, step.optional]),
    [
      ['tapOn', 17_000, false],
      ['tapOn', 7_000, true],
      ['assertNotVisible', 7_000, false],
      ['assertNotVisible', 3_000, false],
      ['scrollUntilVisible', 20_000, false],
      ['waitForAnimationToEnd', 5_000, false],
      ['waitForAnimationToEnd', 5_000, false],
      ['swipe', 10_400, false],
      ['runFlow', 0, false],
    ],
  );
});

test('runFlow file refs compile with their own file and line', () => {
  withFlow(
    '- runFlow:\n    file: sub/dismiss.yaml\n    when:\n      notVisible:\n        id: "home"\n- runFlow: sub/dismiss.yaml\n',
    (file, dir) => {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'dismiss.yaml'), '- back\n- hideKeyboard\n');
      const plan = compileFlow({ file, params: {}, platform: 'ios' });
      const [conditional, spliced, last] = plan.steps;
      assert.deepEqual(conditional!.when, { notVisible: { id: 'home' } });
      assert.deepEqual(conditional!.source, { line: 5 });
      assert.deepEqual(
        conditional!.steps.map((step) => [step.id, step.source]),
        [
          ['s2', { file: 'sub/dismiss.yaml', line: 1 }],
          ['s3', { file: 'sub/dismiss.yaml', line: 2 }],
        ],
      );
      assert.deepEqual(
        [spliced, last].map((step) => [step!.id, step!.op, step!.source]),
        [
          ['s4', 'back', { file: 'sub/dismiss.yaml', line: 1 }],
          ['s5', 'hideKeyboard', { file: 'sub/dismiss.yaml', line: 2 }],
        ],
      );
    },
  );
});

test('sub-flow appId header refuses at the parent runFlow', () => {
  withFlow('- runFlow: sub.yaml\n', (file, dir) => {
    writeFileSync(join(dir, 'sub.yaml'), 'appId: com.example.other\n---\n- back\n');
    assert.throws(
      () => compileFlow({ file, params: {}, platform: 'ios' }),
      (error: unknown) => {
        assert.ok(error instanceof FlowCompileError);
        assert.deepEqual([error.command, error.line], ['runFlow', 5]);
        assert.match(error.reason, /appId header/);
        return true;
      },
    );
  });
});

test('the enginePin header never gates compilation', () => {
  const plan = compile('# enginePin: maestro-runner@0.0.1\n- back\n');
  assert.equal(plan.steps[0]!.op, 'back');
});

test('the 13 Test App actions match their golden plans on both platforms', () => {
  const actions = readdirSync(join(fixtures, 'actions')).filter((name) => name.endsWith('.yaml'));
  assert.equal(actions.length, 13);
  for (const name of actions) {
    for (const platform of ['ios', 'android'] as const) {
      const plan = compileFlow({ file: join(fixtures, 'actions', name), params: PARAMS, platform });
      const golden = join(fixtures, 'plans', `${name.replace(/\.yaml$/, '')}.${platform}.json`);
      const actual = `${JSON.stringify(plan, null, 2)}\n`;
      if (process.env.UPDATE_GOLDEN === '1') writeFileSync(golden, actual);
      assert.equal(actual, readFileSync(golden, 'utf8'), golden);
    }
  }
});

test('walk.js --compile prints the plan or the refusal', () => {
  withFlow('- back\n- tapOn:\n    point: "50%,50%"\n', (file) => {
    const refused = spawnSync(
      process.execPath,
      [walk, '--compile', file, '--params', '{}', '--platform', 'ios'],
      { encoding: 'utf8' },
    );
    assert.equal(refused.status, 4, refused.stderr);
    const out = JSON.parse(refused.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'FLOW_UNSUPPORTED');
    assert.equal(out.refused[0].line, 6);
    assert.equal(out.refused[0].command, 'tapOn');
  });
  const file = join(fixtures, 'actions', 'wizard-create-task.yaml');
  const ok = spawnSync(
    process.execPath,
    [walk, '--compile', file, '--params', JSON.stringify(PARAMS), '--platform', 'android'],
    { encoding: 'utf8' },
  );
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.plan.schema, 'rn-flow/1');
  assert.equal(out.plan.actionId, 'wizard-create-task');
  const flagsFirst = spawnSync(
    process.execPath,
    [walk, '--compile', '--platform', 'android', '--params', JSON.stringify(PARAMS), file],
    { encoding: 'utf8' },
  );
  assert.equal(flagsFirst.status, 0, flagsFirst.stderr);
  assert.equal(flagsFirst.stdout, ok.stdout);
  for (const args of [
    [file, '--platform', 'web'],
    ['--platform', 'ios'],
    [file, file, '--platform', 'ios'],
    [file, '--platform'],
    [file, '--platform', 'ios', '--verbose'],
    [file, '--platform', 'ios', '--params', '[]'],
  ]) {
    const usage = spawnSync(process.execPath, [walk, '--compile', ...args], { encoding: 'utf8' });
    assert.equal(usage.status, 4, args.join(' '));
    assert.equal(JSON.parse(usage.stdout).code, 'FLOW_USAGE', args.join(' '));
  }
});

test('symbolic inputs remain unsupported with or without fixture sensitivity', () => {
  for (const fields of ['input: FIXTURE', 'input: FIXTURE, sensitivity: non-secret']) {
    const error = refusal(`- inputText: { ${fields} }\n`);
    assert.match(error.reason, /named inputs require qaren check or pr/);
  }
});
