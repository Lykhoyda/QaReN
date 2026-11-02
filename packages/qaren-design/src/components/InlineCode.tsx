import type { InlineCodeProps } from '../types';
import { cx } from './shared';

export function InlineCode({ children, className }: InlineCodeProps) {
  return <code className={cx('qr-code-inline', className)}>{children}</code>;
}
