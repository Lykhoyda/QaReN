import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const native = new URL(
  '../../../../rn-fast-runner/RnFastRunner/RnFastRunnerUITests/',
  import.meta.url,
);
const read = (name: string) =>
  readFileSync(new URL(`RnFastRunnerTests+${name}.swift`, native), 'utf8');
function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing production section: ${start}`);
  return source.slice(from, to);
}

test('Swift V2 decodes explicit integer budgets and rejects beyond the command reserve without clamping', (t) => {
  const available = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT')
    return t.skip('Swift toolchain unavailable');
  assert.equal(available.status, 0, available.stderr);
  const models = read('Models');
  const execution = read('CommandExecution');
  const guard = section(
    execution,
    '      guard command.command == .snapshot,',
    '      let bundleId = appId.',
  );
  const result = spawnSync('swift', ['-'], {
    encoding: 'utf8',
    timeout: 90_000,
    input: `
import Foundation
${section(models, 'enum CommandType:', 'struct Response:')}
${section(models, 'struct SnapshotRect:', 'struct SnapshotNode:')}
${section(models, 'struct PlatformPresenceCapture:', 'struct PlatformPresenceObservation:')}
struct Response { let ok: Bool; var error: ErrorPayload? = nil }
struct ErrorPayload { let code: String; let message: String }
func admit(_ command: Command) -> Response {
  let mainThreadExecutionTimeout: TimeInterval = 30
${guard}
  precondition(presenceBudgetMs == command.presenceBudgetMs)
  return Response(ok: true)
}
let decoder = JSONDecoder()
func command(_ budget: String?) -> Command? {
  let field = budget.map { ",\\"presenceBudgetMs\\":\\($0)" } ?? ""
  return try? decoder.decode(Command.self, from: Data("{\\"command\\":\\"snapshot\\",\\"appBundleId\\":\\"test.app\\",\\"platformPresence\\":true\\(field)}".utf8))
}
for budget in [1, 20_000, 25_000] {
  let value = command(String(budget))!
  precondition(admit(value).ok)
  precondition(value.presenceBudgetMs == budget)
}
for budget in [nil, "null", "0", "-1", "25001", "30000"] as [String?] {
  precondition(!admit(command(budget)!).ok)
}
for budget in ["true", "false", "1.5", "\\"20000\\"", "{}", "[]", "1e100"] {
  precondition(command(budget) == nil)
}
let capture = PlatformPresenceCapture(
  version: 2, source: "xcui-live", captureId: "capture", appId: "test.app", generation: 7,
  startedUptimeMs: 100, endedUptimeMs: 200, enumeration: "raw-unfiltered", complete: true,
  appliedBudgetMs: 20_000
)
let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(capture)) as! [String: Any]
precondition(json["version"] as? Int == 2)
precondition(json["appliedBudgetMs"] as? Int == 20_000)
`,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
