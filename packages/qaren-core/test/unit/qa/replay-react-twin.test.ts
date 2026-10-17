import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from '../../../dist/qa/screen.js';
import type { DigestEntry, NativeNode, Screen } from '../../../dist/qa/screen.js';
import { exactIdentities } from '../../../dist/qa/identity.js';
import { prepareTarget, targetEvidence } from '../../../dist/qa/resolve.js';
import type { Step, Target } from '../../../dist/qa/plan.js';

const window: NativeNode = {
  ref: '@win',
  index: 0,
  type: 'Window',
  rect: { x: 0, y: 0, width: 390, height: 844 },
};

function joined(natives: Array<{ id: string; type?: string; y: number }>, digest: DigestEntry[]) {
  const nodes = natives.map(({ id, type = 'Button', y }, i) => ({
    ref: `@n${i + 1}`,
    index: i + 1,
    parentIndex: 0,
    type,
    identifier: id,
    label: id,
    hittable: true,
    rect: { x: 20, y, width: 300, height: 44 },
  }));
  return join([window, ...nodes], digest, 'app', { native: 'complete', react: 'complete' });
}

const button = (testID: string): DigestEntry => ({
  role: 'button',
  testID,
  capabilities: { press: true, fill: false },
});
const input = (testID: string): DigestEntry => ({
  role: 'textinput',
  testID,
  capabilities: { press: false, fill: true },
});
const exactId = (quoted: string): Target => ({ quoted, phrase: quoted, exact: 'id' });
const press = (target: Target): Step => ({ kind: 'press', target });
const outcome = (resolved: ReturnType<typeof prepareTarget>) =>
  'refuse' in resolved ? resolved.refuse : 'ref' in resolved ? resolved.ref : 'scroll';
const tags = (screen: Screen, target: Target, kind: Step['kind']) =>
  exactIdentities(screen, target, kind).map(({ tag }) => tag);

const twin = joined([{ id: 'close', y: 100 }], [button('close'), button('close')]);

test('a stored id resolves to its native element beside a React-only twin', () => {
  assert.deepEqual(tags(twin, exactId('close'), 'press'), ['native', 'react-only']);
  assert.equal(outcome(prepareTarget(press(exactId('close')), twin)), '@n1');
});

test('a stored id wait passes on the visible native element beside a React-only twin', () => {
  assert.equal(targetEvidence(exactId('close'), twin), 'pass');
});

test('two native elements sharing a stored id stay ambiguous', () => {
  const screen = joined(
    [
      { id: 'close', y: 100 },
      { id: 'close', y: 300 },
    ],
    [button('close'), button('close')],
  );
  assert.equal(outcome(prepareTarget(press(exactId('close')), screen)), 'TARGET_AMBIGUOUS');
  assert.throws(() => targetEvidence(exactId('close'), screen), /TARGET_AMBIGUOUS/);
});

test('a stored id with only a React-only match keeps its scroll and fails a wait', () => {
  const screen = joined([], [button('close')]);
  assert.deepEqual(tags(screen, exactId('close'), 'press'), ['react-only']);
  assert.equal(outcome(prepareTarget(press(exactId('close')), screen)), 'scroll');
  assert.equal(targetEvidence(exactId('close'), screen), 'fail');
});

test('a phrase naming the id keeps the React-only twin ambiguous', () => {
  const phrase = { quoted: 'close', phrase: 'close' };
  assert.equal(outcome(prepareTarget(press(phrase), twin)), 'TARGET_AMBIGUOUS');
});

test('a stored-id fill keeps counting a React-only input twin', () => {
  const screen = joined(
    [{ id: 'notes', type: 'TextField', y: 100 }],
    [input('notes'), input('notes')],
  );
  assert.deepEqual(tags(screen, exactId('notes'), 'fill'), ['native', 'react-only']);
  const fill: Step = { kind: 'fill', target: exactId('notes'), text: 'x' };
  assert.equal(outcome(prepareTarget(fill, screen)), 'TARGET_AMBIGUOUS');
});
