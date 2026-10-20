import { validInputName } from './inputs.js';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import yaml from 'yaml';
import {
  captureOwnedActionWriteContext,
  ownedActionPathIdentityMatches,
  splitYaml,
  resolveActionPath,
} from '../domain/action-store.js';
import { parseM7Header, serializeM7Header } from '../domain/reusable-action.js';
import { atomicWriter } from '../domain/atomic-writer.js';
import type { Block, Item } from './plan.js';
import { normalizedSlug, parseStep } from './plan.js';
import type { LedgerRow, Selector } from './ledger.js';
import { type PrivateSet, matchPrivate, planLineBody, projectPlanLine } from './privacy.js';

export type BlockPlatform = 'ios' | 'android';

export interface StoredStep {
  raw: string;
  kind: Item['kind'];
  selector?: Selector;
  text?: string;
  input?: string;
  sensitivity?: 'non-secret';
  direction?: 'down' | 'up';
  until?: Selector;
  action?: 'accept' | 'dismiss';
}

export interface StoredBlock {
  header: { appId: string; plan: string; planHash: string; platform: BlockPlatform };
  steps: StoredStep[];
}

export class BlockWriteError extends Error {
  constructor(
    readonly code: 'BLOCK_SLUG_COLLISION' | 'BLOCK_WRITE_REFUSED',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const quote = (value: string): string =>
  yaml.stringify(value, { defaultStringType: 'QUOTE_DOUBLE', lineWidth: 0 }).trimEnd();

const selectorYaml = (selector: Selector): string =>
  selector.id !== undefined
    ? `{ id: ${quote(selector.id)} }`
    : `{ text: ${quote(selector.text!)} }`;

function commandsFor(item: Item, selector: Selector | undefined, platform: BlockPlatform) {
  switch (item.kind) {
    case 'press':
      return [`- tapOn: ${selectorYaml(selector!)}`];
    case 'fill':
      return [
        `- tapOn: ${selectorYaml(selector!)}`,
        `- inputText: ${item.input !== undefined ? `{ input: ${quote(item.input)}${item.sensitivity ? ', sensitivity: "non-secret"' : ''} }` : quote(item.text)}`,
      ];
    case 'scroll':
      if (item.until)
        return [
          `- scrollUntilVisible: { element: ${selectorYaml(selector!)}, direction: ${item.direction === 'up' ? 'UP' : 'DOWN'} }`,
        ];
      return [item.direction === 'up' ? '- swipe: { direction: DOWN }' : '- scroll'];
    case 'wait':
      return [`- extendedWaitUntil: { visible: ${selectorYaml(selector!)}, timeout: 15000 }`];
    case 'back':
      return [platform === 'android' ? '- back' : '# qaren: back'];
    case 'dialog':
      return [`# qaren: dialog ${item.action}`];
    case 'echo':
      return [`# qaren: echo ${item.input}`];
    case 'check':
      return item.literal ? [`- assertVisible: { text: ${quote(item.text)} }`] : [];
  }
}

const needsSelector = (item: Item): boolean =>
  item.kind === 'press' ||
  item.kind === 'fill' ||
  item.kind === 'wait' ||
  (item.kind === 'scroll' && item.until !== undefined);

export function serializeBlock(
  block: Block,
  rows: readonly Pick<LedgerRow, 'block' | 'line' | 'outcome' | 'selector'>[],
  meta: { appId: string; platform: BlockPlatform },
  privateSet: PrivateSet = { values: [] },
): { yaml: string } | { unsavable: string } {
  const protectedContent = (texts: string[]): boolean =>
    texts.some((text) => matchPrivate(text, privateSet, 'persisted').hit);
  const withheld = { unsavable: 'contains a protected plan-typed value' };
  if (protectedContent([meta.appId, block.slug, block.title])) return withheld;
  const lines = [
    yaml.stringify({ appId: meta.appId }, { lineWidth: 0 }).trimEnd(),
    '---',
    serializeM7Header({ id: block.slug, intent: block.title, status: 'active', appId: meta.appId }),
    `# plan: ${block.slug}`,
    `# planHash: ${block.planHash}`,
    `# platform: ${meta.platform}`,
    '',
  ];
  for (const item of block.items) {
    let selector: Selector | undefined;
    if (needsSelector(item)) {
      const passed = rows.filter(
        (row) => row.block === block.slug && row.line === item.line && row.outcome === 'pass',
      );
      selector = passed[passed.length - 1]?.selector;
      if (!selector)
        return {
          unsavable:
            item.kind === 'wait' || item.kind === 'scroll'
              ? `line ${item.line}: the visible target has no testID or label to store`
              : `line ${item.line}: element has no testID or label`,
        };
    }
    if (
      projectPlanLine(item.raw, privateSet, 'persisted').hit ||
      protectedContent([
        ...(item.kind === 'fill'
          ? [item.input ?? item.text]
          : item.kind === 'echo'
            ? [item.input]
            : item.kind === 'check' && item.literal
              ? [item.text]
              : []),
        selector?.id ?? selector?.text ?? '',
      ])
    )
      return withheld;
    lines.push(`# ${item.raw}`, ...commandsFor(item, selector, meta.platform));
  }
  const serialized = `${lines.join('\n')}\n`;
  const admission = lines
    .map((line) => (line.startsWith('# ') ? `# ${planLineBody(line.slice(2))}` : line))
    .join('\n');
  return matchPrivate(admission, { values: privateSet.values }, 'persisted').hit
    ? withheld
    : { yaml: serialized };
}

function selectorFrom(value: unknown): Selector | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'id' && typeof record.id === 'string') return { id: record.id };
  if (keys[0] === 'text' && typeof record.text === 'string') return { text: record.text };
  return undefined;
}

type Command = Record<string, unknown> | string;

function parseCommand(line: string): Command | undefined {
  let parsed: unknown;
  try {
    parsed = yaml.parse(line);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
  const command = parsed[0] as unknown;
  if (typeof command === 'string') return command;
  if (!command || typeof command !== 'object' || Object.keys(command).length !== 1)
    return undefined;
  return command as Record<string, unknown>;
}

function only(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, i) => key === [...keys].sort()[i])
    ? (value as Record<string, unknown>)
    : undefined;
}

// Map one item's commands back onto a stored step; anything not written by serializeBlock is invalid.
function storedStep(raw: string, commands: Command[]): StoredStep | undefined {
  const [first, second] = commands;
  const map = (command: Command | undefined, key: string): unknown =>
    command && typeof command === 'object' && key in command ? command[key] : undefined;
  const declared = parseStep(planLineBody(raw));
  const echo =
    declared && !('refuse' in declared) && declared.kind === 'echo' ? declared : undefined;
  if (commands.length === 0) return echo ? undefined : { raw, kind: 'check' };
  if (commands.length === 1 && typeof first === 'string' && first.startsWith('#echo '))
    return echo?.input === first.slice(6) ? { raw, kind: 'echo', input: echo.input } : undefined;
  if (commands.length === 1 && first === 'scroll')
    return { raw, kind: 'scroll', direction: 'down' };
  if (commands.length === 1 && first === 'back') return { raw, kind: 'back' };
  if (commands.length === 1 && first === '#back') return { raw, kind: 'back' };
  if (commands.length === 1 && (first === '#dialog accept' || first === '#dialog dismiss'))
    return { raw, kind: 'dialog', action: first === '#dialog accept' ? 'accept' : 'dismiss' };
  const tap = selectorFrom(map(first, 'tapOn'));
  if (commands.length === 1 && tap) return { raw, kind: 'press', selector: tap };
  const typed = map(second, 'inputText');
  if (
    commands.length === 2 &&
    tap &&
    typeof typed === 'string' &&
    !(
      declared &&
      !('refuse' in declared) &&
      declared.kind === 'fill' &&
      declared.input !== undefined
    )
  )
    return { raw, kind: 'fill', selector: tap, text: typed };
  const slot = only(typed, ['input']) ?? only(typed, ['input', 'sensitivity']);
  if (commands.length === 2 && tap && validInputName(slot?.input)) {
    const declared = parseStep(planLineBody(raw));
    if (
      !declared ||
      'refuse' in declared ||
      declared.kind !== 'fill' ||
      declared.input !== slot.input ||
      (slot.sensitivity !== undefined && slot.sensitivity !== 'non-secret') ||
      declared.sensitivity !== slot.sensitivity
    )
      return undefined;
    return {
      raw,
      kind: 'fill',
      selector: tap,
      input: slot.input,
      ...(declared.sensitivity ? { sensitivity: declared.sensitivity } : {}),
    };
  }
  if (commands.length !== 1) return undefined;
  const swipe = only(map(first, 'swipe'), ['direction']);
  if (swipe?.direction === 'DOWN') return { raw, kind: 'scroll', direction: 'up' };
  const until = only(map(first, 'scrollUntilVisible'), ['element', 'direction']);
  const untilSelector = selectorFrom(until?.element);
  if (untilSelector && (until!.direction === 'DOWN' || until!.direction === 'UP'))
    return {
      raw,
      kind: 'scroll',
      direction: until!.direction === 'UP' ? 'up' : 'down',
      until: untilSelector,
    };
  const wait = only(map(first, 'extendedWaitUntil'), ['visible', 'timeout']);
  const waitSelector = selectorFrom(wait?.visible);
  if (waitSelector && wait!.timeout === 15000) return { raw, kind: 'wait', selector: waitSelector };
  const assert = selectorFrom(map(first, 'assertVisible'));
  if (assert?.text !== undefined) return { raw, kind: 'check', text: assert.text };
  return undefined;
}

export function readBlock(text: string): StoredBlock | { invalid: string } {
  const { topSection, headerLines, bodyLines } = splitYaml(text);
  const rest = [...headerLines, ...bodyLines];
  const blank = rest.findIndex((line) => !line.trim());
  if (blank < 0) return { invalid: 'the header is not followed by a blank line' };
  let top: unknown;
  try {
    top = yaml.parse(topSection);
  } catch {
    return { invalid: 'the appId section is not valid YAML' };
  }
  const header = parseM7Header(rest.slice(0, blank).join('\n'));
  const appId = only(top, ['appId'])?.appId;
  if (
    typeof appId !== 'string' ||
    !header?.plan ||
    !header.planHash ||
    (header.platform !== 'ios' && header.platform !== 'android')
  )
    return { invalid: 'the header does not name an appId, plan, planHash and platform' };
  const steps: StoredStep[] = [];
  let open: { raw: string; commands: Command[] } | undefined;
  const close = (): boolean => {
    if (!open) return true;
    const step = storedStep(open.raw, open.commands);
    if (!step) return false;
    steps.push(step);
    return true;
  };
  for (const line of rest.slice(blank + 1)) {
    if (!line.trim()) continue;
    const marker = /^# qaren: (back|dialog (?:accept|dismiss)|echo [A-Z][A-Z0-9_]{0,31})$/.exec(
      line,
    );
    if (marker && open) {
      open.commands.push(`#${marker[1]}`);
      continue;
    }
    if (line.startsWith('# ')) {
      if (!close()) return { invalid: `the commands under "${open!.raw}" are not canonical` };
      open = { raw: line.slice(2), commands: [] };
      continue;
    }
    const command = line.startsWith('- ') && open ? parseCommand(line) : undefined;
    if (!command) return { invalid: `unexpected line: ${line.slice(0, 80)}` };
    open!.commands.push(command);
  }
  if (!close()) return { invalid: `the commands under "${open!.raw}" are not canonical` };
  return {
    header: {
      appId,
      plan: header.plan,
      planHash: header.planHash,
      platform: header.platform,
    },
    steps,
  };
}

// A replay needs one stored step per plan item, in order, of the same kind.
export function storedMatches(block: Block, stored: StoredBlock): boolean {
  return (
    stored.steps.length === block.items.length &&
    block.items.every((item, i) => {
      const step = stored.steps[i];
      if (step.raw !== item.raw || step.kind !== item.kind) return false;
      if (item.kind === 'check') return item.literal ? step.text === item.text : !step.text;
      if (item.kind === 'fill')
        return (
          step.text === item.text &&
          step.input === item.input &&
          step.sensitivity === item.sensitivity
        );
      if (item.kind === 'scroll')
        return step.direction === item.direction && !!step.until === !!item.until;
      if (item.kind === 'dialog') return step.action === item.action;
      if (item.kind === 'echo') return step.input === item.input;
      return true;
    })
  );
}

// Reads the saved block without following a symlink at the file itself.
function readOwnedFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new BlockWriteError('BLOCK_WRITE_REFUSED', `${path} is a symlink`);
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile())
      throw new BlockWriteError('BLOCK_WRITE_REFUSED', `${path} is not a regular file`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function loadBlock(appRoot: string, slug: string): string | null {
  const path = resolveActionPath(appRoot, slug);
  return path ? readOwnedFile(path) : null;
}

// Replay only a block exactly as serializeBlock writes it, so a patch rewrites nothing before line k.
export function storedFits(
  block: Block,
  stored: StoredBlock,
  text: string,
  meta: { appId: string; platform: BlockPlatform },
): boolean {
  if (!storedMatches(block, stored)) return false;
  const rows: LedgerRow[] = block.items.map((item, i) => {
    const selector = stored.steps[i].selector ?? stored.steps[i].until;
    return {
      block: block.slug,
      line: item.line,
      text: item.raw,
      attempt: 1,
      kind: item.kind === 'check' ? 'check' : 'step',
      resolvedBy: 'exact',
      t: 0,
      outcome: 'pass',
      ...(selector ? { selector } : {}),
    };
  });
  const again = serializeBlock(block, rows, meta);
  return 'yaml' in again && again.yaml === text;
}

export function writeBlock(appRoot: string, slug: string, text: string): 'written' | 'unchanged' {
  const { filePath: canonicalPath, identity } = captureOwnedActionWriteContext(appRoot, slug);
  const owned = (): void => {
    if (!ownedActionPathIdentityMatches(identity))
      throw new BlockWriteError(
        'BLOCK_WRITE_REFUSED',
        `${dirname(canonicalPath)} changed during the write`,
      );
  };
  return atomicWriter.withLock(canonicalPath, () => {
    owned();
    const path = resolveActionPath(appRoot, slug) ?? canonicalPath;
    const existing = readOwnedFile(path);
    if (existing === text) return 'unchanged';
    const previous = existing !== null ? parseM7Header(existing) : null;
    const incoming = parseM7Header(text);
    if (
      existing !== null &&
      (previous?.plan !== slug ||
        !incoming ||
        normalizedSlug(previous.intent) !== normalizedSlug(incoming.intent))
    )
      throw new BlockWriteError(
        'BLOCK_SLUG_COLLISION',
        `${path} already holds an action that is not this plan block`,
      );
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      const fd = openSync(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      owned();
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    return 'written';
  });
}
