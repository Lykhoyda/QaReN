import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { declarationSource } from '../../helpers/program-edits.ts';

type Fn = (...args: unknown[]) => unknown;

const baseline: { program: string } = JSON.parse(
  readFileSync(new URL('../../../fixtures/helpers/baseline.txt', import.meta.url), 'utf8'),
);

const NAMES = [
  'descriptorValue',
  'qaData',
  'QA_POINTER_EVENTS',
  'qaStyleFact',
  'qaHostType',
  'imageSourcePlaceholderFacts',
  'HOST_KIND_NAMES',
  'HOST_KIND_LOOKUP',
  'isHostFiber',
  'hostKind',
];

// The base revision's own declarations, evaluated in the main realm so their
// results compare with the typed modules' results directly.
export const base = new vm.Script(
  `(function() {\n${declarationSource(baseline.program, NAMES)}\nreturn { ${NAMES.join(', ')} };\n})()`,
).runInThisContext() as Record<string, Fn> & {
  QA_POINTER_EVENTS: string[];
  HOST_KIND_LOOKUP: Record<string, string>;
};

export type Outcome = { value: unknown } | { threw: string };

export function outcome(run: () => unknown): Outcome {
  try {
    return { value: run() };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}
