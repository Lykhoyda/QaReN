import type { NavBarProps } from '../types';
import { Logo } from './Logo';
import { cx } from './shared';

export function NavBar({ links, homeHref, action, className }: NavBarProps) {
  return (
    <nav className={cx('qr-nav', className)} aria-label="Main">
      <a href={homeHref || '#'} className="qr-nav__home" aria-label="QaReN home">
        <Logo variant="lockup" size={26} />
      </a>
      <ul className="qr-nav__links">
        {(links ?? []).map((l, i) => (
          <li key={i}>
            <a
              className="qr-nav__link"
              href={l.href || '#'}
              aria-current={l.active ? 'page' : undefined}
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul>
      {action || null}
    </nav>
  );
}
