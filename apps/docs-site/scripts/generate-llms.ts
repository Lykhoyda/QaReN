// Writes public/llms.txt, llms-full.txt and llms-small.txt from the MDX sources in sidebar order.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BASE_PATH,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN,
  pages,
  type Page,
} from '../src/site.ts';

const HERE = import.meta.dirname;
const CONTENT = resolve(HERE, '../src/content/docs');
const PUBLIC = resolve(HERE, '../public');
const SITE = `${SITE_ORIGIN}${BASE_PATH}`;

/** Markdown body without frontmatter, ESM lines or JSX tags; fenced code is kept verbatim. */
export function plainMarkdown(source: string): string {
  let fenced = false;
  return source
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split('\n')
    .flatMap((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced || /^\s*(```|~~~)/.test(line)) return [line];
      if (
        /^(import\s.*\sfrom\s|import\s+['"]|export\s+(const|let|function|default|async|\{|\*))/.test(
          line,
        )
      )
        return [];
      const text = line.replace(
        /(`+).*?\1|<\/?[A-Z][\w.]*(?:\s[^<>]*)?\/?>/g,
        (match, backticks) => (backticks ? match : ''),
      );
      return text.trim() === '' && line.trim() !== '' ? [] : [text];
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function section(page: Page): string {
  const body = plainMarkdown(readFileSync(resolve(CONTENT, page.file), 'utf8'));
  return `# ${page.title}\n\n> ${page.description}\n\n${body}\n`;
}

function bundle(kind: 'full' | 'abridged', list: Page[]): string {
  return `<SYSTEM>This is the ${kind} developer documentation for ${SITE_NAME}</SYSTEM>\n\n${list.map(section).join('\n')}`;
}

if (import.meta.main) {
  writeFileSync(
    resolve(PUBLIC, 'llms.txt'),
    `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

## Documentation Sets

- [Abridged documentation](${SITE}/llms-small.txt): a compact version of the documentation for ${SITE_NAME}, without the changelog
- [Complete documentation](${SITE}/llms-full.txt): the full documentation for ${SITE_NAME}

## Pages

${pages.map((page) => `- [${page.title}](${SITE}/${page.slug ? `${page.slug}/` : ''}): ${page.description}`).join('\n')}
`,
  );
  writeFileSync(resolve(PUBLIC, 'llms-full.txt'), bundle('full', pages));
  writeFileSync(
    resolve(PUBLIC, 'llms-small.txt'),
    bundle(
      'abridged',
      pages.filter((page) => page.slug !== 'changelog'),
    ),
  );
  console.log('generate-llms: wrote llms.txt, llms-full.txt, llms-small.txt');
}
