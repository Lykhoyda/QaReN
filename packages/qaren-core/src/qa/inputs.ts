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

export class RunInputs {
  #values: ReadonlyMap<string, string>;
  #privacy: ObservedPrivacy;
  #refuse?: (reason: InputPrivacyRefusal) => void;
  #terminal?: InputPrivacyRefusal;

  constructor(value: unknown, required: readonly string[], privacy = new ObservedPrivacy()) {
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
    this.#privacy = privacy;
    privacy.classifyInputs([...this.#values.values()]);
  }

  names(): string[] {
    return [...this.#values.keys()].sort();
  }
  get hasInputs(): boolean {
    return this.#values.size > 0;
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
    if (this.#privacy.assertInputHashSafe(text)) return;
    this.#terminal = new InputPrivacyRefusal();
    this.#refuse?.(this.#terminal);
    throw this.#terminal;
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
