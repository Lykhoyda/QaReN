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

function verifyHomepageLink(href: string, content = '') {
  const dist = mkdtempSync(join(tmpdir(), 'verify-site-'));
  try {
    mkdirSync(join(dist, 'check'));
    writeFileSync(join(dist, 'index.html'), `<a href="${href}">link</a>${content}`);
    writeFileSync(join(dist, 'check', 'index.html'), '<p>check</p>');
    return spawnSync(process.execPath, [verifier], {
      env: { ...process.env, DOCS_DIST: dist },
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
