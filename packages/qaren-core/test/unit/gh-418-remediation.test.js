// GH #418: 'missing-commands' remediation is tiered. Mid-flow callers refuse
// fast with RUNNER_COMMANDS_STALE (a respawn can't fix a stale ARTIFACT); only
// device_snapshot action=open (allowArtifactRebuild) invalidates DerivedData
// and pays the cold rebuild — reap-first, behind a checkout-scoped build lock,
// at most once per plugin version (multi-LLM review amendments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureRunnerForCommand } from '../../dist/agent-device-wrapper.js';

const MISSING = {
  liveness: 'stale',
  staleReason: 'missing-commands',
  missingCommands: ['keyboardDismiss'],
};
const AUTHORITY_MISMATCH = {
  liveness: 'stale',
  staleReason: 'authority-mismatch',
};
const freshBudget = () => {
  const rebuilt = new Set();
  return {
    alreadyRebuiltFor: (v) => rebuilt.has(v),
    recordRebuild: (v) => rebuilt.add(v),
  };
};
const base = () => ({
  prebuilt: () => true,
  adopt: () => {},
  reap: async () => {},
  acquireBuildLock: () => true,
  releaseBuildLock: () => {},
  rebuildBudget: freshBudget(),
  pluginVersion: '0.99.0',
});

test('gh-418: mid-flow, missing-commands survives respawn → RUNNER_COMMANDS_STALE, no invalidation', async () => {
  let invalidated = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    probe: async () => MISSING,
    ensure: async () => {},
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(invalidated, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_COMMANDS_STALE');
  assert.match(res.message, /keyboardDismiss/);
  assert.match(res.message, /device_snapshot action=open/);
});

test('gh-418: mid-flow, respawn fixes a stale process → ok + upgrade note, no invalidation', async () => {
  const probes = [MISSING, { liveness: 'alive' }];
  let invalidated = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    probe: async () => probes.shift(),
    ensure: async () => {},
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(invalidated, 0);
  assert.deepEqual(res, { ok: true, note: 'runner upgraded (stale command surface)' });
});

test('gh-418: at open, invalidate FIRST (no wasted stale respawn) → single ensure + rebuilt note', async () => {
  const probes = [MISSING, { liveness: 'alive' }];
  let invalidated = 0;
  let ensured = 0;
  let reaped = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    probe: async () => probes.shift(),
    ensure: async () => {
      ensured++;
    },
    reap: async () => {
      reaped++;
    },
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(reaped, 1);
  assert.equal(invalidated, 1);
  assert.equal(ensured, 1);
  assert.deepEqual(res, {
    ok: true,
    note: 'runner artifact rebuilt (missing commands: keyboardDismiss)',
  });
});

test('at open, a respawn heals authority mismatch without rebuilding', async () => {
  const probes = [AUTHORITY_MISMATCH, { liveness: 'alive' }];
  let invalidated = 0;
  let ensured = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    probe: async () => probes.shift(),
    ensure: async () => {
      ensured++;
    },
    invalidateArtifact: () => invalidated++,
  });

  assert.equal(invalidated, 0);
  assert.equal(ensured, 1);
  assert.deepEqual(res, {
    ok: true,
    note: 'runner upgraded (authority identity mismatch)',
  });
});

test('at open, persistent authority mismatch cold-rebuilds after one respawn', async () => {
  const probes = [AUTHORITY_MISMATCH, AUTHORITY_MISMATCH, { liveness: 'alive' }];
  let invalidated = 0;
  let ensured = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    probe: async () => probes.shift(),
    ensure: async (_deviceId, _bundleId, opts) => {
      ensured++;
      if (ensured === 2) assert.equal(opts.forceLocalBuild, true);
    },
    invalidateArtifact: () => invalidated++,
  });

  assert.equal(invalidated, 1);
  assert.equal(ensured, 2);
  assert.deepEqual(res, {
    ok: true,
    note: 'runner artifact rebuilt (authority identity mismatch)',
  });
});

test('gh-418: at open, rebuild budget already spent for this plugin version → refuse, no invalidation', async () => {
  const budget = freshBudget();
  budget.recordRebuild('0.99.0');
  let invalidated = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    rebuildBudget: budget,
    probe: async () => MISSING,
    ensure: async () => {},
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(invalidated, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_COMMANDS_STALE');
  assert.match(res.message, /already cold-rebuilt/i);
});

test('gh-418: authority mismatch after a prior rebuild exposes supported marker recovery', async () => {
  const budget = freshBudget();
  budget.recordRebuild('0.99.0');
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    rebuildBudget: budget,
    probe: async () => ({
      liveness: 'stale',
      staleReason: 'authority-mismatch',
      runnerVersion: '0.1.0',
    }),
    ensure: async () => {},
    invalidateArtifact: () => assert.fail('must not invalidate while the guard is present'),
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_OWNERSHIP_MISMATCH');
  assert.match(res.message, /delete the runner build\/commands-rebuild\.json marker/);
  assert.match(res.message, /re-open to retry/);
});

test('gh-418: at open, build lock held by another session → refuse, no invalidation', async () => {
  let invalidated = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    acquireBuildLock: () => false,
    probe: async () => MISSING,
    ensure: async () => {},
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(invalidated, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_COMMANDS_STALE');
  assert.match(res.message, /another session/i);
});

test('gh-418: at open, even a cold rebuild misses commands → RUNNER_COMMANDS_STALE naming plugin update', async () => {
  let released = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    releaseBuildLock: () => released++,
    probe: async () => MISSING,
    ensure: async () => {},
    invalidateArtifact: () => {},
  });
  assert.equal(released, 1, 'lock must be released even on failure');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_COMMANDS_STALE');
  assert.match(res.message, /update the plugin/i);
});

test('gh-418: at open, DEAD runner spawned from a stale prebuilt → rebuild tier still fires', async () => {
  // First probe 'dead' (no runner yet — the common first-open-after-upgrade
  // case), spawn launches the stale prebuilt, after-probe says
  // missing-commands: the FIRST open must heal, not error until a second one.
  const probes = [{ liveness: 'dead' }, MISSING, { liveness: 'alive' }];
  let invalidated = 0;
  let ensured = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    probe: async () => probes.shift(),
    ensure: async () => {
      ensured++;
    },
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(invalidated, 1);
  assert.equal(ensured, 2, 'initial spawn + post-invalidation cold rebuild');
  assert.deepEqual(res, {
    ok: true,
    note: 'runner artifact rebuilt (missing commands: keyboardDismiss)',
  });
});

test('gh-418: at open, dead runner + NOT prebuilt → cold-build via ensure, not a refusal', async () => {
  // Open is the sanctioned cold-build entry (its own not-prebuilt error text
  // directs users here). After #418's invalidation deletes DerivedData — and
  // because a cold `xcodebuild test` leaves no .xctestrun — a later runner
  // death must not brick opens (device-verify finding).
  const probes = [{ liveness: 'dead' }, { liveness: 'alive' }];
  let ensured = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    prebuilt: () => false,
    allowArtifactRebuild: true,
    probe: async () => probes.shift(),
    ensure: async () => {
      ensured++;
    },
  });
  assert.equal(ensured, 1);
  assert.deepEqual(res, { ok: true });
});

test('gh-418: mid-flow, STALE missing-commands runner + NOT prebuilt → typed RUNNER_COMMANDS_STALE', async () => {
  // Multi-review finding: without this, the not-prebuilt decision shadowed the
  // typed refusal and callers surfaced RN_FAST_RUNNER_DOWN instead.
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    prebuilt: () => false,
    probe: async () => MISSING,
    ensure: async () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_COMMANDS_STALE');
  assert.match(res.message, /keyboardDismiss/);
});

test('gh-418: mid-flow, dead runner + NOT prebuilt keeps the #210 refusal', async () => {
  let ensured = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    prebuilt: () => false,
    probe: async () => ({ liveness: 'dead' }),
    ensure: async () => {
      ensured++;
    },
  });
  assert.equal(ensured, 0);
  assert.equal(res.ok, false);
  assert.match(res.message, /not prebuilt/);
});

test('gh-418: protocol reasons keep the existing note and error path', async () => {
  const probes = [{ liveness: 'stale', staleReason: 'legacy' }, { liveness: 'alive' }];
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    probe: async () => probes.shift(),
    ensure: async () => {},
  });
  assert.deepEqual(res, { ok: true, note: 'runner upgraded (protocol/version mismatch)' });
});
