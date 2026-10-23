import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOwnedActionCorpus,
  assertReadableActionOperationUnchanged,
  captureOwnedActionPathIdentity,
  createActionTextExclusive,
  loadAction,
  openReadableActionLoadContext,
  ownedActionPathIdentityMatches,
  resolveReadableActionCorpus,
  writeRecordedActionTransaction,
} from '../../dist/domain/action-store.js';
import { atomicWriter } from '../../dist/domain/atomic-writer.js';
import { freshRuntimeState } from '../../dist/domain/reusable-action.js';
import { writeBlock } from '../../dist/qa/blocks.js';

function repository(t: TestContext, bare = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qaren-action-worktree-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const linked = join(root, 'linked');
  mkdirSync(main);
  mkdirSync(linked);
  execFileSync('git', ['init', '-q', ...(bare ? ['--bare'] : []), main]);
  const common = bare ? main : join(main, '.git');
  const gitdir = join(common, 'worktrees', 'linked');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/linked\n');
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  writeFileSync(join(gitdir, 'gitdir'), `${linked}/.git\n`);
  writeFileSync(join(linked, '.git'), `gitdir: ${gitdir}\n`);
  const mainApp = join(main, 'apps', 'example');
  const linkedApp = join(linked, 'apps', 'example');
  mkdirSync(join(mainApp, '.qaren', 'actions'), { recursive: true });
  mkdirSync(join(linkedApp, '.qaren'), { recursive: true });
  assert.equal(
    execFileSync('git', ['-C', linkedApp, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim(),
    linked,
  );
  return { root, mainApp, linkedApp };
}

const yaml =
  'appId: com.example.app\n---\n# id: welcome\n# intent: Welcome\n# status: experimental\n- tapOn: Welcome\n';

for (const scenario of ['accepted', 'other-clone', 'bare'] as const) {
  test(`main-copy link fixture parity: ${scenario}`, (t) => {
    const { root, mainApp, linkedApp } = repository(t, scenario === 'bare');
    let target = join(mainApp, '.qaren', 'actions');
    if (scenario === 'other-clone') {
      const other = join(root, 'other');
      execFileSync('git', ['clone', '-q', join(root, 'main'), other], { stdio: 'pipe' });
      target = join(other, 'apps', 'example', '.qaren', 'actions');
      mkdirSync(target, { recursive: true });
    }
    writeFileSync(join(target, 'welcome.yaml'), yaml);
    symlinkSync(target, join(linkedApp, '.qaren', 'actions'));
    assert.equal(
      resolveReadableActionCorpus(linkedApp).status,
      scenario === 'accepted' ? 'owned-directory' : 'refused',
    );
    if (scenario === 'accepted')
      assert.equal(loadAction(linkedApp, 'welcome').metadata.id, 'welcome');
    else assert.throws(() => loadAction(linkedApp, 'welcome'), /Refusing/);
  });
}

test('creating an action refuses a main-copy link replaced during lock acquisition', (t) => {
  const { mainApp, linkedApp } = repository(t);
  const mainActions = join(mainApp, '.qaren', 'actions');
  const link = join(linkedApp, '.qaren', 'actions');
  symlinkSync(mainActions, link);
  const withLock = atomicWriter.withLock;
  t.mock.method(atomicWriter, 'withLock', (path: string, operation: () => unknown) => {
    unlinkSync(link);
    mkdirSync(link);
    return withLock(path, operation);
  });
  assert.throws(() => createActionTextExclusive(linkedApp, 'welcome', yaml), /changed/);
  assert.equal(existsSync(join(mainActions, 'welcome.yaml')), false);
  assert.equal(existsSync(join(link, 'welcome.yaml')), false);
});

test('recording an action refuses a main-copy link replaced during lock acquisition', (t) => {
  const { mainApp, linkedApp } = repository(t);
  const mainActions = join(mainApp, '.qaren', 'actions');
  const link = join(linkedApp, '.qaren', 'actions');
  symlinkSync(mainActions, link);
  const withLock = atomicWriter.withLock;
  t.mock.method(atomicWriter, 'withLock', (path: string, operation: () => unknown) => {
    unlinkSync(link);
    mkdirSync(link);
    return withLock(path, operation);
  });
  assert.throws(
    () => writeRecordedActionTransaction(linkedApp, 'welcome', yaml, freshRuntimeState(), false),
    /changed/,
  );
  assert.equal(existsSync(join(mainActions, 'welcome.yaml')), false);
  assert.equal(existsSync(join(link, 'welcome.yaml')), false);
});

test('saving a block refuses a main-copy link replaced during lock acquisition', (t) => {
  const { mainApp, linkedApp } = repository(t);
  const mainActions = join(mainApp, '.qaren', 'actions');
  const link = join(linkedApp, '.qaren', 'actions');
  symlinkSync(mainActions, link);
  const withLock = atomicWriter.withLock;
  t.mock.method(atomicWriter, 'withLock', (path: string, operation: () => unknown) => {
    unlinkSync(link);
    mkdirSync(link);
    return withLock(path, operation);
  });
  assert.throws(() => writeBlock(linkedApp, 'welcome', yaml), /changed/);
  assert.equal(existsSync(join(mainActions, 'welcome.yaml')), false);
  assert.equal(existsSync(join(link, 'welcome.yaml')), false);
});

for (const aliased of [false, true]) {
  test(`a linked worktree reads and creates actions in its repository main app copy (aliased=${aliased})`, (t) => {
    const { root, mainApp, linkedApp } = repository(t);
    const mainActions = join(mainApp, '.qaren', 'actions');
    let target = mainActions;
    if (aliased) {
      const alias = join(root, 'main-alias');
      symlinkSync(join(root, 'main'), alias);
      target = join(alias, 'apps', 'example', '.qaren', 'actions');
    }
    symlinkSync(target, join(linkedApp, '.qaren', 'actions'));
    assert.equal(resolveReadableActionCorpus(linkedApp).status, 'owned-directory');
    assert.doesNotThrow(() => assertOwnedActionCorpus(linkedApp));
    const path = createActionTextExclusive(linkedApp, 'welcome', yaml);
    assert.equal(path, join(mainActions, 'welcome.yaml'));
    assert.equal(readFileSync(path, 'utf8'), yaml);
    assert.equal(loadAction(linkedApp, 'welcome').metadata.id, 'welcome');
    assert.equal(
      writeBlock(linkedApp, 'saved', yaml.replace('# id: welcome', '# id: saved')),
      'written',
    );
    assert.equal(loadAction(mainApp, 'saved').metadata.id, 'saved');
  });
}

test('ordinary real action directories remain readable and writable without Git', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qaren-real-actions-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.qaren', 'actions'), { recursive: true });
  assert.equal(
    createActionTextExclusive(root, 'welcome', yaml),
    join(root, '.qaren', 'actions', 'welcome.yaml'),
  );
  assert.equal(loadAction(root, 'welcome').metadata.id, 'welcome');
});

test('action creation, recording and blocks initialize an absent real corpus', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qaren-new-actions-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(
    createActionTextExclusive(root, 'welcome', yaml),
    join(root, '.qaren', 'actions', 'welcome.yaml'),
  );
  assert.equal(
    writeRecordedActionTransaction(
      root,
      'recorded',
      yaml.replace('# id: welcome', '# id: recorded'),
      freshRuntimeState(),
      false,
    ).ok,
    true,
  );
  assert.equal(writeBlock(root, 'saved', yaml.replace('# id: welcome', '# id: saved')), 'written');
  for (const id of ['welcome', 'recorded', 'saved'])
    assert.equal(loadAction(root, id)?.metadata.id, id);
});

for (const scenario of [
  'foreign-repository',
  'other-clone',
  'wrong-app',
  'chained',
  'dangling',
  'dangling-alias',
] as const) {
  test(`read and owned/write paths refuse a ${scenario} actions link with supported setup advice`, (t) => {
    const { root, mainApp, linkedApp } = repository(t);
    let target = join(mainApp, '.qaren', 'actions');
    if (scenario === 'foreign-repository' || scenario === 'other-clone') {
      const foreign = join(root, 'foreign');
      if (scenario === 'other-clone')
        execFileSync('git', ['clone', '-q', join(root, 'main'), foreign], { stdio: 'pipe' });
      else execFileSync('git', ['init', '-q', foreign]);
      target = join(foreign, 'apps', 'example', '.qaren', 'actions');
      mkdirSync(target, { recursive: true });
    } else if (scenario === 'wrong-app') {
      target = join(root, 'main', 'apps', 'other', '.qaren', 'actions');
      mkdirSync(target, { recursive: true });
    } else if (scenario === 'chained') {
      const real = join(root, 'real-actions');
      mkdirSync(real);
      rmSync(target, { recursive: true });
      symlinkSync(real, target);
    } else {
      rmSync(target, { recursive: true });
      if (scenario === 'dangling-alias') {
        const alias = join(root, 'main-alias');
        symlinkSync(join(root, 'main'), alias);
        target = join(alias, 'apps', 'example', '.qaren', 'actions');
      }
    }
    symlinkSync(target, join(linkedApp, '.qaren', 'actions'));
    const corpus = resolveReadableActionCorpus(linkedApp);
    assert.equal(corpus.status, 'refused');
    if (corpus.status !== 'refused') assert.fail('must refuse');
    assert.match(corpus.reason, /symlink.*Use a real directory.*this repository main copy/);
    if (scenario === 'dangling' || scenario === 'dangling-alias')
      assert.match(corpus.reason, /main copy has no actions directory yet/);
    assert.throws(() => assertOwnedActionCorpus(linkedApp), { message: corpus.reason });
    assert.throws(() => loadAction(linkedApp, 'welcome'), { message: corpus.reason });
    assert.throws(() => createActionTextExclusive(linkedApp, 'welcome', yaml), {
      message: corpus.reason,
    });
  });
}

test('per-file symlinks stay refused inside an accepted main-copy corpus', (t) => {
  const { root, mainApp, linkedApp } = repository(t);
  const mainActions = join(mainApp, '.qaren', 'actions');
  symlinkSync(mainActions, join(linkedApp, '.qaren', 'actions'));
  const foreignFile = join(root, 'foreign.yaml');
  writeFileSync(foreignFile, yaml);
  symlinkSync(foreignFile, join(mainActions, 'welcome.yaml'));
  assert.throws(() => loadAction(linkedApp, 'welcome'), /Refusing/);
  assert.throws(() => createActionTextExclusive(linkedApp, 'welcome', yaml), /Refusing/);
  assert.equal(readFileSync(foreignFile, 'utf8'), yaml);
});

test('read and write snapshots refuse a replaced accepted actions link', (t) => {
  const { root, mainApp, linkedApp } = repository(t);
  const link = join(linkedApp, '.qaren', 'actions');
  symlinkSync(join(mainApp, '.qaren', 'actions'), link);
  createActionTextExclusive(linkedApp, 'welcome', yaml);
  const context = openReadableActionLoadContext(linkedApp);
  assert.ok(context);
  const identity = captureOwnedActionPathIdentity(linkedApp);
  const foreign = join(root, 'foreign-actions');
  mkdirSync(foreign);
  unlinkSync(link);
  symlinkSync(foreign, link);
  assert.throws(() => assertReadableActionOperationUnchanged(context.operation), /replaced/);
  assert.equal(ownedActionPathIdentityMatches(identity), false);
});

test('a direct main-copy link refuses a target that escapes the main copy through an ancestor link', (t) => {
  const { root, mainApp, linkedApp } = repository(t);
  const target = join(mainApp, '.qaren', 'actions');
  symlinkSync(target, join(linkedApp, '.qaren', 'actions'));
  const elsewhere = join(root, 'elsewhere');
  renameSync(mainApp, elsewhere);
  symlinkSync(elsewhere, mainApp);
  assert.equal(resolveReadableActionCorpus(linkedApp).status, 'refused');
  assert.throws(() => assertOwnedActionCorpus(linkedApp), /symlink/);
  assert.throws(() => createActionTextExclusive(linkedApp, 'welcome', yaml), /symlink/);
});
