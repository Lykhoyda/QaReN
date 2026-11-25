// Shared fixtures for the AI-711 hit-probe reason rows (not a test file).
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';

const full = { x: 0, y: 0, width: 402, height: 874 };
// A title inside a list clipped at 0..782 is followed by a later
// full-width node that cuts the bottom of the visible band from 782 to 116.
export function covered(
  opts: { titles?: number; type?: string; generation?: number | null } = {},
): Screen {
  const { titles = 1, type = 'StaticText' } = opts;
  const nodes: NativeNode[] = [
    { ref: '@e0', index: 0, type: 'Application', rect: full },
    { ref: '@e1', index: 1, parentIndex: 0, type: 'Window', rect: full },
    { ref: '@e2', index: 2, parentIndex: 1, type: 'Other', rect: full },
    {
      ref: '@e3',
      index: 3,
      parentIndex: 2,
      type: 'ScrollView',
      rect: { x: 0, y: 0, width: 402, height: 782 },
    },
    ...Array.from(
      { length: titles },
      (_, i): NativeNode => ({
        ref: `@e${4 + i}`,
        index: 4 + i,
        parentIndex: 3,
        type,
        ...(type === 'StaticText' ? { label: 'Heading' } : { identifier: 'field' }),
        hittable: true,
        rect: { x: 21, y: 151 + 250 * i, width: 360, height: 30 },
      }),
    ),
    {
      ref: '@e9',
      index: 9,
      parentIndex: 2,
      type: 'Other',
      identifier: 'later',
      hittable: true,
      rect: { x: 0, y: 116, width: 402, height: 758 },
    },
  ];
  const screen = join(nodes, []);
  screen.coverage = { native: 'complete', react: 'complete' };
  screen.keyboardVisible = false;
  if (opts.generation !== null) screen.nativeGeneration = opts.generation ?? 7;
  return screen;
}
export function fake(probe?: WalkerDeps['hitProbe'], screen: () => Screen = () => covered()) {
  let clock = 0;
  const calls: string[] = [];
  const deps: WalkerDeps = {
    async captureScreen() {
      calls.push('capture');
      return screen();
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return { ok: true, proven: false };
    },
    async fill(ref) {
      calls.push(`fill ${ref}`);
      return { ok: true, proven: true };
    },
    async scroll() {
      calls.push('scroll');
      return { ok: true, proven: false };
    },
    async back() {
      return { ok: true, proven: false };
    },
    async dialog() {
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => undefined,
    platform: 'ios',
    ...(probe ? { hitProbe: probe } : {}),
  };
  return { deps, calls };
}
const plan = (line = '1. Wait for "Heading"\n') => parsePlan(line).blocks![0];
export const walked = async (f: ReturnType<typeof fake>, line?: string) => {
  const outcome = await walkBlock(plan(line), f.deps);
  return { outcome, checks: outcome.rows.at(-1)?.overlayChecks ?? [] };
};
