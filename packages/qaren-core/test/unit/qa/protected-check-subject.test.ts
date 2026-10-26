import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import type { ReactObservation } from '../../../dist/qa/capture.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { inputValues, isPossibleInput } from '../../../dist/qa/privacy.js';
import type { NativeNode, ReactHostEvidence } from '../../../dist/qa/screen.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { scriptedJudge } from './judgment-fixtures.ts';

const typedEmail = 'qa@example.test';

function emailCapture(
  configure: (nodes: NativeNode[], react: ReactObservation) => void = () => {},
) {
  const native = nativeCapture();
  const observed = native.nodes[1];
  const nodes: NativeNode[] = [
    native.nodes[0],
    { ...observed, type: 'StaticText', identifier: undefined, label: 'Email' },
    {
      ...observed,
      ref: '@email',
      index: 2,
      type: 'TextField',
      identifier: undefined,
      label: 'Email',
      value: typedEmail,
      rect: { x: 10, y: 70, width: 200, height: 40 },
      presence: { ...observed.presence, nodeIndex: 2 },
    },
  ];
  const react: ReactObservation = {
    interactive: [{ role: 'textinput', label: 'Email' }],
    hostEvidence: { complete: true, hosts: [] },
    verdict: { state: 'ok', path: 'interactive', complete: true },
  };
  configure(nodes, react);
  return captureScreen({
    appId: 'com.test',
    native: async () => ({
      ...native,
      nodes,
      snapshotVerdict: { ...native.snapshotVerdict, nodeCount: nodes.length },
    }),
    react: async () => react,
  });
}

const emailCheck = {
  kind: 'check' as const,
  literal: false,
  text: `Email field contains ${typedEmail}`,
  line: 1,
};

test('a visible Email label does not become a second field subject or make native values assertion evidence', async () => {
  const screen = await emailCapture();
  assert.equal(screen.coverage?.native, 'complete');
  assert.equal(screen.elements[1].semantic?.visibility, 'visible');
  assert.equal(screen.elements[2].semantic?.visibility, 'visible');
  assert.equal(screen.elements[1].kind, 'text');
  assert.equal(screen.elements[2].kind, 'input');
  assert.equal(isPossibleInput(screen.elements[1]), true);
  assert.equal(isPossibleInput(screen.elements[2]), true);
  assert.deepEqual(inputValues(screen), [typedEmail]);
  assert.deepEqual(screen.visibleText, ['Email', `Email: ${typedEmail}`]);
  const judge = scriptedJudge(() => assert.fail('native input values cannot prove equality'));
  const decision = await decideScreen(screen, judge, emailCheck, undefined, [typedEmail]);
  assert.equal(decision.check, 'unsure');
  assert.equal(judge.requests.length, 0);
});

test('matching and mismatching native values cannot delegate equality to an optimistic judge', async () => {
  for (const value of [typedEmail, 'different@example.test']) {
    const screen = await emailCapture((nodes) => {
      nodes[2].value = value;
    });
    const judge = scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.99 } }));
    const decision = await decideScreen(screen, judge, emailCheck, undefined, [typedEmail]);
    assert.equal(decision.check, 'unsure');
    assert.equal(judge.requests.length, 0);
    assert.equal(JSON.stringify(judge.requests).includes(value), false);
    assert.equal(JSON.stringify(judge.requests).includes(typedEmail), false);
  }
});

test('real duplicate inputs never pick a winner from equal values or a shared anonymous label', async () => {
  for (const value of [typedEmail, 'different@example.test', undefined]) {
    const screen = await emailCapture((nodes) => {
      nodes.push({
        ...nodes[2],
        ref: '@second-email',
        value,
        index: 3,
        presence: {
          ...nativeCapture().nodes[1].presence,
          nodeIndex: 3,
        },
      });
    });
    const judge = scriptedJudge(() => assert.fail('ambiguous inputs must not be judged'));
    const decision = await decideScreen(screen, judge, emailCheck, undefined, [typedEmail]);
    assert.equal(decision.check, 'unsure');
    assert.equal(judge.requests.length, 0);
    assert.equal(screen.elements.filter((element) => element.kind === 'input').length, 2);
  }
});

test('uncertain input evidence is not discarded just because a proven field has the same value', async () => {
  for (const type of ['Other', 'StaticText']) {
    const screen = await emailCapture((nodes) => {
      nodes[1].type = type;
      nodes[1].value = typedEmail;
    });
    const judge = scriptedJudge(() => assert.fail('uncertain competing subjects must remain'));
    const decision = await decideScreen(screen, judge, emailCheck, undefined, [typedEmail]);
    assert.equal(decision.check, 'unsure', type);
  }
});

test('a weakly associated generic field cannot establish equality from its own value', async () => {
  const screen = await emailCapture((nodes) => {
    nodes[2].type = 'Other';
  });
  assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  const judge = scriptedJudge(() => assert.fail('a weak identity does not prove the subject'));
  assert.equal(
    (await decideScreen(screen, judge, emailCheck, undefined, [typedEmail])).check,
    'unsure',
  );
});

test('secure generic fields retain protected bounds even without input kind or fill capability', async () => {
  for (const type of ['Other', 'TextField']) {
    const screen = await emailCapture((nodes) => {
      nodes[2].type = type;
      nodes[2].secure = true;
    });
    if (type === 'Other') assert.equal(screen.elements[2].semantic?.fill, 'unknown');
    assert.equal(screen.elements[2].value, undefined);
    // A secure node's label may be its value natively, so it is masked too (fail-closed).
    assert.deepEqual(inputValues(screen), [typedEmail, 'Email']);
    const judge = scriptedJudge(() => assert.fail('hidden contents must not be judged'));
    for (const predicate of [
      `contains ${typedEmail}`,
      `equals ${typedEmail}`,
      'is valid',
      'is filled',
      'starts with qa',
      'has 15 characters',
    ]) {
      const decision = await decideScreen(
        screen,
        judge,
        { ...emailCheck, text: `Email field ${predicate}` },
        undefined,
        [typedEmail],
      );
      assert.equal(decision.check, 'unsure', `${type}: ${predicate}`);
    }
  }
});

test('masked ordinary field contents cannot establish hidden format or length properties', async () => {
  const screen = await emailCapture();
  const judge = scriptedJudge(() => assert.fail('opaque values do not disclose their properties'));
  for (const predicate of ['contains a valid email', 'starts with qa', 'has 15 characters']) {
    const decision = await decideScreen(
      screen,
      judge,
      { ...emailCheck, text: `Email field ${predicate}` },
      undefined,
      [typedEmail],
    );
    assert.equal(decision.check, 'unsure', predicate);
  }
});

test('default quoted fill and literal checks use local observations, never generated masks', async () => {
  const screen = await emailCapture();
  const judge = scriptedJudge(() => assert.fail('quoted paths remain model-free'));
  for (const [text, expected] of [
    [typedEmail, 'pass'],
    ['•••', 'fail'],
    ['[QAREN_VALUE_1]', 'fail'],
  ] as const) {
    const decision = await decideScreen(
      screen,
      judge,
      { ...emailCheck, literal: true, text },
      {
        kind: 'fill',
        target: { quoted: 'Email', phrase: 'Email' },
        text: 'replacement',
        line: 2,
      },
    );
    assert.equal(decision.check, expected);
    assert.ok(decision.target && 'ref' in decision.target);
    assert.equal(decision.target.ref, '@email');
  }
});

test('positive fill evidence for a generic subject does not supply missing assertion text', async () => {
  for (const complete of [true, false]) {
    const screen = await emailCapture((nodes, react) => {
      nodes[1] = {
        ...nodes[1],
        type: 'Window',
        label: '',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      };
      nodes[2] = { ...nodes[2], type: 'Other', identifier: 'email', parentIndex: 1, depth: 2 };
      react.interactive = [];
      const hostEvidence: ReactHostEvidence = {
        complete,
        hosts: [{ testID: 'email', role: null, roleSource: 'none', capabilities: { fill: true } }],
        typography: {
          version: 1,
          complete: true,
          durationMs: 10,
          coordinateSpace: 'window-points',
          nodes: [
            {
              hostIndex: 0,
              parentHostIndex: null,
              rootIndex: 0,
              hostType: 'RCTView',
              rect: nodes[2].rect,
              text: { kind: 'none' },
            },
          ],
        },
      };
      react.hostEvidence = hostEvidence;
    });
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].semantic?.fill, complete ? 'supported' : 'unknown');
    assert.deepEqual(screen.visibleText, []);
    const judge = scriptedJudge(() => assert.fail('missing assertion text must not be judged'));
    const decision = await decideScreen(screen, judge, emailCheck, undefined, [typedEmail]);
    if (complete) assert.equal(decision.check, 'unsure');
    else
      assert.deepEqual(decision.check, {
        refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
        reason:
          'semantic projection requires complete native and React coverage (capture native=complete react=complete; projected native=complete react=incomplete)',
      });
    assert.equal(judge.requests.length, 0);
  }
});
