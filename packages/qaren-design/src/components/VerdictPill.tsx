import type { VerdictPillProps } from '../types';
import { Check, Cross, cx } from './shared';

export function VerdictPill({ verdict, size, className }: VerdictPillProps) {
  const v = verdict === 'FAIL' ? 'FAIL' : 'PASS';
  return (
    <span
      className={cx(
        'qr-verdict',
        `qr-verdict--${v.toLowerCase()}`,
        size && size !== 'md' ? `qr-verdict--${size}` : null,
        className,
      )}
    >
      {v === 'PASS' ? <Check /> : <Cross />}
      {v}
    </span>
  );
}
