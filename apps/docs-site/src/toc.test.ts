import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocsPage } from './components/DocsPage.tsx';
import { tableOfContents } from './toc.ts';

test('TOC labels render tag-shaped input as text rather than HTML elements', () => {
  const label = '<script>alert(1)</script> <scr<script>ipt> `code <tag>`';
  const toc = tableOfContents(`## ${label}`);
  expect(toc[0].text).toBe('<script>alert(1)</script> <scr<script>ipt> code <tag>');

  // The HTML serialization contract requires angle brackets in text nodes to be escaped.
  const html = renderToStaticMarkup(createElement(DocsPage, { title: 'Test', toc }));
  expect(html).toContain(
    '&lt;script&gt;alert(1)&lt;/script&gt; &lt;scr&lt;script&gt;ipt&gt; code &lt;tag&gt;</a>',
  );
  expect(html).not.toContain('<script>');
});

// Expected ids follow GitHub's anchor rules, which rehype-slug implements; the build's
// verify-site check proves them against the rendered pages.
test('tableOfContents lists h2 and h3 outside fences with GitHub-style ids', () => {
  const source = [
    '---',
    'title: x',
    '---',
    '## What `/qaren:setup` does',
    '### Install from **source**',
    '```md',
    '## not a heading',
    '```',
    '#### Deep',
    '## Runtime [inputs](../plans/)',
    '## Patch Changes',
    '## Patch Changes',
  ].join('\n');

  expect(tableOfContents(source)).toEqual([
    { depth: 2, text: 'What /qaren:setup does', id: 'what-qarensetup-does' },
    { depth: 3, text: 'Install from source', id: 'install-from-source' },
    { depth: 2, text: 'Runtime inputs', id: 'runtime-inputs' },
    { depth: 2, text: 'Patch Changes', id: 'patch-changes' },
    { depth: 2, text: 'Patch Changes', id: 'patch-changes-1' },
  ]);
});

test('tableOfContents keeps h2 and h3 entries on pages with more than 40 headings', () => {
  const source = Array.from({ length: 21 }, (_, i) => `## v${i}\n### Patch Changes`).join('\n');

  const toc = tableOfContents(source);
  expect(toc).toHaveLength(42);
  expect(toc.filter((entry) => entry.depth === 2)).toHaveLength(21);
  expect(toc.filter((entry) => entry.depth === 3)).toHaveLength(21);
  expect(toc[1]).toEqual({ depth: 3, text: 'Patch Changes', id: 'patch-changes' });
  expect(toc[2]).toEqual({ depth: 2, text: 'v1', id: 'v1' });
  expect(toc[41]).toEqual({ depth: 3, text: 'Patch Changes', id: 'patch-changes-20' });
});
