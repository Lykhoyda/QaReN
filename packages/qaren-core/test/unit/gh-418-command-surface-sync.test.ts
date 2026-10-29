import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRunnerCompatibility,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_ANDROID_COMMANDS,
  RUNNER_PROTOCOL_VERSION,
} from '../../dist/runners/protocol.js';

for (const [platform, commands] of [
  ['iOS', REQUIRED_IOS_COMMANDS],
  ['Android', REQUIRED_ANDROID_COMMANDS],
] as const) {
  test(`gh-418 ${platform}: required commands have no duplicates`, () => {
    assert.equal(new Set(commands).size, commands.length);
  });

  test(`gh-418 ${platform}: complete command surface is compatible`, () => {
    assert.deepEqual(
      classifyRunnerCompatibility(
        { protocolVersion: RUNNER_PROTOCOL_VERSION, commands: [...commands] },
        null,
        commands,
      ),
      { compatible: true },
    );
  });

  test(`gh-418 ${platform}: absent commands refuse with the full missing surface`, () => {
    assert.deepEqual(
      classifyRunnerCompatibility({ protocolVersion: RUNNER_PROTOCOL_VERSION }, null, commands),
      { compatible: false, reason: 'missing-commands', missing: [...commands] },
    );
  });

  for (const missing of commands) {
    test(`gh-418 ${platform}: missing ${missing} refuses with exactly that command`, () => {
      assert.deepEqual(
        classifyRunnerCompatibility(
          {
            protocolVersion: RUNNER_PROTOCOL_VERSION,
            commands: commands.filter((command) => command !== missing),
          },
          null,
          commands,
        ),
        { compatible: false, reason: 'missing-commands', missing: [missing] },
      );
    });
  }
}
