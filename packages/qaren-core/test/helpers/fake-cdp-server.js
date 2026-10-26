import http from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * Start a fake CDP server that speaks the Chrome DevTools Protocol.
 *
 * @param {number} [preferredPort=0] - Port to listen on. 0 = OS-assigned random port.
 * @returns {Promise<{
 *   port: number,
 *   setResponse: (method: string, factory: (params: unknown) => unknown) => void,
 *   removeResponse: (method: string) => void,
 *   emitEvent: (method: string, params: unknown) => void,
 *   disconnectAll: () => void,
 *   close: () => Promise<void>,
 * }>}
 */
// A response factory may return a Promise (a delayed reply) or NO_REPLY (the request is never answered).
export const NO_REPLY = Symbol('no-reply');

export async function startFakeCDP(preferredPort = 0, options = {}) {
  /** @type {Map<string, (params: unknown) => unknown>} */
  const responses = new Map();

  /** @type {Set<import('ws').WebSocket>} */
  const clients = new Set();

  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('packager-status:running');
      return;
    }

    if (req.url === '/json/list') {
      const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
      const webSocketDebuggerUrl = `ws://127.0.0.1:${port}/debugger/page1`;
      const targets = options.targets
        ? options.targets.map((target) => ({ ...target, webSocketDebuggerUrl }))
        : [
            {
              id: 'page1',
              title: 'React Native (Hermes)',
              vm: 'Hermes',
              webSocketDebuggerUrl,
              description: 'com.testapp',
            },
          ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server, path: '/debugger/page1' });

  wss.on('connection', (ws) => {
    clients.add(ws);

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const { id, method, params } = msg;

      let result;
      if (responses.has(method)) {
        result = responses.get(method)(params);
      } else if (method === 'Runtime.evaluate') {
        result = { result: { type: 'boolean', value: true } };
      } else {
        result = {};
      }

      Promise.resolve(result).then((value) => {
        if (value !== NO_REPLY && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ id, result: value }));
        }
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(preferredPort, '127.0.0.1', () => resolve(undefined));
    server.once('error', reject);
  });

  const { port } = /** @type {import('net').AddressInfo} */ (server.address());

  function setResponse(method, factory) {
    responses.set(method, factory);
  }

  function removeResponse(method) {
    responses.delete(method);
  }

  function emitEvent(method, params) {
    const payload = JSON.stringify({ method, params });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  function disconnectAll() {
    for (const ws of clients) {
      ws.terminate();
    }
    clients.clear();
  }

  async function close() {
    disconnectAll();
    await new Promise((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve(undefined)));
    });
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }

  return { port, setResponse, removeResponse, emitEvent, disconnectAll, close };
}
