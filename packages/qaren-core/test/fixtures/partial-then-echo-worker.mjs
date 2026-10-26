#!/usr/bin/env node
// GH#264 integration fixture (PR #273 Codex P2): the FIRST incarnation writes
// a partial JSON-RPC frame (no trailing newline) and dies — leaving stale
// bytes in any splitter that survives the worker. Later incarnations behave
// like fake-worker (echo), so the test can prove the fresh worker's frames
// are not prefixed by the dead worker's tail.
import { createInterface } from 'node:readline';

if (process.env.RN_BRIDGE_RESTARTS === '0') {
  process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"partial":tru');
  setTimeout(() => process.exit(1), 150);
} else {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined) return;
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          echo: msg.method,
          pid: process.pid,
          restarts: process.env.RN_BRIDGE_RESTARTS ?? null,
        },
      }) + '\n',
    );
  });
}
