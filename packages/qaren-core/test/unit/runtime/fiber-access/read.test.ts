import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  descriptorValue,
  imageSourcePlaceholderFacts,
  QA_POINTER_EVENTS,
  qaData,
  qaHostType,
  qaStyleFact,
} from '../../../../dist/runtime/fiber-access/read.js';
import { devFreeze } from '../../qa/rn-dev-freeze.ts';
import { base, outcome } from './base-implementation.ts';

type Case = [label: string, ...args: unknown[]];

function sameAsBase(name: string, typed: (...args: never[]) => unknown, cases: Case[]) {
  for (const [label, ...args] of cases) {
    const expected = outcome(() => base[name]!(...args));
    const actual = outcome(() => (typed as (...values: unknown[]) => unknown)(...args));
    assert.deepEqual(actual, expected, `${name}: ${label}`);
  }
}

const inherited = Object.create({ inheritedKey: 1 });
const getter = {
  get value() {
    return 'getter';
  },
};
const frozen = devFreeze({ label: 'frozen', nested: devFreeze({ disabled: true }) });
const callable = Object.assign(function named() {}, { tag: 'fn' });

test('G: qaData reads own data, refuses accessors and inherited keys, and admits dev-frozen values', () => {
  sameAsBase('qaData', qaData, [
    ['null', null, 'a'],
    ['undefined', undefined, 'a'],
    ['number', 5, 'a'],
    ['string', 'text', 'length'],
    ['boolean', true, 'a'],
    ['data property', { a: 1 }, 'a'],
    ['missing key', {}, 'missing'],
    ['inherited key', inherited, 'inheritedKey'],
    ['getter', getter, 'value'],
    ['getter, devFrozen', getter, 'value', true],
    ['frozen identity, not devFrozen', frozen, 'label'],
    ['frozen identity, devFrozen', frozen, 'label', true],
    ['devFrozen must be true', frozen, 'label', 1],
    ['function', callable, 'tag'],
    ['array length', [1, 2], 'length'],
    ['prototype name', {}, 'toString'],
  ]);
  assert.equal(qaData(frozen, 'label', true), 'frozen');
  assert.throws(() => qaData(getter, 'value', true), /Capture refused/);
});

test('G: descriptorValue returns data values and only invokes RN dev-freeze accessors', () => {
  const bound = Object.getOwnPropertyDescriptor(frozen, 'label')!;
  sameAsBase('descriptorValue', descriptorValue, [
    ['data', {}, { value: 3 }],
    ['data undefined', {}, { value: undefined }],
    ['accessor on unfrozen object', {}, bound],
    ['bound identity', frozen, bound],
    ['plain getter', Object.freeze({}), Object.getOwnPropertyDescriptor(getter, 'value')!],
    ['getter only', frozen, { get: bound.get }],
    ['no accessors', frozen, {}],
  ]);
});

test('G: qaStyleFact walks nested style arrays from the end and bounds their depth', () => {
  let deep: unknown = { zIndex: 4 };
  for (let level = 0; level < 33; level++) deep = [deep];
  let deepest: unknown = { zIndex: 4 };
  for (let level = 0; level < 32; level++) deepest = [deepest];
  sameAsBase('qaStyleFact', qaStyleFact, [
    ['null', null, 'zIndex', 0],
    ['false', false, 'zIndex', 0],
    ['object', { zIndex: 1 }, 'zIndex', 0],
    ['last wins', [{ zIndex: 1 }, { zIndex: 2 }], 'zIndex', 0],
    ['nested', [{ zIndex: 1 }, [null, { pointerEvents: 'none' }]], 'pointerEvents', 0],
    ['holes and falsy', [undefined, false, null], 'zIndex', 0],
    ['frozen', devFreeze([devFreeze({ zIndex: 7 })]), 'zIndex', 0],
    ['number style id', 12, 'zIndex', 0],
    ['string', 'flex', 'zIndex', 0],
    ['depth 32 holds', deepest, 'zIndex', 0],
    ['depth 33 refuses', deep, 'zIndex', 0],
    ['starting depth', { zIndex: 1 }, 'zIndex', 40],
    ['missing', [{ a: 1 }], 'zIndex', 0],
  ]);
  assert.deepEqual(QA_POINTER_EVENTS, base.QA_POINTER_EVENTS);
});

function host(name: unknown, type: unknown = 'RCTView', viaCanonical = true) {
  const viewConfig = { uiViewClassName: name };
  return { tag: 5, type, stateNode: viaCanonical ? { canonical: { viewConfig } } : { viewConfig } };
}

test('G: qaHostType prefers the native view name and falls back to a string type', () => {
  sameAsBase('qaHostType', qaHostType, [
    ['canonical', host('RCTText')],
    ['paper', host('RCTImageView', 'Image', false)],
    ['no view name', host(undefined, 'RCTView')],
    ['no view name, composite', host(undefined, { displayName: 'X' })],
    ['empty name', host('', 'Fallback')],
    ['non-string name', host(5)],
    ['long name', host('x'.repeat(201))],
    ['name 200', host('x'.repeat(200))],
    ['no state', { tag: 5, type: 'RCTView', stateNode: null }],
    [
      'accessor state',
      {
        tag: 5,
        type: 'RCTView',
        get stateNode() {
          return {};
        },
      },
    ],
  ]);
});

function image(
  props: Record<string, unknown>,
  attributes: Record<string, unknown>,
  name = 'ViewManagerAdapter_ExpoImage',
) {
  return [
    {
      tag: 5,
      type: 'ViewManagerAdapter_ExpoImage',
      stateNode: {
        canonical: { viewConfig: { uiViewClassName: name, validAttributes: attributes } },
      },
    },
    props,
  ] as const;
}

test('G: imageSourcePlaceholderFacts recognizes only the native image source and placeholder', () => {
  const process = () => 'never called';
  const cases: Case[] = [
    ['plain', ...image({}, { source: true, placeholder: true })],
    ['processors', ...image({}, { source: { process }, placeholder: { process } })],
    ['other host', ...image({}, { source: true, placeholder: true }, 'RCTImageView')],
    ['no source', ...image({}, { placeholder: true })],
    ['source false', ...image({}, { source: false, placeholder: true })],
    ['non-function process', ...image({}, { source: { process: 1 }, placeholder: true })],
    ['role image', ...image({ role: 'image' }, { source: true, placeholder: true })],
    ['role searchbox', ...image({ role: 'SearchBox' }, { source: true, placeholder: true })],
    [
      'accessibilityRole textinput',
      ...image({ accessibilityRole: 'textinput' }, { source: true, placeholder: true }),
    ],
    ['non-string role', ...image({ role: 3 }, { source: true, placeholder: true })],
    ['input handler', ...image({ onChangeText() {} }, { source: true, placeholder: true })],
    ['editable false', ...image({ editable: false }, { source: true, placeholder: true })],
  ];
  sameAsBase('imageSourcePlaceholderFacts', imageSourcePlaceholderFacts, cases);
  const [fiber, props] = image({}, { source: true, placeholder: { process } });
  const facts = imageSourcePlaceholderFacts(fiber, props)!;
  assert.equal(facts.length, 6);
  assert.equal(
    facts[0],
    fiber.stateNode.canonical.viewConfig,
    'facts hold the app objects themselves',
  );
});
