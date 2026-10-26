import { normalizeSteps, UnsupportedStepError } from './cdp-flow-replay.js';

export type IosProofDomain = 'react-tree' | 'xctest-native';

export interface IosProofSegment {
  domain: IosProofDomain;
  commands: unknown[];
  sourceIndices: number[];
  initialReactFocusId?: string;
}

export type IosProofPlan =
  | { ok: true; segments: IosProofSegment[] }
  | { ok: false; sourceIndex: number; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsExactId(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (Array.isArray(value)) return value.some((child) => containsExactId(child, depth + 1));
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (key === 'id' && typeof child === 'string') || containsExactId(child, depth + 1),
  );
}

function commandName(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (!isObject(command)) return null;
  const keys = Object.keys(command);
  return keys.length === 1 ? keys[0]! : null;
}

function commandTreeContains(value: unknown, names: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 20) return false;
  if (Array.isArray(value)) {
    return value.some((child) => commandTreeContains(child, names, depth + 1));
  }
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => names.has(key) || commandTreeContains(child, names, depth + 1),
  );
}

function runFlowHasUnanchoredLeadingInputText(command: unknown): boolean {
  if (!isObject(command) || !isObject(command.runFlow)) return false;
  const commands = command.runFlow.commands;
  if (!Array.isArray(commands) || commands.length === 0) return false;
  for (const child of commands) {
    const name = commandName(child);
    if (name === 'inputText') return true;
    if (name && nativeFocusPreservingCommands.has(name)) continue;
    if (name === 'tapOn' || name === 'tap')
      return commands.some((candidate) => commandName(candidate) === 'inputText');
    return false;
  }
  return false;
}

const nativeFocusPreservingCommands = new Set([
  'assertVisible',
  'assertNotVisible',
  'extendedWaitUntil',
  'takeScreenshot',
  'waitForAnimationToEnd',
]);

export function nativeCommandMayChangeFocus(command: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  const name = commandName(command);
  if (name !== 'runFlow') return name === null || !nativeFocusPreservingCommands.has(name);
  if (!isObject(command)) return true;
  const runFlow = command.runFlow;
  if (!isObject(runFlow) || !Array.isArray(runFlow.commands)) return true;
  return runFlow.commands.some((child) => nativeCommandMayChangeFocus(child, depth + 1));
}

function exactTapId(command: unknown, params: Record<string, string>): string | null {
  try {
    const step = normalizeSteps([command], params)[0];
    return step?.t === 'tap' ? step.id : null;
  } catch (error) {
    if (error instanceof UnsupportedStepError) return null;
    throw error;
  }
}

function commandDomain(
  command: unknown,
  params: Record<string, string>,
): IosProofDomain | 'neutral' | 'mixed' {
  const name = commandName(command);
  if (name === 'waitForAnimationToEnd' || name === 'inputText') return 'neutral';
  try {
    normalizeSteps([command], params);
    return name === 'launchApp' ? 'neutral' : 'react-tree';
  } catch (error) {
    if (!(error instanceof UnsupportedStepError)) throw error;
    return containsExactId(command) ? 'mixed' : 'xctest-native';
  }
}

export function planIosProofDomains(
  commands: unknown[],
  params: Record<string, string>,
): IosProofPlan {
  const classified = commands.map((command) => commandDomain(command, params));
  for (let index = 0; index < classified.length; index++) {
    if (classified[index] === 'mixed') {
      return {
        ok: false,
        sourceIndex: index,
        reason:
          'one command mixes an exact testID with native-only semantics; split it into separate React-tree and XCTest commands',
      };
    }
  }

  const segments: IosProofSegment[] = [];
  let focusedDomain: IosProofDomain | null = null;
  let focusedReactId: string | null = null;
  const tapCommands = new Set(['tapOn', 'tap']);
  const lifecycleCommands = new Set(['launchApp', 'clearState', 'killApp', 'stopApp']);
  for (let index = 0; index < commands.length; index++) {
    const name = commandName(commands[index]);
    let domain = classified[index];
    if (name === 'runFlow' && runFlowHasUnanchoredLeadingInputText(commands[index])) {
      domain = 'xctest-native';
    }
    if (domain === 'neutral') {
      domain =
        name === 'inputText'
          ? (focusedDomain ?? 'xctest-native')
          : (segments.at(-1)?.domain ??
            classified.slice(index + 1).find((candidate) => candidate !== 'neutral') ??
            'react-tree');
    }
    if (domain === 'mixed') continue;
    const prior = segments.at(-1);
    if (prior?.domain === domain) {
      prior.commands.push(commands[index]);
      prior.sourceIndices.push(index);
    } else {
      segments.push({
        domain,
        commands: [commands[index]],
        sourceIndices: [index],
        ...(domain === 'react-tree' && focusedReactId
          ? { initialReactFocusId: focusedReactId }
          : {}),
      });
    }
    if (domain === 'xctest-native' && nativeCommandMayChangeFocus(commands[index])) {
      focusedDomain = domain;
      focusedReactId = null;
    } else if (tapCommands.has(name ?? '')) {
      focusedDomain = domain;
      focusedReactId =
        name === 'tapOn' && domain === 'react-tree' ? exactTapId(commands[index], params) : null;
    } else if (commandTreeContains(commands[index], tapCommands)) {
      focusedDomain = domain;
      focusedReactId = null;
    } else if (commandTreeContains(commands[index], lifecycleCommands)) {
      focusedDomain = null;
      focusedReactId = null;
    }
  }
  const firstReact = segments.findIndex(
    (segment) =>
      segment.domain === 'react-tree' &&
      segment.commands.some((command) => containsExactId(command)),
  );
  if (firstReact !== -1) {
    for (const segment of segments.slice(firstReact + 1)) {
      if (segment.domain !== 'xctest-native') continue;
      for (let index = 0; index < segment.commands.length; index++) {
        const command = commandName(segment.commands[index]) ?? 'command';
        if (lifecycleCommands.has(command)) continue;
        return {
          ok: false,
          sourceIndex: segment.sourceIndices[index]!,
          reason: `${command}: a native segment starts a new runner session that relaunches the app and discards the React-tree steps`,
        };
      }
    }
  }
  return { ok: true, segments };
}

export interface NativeProofSelector {
  kind: 'text';
  value: string;
}

export function selectorsVisibleInNativeSnapshot(
  selectors: NativeProofSelector[],
  nodes: Array<{ label?: string; identifier?: string; hittable?: boolean }>,
): NativeProofSelector[] {
  return selectors.filter((selector) =>
    nodes.some(
      (node) =>
        node.hittable === true &&
        (node.label === selector.value || node.identifier === selector.value),
    ),
  );
}

export function nativeSelectorsForCommands(commands: unknown[]): NativeProofSelector[] {
  const selectors = new Set<string>();
  const unsupportedSelectors = new Set<string>();
  const addSelector = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!unsupportedSelectors.has(value)) selectors.add(value);
      return;
    }
    if (isObject(value) && typeof value.text === 'string') {
      if (Object.keys(value).length === 1 && !unsupportedSelectors.has(value.text)) {
        selectors.add(value.text);
      } else {
        selectors.delete(value.text);
        unsupportedSelectors.add(value.text);
      }
    }
  };
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 20) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === 'tapOn' || childKey === 'assertVisible') addSelector(child);
      if (childKey === 'extendedWaitUntil' && isObject(child)) addSelector(child.visible);
      if (childKey === 'scrollUntilVisible' && isObject(child)) addSelector(child.element);
      if (childKey === 'when' && isObject(child)) addSelector(child.visible);
      if (childKey !== 'assertNotVisible' && childKey !== 'notVisible') visit(child, depth + 1);
    }
  };
  visit(commands);
  return [...selectors].slice(0, 20).map((value) => ({ kind: 'text', value }));
}

export function soleComparableNativeSelectorForCommands(
  commands: unknown[],
): NativeProofSelector | null {
  const candidates: Array<NativeProofSelector | null> = [];
  const addCandidate = (value: unknown): void => {
    if (typeof value === 'string') {
      candidates.push({ kind: 'text', value });
      return;
    }
    if (isObject(value) && typeof value.text === 'string') {
      candidates.push(Object.keys(value).length === 1 ? { kind: 'text', value: value.text } : null);
      return;
    }
    candidates.push(null);
  };
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 20) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === 'tapOn' || childKey === 'assertVisible') addCandidate(child);
      if (childKey === 'extendedWaitUntil' && isObject(child)) addCandidate(child.visible);
      if (childKey === 'scrollUntilVisible' && isObject(child)) addCandidate(child.element);
      if (childKey === 'when' && isObject(child)) addCandidate(child.visible);
      if (childKey !== 'assertNotVisible' && childKey !== 'notVisible') visit(child, depth + 1);
    }
  };
  visit(commands);
  return candidates.length === 1 ? candidates[0] : null;
}

export function loginPostconditionId(commands: unknown[]): string | null {
  const last = commands.at(-1);
  if (!isObject(last)) return null;
  const command = last.assertVisible ?? last.extendedWaitUntil;
  if (!isObject(command)) return null;
  const visible = 'visible' in command ? command.visible : command;
  return isObject(visible) && typeof visible.id === 'string' ? visible.id : null;
}
