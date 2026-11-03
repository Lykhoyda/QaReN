import type { WordmarkProps } from '../types';
import { cx } from './shared';

export function Wordmark({ href, cursor, blink, size, className }: WordmarkProps) {
  const Tag = href ? 'a' : 'span';
  return (
    <Tag
      className={cx('qr-wordmark', className)}
      href={href}
      style={size ? { fontSize: size } : undefined}
      aria-label="QaReN"
    >
      QaReN
      {cursor ? (
        <span className={cx('qr-cursor', blink ? 'qr-cursor--blink' : null)} aria-hidden="true" />
      ) : null}
    </Tag>
  );
}
