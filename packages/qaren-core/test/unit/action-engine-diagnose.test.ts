import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import {
  ACTION_ENGINE_PIN,
  MAESTRO_RUNNER_PIN,
  buildReplayEngineStatus,
} from '../../dist/domain/engine-pin.js';
import {
  actionReplayRefusal,
  diagnoseLearnedActions,
} from '../../dist/domain/action-engine-compat.js';
import { loadAction } from '../../dist/domain/action-store.js';

const PIN_CLI = join(dirname(fileURLToPath(import.meta.url)), '../../dist/maestro-runner-pin.js');

const PINNED = () =>
  buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false, {
    selectedPath: '/pin-cache/maestro-runner/1.1.28/bin/maestro-runner',
    provenance: 'pin-cache',
  });

function actionYaml(id: string, extraHeader = '', body = '- tapOn:\n    id: "fab-create-task"\n') {
  return [
    'appId: com.test.app',
    '---',
    `# id: ${id}`,
    '# intent: test fixture',
    '# status: experimental',
    extraHeader,
    '',
    '- launchApp:',
    '    stopApp: false',
    body,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function seedAction(dir: string, id: string, extraHeader = '', body?: string) {
  writeFileSync(join(dir, `${id}.yaml`), actionYaml(id, extraHeader, body), 'utf8');
}

function tmpRoot(t: TestContext, prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('diagnoseLearnedActions reports refusal classes without mutating or leaking bodies', (t) => {
  const root = tmpRoot(t, 'qaren-action-diagnose-');
  const dir = join(root, '.qaren', 'actions');
  mkdirSync(dir, { recursive: true });
  seedAction(dir, 'ok', `# enginePin: ${ACTION_ENGINE_PIN}`);
  seedAction(dir, 'login');
  seedAction(dir, 'search', `# enginePin: ${ACTION_ENGINE_PIN}`, '- tapOn: ".*Server.*"\n');
  writeFileSync(join(dir, 'broken.yaml'), 'not-yaml', 'utf8');
  const before = {
    login: readFileSync(join(dir, 'login.yaml'), 'utf8'),
    search: readFileSync(join(dir, 'search.yaml'), 'utf8'),
    broken: readFileSync(join(dir, 'broken.yaml'), 'utf8'),
  };

  const report = diagnoseLearnedActions(root);
  assert.equal(report.scanned, 4);
  assert.equal(report.compatible, 1);
  assert.deepEqual(report.counts, { enginePin: 1, regexSelector: 1, unreadable: 1 });
  assert.deepEqual(report.actionIds.enginePin, ['login']);
  assert.deepEqual(report.actionIds.regexSelector, ['search']);
  assert.deepEqual(report.actionIds.unreadable, ['broken']);
  assert.equal(readFileSync(join(dir, 'login.yaml'), 'utf8'), before.login);
  assert.equal(readFileSync(join(dir, 'search.yaml'), 'utf8'), before.search);
  assert.equal(readFileSync(join(dir, 'broken.yaml'), 'utf8'), before.broken);
  assert.equal(JSON.stringify(report).includes(root), false);
  assert.equal(JSON.stringify(report).includes('.*Server.*'), false);
  assert.equal(JSON.stringify(report).includes('tapOn'), false);
});

test('diagnoseLearnedActions treats an absent corpus as compatible', (t) => {
  const root = tmpRoot(t, 'qaren-action-diagnose-absent-');
  assert.deepEqual(diagnoseLearnedActions(root), {
    scanned: 0,
    compatible: 0,
    counts: { enginePin: 0, regexSelector: 0, unreadable: 0 },
    actionIds: { enginePin: [], regexSelector: [], unreadable: [] },
  });
});

test('diagnoseLearnedActions agrees with replay on invalid action ids without mutation', (t) => {
  const root = tmpRoot(t, 'qaren-action-diagnose-invalid-id-');
  const dir = join(root, '.qaren', 'actions');
  mkdirSync(dir, { recursive: true });
  const invalidIds = ['-login', 'a'.repeat(65)];
  for (const id of [...invalidIds, 'login']) {
    seedAction(dir, id, `# enginePin: ${ACTION_ENGINE_PIN}`);
  }
  const before = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]);
  for (const id of invalidIds) {
    assert.throws(() => loadAction(root, id), /Invalid action ID/);
  }

  assert.deepEqual(diagnoseLearnedActions(root), {
    scanned: 3,
    compatible: 1,
    counts: { enginePin: 0, regexSelector: 0, unreadable: 2 },
    actionIds: { enginePin: [], regexSelector: [], unreadable: invalidIds },
  });
  assert.deepEqual(
    readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]),
    before,
  );
});

test('diagnose-actions --json prints counts and refusal classes only', (t) => {
  const root = tmpRoot(t, 'qaren-action-diagnose-cli-');
  const dir = join(root, '.qaren', 'actions');
  mkdirSync(dir, { recursive: true });
  seedAction(dir, 'login');
  const before = readFileSync(join(dir, 'login.yaml'), 'utf8');
  const result = spawnSync(
    process.execPath,
    [PIN_CLI, 'diagnose-actions', '--root', root, '--json'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.actionIds.enginePin, ['login']);
  assert.equal(result.stdout.includes(before), false);
  assert.equal(result.stdout.includes('tapOn'), false);
  assert.equal(readFileSync(join(dir, 'login.yaml'), 'utf8'), before);
});

test('actionReplayRefusal labels unmigrated pin vs regex vs missing binary', () => {
  assert.equal(
    actionReplayRefusal({
      enginePin: undefined,
      commands: [{ tapOn: { id: 'x' } }],
      engineStatus: PINNED(),
    })?.refusalClass,
    'enginePin',
  );
  assert.equal(
    actionReplayRefusal({
      enginePin: ACTION_ENGINE_PIN,
      commands: [{ tapOn: '.*Server.*' }],
      engineStatus: PINNED(),
    })?.refusalClass,
    'regexSelector',
  );
  assert.equal(
    actionReplayRefusal({
      enginePin: ACTION_ENGINE_PIN,
      commands: [{ tapOn: { id: 'x' } }],
      engineStatus: buildReplayEngineStatus('not-installed', null, false),
    })?.refusalClass,
    'runtimePin',
  );
});
