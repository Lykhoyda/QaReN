const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}
