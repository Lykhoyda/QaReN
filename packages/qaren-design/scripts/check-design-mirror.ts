// Fails when design/ no longer equals the lock in design-source.json: a changed, missing or
// extra file, a symlink, or a package README that does not name the locked version.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Lock {
  url: string;
  slug: string;
  version: string;
  files: Record<string, string>;
}

/** Every regular file under dir as path (with /) -> sha256. Throws on a symlink or any other non-file. */
export function listTree(dir: string, prefix = ''): Record<string, string> {
  if (!prefix && !lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  const out: Record<string, string> = Object.create(null);
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(dir, rel));
    if (stat.isDirectory()) Object.assign(out, listTree(dir, rel));
    else if (stat.isFile())
      out[rel] = createHash('sha256')
        .update(readFileSync(join(dir, rel)))
        .digest('hex');
    else throw new Error(`${rel} is not a regular file`);
  }
  return out;
}

/** Differences between the expected and actual path -> sha256 maps, as readable lines. */
export function compare(
  expected: Record<string, string>,
  actual: Record<string, string>,
): string[] {
  const paths = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return paths.flatMap((p) => {
    if (!Object.hasOwn(actual, p)) return [`missing ${p}`];
    if (!Object.hasOwn(expected, p)) return [`extra ${p}`];
    return expected[p] === actual[p] ? [] : [`changed ${p}`];
  });
}

export function checkMirror(pkgDir: string): string[] {
  const lock: Lock = JSON.parse(readFileSync(join(pkgDir, 'design-source.json'), 'utf8'));
  let problems: string[];
  try {
    problems = compare(lock.files, listTree(join(pkgDir, 'design')));
  } catch (error) {
    problems = [(error as Error).message];
  }
  if (!readFileSync(join(pkgDir, 'README.md'), 'utf8').includes(lock.version))
    problems.push(`README.md does not name the locked version ${lock.version}`);
  return problems;
}

if (import.meta.main) {
  const problems = checkMirror(fileURLToPath(new URL('..', import.meta.url)));
  if (problems.length) {
    console.error(
      `design/ does not match design-source.json; edit in Claude Design and re-sync:\n${problems.join('\n')}`,
    );
    process.exit(1);
  }
  console.log('design mirror: every file matches design-source.json');
}
