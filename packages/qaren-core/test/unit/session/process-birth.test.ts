import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  probeProcessBirth,
  processBirthMatches,
  readProcessBirth,
} from '../../../dist/lifecycle/process-birth.js';

const noHostPidLookup = { signalPermission: () => 'unknown' as const };

test('macOS process identity uses full kernel start time and boot session', () => {
  const runForBoot = (bootSession, startMicroseconds = '345678') => ({
    run: (command, args) => {
      if (command === '/bin/ps') {
        assert.deepEqual(args, ['-p', '123', '-o', 'pid=,state=']);
        return '123\n';
      }
      if (command === '/usr/sbin/sysctl') {
        assert.deepEqual(args, ['-n', 'kern.bootsessionuuid']);
        return `${bootSession}\n`;
      }
      throw new Error(`unexpected command ${command}`);
    },
    runVerifiedHelper: (path, pid, requirement) => {
      assert.match(path, /darwin-process-birth$/);
      assert.equal(pid, 123);
      assert.match(requirement, /cdhash H"[0-9a-f]{40}"/);
      return `123:1784792468:${startMicroseconds}\n`;
    },
  });
  const before = readProcessBirth(123, {
    platform: 'darwin',
    ...noHostPidLookup,
    ...runForBoot('C9D056AF-6F25-47A3-8A9A-63B86EF8519F'),
  });
  const after = readProcessBirth(123, {
    platform: 'darwin',
    ...noHostPidLookup,
    ...runForBoot('D9D056AF-6F25-47A3-8A9A-63B86EF8519F'),
  });
  const sameMillisecond = readProcessBirth(123, {
    platform: 'darwin',
    ...noHostPidLookup,
    ...runForBoot('C9D056AF-6F25-47A3-8A9A-63B86EF8519F', '345679'),
  });

  assert.equal(before?.source, 'darwin-libproc');
  assert.match(before?.token ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(before?.token, after?.token);
  assert.notEqual(before?.token, sameMillisecond?.token);
});

test('macOS process probes distinguish confirmed absence from unreadable identity', () => {
  assert.deepEqual(
    probeProcessBirth(123, {
      platform: 'darwin',
      ...noHostPidLookup,
      run: (command) => (command === '/bin/ps' ? '' : assert.fail()),
    }),
    { status: 'absent' },
  );
  assert.deepEqual(
    probeProcessBirth(123, {
      platform: 'darwin',
      ...noHostPidLookup,
      run: (command) => (command === '/bin/ps' ? '123\n' : 'unparseable\n'),
    }),
    { status: 'unknown' },
  );
});

test('a terminated but unreaped process reads as absent, not as an unknown identity', () => {
  assert.deepEqual(
    probeProcessBirth(123, {
      platform: 'darwin',
      ...noHostPidLookup,
      run: (command) => (command === '/bin/ps' ? '  123 Z+\n' : assert.fail()),
      runVerifiedHelper: () => assert.fail('a zombie must not reach the identity helper'),
    }),
    { status: 'absent' },
  );
  assert.deepEqual(
    probeProcessBirth(123, {
      platform: 'linux',
      ...noHostPidLookup,
      read: (path) =>
        path.includes('boot_id') ? 'boot-1\n' : '123 (runner) Z 1 1 0 0 -1 0 0 0 0 0 0 0\n',
    }),
    { status: 'absent' },
  );
});

test('macOS process identity refuses a replaced helper manifest', () => {
  let helperExecuted = false;
  const birth = probeProcessBirth(123, {
    platform: 'darwin',
    ...noHostPidLookup,
    readBinary: (path) =>
      path.endsWith('.json')
        ? Buffer.from('{}')
        : readFileSync(new URL('../../../dist/native/darwin-process-birth', import.meta.url)),
    run: (command) => {
      if (command === '/bin/ps') return '123\n';
      return '';
    },
    runVerifiedHelper: () => {
      helperExecuted = true;
      return '';
    },
  });

  assert.deepEqual(birth, { status: 'unknown' });
  assert.equal(helperExecuted, false);
});

test('macOS process identity requires the verified live helper CDHash', () => {
  const helperBytes = readFileSync(
    new URL('../../../dist/native/darwin-process-birth', import.meta.url),
  );
  const helperManifest = JSON.parse(
    readFileSync(
      new URL('../../../dist/native/darwin-process-birth.json', import.meta.url),
      'utf8',
    ),
  );
  const metadata = {
    dev: 1,
    ino: 2,
    mode: 0o100500,
    size: helperBytes.length,
    uid: 501,
    isFile: () => true,
  };
  let observedRequirement = '';
  const birth = readProcessBirth(123, {
    platform: 'darwin',
    ...noHostPidLookup,
    helperPath: () => '/trusted/darwin-process-birth',
    canonicalize: (path) => path,
    lstat: () => metadata,
    open: () => 17,
    fstat: () => metadata,
    close: () => {},
    uid: 501,
    readDescriptor: () => helperBytes,
    readBinary: () => Buffer.from(JSON.stringify(helperManifest)),
    run: (command) => (command === '/bin/ps' ? '123\n' : 'C9D056AF-6F25-47A3-8A9A-63B86EF8519F\n'),
    runVerifiedHelper: (path, pid, requirement) => {
      assert.equal(path, '/trusted/darwin-process-birth');
      assert.equal(pid, 123);
      observedRequirement = requirement;
      return '123:1784792468:345678\n';
    },
  });

  assert.equal(birth?.source, 'darwin-libproc');
  assert.equal(
    observedRequirement,
    `(${helperManifest.cdhashes.map((hash) => `cdhash H"${hash}"`).join(' or ')})`,
  );
});

test('macOS process identity rejects a live helper outside the pinned CDHashes', () => {
  const birth = probeProcessBirth(123, {
    platform: 'darwin',
    ...noHostPidLookup,
    run: (command) => (command === '/bin/ps' ? '123\n' : 'C9D056AF-6F25-47A3-8A9A-63B86EF8519F\n'),
    runVerifiedHelper: () => {
      throw new Error('live process failed its code requirement');
    },
  });

  assert.deepEqual(birth, { status: 'unknown' });
});

test('macOS helper verification waits for SIGSTOP and applies the pinned requirement', () => {
  const sources = [
    readFileSync(new URL('../../../src/lifecycle/process-birth.ts', import.meta.url), 'utf8'),
  ];

  for (const source of sources) {
    assert.match(
      source,
      /\[\[ "\$state" == T\* \]\][\s\S]*?codesign --verify --strict "-R=\$3" "\$1"[\s\S]*?codesign --verify --strict "\+\$helper_pid"[\s\S]*?CDHash=[\s\S]*?expected_cdhash=[\s\S]*?kill -CONT "\$helper_pid"/,
    );
    assert.doesNotMatch(source, /codesign --verify --strict --requirement/);
  }
});

test('Linux process identity handles process names containing spaces', () => {
  const birth = readProcessBirth(456, {
    platform: 'linux',
    ...noHostPidLookup,
    read: (path) => {
      if (path === '/proc/sys/kernel/random/boot_id') return 'boot-123\n';
      if (path === '/proc/456/stat') {
        const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index)), '987654'];
        return `456 (worker with spaces) ${fields.join(' ')}\n`;
      }
      throw new Error(`unexpected path ${path}`);
    },
  });

  assert.equal(birth?.source, 'linux-proc');
  assert.match(birth?.token ?? '', /^[a-f0-9]{64}$/);
});

test('Windows process identity uses a trusted absolute PowerShell executable', () => {
  const powershell = 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const commands: string[] = [];
  const birth = probeProcessBirth(456, {
    platform: 'win32',
    ...noHostPidLookup,
    executableDependencies: {
      environment: { SystemRoot: 'D:\\Windows' },
      exists: (path) => path === powershell,
    },
    run: (command) => {
      commands.push(command);
      return '638892576000000000\n';
    },
  });

  assert.equal(birth.status, 'present');
  assert.deepEqual(commands, [powershell]);
});

test('Windows process identity fails closed without trusted PowerShell', () => {
  let executed = false;
  const birth = probeProcessBirth(456, {
    platform: 'win32',
    ...noHostPidLookup,
    executableDependencies: { exists: () => false },
    run: () => {
      executed = true;
      return '638892576000000000\n';
    },
  });

  assert.deepEqual(birth, { status: 'unknown' });
  assert.equal(executed, false);
});

test('unreadable process birth fails conservative', () => {
  const birth = readProcessBirth(789, {
    platform: 'darwin',
    ...noHostPidLookup,
    run: () => {
      throw new Error('permission denied');
    },
  });

  assert.equal(birth, null);
  assert.equal(
    processBirthMatches(
      { pid: 789, token: 'recorded' },
      {
        platform: 'darwin',
        ...noHostPidLookup,
        run: () => {
          throw new Error('permission denied');
        },
      },
    ),
    false,
  );
});

test('process birth probes distinguish confirmed absence from unreadable identity', () => {
  const missing = new Error('missing');
  (missing as NodeJS.ErrnoException).code = 'ENOENT';
  const read = (path) => {
    if (path.endsWith('boot_id')) return 'boot-123';
    throw missing;
  };
  assert.deepEqual(probeProcessBirth(789, { platform: 'linux', ...noHostPidLookup, read }), {
    status: 'absent',
  });
  assert.deepEqual(
    probeProcessBirth(789, {
      platform: 'linux',
      ...noHostPidLookup,
      read: (path) => {
        if (path.endsWith('boot_id')) return 'boot-123';
        throw new Error('permission denied');
      },
    }),
    { status: 'unknown' },
  );
});

test('current process has a portable birth identity on supported hosts', () => {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    return;
  }

  const birth = readProcessBirth(process.pid);

  assert.equal(birth?.pid, process.pid);
  assert.match(birth?.token ?? '', /^[a-f0-9]{64}$/);
});

test('Darwin process helper ships executable in core', () => {
  const helperUrls = [new URL('../../../dist/native/darwin-process-birth', import.meta.url)];
  const helpers = helperUrls.map((url) => readFileSync(url));
  const manifests = helperUrls.map((url) =>
    JSON.parse(readFileSync(`${fileURLToPath(url)}.json`, 'utf8')),
  );

  assert.equal(manifests[0].binarySha256, createHash('sha256').update(helpers[0]).digest('hex'));
  assert.equal(manifests[0].cdhashes.length, 2);
  assert.ok(manifests[0].cdhashes.every((cdhash) => /^[a-f0-9]{40}$/.test(cdhash)));
  assert.match(manifests[0].sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(manifests[0].recipeSha256, /^[a-f0-9]{64}$/);
  assert.match(manifests[0].stableBinarySha256, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    for (const url of helperUrls) {
      assert.notEqual(statSync(url).mode & 0o111, 0);
    }
  }
});

test('Linux publication helpers ship in core', () => {
  for (const [architecture, machine] of [
    ['x64', 62],
    ['arm64', 183],
  ] as const) {
    const relative = `native/linux-conditional-publication-${architecture}`;
    const urls = [new URL(`../../../dist/${relative}`, import.meta.url)];
    const helpers = urls.map((url) => readFileSync(url));
    const manifests = urls.map((url) =>
      JSON.parse(readFileSync(`${fileURLToPath(url)}.json`, 'utf8')),
    );

    assert.equal(helpers[0].readUInt32BE(0), 0x7f454c46);
    assert.equal(helpers[0].readUInt16LE(18), machine);
    assert.equal(manifests[0].binarySha256, createHash('sha256').update(helpers[0]).digest('hex'));
  }
});
