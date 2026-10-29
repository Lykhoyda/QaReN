import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { probeIosExternalRunnerStrict } from '../../../dist/runners/external-runner-detect.js';

const device = 'AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB';
const prompt = 'word '.repeat(4_000);
const ps = (stdout: string) => (async () => ({ stdout, stderr: '' })) as unknown as typeof execFile;

test('an unreadable unrelated process does not prevent fresh-install admission', async () => {
  for (const unreadable of [
    async () => null,
    async () => {
      throw new Error('process exited or identity is inaccessible');
    },
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(
        ps(`1 /sbin/launchd\n20 /opt/bin/agent --prompt ${prompt}\n`),
        device,
        unreadable,
      ),
      'clear',
    );
  }
});

test('an unreadable relevant process still prevents fresh-install admission', async () => {
  for (const command of [
    'xcodebuild test -scheme Example',
    '/usr/bin/java -classpath lib maestro.cli.AppKt mcp',
    '/opt/bin/agent review /tmp/WebDriverAgent',
    `/opt/bin/agent --prompt ${prompt}/tmp/QaReN-Runner`,
    `/usr/bin/node -e ${prompt}/tmp/XCTRunner`,
    '/bin/bash --unknown-option /tmp/script.sh',
  ]) {
    for (const unreadable of [
      async () => null,
      async () => {
        throw new Error('process exited or identity is inaccessible');
      },
    ]) {
      assert.equal(
        await probeIosExternalRunnerStrict(
          ps(`1 /sbin/launchd\n20 ${command}\n`),
          device,
          unreadable,
        ),
        'unknown',
        command.slice(0, 100),
      );
    }
  }
});
