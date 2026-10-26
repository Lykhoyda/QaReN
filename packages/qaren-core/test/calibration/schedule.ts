import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePlan } from '../../dist/qa/plan.js';

export const planPath = fileURLToPath(new URL('./plan.md', import.meta.url));
export const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export const policy = Object.freeze({
  nativeMs: 18_000,
  acquisitionMs: 20_000,
  useMs: 8_000,
  oldestMs: 32_000,
});
export const target = Object.freeze({
  device: '2E24DCF0-C991-4EB0-80CC-CCFEB9042A73',
  appId: 'com.rndevagent.testapp',
});

export function schedule() {
  const plan = readFileSync(planPath, 'utf8');
  const parsed = parsePlan(plan);
  if (!parsed.blocks || parsed.blocks.length !== 3) throw new Error('CALIBRATION_PLAN_INVALID');
  const items = parsed.blocks.flatMap((block) => block.items);
  const step = (number: number) => {
    const item = items.find((item) => item.raw.startsWith(`${number}. `));
    if (!item) throw new Error('CALIBRATION_PLAN_INVALID');
    return item.line;
  };
  return {
    planHash: hash(plan),
    lines: items.map((item) => item.line),
    items: items.map((item) => ({ line: item.line, kind: item.kind })),
    acquisitions: [
      { screen: 'onboarding', lines: [1, 2, 3, 4, 5].map(step) },
      { screen: 'home', lines: [8, 9, 10, 11, 12].map(step) },
      { screen: 'tasks', lines: [14, 15, 16, 17, 18].map(step) },
    ],
    cycles: [
      { line: step(6), kind: 'press', model: true },
      { line: step(7), kind: 'press', model: true },
      { line: step(13), kind: 'cached-press', model: true },
      { line: step(19), kind: 'press', model: true },
      { line: step(20), kind: 'scroll', model: false },
      { line: step(22), kind: 'fill', model: false },
    ],
    cachedCheck: items.find((item) => item.kind === 'check' && !item.literal)!.line,
  };
}
