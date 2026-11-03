'use client';

// Search over the Pagefind index written after `next build`, drawn with the design tokens
// instead of Pagefind's default UI. `/` focuses the box; arrow keys walk the results.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BASE_PATH } from '../site.ts';

type Hit = { url: string; title: string; excerpt: string };
type Pagefind = {
  options: (options: { baseUrl: string }) => Promise<void>;
  debouncedSearch: (query: string) => Promise<{
    results: { data: () => Promise<{ url: string; excerpt: string; meta: { title?: string } }> }[];
  } | null>;
};

let pagefind: Promise<Pagefind> | undefined;
function loadPagefind(): Promise<Pagefind> {
  pagefind ??= import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ `${BASE_PATH}/pagefind/pagefind.js`
  ).then(async (module: Pagefind) => {
    await module.options({ baseUrl: `${BASE_PATH}/` });
    return module;
  });
  return pagefind;
}

export function Search() {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setStatus('');
      return;
    }
    let live = true;
    loadPagefind()
      .then((engine) => engine.debouncedSearch(query))
      .then(async (search) => {
        if (!search || !live) return;
        const data = await Promise.all(search.results.slice(0, 8).map((result) => result.data()));
        if (!live) return;
        setHits(
          data.map((item) => ({
            url: item.url,
            title: item.meta.title ?? item.url,
            excerpt: item.excerpt,
          })),
        );
        setStatus(data.length ? '' : 'No results');
      })
      .catch(() => live && setStatus('Search is available on the built site'));
    return () => {
      live = false;
    };
  }, [query]);

  const move = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...(list.current?.querySelectorAll('a') ?? [])];
    if (!links.length) return;
    event.preventDefault();
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
    if (next < 0) input.current?.focus();
    else links[Math.min(next, links.length - 1)].focus();
  };

  return (
    <div role="search" className="qr-search" onKeyDown={move}>
      <label className="qr-search__label" htmlFor="qr-search-input">
        Search docs
      </label>
      <div className="qr-search__box">
        <input
          id="qr-search-input"
          ref={input}
          className="qr-search__input"
          type="search"
          placeholder="Search docs"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <kbd className="qr-search__key" aria-hidden="true">
          /
        </kbd>
      </div>
      {query.trim() ? (
        <div className="qr-search__panel">
          <p className="qr-search__status" role="status">
            {status || `${hits.length} result${hits.length === 1 ? '' : 's'}`}
          </p>
          <ul ref={list} className="qr-search__results">
            {hits.map((hit) => (
              <li key={hit.url}>
                <a href={hit.url}>
                  <span className="qr-search__title">{hit.title}</span>
                  {/* Pagefind escapes page text and wraps matches in <mark>. */}
                  <span
                    className="qr-search__excerpt"
                    dangerouslySetInnerHTML={{ __html: hit.excerpt }}
                  />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
