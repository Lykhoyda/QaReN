import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failures, measure, ratio, resolve, type Tokens } from '../scripts/check-contrast';
import { PACKAGE_OWNED, componentsCss, sync } from '../scripts/sync-design';

const tokens: Tokens = JSON.parse(readFileSync(new URL('../tokens.json', import.meta.url), 'utf8'));

describe('check-contrast', () => {
  test('uses the WCAG 2 ratio', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#ffffff', '#ffffff')).toBe(1);
  });

  test('follows token references', () => {
    expect(resolve(tokens, 'focus', 'light')).toBe('#8a5a00');
  });

  test('reports a pair that drops below its floor', () => {
    const lowered: Tokens = structuredClone(tokens);
    lowered.color.tokens.find((t) => t.name === 'muted')!.value.light = '#c0c0c0';
    expect(failures(measure(tokens))).toEqual([]);
    expect(failures(measure(lowered))).toContain('muted on bg (light): 1.68:1 is below 4.5:1');
  });

  test('does not round a ratio up to its floor', () => {
    const row = { fg: 'a', bg: 'b', where: '', floor: 4.5, ratios: { dark: 4.496, light: 5 } };
    expect(failures([row])).toEqual(['a on b (dark): 4.50:1 is below 4.5:1']);
  });
});

describe('sync-design', () => {
  const bundle =
    "@import url('https://fonts.googleapis.com/css2?family=Inter&display=swap');\n\n.qr-root { color: var(--text); }\n";

  test('drops the font import and keeps the package-owned section', () => {
    const current = `.old {}\n\n${PACKAGE_OWNED}\n.qr-docs {}\n`;
    expect(componentsCss(bundle, current)).toBe(
      `.qr-root { color: var(--text); }\n\n${PACKAGE_OWNED}\n.qr-docs {}\n`,
    );
  });

  test('refuses other imports and a components.css without the owned section', () => {
    expect(() => componentsCss("@import url('x.css');\n.a {}", PACKAGE_OWNED)).toThrow(/@import/);
    expect(() => componentsCss(bundle, '.a {}')).toThrow(/package-owned/);
  });

  test('copies the saved files and reports what changed', () => {
    const src = mkdtempSync(join(tmpdir(), 'qr-sync-src-'));
    const pkg = mkdtempSync(join(tmpdir(), 'qr-sync-pkg-'));
    mkdirSync(join(src, 'components'));
    writeFileSync(join(src, 'tokens.css'), ':root {}\n');
    writeFileSync(join(src, 'tokens.json'), '{}\n');
    writeFileSync(join(src, 'contrast.md'), '# Contrast\n');
    writeFileSync(join(src, 'components/bundle.css'), bundle);
    writeFileSync(join(pkg, 'components.css'), `${PACKAGE_OWNED}\n`);
    writeFileSync(join(pkg, 'tokens.css'), ':root {}\n');

    expect(sync(src, pkg)).toEqual([
      { file: 'tokens.css', changed: false },
      { file: 'tokens.json', changed: true },
      { file: 'contrast.md', changed: true },
      { file: 'components.css', changed: true },
    ]);
    expect(sync(src, pkg).every((r) => !r.changed)).toBe(true);
    expect(readFileSync(join(pkg, 'components.css'), 'utf8')).not.toContain('@import');
  });

  test('refuses a source folder without the saved files', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qr-sync-empty-'));
    expect(() => sync(empty, empty)).toThrow(/missing/);
  });
});
