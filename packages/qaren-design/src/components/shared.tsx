import type { StepStatus } from '../types';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// Glyphs stroke in currentColor.
export function Check() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Cross() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 4.5l7 7M11.5 4.5l-7 7"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Play() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 1l7 4-7 4z" fill="currentColor" />
    </svg>
  );
}

const STATUSES: readonly string[] = ['pending', 'running', 'passed', 'failed'];

/** An unknown status falls back to pending, as in the design system bundle. */
export function stepStatus(status: string): StepStatus {
  return STATUSES.includes(status) ? (status as StepStatus) : 'pending';
}

export function Mark({ status }: { status: StepStatus }) {
  return (
    <span className={cx('qr-mark', `qr-mark--${status}`)} aria-hidden="true">
      {status === 'passed' ? <Check /> : status === 'failed' ? <Cross /> : null}
    </span>
  );
}
