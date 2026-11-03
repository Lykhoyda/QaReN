import type { LinkProps } from '../types';
import { cx } from './shared';

export function Link({ href, muted, children, className }: LinkProps) {
  return (
    <a className={cx('qr-link', muted ? 'qr-link--muted' : null, className)} href={href || '#'}>
      {children}
    </a>
  );
}
