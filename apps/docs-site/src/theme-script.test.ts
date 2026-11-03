import { expect, test } from 'bun:test';
import { BASE_PATH } from './site.ts';
import { themeScript } from './theme-script.ts';

const run = new Function('document', 'location', 'localStorage', themeScript);

for (const [path, defaultTheme] of [
  ['/', 'dark'],
  ['/check/', 'light'],
] as const) {
  test(`theme script applies ${defaultTheme} before reading blocked storage on ${path}`, () => {
    const document = { documentElement: { dataset: { theme: 'light' } } };
    let themeAtRead: string | undefined;
    let keyRead: string | undefined;
    run(
      document,
      { pathname: `${BASE_PATH}${path}` },
      {
        getItem(key: string) {
          keyRead = key;
          themeAtRead = document.documentElement.dataset.theme;
          throw new Error('Storage blocked');
        },
      },
    );
    expect(keyRead).toBe('qaren-theme');
    expect(themeAtRead).toBe(defaultTheme);
    expect(document.documentElement.dataset.theme).toBe(defaultTheme);
  });

  for (const stored of ['light', 'dark', null, 'invalid']) {
    test(`theme script handles stored ${stored} on ${path}`, () => {
      const document = { documentElement: { dataset: { theme: 'light' } } };
      run(
        document,
        { pathname: `${BASE_PATH}${path}` },
        {
          getItem(key: string) {
            expect(key).toBe('qaren-theme');
            return stored;
          },
        },
      );
      expect(document.documentElement.dataset.theme).toBe(
        stored === 'light' || stored === 'dark' ? stored : defaultTheme,
      );
    });
  }
}
