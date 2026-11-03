import type { CardProps } from '../types';
import { cx } from './shared';

export function Card({ kicker, title, href, children, className }: CardProps) {
  const Tag = href ? 'a' : 'div';
  return (
    <Tag className={cx('qr-card', className)} href={href}>
      {kicker ? <p className="qr-card__kicker">{kicker}</p> : null}
      {title ? <h3 className="qr-card__title">{title}</h3> : null}
      {children ? <div className="qr-card__body">{children}</div> : null}
    </Tag>
  );
}
