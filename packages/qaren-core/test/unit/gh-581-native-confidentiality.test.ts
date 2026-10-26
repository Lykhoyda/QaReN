import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  runAndroid,
  startAndroidRunner,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
} from '../../dist/runners/protocol.js';

test('Android runner fill keeps its privacy canary out of diagnostics and public output', async () => {
  const canary = 'RN_FILL_LOGCAT_PRIVACY_CANARY_581';
  const diagnostics: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => diagnostics.push(args.map(String).join(' '));
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'emulator-581',
    bundleId: 'dev.test',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 1,
  });
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health')) {
      return new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: 1,
          commands: [...REQUIRED_ANDROID_COMMANDS],
          capabilities: [...REQUIRED_ANDROID_FEATURES],
        }),
      );
    }
    return new Response(JSON.stringify({ ok: true, data: { typed: true } }));
  });

  try {
    const result = await runAndroid({
      command: 'fill',
      bundleId: 'dev.test',
      text: canary,
      snapshotIdentifier: 'field',
      snapshotElementType: 'android.widget.EditText',
    });
    assert.equal(result.isError, undefined);
    assert.doesNotMatch(result.content[0]!.text, new RegExp(canary));
    assert.doesNotMatch(diagnostics.join('\n'), new RegExp(canary));
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    _setAndroidRunnerStateForTest(null);
    _setFetchForTest(globalThis.fetch);
  }
});

test('Android exact fill timeout is not replayed and runner health remains probeable', async () => {
  let healthProbes = 0;
  const commands: string[] = [];
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'emulator-581',
    bundleId: 'dev.test',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 1,
  });
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) {
      healthProbes += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: 1,
          commands: [...REQUIRED_ANDROID_COMMANDS],
          capabilities: [...REQUIRED_ANDROID_FEATURES],
        }),
      );
    }
    const body = JSON.parse(String(init?.body)) as { command: string; commandId: string };
    commands.push(body.command);
    if (body.command === 'fill') {
      assert.ok(init?.signal);
      return await new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    assert.equal(body.command, 'status');
    return new Response(
      JSON.stringify({
        ok: true,
        data: { commandId: body.commandId, state: 'unknown' },
      }),
    );
  });

  try {
    await assert.rejects(
      runAndroid({
        command: 'fill',
        deviceId: 'emulator-581',
        bundleId: 'dev.test',
        text: 'timeout-canary',
        snapshotIdentifier: 'field',
        snapshotElementType: 'android.widget.EditText',
      }),
      /RUNNER_TIMEOUT/,
    );
    assert.deepEqual(commands, ['fill', 'status']);

    await startAndroidRunner('emulator-581', 'dev.test');
    assert.equal(healthProbes, 2);
    assert.deepEqual(commands, ['fill', 'status']);
  } finally {
    _setAndroidRunnerStateForTest(null);
    _setFetchForTest(globalThis.fetch);
  }
});
