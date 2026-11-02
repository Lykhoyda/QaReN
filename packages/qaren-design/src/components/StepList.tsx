import type { StepListProps } from '../types';
import { Mark, cx, stepStatus } from './shared';

export function StepList({ steps, className }: StepListProps) {
  return (
    <ol className={cx('qr-steps', className)}>
      {(steps ?? []).map((s, i) => {
        const st = stepStatus(s.status);
        return (
          <li
            key={i}
            className={cx('qr-step', `qr-step--${st}`)}
            aria-current={st === 'running' ? 'step' : undefined}
          >
            <Mark status={st} />
            <span className="qr-step__n">{String(i + 1)}</span>
            <span className="qr-step__text">
              {s.text}
              {s.detail ? <span className="qr-step__detail">{s.detail}</span> : null}
            </span>
            <span className={cx('qr-status', `qr-status--${st}`)}>{st}</span>
          </li>
        );
      })}
    </ol>
  );
}
