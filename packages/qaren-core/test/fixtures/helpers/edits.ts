import type { EditList } from '../../unit/helpers/program-edits.ts';

// Check C: the edits that turn the base fixture's program (baseline.txt) into
// the current one, with the runtime fragment standing at its marker.
export const RUNTIME_ALIASES = [
  'qaData',
  'descriptorValue',
  'QA_POINTER_EVENTS',
  'qaStyleFact',
  'qaHostType',
  'imageSourcePlaceholderFacts',
  'HOST_KIND_LOOKUP',
  'isHostFiber',
  'hostKind',
];

export const DECLARED_EDITS: EditList = {
  removals: [
    { name: 'descriptorValue' },
    { name: 'qaData' },
    { name: 'QA_POINTER_EVENTS', keepComment: true },
    { name: 'qaStyleFact' },
    { name: 'qaHostType' },
    { name: 'imageSourcePlaceholderFacts' },
    { name: 'HOST_KIND_NAMES' },
    { name: 'HOST_KIND_LOOKUP' },
    { name: 'isHostFiber' },
    { name: 'hostKind' },
  ],
  replacements: [
    { from: '__HELPERS_VERSION__ = 107;', to: '__HELPERS_VERSION__ = 108;', count: 1 },
  ],
  insertion: {
    after: '  if (globalThis.__QAREN) delete globalThis.__QAREN;\n',
    text:
      '\n  // Typed modules from src/runtime, compiled here by scripts/build-injected-helpers.ts.\n' +
      '  var __rt;\n' +
      '@@QAREN_RUNTIME@@\n' +
      RUNTIME_ALIASES.map((name) => `  var ${name} = __rt.${name};\n`).join(''),
  },
};
