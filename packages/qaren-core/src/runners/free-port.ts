import { createServer } from 'node:net';
import { interruptible, throwIfCancelled } from '../domain/cancellation.js';

export function isPortFree(port: number): Promise<boolean> {
  return interruptible(
    () =>
      new Promise((resolve) => {
        const srv = createServer();
        srv.once('error', () => resolve(false));
        srv.listen({ port, host: '127.0.0.1' }, () => srv.close(() => resolve(true)));
      }),
  );
}

/**
 * Resolve a bindable TCP port on 127.0.0.1: `preferred` if free, else an
 * OS-assigned ephemeral free port. Rejects on unexpected bind errors or if the
 * OS hands back an unusable port 0. Note: there is an inherent TOCTOU window
 * between this probe and the caller's real bind — callers that bind a SPECIFIC
 * number (e.g. adb forward) must handle a late EADDRINUSE; the iOS runner avoids
 * the window entirely by self-assigning (port 0).
 */
export function findFreePort(preferred: number): Promise<number> {
  return interruptible(
    (signal) =>
      new Promise((resolve, reject) => {
        const tryListen = (port: number, fallbackToAny: boolean): void => {
          try {
            throwIfCancelled(signal);
            const srv = createServer();
            srv.once('error', (err: NodeJS.ErrnoException) => {
              if (fallbackToAny && err.code === 'EADDRINUSE') tryListen(0, false);
              else reject(err);
            });
            srv.listen({ port, host: '127.0.0.1' }, () => {
              const addr = srv.address();
              const chosen = typeof addr === 'object' && addr ? addr.port : 0;
              if (!chosen) {
                srv.close(() => reject(new Error('findFreePort: OS returned port 0')));
                return;
              }
              srv.close(() => resolve(chosen));
            });
          } catch (error) {
            reject(error);
          }
        };
        tryListen(preferred, true);
      }),
  );
}
