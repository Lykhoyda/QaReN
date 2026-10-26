// B136 + B137: generator improvements for M6 recorder.
// B136 — emit `# startRoute:` preamble when opts.startRoute is set.
// B137 — correlate tap events with following navigate events, emit
//        `# navigated:` + assertVisible inline, consume the navigate so it
//        isn't double-emitted by the navigate branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMaestro,
  generateDetox,
  lookaheadNavigate,
} from '../../dist/handlers/test-recorder-generators.js';

test('B136: Maestro emits `# startRoute:` preamble when set', () => {
  const out = generateMaestro([{ type: 'annotation', note: 'first', t: 1 }], {
    startRoute: 'ProfileTab',
  });
  assert.match(out, /# startRoute: ProfileTab/);
});

test('B136: Maestro preamble includes replay note about navigation setup', () => {
  const out = generateMaestro([], { startRoute: 'SettingsScreen' });
  assert.match(out, /replay requires the app to be on this route/);
});

test('B136: Maestro emits NO preamble when startRoute not set', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'x', t: 1 }]);
  assert.doesNotMatch(out, /# startRoute/);
});

test('B136: Maestro emits NO preamble when startRoute is null', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'x', t: 1 }], { startRoute: null });
  assert.doesNotMatch(out, /# startRoute/);
});

test('B136: Detox emits startRoute comment inside describe block', () => {
  const out = generateDetox([], { startRoute: 'Home' });
  assert.match(out, /\/\/ startRoute: Home/);
});

test('B137: lookaheadNavigate finds next navigate within window', () => {
  const events = [
    { type: 'tap', testID: 'tab-home', t: 1000 },
    { type: 'navigate', from: 'X', to: 'Home', t: 1100 },
  ];
  const hit = lookaheadNavigate(events, 0, 1000);
  assert.ok(hit);
  assert.equal(hit.event.to, 'Home');
  assert.equal(hit.index, 1);
});

test('B137: lookaheadNavigate returns null when navigate is outside window', () => {
  const events = [
    { type: 'tap', testID: 'tab-home', t: 1000 },
    { type: 'navigate', from: 'X', to: 'Home', t: 3000 },
  ];
  assert.equal(lookaheadNavigate(events, 0, 1000), null);
});

test('B137: lookaheadNavigate returns null when another tap intervenes', () => {
  const events = [
    { type: 'tap', testID: 'a', t: 1000 },
    { type: 'tap', testID: 'b', t: 1050 },
    { type: 'navigate', from: 'X', to: 'Y', t: 1100 },
  ];
  assert.equal(lookaheadNavigate(events, 0, 1000), null);
});

test('B137: lookaheadNavigate returns null when called on a non-tap event', () => {
  const events = [
    { type: 'annotation', note: 'x', t: 1 },
    { type: 'navigate', from: 'A', to: 'B', t: 50 },
  ];
  assert.equal(lookaheadNavigate(events, 0, 1000), null);
});

test('B137: lookaheadNavigate works for long_press too', () => {
  const events = [
    { type: 'long_press', testID: 'row', t: 1000 },
    { type: 'navigate', from: 'List', to: 'Detail', t: 1100 },
  ];
  const hit = lookaheadNavigate(events, 0, 1000);
  assert.ok(hit);
  assert.equal(hit.event.to, 'Detail');
});

test('B137: Maestro tap + nav emits navigated comment inline', () => {
  const events = [
    { type: 'tap', testID: 'tab-tasks', t: 1000 },
    { type: 'navigate', from: 'Home', to: 'Tasks', t: 1100 },
    { type: 'tap', testID: 'task-row-1', t: 1500 },
  ];
  const out = generateMaestro(events);
  // CDP-013: yaml-serialized scalars — simple identifiers as plain scalars.
  assert.match(out, /- tapOn:\s+id:\s+["']?tab-tasks["']?\s+# navigated: Home -> Tasks/);
  // lookahead assertVisible should point at task-row-1 (next selector after navigate)
  assert.match(out, /- assertVisible:\s+id:\s+["']?task-row-1["']?/);
});

test('B137: Maestro does NOT double-emit navigate — only once, not from both branches', () => {
  const events = [
    { type: 'tap', testID: 'cta', t: 1000 },
    { type: 'navigate', from: 'Start', to: 'End', t: 1100 },
  ];
  const out = generateMaestro(events);
  const navComments = (out.match(/# navigated: Start -> End/g) ?? []).length;
  assert.equal(navComments, 1, 'navigate comment must appear exactly once');
});

test('B137: Maestro falls back to navigate branch when tap is NOT followed by navigate within window', () => {
  const events = [
    { type: 'tap', testID: 'lonely', t: 1000 },
    { type: 'annotation', note: 'wait', t: 1500 },
    { type: 'navigate', from: 'A', to: 'B', t: 3000 },
    { type: 'tap', testID: 'on-b', t: 3100 },
  ];
  const out = generateMaestro(events);
  assert.match(out, /# navigated: A -> B/);
  assert.match(out, /- assertVisible:\s+id:\s+["']?on-b["']?/);
});

test('B137: Maestro emits navigate branch when no preceding tap exists', () => {
  const events = [
    { type: 'navigate', from: 'Splash', to: 'Login', t: 1 },
    { type: 'tap', testID: 'username', t: 2 },
  ];
  const out = generateMaestro(events);
  assert.match(out, /# navigated: Splash -> Login/);
  assert.match(out, /- assertVisible:\s+id:\s+["']?username["']?/);
});

test('B137: Detox tap + nav emits navigated comment + toBeVisible inline', () => {
  const events = [
    { type: 'tap', testID: 'tab-tasks', t: 1000 },
    { type: 'navigate', from: 'Home', to: 'Tasks', t: 1050 },
    { type: 'tap', testID: 'row', t: 2000 },
  ];
  const out = generateDetox(events);
  assert.match(out, /await element\(by\.id\("tab-tasks"\)\)\.tap\(\);/);
  assert.match(out, /\/\/ navigated: Home -> Tasks/);
  assert.match(out, /await expect\(element\(by\.id\("row"\)\)\)\.toBeVisible\(\)/);
});

test('B137: Detox does NOT double-emit navigate comment', () => {
  const events = [
    { type: 'tap', testID: 'cta', t: 1000 },
    { type: 'navigate', from: 'Start', to: 'End', t: 1100 },
  ];
  const out = generateDetox(events);
  const navComments = (out.match(/\/\/ navigated: Start -> End/g) ?? []).length;
  assert.equal(navComments, 1);
});
