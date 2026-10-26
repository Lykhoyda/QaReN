// GH #112: regression test for sidecarPathFor's basename extraction.
// The original implementation used `split('/').pop()` which returned the
// entire backslash-containing path as a single segment on Windows,
// producing absurd `join(parent, 'state', <full-windows-path>)` deep
// directory trees. The fix splits on both separators explicitly.
//
// We run this on a POSIX runtime (darwin/linux) and assert that the
// EXTRACTED basename is correct for Windows-style input regardless of
// platform-native path module behavior. Parent-dir resolution on a
// Windows path is platform-dependent and out of scope — the goal here is
// only "the basename portion is correctly extracted."
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD_PATH = '../../dist/domain/sidecar-io.js';

test('sidecarPathFor: POSIX-style path produces expected sidecar path', async () => {
  const { sidecarPathFor } = await import(MOD_PATH);
  const result = sidecarPathFor('/Users/me/project/.qaren/actions/wizard-create-task.yaml');
  assert.equal(result, '/Users/me/project/.qaren/state/wizard-create-task.state.json');
});

test('sidecarPathFor: .yml extension also handled', async () => {
  const { sidecarPathFor } = await import(MOD_PATH);
  const result = sidecarPathFor('/a/b/actions/short.yml');
  assert.equal(result, '/a/b/state/short.state.json');
});

test('sidecarPathFor: Windows-style backslash input extracts basename correctly (no embedded path in result)', async () => {
  // GH #112: this is the regression case. The buggy code produced a base
  // string containing the entire backslash path, which join() then
  // embedded into a deeply-nested directory tree. The fix's contract is
  // that the result's filename portion is just `<id>.state.json`, not
  // the full path. We assert on the END of the result string so we don't
  // depend on platform-native dirname/join behavior for Windows inputs
  // on a POSIX test runtime.
  const { sidecarPathFor } = await import(MOD_PATH);
  const result = sidecarPathFor('C:\\Users\\foo\\project\\.qaren\\actions\\my-action.yaml');
  // The trailing segment must be `my-action.state.json`, not the full
  // backslash-containing path.
  assert.match(
    result,
    /[/\\]my-action\.state\.json$/,
    `result did not end with clean basename: ${result}`,
  );
  // The result must NOT contain the entire Windows-style filename glued in.
  assert.ok(
    !result.includes('C:\\Users\\foo\\project\\.qaren\\actions\\my-action.state.json'),
    `result still contains the full Windows path: ${result}`,
  );
});

test('sidecarPathFor: mixed forward+backward slash input extracts basename correctly', async () => {
  // Defensive: someone hand-builds a path with both separators (e.g.
  // pre-processing wasn't normalized). Should still extract the trailing
  // segment cleanly.
  const { sidecarPathFor } = await import(MOD_PATH);
  const result = sidecarPathFor('/a/b\\c/d\\my-action.yaml');
  assert.match(result, /[/\\]my-action\.state\.json$/, `mixed-separator result: ${result}`);
  assert.ok(!result.includes('a/b\\c/d\\my-action.state.json'));
});
