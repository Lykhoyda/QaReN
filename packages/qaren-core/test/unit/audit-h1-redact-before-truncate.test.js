import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../dist/util/redact.js';

// Audit H1: redactString must apply SECRET_PATTERNS BEFORE truncating. The PEM
// rule is a paired-delimiter regex needing both BEGIN and END markers; a real
// private key (1700-3200+ chars) exceeds MAX_STRING_LENGTH (2000), so truncating
// first severs the END marker and the key body leaks through unredacted.

function bigPem() {
  // ~2940-char base64 body -> total > 3000 chars, comfortably over the 2000 cap.
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ'.repeat(60);
  return '-----BEGIN RSA PRIVATE KEY-----\n' + body + '\n-----END RSA PRIVATE KEY-----';
}

test('H1: a >2000-char PEM private key is redacted, not leaked', () => {
  const pem = bigPem();
  assert.ok(pem.length > 2000, 'precondition: PEM exceeds MAX_STRING_LENGTH');

  const out = redact({ note: pem });
  const s = out.note;

  assert.equal(typeof s, 'string');
  assert.ok(!s.includes('MIIEvQIBADANBgkqhkiG'), 'raw key body must NOT survive redaction');
  assert.ok(s.includes('[REDACTED_SECRET]'), 'the PEM must be replaced with the redaction marker');
});

test('H1: OPENSSH private key over the cap is also redacted', () => {
  const body = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB'.repeat(50);
  const key =
    '-----BEGIN OPENSSH PRIVATE KEY-----\n' + body + '\n-----END OPENSSH PRIVATE KEY-----';
  const out = redact({ k: key });
  assert.ok(!out.k.includes('b3BlbnNzaC1rZXktdjEA'), 'OPENSSH key body must not leak');
  assert.ok(out.k.includes('[REDACTED_SECRET]'));
});

test('H1: a long non-secret string is still truncated (ordering preserved)', () => {
  const long = 'x'.repeat(5000);
  const out = redact({ blob: long });
  assert.ok(out.blob.includes('[TRUNCATED:'), 'long benign strings still get a truncation marker');
  assert.ok(out.blob.length < 5000, 'output is clipped');
});

test('the supervisor override field is always redacted', () => {
  const out = redact({ supervisorOverrideToken: 'supervisor-token-123456' });
  assert.equal(out.supervisorOverrideToken, '[REDACTED:string]');
});
