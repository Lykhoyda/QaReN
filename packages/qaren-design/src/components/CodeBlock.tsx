import { Fragment } from 'react';
import type { CodeBlockProps } from '../types';
import { Badge } from './Badge';
import { cx } from './shared';

export function CodeBlock({ code, title, placeholder, comments, className }: CodeBlockProps) {
  const lines = String(code || '')
    .replace(/\n$/, '')
    .split('\n');
  return (
    <div className={cx('qr-codeblock', className)}>
      {title || placeholder ? (
        <div className="qr-codeblock__head">
          <span>{title || ''}</span>
          {placeholder ? <Badge tone="placeholder">Placeholder</Badge> : null}
        </div>
      ) : null}
      <pre>
        <code>
          {lines.map((l, i) => {
            const muted = comments !== false && /^\s*(#|\/\/)/.test(l);
            return (
              <Fragment key={i}>
                <span className={muted ? 'qr-comment' : undefined}>{l}</span>
                {i < lines.length - 1 ? '\n' : null}
              </Fragment>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
