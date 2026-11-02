import type { BadgeProps } from '../types';
import { cx } from './shared';

export function Badge({ tone, children, className }: BadgeProps) {
  return (
    <span
      className={cx('qr-badge', tone && tone !== 'neutral' ? `qr-badge--${tone}` : null, className)}
    >
      {children}
    </span>
  );
}
