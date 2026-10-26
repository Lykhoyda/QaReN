import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// Phase 2 (eradicate-agent-device) acceptance gate: no LIVE agent-device dispatch
// may remain in src. The foreign-AgentDeviceRunner CLEANUP (spec D-b — self-heal
// for users with old installs) is intentionally retained and is NOT flagged here.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Strip line comments + block comments so historical mentions of "agent-device"
// in prose never trip the gate — we only care about live code.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

const FORBIDDEN = [
  // spawning the agent-device executable in any form
  {
    re: /(execFile|execFileAsync|spawn|exec)\(\s*['"]agent-device['"]/,
    name: "spawn of 'agent-device'",
  },
  // the deleted daemon tier
  { re: /\brunViaDaemon\b/, name: 'runViaDaemon (deleted daemon tier)' },
  { re: /\bloadDaemonInfo\b/, name: 'loadDaemonInfo (deleted daemon tier)' },
  { re: /\bsendToDaemon\b/, name: 'sendToDaemon (deleted daemon tier)' },
  // lifecycle/discovery verbs that have no native dispatch route (must use their tools)
  { re: /runNative\(\s*\[\s*['"]open['"]/, name: "runNative(['open']) — no native route" },
  { re: /runNative\(\s*\[\s*['"]close['"]/, name: "runNative(['close']) — no native route" },
  { re: /runNative\(\s*\[\s*['"]find['"]/, name: "runNative(['find']) — use the orchestrator" },
  { re: /runNative\(\s*\[\s*['"]devices['"]/, name: "runNative(['devices']) — use device_list" },
];

test('Phase 2 gate: no live agent-device dispatch remains in src', () => {
  const violations = [];
  for (const file of tsFiles(SRC)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const { re, name } of FORBIDDEN) {
      if (re.test(code)) violations.push(`${relative(SRC, file)}: ${name}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Forbidden agent-device dispatch found:\n${violations.join('\n')}`,
  );
});

test('Phase 2 gate: D-b foreign-runner cleanup is RETAINED (negative control)', () => {
  // These SHOULD exist — the gate must not have been satisfied by deleting the
  // legitimate self-heal defense against a stale upstream AgentDeviceRunner.
  const ensure = readFileSync(join(SRC, 'runners', 'ensure-single-runner.ts'), 'utf8');
  assert.match(
    ensure,
    /AgentDeviceRunner|callstack\.agentdevice/,
    'foreign-runner cleanup must remain (spec D-b)',
  );
  const sentinel = readFileSync(join(SRC, 'handlers', 'runner-leak-recovery.ts'), 'utf8');
  assert.match(
    sentinel,
    /isAgentDeviceRunnerSentinel/,
    'runner-leak sentinel must remain (spec D-b)',
  );
});
