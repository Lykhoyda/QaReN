// Scroll-container marker: recorded per native element while the screen is read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isScrollContainer, join } from '../../../dist/qa/screen.js';

const RECT = { x: 0, y: 0, width: 1080, height: 2424 };

test('(j) a native scroll class is a container and a plain view group is not', () => {
  const screen = join(
    [
      { ref: '@app', index: 0, type: 'Application', rect: RECT },
      { ref: '@win', index: 1, parentIndex: 0, type: 'Window', rect: RECT },
      { ref: '@group', index: 2, parentIndex: 1, type: 'android.view.ViewGroup', rect: RECT },
      { ref: '@list', index: 3, parentIndex: 2, type: 'android.widget.ScrollView', rect: RECT },
    ],
    [],
  );
  assert.equal(isScrollContainer(screen.elements[3]), true);
  assert.equal(isScrollContainer(screen.elements[2]), false);
});

test('(i) a React-only element is never a container', () => {
  const screen = join(
    [{ ref: '@app', index: 0, type: 'Application', rect: RECT }],
    [{ role: 'button', testID: 'react-list' }],
  );
  const reactOnly = screen.elements.find((e) => e.ref === 'react:react-list');
  assert.ok(reactOnly);
  assert.equal(isScrollContainer(reactOnly), false);
});
