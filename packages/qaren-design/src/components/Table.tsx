import type { TableProps } from '../types';
import { cx } from './shared';

export function Table({ columns, rows, caption, className }: TableProps) {
  const cols = columns ?? [];
  return (
    <div className={cx('qr-table-wrap', className)}>
      <table className="qr-table">
        {caption ? (
          <caption style={{ position: 'absolute', left: '-9999px' }}>{caption}</caption>
        ) : null}
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r, ri) => (
            <tr key={ri}>
              {cols.map((c, ci) => (
                <td key={ci} className={c.numeric ? 'qr-num' : undefined}>
                  {r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
