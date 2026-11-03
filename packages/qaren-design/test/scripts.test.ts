import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterJs, bundleNames } from '../scripts/build-adapter';
import { check, parseTable, ratio, resolve, type Tokens } from '../scripts/check-contrast';
import { checkMirror } from '../scripts/check-design-mirror';
import { sync, type Inventory } from '../scripts/sync-design';

const design = new URL('../design/', import.meta.url);
const tokens: Tokens = JSON.parse(readFileSync(new URL('tokens.json', design), 'utf8'));
const contrast = readFileSync(new URL('contrast.md', design), 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `qr-${name}-`));

describe('check-contrast', () => {
  test('uses the WCAG 2 ratio and follows token references', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(resolve(tokens, 'focus', 'light')).toBe('#8a5a00');
  });

  test('the mirrored table agrees with the mirrored tokens', () => {
    expect(parseTable(contrast)).toHaveLength(30);
    expect(check(tokens, parseTable(contrast))).toEqual([]);
  });

  test('reports a printed ratio that disagrees with the tokens, and a pair under its floor', () => {
    const lowered: Tokens = structuredClone(tokens);
    lowered.color.tokens.find((t) => t.name === 'muted')!.value.light = '#c0c0c0';
    const problems = check(lowered, parseTable(contrast));
    expect(problems).toContain('muted on bg (light): contrast.md says 5.72:1, tokens give 1.68:1');
    expect(problems).toContain('muted on bg (light): 1.68:1 is below 4.5:1');
  });

  test('does not round a ratio up to its floor', () => {
    const both = (hex: string) => ({ dark: hex, light: hex });
    const pair: Tokens = {
      color: {
        tokens: [
          { name: 'a', value: both('#70768e') },
          { name: 'b', value: both('#ffffff') },
        ],
      },
    };
    const row = { fg: 'a', bg: 'b', floor: 4.5, printed: both('4.50') };
    expect(check(pair, [row])).toEqual([
      'a on b (dark): 4.50:1 is below 4.5:1',
      'a on b (light): 4.50:1 is below 4.5:1',
    ]);
  });

  test('refuses a table row it cannot read', () => {
    expect(() => parseTable('| `a` on `b` | x | 4.5:1 | lots | 1.00:1 (pass) |')).toThrow(
      /not understood/,
    );
  });
});

describe('sync-design and check-design-mirror', () => {
  const files = { 'tokens.css': ':root {}\n', 'components/bundle.js': '/* js */\n' };
  const inventory = (version = 'v1'): Inventory => ({
    version,
    files: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, sha(t)])),
  });
  const saved = () => {
    const dir = tmp('saved');
    mkdirSync(join(dir, 'components'));
    for (const [p, t] of Object.entries(files)) writeFileSync(join(dir, p), t);
    return dir;
  };
  const pkg = (version = 'v1') => {
    const dir = tmp('pkg');
    writeFileSync(join(dir, 'README.md'), `mirror at version ${version}\n`);
    return dir;
  };

  test('replaces design/ and writes the lock from the inventory', () => {
    const dir = pkg();
    mkdirSync(join(dir, 'design'));
    writeFileSync(join(dir, 'design/stale.md'), 'old\n');
    const lock = sync(saved(), inventory(), dir);
    expect(lock.version).toBe('v1');
    expect(JSON.parse(readFileSync(join(dir, 'design-source.json'), 'utf8'))).toEqual(lock);
    expect(readFileSync(join(dir, 'design/components/bundle.js'), 'utf8')).toBe('/* js */\n');
    expect(checkMirror(dir)).toEqual([]);
  });

  test('refuses a folder that differs from the inventory, before touching design/', () => {
    const folder = saved();
    writeFileSync(join(folder, 'extra.md'), 'x\n');
    const dir = pkg();
    expect(() => sync(folder, inventory(), dir)).toThrow(/extra extra\.md/);
    writeFileSync(join(folder, 'tokens.css'), ':root { --x: 1; }\n');
    expect(() => sync(folder, inventory(), dir)).toThrow(/changed tokens\.css/);
    expect(() => sync(tmp('empty'), inventory(), dir)).toThrow(/missing tokens\.css/);
    expect(() => readFileSync(join(dir, 'design-source.json'))).toThrow();
  });

  test('refuses a symlink in the folder and a path escape in the inventory', () => {
    const folder = saved();
    symlinkSync(join(folder, 'tokens.css'), join(folder, 'link.css'));
    expect(() => sync(folder, inventory(), pkg())).toThrow(/link\.css is not a regular file/);
    const escape = inventory();
    escape.files['../outside.css'] = sha('x');
    expect(() => sync(saved(), escape, pkg())).toThrow(/escapes/);
  });

  test('the mirror check catches edits, extras, missing files and a stale README version', () => {
    const dir = pkg();
    sync(saved(), inventory(), dir);
    writeFileSync(join(dir, 'design/tokens.css'), ':root { --edited: 1; }\n');
    writeFileSync(join(dir, 'design/new.md'), 'x\n');
    expect(checkMirror(dir)).toEqual(['extra new.md', 'changed tokens.css']);
    writeFileSync(join(dir, 'README.md'), 'mirror at version v0\n');
    expect(checkMirror(dir)).toContain('README.md does not name the locked version v1');
  });
});

describe('build-adapter', () => {
  const header =
    '/* @ds-bundle: {"format":4,"namespace":"QaReN","components":[{"name":"Logo"},{"name":"Badge"}]} */\n';

  test('reads component names from the bundle header', () => {
    expect(bundleNames(`${header}(function () {})();\n`)).toEqual(['Logo', 'Badge']);
    expect(() => bundleNames('(function () {})();\n')).toThrow(/@ds-bundle/);
    expect(() => bundleNames('/* @ds-bundle: {"components":[{"name":"x;y"}]} */\n')).toThrow(
      /unexpected/,
    );
  });

  test('wraps the bundle byte for byte and supplies React through a module-scoped window', () => {
    const bundle = `${header}(function () { window.QaReN = { Logo: 1, Badge: 2 }; })();\n`;
    const js = adapterJs(bundle, bundleNames(bundle));
    expect(js).toContain(bundle);
    expect(js).toContain('const window = { React };');
    expect(js).toContain('export const Badge = QaReN.Badge;');
  });
});
