import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildTerminalEvidence } from '../../dist/domain/maestro-step-parser.js';
import { parseMaestroFailure } from '../../dist/domain/maestro-error-parser.js';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('../fixtures/gh-588-fake-pinned-engine.ts', import.meta.url));

async function fixtureOutput(variant: string): Promise<string> {
  try {
    await run(process.execPath, [fixture, variant], { maxBuffer: 1024 * 1024 });
    throw new Error('fixture unexpectedly passed');
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
}

test('GH-588 Slice B: >4KB pre-step WDA death classifies from full terminal evidence', async () => {
  const output = await fixtureOutput('bootstrap');
  assert.ok(output.length > 4_000, 'sub-4KB parser fixtures are a rejected false proof');
  const terminal = buildTerminalEvidence(output);
  const failure = parseMaestroFailure(output.slice(0, 4_000), terminal);
  assert.equal(terminal.exitClass, 'before-first-step');
  assert.equal(failure.kind, 'WDA_BOOTSTRAP_FAILED');
  assert.match(failure.kind === 'WDA_BOOTSTRAP_FAILED' ? failure.detail : '', /WDA start failed/);
});

test('GH-588 Slice B: a healthy WDA banner never manufactures a bootstrap failure', async () => {
  const output = await fixtureOutput('benign');
  assert.ok(output.length > 4_000, 'sub-4KB parser fixtures are a rejected false proof');
  const terminal = buildTerminalEvidence(output);
  assert.equal(terminal.exitClass, 'before-first-step');
  assert.equal(terminal.bootstrapEvidence, undefined);
  assert.equal(parseMaestroFailure(output.slice(0, 4_000), terminal).kind, 'UNKNOWN');
});

for (const [variant, kind] of [
  ['selector', 'SELECTOR_NOT_FOUND'],
  ['assertion', 'ASSERTION_FAILED'],
  ['timeout', 'TIMEOUT'],
] as const) {
  test(`GH-588 Slice B: terminal ${kind} outranks an earlier >4KB bootstrap banner`, async () => {
    const output = await fixtureOutput(variant);
    const terminal = buildTerminalEvidence(output);
    assert.equal(terminal.exitClass, 'step-failure');
    assert.equal(parseMaestroFailure(output.slice(0, 4_000), terminal).kind, kind);
  });
}

test('GH-588 Slice B: genuinely unknown terminal output stays UNKNOWN', () => {
  assert.equal(
    parseMaestroFailure(
      'unrecognized engine death',
      buildTerminalEvidence('unrecognized engine death'),
    ).kind,
    'UNKNOWN',
  );
});
