import type { DocsLayoutProps } from '../types';
import { Footer } from './Footer';
import { NavBar } from './NavBar';
import { cx } from './shared';

export function DocsLayout({ nav, groups, footer, children, className }: DocsLayoutProps) {
  return (
    <div className={cx('qr-root', 'qr-docs', className)} data-theme="light">
      <NavBar {...nav} />
      <div className="qr-docs__body">
        <nav className="qr-docs__side" aria-label="Docs">
          {groups.map((g, i) => (
            <div key={i} className="qr-docs__group">
              <p className="label qr-docs__group-label">{g.label}</p>
              <ul className="qr-docs__list">
                {g.items.map((l, j) => (
                  <li key={j}>
                    <a
                      className="qr-docs__link"
                      href={l.href || '#'}
                      aria-current={l.active ? 'page' : undefined}
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main className="qr-docs__main">{children}</main>
      </div>
      <Footer {...footer} />
    </div>
  );
}
