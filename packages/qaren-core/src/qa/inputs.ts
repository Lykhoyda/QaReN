import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';
import { ObservedPrivacy, SHORT } from './privacy.js';

export const validInputName = (name: unknown): name is string =>
  typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(name);

export class InputPrivacyRefusal extends Error {
  readonly code = 'CORE_REFUSED';
  constructor() {
    super('runtime input privacy refused');
    this.name = 'AbortError';
  }
}

export const INPUT_ECHO_MARKER = '[runtime input]';

const echoes = new AsyncLocalStorage<Set<string>>();
export const withEchoScope = <T>(operation: () => T): T => echoes.run(new Set(), operation);
export const declareEcho = (name: string): void => {
  echoes.getStore()?.add(name);
};

export class RunInputs {
  #values: ReadonlyMap<string, string>;
  #filled = new Set<string>();
  #strict: Map<string, string>;
  #nonSecret: readonly string[];
  #privacy: ObservedPrivacy;
  #refuse?: (reason: InputPrivacyRefusal) => void;
  #terminal?: InputPrivacyRefusal;

  constructor(
    value: unknown,
    required: readonly string[],
    privacy = new ObservedPrivacy(),
    nonSecretInputs: readonly string[] = [],
  ) {
    const invalid = () => new Error('runtime inputs are invalid');
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      throw invalid();
    const entries = Object.entries(value);
    const names = [...new Set(required)].sort();
    if (
      names.length > 64 ||
      names.some((name) => !validInputName(name)) ||
      entries.length !== names.length
    )
      throw invalid();
    let bytes = 0;
    for (const [name, text] of entries) {
      if (!validInputName(name) || !names.includes(name) || typeof text !== 'string')
        throw invalid();
      const size = Buffer.byteLength(text, 'utf8');
      bytes += size;
      if (
        !size ||
        [...text.trim()].length < SHORT ||
        size > 4096 ||
        bytes > 65536 ||
        // eslint-disable-next-line no-control-regex -- Runtime inputs are single-line printable text.
        /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(text) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) ||
        /\$\{|\$\(|\{\{/.test(text)
      )
        throw invalid();
    }
    this.#values = new Map(entries as [string, string][]);
    if (nonSecretInputs.some((name) => !validInputName(name) || !names.includes(name)))
      throw invalid();
    this.#nonSecret = Object.freeze([...new Set(nonSecretInputs)].sort());
    this.#strict = new Map([...this.#values].filter(([name]) => !this.#nonSecret.includes(name)));
    this.#privacy = privacy;
    privacy.classifyInputs([...this.#values.values()], [...this.#strict.values()]);
  }

  names(): string[] {
    return [...this.#values.keys()].sort();
  }
  nonSecretNames(): readonly string[] {
    return this.#nonSecret;
  }
  protectFill(name: string, privateTarget = false): boolean {
    const value = this.#values.get(name);
    if (value === undefined) throw new Error('runtime inputs are invalid');
    if (privateTarget && !this.#strict.has(name)) {
      this.#strict.set(name, value);
      this.#privacy.classifyInputs([], [value]);
    }
    return (
      this.#strict.has(name) || !this.#privacy.assertInputHashSafe(value, this.#strict.values())
    );
  }
  get hasInputs(): boolean {
    return this.#values.size > 0;
  }
  get hasStrictInputs(): boolean {
    return this.#strict.size > 0;
  }
  get terminal(): InputPrivacyRefusal | undefined {
    return this.#terminal;
  }
  onRefusal(refuse: (reason: InputPrivacyRefusal) => void): void {
    this.#refuse = refuse;
  }
  textFor(fill: { text?: string; input?: string }): string {
    if (fill.input === undefined && typeof fill.text === 'string') return fill.text;
    const value = fill.input === undefined ? undefined : this.#values.get(fill.input);
    if (value === undefined || fill.text !== undefined)
      throw new Error('runtime inputs are invalid');
    return value;
  }
  redact(text: string): string {
    return this.#privacy.redact(text);
  }
  assertHashSafe(text: string): void {
    if (this.#terminal) throw this.#terminal;
    if (this.#privacy.assertInputHashSafe(text, [...this.#strict.values()])) return;
    this.#terminal = new InputPrivacyRefusal();
    this.#refuse?.(this.#terminal);
    throw this.#terminal;
  }
  expectEcho(identifier: string | undefined, inputName?: string): void {
    if (inputName !== undefined && !this.#strict.has(inputName)) return;
    if (identifier) this.#filled.add(identifier);
  }
  // Declared echoes hash as a constant; other labels must prove their redacted projection safe.
  maskFilledEcho<T extends { identifier?: string; label?: string }>(node: T): T {
    const label = node.label;
    if (label === undefined || this.#privacy.assertInputHashSafe(label, [...this.#strict.values()]))
      return node;
    const declared = echoes.getStore();
    const allowed =
      (node.identifier !== undefined && this.#filled.has(node.identifier)) ||
      [...this.#strict].every(
        ([name, value]) => declared?.has(name) || this.#privacy.assertInputHashSafe(label, [value]),
      );
    const masked = allowed ? INPUT_ECHO_MARKER : this.#privacy.redact(label);
    return this.#privacy.assertInputHashSafe(masked, [...this.#strict.values()])
      ? { ...node, label: masked }
      : node;
  }
  toJSON(): never {
    throw new Error('runtime inputs cannot be serialized');
  }
  [inspect.custom](): string {
    return '[runtime inputs]';
  }
}

const scope = new AsyncLocalStorage<RunInputs>();
export const withInputs = <T>(inputs: RunInputs, operation: () => T): T =>
  scope.run(inputs, operation);
export const currentInputs = (): RunInputs | undefined => scope.getStore();
export const maskFilledEcho = <T extends { identifier?: string; label?: string }>(node: T): T =>
  scope.getStore()?.maskFilledEcho(node) ?? node;
export function assertInputHashSafe(text: string): void {
  scope.getStore()?.assertHashSafe(text);
}

export function fillText(fill: { text?: string; input?: string }): string {
  const inputs = currentInputs();
  if (inputs) return inputs.textFor(fill);
  if (fill.input === undefined && typeof fill.text === 'string') return fill.text;
  throw new Error('CORE_REFUSED: runtime inputs are invalid');
}

export function throwIfInputPrivacyRefused(): void {
  const reason = currentInputs()?.terminal;
  if (reason) throw reason;
}
