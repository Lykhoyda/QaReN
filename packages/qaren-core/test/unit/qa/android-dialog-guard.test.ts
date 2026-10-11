// Android system dialogs are refused before any driver runs; iOS keeps its proven dialog handler.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { platformDialog, walkBlock } from '../../../dist/qa/walker.js';
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

function fake(platform: 'ios' | 'android') {
  const handled: string[] = [];
  let clock = 0;
  const deps: WalkerDeps = {
    captureScreen: async () => screen(),
    press: async () => ({ ok: true, proven: false }),
    fill: async () => ({ ok: true, proven: true }),
    scroll: async () => ({ ok: true, proven: false }),
    back: async () => ({ ok: true, proven: false }),
    dialog: platformDialog(platform, async (action, context) => {
      context.authorize();
      handled.push(action);
      return {
        ok: true,
        proven: true,
        dialog: { label: 'Allow', rect: { x: 1, y: 2, width: 3, height: 4 } },
      };
    }),
    screenshot: async (name) => name,
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => undefined,
  };
  return { deps, handled };
}

const block = () => parsePlan('1. Dismiss the system dialog\n').blocks![0];

test('android_dialog_step_refuses_before_any_driver', async () => {
  const f = fake('android');
  const outcome = await walkBlock(block(), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    outcome.failure?.seen ?? '',
    /^TARGET_UNSUPPORTED: Android system dialogs arrive in S5b/,
  );
  assert.deepEqual(f.handled, []);
});

test('an iOS dialog step still reaches its handler', async () => {
  const f = fake('ios');
  const outcome = await walkBlock(block(), f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.deepEqual(f.handled, ['dismiss']);
});
