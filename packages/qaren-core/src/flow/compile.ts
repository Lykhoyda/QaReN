import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, relative } from 'node:path';
import yaml, { LineCounter, isMap, isSeq } from 'yaml';
import { PARAM_PLACEHOLDER } from '../domain/cdp-flow-replay.js';
import { isRegexShapedSelector } from '../domain/engine-pin.js';
import {
  MaestroValidationError,
  parseAndValidateFlow,
  resolveRunFlowTarget,
  validateCommand,
} from '../domain/maestro-validator.js';
import { parseM7Header } from '../domain/reusable-action.js';
import {
  DEFAULT_ERASE_CHARACTERS,
  DEFAULT_SWIPE_DURATION_MS,
  LAUNCH_BUDGET_MS,
  LOOKUP_BUDGET_MS,
  NATIVE_DISPATCH_BUDGET_MS,
  OPTIONAL_LOOKUP_BUDGET_MS,
  PLAN_SCHEMA,
  SCROLL_UNTIL_VISIBLE_BUDGET_MS,
  SETTLE_CAP_MS,
  TERMINATE_BUDGET_MS,
  type Direction,
  type Domain,
  type Plan,
  type Platform,
  type Selector,
  type Step,
} from './plan.js';

export class FlowCompileError extends Error {
  constructor(
    readonly line: number,
    readonly command: string,
    readonly reason: string,
    readonly file?: string,
  ) {
    super(`${file ? `${file} ` : ''}line ${line}${command ? ` ${command}` : ''}: ${reason}`);
    this.name = 'FlowCompileError';
  }
}

export interface CompileFlowInput {
  file: string;
  params: Record<string, string>;
  platform: Platform;
}

interface Body {
  values: unknown[];
  nodes: unknown[];
  lines: LineCounter;
  hasAppIdHeader: boolean;
}

interface Context {
  params: Record<string, string>;
  read: (path: string) => string;
  depth: number;
  platform: Platform;
  root: string;
  dir: string;
  file?: string;
  nextId: () => string;
}

const RELATIVE_SELECTOR_KEYS = new Set([
  'above',
  'below',
  'leftOf',
  'rightOf',
  'childOf',
  'containsChild',
  'containsDescendants',
]);
const DIRECTIONS = new Set<Direction>(['UP', 'DOWN', 'LEFT', 'RIGHT']);
const SWIPE_SHORTHANDS: Record<string, Direction> = {
  swipeUp: 'UP',
  swipeDown: 'DOWN',
  swipeLeft: 'LEFT',
  swipeRight: 'RIGHT',
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_RUN_FLOW_DEPTH = 5;

function readBody(text: string, file?: string): Body {
  const lines = new LineCounter();
  const docs = yaml.parseAllDocuments(text, { lineCounter: lines, strict: true });
  const all = Array.isArray(docs) ? docs : [];
  const error = all.flatMap((doc) => doc.errors)[0];
  if (error) {
    throw new FlowCompileError(
      lines.linePos(error.pos[0]).line,
      '',
      `YAML: ${error.message}`,
      file,
    );
  }
  if (all.length > 2) {
    const line = lines.linePos(all[2]!.range[0]).line;
    throw new FlowCompileError(
      line,
      '',
      'a flow is one optional header and one command list',
      file,
    );
  }
  if (all.length === 2) {
    const header = all[0]!;
    if (
      !isMap(header.contents) ||
      header.contents.items.length !== 1 ||
      !header.contents.has('appId')
    ) {
      throw new FlowCompileError(
        lines.linePos(header.range[0]).line,
        '',
        'the first document must be an appId header',
        file,
      );
    }
  }
  const doc = all.at(-1);
  if (!isSeq(doc?.contents) || doc.contents.items.length === 0) {
    throw new FlowCompileError(
      doc ? lines.linePos(doc.range[0]).line : 1,
      '',
      'the final document must be a non-empty command list',
      file,
    );
  }
  let values: unknown[];
  try {
    values = all.map((each) => each.toJS()).at(-1) as unknown[];
  } catch (caught) {
    throw new FlowCompileError(0, '', `YAML: ${(caught as Error).message}`, file);
  }
  return {
    values,
    nodes: doc.contents.items,
    lines,
    hasAppIdHeader: all.length === 2,
  };
}

export function compileFlow({ file, params, platform }: CompileFlowInput): Plan {
  if (platform !== 'ios' && platform !== 'android') {
    throw new FlowCompileError(0, '', `platform must be ios or android, got ${String(platform)}`);
  }
  const dir = dirname(file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new FlowCompileError(0, '', `cannot read ${file}: ${(error as Error).message}`);
  }
  // One read per file: the validator and the compiler see the same bytes.
  const cache = new Map<string, string>();
  const read = (path: string): string => {
    const cached = cache.get(path) ?? readFileSync(path, 'utf8');
    cache.set(path, cached);
    return cached;
  };
  let counter = 0;
  const root = realpathSync(dir);
  const context: Context = {
    params,
    read,
    depth: 0,
    platform,
    root,
    dir: root,
    nextId: () => `s${++counter}`,
  };
  // The dialect walk runs first so its refusals carry a line; nothing executes before validation.
  const steps = compileCommands(readBody(text), context);
  let appId: string | undefined;
  try {
    appId = parseAndValidateFlow(text, { flowDir: root, flowRoot: root, readFileFn: read }).appId;
  } catch (error) {
    if (error instanceof MaestroValidationError) throw new FlowCompileError(0, '', error.message);
    throw error;
  }
  if (!appId) throw new FlowCompileError(0, '', 'the flow has no appId header');
  const fallbackId = basename(file, extname(file));
  return deepFreeze({
    schema: PLAN_SCHEMA,
    actionId: parseM7Header(text, fallbackId)?.id ?? fallbackId,
    appId,
    platform,
    steps,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compileCommands(body: Body, context: Context): Step[] {
  return body.values.flatMap((value, index) =>
    compileCommand(value, body.nodes[index], body.lines, context),
  );
}

function compileCommand(
  value: unknown,
  node: unknown,
  lines: LineCounter,
  context: Context,
): Step[] {
  const offset = (node as { range?: [number] } | undefined)?.range?.[0];
  const line = offset === undefined ? 0 : lines.linePos(offset).line;
  const keys = isObject(value) ? Object.keys(value) : [];
  const name = typeof value === 'string' ? value : keys.length === 1 ? keys[0]! : '';
  if (!name) {
    throw new FlowCompileError(line, '', 'a command is a name or a one-key map', context.file);
  }
  const arg = typeof value === 'string' ? null : (value as Record<string, unknown>)[name];
  const refuse = (reason: string): never => {
    throw new FlowCompileError(line, name, reason, context.file);
  };
  const validate = (): void => {
    try {
      validateCommand(value);
    } catch (error) {
      if (error instanceof MaestroValidationError) refuse(error.message);
      throw error;
    }
  };
  if (name !== 'runFlow') validate();

  const onlyKeys = (object: Record<string, unknown>, allowed: string[], label = name): void => {
    for (const key of Object.keys(object)) {
      if (allowed.includes(key)) continue;
      if (RELATIVE_SELECTOR_KEYS.has(key)) refuse(`relative selector "${key}" is not in rn-flow@1`);
      refuse(`unsupported key "${key}" in ${label}`);
    }
  };
  const noArgument = (): void => {
    if (arg !== null && arg !== undefined) refuse('takes no argument in rn-flow@1');
  };
  const resolve = (template: unknown, what: string, textSelector = false): string => {
    if (typeof template !== 'string' || template === '')
      refuse(`${what} must be a non-empty string`);
    if ((template as string).replace(PARAM_PLACEHOLDER, '').includes('${')) {
      refuse(
        `${what} uses an unsupported expression; only \${NAME} and \${NAME ?? "x"} interpolate`,
      );
    }
    const authored = (template as string).replace(
      PARAM_PLACEHOLDER,
      (_match, _key, _quote, fallback: string | undefined) => fallback ?? '',
    );
    if (textSelector && isRegexShapedSelector(authored)) {
      refuse(`text "${template}" is regex-shaped; rn-flow@1 matches text exactly (GH #750)`);
    }
    const missing: string[] = [];
    const resolved = (template as string).replace(
      PARAM_PLACEHOLDER,
      (match, key: string, _quote: string | undefined, fallback: string | undefined) => {
        const replacement = context.params[key] ?? fallback;
        if (replacement === undefined) missing.push(key);
        return replacement ?? match;
      },
    );
    if (missing.length > 0) refuse(`missing param ${missing.join(', ')}`);
    if (resolved === '') refuse(`${what} resolves to an empty string`);
    return resolved;
  };
  const integer = (raw: unknown, what: string, fallback: number, minimum = 0): number => {
    if (raw === undefined) return fallback;
    if (!Number.isSafeInteger(raw) || (raw as number) < minimum) {
      refuse(`${what} must be a ${minimum === 0 ? 'non-negative' : 'positive'} integer`);
    }
    return raw as number;
  };
  const selector = (
    raw: unknown,
    allowOptional = false,
  ): { selector: Selector; optional: boolean } => {
    if (typeof raw === 'string')
      return { selector: { text: resolve(raw, 'text', true) }, optional: false };
    if (!isObject(raw)) return refuse('selector must be text or a map with id or text');
    onlyKeys(raw, ['id', 'text', 'index', ...(allowOptional ? ['optional'] : [])]);
    if ('id' in raw && 'text' in raw) {
      refuse('one selector carries both id and text; split it into two steps');
    }
    if (!('id' in raw) && !('text' in raw)) refuse('selector needs id or text');
    if ('optional' in raw && typeof raw.optional !== 'boolean')
      refuse('optional must be a boolean');
    const index = raw.index === undefined ? {} : { index: integer(raw.index, 'index', 0) };
    return {
      selector:
        'id' in raw
          ? { id: resolve(raw.id, 'id'), ...index }
          : { text: resolve(raw.text, 'text', true), ...index },
      optional: raw.optional === true,
    };
  };
  // Absence needs on-screen evidence: a parked sheet keeps its fibers mounted.
  const readDomain = (target: Selector, absence: boolean): Domain =>
    context.platform === 'ios' && !absence && 'id' in target && target.index === undefined
      ? 'react-tree'
      : 'native';
  const direction = (raw: unknown, fallback: Direction): Direction => {
    if (raw === undefined) return fallback;
    const upper = typeof raw === 'string' ? raw.toUpperCase() : '';
    if (!DIRECTIONS.has(upper as Direction)) refuse('direction must be UP, DOWN, LEFT or RIGHT');
    return upper as Direction;
  };
  const step = (
    fields: Record<string, unknown>,
    domain: Domain,
    budgetMs: number,
    optional = false,
  ): Step[] => [
    {
      id: context.nextId(),
      source: context.file ? { file: context.file, line } : { line },
      domain,
      optional,
      budgetMs,
      ...fields,
    } as Step,
  ];
  const lookup = (optional: boolean): number =>
    optional ? OPTIONAL_LOOKUP_BUDGET_MS : LOOKUP_BUDGET_MS;

  switch (name) {
    case 'launchApp': {
      if (arg !== null && !isObject(arg)) refuse('launchApp takes a map');
      const options = isObject(arg) ? arg : {};
      onlyKeys(options, ['stopApp', 'clearState']);
      for (const key of ['stopApp', 'clearState']) {
        if (key in options && typeof options[key] !== 'boolean') refuse(`${key} must be a boolean`);
      }
      const stopApp = options.stopApp !== false;
      const clearState = options.clearState === true;
      return step(
        { op: name, stopApp, clearState },
        stopApp || clearState ? 'lifecycle' : 'native',
        LAUNCH_BUDGET_MS,
      );
    }
    case 'tapOn':
    case 'doubleTapOn':
    case 'longPressOn': {
      const target = selector(arg, true);
      return step(
        { op: name, selector: target.selector },
        'native',
        lookup(target.optional),
        target.optional,
      );
    }
    case 'assertVisible':
    case 'assertNotVisible': {
      const target = selector(arg, true);
      const budget = name === 'assertVisible' ? lookup(target.optional) : OPTIONAL_LOOKUP_BUDGET_MS;
      return step(
        { op: name, selector: target.selector },
        readDomain(target.selector, name === 'assertNotVisible'),
        budget,
        target.optional,
      );
    }
    case 'extendedWaitUntil': {
      if (!isObject(arg)) return refuse('extendedWaitUntil takes a map');
      onlyKeys(arg, ['visible', 'notVisible', 'timeout']);
      if ('visible' in arg === 'notVisible' in arg)
        refuse('needs exactly one of visible or notVisible');
      const visible = 'visible' in arg;
      const target = selector(visible ? arg.visible : arg.notVisible).selector;
      const budget = integer(
        arg.timeout,
        'timeout',
        visible ? LOOKUP_BUDGET_MS : OPTIONAL_LOOKUP_BUDGET_MS,
        1,
      );
      return step(
        { op: visible ? 'assertVisible' : 'assertNotVisible', selector: target },
        readDomain(target, !visible),
        budget,
      );
    }
    case 'inputText':
      if (isObject(arg) && 'input' in arg) refuse('named inputs require qaren check or pr');
      return step(
        { op: name, text: resolve(arg, 'inputText') },
        'native',
        NATIVE_DISPATCH_BUDGET_MS,
      );
    case 'eraseText': {
      const raw = isObject(arg)
        ? (onlyKeys(arg, ['charactersToErase']), arg.charactersToErase)
        : (arg ?? undefined);
      return step(
        { op: name, characters: integer(raw, 'charactersToErase', DEFAULT_ERASE_CHARACTERS) },
        'native',
        NATIVE_DISPATCH_BUDGET_MS,
      );
    }
    case 'hideKeyboard':
      noArgument();
      return step({ op: name, fallbackDomain: 'react-tree' }, 'native', NATIVE_DISPATCH_BUDGET_MS);
    case 'back':
    case 'scroll':
      noArgument();
      return step({ op: name }, 'native', NATIVE_DISPATCH_BUDGET_MS);
    case 'pressKey': {
      const key = typeof arg === 'string' ? arg.toLowerCase() : '';
      if (key !== 'enter' && key !== 'back') refuse('pressKey supports Enter and Back');
      return step(
        { op: name, key: key === 'enter' ? 'Enter' : 'Back' },
        'native',
        NATIVE_DISPATCH_BUDGET_MS,
      );
    }
    case 'swipeUp':
    case 'swipeDown':
    case 'swipeLeft':
    case 'swipeRight':
      noArgument();
      return step(
        { op: 'swipe', direction: SWIPE_SHORTHANDS[name], durationMs: DEFAULT_SWIPE_DURATION_MS },
        'native',
        NATIVE_DISPATCH_BUDGET_MS + DEFAULT_SWIPE_DURATION_MS,
      );
    case 'swipe': {
      if (!isObject(arg)) return refuse('swipe takes a map');
      onlyKeys(arg, ['direction', 'from', 'duration']);
      if (arg.direction === undefined) refuse('swipe needs a direction');
      const from = arg.from === undefined ? undefined : selector(arg.from).selector;
      const durationMs = integer(arg.duration, 'duration', DEFAULT_SWIPE_DURATION_MS);
      return step(
        {
          op: name,
          direction: direction(arg.direction, 'DOWN'),
          ...(from ? { from } : {}),
          durationMs,
        },
        'native',
        (from ? LOOKUP_BUDGET_MS : NATIVE_DISPATCH_BUDGET_MS) + durationMs,
      );
    }
    case 'scrollUntilVisible': {
      if (!isObject(arg)) return refuse('scrollUntilVisible takes a map');
      onlyKeys(arg, ['element', 'direction', 'timeout']);
      if (arg.element === undefined) refuse('scrollUntilVisible needs an element');
      return step(
        {
          op: name,
          selector: selector(arg.element).selector,
          direction: direction(arg.direction, 'DOWN'),
        },
        'native',
        integer(arg.timeout, 'timeout', SCROLL_UNTIL_VISIBLE_BUDGET_MS, 1),
      );
    }
    case 'waitForAnimationToEnd': {
      if (arg !== null && !isObject(arg)) refuse('waitForAnimationToEnd takes a map');
      const options = isObject(arg) ? arg : {};
      onlyKeys(options, ['timeout']);
      return step(
        { op: name },
        'native',
        Math.min(integer(options.timeout, 'timeout', SETTLE_CAP_MS, 1), SETTLE_CAP_MS),
      );
    }
    case 'takeScreenshot': {
      const raw = isObject(arg) ? (onlyKeys(arg, ['path']), arg.path) : arg;
      return step(
        { op: name, name: resolve(raw, 'takeScreenshot') },
        'native',
        NATIVE_DISPATCH_BUDGET_MS,
      );
    }
    case 'openLink': {
      const raw = isObject(arg) ? (onlyKeys(arg, ['link']), arg.link) : arg;
      return step({ op: name, link: resolve(raw, 'openLink') }, 'lifecycle', LAUNCH_BUDGET_MS);
    }
    case 'stopApp':
    case 'killApp':
      noArgument();
      return step({ op: name }, 'lifecycle', TERMINATE_BUDGET_MS);
    case 'clearState':
      noArgument();
      return step({ op: name }, 'lifecycle', LAUNCH_BUDGET_MS);
    case 'runFlow': {
      const steps = compileRunFlow(arg, node, lines, context, {
        refuse,
        onlyKeys,
        selector,
        readDomain,
        step,
      });
      validate();
      return steps;
    }
    default:
      return refuse('not in rn-flow@1');
  }
}

interface RunFlowTools {
  refuse: (reason: string) => never;
  onlyKeys: (object: Record<string, unknown>, allowed: string[], label?: string) => void;
  selector: (raw: unknown) => { selector: Selector };
  readDomain: (target: Selector, absence: boolean) => Domain;
  step: (fields: Record<string, unknown>, domain: Domain, budgetMs: number) => Step[];
}

function compileRunFlow(
  arg: unknown,
  node: unknown,
  lines: LineCounter,
  context: Context,
  tools: RunFlowTools,
): Step[] {
  const { refuse, onlyKeys, selector, readDomain, step } = tools;
  const options = typeof arg === 'string' ? { file: arg } : arg;
  if (!isObject(options)) return refuse('runFlow takes a file or a map');
  onlyKeys(options, ['file', 'when', 'commands']);
  if ('file' in options === 'commands' in options) refuse('needs exactly one of file or commands');
  if ('file' in options && typeof options.file !== 'string') refuse('runFlow.file must be a path');
  if ('commands' in options && !Array.isArray(options.commands)) {
    refuse('runFlow.commands must be a list');
  }
  if (context.depth >= MAX_RUN_FLOW_DEPTH) {
    refuse(`runFlow nesting exceeds ${MAX_RUN_FLOW_DEPTH} levels`);
  }

  let when: { visible: Selector } | { notVisible: Selector } | undefined;
  if (options.when !== undefined) {
    if (!isObject(options.when)) return refuse('runFlow.when takes a map');
    onlyKeys(options.when, ['visible', 'notVisible'], 'runFlow.when');
    if ('visible' in options.when === 'notVisible' in options.when) {
      refuse('runFlow.when needs exactly one of visible or notVisible');
    }
    when =
      'visible' in options.when
        ? { visible: selector(options.when.visible).selector }
        : { notVisible: selector(options.when.notVisible).selector };
  }
  const conditional = when
    ? step(
        { op: 'runFlow', when },
        'visible' in when ? readDomain(when.visible, false) : readDomain(when.notVisible, true),
        0,
      )[0]!
    : undefined;

  let steps: Step[];
  if (typeof options.file === 'string') {
    let target: string;
    let text: string;
    try {
      target = resolveRunFlowTarget(options.file, { flowDir: context.dir, flowRoot: context.root });
      text = context.read(target);
    } catch (error) {
      return refuse((error as Error).message);
    }
    const file = relative(context.root, target);
    const body = readBody(text, file);
    if (body.hasAppIdHeader) refuse('sub-flow appId header is not allowed');
    steps = compileCommands(body, {
      ...context,
      depth: context.depth + 1,
      dir: dirname(target),
      file,
    });
  } else {
    const commands = isMap(node) ? node.getIn(['runFlow', 'commands'], true) : undefined;
    steps = compileCommands(
      {
        values: options.commands as unknown[],
        nodes: isSeq(commands) ? commands.items : [],
        lines,
        hasAppIdHeader: false,
      },
      { ...context, depth: context.depth + 1 },
    );
  }
  if (!conditional) return steps;
  return [{ ...conditional, steps } as Step];
}
