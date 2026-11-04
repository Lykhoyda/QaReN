import { expect, test } from 'bun:test';
import { themeScript } from './theme-script.ts';

const run = new Function('document', 'localStorage', themeScript);

test('theme script applies dark before reading blocked storage', () => {
  const document = { documentElement: { dataset: { theme: 'light' } } };
  let themeAtRead: string | undefined;
  let keyRead: string | undefined;
  run(document, {
    getItem(key: string) {
      keyRead = key;
      themeAtRead = document.documentElement.dataset.theme;
      throw new Error('Storage blocked');
    },
  });
  expect(keyRead).toBe('qaren-theme');
  expect(themeAtRead).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
});

for (const stored of ['light', 'dark', null, 'invalid']) {
  test(`theme script handles stored ${stored}`, () => {
    const document = { documentElement: { dataset: { theme: 'light' } } };
    run(document, {
      getItem(key: string) {
        expect(key).toBe('qaren-theme');
        return stored;
      },
    });
    expect(document.documentElement.dataset.theme).toBe(
      stored === 'light' || stored === 'dark' ? stored : 'dark',
    );
  });
}
