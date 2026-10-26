#!/usr/bin/env node
// Test-only deterministic maestro-runner stand-in. This file is outside every
// release/package input and intentionally contains no TypeScript-only syntax so
// execFile can run it directly.
const variant = process.argv[2] ?? 'bootstrap';
const preamble = `${'Checking WDA installation… Downloading WebDriverAgent v15.1.6\n'.repeat(100)}`;
process.stdout.write(preamble);
if (variant === 'bootstrap') {
  process.stdout.write('WDA start failed: WebDriverAgent session could not be created\n');
} else if (variant === 'selector') {
  process.stdout.write("    ✗ tapOn id=continue (0.2s)\nElement with id 'continue' not found\n");
} else if (variant === 'assertion') {
  process.stdout.write(
    "    ✗ assertVisible continue (0.2s)\nAssertion failed: 'continue' not visible\n",
  );
} else if (variant === 'timeout') {
  process.stdout.write("    ✗ tapOn continue (30.0s)\nTimed out waiting for element 'continue'\n");
}
process.exit(17);
