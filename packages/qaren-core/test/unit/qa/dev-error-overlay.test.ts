import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { devErrorOverlay, frontFromSurface } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { nativeDevOverlayObservation } from '../../../dist/qa/capture.js';
import { DEV_ERROR_DISMISSALS } from '../../../dist/qa/walker.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';
import { element, screen } from './judgment-fixtures.ts';

// Value-free shapes from React Native's RCTRedBox and LogBox inspector sources, not recorded from a device.
const FULL = { x: 0, y: 0, width: 402, height: 874 };
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function tree(
  ...windows: Array<Array<Omit<NativeNode, 'ref' | 'parentIndex'> & { parent?: number }>>
) {
  const nodes: NativeNode[] = [{ ref: 'e0', index: 0, type: 'Application', rect: FULL }];
  for (const children of windows) {
    const window = nodes.length;
    nodes.push({ ref: `e${window}`, index: window, parentIndex: 0, type: 'Window', rect: FULL });
    for (const { parent, ...child } of children)
      nodes.push({
        ref: `e${nodes.length}`,
        index: nodes.length,
        parentIndex: parent === undefined ? window : window + parent,
        ...child,
      });
  }
  return nodes;
}

const appContent = [
  { type: 'Other', rect: FULL },
  { type: 'StaticText', label: 'Settings', rect: rect(16, 120, 220, 24), parent: 1 },
  { type: 'Button', label: 'Dismiss', rect: rect(16, 780, 370, 48), parent: 1 },
];
const redbox = [
  { type: 'Other', rect: FULL },
  { type: 'StaticText', label: 'CANARY_STACK_FRAME', identifier: 'redbox-error', parent: 1 },
  { type: 'Button', label: 'Dismiss\n(ESC)', identifier: 'redbox-dismiss', parent: 1 },
  { type: 'Button', label: 'Reload\n(⌘R)', identifier: 'redbox-reload', parent: 1 },
  { type: 'Button', label: 'Copy\n(⌥⇧⌘C)', identifier: 'redbox-copy', parent: 1 },
];
const logbox = (level: 'error' | 'syntax') =>
  level === 'error'
    ? [
        { type: 'Other', rect: FULL },
        { type: 'StaticText', label: 'Log 1 of 2', parent: 1 },
        { type: 'StaticText', label: 'CANARY_MESSAGE', parent: 1 },
        { type: 'Button', label: 'Dismiss', parent: 1 },
        { type: 'StaticText', label: 'Dismiss', parent: 4 },
        { type: 'Button', label: 'Minimize', parent: 1 },
      ]
    : [
        { type: 'Other', rect: FULL },
        { type: 'StaticText', label: 'Failed to compile', parent: 1 },
        { type: 'StaticText', label: 'This error cannot be dismissed.', parent: 1 },
      ];

test('the native RedBox is a development error front with its own Dismiss control', () => {
  const nodes = tree(appContent, redbox);
  assert.equal(frontFromSurface(undefined, nodes), 'dev-redbox');
  const dismiss = nodes.find((node) => node.identifier === 'redbox-dismiss')!;
  assert.deepEqual(devErrorOverlay(nodes), { variant: 'redbox', dismissRef: dismiss.ref });
  assert.deepEqual(
    nativeDevOverlayObservation({
      nodes,
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
    }),
    { state: 'shown', front: 'dev-redbox' },
  );
});

test('the LogBox inspector is recognized by its fixed header and footer in one window', () => {
  const nodes = tree(appContent, logbox('error'));
  assert.equal(frontFromSurface(undefined, nodes), 'dev-redbox');
  // The outer button, not its own label text, is the one Dismiss control.
  const outer = nodes.find(
    (node) => node.type === 'Button' && node.label === 'Dismiss' && node.index! > 4,
  )!;
  assert.deepEqual(devErrorOverlay(nodes), { variant: 'logbox', dismissRef: outer.ref });
});

test('a syntax-error LogBox has no Dismiss control to press', () => {
  const nodes = tree(appContent, logbox('syntax'));
  assert.equal(frontFromSurface(undefined, nodes), 'dev-redbox');
  assert.deepEqual(devErrorOverlay(nodes), { variant: 'logbox' });
});

test('app screens with Dismiss, Minimize or log text in different windows stay the app', () => {
  assert.equal(frontFromSurface(undefined, tree(appContent)), 'app');
  assert.equal(devErrorOverlay(tree(appContent)), undefined);
  const split = tree(
    [...appContent, { type: 'Button', label: 'Minimize', parent: 1 }],
    [{ type: 'StaticText', label: 'Log 1 of 2', rect: rect(0, 0, 80, 20) }],
  );
  assert.equal(devErrorOverlay(split), undefined);
});

test('an alert and a dev menu keep precedence over the error overlay', () => {
  const alert = tree(appContent, redbox);
  alert[0] = { ...alert[0], type: 'Alert' };
  assert.equal(frontFromSurface(undefined, alert), 'dialog');
  assert.equal(frontFromSurface('expo_dev_menu', tree(appContent, redbox)), 'dev-menu');
});

const CANARY = 'CANARY_STACK_FRAME at render (App.tsx:12)';
const home = () => screen([element('@settings', 'Settings')]);
const overlay = (dismissRef: string | null = '@dismiss'): Screen => ({
  ...screen([
    element('@dismiss', 'Dismiss\n(ESC)', { testID: 'redbox-dismiss' }),
    element('@stack', CANARY, { kind: 'text' }),
  ]),
  front: 'dev-redbox',
  devError: { variant: 'redbox', ...(dismissRef ? { dismissRef } : {}) },
});

function app(initial: Screen, options: { reappear?: number; pressed?: Screen } = {}) {
  let current = initial;
  let reappear = options.reappear ?? 0;
  const actions: string[] = [];
  const shots: string[] = [];
  const deps: WalkerDeps = {
    async captureScreen() {
      return current;
    },
    async press(ref, context) {
      context!.authorize();
      actions.push(`press ${ref}`);
      if (ref === '@dismiss') current = reappear-- > 0 ? overlay() : home();
      else current = options.pressed ?? screen([element('@done', 'Done')]);
      return { ok: true, proven: false, executed: true };
    },
    async fill() {
      throw new Error('unexpected fill');
    },
    async scroll() {
      throw new Error('unexpected scroll');
    },
    async back() {
      throw new Error('unexpected back');
    },
    async dialog() {
      throw new Error('unexpected dialog');
    },
    async hideDevMenu() {
      throw new Error('unexpected dev menu');
    },
    async screenshot(name) {
      shots.push(name);
      return name;
    },
    now: () => 0,
    async sleep() {},
    row() {},
  };
  return { deps, actions, shots };
}

const tapPlan = () => parsePlan('1. Tap "Settings"\n✓ "Done"').blocks!;

test('an error overlay in front of a tap is dismissed with its own control, then the tap runs', async () => {
  const f = app(overlay());
  const result = await runPlan(tapPlan(), f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @dismiss', 'press @settings']);
  const retry = result.steps.filter((row) => row.retryCause === 'DEV_REDBOX');
  assert.equal(retry.length, 1);
  assert.deepEqual(retry[0].devError, { variant: 'redbox', dismissal: 1 });
  assert.equal(retry[0].outcome, 'retry');
  assert.match(retry[0].reason!, /development error overlay/);
  assert.ok(!JSON.stringify(result).includes('CANARY'));
});

test("React's error-screen flag does not skip the dismissal of a natively identified overlay", async () => {
  const f = app({ ...overlay(), renderError: true });
  const result = await runPlan(tapPlan(), f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @dismiss', 'press @settings']);
});

test('an error screen only React reports still fails the step without a dismissal', async () => {
  const f = app({ ...home(), renderError: true });
  const result = await runPlan(tapPlan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, []);
});

test('an overlay that returns is dismissed at most three times for one step, then refused', async () => {
  for (const reappear of [1, 2]) {
    const f = app(overlay(), { reappear });
    const result = await runPlan(tapPlan(), f.deps);
    assert.equal(result.verdict, 'PASS', `reappear=${reappear}`);
    assert.equal(f.actions.filter((a) => a === 'press @dismiss').length, reappear + 1);
  }
  const f = app(overlay(), { reappear: 10 });
  const result = await runPlan(tapPlan(), f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(result.code, 'DEV_REDBOX_REPEATED');
  assert.equal(DEV_ERROR_DISMISSALS, 3);
  assert.deepEqual(f.actions, ['press @dismiss', 'press @dismiss', 'press @dismiss']);
  assert.deepEqual(
    result.steps
      .filter((row) => row.retryCause === 'DEV_REDBOX')
      .map((row) => row.devError?.dismissal),
    [1, 2, 3],
  );
  assert.ok(!JSON.stringify(result).includes('CANARY'));
  assert.match(
    result.failure!.seen,
    /A development error overlay was in front; \d+ lines withheld\./,
  );
  assert.deepEqual(f.shots, []);
});

test('each step has its own dismissal budget', { timeout: 5_000 }, async () => {
  const shown = home();
  // Two overlays before each wait: four dismissals in all, two per step.
  const after = [overlay(), shown, overlay(), screen([element('@done', 'Done')])];
  let current = overlay();
  let returned = false;
  const f = app(current);
  f.deps.captureScreen = async () => current;
  f.deps.press = async (ref, context) => {
    context!.authorize();
    f.actions.push(`press ${ref}`);
    current = after.shift()!;
    return { ok: true, proven: false, executed: true };
  };
  // The overlay returns on its own while the second step waits.
  f.deps.sleep = async () => {
    if (current === shown && !returned) {
      returned = true;
      current = overlay();
    }
  };
  const result = await runPlan(
    parsePlan('1. Wait for "Settings"\n2. Wait for "Done"').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'PASS');
  assert.equal(f.actions.length, 4);
});

test('a plain wait behind an error overlay recovers once the overlay is dismissed', async () => {
  const f = app(overlay());
  const result = await runPlan(parsePlan('1. Wait for "Settings"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @dismiss']);
});

test('an overlay first seen after the planned press is refused without dismissing or replaying', async () => {
  const f = app(home(), { pressed: overlay() });
  const result = await runPlan(tapPlan(), f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(result.code, 'DEV_REDBOX_ACTION_UNCERTAIN');
  assert.deepEqual(f.actions, ['press @settings']);
  assert.ok(!JSON.stringify(result).includes('CANARY'));
});

test('an overlay without a pressable Dismiss control is refused without tapping', async () => {
  const f = app(overlay(null));
  const result = await runPlan(tapPlan(), f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(result.code, 'DEV_REDBOX_NO_SAFE_DISMISS');
  assert.deepEqual(f.actions, []);
});

test('a Dismiss that is not dispatched is refused and never retried', async () => {
  const f = app(overlay());
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    return { ok: false, executed: false, error: 'not dispatched' };
  };
  const result = await runPlan(tapPlan(), f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(result.code, 'DEV_REDBOX_DISMISS_FAILED');
  assert.deepEqual(f.actions, ['press @dismiss']);
});

test('a check behind an error overlay is judged only after the overlay is dismissed', async () => {
  const f = app(overlay());
  const result = await runPlan(parsePlan('✓ "Settings"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @dismiss']);
});
