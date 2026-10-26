import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  runAndroid,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
} from '../../dist/runners/protocol.js';

const TEXT_SAMPLES = ['Friedrichstraße', '東京 👋🏽', 'quote: " slash: \\ newline:\n tab:\t', ''];

function setRunnerState(): void {
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'emulator-635',
    bundleId: 'dev.test',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 2,
  });
}

function healthResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      protocolVersion: 2,
      commands: [...REQUIRED_ANDROID_COMMANDS],
      capabilities: [...REQUIRED_ANDROID_FEATURES],
    }),
  );
}

afterEach(() => {
  _setAndroidRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
});

test('Android runner transport declares UTF-8 and preserves arbitrary JSON text exactly', async () => {
  const received: string[] = [];
  setRunnerState();
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health')) return healthResponse();

    const headers = new Headers(init?.headers);
    assert.equal(headers.get('content-type'), 'application/json; charset=UTF-8');
    const body = JSON.parse(String(init?.body)) as { text: string };
    received.push(body.text);
    return new Response(JSON.stringify({ ok: true, data: { typed: true } }));
  });

  for (const text of TEXT_SAMPLES) {
    const result = await runAndroid({
      command: 'fill',
      bundleId: 'dev.test',
      text,
      snapshotIdentifier: 'address-input',
      snapshotElementType: 'android.widget.EditText',
    });
    assert.equal(result.isError, undefined);
  }

  assert.deepEqual(received, TEXT_SAMPLES);
});

test('Android runner transport refuses a failed Unicode fill once without disclosing its text', async () => {
  const secret = 'Friedrichstraße "東京" 👋🏽';
  const diagnostics: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  let commandPosts = 0;
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => diagnostics.push(args.map(String).join(' '));
  setRunnerState();
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health')) return healthResponse();
    commandPosts += 1;
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: 'SET_TEXT_REJECTED',
          message: 'Bound field ignored ACTION_SET_TEXT.',
          mutation: 'none',
        },
      }),
    );
  });

  try {
    const result = await runAndroid({
      command: 'fill',
      bundleId: 'dev.test',
      text: secret,
      snapshotIdentifier: 'address-input',
      snapshotElementType: 'android.widget.EditText',
    });

    assert.equal(result.isError, true);
    assert.equal(commandPosts, 1);
    assert.doesNotMatch(result.content[0]!.text, new RegExp(secret));
    assert.doesNotMatch(diagnostics.join('\n'), new RegExp(secret));
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});
