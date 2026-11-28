// Gives this test process its own temp folder and removes it when the process exits, whether its
// tests passed or failed. A process that a signal kills does not get that far.
// Import it first in a test file whose tests, or the code they run, write under os.tmpdir().
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'qaren-node-test-'));
process.env.TMPDIR = root;

// A test may leave a folder it made read-only; removal needs it writable again. Symlinks are
// not followed.
function makeWritable(path: string): void {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}

// Never throws: an exception here would replace the process's exit code.
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    try {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error(`private-tmp: cannot remove ${root}: ${String(error)}`);
    }
  }
});
