import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '../src/components/Button';

const window = new Window({ url: 'https://qaren.test/' });
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);
Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const container = window.document.createElement('div');
window.document.body.append(container);
const root = createRoot(container);

afterEach(async () => {
  await act(async () => root.render(null));
});

afterAll(async () => {
  await act(async () => root.unmount());
  await window.happyDOM.close();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (previousActEnvironment)
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

// Button's public contract: enabled controls call back; disabled controls cannot activate.
for (const href of [undefined, '#destination']) {
  test(`Button calls onClick when enabled (${href ? 'link' : 'button'})`, async () => {
    let clicks = 0;
    await act(async () =>
      root.render(
        <Button href={href} onClick={() => clicks++}>
          Continue
        </Button>,
      ),
    );
    container.firstElementChild!.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(clicks).toBe(1);
    if (href) expect(container.firstElementChild!.getAttribute('href')).toBe(href);
  });

  test(`Button blocks activation when disabled (${href ? 'link' : 'button'})`, async () => {
    let clicks = 0;
    await act(async () =>
      root.render(
        <Button href={href} disabled onClick={() => clicks++}>
          Continue
        </Button>,
      ),
    );
    const control = container.firstElementChild!;
    control.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(clicks).toBe(0);
    if (href) {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.hasAttribute('href')).toBe(false);
      expect(control.getAttribute('role')).toBe('link');
      expect(control.getAttribute('tabindex')).toBe('-1');
    } else expect(control.hasAttribute('disabled')).toBe(true);
  });
}
