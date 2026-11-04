// Replaces design/ with a saved copy of the Claude Design artifact's files, after proving the
// copy equals the artifact's own file listing. It never reads the network. Usage:
//   bun scripts/sync-design.ts <saved project/ folder> --inventory <inventory.json>
// inventory.json: { "version": "<artifact version>", "files": { "<path under project/>": "<sha256>" } }
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, listTree, type Lock } from './check-design-mirror';

export const ARTIFACT_URL = 'https://claude.ai/artifact/9wASKvBDC7Lx4ooS66t7YD';
export const ARTIFACT_SLUG = '485916a1-d5ad-44bf-9142-4869eeebc892';

export interface Inventory {
  version: string;
  files: Record<string, string>;
}

/** Verifies folder against inventory, then replaces pkgDir/design and writes the lock. Throws before writing on any difference. */
export function sync(folder: string, inventory: Inventory, pkgDir: string): Lock {
  if (!inventory.version || !inventory.files || !Object.keys(inventory.files).length)
    throw new Error('inventory needs a version and at least one file');
  for (const path of Object.keys(inventory.files)) {
    if (path.startsWith('/') || path.split('/').some((s) => s === '..' || s === '' || s === '.'))
      throw new Error(`inventory path escapes the folder: ${path}`);
  }
  const problems = compare(inventory.files, listTree(folder));
  if (problems.length)
    throw new Error(`saved folder does not match the inventory:\n${problems.join('\n')}`);

  // Stage and re-verify before swapping, so a failed copy never leaves a partial design/.
  const design = join(pkgDir, 'design');
  const staged = `${design}.next`;
  rmSync(staged, { recursive: true, force: true });
  for (const path of Object.keys(inventory.files)) {
    mkdirSync(dirname(join(staged, path)), { recursive: true });
    cpSync(join(folder, path), join(staged, path));
  }
  const copied = compare(inventory.files, listTree(staged));
  if (copied.length) throw new Error(`copy into ${staged} failed:\n${copied.join('\n')}`);
  rmSync(design, { recursive: true, force: true });
  renameSync(staged, design);
  const files = Object.fromEntries(
    Object.entries(inventory.files).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const lock: Lock = { url: ARTIFACT_URL, slug: ARTIFACT_SLUG, version: inventory.version, files };
  writeFileSync(join(pkgDir, 'design-source.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

if (import.meta.main) {
  const [folder, flag, inventoryPath] = process.argv.slice(2);
  if (
    !folder ||
    flag !== '--inventory' ||
    !inventoryPath ||
    [folder, inventoryPath].some((a) => /^[a-z]+:\/\//i.test(a))
  ) {
    console.error(
      'usage: bun scripts/sync-design.ts <saved project/ folder> --inventory <inventory.json>',
    );
    process.exit(2);
  }
  const inventory: Inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const lock = sync(folder, inventory, fileURLToPath(new URL('..', import.meta.url)));
  for (const [path, sha] of Object.entries(lock.files)) console.log(`${sha}  design/${path}`);
  console.log(
    `design/ now mirrors ${lock.url} at version ${lock.version}; update the version in README.md, then commit design/ and design-source.json.`,
  );
}
