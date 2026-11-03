import { expect, test } from 'bun:test';
import { plainMarkdown } from './generate-llms.ts';

test('plainMarkdown drops frontmatter, ESM lines and JSX tags but keeps fenced code', () => {
  const source = [
    '---',
    'title: Getting started',
    '---',
    "import { Steps } from './steps';",
    '',
    '<Steps>',
    '1. Install the <Card title="plugin" /> plugin.',
    '</Steps>',
    '',
    '```tsx',
    "import { X } from 'y';",
    '<Kept />',
    '```',
  ].join('\n');

  expect(plainMarkdown(source)).toBe(
    ['1. Install the  plugin.', '', '```tsx', "import { X } from 'y';", '<Kept />', '```'].join(
      '\n',
    ),
  );
});

test('plainMarkdown keeps prose lines that start with the word import or export', () => {
  const source = [
    "export const meta = { title: 'x' };",
    'export identifiers through the same masking step.',
    'import paths stay relative.',
  ].join('\n');

  expect(plainMarkdown(source)).toBe(
    ['export identifiers through the same masking step.', 'import paths stay relative.'].join('\n'),
  );
});
