import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { captureScreen, type NativeObservation } from '../../../dist/qa/capture.js';
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

for (const [count, modal, rewalk, firstReadMs, generation] of [
  [120, 'Element(7)', false, undefined, 7],
  [120, 'Element(5)', false, undefined, 7],
  [63, undefined, true, undefined, 7],
  [153, 'Element(7)', false, 7_808, 41],
  [103, undefined, false, 6_399, 19],
] as const) {
  test(`post-fill quoted press ${firstReadMs ? 'retains deadline causes' : 'settles'} on a ${count}-node ${modal ?? 'app'} screen`, async (t) => {
    let now = 0;
    if (firstReadMs) {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.timers.reset();
        syncBuiltinESMExports();
      });
    }
    let filled = 0;
    let pressed = false;
    let presenceReads = 0;
    let screenshots = 0;
    let postPressReads = 0;
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
        ...(firstReadMs ? { now: () => now } : {}),
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
          const postPressIncomplete = pressed && firstReadMs;
          if (postPressIncomplete) {
            if (++postPressReads > 1) return new Promise<NativeObservation>(() => {});
            now += firstReadMs;
          }
          if (
            postPressIncomplete ||
            (options?.platformPresence && !pressed && ++presenceReads <= 2)
          ) {
            const native = nativeCapture();
            return {
              ...attested(captured),
              snapshotGeneration: generation,
              presenceCapture: {
                ...native.presenceCapture,
                generation,
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
    const pending = runPlan(plan.blocks, f.deps);
    if (firstReadMs) {
      await nextTurn();
      for (const duration of [500, 500, 500, 5_500]) {
        now += duration;
        t.mock.timers.tick(duration);
        await nextTurn();
      }
    }
    const result = await pending;
    assert.equal(result.verdict, firstReadMs ? 'REFUSED' : 'PASS', JSON.stringify(result));
    assert.equal(presenceReads, 3);
    assert.ok(f.actions.includes('press @logout'));
    const row = result.steps.find((step) => step.line === (rewalk ? 4 : 3));
    if (firstReadMs) {
      assert.equal('code' in result && result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
      assert.match(JSON.stringify(result), /keyboard-state-unknown/);
      assert.match(JSON.stringify(result), /presence-failure=revalidation:enumeration-changed/);
      assert.match(JSON.stringify(result), /retry-deadline/);
      assert.match(JSON.stringify(result), new RegExp(`nodes=${count};`));
      assert.equal(postPressReads, 2);
    } else {
      assert.equal(row?.unverifiedPress, modal ? true : undefined);
      if (modal) assert.match(row?.reason ?? '', /UNVERIFIED_PRESS: .*alert or sheet/);
    }
    const publicOutput = JSON.stringify({ result, rows: f.rows });
    assert.equal(publicOutput.includes(email), false);
    assert.equal(publicOutput.includes(code), false);
    assert.equal(screenshots, 0);
  });
}
