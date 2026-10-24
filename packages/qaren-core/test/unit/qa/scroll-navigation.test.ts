import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, isScrollContainer, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { scrollNavigationChange } from '../../../dist/qa/scroll-navigation.js';

const frame = { x: 0, y: 100, width: 390, height: 600 };

function screen(
  options: {
    tab?: string;
    title?: string;
    titleHeight?: number;
    titleType?: string;
    titleIdentifier?: string;
    rowY?: number;
    rowLabel?: string;
    header?: boolean;
    list?: boolean;
    listType?: string;
    listID?: string | false;
    listFrame?: typeof frame;
    keyboard?: boolean;
  } = {},
): Screen {
  const nodes: NativeNode[] = [
    { ref: '@window', index: 0, type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      ref: '@tab',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      selected: true,
      label: options.tab ?? 'Policies',
      rect: { x: 0, y: 780, width: 150, height: 44 },
    },
    {
      ref: '@title',
      index: 2,
      parentIndex: 0,
      type: options.titleType ?? 'NavigationBar',
      identifier: options.titleIdentifier,
      label: options.title ?? 'Policies',
      rect: { x: 0, y: 20, width: 390, height: options.titleHeight ?? 70 },
    },
  ];
  if (options.list !== false) {
    nodes.push(
      {
        ref: '@list',
        index: 3,
        parentIndex: 0,
        type: options.listType ?? 'ScrollView',
        identifier: options.listID === false ? undefined : (options.listID ?? 'policies'),
        rect: options.listFrame ?? frame,
      },
      {
        ref: '@row',
        index: 4,
        parentIndex: 3,
        type: 'Button',
        selected: true,
        label: options.rowLabel ?? 'Policy',
        rect: { x: 0, y: options.rowY ?? 500, width: 390, height: 44 },
      },
    );
  }
  if (options.header !== false)
    nodes.push({
      ref: '@header',
      index: 5,
      parentIndex: 0,
      type: 'StaticText',
      label: 'Welcome',
      rect: { x: 0, y: 100, width: 390, height: 44 },
    });
  if (options.keyboard)
    nodes.push({
      ref: '@keyboard',
      index: 6,
      parentIndex: 0,
      type: 'Keyboard',
      rect: { x: 0, y: 500, width: 390, height: 344 },
    });
  return join(nodes, []);
}

function change(before: Screen, after: Screen): string | undefined {
  return scrollNavigationChange(before, after, before.elements.find(isScrollContainer));
}

test('selected tab changes stop scrolling', () => {
  assert.match(change(screen(), screen({ tab: 'Claims' }))!, /selected/);
});

test('native navigation-bar label and identifier changes stop scrolling', () => {
  assert.match(change(screen(), screen({ title: 'Claims' }))!, /title/);
  assert.match(
    change(screen({ titleIdentifier: 'Policies' }), screen({ titleIdentifier: 'Claims' }))!,
    /title/,
  );
});

test('JS-only header changes have no native title marker', () => {
  assert.equal(
    change(
      screen({ titleType: 'StaticText' }),
      screen({ titleType: 'StaticText', title: 'Claims' }),
    ),
    undefined,
  );
});

for (const type of [
  'android.widget.Toolbar',
  'androidx.appcompat.widget.Toolbar',
  'android.app.ActionBar',
  'com.android.internal.widget.ActionBarView',
]) {
  test(`ordinary Android title text stops navigation: ${type}`, () => {
    const android = (label: string) =>
      join(
        [
          { type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } },
          { type, parentIndex: 0, rect: { x: 0, y: 0, width: 390, height: 80 } },
          {
            type: 'android.widget.TextView',
            parentIndex: 1,
            label,
            rect: { x: 40, y: 20, width: 200, height: 30 },
          },
        ],
        [],
      );
    assert.match(change(android('Policies'), android('Claims'))!, /title/);
    assert.equal(change(android('Policies'), android('Policies')), undefined);
  });
}

test('a disappeared, replaced or differently typed dragged list stops scrolling', () => {
  for (const after of [
    screen({ list: false }),
    screen({ listID: 'claims' }),
    screen({ listType: 'CollectionView' }),
  ]) {
    assert.match(change(screen(), after)!, /scrolled list/);
  }
});

test('moving rows and changing selection inside the list do not count as navigation', () => {
  assert.equal(change(screen(), screen({ rowY: 200, rowLabel: 'Next policy' })), undefined);
});

test('a large navigation title can collapse without changing identity', () => {
  assert.equal(change(screen(), screen({ titleHeight: 30 })), undefined);
});

test('an ordinary header label can scroll away', () => {
  assert.equal(change(screen(), screen({ header: false })), undefined);
});

test('an identified list can resize without changing the screen', () => {
  assert.equal(change(screen({ listFrame: { ...frame, height: 400 } }), screen()), undefined);
});

test('dismissing the keyboard can expand the same identified list', () => {
  assert.equal(
    change(screen({ keyboard: true, listFrame: { ...frame, height: 400 } }), screen()),
    undefined,
  );
});

test('a collapsing header can move and expand the same identified list', () => {
  assert.equal(
    change(screen(), screen({ titleHeight: 30, listFrame: { ...frame, y: 60, height: 640 } })),
    undefined,
  );
});

test('unidentified list frames tolerate two points on every axis', () => {
  for (const axis of ['x', 'y', 'width', 'height'] as const) {
    for (const sign of [-1, 1]) {
      assert.equal(
        change(
          screen({ listID: false }),
          screen({
            listID: false,
            listFrame: {
              ...frame,
              [axis]: frame[axis] + sign * 2,
            },
          }),
        ),
        undefined,
      );
      assert.match(
        change(
          screen({ listID: false }),
          screen({
            listID: false,
            listFrame: {
              ...frame,
              [axis]: frame[axis] + sign * 3,
            },
          }),
        )!,
        /scrolled list/,
      );
    }
  }
});

test('selected controls use stable test IDs when their labels change', () => {
  const before = screen();
  const after = screen({ tab: 'Your policies' });
  for (const s of [before, after])
    s.elements.find((element) => element.ref === '@tab')!.testID = 'policies-tab';
  assert.equal(change(before, after), undefined);
});
