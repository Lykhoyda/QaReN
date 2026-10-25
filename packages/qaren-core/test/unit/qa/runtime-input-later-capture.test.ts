import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlatNode } from '../../../dist/fast-runner-ref-map.js';
import { hashSnapshotNodes } from '../../../dist/lifecycle/settle-hash.js';
import { serializeBlock } from '../../../dist/qa/blocks.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { requiredInputs } from '../../../dist/qa/input-preflight.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { MASK, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { attested } from './platform-presence-fixtures.ts';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

test('configured login inputs on a later account screen are masked without replaying login', async () => {
  const email = 'person742@example.test';
  const plan = '1. Tap "Account"\n2. Wait for "Account details"';
  const login = parsePlan('# Sign in\n1. Fill "email" with input EMAIL').blocks![0];
  const saved = serializeBlock(
    login,
    [{ block: login.slug, line: 2, outcome: 'pass', selector: { id: 'email' } }],
    { appId: 'com.test', platform: 'ios' },
  );
  assert.ok('yaml' in saved);
  const privacy = new ObservedPrivacy();
  const inputs = new RunInputs(
    { EMAIL: email },
    requiredInputs(plan, { slug: login.slug, content: saved.yaml }),
    privacy,
  );
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal targets need no model')),
  );
  let account = false;
  let accountCaptures = 0;
  let screenshots = 0;
  const nodes = (): FlatNode[] => [
    {
      ref: '@e0',
      index: 0,
      type: account ? 'StaticText' : 'Button',
      identifier: account ? 'account-title' : 'account',
      label: account ? 'Account details' : 'Account',
      enabled: true,
      hittable: true,
      rect: { x: 20, y: 100, width: 300, height: 40 },
    },
    ...(account
      ? [
          {
            ref: '@e1',
            index: 1,
            type: 'StaticText',
            identifier: 'account-email',
            label: `Signed in as ${email}`,
            rect: { x: 20, y: 200, width: 300, height: 40 },
          },
        ]
      : []),
  ];
  f.deps.privacy = privacy;
  f.deps.login = { marker: { id: 'sign-in' }, block: login };
  f.deps.fill = async () => assert.fail('the signed-in session must not replay login');
  f.deps.press = async () => {
    account = true;
    return { ok: true, proven: true };
  };
  f.deps.screenshot = async () => {
    screenshots++;
    return 'screen.png';
  };
  f.deps.captureScreen = (options) =>
    captureScreen({
      ...options,
      requirePrivateInputs: true,
      native: async () => {
        const captured = nodes();
        hashSnapshotNodes(captured);
        if (account) accountCaptures++;
        return attested(captured);
      },
      react: async () => ({}),
    });
  const result = await withInputs(inputs, () => runPlan(parsePlan(plan).blocks!, f.deps));
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.ok(accountCaptures > 0);
  assert.equal(inputs.terminal, undefined);
  assert.equal(screenshots, 0);
  assert.equal(privacy.canScreenshot(), false);
  const publicOutput = JSON.stringify({ result, rows: f.rows });
  assert.equal(publicOutput.includes(email), false);
  assert.equal(privacy.redact(`Signed in as ${email}`), `Signed in as ${MASK}`);
});
