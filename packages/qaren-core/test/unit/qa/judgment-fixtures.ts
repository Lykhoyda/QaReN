import assert from 'node:assert/strict';
import type {
  Answer,
  Answers,
  Judge,
  JevCall,
  Question,
  Questions,
} from '../../../dist/qa/questions.js';
import {
  join as joinScreen,
  type Element,
  type Screen,
  type NativeNode,
  type ReactHostEvidence,
} from '../../../dist/qa/screen.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import type { LedgerRow } from '../../../dist/qa/ledger.js';

export function element(ref: string, label: string, extra: Partial<Element> = {}): Element {
  const kind = extra.kind ?? 'button';
  return {
    ref,
    label,
    kind,
    hittable: true,
    disabled: false,
    secure: false,
    offscreen: false,
    semantic: {
      press: ['button', 'switch', 'link', 'cell'].includes(kind) ? 'supported' : 'unsupported',
      fill: kind === 'input' ? 'supported' : 'unsupported',
      visibility: extra.offscreen ? 'offscreen' : 'visible',
    },
    ...extra,
  };
}

export function screen(
  elements: Element[],
  visibleText = elements
    .filter((e) => e.semantic?.visibility === 'visible')
    .map((e) => e.label ?? ''),
): Screen {
  return {
    front: 'app',
    elements,
    visibleText,
    coverage: { native: 'complete', react: 'complete' },
  };
}

export function choice(
  question: Question,
  chosen = 'e0',
  probabilities?: Record<string, number>,
): Answer {
  assert.equal(question.type, 'choice');
  return {
    type: 'choice',
    choice: chosen,
    confidence: 0.99,
    probabilities:
      probabilities ??
      Object.fromEntries(
        Object.keys(question.criteria!).map((key) => [key, key === chosen ? 1 : 0]),
      ),
  };
}

export function scriptedJudge(
  script: (q: Questions, index: number, state: unknown) => Answers,
): Judge & { requests: { state: unknown; questions: Questions }[] } {
  const calls: JevCall[] = [];
  const requests: { state: unknown; questions: Questions }[] = [];
  return {
    calls,
    requests,
    async ask(state, questions, scope = 'walk') {
      const index = requests.length;
      requests.push(structuredClone({ state, questions }));
      calls.push({
        scope,
        questionIds: Object.keys(questions),
        inputTokens: 10 + index,
        ms: 20 + index * 10,
        outcome: 'ok',
        status: 200,
      });
      return script(questions, index, state);
    },
  };
}

export function walker(
  screens: Screen[],
  judge: Judge,
  act: ActResult = { ok: true, proven: true },
) {
  const actions: string[] = [];
  const rows: LedgerRow[] = [];
  let captures = 0;
  let time = 0;
  const deps: WalkerDeps = {
    judge,
    async captureScreen() {
      return screens[Math.min(captures++, screens.length - 1)];
    },
    async press(ref) {
      actions.push(`press ${ref}`);
      return act;
    },
    async fill(ref, text) {
      actions.push(`fill ${ref} ${text}`);
      return act;
    },
    async scroll(dir) {
      actions.push(`scroll ${dir}`);
      return act;
    },
    async back() {
      actions.push('back');
      return act;
    },
    async dialog(action) {
      actions.push(`dialog ${action}`);
      return act;
    },
    async screenshot(name) {
      return name;
    },
    now: () => time,
    async sleep(ms) {
      time += ms;
    },
    row: (row) => {
      rows.push(row);
    },
  };
  return { deps, actions, rows, captures: () => captures };
}

export function joinedGapScreen(
  category: 'missing-host-evidence' | 'incomplete-host-evidence' | 'unassociated-hosts',
  presence: boolean | 'unknown' = true,
  typographyComplete = true,
  ancestry?:
    | 'shared'
    | 'distinct'
    | 'retained'
    | 'other'
    | 'ambiguous'
    | 'incompatible'
    | 'incompatible-distinct'
    | 'incompatible-same',
): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      ref: '@private-target',
      type: 'Button',
      parentIndex: 1,
      identifier: 'private-gap-primary',
      label: 'private-gap-label',
      hittable: true,
      rect: { x: 20, y: 100, width: 100, height: 40 },
    },
    { ref: '@id-input', type: 'TextField', parentIndex: 1, value: 'private-gap-primary' },
    { ref: '@label-input', type: 'TextField', parentIndex: 1, value: 'private-gap-label' },
  ];
  const evidence: ReactHostEvidence | undefined =
    category === 'missing-host-evidence'
      ? undefined
      : {
          complete: category !== 'incomplete-host-evidence',
          hosts: Array.from({ length: 10 }, (_, i) => ({
            testID: 'private-unassociated-host-' + i,
            role: 'button',
            roleSource: 'role',
            capabilities: { press: true, fill: false },
          })),
          typography: {
            version: 1,
            complete: typographyComplete,
            durationMs: 1,
            coordinateSpace: 'window-points',
            nodes: Array.from({ length: 10 }, (_, i) => ({
              hostIndex: i,
              parentHostIndex: null,
              rootIndex: 0,
              hostType: 'RCTView',
              rect: { x: 20, y: 100, width: 100, height: 40 },
              text: { kind: 'none' },
            })),
          },
        };
  if (ancestry && evidence) {
    const paired = ancestry !== 'shared' && ancestry !== 'incompatible';
    const incompatible = ancestry.startsWith('incompatible');
    const ambiguous = ancestry !== 'shared' && ancestry !== 'distinct' && !incompatible;
    const parentCount = paired ? 2 : 1;
    const parents = Array.from({ length: parentCount }, (_, i) => ({
      testID: 'private-ancestor-canary-' + (ambiguous ? 0 : i),
      hidden: !ambiguous || (i === 1 && ancestry !== 'ambiguous'),
      role: null,
      roleSource: 'none',
      capabilities: { press: ambiguous && (i === 0 || ancestry === 'ambiguous'), fill: false },
    }));
    const children = evidence.hosts;
    evidence.hosts = [...parents, ...children];
    evidence.typography!.nodes = evidence.hosts.map((_, hostIndex) => ({
      hostIndex,
      parentHostIndex:
        hostIndex < parentCount
          ? null
          : ancestry === 'other'
            ? 1
            : ancestry === 'distinct' ||
                ancestry === 'incompatible-distinct' ||
                ancestry === 'incompatible-same'
              ? (hostIndex - parentCount) % 2
              : 0,
      rootIndex: 0,
      hostType: 'RCTView',
      rect: { x: 20, y: 100, width: 100, height: 40 },
      text: { kind: 'none' },
    }));
    if (incompatible) {
      for (let i = 0; i < parentCount; i++) {
        evidence.typography!.nodes[i].hostType =
          i === 1 && ancestry === 'incompatible-distinct' ? 'RCTVirtualText' : 'RCTText';
        nodes.push({
          ref: '@private-ancestor-' + i,
          type: 'Other',
          parentIndex: 1,
          identifier: parents[i].testID,
          rect: { x: 20, y: 100, width: 100, height: 40 },
        });
      }
    }
    for (const child of children)
      nodes.push({
        ref: '@private-child-' + nodes.length,
        type: 'Other',
        parentIndex: 1,
        identifier: child.testID,
        rect: { x: 20, y: 100, width: 100, height: 40 },
      });
  }
  const native: NativePresence | 'unknown' | undefined =
    presence === true
      ? {
          source: 'xcui-live',
          nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
        }
      : presence === 'unknown'
        ? 'unknown'
        : undefined;
  return joinScreen(nodes, [], 'app', { native: 'complete', react: 'complete' }, evidence, native);
}
