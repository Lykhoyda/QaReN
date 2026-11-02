import type { CalloutProps } from '../types';
import { cx } from './shared';

const LABEL = { note: 'Note', caution: 'Caution', danger: 'Danger' } as const;

export function Callout({ tone, title, children, className }: CalloutProps) {
  const t = tone && tone in LABEL ? tone : 'note';
  return (
    <aside className={cx('qr-callout', `qr-callout--${t}`, className)}>
      <p className="qr-callout__title">
        <span className="qr-callout__label">{LABEL[t]}</span>
        {title || null}
      </p>
      <p>{children}</p>
    </aside>
  );
}
