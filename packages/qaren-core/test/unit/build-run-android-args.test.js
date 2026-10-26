import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = resolve(__dirname, '../../src/agent-device-wrapper.ts');
const source = readFileSync(WRAPPER_PATH, 'utf8');

test('buildRunAndroidArgs maps Android MVP verbs', () => {
  const normalized = source.replace(/'/g, '"');
  for (const fragment of [
    'case "press":',
    'case "tap":',
    'case "fill":',
    'case "type":',
    'case "verify-input":',
    'case "snapshot":',
    'case "back":',
    'case "screenshot":',
    'case "keyboard":',
    'case "swipe":',
    'case "scroll":',
    'case "drag":',
    'case "longpress":',
    'case "pinch":',
  ]) {
    assert.ok(normalized.includes(fragment), `missing ${fragment}`);
  }
  const routeSetStart = source.indexOf('const RN_ANDROID_RUNNER_COMMANDS');
  const routeSetEnd = source.indexOf(']);', routeSetStart);
  assert.match(source.slice(routeSetStart, routeSetEnd), /'verify-input'/);
});

test('buildRunAndroidArgs includes stale-ref sentinel and screenshot out path', () => {
  assert.match(source, /_staleRef: ref/);
  assert.match(source, /_staleRef: target/);
  assert.match(source, /outPath: optionValue\(cliArgs, ['"]--out['"]\)/);
});
