import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const request: { appRoot: string; slug: string; text: string; pause: boolean } = JSON.parse(
  process.argv[2],
);
if (request.pause) {
  const rename = fs.renameSync;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  fs.renameSync = (from, to) => {
    process.send?.({ kind: 'publishing' });
    while (!fs.existsSync(join(request.appRoot, 'release'))) Atomics.wait(wait, 0, 0, 10);
    return rename(from, to);
  };
  syncBuiltinESMExports();
}

const { writeBlock } = await import('../../../dist/qa/blocks.js');
process.send?.({ kind: 'ready' });
try {
  process.send?.({
    kind: 'result',
    value: writeBlock(request.appRoot, request.slug, request.text),
  });
} catch (error) {
  process.send?.({ kind: 'result', value: error instanceof Error ? error.message : String(error) });
}
process.disconnect();
