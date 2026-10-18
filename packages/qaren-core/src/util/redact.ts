import { currentInputs } from '../qa/inputs.js';
import { homedir } from 'node:os';

const HOME = homedir();
const HOME_RE = new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

const SECRET_PATTERNS = [
  /(?:sk|pk|api|key|token|secret|password|auth)[-_]?[A-Za-z0-9_-]{20,}/gi,
  /Bearer\s+[A-Za-z0-9_\-./+=]{20,}/g,
  /ghp_[A-Za-z0-9_]{36}/g,
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  // Any private-key label variant: PRIVATE KEY, RSA PRIVATE KEY,
  // OPENSSH PRIVATE KEY, EC/DSA/ENCRYPTED PRIVATE KEY, ... The old single-word
  // `(?:RSA |OPENSSH |PRIVATE )?KEY` form never matched multi-word labels like
  // "RSA PRIVATE KEY" — the most common ssh-keygen header — so keys leaked.
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
];

// Value-side secret capture: redacts the VALUE when a secret-ish key is glued
// to it via `:` or `=` (quoted JSON / kv-pairs in error strings), preserving
// the key prefix. Catches `"password":"hunter2longvalue"` and `api_key=abc...`
// that SECRET_PATTERNS (which requires the keyword glued directly to the value)
// misses because the quote/colon separates them.
const KEYED_SECRET_RE =
  /((?:token|secret|password|passwd|pwd|api[_-]?key|apikey|authorization|auth|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)([^"'\s,;}]{6,})/gi;

const PII_PATTERNS = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // Require separators so bare digit runs (timestamps, latencies, ids) are not
  // mistaken for phone/SSN numbers (previously `[-.]?`/`[-]?` made them
  // optional, redacting any 9-10 digit number).
  /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

const AUTH_PATHS =
  /\b(auth|authorization|session|token|accessToken|refreshToken|supervisorOverrideToken|credentials?|password|passwd|pwd|pass|secret|apiKey|api_key|cookie|set-cookie|clientSecret|client_secret)\b/i;

const MAX_STRING_LENGTH = 2000;

let redactionKey: string | undefined;

export function setRedactionKey(key: string | undefined): void {
  redactionKey = key;
}

export function isSecretEnvName(name: string): boolean {
  return /(?:TOKEN|_API_KEY|APIKEY)$|SECRET|PASSWORD|PASSWD|_CREDENTIALS|_PRIVATE_KEY|^QAREN_INPUT_/i.test(
    name,
  );
}

export function redactApiKey(value: string, key = redactionKey): string {
  if (!key) return value;
  return value
    .split(JSON.stringify(key).slice(1, -1))
    .join('[REDACTED_SECRET]')
    .split(key)
    .join('[REDACTED_SECRET]');
}

function redactString(value: string): string {
  // Redact BEFORE truncating. Truncation can sever a paired-delimiter secret —
  // e.g. a PEM private key's -----END----- marker — so the pattern would never
  // match and the key body would leak through. Apply every pattern to the full
  // string first, then clip what remains.
  let result = redactApiKey(currentInputs()?.redact(value) ?? value).replace(HOME_RE, '~');
  KEYED_SECRET_RE.lastIndex = 0;
  result = result.replace(KEYED_SECRET_RE, '$1[REDACTED_SECRET]');
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED_SECRET]');
  }
  for (const pattern of PII_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[PII_REDACTED]');
  }
  if (result.length > MAX_STRING_LENGTH) {
    result = result.slice(0, MAX_STRING_LENGTH) + `[TRUNCATED:${result.length}]`;
  }
  return result;
}

function redactValue(value: unknown, path: string): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);

  if (Array.isArray(value)) {
    return value.map((item, i) => redactValue(item, `${path}[${i}]`));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const fullPath = path ? `${path}.${key}` : key;
      if (AUTH_PATHS.test(key)) {
        // Redact regardless of value type — an object/array value under an
        // auth-named key (e.g. credentials: { user, pass }) must not be
        // recursed into, or inner secrets leak when they match no pattern.
        result[key] = Array.isArray(val) ? '[REDACTED:array]' : `[REDACTED:${typeof val}]`;
      } else {
        result[key] = redactValue(val, fullPath);
      }
    }
    return result;
  }

  return value;
}

export function redact(data: Record<string, unknown>): Record<string, unknown> {
  return redactValue(data, '') as Record<string, unknown>;
}
