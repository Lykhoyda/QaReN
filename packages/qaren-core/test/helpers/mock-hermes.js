import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * Minimal Hermes stand-in used by multiplexer and CDPClient proxy tests.
 * Accepts a single WS, echoes request ids back as responses, can emit events
 * on demand, and tracks the raw messages it received for assertion.
 *
 * Returns:
 *   { port, url, received, emit(event), stop() }
 */
export function makeMockHermes() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let activeWs = null;
  const received = [];

  wss.on('connection', (ws) => {
    if (activeWs) {
      // Real Hermes would evict the older connection; for tests we just reject.
      ws.close(4000, 'only-one-allowed');
      return;
    }
    activeWs = ws;
    ws.on('message', (data) => {
      const raw = data.toString();
      received.push(raw);
      const parsed = JSON.parse(raw);
      if (typeof parsed.id === 'number') {
        ws.send(
          JSON.stringify({
            id: parsed.id,
            result: { echo: parsed.method, params: parsed.params ?? null },
          }),
        );
      }
    });
    ws.on('close', () => {
      activeWs = null;
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `ws://127.0.0.1:${port}`,
        received,
        emit: (event) => {
          if (activeWs) activeWs.send(JSON.stringify(event));
        },
        stop: () =>
          new Promise((r) => {
            wss.close(() => server.close(() => r()));
          }),
      });
    });
  });
}
