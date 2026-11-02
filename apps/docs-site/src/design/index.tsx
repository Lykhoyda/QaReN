// Local stub of the @qaren/design components the docs site uses, following the design
// system's index.d.ts prop contract. Swap the imports to @qaren/design once that package lands.
import type { ReactNode } from 'react';

export type NavLink = { label: string; href?: string; active?: boolean };

export function Wordmark({ href, cursor = false }: { href?: string; cursor?: boolean }) {
  const inner = <>QaReN{cursor ? <span className="qr-cursor" aria-hidden="true" /> : null}</>;
  return href ? (
    <a className="qr-wordmark" href={href}>
      {inner}
    </a>
  ) : (
    <span className="qr-wordmark">{inner}</span>
  );
}

export function NavBar({
  links,
  homeHref,
  action,
}: {
  links: NavLink[];
  homeHref?: string;
  action?: ReactNode;
}) {
  return (
    <header className="qr-nav">
      <span className="qr-nav__home" style={{ fontSize: 20 }}>
        <Wordmark href={homeHref} cursor />
      </span>
      <ul className="qr-nav__links">
        {links.map((link) => (
          <li key={link.label}>
            <a
              className="qr-nav__link"
              href={link.href}
              aria-current={link.active ? 'page' : undefined}
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
      {action}
    </header>
  );
}

export function Footer({ note, links = [] }: { note?: ReactNode; links?: NavLink[] }) {
  return (
    <footer className="qr-footer">
      <Wordmark />
      {note}
      <ul className="qr-footer__links">
        {links.map((link) => (
          <li key={link.label}>
            <a className="qr-link qr-link--muted" href={link.href}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </footer>
  );
}

export function Link({ href, children }: { href?: string; children: ReactNode }) {
  return (
    <a className="qr-link" href={href}>
      {children}
    </a>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="qr-code-inline">{children}</code>;
}
