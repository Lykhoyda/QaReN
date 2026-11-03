// Read-only floor check over the mirrored design: recomputes every pair in the table of
// design/contrast.md from design/tokens.json with the WCAG 2 formula. Fails when a pair is below
// its floor in either theme, or when a ratio in the table disagrees with the tokens at the table's
// two-decimal rounding. Both files come from Claude Design, so a failure is fixed there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Theme = 'dark' | 'light';
const THEMES: Theme[] = ['dark', 'light'];
interface ColorToken {
  name: string;
  value: Record<Theme, string>;
}
export interface Tokens {
  color: { tokens: ColorToken[] };
}

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

/** One table row: the pair, its floor (null for a decorative row) and the ratio the table prints per theme. */
export interface Row {
  fg: string;
  bg: string;
  floor: number | null;
  printed: Record<Theme, string>;
}

const ROW =
  /^\| `([\w-]+)` on `([\w-]+)` \| [^|]* \| (none|[\d.]+:1) \| ([\d.]+):1 \([^)]*\) \| ([\d.]+):1 \([^)]*\) \|$/;

/** The pair rows of contrast.md's table. Throws on a table row it cannot read. */
export function parseTable(doc: string): Row[] {
  const rows = doc
    .split('\n')
    .filter((l) => l.startsWith('|') && !l.startsWith('| Pair ') && !l.startsWith('| ---'))
    .map((line) => {
      const m = ROW.exec(line);
      if (!m) throw new Error(`contrast.md row not understood: ${line}`);
      return {
        fg: m[1],
        bg: m[2],
        floor: m[3] === 'none' ? null : Number.parseFloat(m[3]),
        printed: { dark: m[4], light: m[5] },
      };
    });
  if (!rows.length) throw new Error('contrast.md has no pair rows');
  return rows;
}

/** Floor failures and printed ratios that disagree with the tokens, as readable lines. WCAG does not round up to a floor. */
export function check(tokens: Tokens, rows: Row[]): string[] {
  return rows.flatMap((r) =>
    THEMES.flatMap((t) => {
      const value = ratio(resolve(tokens, r.fg, t), resolve(tokens, r.bg, t));
      const pair = `${r.fg} on ${r.bg} (${t})`;
      const out: string[] = [];
      if (value.toFixed(2) !== r.printed[t])
        out.push(`${pair}: contrast.md says ${r.printed[t]}:1, tokens give ${value.toFixed(2)}:1`);
      if (r.floor !== null && value < r.floor)
        out.push(`${pair}: ${value.toFixed(2)}:1 is below ${r.floor}:1`);
      return out;
    }),
  );
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.error('check-contrast takes no arguments; contrast.md is edited in Claude Design');
    process.exit(2);
  }
  const design = fileURLToPath(new URL('../design', import.meta.url));
  const tokens: Tokens = JSON.parse(readFileSync(join(design, 'tokens.json'), 'utf8'));
  const rows = parseTable(readFileSync(join(design, 'contrast.md'), 'utf8'));
  const problems = check(tokens, rows);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`contrast: ${rows.length} pairs checked in dark and light, all floors met`);
}
