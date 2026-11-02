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
