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
      <a
        className={cls}
        href={disabled ? undefined : href}
        onClick={disabled ? undefined : onClick}
        aria-disabled={disabled || undefined}
        role={disabled ? 'link' : undefined}
        tabIndex={disabled ? -1 : undefined}
      >
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
