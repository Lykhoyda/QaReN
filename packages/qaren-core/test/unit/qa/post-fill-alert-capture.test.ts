import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const viewport = { x: 0, y: 0, width: 400, height: 800 };
const email = 'private-email@example.test';
const code = 'private-code-canary';

function nodes(count: number, modal?: string): NativeNode[] {
  const result: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: viewport },
    { ref: '@window', index: 1, parentIndex: 0, type: 'Window', rect: viewport },
    { ref: '@home', index: 2, parentIndex: 1, type: 'StaticText', label: 'Home' },
    ...(modal
      ? [
          {
            ref: '@alert',
            index: 3,
            parentIndex: 1,
            type: modal,
            label: 'Log out?',
            rect: viewport,
          },
        ]
      : []),
    {
      ref: '@logout',
      index: modal ? 4 : 3,
      parentIndex: modal ? 3 : 1,
      type: 'Button',
      label: 'Log out',
      enabled: true,
      hittable: true,
      rect: { x: 20, y: 300, width: 300, height: 40 },
    },
  ];
  while (result.length < count)
    result.push({
      ref: `@padding-${result.length}`,
      index: result.length,
      parentIndex: 1,
      type: 'Other',
      rect: viewport,
    });
  return result;
}

for (const [count, modal, rewalk] of [
  [120, 'Element(7)', false],
  [120, 'Element(5)', false],
  [63, undefined, true],
  [153, 'Element(7)', false],
  [103, undefined, false],
] as const) {
  test(`post-fill quoted press uses ordinary evidence on a ${count}-node ${modal ?? 'first re-walk'} screen`, async () => {
    let filled = 0;
    let pressed = false;
    let presenceReads = 0;
    let screenshots = 0;
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('quoted targets do not need a model')),
    );
    const fill = f.deps.fill;
    f.deps.fill = async (...args) => {
      filled++;
      return fill(...args);
    };
    const press = f.deps.press;
    f.deps.press = async (...args) => {
      pressed = true;
      await press(...args);
      return { ok: true, proven: false };
    };
    f.deps.screenshot = async () => {
      screenshots++;
      return 'screen.png';
    };
    f.deps.captureScreen = (options) =>
      captureScreen({
        ...options,
        appId: 'com.test',
        requirePrivateInputs: true,
        native: async () => {
          if (filled < 2)
            return attested([
              {
                ref: '@email',
                type: 'TextField',
                label: 'Email',
                identifier: 'email',
                enabled: true,
                hittable: true,
                rect: { x: 20, y: 100, width: 300, height: 40 },
                ...(filled ? { value: email } : {}),
              },
              {
                ref: '@code',
                type: 'TextField',
                label: 'Code',
                identifier: 'code',
                enabled: true,
                hittable: true,
                rect: { x: 20, y: 200, width: 300, height: 40 },
              },
            ]);
          const captured = nodes(count, pressed ? undefined : modal);
          if (pressed) {
            captured.splice(
              captured.findIndex((node) => node.ref === '@logout'),
              1,
            );
            captured.push({ ref: '@after', index: count, parentIndex: 1, type: 'Other' });
          }
          if (options?.platformPresence) {
            presenceReads++;
            const native = nativeCapture();
            return {
              ...attested(captured),
              snapshotGeneration: 7,
              presenceCapture: {
                ...native.presenceCapture,
                complete: false,
                diagnostics: { failure: { phase: 'revalidation', reason: 'enumeration-changed' } },
              },
              snapshotVerdict: {
                state: 'degraded',
                nodeCount: captured.length,
                refMapUpdated: false,
                reasons: ['snapshot-ref-freshness-unknown'],
              },
            };
          }
          return attested(captured);
        },
        react: async () => ({}),
      });
    const plan = parsePlan(
      `1. Type "${email}" into "Email"\n2. Type "${code}" into "Code"\n${rewalk ? '## Re-walk\n' : ''}3. Tap "Log out"`,
    );
    assert.ok(plan.blocks);
    const result = await runPlan(plan.blocks, f.deps);
    assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.equal(presenceReads, 0);
    assert.ok(f.actions.includes('press @logout'));
    const row = result.steps.find((step) => step.line === (rewalk ? 4 : 3));
    assert.equal(row?.unverifiedPress, modal ? true : undefined);
    if (modal) assert.match(row?.reason ?? '', /UNVERIFIED_PRESS: .*alert or sheet/);
    const publicOutput = JSON.stringify({ result, rows: f.rows });
    assert.equal(publicOutput.includes(email), false);
    assert.equal(publicOutput.includes(code), false);
    assert.equal(screenshots, 0);
  });
}
