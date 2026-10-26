import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULE_NAMES_EXPRESSION,
  SCRIPT_URL_EXPRESSION,
  isAppModule,
  prove,
} from '../../../dist/qa/prove.js';

const WORKTREE = '/work/app';
const tree = new Set([
  `${WORKTREE}/index.js`,
  `${WORKTREE}/src/App.tsx`,
  `${WORKTREE}/src/screens/Home.tsx`,
]);
const fileExists = (path: string): boolean => tree.has(path);

function client(scriptURL: string | null, names: string[] | { error: string }) {
  return {
    async evaluate(expression: string) {
      if (expression === SCRIPT_URL_EXPRESSION) return { value: scriptURL };
      if (expression === MODULE_NAMES_EXPRESSION) {
        return { value: JSON.stringify('error' in names ? names : { count: names.length, names }) };
      }
      return { error: `unexpected expression ${expression.slice(0, 40)}` };
    },
  };
}

const bundled = [
  'node_modules/react-native/Libraries/Core/InitializeCore.js',
  'index.js',
  'src/App.tsx',
  'src/screens/Home.tsx',
  '../shared/node_modules/lib/index.js',
];

test('a scriptURL on the run port and a registry under the worktree prove the bundle', async () => {
  const outcome = await prove(
    { ...client('http://localhost:8791/index.bundle?platform=ios&dev=true', bundled), fileExists },
    { metroPort: 8791, worktree: WORKTREE },
  );
  assert.deepEqual(outcome, {
    ok: true,
    scriptURL: 'http://localhost:8791/index.bundle?platform=ios&dev=true',
    appModules: 3,
  });
});

test('a scriptURL on another port refuses with METRO_ORIGIN_MISMATCH before reading the registry', async () => {
  let registryRead = false;
  const c = client('http://localhost:8081/index.bundle?platform=ios&dev=true', bundled);
  const outcome = await prove(
    {
      evaluate: async (expression) => {
        if (expression === MODULE_NAMES_EXPRESSION) registryRead = true;
        return c.evaluate(expression);
      },
      fileExists,
    },
    { metroPort: 8791, worktree: WORKTREE },
  );
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'METRO_ORIGIN_MISMATCH');
  assert.match(
    !outcome.ok ? outcome.message : '',
    /localhost:8081 is not the run's Metro port 8791/,
  );
  assert.equal(registryRead, false);
});

test('a module registry under another root refuses with METRO_ORIGIN_MISMATCH', async () => {
  const outcome = await prove(
    { ...client('http://127.0.0.1:8791/index.bundle', bundled), fileExists },
    { metroPort: 8791, worktree: '/work/other-checkout' },
  );
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.message : '', /built from another tree: 3 of 3 app modules/);
  assert.match(!outcome.ok ? outcome.message : '', /index\.js, src\/App\.tsx/);
});

test('a client without a scriptURL or without a dev registry cannot be proven', async () => {
  const noScript = await prove(
    { ...client(null, bundled), fileExists },
    { metroPort: 8791, worktree: WORKTREE },
  );
  assert.match(!noScript.ok ? noScript.message : '', /no scriptURL/);
  const noRegistry = await prove(
    { ...client('http://127.0.0.1:8791/index.bundle', { error: 'no-registry' }), fileExists },
    { metroPort: 8791, worktree: WORKTREE },
  );
  assert.match(!noRegistry.ok ? noRegistry.message : '', /no dev module registry/);
  const onlyVendor = await prove(
    { ...client('http://127.0.0.1:8791/index.bundle', [bundled[0]]), fileExists },
    { metroPort: 8791, worktree: WORKTREE },
  );
  assert.match(!onlyVendor.ok ? onlyVendor.message : '', /registers no app modules/);
});

test('app modules exclude vendored, out-of-root and virtual names', () => {
  assert.equal(isAppModule('src/App.tsx'), true);
  assert.equal(isAppModule('index.js'), true);
  assert.equal(isAppModule('node_modules/react/index.js'), false);
  assert.equal(isAppModule('packages/ui/node_modules/x/index.js'), false);
  assert.equal(isAppModule('../sibling/src/App.tsx'), false);
  assert.equal(isAppModule('__prelude__'), false);
  assert.equal(isAppModule('src/logo.png'), false);
});

test('a registry name that escapes the worktree through an embedded .. is a mismatch even when the file exists', async () => {
  const escaped = new Set([...tree, '/work/other/App.tsx']);
  const outcome = await prove(
    {
      ...client('http://localhost:8791/index.bundle?platform=ios&dev=true', [
        'index.js',
        'src/../../other/App.tsx',
      ]),
      fileExists: (path: string) => escaped.has(path),
    },
    { metroPort: 8791, worktree: WORKTREE },
  );
  assert.equal(outcome.ok, false);
  assert.match(String((outcome as { message?: string }).message), /not under \/work\/app/);
});

test('cancellation during either proof evaluation rejects without another read', async () => {
  const { createStop } = await import('../../../dist/qa/stop.js');
  for (const cancelAt of [1, 2]) {
    const stop = createStop();
    let reads = 0;
    let ready!: () => void;
    let release!: (value: { value: string }) => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const deps = {
      fileExists,
      evaluate: async () => {
        reads++;
        if (reads === cancelAt) {
          ready();
          return new Promise<{ value: string }>((resolve) => {
            release = resolve;
          });
        }
        return { value: 'http://localhost:8081/index.bundle' };
      },
    };
    const pending = stop.track(() => prove(deps, { metroPort: 8081, worktree: WORKTREE }));
    const refused = assert.rejects(pending, /RUN_CANCELLED/);
    await started;
    stop.begin();
    release({
      value:
        cancelAt === 1
          ? 'http://localhost:8081/index.bundle'
          : JSON.stringify({ count: 1, names: ['index.js'] }),
    });
    await refused;
    await stop.drained(1000);
    assert.equal(reads, cancelAt);
  }
});
