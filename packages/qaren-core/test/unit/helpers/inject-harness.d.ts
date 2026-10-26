export { INJECTED_HELPERS } from '../../../dist/injected-helpers.js';

export function createSandbox(opts?: { fiberRoot?: object }): {
  [key: string]: unknown;
  __QAREN: {
    getStoreState(path?: string, requestedType?: string): string;
    dispatchAction(options: { action: string; payload?: unknown; readPath?: string }): string;
  };
};

export function buildFiber(spec: object, parent?: object | null): object;
