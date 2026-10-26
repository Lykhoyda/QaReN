import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../../dist/logger.js';
import { readRnAgentConfig, resolveAutoHideDevMenu } from '../../dist/project-config.js';

const resolveWith = (autoHideDevMenu: unknown) =>
  resolveAutoHideDevMenu({ readConfig: () => ({ autoHideDevMenu }) });

test('resolveAutoHideDevMenu: absent key hides on every target by default', () => {
  assert.deepEqual(resolveAutoHideDevMenu({ readConfig: () => null }), {
    simulators: true,
    devices: true,
    source: 'default',
  });
  assert.deepEqual(resolveWith(undefined), { simulators: true, devices: true, source: 'default' });
});

test('resolveAutoHideDevMenu: a boolean applies to both target classes', () => {
  assert.deepEqual(resolveWith(false), { simulators: false, devices: false, source: 'config' });
  assert.deepEqual(resolveWith(true), { simulators: true, devices: true, source: 'config' });
});

test('resolveAutoHideDevMenu: a partial object keeps missing target classes hidden', () => {
  assert.deepEqual(resolveWith({ simulators: false }), {
    simulators: false,
    devices: true,
    source: 'config',
  });
  assert.deepEqual(resolveWith({ devices: false }), {
    simulators: true,
    devices: false,
    source: 'config',
  });
});

test('resolveAutoHideDevMenu: a malformed value falls back to the default with a warning', () => {
  const warn = mock.method(logger, 'warn', () => {});
  try {
    for (const malformed of ['off', 0, null, [false], { simulators: 'no' }]) {
      assert.deepEqual(resolveWith(malformed), {
        simulators: true,
        devices: true,
        source: 'default',
      });
    }
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[1], /autoHideDevMenu/);
  } finally {
    warn.mock.restore();
  }
});

test('resolveAutoHideDevMenu: an unreadable config file falls back to the default', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-agent-cfg-'));
  try {
    mkdirSync(join(root, '.qaren'), { recursive: true });
    writeFileSync(join(root, '.qaren', 'config.json'), '{ not json');
    assert.deepEqual(resolveAutoHideDevMenu({ readConfig: () => readRnAgentConfig(root) }), {
      simulators: true,
      devices: true,
      source: 'default',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
