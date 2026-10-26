#!/usr/bin/env node
// GH#264 integration fixture: a newline-JSON-RPC echo server. Every result
// carries this process's pid so tests can prove which incarnation answered.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'hang') return; // never answers — stays in flight
  if (msg.id === undefined) return; // notifications: no response
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        echo: msg.method,
        pid: process.pid,
        supervised: process.env.RN_BRIDGE_SUPERVISED ?? null,
        restarts: process.env.RN_BRIDGE_RESTARTS ?? null,
      },
    }) + '\n',
  );
});
