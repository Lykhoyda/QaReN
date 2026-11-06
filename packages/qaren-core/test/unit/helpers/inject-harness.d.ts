export { INJECTED_HELPERS } from '../../../dist/injected-helpers.js';

export function createSandbox(opts?: { fiberRoot?: object }): {
  [key: string]: unknown;
  __QAREN: { [name: string]: unknown };
};

export function buildFiber(spec: object, parent?: object | null): object;
