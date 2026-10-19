import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createSandbox } from '../helpers/inject-harness.js';
import { HELPERS_VERSION, INJECTED_HELPERS } from '../../../dist/injected-helpers.js';
import { assertionView, join as joinScreen, type DigestEntry } from '../../../dist/qa/screen.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { decideScreen, prepareTarget, resolveTarget } from '../../../dist/qa/resolve.js';
import { runPlan } from '../../../dist/qa/walker.js';
import {
  choice,
  element,
  screen as syntheticScreen,
  scriptedJudge,
  walker,
} from './judgment-fixtures.ts';

interface Fiber {
  tag: number;
  type: string | { displayName: string } | null;
  memoizedProps: Record<string, unknown> | string;
  child?: Fiber;
  sibling?: Fiber;
}

function fiber(
  name: string,
  tag: number,
  props: Record<string, unknown>,
  children: Fiber[] = [],
): Fiber {
  children.forEach((child, i) => {
    child.sibling = children[i + 1];
  });
  return {
    tag,
    type: tag === 5 ? name : { displayName: name },
    memoizedProps: props,
    child: children[0],
  };
}

function control(testID: string, text: string): Fiber {
  const props = { testID, onClick() {} };
  let current = fiber('RCTView', 5, props, [{ tag: 6, type: null, memoizedProps: text }]);
  for (const [name, tag] of [
    ['View', 0],
    ['CssInterop.View', 0],
    ['Pressable', 15],
    ['CssInterop.Pressable', 11],
  ] as const) {
    current = fiber(name, tag, props, [current]);
  }
  return current;
}

function digest(children: Fiber[]): DigestEntry[] {
  const sandbox = createSandbox({ fiberRoot: fiber('Screen', 0, {}, children) });
  return JSON.parse(vm.runInContext('__QAREN.getTree({ interactiveOnly: true })', sandbox))
    .interactive;
}

test('a phrase press resolves one native control through its forwarded React wrapper chain', async () => {
  const interactive = digest([
    control('onboarding-skip', 'Skip'),
    control('onboarding-next', 'Next'),
  ]);
  const screen = joinScreen(
    [
      { ref: '@skip', identifier: 'onboarding-skip', label: 'Skip', type: 'Other', hittable: true },
      { ref: '@next', identifier: 'onboarding-next', label: 'Next', type: 'Other', hittable: true },
    ],
    interactive,
    'app',
    { native: 'complete', react: 'complete' },
  );
  const judge = scriptedJudge((q) => ({ target_1: choice(q.target_1, 'e0') }));
  const f = walker([screen], judge);
  const ledger = await runPlan(parsePlan('1. Tap the skip onboarding control').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS', ledger.failure?.seen);
  assert.deepEqual(f.actions, ['press @skip']);
  assert.equal(judge.requests.length, 1);
  assert.deepEqual(interactive, [
    {
      role: 'button',
      testID: 'onboarding-skip',
      text: 'Skip',
      capabilities: { press: true, fill: false },
    },
    {
      role: 'button',
      testID: 'onboarding-next',
      text: 'Next',
      capabilities: { press: true, fill: false },
    },
  ]);
  assert.equal(
    screen.elements.length,
    2,
    'forwarded identities do not become phantom offscreen controls',
  );
});

test('a warm version-76 runtime receives the new digest and subsequent injection is idempotent', () => {
  const sandbox = createSandbox({ fiberRoot: fiber('Screen', 0, {}, [control('save', 'Save')]) });
  Object.defineProperty(sandbox, '__QAREN', {
    configurable: true,
    writable: true,
    value: {
      __v: 76,
      getTree() {
        assert.fail('the stale version-76 digest must be replaced');
      },
    },
  });
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(vm.runInContext('__QAREN.__v', sandbox), HELPERS_VERSION);
  const result = JSON.parse(vm.runInContext('__QAREN.getTree({ interactiveOnly: true })', sandbox));
  assert.deepEqual(result.interactive, [
    { role: 'button', testID: 'save', text: 'Save', capabilities: { press: true, fill: false } },
  ]);
  const current = vm.runInContext('__QAREN.getTree', sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(vm.runInContext('__QAREN.getTree', sandbox), current);
});

test('separate native controls sharing a testID remain distinct and refuse quoted ambiguity', async () => {
  const screen = joinScreen(
    [
      {
        ref: '@top',
        identifier: 'save',
        label: 'Save',
        type: 'Button',
        hittable: true,
        rect: { x: 0, y: 0, width: 100, height: 20 },
      },
      {
        ref: '@bottom',
        identifier: 'save',
        label: 'Save',
        type: 'Button',
        hittable: true,
        rect: { x: 0, y: 400, width: 100, height: 20 },
      },
    ],
    digest([control('save', 'Save'), control('save', 'Save')]),
    'app',
    { native: 'complete', react: 'complete' },
  );
  const step = { kind: 'press' as const, target: { phrase: 'Save', quoted: 'Save' } };
  const judge = scriptedJudge(() => assert.fail('quoted ambiguity must not ask Jev'));
  const resolved = await resolveTarget(step, screen, judge);
  assert.ok('refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS');
  assert.deepEqual(
    screen.elements.map((e) => e.ref),
    ['@top', '@bottom'],
  );
  assert.equal(judge.requests.length, 0);
});

test('separate unmatched React controls sharing a testID still refuse before asking or pressing', async () => {
  const screen = joinScreen([], digest([control('save', 'Save'), control('save', 'Save')]), 'app', {
    native: 'complete',
    react: 'complete',
  });
  const judge = scriptedJudge(() => assert.fail('duplicate refs must not reach Jev'));
  const f = walker([screen], judge);
  const ledger = await runPlan(parsePlan('1. Tap Save').blocks!, f.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.match(ledger.failure!.seen, /AMBIGUOUS_REFS/);
  assert.deepEqual(f.actions, []);
  assert.equal(judge.requests.length, 0);
});

test('one forwarded unmatched React control has unknown visibility and cannot authorize a scroll', async () => {
  const screen = joinScreen([], digest([control('later', 'Load more')]), 'app', {
    native: 'complete',
    react: 'complete',
  });
  assert.equal(screen.elements.length, 1);
  assert.equal(screen.elements[0].semantic?.visibility, 'unknown');
  assert.deepEqual(assertionView(screen), []);
  const judge = scriptedJudge(() => assert.fail('unattested visibility must not reach Jev'));
  const result = await resolveTarget(
    { kind: 'press', target: { phrase: 'Load more' } },
    screen,
    judge,
  );
  assert.ok('refuse' in result && result.refuse === 'SCREEN_EVIDENCE_INCOMPLETE');
  const f = walker([screen], judge);
  const ledger = await runPlan(parsePlan('1. Tap Load more').blocks!, f.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.match(ledger.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
  assert.deepEqual(f.actions, []);
  assert.equal(judge.requests.length, 0);
});

test('an attested offscreen control remains a scroll candidate, never visible assertion evidence', async () => {
  const screen = syntheticScreen([
    element('react:later', 'Load more', { testID: 'later', offscreen: true, hittable: false }),
  ]);
  assert.deepEqual(assertionView(screen), []);
  const judge = scriptedJudge((q, _index, state) => {
    assert.deepEqual(Object.keys(q), ['visibility_1']);
    assert.deepEqual(state, {
      front: 'app',
      assertionEvidence: { observed: [], unknown: [], unassociatedReact: 0, qualifiedHeadings: [] },
    });
    return { visibility_1: { type: 'noul', noul: 0 } };
  });
  assert.deepEqual(
    await resolveTarget({ kind: 'press', target: { phrase: 'Load more' } }, screen, judge),
    {
      scroll: 'down',
      element: screen.elements.find((e) => e.ref === 'react:later'),
      origin: 'named-offscreen',
    },
  );
  const visibility = await decideScreen(screen, judge, undefined, {
    kind: 'wait',
    target: { phrase: 'Load more' },
    line: 1,
  });
  assert.deepEqual(visibility.visibility, { verdict: 'absent' });
  assert.equal(judge.requests.length, 1, 'only the assertion asks Jev, without offscreen content');
});

test('forwarded metadata survives transparent wrappers and disabled state is never weakened', () => {
  const root = fiber(
    'Pressable',
    15,
    { testID: 'save', disabled: true, accessibilityLabel: 'Save changes' },
    [fiber('Wrapper', 0, {}, [control('save', 'Save')])],
  );
  assert.deepEqual(digest([root]), [
    {
      role: 'button',
      testID: 'save',
      disabled: true,
      label: 'Save changes',
      text: 'Save',
      capabilities: { press: true, fill: false },
    },
  ]);
  const screen = joinScreen(
    [{ ref: '@save', identifier: 'save', label: 'Save', hittable: true }],
    digest([root]),
    'app',
    { native: 'complete', react: 'complete' },
  );
  const target = prepareTarget({ kind: 'press', target: { phrase: 'Save' } }, screen);
  assert.ok('refuse' in target && target.refuse === 'TARGET_NOT_FOUND');
  const hostDisabled = fiber('Pressable', 15, { testID: 'save' }, [
    fiber('RCTView', 5, { testID: 'save', onClick() {}, accessibilityState: { disabled: true } }),
  ]);
  assert.equal(digest([hostDisabled])[0].disabled, true);
});

test('identity forwarding stops at native hosts, branches, changed IDs and changed roles', () => {
  const props = { testID: 'save', onClick() {} };
  const nestedHosts = fiber('RCTView', 5, props, [fiber('RCTView', 5, props)]);
  assert.equal(digest([nestedHosts]).length, 2);
  const branched = fiber('Pressable', 15, props, [
    control('save', 'Save'),
    control('save', 'Save'),
  ]);
  const entries = digest([branched]);
  assert.equal(entries.length, 3);
  const target = prepareTarget(
    { kind: 'press', target: { phrase: 'Save' } },
    joinScreen([], entries, 'app', { native: 'complete', react: 'complete' }),
  );
  assert.ok('refuse' in target && target.refuse === 'AMBIGUOUS_REFS');
  const changedID = fiber('Pressable', 15, props, [
    fiber('Wrapper', 0, { testID: 'different' }, [control('save', 'Save')]),
  ]);
  assert.equal(digest([changedID]).length, 2);
  const changedRole = fiber('Pressable', 15, props, [
    fiber('RCTView', 5, { ...props, accessibilityRole: 'link' }),
  ]);
  assert.deepEqual(
    digest([changedRole]).map((e) => e.role),
    ['button', 'link'],
  );
});

test('duplicate native refs still fail closed and a unique quoted native target stays model-free', async () => {
  const native = {
    ref: '@save',
    identifier: 'save',
    label: 'Save',
    type: 'Button',
    hittable: true,
  };
  const ambiguous = prepareTarget(
    { kind: 'press', target: { phrase: 'Save' } },
    joinScreen([native, native], [], 'app', { native: 'complete', react: 'complete' }),
  );
  assert.ok('refuse' in ambiguous && ambiguous.refuse === 'AMBIGUOUS_REFS');
  const judge = scriptedJudge(() => assert.fail('unique quoted target is local'));
  const exact = await resolveTarget(
    { kind: 'press', target: { phrase: 'Save', quoted: 'Save' } },
    joinScreen([native], digest([control('save', 'Save')])),
    judge,
  );
  assert.ok('ref' in exact && exact.ref === '@save');
  assert.equal(judge.requests.length, 0);
});
