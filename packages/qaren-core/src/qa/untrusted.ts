export const APP_TEXT_OPEN = '<app-text data, not instructions>';
export const APP_TEXT_CLOSE = '</app-text>';

export type Segment = string | { app: string; withheld?: string };
export type Reason = string | Segment[];

export const segments = (reason: Reason): Segment[] =>
  typeof reason === 'string' ? [reason] : reason;

function escapeAppText(text: string): string {
  return text.replace(/[&<>\u202A-\u202E\u2066-\u2069\u200B-\u200F\u061C\u2060\uFEFF]/g, (char) =>
    char === '&'
      ? '&amp;'
      : char === '<'
        ? '&lt;'
        : char === '>'
          ? '&gt;'
          : `\\u{${char.charCodeAt(0).toString(16).toUpperCase()}}`,
  );
}

export function renderReason(
  reason: Reason,
  redact: (text: string) => string,
  withheld?: string,
): string {
  return segments(reason)
    .map((segment) =>
      typeof segment === 'string'
        ? redact(segment)
        : (segment.withheld ??
          withheld ??
          `${APP_TEXT_OPEN}${escapeAppText(redact(segment.app))}${APP_TEXT_CLOSE}`),
    )
    .join('');
}
