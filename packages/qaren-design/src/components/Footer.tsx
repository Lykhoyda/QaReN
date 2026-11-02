import type { FooterProps } from '../types';
import { Wordmark } from './Wordmark';
import { cx } from './shared';

export function Footer({ note, links, className }: FooterProps) {
  return (
    <footer className={cx('qr-footer', className)}>
      <Wordmark />
      <span>{note || 'Open source under the MIT license.'}</span>
      <ul className="qr-footer__links">
        {(links ?? []).map((l, i) => (
          <li key={i}>
            <a className="qr-link qr-link--muted" href={l.href || '#'}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </footer>
  );
}
