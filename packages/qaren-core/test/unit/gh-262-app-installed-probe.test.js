// GH #262: ground-truth probe for "is the app bundle installed on the sim?".
// Classification is ALLOWLIST-only and reads simctl STDERR ONLY (never
// Error.message, which embeds command argv — a crafted bundleId containing
// the marker text must not force a false "not installed"). `false` requires
// the NSPOSIXErrorDomain + code=2 marker (verified live: "(domain=
// NSPOSIXErrorDomain, code=2)"); every other failure shape — bare ENOENT
// text, device errors, unknown stderr, no stderr, timeouts — returns `null`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAppInstalled,
  buildNotInstalledAdvice,
  posixSingleQuote,
} from '../../dist/cdp/app-installed-probe.js';

function execFailing(stderr, message) {
  return async () => {
    const err = new Error(
      message ?? `Command failed: xcrun simctl get_app_container ...\n${stderr}`,
    );
    err.stderr = stderr;
    throw err;
  };
}

test('probeAppInstalled: container resolves → true', async () => {
  const exec = async (cmd, args, opts) => {
    assert.equal(cmd, 'xcrun');
    assert.deepEqual(args, ['simctl', 'get_app_container', 'UDID-A', 'com.example.app', 'app']);
    assert.equal(opts.timeout, 5000);
    return { stdout: '/path/Example.app\n', stderr: '' };
  };
  assert.equal(await probeAppInstalled('UDID-A', 'com.example.app', exec), true);
});

test('probeAppInstalled: real missing-app stderr (domain + code=2) → false', async () => {
  // Exact shape captured live on this machine (Xcode 26):
  const stderr =
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\n' +
    'The operation couldn’t be completed. No such file or directory\n' +
    'No such file or directory';
  assert.equal(await probeAppInstalled('U', 'a', execFailing(stderr)), false);
});

test('probeAppInstalled: marker is case-insensitive and separator-flexible', async () => {
  assert.equal(
    await probeAppInstalled('U', 'a', execFailing('nsposixerrordomain Code: 2 oops')),
    false,
  );
});

test('probeAppInstalled: code=-2 / code=20 / missing domain → null (never false)', async () => {
  assert.equal(
    await probeAppInstalled('U', 'a', execFailing('domain=NSPOSIXErrorDomain, code=-2')),
    null,
  );
  assert.equal(
    await probeAppInstalled('U', 'a', execFailing('domain=NSPOSIXErrorDomain, code=20')),
    null,
  );
  assert.equal(await probeAppInstalled('U', 'a', execFailing('No such file or directory')), null);
});

test('probeAppInstalled: marker in Error.message but NOT stderr → null (argv-spoof defense)', async () => {
  const spoof = execFailing(
    '',
    'Command failed: xcrun simctl get_app_container U NSPOSIXErrorDomain-code=2-trap app',
  );
  assert.equal(await probeAppInstalled('U', 'NSPOSIXErrorDomain-code=2-trap', spoof), null);
});

test('probeAppInstalled: device-level error → null (fail open)', async () => {
  assert.equal(await probeAppInstalled('U', 'a', execFailing('Invalid device: U')), null);
  assert.equal(await probeAppInstalled('U', 'a', execFailing('No devices are booted.')), null);
});

test('probeAppInstalled: no stderr at all (spawn error / timeout) → null', async () => {
  assert.equal(
    await probeAppInstalled('U', 'a', async () => {
      throw new Error('ETIMEDOUT');
    }),
    null,
  );
});

test('posixSingleQuote: inert metacharacters and embedded quotes', () => {
  assert.equal(posixSingleQuote('plain'), `'plain'`);
  assert.equal(posixSingleQuote("My App's.app"), `'My App'\\''s.app'`);
});

test('buildNotInstalledAdvice: base advice without hint; shell-quoted install line with hint', () => {
  const base = buildNotInstalledAdvice('UDID-A', 'com.example.app', null);
  assert.match(base, /com\.example\.app is not installed on simulator UDID-A/);
  assert.match(base, /npx expo run:ios/);
  assert.doesNotMatch(base, /simctl install/);

  const withHint = buildNotInstalledAdvice('UDID-A', 'com.example.app', {
    path: '/tmp/rn-appfile-snapshots/My App.app',
    ageMinutes: 42,
  });
  assert.match(withHint, /42 min ago/);
  assert.match(withHint, /may be stale/);
  assert.match(
    withHint,
    /xcrun simctl install 'UDID-A' '\/tmp\/rn-appfile-snapshots\/My App\.app'/,
  );
});
