import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRnAgentConfig, resolveAutoConnect } from '../../dist/project-config.js';

// Spec 2026-06-10-debugger-seat-optout: autoConnect resolution precedence is
// env RN_CDP_AUTOCONNECT > .qaren/config.json > default true. Config file
// errors are fail-open (never block a session).

function makeProjectRoot(configJson) {
  const root = mkdtempSync(join(tmpdir(), 'rn-agent-cfg-'));
  if (configJson !== undefined) {
    mkdirSync(join(root, '.qaren'), { recursive: true });
    writeFileSync(join(root, '.qaren', 'config.json'), configJson);
  }
  return root;
}

test('readRnAgentConfig: parses cdp.autoConnect=false', () => {
  const root = makeProjectRoot(JSON.stringify({ cdp: { autoConnect: false } }));
  try {
    assert.deepEqual(readRnAgentConfig(root), { cdp: { autoConnect: false } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readRnAgentConfig: missing file returns null', () => {
  const root = makeProjectRoot(undefined);
  try {
    assert.equal(readRnAgentConfig(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readRnAgentConfig: malformed JSON is fail-open (null, no throw)', () => {
  const root = makeProjectRoot('{ not json');
  try {
    assert.equal(readRnAgentConfig(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveAutoConnect: env "0" wins over config true', () => {
  const r = resolveAutoConnect({ env: '0', readConfig: () => ({ cdp: { autoConnect: true } }) });
  assert.deepEqual(r, { enabled: false, source: 'env' });
});

test('resolveAutoConnect: env "false" disables', () => {
  assert.deepEqual(resolveAutoConnect({ env: 'false', readConfig: () => null }), {
    enabled: false,
    source: 'env',
  });
});

test('resolveAutoConnect: env "1" forces on over config false', () => {
  const r = resolveAutoConnect({ env: '1', readConfig: () => ({ cdp: { autoConnect: false } }) });
  assert.deepEqual(r, { enabled: true, source: 'env' });
});

test('resolveAutoConnect: unset env falls through to config', () => {
  const r = resolveAutoConnect({
    env: undefined,
    readConfig: () => ({ cdp: { autoConnect: false } }),
  });
  assert.deepEqual(r, { enabled: false, source: 'config' });
});

test('resolveAutoConnect: non-boolean config value ignored → default', () => {
  const r = resolveAutoConnect({
    env: undefined,
    readConfig: () => ({ cdp: { autoConnect: 'nope' } }),
  });
  assert.deepEqual(r, { enabled: true, source: 'default' });
});

test('resolveAutoConnect: nothing set → default true', () => {
  assert.deepEqual(resolveAutoConnect({ env: undefined, readConfig: () => null }), {
    enabled: true,
    source: 'default',
  });
});

test('resolveAutoConnect: unrecognized env value falls through (not an off-switch typo trap)', () => {
  const r = resolveAutoConnect({ env: 'banana', readConfig: () => null });
  assert.deepEqual(r, { enabled: true, source: 'default' });
});

test('resolveAutoConnect: absent env key reads process.env.RN_CDP_AUTOCONNECT', () => {
  const prev = process.env.RN_CDP_AUTOCONNECT;
  process.env.RN_CDP_AUTOCONNECT = '0';
  try {
    assert.deepEqual(resolveAutoConnect({ readConfig: () => null }), {
      enabled: false,
      source: 'env',
    });
  } finally {
    if (prev === undefined) delete process.env.RN_CDP_AUTOCONNECT;
    else process.env.RN_CDP_AUTOCONNECT = prev;
  }
});
