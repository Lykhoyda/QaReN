import type { LedgerRowProps } from '../types';
import { Mark, cx, stepStatus } from './shared';

export function LedgerRow({ index, status, action, target, duration, className }: LedgerRowProps) {
  const st = stepStatus(status);
  return (
    <div className={cx('qr-ledger-row', `qr-ledger-row--${st}`, className)} role="row">
      <span className="qr-ledger-row__i" role="cell">
        {index}
      </span>
      <Mark status={st} />
      <span className="qr-ledger-row__action" role="cell">
        {action}
      </span>
      <span
        className="qr-ledger-row__target"
        role="cell"
        title={typeof target === 'string' ? target : undefined}
      >
        {target}
      </span>
      <span className="qr-ledger-row__dur" role="cell">
        {duration || ''}
      </span>
      <span className={cx('qr-status', `qr-status--${st}`)} role="cell">
        {st}
      </span>
    </div>
  );
}
