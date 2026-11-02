import type { TerminalPaneProps } from '../types';
import { Badge } from './Badge';
import { cx } from './shared';

export function TerminalPane({
  title,
  lines,
  cursor,
  float,
  placeholder,
  className,
}: TerminalPaneProps) {
  const all = lines ?? [];
  return (
    <div className={cx('qr-terminal', float ? 'qr-terminal--float' : null, className)}>
      <div className="qr-terminal__bar">
        <span className="qr-terminal__dot" />
        <span className="qr-terminal__dot" />
        <span className="qr-terminal__dot" />
        <span className="qr-terminal__title">{title || 'terminal'}</span>
        {placeholder !== false ? <Badge tone="placeholder">Placeholder output</Badge> : null}
      </div>
      <pre>
        {all.map((l, i) => {
          const kind = l.kind || 'out';
          return (
            <span key={i} className={cx('qr-line', `qr-line--${kind}`)}>
              {kind === 'cmd' ? <span className="qr-prompt">$ </span> : null}
              {l.text}
              {i === all.length - 1 && cursor ? (
                <span
                  className="qr-cursor qr-cursor--blink"
                  aria-hidden="true"
                  style={{ marginLeft: '0.2em' }}
                />
              ) : null}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
