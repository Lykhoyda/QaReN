import type { ButtonProps } from '../types';
import { cx } from './shared';

export function Button({
  variant,
  size,
  href,
  type,
  disabled,
  onClick,
  children,
  className,
}: ButtonProps) {
  const cls = cx(
    'qr-btn',
    `qr-btn--${variant || 'secondary'}`,
    size === 'sm' ? 'qr-btn--sm' : null,
    className,
  );
  if (href) {
    return (
      <a className={cls} href={href}>
        {children}
      </a>
    );
  }
  return (
    <button className={cls} type={type || 'button'} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
