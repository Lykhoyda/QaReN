import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../dist/qa/plan.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { MASK } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';
import type { Element, Screen } from '../../../dist/qa/screen.js';

function control(ref: string, label: string, extra: Partial<Element> = {}): Element {
  return {
    ref,
    kind: 'button',
    label,
    hittable: true,
    disabled: false,
    secure: false,
    offscreen: false,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible' },
    where: 'middle',
    side: 'center',
    ...extra,
  };
}

function screen(elements: Element[]): Screen {
  return {
    elements,
    visibleText: elements.flatMap((e) => (e.label ? [e.label] : [])),
    front: 'app',
    coverage: { native: 'complete', react: 'complete' },
  };
}

function deps(screens: Screen[]): WalkerDeps {
  let clock = 0;
  const queue = [...screens];
  return {
    captureScreen: async () => (queue.length > 1 ? queue.shift()! : queue[0]),
    press: async () => ({ ok: true, proven: false }),
    fill: async () => ({ ok: true, proven: true }),
    scroll: async () => ({ ok: true, proven: false }),
    back: async () => ({ ok: true, proven: false }),
    dialog: async () => ({ ok: true, proven: true }),
    hideDevMenu: async () => ({ ok: true, proven: true }),
    screenshot: async (name) => name,
    now: () => (clock += 100),
    sleep: async (ms) => {
      clock += ms;
    },
    row: () => {},
  };
}

const plan = (markdown: string) => parsePlan(markdown).blocks!;

const pad = () =>
  screen([
    control('@agree', 'Agree', { testID: 'qa-agree', disabled: true, hittable: false }),
    control('@continue', 'Continue', { testID: 'qa-continue' }),
  ]);

test('a press on a disabled target reports it disabled on the last observed screen', async () => {
  const ledger = await runPlan(plan('1. Tap "Agree"\n'), deps([pad()]));
  const failure = ledger.failure!;
  assert.equal(failure.subreason, 'present-but-unavailable');
  assert.deepEqual(failure.screen?.controls[0], {
    role: 'button',
    id: 'qa-agree',
    label: 'Agree',
    enabled: false,
    hittable: false,
    offscreen: false,
  });
  assert.deepEqual(failure.screen?.counts, { controls: 2, enabled: 1, hidden: 0 });
  assert.equal(failure.screen?.afterDispatch, false);
  assert.ok(failure.screen!.ageMs > 0);
  assert.match(
    failure.suggestion!,
    /line 1 was on screen and disabled; consider adding, before line 1/,
  );
  assert.doesNotMatch(failure.suggestion!, /Wait/);
  assert.match(failure.seen, /; last observed on screen: /);
});

test('an absent target suggests inserting a step and names enabled controls by id', async () => {
  const ledger = await runPlan(
    plan('1. Tap "Continue"\n2. Tap "Submit"\n'),
    deps([pad(), screen([control('@next', 'Next', { testID: 'qa-next' })])]),
  );
  const failure = ledger.failure!;
  assert.equal(failure.step, 2);
  assert.equal(failure.subreason, 'absent');
  // The capture after the press is newer than the dispatch.
  assert.equal(failure.screen?.afterDispatch, false);
  assert.match(failure.suggestion!, /lists 1 enabled controls in failure\.screen; .*before line 2/);
  assert.doesNotMatch(failure.suggestion!, /qa-next/);
});

test('a label shared by two controls suggests a unique testID', async () => {
  const ledger = await runPlan(
    plan('1. Tap "Agree"\n'),
    deps([screen([control('@a', 'Agree'), control('@b', 'Agree')])]),
  );
  assert.equal(ledger.failure?.subreason, 'ambiguous');
  assert.match(ledger.failure!.suggestion!, /line 1 matched more than one control/);
});

test('an unmet quoted wait carries the last observed screen', async () => {
  const ledger = await runPlan(plan('1. Wait for "Done"\n'), deps([pad()]));
  assert.equal(ledger.failure?.subreason, 'absent');
  assert.equal(ledger.failure?.screen?.counts.controls, 2);
});

test('a failure that is not about the target carries no last screen', async () => {
  const ledger = await runPlan(plan('1. Tap "Continue"\n'), deps([pad()]));
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal(ledger.failure?.screen, undefined);
  assert.equal(ledger.failure?.suggestion, undefined);
});

test('a secure field masks every label while identifiers remain', async () => {
  const ledger = await runPlan(
    plan('1. Tap "Submit"\n'),
    deps([
      screen([
        control('@pw', 'Password', { kind: 'input', secure: true, testID: 'qa-password' }),
        control('@go', 'Sign in', { testID: 'qa-sign-in' }),
      ]),
    ]),
  );
  const controls = ledger.failure!.screen!.controls;
  assert.deepEqual(
    controls.map((c) => [c.id, c.label]),
    [
      ['qa-password', MASK],
      ['qa-sign-in', MASK],
    ],
  );
});

test('a secret input value never appears in the screen, suggestion or ledger', async () => {
  const value = 'zq-s3cret-7781';
  const inputs = new RunInputs({ SECRET: value }, ['SECRET']);
  const ledger = await withInputs(inputs, () =>
    runPlan(
      plan('1. Fill "code" with input SECRET\n2. Tap "Submit"\n'),
      deps([
        screen([control('@code', 'code', { kind: 'input', testID: 'code' })]),
        screen([
          control('@code', value, { kind: 'input', testID: 'code' }),
          control('@shown', `Saved ${value}`, { testID: `qa-${value}` }),
        ]),
      ]),
    ),
  );
  assert.equal(ledger.failure?.step, 2);
  assert.ok(ledger.failure?.screen?.controls.some((c) => c.id === MASK));
  assert.ok(!JSON.stringify(ledger).includes(value));
});
