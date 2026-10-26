// M6 / Phase 112: Maestro YAML + Detox JS generator tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMaestro,
  generateDetox,
  maestroSelector,
  detoxSelector,
  nextSelector,
} from '../../dist/handlers/test-recorder-generators.js';

test('M6 Maestro: tap with testID emits tapOn id selector', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'login-btn', t: 1 }]);
  // CDP-013: yaml serializer emits simple identifiers as plain scalars (no quotes).
  assert.match(out, /- tapOn:\s+id:\s+["']?login-btn["']?/);
});

test('M6 Maestro: type emits tapOn + inputText pair', () => {
  const out = generateMaestro([{ type: 'type', testID: 'email-input', value: 'a@b.c', t: 1 }]);
  assert.match(out, /- tapOn:\s+id:\s+["']?email-input["']?/);
  assert.match(out, /- inputText: "a@b\.c"/);
});

test('M6 Maestro: swipeUp uses finger-direction (dy>0 → up)', () => {
  const out = generateMaestro([{ type: 'swipe', direction: 'up', t: 1 }]);
  assert.match(out, /- swipeUp/);
});

test('M6 Maestro: swipeDown / swipeLeft / swipeRight all render', () => {
  const out = generateMaestro([
    { type: 'swipe', direction: 'down', t: 1 },
    { type: 'swipe', direction: 'left', t: 2 },
    { type: 'swipe', direction: 'right', t: 3 },
  ]);
  assert.match(out, /- swipeDown/);
  assert.match(out, /- swipeLeft/);
  assert.match(out, /- swipeRight/);
});

test('M6 Maestro: navigate emits assertVisible on next selector', () => {
  const out = generateMaestro([
    { type: 'navigate', from: 'Login', to: 'Home', t: 1 },
    { type: 'tap', testID: 'home-greeting', t: 2 },
  ]);
  assert.match(out, /# navigated: Login -> Home/);
  assert.match(out, /- assertVisible:\s+id:\s+["']?home-greeting["']?/);
});

test('M6 Maestro: annotation becomes YAML comment', () => {
  const out = generateMaestro([{ type: 'annotation', note: 'reached checkout', t: 1 }]);
  assert.match(out, /# NOTE: reached checkout/);
});

test('M6 Maestro: long_press emits longPressOn', () => {
  const out = generateMaestro([{ type: 'long_press', testID: 'avatar', t: 1 }]);
  assert.match(out, /- longPressOn:\s+id:\s+["']?avatar["']?/);
});

test('M6 Detox: tap uses by.id selector', () => {
  const out = generateDetox([{ type: 'tap', testID: 'login-btn', t: 1 }]);
  assert.match(out, /await element\(by\.id\("login-btn"\)\)\.tap\(\)/);
});

test('M6 Detox: type uses typeText with JSON-stringified value', () => {
  const out = generateDetox([{ type: 'type', testID: 'email', value: 'with "quotes"', t: 1 }]);
  assert.match(out, /await element\(by\.id\("email"\)\)\.typeText\("with \\"quotes\\""\)/);
});

test('M6 Detox: swipe passes direction verbatim (finger-direction matches Detox)', () => {
  const out = generateDetox([{ type: 'swipe', testID: 'list', direction: 'up', t: 1 }]);
  assert.match(out, /await element\(by\.id\("list"\)\)\.swipe\("up"\)/);
});

test('M6 selectors: maestroSelector falls back to label when no testID', () => {
  // CDP-013: label-only events emit `text:` (the correct Maestro selector
  // for visible-text matching) instead of `id:`. Simple label strings
  // serialize as plain scalars without quotes.
  const sel = maestroSelector({ type: 'tap', label: 'Submit', t: 1 });
  assert.match(sel, /^text:\s+["']?Submit["']?$/);
});

test('M6 selectors: detoxSelector returns null when nothing identifies the event', () => {
  assert.equal(detoxSelector({ type: 'tap', t: 1 }), null);
});

test('M6 nextSelector: stops at next navigate boundary', () => {
  const events = [
    { type: 'navigate', from: 'A', to: 'B', t: 1 },
    { type: 'navigate', from: 'B', to: 'C', t: 2 },
    { type: 'tap', testID: 'after-nav', t: 3 },
  ];
  const sel = nextSelector(events, 0, maestroSelector);
  assert.equal(sel, null);
});

// Review fixes (Gemini conf 90 + Codex conf 95): newline injection in
// generators. Annotations and other user-controlled strings must not break
// out of comment context.
test('M6 Maestro: annotation newlines are stripped (no YAML escape)', () => {
  const out = generateMaestro([
    { type: 'annotation', note: 'reached checkout\nstep:malicious', t: 1 },
  ]);
  assert.match(out, /# NOTE: reached checkout step:malicious/);
  assert.doesNotMatch(out, /^step:malicious/m);
});

test('M6 Detox: annotation newlines are stripped (no JS escape)', () => {
  const out = generateDetox([
    { type: 'annotation', note: 'line1\nawait device.uninstallApp();', t: 1 },
  ]);
  assert.match(out, /\/\/ NOTE: line1 await device\.uninstallApp\(\);/);
  // The escaped line MUST appear inside a comment, never as standalone code.
  assert.doesNotMatch(out, /^\s*await device\.uninstallApp\(\);/m);
});

test('M6 Maestro: testName / bundleId newlines are stripped', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'x', t: 1 }], {
    testName: 'flow\nrm -rf',
    bundleId: 'com.x\nstep: bad',
  });
  assert.match(out, /# flow rm -rf/);
  assert.match(out, /appId: ["']com\.x step: bad["']/);
  assert.doesNotMatch(out, /^step: bad/m);
});

test('M6 Detox: submit fallback is a manual-replay comment, not pressBack()', () => {
  // No testID/label → fallback path. Old behavior was `device.pressBack()`
  // which is Android-only and semantically wrong (back-button vs return-key).
  const out = generateDetox([{ type: 'submit', t: 1 }]);
  assert.doesNotMatch(out, /device\.pressBack/);
  assert.match(out, /\/\/ submit: missing testID\/label/);
});

// M7 / Phase 116: Reusable Action Metadata header emission.
test('M7 Maestro: metadata header emits id/intent/tags/mutates/status', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'x', t: 1 }], {
    testName: 'wizard create',
    id: 'wizard-create-task',
    intent: 'Create a task via the FAB',
    tags: ['tasks', 'wizard'],
    mutates: true,
    status: 'active',
  });
  assert.match(out, /# id: wizard-create-task/);
  assert.match(out, /# intent: Create a task via the FAB/);
  assert.match(out, /# tags: \[tasks, wizard\]/);
  assert.match(out, /# mutates: true/);
  assert.match(out, /# status: active/);
  assert.match(out, /# enginePin: maestro-runner@1\.1\.28/);
});

test('M7 Maestro: omitted metadata fields are not emitted', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'x', t: 1 }], {
    intent: 'just intent',
  });
  assert.match(out, /# intent: just intent/);
  assert.doesNotMatch(out, /# id:/);
  assert.doesNotMatch(out, /# tags:/);
  assert.doesNotMatch(out, /# mutates:/);
  assert.doesNotMatch(out, /# status:/);
});

test('M7 Maestro: mutates=false still emits the line', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'x', t: 1 }], { mutates: false });
  assert.match(out, /# mutates: false/);
});

test('M7 Maestro: metadata strings are newline-stripped', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'x', t: 1 }], {
    id: 'evil\nappId: com.bad',
    intent: 'first\nrm -rf',
  });
  assert.match(out, /# id: evil appId: com\.bad/);
  assert.match(out, /# intent: first rm -rf/);
});

test('M7 Detox: metadata header emits as // comments inside describe block', () => {
  const out = generateDetox([{ type: 'tap', testID: 'x', t: 1 }], {
    id: 'wizard-create-task',
    intent: 'Create a task',
    tags: ['tasks'],
    mutates: true,
    status: 'active',
  });
  assert.match(out, /\/\/ id: wizard-create-task/);
  assert.match(out, /\/\/ intent: Create a task/);
  assert.match(out, /\/\/ tags: \[tasks\]/);
  assert.match(out, /\/\/ mutates: true/);
  assert.match(out, /\/\/ status: active/);
});

test('M7 Maestro: empty tags array is treated as omitted', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'x', t: 1 }], { tags: [] });
  assert.doesNotMatch(out, /# tags:/);
});

test('#356 Maestro: hideKeyboard injected before a tap that follows type', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'tap', testID: 'submit', t: 2 },
  ]);
  assert.match(out, /# qaren: keyboard-occlusion guard \(#356\)/);
  const hk = out.indexOf('- hideKeyboard');
  const input = out.indexOf('- inputText:');
  const submitTap = out.indexOf('id: submit');
  assert.ok(hk > -1, 'hideKeyboard should be injected');
  assert.ok(hk > input, 'hideKeyboard comes after the inputText');
  assert.ok(hk < submitTap, 'hideKeyboard comes before the submit tap');
  const emailTap = out.indexOf('id: email');
  assert.ok(
    !out.slice(0, emailTap).includes('- hideKeyboard'),
    'the focusing tap of the type step is NOT guarded',
  );
});

test('#356 Maestro: no hideKeyboard when a tap is not preceded by type', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'submit', t: 1 }]);
  assert.ok(!out.includes('- hideKeyboard'), 'no keyboard, no injection');
});

test('#356 Maestro: single hideKeyboard for type then two taps', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'tap', testID: 'next', t: 2 },
    { type: 'tap', testID: 'submit', t: 3 },
  ]);
  const count = (out.match(/- hideKeyboard/g) || []).length;
  assert.equal(count, 1, 'flag cleared after first guarded tap');
  assert.ok(out.indexOf('- hideKeyboard') < out.indexOf('id: next'));
});

test('#356 Maestro: navigate resets keyboard state (no injection after nav)', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'navigate', from: 'A', to: 'B', t: 2 },
    { type: 'tap', testID: 'submit', t: 3 },
  ]);
  assert.ok(!out.includes('- hideKeyboard'), 'navigation dismisses the keyboard');
});

test('#356 Maestro: consecutive types inject once before the final tap', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'first', value: 'x', t: 1 },
    { type: 'type', testID: 'second', value: 'y', t: 2 },
    { type: 'tap', testID: 'submit', t: 3 },
  ]);
  const count = (out.match(/- hideKeyboard/g) || []).length;
  assert.equal(count, 1, 'one injection for the trailing button tap');
  const secondTap = out.indexOf('id: second');
  assert.ok(
    !out.slice(0, secondTap).includes('- hideKeyboard'),
    'the focusing tap of the second type is not guarded',
  );
  assert.ok(out.indexOf('- hideKeyboard') < out.indexOf('id: submit'));
});

test('#356 Maestro: submit (Enter) does not reset keyboard state', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'submit', t: 2 },
    { type: 'tap', testID: 'submit', t: 3 },
  ]);
  const hk = out.indexOf('- hideKeyboard');
  assert.ok(hk > -1, 'still guarded after submit');
  assert.ok(hk < out.indexOf('id: submit'));
});

test('#356 Maestro: long_press following type is guarded', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1 },
    { type: 'long_press', testID: 'avatar', t: 2 },
  ]);
  const hk = out.indexOf('- hideKeyboard');
  assert.ok(hk > -1, 'long_press is guarded too');
  assert.ok(hk < out.indexOf('- longPressOn:'));
});
