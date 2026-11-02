// Refreshes tokens and styles from a saved copy of the design source's
// project/ folder on local disk. It never reads the network. Usage:
//   bun scripts/sync-design.ts <path to saved project/ folder>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Everything from this line to the end of components.css is owned by the package and kept by sync. */
export const PACKAGE_OWNED =
  '/* ---------- docs layout (package-owned; sync-design keeps it) ---------- */';

/** bundle.css without the font import: the document head loads the fonts, so the stylesheet makes no network request. */
export function componentsCss(bundleCss: string, currentComponentsCss: string): string {
  const css = bundleCss.replace(
    /^@import url\(['"]?https:\/\/fonts\.googleapis\.com\/[^)]*\);\n+/m,
    '',
  );
  if (/@import/.test(css))
    throw new Error('bundle.css has an @import the sync does not know how to drop');
  const owned = currentComponentsCss.indexOf(PACKAGE_OWNED);
  if (owned < 0) throw new Error('components.css lost its package-owned docs layout section');
  return `${css.trimEnd()}\n\n${currentComponentsCss.slice(owned)}`;
}

/** Copies the synced files from source into pkgDir and returns each file with whether it changed. */
export function sync(source: string, pkgDir: string): { file: string; changed: boolean }[] {
  const read = (path: string) => {
    if (!existsSync(path))
      throw new Error(`missing ${path}; pass the saved design source's project/ folder`);
    return readFileSync(path, 'utf8');
  };
  JSON.parse(read(join(source, 'tokens.json')));
  const next: Record<string, string> = {
    'tokens.css': read(join(source, 'tokens.css')),
    'tokens.json': read(join(source, 'tokens.json')),
    'contrast.md': read(join(source, 'contrast.md')),
    'components.css': componentsCss(
      read(join(source, 'components/bundle.css')),
      read(join(pkgDir, 'components.css')),
    ),
  };
  return Object.entries(next).map(([file, text]) => {
    const target = join(pkgDir, file);
    const changed = !existsSync(target) || readFileSync(target, 'utf8') !== text;
    if (changed) writeFileSync(target, text);
    return { file, changed };
  });
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source || /^[a-z]+:\/\//i.test(source)) {
    console.error(
      'usage: bun scripts/sync-design.ts <local path to the saved design source project/ folder>',
    );
    process.exit(2);
  }
  const results = sync(source, fileURLToPath(new URL('..', import.meta.url)));
  for (const r of results) console.log(`${r.changed ? 'changed  ' : 'unchanged'} ${r.file}`);
  console.log(
    'Components are ported by hand: compare components/bundle.js and index.d.ts with src/, then run `bun run test` and review `git diff`.',
  );
}
