// GH #383 acceptance criterion: no file under /tmp is read or written by
// either runner client. Grep-enforced static invariant (gh-374 pattern, per
// D1288) — the runtime never exercises every path, the source scan does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const CLIENTS = [
  join(SRC, 'runners', 'rn-fast-runner-client.ts'),
  join(SRC, 'runners', 'rn-android-runner-client.ts'),
];

test('gh-383: runner clients contain no /tmp path literal', () => {
  for (const file of CLIENTS) {
    const src = readFileSync(file, 'utf8');
    assert.ok(
      !/['"`]\/tmp\//.test(src),
      `${file} must not reference /tmp — use util/secure-state-file.ts (state) or os.tmpdir() (scratch)`,
    );
  }
});
