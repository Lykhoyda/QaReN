// B59 follow-up: grammar guard against Maestro CLI flag drift.
//
// Why this test exists: during the B59 code review (2026-04-24), Gemini
// and Codex both caught — independently at conf 97+ — that the initial
// Tier 2 argv used `--device-type`, a flag that does not exist in
// Maestro CLI v2.x. The unit tests passed because they only asserted
// argv shape, never executed `maestro`. The fix would have shipped
// broken if multi-review hadn't caught it.
//
// This integration test spawns the real `maestro test --help` and
// verifies:
//   1. The flags our code relies on (`--platform`, `-p`) appear in the help
//   2. The flag we accidentally invented (`--device-type`) does NOT appear
//   3. The subcommand (`test`) is still present as the entry point we use
//
// If Maestro CLI changes its flag grammar (rename, removal, deprecation),
// this test fails loudly and we can adjust the dispatch's buildArgs
// BEFORE shipping a broken release.
//
// Gracefully skips when `maestro` is not installed — CI machines without
// the JDK-based CLI should not be forced to install it just to run this
// guard. Local dev machines that ship Maestro flows will exercise it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

let maestroProbe;
function maestroAvailable() {
  maestroProbe ??=
    spawnSync('maestro', ['--version'], { encoding: 'utf8', timeout: 30_000 }).status === 0;
  return maestroProbe;
}

function captureHelp() {
  const r = spawnSync('maestro', ['test', '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  // Maestro's CLI writes its Usage line to stdout; version info goes to
  // stderr. The `--help` handler in clikt-based CLIs typically exits 0
  // but some versions exit 1 — accept either as long as stdout contains
  // the usage block.
  const text = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
  return { text, status: r.status };
}

test('B59 grammar guard: `maestro test` subcommand exists', { skip: !maestroAvailable() }, () => {
  const { text } = captureHelp();
  assert.match(
    text,
    /Usage: maestro test/i,
    `Expected 'Usage: maestro test' header in --help output.\nActual first 200 chars: ${text.slice(0, 200)}`,
  );
});

test(
  'B59 grammar guard: --platform flag our code uses is still documented',
  { skip: !maestroAvailable() },
  () => {
    // Our dispatch builds `['test', '--platform', platform, flowFile]`.
    // Maestro v2.x documents the flag as either `-p=<platform>` or the
    // long-form `--platform=<platform>`; clikt-based parsers accept both
    // the `-p` short form and the `--platform` long form. We assert at
    // least one form is present — either would keep our dispatch working.
    const { text } = captureHelp();
    const hasLongForm = /--platform/.test(text);
    const hasShortForm = /\[-p=<platform>\]|-p,\s*--platform|-p\s+<platform>|-p=<platform>/.test(
      text,
    );
    assert.ok(
      hasLongForm || hasShortForm,
      `Neither '--platform' nor '-p' platform flag found in maestro test --help.\n` +
        `Dispatch argv would break. First 500 chars:\n${text.slice(0, 500)}`,
    );
  },
);

test(
  'B59 grammar guard: --device-type flag must NOT exist (pre-ship bug regression)',
  { skip: !maestroAvailable() },
  () => {
    // This is the exact bug Gemini (conf 97) + Codex (conf 98) caught on
    // 2026-04-24. Initial draft used --device-type; if maestro ever
    // introduces that flag AND we haven't updated our dispatch, this test
    // will fail and signal "reconsider argv choice." More importantly, if
    // someone re-introduces --device-type in a refactor thinking it's the
    // platform selector, live maestro will reject it and this test fails.
    const { text } = captureHelp();
    assert.doesNotMatch(
      text,
      /--device-type/,
      `Unexpected: --device-type appears in maestro test --help. ` +
        `Our dispatch uses --platform; if you intend to switch, update ` +
        `packages/qaren-core/src/handlers/maestro-dispatch.ts buildArgs.`,
    );
  },
);

test(
  'B59 grammar guard: `maestro` accepts --platform ios without parse error (smoke)',
  { skip: !maestroAvailable() },
  () => {
    // Sanity smoke: invoke maestro with our exact argv prefix against a
    // non-existent flow. The flag must parse cleanly — the CLI must reach
    // the "flow file not found" branch, not fail at "Unknown option."
    const r = spawnSync('maestro', ['test', '--platform', 'ios', '/tmp/__does-not-exist__.yaml'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const combined = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
    assert.doesNotMatch(
      combined,
      /Unknown option/,
      `maestro CLI rejected our argv — dispatch would fail in production.\n` +
        `Combined output: ${combined.slice(0, 500)}`,
    );
    // We DO expect a "flow not found" type error — that proves the flag
    // parsed and we reached the flow-file lookup step.
    assert.match(
      combined,
      /(Flow path does not exist|Flow not found|No such file|does not exist)/i,
      `Expected flow-not-found error (proving flag parsing succeeded). Got:\n${combined.slice(0, 500)}`,
    );
  },
);

test('B59 grammar guard: when `maestro` is missing, all guards skip cleanly', () => {
  // Meta-test: documents that this whole file is opt-in. The `skip:
  // !maestroAvailable()` guard on each test above fires when maestro
  // isn't installed. This test verifies the detection primitive itself
  // works — any machine that runs the suite sees a truthy/falsy answer.
  const avail = maestroAvailable();
  assert.equal(typeof avail, 'boolean');
  // No maestro-specific assertions here — the point is documenting the
  // skip contract for future readers.
});
