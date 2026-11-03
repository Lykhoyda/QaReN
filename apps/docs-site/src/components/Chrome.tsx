// Header, logo and footer from the "QaReN docs redesign" boards (Home and Docs page).
import { BASE_PATH, GITHUB_URL, pagePath } from '../site.ts';
import { Search } from './Search.tsx';
import { ThemeSwitch } from './ThemeSwitch.tsx';

const home = `${BASE_PATH}${pagePath('')}`;

function Logo({ size, docs = false }: { size: number; docs?: boolean }) {
  return (
    <a href={home} className="plain docs-logo" aria-label="QaReN docs home">
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="M19 27H10a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6h12a6 6 0 0 1 6 6v9"
          stroke="currentColor"
          strokeWidth="3"
        />
        <rect
          className="qr-cursor"
          x="22"
          y="22"
          width="6"
          height="7"
          rx="1"
          style={{ fill: 'var(--accent)' }}
        />
      </svg>
      <span className="docs-logo__name">QaReN</span>
      {docs ? <span className="docs-logo__docs">docs</span> : null}
    </a>
  );
}

export function DocsHeader() {
  return (
    <header className="docs-header">
      <nav aria-label="Main" className="docs-header__bar">
        <Logo size={26} docs />
        <Search />
        <span className="docs-header__spacer" />
        <ThemeSwitch />
        <a href={GITHUB_URL} className="plain docs-header__link">
          GitHub
        </a>
      </nav>
    </header>
  );
}

export function HomeHeader() {
  return (
    <header className="docs-header">
      <nav aria-label="Main" className="docs-header__bar docs-header__bar--home">
        <Logo size={28} />
        <div className="docs-header__links">
          <a href={`${BASE_PATH}${pagePath('getting-started')}`} className="plain">
            Docs
          </a>
          <a href="#get-started" className="plain">
            Getting started
          </a>
          <a href="#how-it-works" className="plain">
            How it works
          </a>
          <a href={`${BASE_PATH}${pagePath('changelog')}`} className="plain">
            Changelog
          </a>
        </div>
        <span className="docs-header__spacer" />
        <Search />
        <a href={GITHUB_URL} className="plain docs-header__link">
          GitHub
        </a>
      </nav>
    </header>
  );
}

export function SiteFooter({ wide = false }: { wide?: boolean }) {
  return (
    <footer className="docs-footer">
      <div className={wide ? 'docs-footer__bar docs-footer__bar--home' : 'docs-footer__bar'}>
        <span className="docs-footer__name">QaReN</span>
        <span>MIT licence</span>
        <span className="docs-header__spacer" />
        <a href={GITHUB_URL} className="plain">
          GitHub
        </a>
        {wide ? (
          <a href={`${BASE_PATH}${pagePath('changelog')}`} className="plain">
            Changelog
          </a>
        ) : null}
        <a href={`${BASE_PATH}/llms.txt`} className="plain">
          llms.txt
        </a>
      </div>
    </footer>
  );
}
