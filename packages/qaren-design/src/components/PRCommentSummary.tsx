import type { PRCommentSummaryProps } from '../types';
import { Badge } from './Badge';
import { StepList } from './StepList';
import { VerdictPill } from './VerdictPill';
import { cx } from './shared';

export function PRCommentSummary({
  verdict,
  title,
  plan,
  summary,
  steps,
  artifacts,
  placeholder,
  className,
}: PRCommentSummaryProps) {
  const v = verdict === 'FAIL' ? 'FAIL' : 'PASS';
  return (
    <section
      className={cx('qr-pr', `qr-pr--${v.toLowerCase()}`, className)}
      aria-label={`QaReN result: ${v}`}
    >
      <div className="qr-pr__head">
        <VerdictPill verdict={v} />
        <span className="qr-pr__title">
          {title || 'QaReN check'}
          {plan ? <span className="qr-pr__plan">{plan}</span> : null}
        </span>
        {placeholder !== false ? <Badge tone="placeholder">Placeholder</Badge> : null}
      </div>
      <div className="qr-pr__body">
        {summary ? <p className="qr-pr__summary">{summary}</p> : null}
        {steps ? <StepList steps={steps} /> : null}
      </div>
      {artifacts && artifacts.length ? (
        <div className="qr-pr__foot">
          {artifacts.map((a, i) => (
            <a key={i} className="qr-link" href={a.href || '#'}>
              {a.label}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}
