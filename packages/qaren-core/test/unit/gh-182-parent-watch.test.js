// GH #182 RC-A: the bridge self-exits when its Claude Code host dies, even when
// stdin-EOF and signals don't fire. Detection is "parent CHANGED from the PPID
// observed at startup" — NOT "PPID===1" — so a container where CC runs as PID 1
// (devcontainer/no-init) never false-self-exits, and subreaper reparenting is caught.
// (Multi-review: Gemini HIGH / Codex C1.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parentWatchTick, startParentDeathWatch } from '../../dist/lifecycle/parent-watch.js';

test('#182 parentWatchTick: parent CHANGED from initial (host died → reparented) → onOrphaned', () => {
  let orphaned = 0,
    beat = 0;
  // initial PPID 4242 (CC), now 1 (reparented to init) → changed → orphaned
  parentWatchTick(
    () => 1,
    4242,
    () => {
      orphaned++;
    },
    () => {
      beat++;
    },
  );
  assert.equal(orphaned, 1, 'PPID changed from 4242→1 means CC died → self-exit');
  assert.equal(beat, 0);
});

test('#182 parentWatchTick: parent changed to a subreaper (not 1) → onOrphaned', () => {
  let orphaned = 0,
    _beat = 0;
  parentWatchTick(
    () => 999,
    4242,
    () => {
      orphaned++;
    },
    () => {
      _beat++;
    },
  );
  assert.equal(orphaned, 1, 'reparented to a subreaper (999 != initial 4242) → orphaned');
});

test('#182 parentWatchTick: parent UNCHANGED → onHeartbeat (no false exit)', () => {
  let orphaned = 0,
    beat = 0;
  parentWatchTick(
    () => 4242,
    4242,
    () => {
      orphaned++;
    },
    () => {
      beat++;
    },
  );
  assert.equal(beat, 1, 'parent still alive (PPID unchanged) → heartbeat');
  assert.equal(orphaned, 0);
});

test('#182 parentWatchTick: container (initial PPID 1, still 1) → onHeartbeat, NOT orphaned', () => {
  let orphaned = 0,
    beat = 0;
  // CC runs as PID 1 in a container: initial PPID is 1 and stays 1 while CC is alive.
  parentWatchTick(
    () => 1,
    1,
    () => {
      orphaned++;
    },
    () => {
      beat++;
    },
  );
  assert.equal(orphaned, 0, 'PPID 1 that was 1 at startup is NOT an orphan signal (container)');
  assert.equal(beat, 1);
});

test('#182 startParentDeathWatch: returns a stop() that clears the interval', () => {
  const stop = startParentDeathWatch({
    getppid: () => 4242,
    onOrphaned: () => {},
    onHeartbeat: () => {},
    intervalMs: 60_000,
  });
  assert.equal(typeof stop, 'function');
  stop();
});
