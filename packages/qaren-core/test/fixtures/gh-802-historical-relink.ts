import { lstatSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const [primary, linked] = process.argv.slice(2);
if (!primary || !linked) process.exit(2);

const root = join(linked, '.qaren');
const backup = `${root}.bak`;
if (lstatSync(root).isSymbolicLink()) process.exit(3);

renameSync(root, backup);
symlinkSync(join(primary, '.qaren'), root, 'dir');
