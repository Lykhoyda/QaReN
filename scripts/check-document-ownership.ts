import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repositoryRoot = process.env.REPO_ROOT
  ? resolve(process.env.REPO_ROOT)
  : resolve(import.meta.dirname, '..');
const rootDocs = join(repositoryRoot, 'docs');

function collectEntries(directory: string): string[] {
  const entries: Dirent[] = readdirSync(directory, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectEntries(path) : [relative(repositoryRoot, path)];
  });
}

function collectRootDocsEntry(): string[] {
  try {
    const rootStats = lstatSync(rootDocs);
    if (!rootStats.isDirectory()) return ['docs'];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const entries = collectEntries(rootDocs);
  return entries.length > 0 ? entries : ['docs'];
}

const misplacedDocuments = collectRootDocsEntry().sort();

if (misplacedDocuments.length > 0) {
  console.error('Top-level docs/ is not an owned documentation surface:');
  for (const path of misplacedDocuments) console.error(`  ${path}`);
  console.error(
    'Engineering material belongs in the sibling workspace repository docs/ tree, approved architecture records in https://github.com/Lykhoyda/anton-factory/tree/main/architect-docs/, and product documentation in apps/docs-site.',
  );
  process.exitCode = 1;
} else {
  console.log('documentation ownership: ok (no top-level docs tree)');
}
