// The Test App option sheet as the runners report it, with the screen it covers drawn first.
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';

export const ANDROID_LIST = { x: 37, y: 949, width: 1006, height: 504 };
const ANDROID_SCREEN = { x: 0, y: 0, width: 1080, height: 2424 };
const ANDROID_ROW = 168;

// Rows outside the list collapse to zero height, as the Android runner reports them; `shift` scrolls the list.
// `extra` nodes take indices from 31.
export function androidOptionSheet(shift = 0, extra: NativeNode[] = []): Screen {
  const rows: NativeNode[] = Array.from({ length: 20 }, (_, i) => {
    const y = ANDROID_LIST.y + ANDROID_ROW * i - shift;
    const inside = y >= ANDROID_LIST.y && y + ANDROID_ROW <= ANDROID_LIST.y + ANDROID_LIST.height;
    return {
      ref: `@option-${i + 1}`,
      index: 11 + i,
      parentIndex: 10,
      type: 'android.widget.Button',
      identifier: `qa-sheet-capture-option-${i + 1}`,
      label: `Option ${i + 1}`,
      hittable: inside,
      rect: { x: ANDROID_LIST.x, y, width: ANDROID_LIST.width, height: inside ? ANDROID_ROW : 0 },
    };
  });
  return join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: ANDROID_SCREEN },
      { ref: '@home-win', index: 1, parentIndex: 0, type: 'Window', rect: ANDROID_SCREEN },
      {
        ref: '@home-list',
        index: 2,
        parentIndex: 1,
        type: 'android.widget.ScrollView',
        rect: ANDROID_SCREEN,
      },
      ...[0, 1, 2, 3].map((k) => ({
        ref: `@home-row-${k}`,
        index: 3 + k,
        parentIndex: 2,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: { x: 0, y: 872 + ANDROID_ROW * k, width: 1080, height: ANDROID_ROW },
      })),
      { ref: '@sheet-win', index: 7, parentIndex: 0, type: 'Window', rect: ANDROID_SCREEN },
      {
        ref: '@sheet',
        index: 8,
        parentIndex: 7,
        type: 'android.view.ViewGroup',
        rect: { x: 0, y: 900, width: 1080, height: 1524 },
      },
      {
        ref: '@list',
        index: 9,
        parentIndex: 8,
        type: 'android.widget.ScrollView',
        rect: ANDROID_LIST,
      },
      {
        ref: '@content',
        index: 10,
        parentIndex: 9,
        type: 'android.view.ViewGroup',
        rect: { ...ANDROID_LIST, y: ANDROID_LIST.y - shift, height: ANDROID_ROW * 20 },
      },
      ...rows,
      ...extra,
      {
        ref: '@keyboard',
        index: 31 + extra.length,
        parentIndex: 0,
        type: 'Keyboard',
        rect: { x: 0, y: 1541, width: 1080, height: 883 },
      },
    ],
    [],
  );
}

export const IOS_LIST = { x: 20, y: 357, width: 362, height: 517 };
const IOS_SCREEN = { x: 0, y: 0, width: 402, height: 874 };
const IOS_ROW = 64;

// The list stretches under the keyboard; its rows are direct children, row 17 at `row17Y`.
export function iosOptionSheet(row17Y: number): Screen {
  const rows: NativeNode[] = Array.from({ length: 20 }, (_, i) => {
    const y = row17Y + IOS_ROW * (i - 16);
    return {
      ref: `@option-${i + 1}`,
      index: 4 + i,
      parentIndex: 3,
      type: 'Button',
      identifier: `qa-sheet-capture-option-${i + 1}`,
      label: `Option ${i + 1}`,
      // XCUI reports a row hittable by its centre, including one under the keyboard window.
      hittable: y + IOS_ROW / 2 >= IOS_LIST.y && y + IOS_ROW / 2 < IOS_LIST.y + IOS_LIST.height,
      rect: { x: IOS_LIST.x, y, width: IOS_LIST.width, height: IOS_ROW },
    };
  });
  return join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: IOS_SCREEN },
      { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect: IOS_SCREEN },
      {
        ref: '@sheet',
        index: 2,
        parentIndex: 1,
        type: 'Other',
        rect: { x: 0, y: 300, width: 402, height: 574 },
      },
      { ref: '@list', index: 3, parentIndex: 2, type: 'ScrollView', rect: IOS_LIST },
      ...rows,
      { ref: '@kw', index: 24, parentIndex: 0, type: 'Window', rect: IOS_SCREEN },
      {
        ref: '@keyboard',
        index: 25,
        parentIndex: 24,
        type: 'Keyboard',
        rect: { x: 0, y: 568, width: 402, height: 306 },
      },
    ],
    [],
  );
}

export const byRef = (screen: Screen, ref: string) => screen.elements.find((e) => e.ref === ref)!;
