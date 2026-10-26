// Phase 2 Task 8: verify the daemon + CLI tiers are fully deleted from
// agent-device-wrapper.ts. Source-regex gates over the built output so
// we catch accidental re-introduction at build time, not only at edit time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../../dist/agent-device-wrapper.js'), 'utf-8');

// ── Deleted dispatch symbols ─────────────────────────────────────────────────

test('no execFile("agent-device") literal in built output', () => {
  const matches = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && l.includes("execFile('agent-device'"));
  assert.equal(matches.length, 0, `Found execFile('agent-device') in:\n${matches.join('\n')}`);
});

test('no execFileAsync("agent-device") literal in built output', () => {
  const matches = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && l.includes("execFileAsync('agent-device'"));
  assert.equal(matches.length, 0, `Found execFileAsync('agent-device') in:\n${matches.join('\n')}`);
});

test('no spawn("agent-device") literal in built output', () => {
  const matches = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && l.includes("spawn('agent-device'"));
  assert.equal(matches.length, 0, `Found spawn('agent-device') in:\n${matches.join('\n')}`);
});

test('no runViaDaemon reference in built output', () => {
  const matches = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && /runViaDaemon/.test(l));
  assert.equal(matches.length, 0, `Found runViaDaemon in:\n${matches.join('\n')}`);
});

test('no loadDaemonInfo reference in built output', () => {
  const matches = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && /loadDaemonInfo/.test(l));
  assert.equal(matches.length, 0, `Found loadDaemonInfo in:\n${matches.join('\n')}`);
});

test('no sendToDaemon reference in built output', () => {
  const matches = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && /sendToDaemon/.test(l));
  assert.equal(matches.length, 0, `Found sendToDaemon in:\n${matches.join('\n')}`);
});

// ── Terminal fallthrough returns NO_NATIVE_ROUTE ─────────────────────────────

test('runNative terminal fallthrough emits NO_NATIVE_ROUTE code', () => {
  assert.match(
    src,
    /NO_NATIVE_ROUTE/,
    'NO_NATIVE_ROUTE must appear in the built dispatcher output',
  );
});

// ── NO_NATIVE_ROUTE is a member of ToolErrorCode ────────────────────────────

test('NO_NATIVE_ROUTE is a member of the ToolErrorCode union in types.ts', async () => {
  const typesSrc = readFileSync(join(__dirname, '../../src/types.ts'), 'utf-8');
  assert.match(
    typesSrc,
    /NO_NATIVE_ROUTE/,
    "ToolErrorCode union in types.ts must include 'NO_NATIVE_ROUTE'",
  );
});
