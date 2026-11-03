// The docs page from the "Docs page: Check a plan" board: sidebar, article, "On this page",
// previous/next cards and the edit link.
import type { ReactNode } from 'react';
import { BASE_PATH, GITHUB_URL, groupOf, groups, pagePath, pages, type Page } from '../site.ts';
import type { TocEntry } from '../toc.ts';
import { DocsHeader, SiteFooter } from './Chrome.tsx';

const href = (page: Page) => `${BASE_PATH}${pagePath(page.slug)}`;

function Sidebar({ current }: { current?: Page }) {
  return (
    <nav aria-label="Docs" className="docs-side">
      {groups.map((group) => (
        <div key={group.label} className="docs-side__group">
          <p className="docs-label">{group.label}</p>
          {group.pages.map((page) => (
            <a
              key={page.slug}
              href={href(page)}
              className={page.slug.startsWith('actions/') ? 'plain docs-side__mono' : 'plain'}
              aria-current={page === current ? 'page' : undefined}
            >
              {page.label}
            </a>
          ))}
          {(group.links ?? []).map((link) => (
            <a key={link.href} href={link.href} className="plain">
              {link.label}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

function Pager({ current }: { current: Page }) {
  const i = pages.indexOf(current);
  const prev = pages[i - 1];
  const next = pages[i + 1];
  return (
    <div className="docs-pager" data-pagefind-ignore>
      {prev ? (
        <a href={href(prev)} rel="prev" className="plain docs-card">
          <span className="docs-label">Previous</span>
          <span className="docs-card__title">{prev.label}</span>
        </a>
      ) : null}
      {next ? (
        <a href={href(next)} rel="next" className="plain docs-card docs-card--next">
          <span className="docs-label">Next</span>
          <span className="docs-card__title">{next.label}</span>
        </a>
      ) : null}
    </div>
  );
}

export function DocsPage({
  current,
  title,
  description,
  toc = [],
  searchable = true,
  children,
}: {
  current?: Page;
  title: string;
  description?: string;
  toc?: TocEntry[];
  /** False keeps the page out of the search index. */
  searchable?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="docs-root">
      <DocsHeader />
      <div className="docs-shell">
        {/* Phone width shows the same nav behind a disclosure; CSS displays only one of the two. */}
        <details className="docs-menu">
          <summary>Menu</summary>
          <Sidebar current={current} />
        </details>
        <aside className="docs-aside">
          <Sidebar current={current} />
        </aside>
        <main id="main" className="docs-content">
          <article className="docs-article" data-pagefind-body={searchable ? '' : undefined}>
            {current ? <p className="docs-label">{groupOf(current).label}</p> : null}
            <h1 className="docs-title">{title}</h1>
            {description ? <p className="docs-lead">{description}</p> : null}
            <div className="docs-prose">{children}</div>
            {current ? <Pager current={current} /> : null}
            {/* The changelog is generated, so it has no source to edit. */}
            {current && current.slug !== 'changelog' ? (
              <p className="docs-edit" data-pagefind-ignore>
                <a
                  href={`${GITHUB_URL}/edit/develop/apps/docs-site/src/content/docs/${current.file}`}
                >
                  Edit this page on GitHub
                </a>
              </p>
            ) : null}
          </article>
          {toc.length ? (
            <nav className="docs-toc" aria-label="On this page">
              <p className="docs-label">On this page</p>
              <a href="#main" className="plain">
                Overview
              </a>
              {toc.map((entry) => (
                <a
                  key={entry.id}
                  href={`#${entry.id}`}
                  className={entry.depth === 3 ? 'plain docs-toc__sub' : 'plain'}
                >
                  {entry.text}
                </a>
              ))}
            </nav>
          ) : null}
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
