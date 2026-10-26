// GH #750 defect 3 (B223-class): maestro-runner 1.1.20 translates Maestro
// regex text selectors into literal WDA `label CONTAINS[c]` predicates that
// can never match. A drifted runner must refuse replay of regex-selector
// flows with a typed error naming the drift — including selectors nested under
// runFlow.commands, which the reported reproduction used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildReplayEngineStatus,
  driftedRegexSelectorRefusal,
  findRegexTextSelectors,
} from '../../dist/domain/engine-pin.js';

test('gh-750: finds regex-shaped text selectors at the top level', () => {
  const commands = [
    { launchApp: { appId: 'com.example.app', clearState: true } },
    { tapOn: '.*Getsafe.*http://.*' },
    { assertVisible: 'Home' },
  ];
  assert.deepEqual(findRegexTextSelectors(commands), ['.*Getsafe.*http://.*']);
});

test('gh-750: finds regex selectors nested under runFlow.commands', () => {
  const commands = [
    {
      runFlow: {
        when: { visible: 'DEVELOPMENT SERVERS' },
        commands: [{ tapOn: '.*Getsafe.*http://.*' }],
      },
    },
  ];
  assert.deepEqual(findRegexTextSelectors(commands), ['.*Getsafe.*http://.*']);
});

test('gh-750: finds regex selectors in object form and class/alternation shapes', () => {
  const commands = [
    { tapOn: { text: 'OTP \\d{6}' } },
    { assertVisible: { text: '(Continue|Weiter)' } },
    { tapOn: '[A-Z]ubmit' },
  ];
  assert.deepEqual(findRegexTextSelectors(commands), [
    'OTP \\d{6}',
    '(Continue|Weiter)',
    '[A-Z]ubmit',
  ]);
});

test('gh-750: plain literals and id selectors are not flagged', () => {
  const commands = [
    { tapOn: 'Continue' },
    { tapOn: { id: 'submit-button' } },
    { inputText: 'user.*name' },
  ];
  assert.deepEqual(findRegexTextSelectors(commands), []);
});

test('gh-750: complete regex syntax includes wildcard and grouping forms', () => {
  assert.deepEqual(findRegexTextSelectors([{ tapOn: 'Log.n' }]), ['Log.n']);
  assert.deepEqual(findRegexTextSelectors([{ tapOn: '^Login$' }]), ['^Login$']);
  assert.deepEqual(findRegexTextSelectors([{ assertVisible: '3.5 stars (12 ratings)' }]), [
    '3.5 stars (12 ratings)',
  ]);
});

test('gh-750: drifted runner refuses regex-selector flows with a typed message', () => {
  const drifted = buildReplayEngineStatus('drift-newer', '1.1.20', false);
  const refusal = driftedRegexSelectorRefusal(drifted, [{ tapOn: '.*Getsafe.*http://.*' }]);
  assert.ok(refusal);
  assert.match(refusal, /1\.1\.20/);
  assert.match(refusal, /1\.1\.28/);
  assert.match(refusal, /CONTAINS/);
  assert.match(refusal, /\.\*Getsafe\.\*/);
});

test('gh-812: drifted runner refuses regex text in scrollUntilVisible.element', () => {
  const drifted = buildReplayEngineStatus('drift-newer', '1.1.29', false);
  const refusal = driftedRegexSelectorRefusal(drifted, [
    { scrollUntilVisible: { element: 'Log.n', direction: 'DOWN' } },
  ]);

  assert.ok(refusal);
  assert.match(refusal, /1\.1\.29/);
  assert.match(refusal, /1\.1\.28/);
  assert.match(refusal, /CONTAINS/);
  assert.match(refusal, /Log\.n/);
});

test('gh-812: drifted runner refuses regex text in copyTextFrom', () => {
  const drifted = buildReplayEngineStatus('drift-newer', '1.1.29', false);
  const refusal = driftedRegexSelectorRefusal(drifted, [{ copyTextFrom: 'Order.*' }]);

  assert.ok(refusal);
  assert.match(refusal, /1\.1\.29/);
  assert.match(refusal, /1\.1\.28/);
  assert.match(refusal, /CONTAINS/);
  assert.match(refusal, /Order\.\*/);
});

test('gh-750: pinned runner and literal-only flows replay without refusal', () => {
  const pinned = buildReplayEngineStatus('pinned-ok', '1.1.28', false);
  const drifted = buildReplayEngineStatus('drift-newer', '1.1.20', false);
  assert.equal(driftedRegexSelectorRefusal(pinned, [{ tapOn: '.*regex.*' }]), null);
  assert.equal(driftedRegexSelectorRefusal(drifted, [{ tapOn: 'Continue' }]), null);
  assert.equal(driftedRegexSelectorRefusal(null, [{ tapOn: '.*regex.*' }]), null);
});
