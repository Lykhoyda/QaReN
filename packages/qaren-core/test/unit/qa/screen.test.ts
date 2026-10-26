import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actionView,
  assertionView,
  describe,
  join as joinScreen,
  kindOf,
  screenSignature,
} from '../../../dist/qa/screen.js';
import type { DigestEntry, NativeNode } from '../../../dist/qa/screen.js';
import { redactEvidence } from '../../../dist/qa/privacy.js';

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(
  readFileSync(join(here, '../../fixtures/device-snapshot.json'), 'utf8'),
) as {
  data: { nodes: NativeNode[] };
};
const digest = JSON.parse(
  readFileSync(join(here, '../../fixtures/device-digest.json'), 'utf8'),
) as {
  interactive: DigestEntry[];
};

test('the 56-node snapshot joins the digest by testID, then by label', () => {
  const screen = joinScreen(snapshot.data.nodes, digest.interactive);
  const byRef = new Map(screen.elements.map((e) => [e.ref, e]));

  const button = byRef.get('@e34')!;
  assert.equal(button.kind, 'button');
  assert.equal(button.label, 'Increment');
  assert.equal(button.testID, 'fixture_button');
  assert.equal(button.hittable, true);
  assert.equal(button.where, 'top');
  assert.equal(button.side, 'left');

  const input = byRef.get('@e36')!;
  assert.equal(input.kind, 'input');
  assert.equal(input.placeholder, 'type here', 'placeholder comes from the digest join on testID');
  assert.equal(input.testID, 'fixture_input');

  const tap = byRef.get('@e53')!;
  assert.equal(tap.kind, 'button');
  assert.equal(tap.label, 'Tap');
  assert.equal(tap.where, 'bottom');
  assert.equal(tap.side, 'right');
  assert.equal(
    screen.elements.filter((e) => e.label === 'Tap' && !e.offscreen).length,
    1,
    'the label fallback binds one digest entry to one native node',
  );

  assert.equal(screen.elements.filter((e) => !e.offscreen).length, 56);
  assert.equal(screen.front, 'app');
});

test('unmatched interactive digest entries become react:<testID> off-screen candidates', () => {
  const screen = joinScreen(snapshot.data.nodes, digest.interactive);
  const offscreen = screen.elements.filter((e) => e.offscreen);
  assert.deepEqual(
    offscreen.map((e) => [e.ref, e.kind, e.label, e.value, e.hittable]),
    [
      // React-only elements keep identity and capability, never user-visible strings.
      ['react:fixture_hidden_cta', 'button', undefined, undefined, false],
      ['react:fixture_hidden_toggle', 'switch', undefined, undefined, false],
    ],
    'entries without a testID cannot be addressed and are dropped',
  );
  const action = actionView(screen);
  assert.ok(action.some((e) => e.ref === 'react:fixture_hidden_cta'));
  assert.ok(action.every((e) => e.offscreen || (e.hittable && !e.disabled)));
  assert.equal(describe(offscreen[0]), 'Button [testID fixture_hidden_cta] off screen');
  assert.equal(
    describe(screen.elements.find((e) => e.ref === '@e53')!),
    'Button "Tap" [testID fixture_bottom_button] bottom-right',
  );
});

test('visibleText reads top to bottom, left to right, with inputs as label: value', () => {
  const observed = joinScreen(snapshot.data.nodes, digest.interactive);
  const text = assertionView(observed);
  const first = text.indexOf('10:08');
  const fixture = text.indexOf('Fixture');
  const increment = text.indexOf('Increment');
  const count = text.indexOf('count: 1');
  const row73 = text.indexOf('row 73');
  const bottom = text.indexOf('bottom taps: 0');
  assert.ok(
    first >= 0 &&
      first < fixture &&
      fixture < increment &&
      increment < count &&
      count < row73 &&
      row73 < bottom,
    text.join(' | '),
  );
  assert.ok(text.includes('type here'), 'an input without a value shows its label');
  assert.ok(
    !redactEvidence(observed, text.join(' | ')).includes('type here'),
    'ambiguous Android input labels are private in outward evidence',
  );

  const withValue = joinScreen(
    [
      {
        ref: '@e0',
        type: 'TextField',
        label: 'Email',
        value: 'a@b.co',
        hittable: true,
        rect: { x: 0, y: 0, width: 100, height: 20 },
      },
      {
        ref: '@e1',
        type: 'StaticText',
        label: 'Welcome',
        hittable: true,
        rect: { x: 0, y: 30, width: 100, height: 20 },
      },
    ],
    [],
  );
  assert.deepEqual(assertionView(withValue), ['Email: a@b.co', 'Welcome']);
});

test('secure values stay out of public values and evidence; image labels are not visible text', () => {
  const screen = joinScreen(
    [
      {
        ref: '@e0',
        type: 'SecureTextField',
        label: 'Password',
        value: 'hunter2',
        hittable: true,
        rect: { x: 0, y: 0, width: 100, height: 20 },
      },
      {
        ref: '@e1',
        type: 'Image',
        label: 'Wifi signal full.',
        hittable: true,
        rect: { x: 0, y: 30, width: 20, height: 20 },
      },
      {
        ref: '@e2',
        type: 'Button',
        label: 'Sign in',
        hittable: true,
        rect: { x: 0, y: 60, width: 100, height: 20 },
      },
    ],
    [{ role: 'textinput', text: 'Password', value: 'hunter2' }],
  );
  const secure = screen.elements[0];
  assert.equal(secure.secure, true);
  assert.equal(secure.value, undefined);
  assert.ok(!describe(secure).includes('hunter2'));
  assert.ok(!screenSignature(screen).includes('hunter2'));
  assert.deepEqual(assertionView(screen), ['Password', 'Sign in']);
});

test('kinds map iOS element types and Android class names', () => {
  assert.equal(kindOf('Button'), 'button');
  assert.equal(kindOf('SecureTextField'), 'input');
  assert.equal(kindOf('StaticText'), 'text');
  assert.equal(kindOf('android.widget.EditText'), 'input');
  assert.equal(kindOf('android.widget.ImageButton'), 'button');
  assert.equal(kindOf('android.widget.Switch'), 'switch');
  assert.equal(kindOf('android.widget.ToggleButton'), 'switch');
  assert.equal(kindOf('android.widget.RadioButton'), 'switch');
  assert.equal(kindOf('android.widget.FrameLayout'), 'other');
  assert.equal(kindOf(undefined), 'other');
});

test('the screen signature changes with every user-visible difference and only those', () => {
  const nodes = snapshot.data.nodes;
  const base = screenSignature(joinScreen(nodes, digest.interactive));
  assert.equal(
    base,
    screenSignature(joinScreen(nodes, digest.interactive)),
    'a re-capture of the same screen is equal',
  );
  const variants: Array<[string, NativeNode[], DigestEntry[]]> = [
    [
      'a label changed',
      nodes.map((n) => (n.ref === '@e35' ? { ...n, label: 'count: 2' } : n)),
      digest.interactive,
    ],
    ['an element disappeared', nodes.filter((n) => n.ref !== '@e53'), digest.interactive],
    [
      'an element appeared',
      [
        ...nodes,
        {
          ref: '@e56',
          type: 'android.widget.TextView',
          label: 'Saved',
          hittable: true,
          rect: { x: 0, y: 2300, width: 100, height: 30 },
        },
      ],
      digest.interactive,
    ],
    [
      'an input value changed',
      nodes.map((n) => (n.ref === '@e36' ? { ...n, value: 'hello' } : n)),
      digest.interactive,
    ],
    [
      'an element became disabled',
      nodes.map((n) => (n.ref === '@e34' ? { ...n, enabled: false } : n)),
      digest.interactive,
    ],
    [
      'an element stopped being hittable',
      nodes.map((n) => (n.ref === '@e34' ? { ...n, hittable: false } : n)),
      digest.interactive,
    ],
    [
      'an element moved to another band',
      nodes.map((n) =>
        n.ref === '@e34' ? { ...n, rect: { x: 0, y: 2200, width: 231, height: 126 } } : n,
      ),
      digest.interactive,
    ],
    [
      'an off-screen candidate appeared',
      nodes,
      [...digest.interactive, { role: 'button', testID: 'later', text: 'Later' }],
    ],
  ];
  for (const [name, n, d] of variants) {
    assert.notEqual(screenSignature(joinScreen(n, d)), base, name);
  }
  const jitter = nodes.map((n) =>
    n.ref === '@e34' && n.rect ? { ...n, rect: { ...n.rect, y: n.rect.y + 2 } } : n,
  );
  assert.equal(
    screenSignature(joinScreen(jitter, digest.interactive)),
    base,
    'a 2px shift inside the same band is not a change',
  );
});

test('the screen signature returns canonical content without hashing', () => {
  const screen = joinScreen(
    [
      { ref: '@e0', type: 'Button', label: 'Save', identifier: 'save', hittable: true },
      { ref: '@e1', type: 'SecureTextField', label: 'Password', value: 'hunter2' },
    ],
    [],
  );
  const signature = screenSignature(screen);
  const content = JSON.parse(signature);
  assert.equal(content.front, 'app');
  assert.deepEqual(content.text, ['Save']);
  assert.deepEqual(content.elements[0], [
    'button',
    'Save',
    'save',
    null,
    true,
    false,
    false,
    false,
    null,
    null,
  ]);
  assert.equal(content.elements[1][3], null);
  assert.ok(!signature.includes('hunter2'));
  assert.equal(signature, screenSignature(structuredClone(screen)));
  assert.notEqual(signature, screenSignature({ ...screen, front: 'dialog' }));
});

test('a keyboard with captured keys adds nothing beyond its keys to the screen signature', () => {
  const nodes: NativeNode[] = [
    {
      ref: '@app',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      ref: '@kb',
      index: 1,
      parentIndex: 0,
      type: 'Keyboard',
      rect: { x: 0, y: 560, width: 402, height: 314 },
    },
    {
      ref: '@q',
      index: 2,
      parentIndex: 1,
      type: 'Key',
      label: 'q',
      rect: { x: 4, y: 570, width: 36, height: 44 },
    },
  ];
  const screen = joinScreen(nodes, []);
  assert.equal(screen.keylessKeyboard, undefined);
  assert.equal(JSON.parse(screenSignature(screen)).keyboard, undefined);
  const keyless = joinScreen(nodes.slice(0, 2), []);
  assert.equal(keyless.keylessKeyboard, true);
  assert.equal(JSON.parse(screenSignature(keyless)).keyboard, true);
});
