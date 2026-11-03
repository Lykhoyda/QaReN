// "On this page" entries read from a page's Markdown source at build time.
import GithubSlugger from 'github-slugger';

export type TocEntry = { depth: 2 | 3; text: string; id: string };

/** Heading text as rehype-slug sees it: inline code kept, link targets, emphasis and escapes dropped. */
function plainText(markdown: string): string {
  // Odd segments are code spans and stay verbatim.
  return markdown
    .split(/`([^`]*)`/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/<[^>]+>/g, '')
            .replace(/(\*\*|__|\*|_)(\S.*?)\1/g, '$2')
            .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1'),
    )
    .join('')
    .trim();
}

/** h2 and h3 headings outside code fences, with the ids rehype-slug gives them. */
export function tableOfContents(source: string): TocEntry[] {
  const slugger = new GithubSlugger();
  const entries: TocEntry[] = [];
  let fenced = false;
  for (const line of source.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const text = plainText(heading[2]);
    // rehype-slug numbers repeated headings across every level, so slug them all in order.
    const id = slugger.slug(text);
    const depth = heading[1].length;
    if (depth === 2 || depth === 3) entries.push({ depth, text, id });
  }
  return entries;
}
