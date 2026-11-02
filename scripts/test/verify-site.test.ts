import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const verifier = resolve(
  import.meta.dirname,
  '..',
  '..',
  'apps',
  'docs-site',
  'scripts',
  'verify-site.ts',
);

// The verifier is a Bun script; DOCS_BASE_PATH selects a GitHub Pages (/QaReN) or root-hosted build.
function verifyHomepageLink(href: string, content = '', basePath = '/QaReN') {
  const dist = mkdtempSync(join(tmpdir(), 'verify-site-'));
  try {
    mkdirSync(join(dist, 'check'));
    writeFileSync(join(dist, 'index.html'), `<a href="${href}">link</a>${content}`);
    writeFileSync(join(dist, 'check', 'index.html'), '<p>check</p>');
    return spawnSync('bun', [verifier], {
      env: { ...process.env, DOCS_DIST: dist, DOCS_BASE_PATH: basePath },
      encoding: 'utf8',
    });
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

test('accepts a relative homepage link to a built page', () => {
  const result = verifyHomepageLink('check/');

  assert.match(result.stdout, /ok {2}no broken internal links or assets/);
  assert.doesNotMatch(result.stderr, /broken link|outside the site base/);
});

test('rejects a relative homepage link to a missing page inside the base', () => {
  const result = verifyHomepageLink('qa-missing-page/');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /broken link \/QaReN\/qa-missing-page in \/index\.html/);
  assert.match(result.stderr, /FAIL {2}no broken internal links or assets/);
});

test('rejects a relative homepage link that escapes the site base', () => {
  const result = verifyHomepageLink('../qa-missing-page/');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /link outside the site base \/qa-missing-page in \/index\.html/);
  assert.match(result.stderr, /FAIL {2}no broken internal links or assets/);
});

test('accepts the device boot deadline configuration key', () => {
  const result = verifyHomepageLink('check/', '<code>device_boot_seconds</code>');

  assert.match(result.stdout, /ok {2}no page outside the changelog names a cdp_ or device_ tool/);
  assert.doesNotMatch(result.stderr, /1\.x tool name/);
});

for (const name of ['cdp_get_tree', 'device_snapshot', 'device_boot_seconds_extra']) {
  test(`rejects the obsolete tool name ${name}`, () => {
    const result = verifyHomepageLink('check/', `<code>${name}</code>`);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /1\.x tool name in index\.html/);
    assert.match(
      result.stderr,
      /FAIL {2}no page outside the changelog names a cdp_ or device_ tool/,
    );
  });
}

test('rejects a root-hosted link that still carries the old /QaReN base', () => {
  const result = verifyHomepageLink('/QaReN/check/', '', '');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /link with the wrong base in index\.html/);
  assert.match(result.stderr, /FAIL {2}internal links do not carry the old \/QaReN base/);
});

test('accepts a root-hosted link without a base', () => {
  const result = verifyHomepageLink('/check/', '', '');

  assert.match(result.stdout, /ok {2}internal links do not carry the old \/QaReN base/);
  assert.match(result.stdout, /ok {2}no broken internal links or assets/);
});

test('accepts one h1 followed by headings that skip no level', () => {
  const result = verifyHomepageLink('check/', '<h1>QaReN</h1><h2>Get started</h2><h3>Install</h3>');

  assert.match(result.stdout, /ok {2}index\.html has one h1/);
  assert.match(result.stdout, /ok {2}index\.html heading order starts at h1 and skips no level/);
});

test('rejects a page with two h1 headings', () => {
  const result = verifyHomepageLink('check/', '<h1>One</h1><h1>Two</h1>');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL {2}index\.html has one h1/);
});

test('rejects a heading that skips a level', () => {
  const result = verifyHomepageLink('check/', '<h1>QaReN</h1><h3>Install</h3>');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL {2}index\.html heading order starts at h1 and skips no level/);
});
