import { Worker } from 'node:worker_threads';

export type BoundedRegexFilterResult =
  | { ok: true; matches: string[] }
  | { ok: false; reason: 'invalid' | 'timeout' | 'worker'; message: string };

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const matcher = new RegExp(workerData.pattern, 'i');
  parentPort.postMessage({ matches: workerData.candidates.filter((value) => matcher.test(value)) });
} catch (error) {
  parentPort.postMessage({ error: String(error) });
}
`;

export function filterWithBoundedRegex(
  candidates: string[],
  pattern: string,
  timeoutMs = 500,
): Promise<BoundedRegexFilterResult> {
  return new Promise((resolve) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { candidates, pattern },
    });
    let settled = false;
    const finish = (result: BoundedRegexFilterResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          reason: 'timeout',
          message: `pattern evaluation exceeded ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
    worker.on('message', (message: { matches?: unknown; error?: unknown }) => {
      if (typeof message.error === 'string') {
        finish({ ok: false, reason: 'invalid', message: message.error });
        return;
      }
      if (
        !Array.isArray(message.matches) ||
        !message.matches.every((value) => typeof value === 'string')
      ) {
        finish({ ok: false, reason: 'worker', message: 'pattern worker returned invalid output' });
        return;
      }
      finish({ ok: true, matches: message.matches });
    });
    worker.on('error', (error) => {
      finish({ ok: false, reason: 'worker', message: String(error) });
    });
    worker.on('exit', (code) => {
      if (!settled) {
        finish({ ok: false, reason: 'worker', message: `pattern worker exited with code ${code}` });
      }
    });
  });
}
