import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import {
  buildAndroidDevClientStartArgv,
  isAndroidDevClientLaunchUrl,
  startAndroidDevClient,
} from '../../../dist/handlers/app-lifecycle.js';
import { withCancellation } from '../../../dist/domain/cancellation.js';

const APP = 'com.example.synthetic';
const SERIAL = 'synthetic-android';
const OLD_URL_8081 =
  'exp+synthetic://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F%3FdisableOnboarding%3D1';
const URL_8081 = `${OLD_URL_8081}&disableFab=1&__expo_disable_fab=1&__expo_disable_auto_launch=1`;

// The promisified execFile of android-app-process.test.ts, answering each adb call in turn.
function adb(t: TestContext, answers: ((args: string[], options: any) => unknown)[]) {
  const calls: { args: string[]; options: any }[] = [];
  const execute = (() => {
    throw new Error('use the promise boundary');
  }) as typeof childProcess.execFile;
  Object.defineProperty(execute, promisify.custom, {
    value: async (file: string, args: string[], options: any) => {
      assert.equal(file, 'adb');
      calls.push({ args, options });
      const answer = answers.shift();
      assert.ok(answer, 'no more adb answers were scripted');
      return answer(args, options);
    },
  });
  const original = childProcess.execFile;
  childProcess.execFile = execute;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  });
  return calls;
}
const fail = (fields: Record<string, unknown>) => () => {
  throw Object.assign(new Error('Command failed'), fields);
};

test('P2: the dev-client start is the CLI argv, sent once', async (t) => {
  const argv = [
    '-s',
    SERIAL,
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '--ez',
    'EXDevMenuDisableAutoLaunch',
    'true',
    '-d',
    `'${URL_8081}'`,
    APP,
  ];
  for (const [name, answer, expected] of [
    ['exit 0', () => ({ stdout: 'Starting: Intent', stderr: '' }), 'sent'],
    ['killed at its limit', fail({ code: null, killed: true, signal: 'SIGTERM' }), 'timed_out'],
  ] as const) {
    await t.test(name, async (t) => {
      const calls = adb(t, [answer]);
      assert.equal(await startAndroidDevClient(APP, SERIAL, URL_8081), expected);
      assert.deepEqual(
        calls.map(({ args }) => args),
        [argv],
      );
      assert.equal(calls[0].options.timeout, 60_000);
    });
  }
  await t.test('an output overflow rejects and is not a timeout', async (t) => {
    const calls = adb(t, [
      fail({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }),
    ]);
    await assert.rejects(startAndroidDevClient(APP, SERIAL, URL_8081));
    assert.equal(calls.length, 1);
  });
  await t.test('exit 1 rejects', async (t) => {
    adb(t, [fail({ code: 1, stdout: '', stderr: 'Error: Activity not started' })]);
    await assert.rejects(startAndroidDevClient(APP, SERIAL, URL_8081));
  });
  await t.test('an abort is rethrown', async (t) => {
    const controller = new AbortController();
    adb(t, [
      () => {
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    ]);
    await assert.rejects(
      withCancellation(controller.signal, () => startAndroidDevClient(APP, SERIAL, URL_8081)),
      { name: 'AbortError' },
    );
  });
  await t.test('a bad app id, serial, or launch URL quote runs no command', async (t) => {
    const calls = adb(t, []);
    for (const [appId, serial, url] of [
      ['com.example;rm', SERIAL, URL_8081],
      [APP, '', URL_8081],
      [APP, 'a b', URL_8081],
      [APP, SERIAL, `${URL_8081}'`],
    ])
      await assert.rejects(startAndroidDevClient(appId, serial, url));
    assert.throws(
      () => buildAndroidDevClientStartArgv(APP, SERIAL, `${URL_8081}'`),
      /the dev-client start needs a launch URL without a quote/,
    );
    assert.deepEqual(calls, []);
  });
  for (const [url, port, ok] of [
    [URL_8081, 8081, true],
    [URL_8081, 8082, false],
    [URL_8081.replace('exp+synthetic', '1bad'), 8081, false],
    [URL_8081.replace('127.0.0.1', '10.0.2.2'), 8081, false],
    [URL_8081 + '%26x%3D1', 8081, false],
    [OLD_URL_8081, 8081, false],
    [`${OLD_URL_8081}&__expo_disable_fab=1&disableFab=1&__expo_disable_auto_launch=1`, 8081, false],
    [`${OLD_URL_8081}&disableFab=1&__expo_disable_fab=1`, 8081, false],
    [`${OLD_URL_8081}&disableFab=1&__expo_disable_auto_launch=1`, 8081, false],
    [`${OLD_URL_8081}&__expo_disable_fab=1&__expo_disable_auto_launch=1`, 8081, false],
    [
      'rndatest://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8791%2F%3FdisableOnboarding%3D1&disableFab=1&__expo_disable_fab=1&__expo_disable_auto_launch=1',
      8791,
      true,
    ],
    [42, 8081, false],
  ] as const)
    assert.equal(isAndroidDevClientLaunchUrl(url, port), ok, String(url));
});
