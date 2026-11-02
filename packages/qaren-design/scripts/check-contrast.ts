// Recomputes the contrast table in contrast.md from tokens.json with the WCAG 2 formula.
// Fails when a pair is below its floor in either theme, or when contrast.md no longer
// matches the tokens. `--write` rewrites the table in contrast.md.
import { readFileSync, writeFileSync } from 'node:fs';

type Theme = 'dark' | 'light';
interface ColorToken {
  name: string;
  value: Record<Theme, string>;
}
export interface Tokens {
  color: { tokens: ColorToken[] };
}
interface Pair {
  fg: string;
  bg: string;
  where: string;
  floor: number | null;
}

const THEMES: Theme[] = ['dark', 'light'];

// [foreground, background, where it appears, floor]; a null floor is a decorative row, reported only.
export const PAIRS: Pair[] = (
  [
    ['text', 'bg', 'Body and headings on the page', 4.5],
    ['text', 'surface', 'Body in cards, code, terminal', 4.5],
    ['text', 'surface-2', 'Inline code, table headers', 4.5],
    ['muted', 'bg', 'Captions, footer', 4.5],
    ['muted', 'surface', 'Metadata in cards, code comments', 4.5],
    ['muted', 'surface-2', 'Table header labels', 4.5],
    ['accent-text', 'bg', 'Running step label, link hover', 4.5],
    ['accent-text', 'surface', 'Running step label in a pane', 4.5],
    ['on-accent', 'accent', 'Primary button label', 4.5],
    ['pass', 'bg', 'The word PASS on the page', 4.5],
    ['pass', 'surface', 'The word PASS in a pane', 4.5],
    ['pass', 'pass-tint', 'PASS in a passed row or PR header', 4.5],
    ['on-pass', 'pass', 'PASS pill', 4.5],
    ['fail', 'bg', 'The word FAIL on the page', 4.5],
    ['fail', 'surface', 'The word FAIL in a pane', 4.5],
    ['fail', 'fail-tint', 'FAIL in a failed row, danger callout title', 4.5],
    ['on-fail', 'fail', 'FAIL pill', 4.5],
    ['text', 'pass-tint', 'Body on a passed row', 4.5],
    ['text', 'fail-tint', 'Body on a failed row or danger callout', 4.5],
    ['muted', 'pass-tint', 'Metadata on a passed row', 4.5],
    ['muted', 'fail-tint', 'Metadata on a failed row', 4.5],
    ['focus', 'bg', 'Focus ring on the page', 3],
    ['focus', 'surface', 'Focus ring in a card', 3],
    ['border-strong', 'bg', 'Secondary button outline', 3],
    ['border-strong', 'surface', 'Control outline in a card', 3],
    ['pass', 'surface', 'Passed step mark', 3],
    ['fail', 'surface', 'Failed step mark', 3],
    ['accent', 'bg', 'Cursor block, primary button fill edge', null],
    ['border', 'bg', 'Hairline divider', null],
    ['pass', 'fail', 'PASS against FAIL (hue alone)', null],
  ] as const
).map(([fg, bg, where, floor]) => ({ fg, bg, where, floor }));

/** A colour token's hex for a theme, following "{other}" references. */
export function resolve(tokens: Tokens, name: string, theme: Theme, seen: string[] = []): string {
  if (seen.includes(name))
    throw new Error(`token reference cycle: ${[...seen, name].join(' -> ')}`);
  const token = tokens.color.tokens.find((t) => t.name === name);
  if (!token) throw new Error(`unknown colour token: ${name}`);
  const value = token.value[theme];
  const ref = /^\{(.+)\}$/.exec(value);
  if (ref) return resolve(tokens, ref[1], theme, [...seen, name]);
  if (!/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(`${name} (${theme}) is not a #rrggbb colour: ${value}`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface Row extends Pair {
  ratios: Record<Theme, number>;
}

export function measure(tokens: Tokens): Row[] {
  return PAIRS.map((p) => ({
    ...p,
    ratios: {
      dark: ratio(resolve(tokens, p.fg, 'dark'), resolve(tokens, p.bg, 'dark')),
      light: ratio(resolve(tokens, p.fg, 'light'), resolve(tokens, p.bg, 'light')),
    },
  }));
}

/** Rows below their floor, as readable lines. Compares the rounded value the table shows. */
export function failures(rows: Row[]): string[] {
  return rows.flatMap((r) =>
    THEMES.filter((t) => r.floor !== null && Number(r.ratios[t].toFixed(2)) < r.floor).map(
      (t) => `${r.fg} on ${r.bg} (${t}): ${r.ratios[t].toFixed(2)}:1 is below ${r.floor}:1`,
    ),
  );
}

export function renderTable(rows: Row[]): string {
  const cell = (r: Row, t: Theme) => {
    const v = `${r.ratios[t].toFixed(2)}:1`;
    if (r.floor === null) return `${v} (n/a)`;
    return `${v} (${Number(r.ratios[t].toFixed(2)) >= r.floor ? 'pass' : 'fail'})`;
  };
  return [
    '| Pair | Where it appears | Floor | Dark | Light (docs) |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| \`${r.fg}\` on \`${r.bg}\` | ${r.where} | ${r.floor === null ? 'none' : `${r.floor}:1`} | ${cell(r, 'dark')} | ${cell(r, 'light')} |`,
    ),
  ].join('\n');
}

/** Replaces the first Markdown table in doc with table. */
export function replaceTable(doc: string, table: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.startsWith('|'));
  if (start < 0) throw new Error('contrast.md has no table');
  let end = start;
  while (end < lines.length && lines[end].startsWith('|')) end++;
  return [...lines.slice(0, start), table, ...lines.slice(end)].join('\n');
}

if (import.meta.main) {
  const dir = new URL('..', import.meta.url);
  const tokens: Tokens = JSON.parse(readFileSync(new URL('tokens.json', dir), 'utf8'));
  const docUrl = new URL('contrast.md', dir);
  const doc = readFileSync(docUrl, 'utf8');
  const rows = measure(tokens);
  const expected = replaceTable(doc, renderTable(rows));
  const problems = failures(rows);
  if (process.argv.includes('--write')) {
    writeFileSync(docUrl, expected);
    console.log('contrast.md table rewritten from tokens.json');
  } else if (expected !== doc) {
    problems.push(
      'contrast.md does not match tokens.json; run `bun run check-contrast --write` and review the diff',
    );
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`contrast: ${rows.length} pairs checked in dark and light, all floors met`);
}
