import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowUsesClearState,
  resolveAppFileForClearState,
} from '../../dist/handlers/resolve-ios-app-file.js';

// Audit (needs-runtime bucket): flowUsesClearState only matched
// `launchApp: { clearState: true }`, missing the standalone `- clearState`
// command (also in the validator allowlist), which uninstalls + needs reinstall.

test('clearState: launchApp object form is detected', () => {
  assert.equal(flowUsesClearState('- launchApp:\n    clearState: true\n'), true);
});

test('clearState: standalone command form is now detected', () => {
  assert.equal(flowUsesClearState('- launchApp\n- clearState\n- tapOn:\n    id: x\n'), true);
});

test('clearState: a flow without it is not flagged', () => {
  assert.equal(flowUsesClearState('- launchApp\n- tapOn:\n    id: x\n'), false);
});

test('clearState: a comment mentioning clearState does not false-trigger the standalone form', () => {
  // The standalone matcher anchors on a list item, so prose/comment mentions
  // (no leading `- `) do not match.
  assert.equal(flowUsesClearState('# we used to clearState here\n- launchApp\n'), false);
});

// GH #993 review: the text matcher missed Maestro's `- clearState: <appId>`
// argument form, so an iOS flow in that shape uninstalled with no reinstall
// bundle. Detection now runs on the parsed command structure.
test('clearState: the appId-argument command form resolves a reinstall app file', () => {
  const resolution = resolveAppFileForClearState(
    'ios',
    'appId: com.test.app\n---\n- launchApp\n- clearState: com.test.app\n',
    'com.test.app',
    undefined,
    {
      getAppContainer: () => '/sim/MyApp.app',
      exists: () => true,
      snapshotApp: () => '/tmp/rn-appfile-snapshots/MyApp.app',
    },
  );
  assert.deepEqual(resolution, { ok: true, appFile: '/tmp/rn-appfile-snapshots/MyApp.app' });
});

test('clearState: a selector value or explicit false does not force a reinstall', () => {
  const resolution = resolveAppFileForClearState(
    'ios',
    'appId: com.test.app\n---\n- tapOn:\n    text: clearState\n- launchApp:\n    clearState: false\n',
    'com.test.app',
    undefined,
    { getAppContainer: () => assert.fail('no app file should be resolved') },
  );
  assert.deepEqual(resolution, { ok: true });
});

// GH #993 review: a parse failure must never be answered as "does not clear
// state" — that is the GH#201 failure (uninstall with no reinstall bundle).
test('clearState: an unparseable flow surfaces the failure instead of answering false', () => {
  assert.throws(() => flowUsesClearState('- launchApp\n- *missingAnchor\n'), ReferenceError);
  assert.throws(
    () =>
      resolveAppFileForClearState(
        'ios',
        '- launchApp\n- *missingAnchor\n',
        'com.test.app',
        undefined,
        { getAppContainer: () => assert.fail('no app file lookup on an unparseable flow') },
      ),
    ReferenceError,
  );
});

// yaml records syntax errors on the document instead of throwing, and toJS()
// returns partial content that can drop a real clearState.
test('clearState: a YAML syntax error before a clearState surfaces instead of answering false', () => {
  const unclosedQuote = '- tapOn: "unclosed\n- launchApp:\n    clearState: true\n';
  const tabIndent = '- tapOn:\n\tid: x\n- launchApp:\n    clearState: true\n';
  for (const flow of [unclosedQuote, tabIndent]) {
    assert.throws(() => flowUsesClearState(flow), { name: 'YAMLParseError' });
  }
});
