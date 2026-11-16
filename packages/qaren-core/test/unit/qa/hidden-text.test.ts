import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenFromAccessibility, hiddenTextClause } from '../../../dist/qa/hidden-text.js';
import { MASK, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { RunInputs } from '../../../dist/qa/inputs.js';
import type { Target } from '../../../dist/qa/plan.js';
import type { ReactHostObservation, Screen } from '../../../dist/qa/screen.js';
import { hiddenCard } from './ios-hidden-card-captures.ts';

const quoted = (text: string, exact?: Target['exact']): Target => ({
  quoted: text,
  phrase: text,
  ...(exact ? { exact } : {}),
});

const frame = (rect: { x: number; y: number; width: number; height: number } | undefined) =>
  rect && [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 10) / 10).join(',');

test('device P1 presence read: each hidden card text names the button that holds it', () => {
  const read = hiddenCard('p1-obs22-presence');
  const alpha = hiddenFromAccessibility(quoted('Alpha plan'), read, 'exact');
  assert.deepEqual(alpha?.hosts, [43]);
  assert.equal(alpha?.via, 'text');
  assert.equal(alpha?.button?.host, 30);
  assert.equal(alpha?.button?.testID, undefined);
  assert.equal(alpha?.button?.labelled, false);
  assert.equal(frame(alpha?.button?.rect), '14,161.7,374,90');

  const bravo = hiddenFromAccessibility(quoted('Bravo plan'), read, 'exact');
  assert.deepEqual(
    [bravo?.via, bravo?.button?.host, bravo?.button?.testID],
    ['text', 31, 'qa-hidden-card-b'],
  );
  const title = hiddenFromAccessibility(quoted('qa-hidden-card-b-title'), read, 'exact');
  assert.deepEqual(
    [title?.hosts, title?.via, title?.button?.host, title?.button?.testID],
    [[45], 'id', 31, 'qa-hidden-card-b'],
  );

  const price = hiddenFromAccessibility(quoted('36 EUR'), read, 'exact');
  assert.equal(price?.button?.host, 32);
  assert.equal(price?.button?.labelled, true);

  // Delta's texts are not hidden: iOS composes them into the button's label.
  assert.equal(hiddenFromAccessibility(quoted('Delta plan'), read, 'exact'), undefined);
});

test('device P9 presence read: the popup card text names its unlabelled button', () => {
  const echo = hiddenFromAccessibility(
    quoted('Echo plan'),
    hiddenCard('p9-obs27-presence'),
    'exact',
  );
  assert.deepEqual(echo?.hosts, [82]);
  assert.equal(echo?.button?.host, 70);
  assert.equal(echo?.button?.labelled, false);
  assert.equal(frame(echo?.button?.rect), '14,87.7,374,90');
});

test('device P1 ordinary read carries no typography, so the lookup answers nothing', () => {
  const read = hiddenCard('p1-obs21-ordinary');
  for (const text of ['Alpha plan', 'Bravo plan', 'qa-hidden-card-b-title', '36 EUR', 'Delta plan'])
    assert.equal(hiddenFromAccessibility(quoted(text), read, 'exact'), undefined, text);
});

type Host = {
  parent: number | null;
  host?: Partial<ReactHostObservation>;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
  label?: 'present' | 'unknown';
};

// A hand-built read: only the React host evidence and typography the lookup reads.
function read(hosts: Host[], complete = true): Screen {
  return {
    elements: [],
    visibleText: [],
    front: 'app',
    coverage: { native: 'complete', react: 'complete' },
    reactHostEvidence: {
      complete: true,
      hosts: hosts.map((h) => ({ role: null, roleSource: 'none', capabilities: {}, ...h.host })),
      typography: {
        version: 1,
        complete,
        durationMs: 1,
        coordinateSpace: 'window-points',
        nodes: hosts.map((h, hostIndex) => ({
          hostIndex,
          parentHostIndex: h.parent,
          rootIndex: 0,
          hostType: h.text === undefined ? 'RCTView' : 'RCTText',
          accessibility: { accessible: 'true', authoredLabel: h.label ?? 'absent' },
          ...(h.rect ? { rect: h.rect } : {}),
          text:
            h.text === undefined
              ? { kind: 'none' }
              : {
                  kind: 'block',
                  content: h.text,
                  runs: [{ start: 0, end: h.text.length, fontSize: 17 }],
                  scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
                },
        })),
      },
    },
  };
}

const press = { capabilities: { press: true as const }, role: 'button' };
const hidden = { hidden: true as const };

test('two hidden texts under two buttons count both and name no button', () => {
  const found = hiddenFromAccessibility(
    quoted('Plan'),
    read([
      { parent: null },
      { parent: 0, host: press },
      { parent: 0, host: press },
      { parent: 1, host: hidden, text: 'Plan' },
      { parent: 2, host: hidden, text: 'Plan' },
    ]),
    'exact',
  );
  assert.deepEqual(found?.hosts, [3, 4]);
  assert.equal(found?.button, undefined);
});

test('a hidden text under no pressable names no button', () => {
  const found = hiddenFromAccessibility(
    quoted('Plan'),
    read([{ parent: null }, { parent: 0, host: hidden, text: 'Plan' }]),
    'exact',
  );
  assert.deepEqual(found, { hosts: [1], via: 'text' });
});

test('a hidden nearest pressable inside a visible outer pressable names no button', () => {
  const found = hiddenFromAccessibility(
    quoted('Plan'),
    read([
      { parent: null },
      { parent: 0, host: press },
      { parent: 1, host: { ...press, ...hidden } },
      { parent: 2, host: hidden, text: 'Plan' },
    ]),
    'exact',
  );
  assert.deepEqual(found?.hosts, [3]);
  assert.equal(found?.button, undefined);
});

test('a hidden text that takes a press itself names no outer button', () => {
  const found = hiddenFromAccessibility(
    quoted('Plan'),
    read([
      { parent: null },
      { parent: 0, host: press },
      { parent: 1, host: { ...press, ...hidden }, text: 'Plan' },
    ]),
    'exact',
  );
  assert.deepEqual(found, { hosts: [2], via: 'text' });
});

test('an unknown authored label is neither claimed present nor absent', () => {
  const found = hiddenFromAccessibility(
    quoted('Plan'),
    read([
      { parent: null },
      { parent: 0, host: press, label: 'unknown', rect: { x: 0, y: 0, width: 100, height: 50 } },
      { parent: 1, host: hidden, text: 'Plan' },
    ]),
    'exact',
  );
  assert.equal(found?.button?.host, 1);
  assert.equal(found?.button?.labelled, undefined);
  assert.equal(
    hiddenTextClause(found!, 'Plan', new ObservedPrivacy()),
    '; "Plan" is inside a button that hides its children from accessibility (the button at 0,0,100,50), so no element carries it',
  );
});

test('the clause names a labelled button by its frame and test id, and counts several texts', () => {
  const privacy = new ObservedPrivacy();
  const rect = { x: 0, y: 0, width: 100, height: 50 };
  const labelled = hiddenFromAccessibility(
    quoted('Plan'),
    read([
      { parent: null },
      { parent: 0, host: { ...press, testID: 'plan-card' }, label: 'present', rect },
      { parent: 1, host: hidden, text: 'Plan' },
    ]),
    'exact',
  );
  assert.equal(
    hiddenTextClause(labelled!, 'Plan', privacy),
    '; "Plan" is inside a button that hides its children from accessibility (the button at 0,0,100,50, testID "plan-card"); the button is reached by its own label or its testID "plan-card", not by this text',
  );
  const shared = hiddenFromAccessibility(
    quoted('Plan'),
    read([
      { parent: null },
      { parent: 0, host: { ...press, testID: 'plan-card' }, rect },
      { parent: 1, host: hidden, text: 'Plan' },
      { parent: 1, host: hidden, text: 'Plan' },
    ]),
    'exact',
  );
  assert.equal(
    hiddenTextClause(shared!, 'Plan', privacy),
    '; 2 texts hidden from accessibility carry "Plan", inside a button that hides its children from accessibility and has no accessibilityLabel (the button at 0,0,100,50, testID "plan-card"), so no element carries it. Give the button an accessibilityLabel, or target "plan-card"',
  );
  const secretPrivacy = new ObservedPrivacy();
  new RunInputs({ SECRET: 'zq-s3cret-7781' }, ['SECRET'], secretPrivacy);
  const secretId = hiddenFromAccessibility(
    quoted('Plan'),
    read([
      { parent: null },
      { parent: 0, host: { ...press, testID: 'card-zq-s3cret-7781' }, rect },
      { parent: 1, host: hidden, text: 'Plan' },
    ]),
    'exact',
  );
  const masked = hiddenTextClause(secretId!, 'Plan', secretPrivacy);
  assert.ok(masked.endsWith(`, or target ${MASK}`), masked);
  assert.ok(!masked.includes('card-'), masked);
  assert.equal(
    hiddenTextClause({ hosts: [0], via: 'text' }, 'Plan', privacy),
    '; "Plan" exists only inside a view the app hides from accessibility, so no element carries it',
  );
});

test('an id-only target does not match by text, and a text-only target not by id', () => {
  const screen = read([
    { parent: null },
    { parent: 0, host: press },
    { parent: 1, host: { ...hidden, testID: 'plan-title' }, text: 'Plan' },
  ]);
  assert.equal(hiddenFromAccessibility(quoted('Plan', 'id'), screen, 'exact'), undefined);
  assert.equal(hiddenFromAccessibility(quoted('plan-title', 'text'), screen, 'exact'), undefined);
  assert.equal(hiddenFromAccessibility(quoted('plan-title', 'id'), screen, 'exact')?.via, 'id');
  assert.equal(hiddenFromAccessibility(quoted('Plan', 'text'), screen, 'exact')?.via, 'text');
});

test('a part of a hidden text matches only by containing', () => {
  const screen = read([
    { parent: null },
    { parent: 0, host: press },
    { parent: 1, host: hidden, text: 'Alpha plan' },
  ]);
  assert.equal(hiddenFromAccessibility(quoted('Alpha'), screen, 'exact'), undefined);
  assert.equal(hiddenFromAccessibility(quoted('Alpha'), screen, 'contains')?.button?.host, 1);
});

test('incomplete typography, or an unquoted target, gives nothing', () => {
  const hosts: Host[] = [
    { parent: null },
    { parent: 0, host: press },
    { parent: 1, host: hidden, text: 'Plan' },
  ];
  assert.equal(hiddenFromAccessibility(quoted('Plan'), read(hosts, false), 'exact'), undefined);
  assert.equal(hiddenFromAccessibility({ phrase: 'Plan' }, read(hosts), 'exact'), undefined);
});
