import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import {
  androidFirstScreen,
  androidFirstViewsFromActivityTop,
} from '../../../dist/handlers/device-session.js';
import { withCancellation } from '../../../dist/domain/cancellation.js';

const appId = 'com.example.synthetic';
const serial = 'synthetic-android';
const fixture = async (name: string) =>
  readFile(new URL(`../../fixtures/android-first-views/${name}.txt`, import.meta.url), 'utf8');

// Fixture subprocesses never forward an invocation to a real adb binary or server.
async function delayedFixtureAdb(t: TestContext, delayMs: number) {
  const directory = await mkdtemp(join(tmpdir(), 'qaren-first-views-'));
  const previousPath = process.env.PATH;
  const loaded = await fixture('first-views');
  const executable = join(directory, 'adb');
  await writeFile(
    executable,
    `#!${process.execPath}
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(['-s', serial, 'shell', 'dumpsys', 'activity', 'top']))}) process.exit(2);
    setTimeout(() => process.stdout.write(${JSON.stringify(loaded)}), ${delayMs});
  `,
  );
  await chmod(executable, 0o700);
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
}

function commandStub(
  t: TestContext,
  respond: (options: { timeout: number; signal?: AbortSignal }) => Promise<string>,
) {
  let calls = 0;
  const execute = (() => {
    throw new Error('use the promise boundary');
  }) as typeof childProcess.execFile;
  Object.defineProperty(execute, promisify.custom, {
    value: async (
      file: string,
      args: string[],
      options: { timeout: number; signal?: AbortSignal },
    ) => {
      calls++;
      assert.equal(file, 'adb');
      assert.deepEqual(args, ['-s', serial, 'shell', 'dumpsys', 'activity', 'top']);
      return { stdout: await respond(options), stderr: '' };
    },
  });
  const original = childProcess.execFile;
  childProcess.execFile = execute;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  });
  return () => calls;
}

test('H7a: the retained loading root is not a mounted React view', async () => {
  assert.equal(androidFirstViewsFromActivityTop(await fixture('loading'), appId), 'loading');
});

test('H7b: two first views release immediately without a count threshold or previous read', async (t) => {
  const output = await fixture('first-views');
  assert.equal(androidFirstViewsFromActivityTop(output, appId), 'loaded');
  const calls = commandStub(t, async ({ timeout }) => {
    assert.equal(timeout, 5000);
    return output;
  });
  assert.equal(await androidFirstScreen(appId, serial), 'loaded');
  assert.equal(calls(), 1);
});

test('H7c: the retained rendered hierarchy is loaded', async () => {
  assert.equal(androidFirstViewsFromActivityTop(await fixture('rendered'), appId), 'loaded');
});

test('H7d: the retained dev-client launcher remains loading', async () => {
  assert.equal(androidFirstViewsFromActivityTop(await fixture('launcher'), appId), 'loading');
});

test('H7e: complete captures keep foreign React views out of the loading app section', async () => {
  const loading = await fixture('complete-load');
  const rendered = await fixture('complete-after-first-screen');
  assert.equal(androidFirstViewsFromActivityTop(loading, appId), 'loading');
  assert.equal(androidFirstViewsFromActivityTop(rendered, appId), 'loaded');

  // Keep every task from the complete rendered capture, replacing only the app's
  // last task with its complete loading task. Neither capture has foreign React
  // views, so the additional foreign task below is deliberately synthetic.
  const appTask = `TASK 1000:${appId} id=3 userId=0`;
  const renderedStart = rendered.indexOf(appTask);
  const loadingStart = loading.indexOf(appTask);
  assert.ok(renderedStart > 0 && loadingStart > 0);
  const foreignApp = 'com.example.foreign';
  const mixed = `${rendered.slice(0, renderedStart)}${loading.slice(loadingStart)}
TASK 1000:${foreignApp} id=4 userId=0
  ACTIVITY ${foreignApp}/.MainActivity 0000001 pid=1004
    View Hierarchy:
      com.facebook.react.views.view.ReactViewGroup{0000001}
`;
  assert.equal(androidFirstViewsFromActivityTop(mixed, foreignApp), 'loaded');
  assert.equal(androidFirstViewsFromActivityTop(mixed, appId), 'loading');
});

test('H7f: no app section, empty output and an unreadable activity are unknown', async () => {
  const output = await fixture('first-views');
  assert.equal(androidFirstViewsFromActivityTop(output, `${appId}.other`), 'unknown');
  assert.equal(androidFirstViewsFromActivityTop('', appId), 'unknown');
  assert.equal(androidFirstViewsFromActivityTop(await fixture('unreadable'), appId), 'unknown');
});

test('H7f: an adb error is unknown', async (t) => {
  const calls = commandStub(t, async () => {
    throw new Error('fixture command failed');
  });
  assert.equal(await androidFirstScreen(appId, serial), 'unknown');
  assert.equal(calls(), 1);
});

test(
  'H7f: a read slower than three seconds still completes inside five seconds',
  { timeout: 10_000 },
  async (t) => {
    await delayedFixtureAdb(t, 3500);
    assert.equal(await androidFirstScreen(appId, serial), 'loaded');
  },
);

test('H7f: a read exceeding five seconds is unknown', { timeout: 10_000 }, async (t) => {
  await delayedFixtureAdb(t, 6000);
  assert.equal(await androidFirstScreen(appId, serial), 'unknown');
});

test('H7f: a cancellation propagates and reaches the subprocess options', async (t) => {
  const controller = new AbortController();
  const reason = new Error('fixture cancellation');
  commandStub(t, async ({ signal }) => {
    assert.ok(signal);
    const pending = new Promise<string>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
    controller.abort(reason);
    return pending;
  });
  await assert.rejects(
    withCancellation(controller.signal, () => androidFirstScreen(appId, serial)),
    (error) => error === reason,
  );
});

test('H7: invalid or absent targets issue no command', async (t) => {
  const calls = commandStub(t, async () => {
    throw new Error('must not execute');
  });
  for (const invalid of ['', 'x;echo', 'x/y', 'x-y', 'x\ny'])
    assert.equal(await androidFirstScreen(invalid, serial), 'unknown');
  for (const invalid of ['', 'a b', ';x', 'x\ny', 'x'.repeat(129), undefined])
    assert.equal(await androidFirstScreen(appId, invalid as string), 'unknown');
  assert.equal(calls(), 0);
});

test('H7g: the complete force-stop-during-load capture has no app section and reads unknown', async () => {
  // Taken 4.7 s after force-stop during load. This covers an absent section;
  // it does not claim to reproduce a spontaneous crash or a retained dead task.
  assert.equal(
    androidFirstViewsFromActivityTop(await fixture('complete-after-kill'), appId),
    'unknown',
  );
});
