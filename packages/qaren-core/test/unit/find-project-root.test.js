import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot } from '../../dist/util/project-root.js';

// B134: findProjectRoot() must find an RN project in these layouts:
// 1. cwd IS the RN project (direct hit)
// 2. cwd is inside an RN project (walk-up)
// 3. cwd is a sibling of the RN project (B134 fix: 1-level sibling scan)
// 4. cwd is a sibling of a workspace containing the RN project (B134 fix: 1-level grandchild scan)
// 5. cwd has nothing resembling an RN project → return null

function makeRnProject(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'test-rn',
      dependencies: { 'react-native': '0.76.0' },
    }),
  );
}

function makeNonRnDir(dir, withPackageJson = false) {
  mkdirSync(dir, { recursive: true });
  if (withPackageJson) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain', dependencies: {} }));
  }
}

function withCwd(dir, fn) {
  const original = process.cwd();
  try {
    process.chdir(dir);
    return fn();
  } finally {
    process.chdir(original);
  }
}

function withEnv(envPatches, fn) {
  const saved = {};
  for (const key of Object.keys(envPatches)) {
    saved[key] = process.env[key];
    if (envPatches[key] === null) delete process.env[key];
    else process.env[key] = envPatches[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('findProjectRoot: cwd IS an RN project → returns cwd', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fpr-direct-'));
  try {
    makeRnProject(tmp);
    withEnv({ RN_PROJECT_ROOT: null, CLAUDE_USER_CWD: null }, () => {
      withCwd(tmp, () => {
        const result = findProjectRoot();
        // On macOS /tmp is a symlink to /private/tmp — the resolved path may start
        // with /private. Either answer is correct as long as it ends with the unique suffix.
        assert.ok(
          result && result.endsWith(tmp.split('/').pop()),
          `expected result to end with tmp suffix, got ${result}`,
        );
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findProjectRoot: cwd is inside an RN project → walks up to find it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fpr-walkup-'));
  try {
    const rnRoot = tmp;
    makeRnProject(rnRoot);
    const nestedCwd = join(rnRoot, 'src', 'components');
    mkdirSync(nestedCwd, { recursive: true });
    withEnv({ RN_PROJECT_ROOT: null, CLAUDE_USER_CWD: null }, () => {
      withCwd(nestedCwd, () => {
        const result = findProjectRoot();
        assert.ok(
          result && result.endsWith(tmp.split('/').pop()),
          `expected walk-up result to end with tmp suffix, got ${result}`,
        );
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('B134: findProjectRoot finds RN project as sibling of cwd (plugin-repo ↔ workspace layout)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fpr-sibling-'));
  try {
    // tmp/
    //   plugin-repo/        (cwd — no package.json at root)
    //   workspace-repo/
    //     test-app/         (RN project, 2 levels deep from tmp)
    const pluginRepo = join(tmp, 'plugin-repo');
    const workspaceRepo = join(tmp, 'workspace-repo');
    const testApp = join(workspaceRepo, 'test-app');
    makeNonRnDir(pluginRepo, false);
    makeNonRnDir(workspaceRepo, false);
    makeRnProject(testApp);

    withEnv({ RN_PROJECT_ROOT: null, CLAUDE_USER_CWD: null }, () => {
      withCwd(pluginRepo, () => {
        const result = findProjectRoot();
        assert.ok(result, 'expected non-null result from sibling scan');
        assert.ok(result.endsWith('test-app'), `expected to find test-app, got ${result}`);
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('B134: findProjectRoot finds RN project as direct sibling (not nested)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fpr-flat-sibling-'));
  try {
    // tmp/
    //   plugin-repo/   (cwd)
    //   test-app/      (RN project, direct sibling)
    const pluginRepo = join(tmp, 'plugin-repo');
    const testApp = join(tmp, 'test-app');
    makeNonRnDir(pluginRepo, false);
    makeRnProject(testApp);

    withEnv({ RN_PROJECT_ROOT: null, CLAUDE_USER_CWD: null }, () => {
      withCwd(pluginRepo, () => {
        const result = findProjectRoot();
        assert.ok(
          result && result.endsWith('test-app'),
          `expected direct sibling match, got ${result}`,
        );
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findProjectRoot: RN_PROJECT_ROOT env takes precedence over cascade', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fpr-env-'));
  try {
    // Explicit RN project in env; random cwd elsewhere.
    const rnRoot = join(tmp, 'explicit-root');
    makeRnProject(rnRoot);
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere);

    withEnv({ RN_PROJECT_ROOT: rnRoot, CLAUDE_USER_CWD: null }, () => {
      withCwd(elsewhere, () => {
        const result = findProjectRoot();
        assert.ok(
          result && result.endsWith('explicit-root'),
          `expected env override, got ${result}`,
        );
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findProjectRoot: no false positive inside a controlled RN-free tree', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fpr-null-'));
  try {
    // Controlled layout — nothing under `tmp/` is an RN project:
    //   tmp/outer/
    //     inner/      (cwd)
    // Pass 1 walks up through inner → outer → tmp → /var/folders/... which MAY
    // contain unrelated RN projects from other mkdtemp dirs in shared /tmp.
    // So rather than asserting the overall return is null, we assert:
    // (a) the function does not throw
    // (b) if it does find a path, that path is NOT inside our controlled tmp
    //     tree (because we know our tree has no RN project).
    // This catches real false positives — if Pass 2/3 accidentally matched
    // a non-RN dir inside our tree, this test would fail.
    const outer = join(tmp, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(inner, { recursive: true });
    // Also create some non-RN clutter to exercise the skip logic.
    makeNonRnDir(join(outer, '.hidden-thing'), true);
    makeNonRnDir(join(outer, 'node_modules'), false);
    makeNonRnDir(join(outer, 'plain-non-rn'), true);

    withEnv({ RN_PROJECT_ROOT: null, CLAUDE_USER_CWD: null }, () => {
      withCwd(inner, () => {
        const result = findProjectRoot();
        if (result !== null) {
          // If we got a path back, it MUST be from outside our tree —
          // nothing inside tmp/ is an RN project.
          const resolvedTmp = tmp.replace(/^\/tmp\//, '/private/tmp/');
          assert.ok(
            !result.startsWith(tmp) && !result.startsWith(resolvedTmp),
            `false positive inside controlled tree: ${result}`,
          );
        }
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('B134: sibling-scan is breadth-first — direct sibling RN wins over grandchild RN', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fpr-bfs-'));
  try {
    // tmp/
    //   plugin-repo/                    (cwd)
    //   aaa-wrapper/                    (non-RN, alphabetically first sibling)
    //     nested-rn/                    (RN, grandchild of aaa-wrapper)
    //   zzz-real/                       (RN, direct sibling, alphabetically later)
    // Direct-sibling RN (zzz-real) must win over grandchild (aaa-wrapper/nested-rn)
    // because breadth-first traversal checks all direct siblings before recursing.
    const pluginRepo = join(tmp, 'plugin-repo');
    const aaaWrapper = join(tmp, 'aaa-wrapper');
    const nestedRn = join(aaaWrapper, 'nested-rn');
    const zzzReal = join(tmp, 'zzz-real');
    makeNonRnDir(pluginRepo, false);
    makeNonRnDir(aaaWrapper, false);
    makeRnProject(nestedRn);
    makeRnProject(zzzReal);

    withEnv({ RN_PROJECT_ROOT: null, CLAUDE_USER_CWD: null }, () => {
      withCwd(pluginRepo, () => {
        const result = findProjectRoot();
        assert.ok(result, 'expected to find an RN project');
        assert.ok(
          result.endsWith('zzz-real'),
          `breadth-first should pick direct sibling over grandchild, got ${result}`,
        );
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('B134: sibling-scan pick is alphabetically deterministic across readdir order', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fpr-det-'));
  try {
    // tmp/
    //   plugin-repo/     (cwd)
    //   aaa-rn/          (RN, alphabetically first)
    //   mmm-rn/          (RN, middle)
    //   zzz-rn/          (RN, last)
    // Expected: aaa-rn wins regardless of OS readdir ordering.
    const pluginRepo = join(tmp, 'plugin-repo');
    makeNonRnDir(pluginRepo, false);
    makeRnProject(join(tmp, 'aaa-rn'));
    makeRnProject(join(tmp, 'mmm-rn'));
    makeRnProject(join(tmp, 'zzz-rn'));

    withEnv({ RN_PROJECT_ROOT: null, CLAUDE_USER_CWD: null }, () => {
      withCwd(pluginRepo, () => {
        const result = findProjectRoot();
        assert.ok(
          result && result.endsWith('aaa-rn'),
          `alphabetical first should win, got ${result}`,
        );
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('B134: findProjectRoot skips node_modules and dotfiles during scan (perf + correctness)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fpr-skip-'));
  try {
    // tmp/
    //   plugin-repo/   (cwd)
    //   node_modules/fake-rn-project/  (should be SKIPPED even though it looks like RN)
    //   .hidden/fake-rn-project/        (should be SKIPPED)
    //   real-app/                       (RN project, should be FOUND)
    const pluginRepo = join(tmp, 'plugin-repo');
    const nodeModulesFake = join(tmp, 'node_modules', 'fake-rn-project');
    const hiddenFake = join(tmp, '.hidden', 'fake-rn-project');
    const realApp = join(tmp, 'real-app');
    makeNonRnDir(pluginRepo, false);
    makeRnProject(nodeModulesFake);
    makeRnProject(hiddenFake);
    makeRnProject(realApp);

    withEnv({ RN_PROJECT_ROOT: null, CLAUDE_USER_CWD: null }, () => {
      withCwd(pluginRepo, () => {
        const result = findProjectRoot();
        assert.ok(result, 'expected to find real-app');
        assert.ok(!result.includes('node_modules'), `should skip node_modules, got ${result}`);
        assert.ok(!result.includes('.hidden'), `should skip dotfiles, got ${result}`);
        assert.ok(result.endsWith('real-app'), `expected real-app, got ${result}`);
      });
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
