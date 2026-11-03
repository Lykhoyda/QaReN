import { expect, test } from 'bun:test';
import { AGENT_PROMPT } from '../src/agent-prompt.ts';
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

test('plainMarkdown preserves inline code while stripping surrounding JSX', () => {
  const source = [
    '<Card>Set `QAREN_INPUT_<NAME>`.</Card>',
    'Run `qaren doctor --device <UUID>` with `prebuilt v<X>`.',
    '<Card>Use ``<Kept value={`example`} />``.</Card>',
    '<Card>Use ```<Kept />```.</Card>',
  ].join('\n');

  expect(plainMarkdown(source)).toBe(
    [
      'Set `QAREN_INPUT_<NAME>`.',
      'Run `qaren doctor --device <UUID>` with `prebuilt v<X>`.',
      'Use ``<Kept value={`example`} />``.',
      'Use ```<Kept />```.',
    ].join('\n'),
  );
});

test('plainMarkdown writes the setup prompt in place of its component', () => {
  const out = plainMarkdown(
    ['Copy this prompt:', '', '<AgentPrompt />', '', 'Then run it.'].join('\n'),
  );

  expect(out).toContain('```text\nSet up QaReN in this app');
  expect(out).toContain(`${AGENT_PROMPT}\n\`\`\``);
  expect(out).not.toContain('<AgentPrompt');
});
