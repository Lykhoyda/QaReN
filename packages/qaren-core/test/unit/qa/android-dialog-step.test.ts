// A dialog step on either platform reaches the proven dialog handler; no platform guard refuses it first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';

function screen(): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@alert',
      index: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: 'Allow notifications?',
      rect: { x: 20, y: 100, width: 200, height: 30 },
    },
  ];
  return { ...join(nodes, []), coverage: { native: 'complete', react: 'complete' } };
}

function fake() {
  const handled: string[] = [];
  const driver: string[] = [];
  let clock = 0;
  const deps: WalkerDeps = {
    captureScreen: async () => {
      driver.push('capture');
      return screen();
    },
    press: async () => ({ ok: true, proven: false }),
    fill: async () => ({ ok: true, proven: true }),
    scroll: async () => ({ ok: true, proven: false }),
    back: async () => ({ ok: true, proven: false }),
    dialog: async (action, context) => {
      context.authorize();
      handled.push(action);
      return {
        ok: true,
        proven: true,
        dialog: { label: 'Allow', rect: { x: 1, y: 2, width: 3, height: 4 } },
      };
    },
    screenshot: async (name) => {
      driver.push('screenshot');
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => undefined,
  };
  return { deps, handled, driver };
}

const block = () => parsePlan('1. Dismiss the system dialog\n').blocks![0];

test('a dialog step reaches its handler and passes on the proven tap', async () => {
  const f = fake();
  const outcome = await walkBlock(block(), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(f.handled, ['dismiss']);
});
