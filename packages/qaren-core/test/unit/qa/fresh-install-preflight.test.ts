import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectIosExternalRunner,
  isIosExternalRunnerProcessLine,
  probeIosExternalRunnerStrict,
  probeIosExternalRunnerAdmission,
} from '../../../dist/runners/external-runner-detect.js';
import { freshInstallPreflight } from '../../../dist/qa/fresh-install-preflight.js';

const UDID = 'FC78646A-56D5-4737-9CD0-A360D622F3B3';
const OTHER = 'AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB';
const entry = fileURLToPath(
  new URL('../../../dist/qa/fresh-install-preflight.js', import.meta.url),
);
const args = ['--platform', 'ios', '--device', UDID];
const ordinary = '1 /sbin/launchd\n2 /usr/bin/login\n';
const secret = '/private/secret-token/flow.yaml';
const driver = (name: string, device = UDID) =>
  `20 /Users/test/Library/Developer/CoreSimulator/Devices/${device}/data/${name}.app/${name}\n`;

const spacedExecutables = [
  `/Users/test/Library/Developer/CoreSimulator/Devices/${UDID}/data/My AppUITests-Runner.app/My AppUITests-Runner`,
  '/Applications/Xcode 26.app/Contents/Developer/usr/bin/xcodebuild',
  '/Applications/Xcode - Beta.app/Contents/Developer/usr/bin/xcodebuild',
  "/Applications/Xcode 'Beta'.app/Contents/Developer/usr/bin/xcodebuild",
  '/Applications/Xcode "Beta".app/Contents/Developer/usr/bin/xcodebuild',
  '/Applications/Xcode /Beta.app/Contents/Developer/usr/bin/xcodebuild',
  `/Applications/Xcode '"Beta"' - /QA.app/Contents/Developer/usr/bin/xcodebuild`,
  `/Users/test/Library/Developer/CoreSimulator/Devices/${UDID}/data/My App - QAUITests-Runner.app/My App - QAUITests-Runner`,
  `/Users/test/Library/Developer/CoreSimulator/Devices/${UDID}/data/My 'QA' AppUITests-Runner.app/My 'QA' AppUITests-Runner`,
  `/Users/test/Library/Developer/CoreSimulator/Devices/${UDID}/data/My 'QA' AppUITestsRunner.app/My 'QA' AppUITestsRunner`,
  `/Users/Test /QA/Library/Developer/CoreSimulator/Devices/${UDID}/data/QaReN-Runner.app/QaReN-Runner`,
  `/Users/Test User/Library/Developer/CoreSimulator/Devices/${UDID}/data/QaReN-Runner.app/QaReN-Runner`,
  `/Users/Test Full Name/Library/Developer/CoreSimulator/Devices/${UDID}/data/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner`,
];

const spacedShellScripts = [
  '/Users/Test User/.maestro/bin/maestro',
  '/Users/Test - QA User/.maestro/bin/maestro',
  "/Users/Test 'QA' User/.maestro/bin/maestro",
  '/Users/Test "QA" User/.maestro/bin/maestro',
  '/Users/Test /QA User/.maestro/bin/maestro',
  `/Users/Test '"QA"' - /User/.maestro/bin/maestro`,
];

const shellPrefixes = [
  '/bin/sh',
  '/bin/bash -eu',
  '/bin/zsh -o errexit --',
  '/bin/bash -O extglob -x',
  '"/bin/sh" --',
  '/usr/bin/env',
];

const ambiguousJvms = [
  '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java',
  '/Applications/Android Studio - Beta.app/Contents/jbr/Contents/Home/bin/java',
  "/Applications/Android 'Studio'.app/Contents/jbr/Contents/Home/bin/java",
  '/Applications/Android "Studio".app/Contents/jbr/Contents/Home/bin/java',
  '/Applications/Android /Studio.app/Contents/jbr/Contents/Home/bin/java',
];

function maestroJava(jvm: string, mode: string, scope = ''): string {
  return `${jvm} -classpath /Users/test/.maestro/lib/* maestro.cli.AppKt ${mode}${scope}`;
}

function fakePs(stdout: string, stderr = ''): typeof execFile {
  return (async (bin: string, argv: string[], opts: object) => {
    assert.equal(bin, 'ps');
    assert.deepEqual(argv, ['axww', '-o', 'pid=,command=']);
    assert.deepEqual(opts, { timeout: 2_000, encoding: 'utf8' });
    return { stdout, stderr };
  }) as unknown as typeof execFile;
}

test('strict detector admits only complete, clean process scans', async () => {
  assert.equal(await probeIosExternalRunnerStrict(fakePs(ordinary), UDID), 'clear');
  for (const output of [
    '',
    '\n',
    '   \n',
    ordinary.trimEnd(),
    'PID COMMAND\n',
    '0 /sbin/launchd\n',
    '12 \n',
    '12\n',
    '12 /bin/login\npartial',
    `${ordinary}\n`,
    '12 /bin/login\n12 /bin/login\n',
    '9007199254740992 /bin/login\n',
    '1 /bin/lo\0gin\n',
    '1 /bin/lo\rgin\n',
    '1 /bin/lo\ufffdgin\n',
    `${ordinary}diagnostic: ${secret}\n`,
  ]) {
    assert.equal(await probeIosExternalRunnerStrict(fakePs(output), UDID), 'unknown');
  }
  for (const diagnostic of ['warning', ' ', secret]) {
    assert.equal(await probeIosExternalRunnerStrict(fakePs(ordinary, diagnostic), UDID), 'unknown');
  }
  const failing = (async () => {
    throw new Error(secret);
  }) as unknown as typeof execFile;
  assert.equal(await probeIosExternalRunnerStrict(failing, UDID), 'unknown');
  assert.equal(await detectIosExternalRunner(failing, UDID), null);
});

test('oversized unrelated rows admit while unreadable automation candidates still refuse', async () => {
  const command = 'x'.repeat(1024 * 1024);
  for (const unreadable of [
    async () => null,
    async () => {
      throw new Error('process exited or identity is inaccessible');
    },
  ]) {
    let calls = 0;
    const observe = async () => {
      calls++;
      return unreadable();
    };
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(`1 ${command}\n`), UDID, observe),
      'clear',
    );
    assert.equal(calls, 0);
    assert.equal(
      await probeIosExternalRunnerStrict(
        fakePs(`1 /opt/bin/agent --prompt ${command} /tmp/XCTRunner\n`),
        UDID,
        observe,
      ),
      'unknown',
    );
    assert.equal(calls, 1);
  }
});

test('fresh-install CLI reports why a scan is unknown without publishing process text', async () => {
  await fixture(async (root, marker) => {
    const result = await invoke(root, marker, args, { FAKE_PS_STDOUT: `malformed ${secret}\n` });
    assert.equal(result.code, 4);
    assert.deepEqual(JSON.parse(result.stdout).evidence, { reason: 'scan_row_invalid' });
    assert.ok(!result.stdout.includes(secret));
  });
});

test('streamed admission preserves timeout, unavailable and failed scan evidence', async () => {
  await fixture(async (root, marker) => {
    for (const [env, reason] of [
      [{ FAKE_PS_MODE: 'timeout' }, 'scan_timeout'],
      [{ FAKE_PS_EXIT: '1', FAKE_PS_STDERR: secret }, 'scan_failed'],
    ] as const) {
      const result = await invoke(root, marker, args, env);
      assertResult(result, 'unknown');
      assert.deepEqual(JSON.parse(result.stdout).evidence, { reason });
    }
    await rm(join(root, 'ps'));
    const result = await invoke(root, marker);
    assertResult(result, 'unknown');
    assert.deepEqual(JSON.parse(result.stdout).evidence, { reason: 'scan_unavailable' });
  });
});

test('admission evidence distinguishes scan and identity failures using reason codes and PIDs', async () => {
  for (const [stdout, stderr, evidence] of [
    [ordinary.trimEnd(), '', { reason: 'scan_incomplete' }],
    [ordinary, secret, { reason: 'scan_stderr' }],
    [`1 /bin/lo\0gin\n`, '', { reason: 'scan_corrupt' }],
    [`${ordinary}2 /usr/bin/login\n`, '', { reason: 'scan_pid_invalid' }],
    [driver('QaReN-Runner', OTHER), '', { reason: 'observer_unavailable', candidates: 1 }],
  ] as const) {
    assert.deepEqual(await probeIosExternalRunnerAdmission(fakePs(stdout, stderr), UDID), {
      status: 'unknown',
      evidence,
    });
  }
  assert.deepEqual(
    await probeIosExternalRunnerAdmission(
      fakePs(driver('QaReN-Runner', OTHER)),
      UDID,
      async () => null,
    ),
    { status: 'unknown', evidence: { reason: 'driver_identity_unproven', pid: 20 } },
  );
  assert.deepEqual(
    await probeIosExternalRunnerAdmission(fakePs(driver('QaReN-Runner', OTHER)), UDID, async () => {
      throw new Error(secret);
    }),
    { status: 'unknown', evidence: { reason: 'observer_failed', pid: 20 } },
  );
});

test('fresh-install CLI reports failed observer acquisition without exposing its output', async () => {
  await fixture(async (root, marker) => {
    const observer = join(root, 'observer');
    await writeFile(
      observer,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(secret)});\n`,
      { mode: 0o755 },
    );
    const result = await invoke(root, marker, [...args, '--process-observer', observer], {
      FAKE_PS_STDOUT: driver('QaReN-Runner', OTHER),
    });
    assert.equal(result.code, 4);
    assert.deepEqual(JSON.parse(result.stdout).evidence, {
      reason: 'observer_invalid_json',
      pid: 20,
    });
    assert.ok(!result.stdout.includes(secret));
  });
});

test('strict detector includes foreign, own and generic test drivers without changing legacy policy', async () => {
  for (const name of [
    'maestro-driver-iosUITests-Runner',
    'WebDriverAgentRunner-Runner',
    'QaReN-Runner',
    'XCTRunner',
    'ExampleUITests-Runner',
  ]) {
    assert.equal(await probeIosExternalRunnerStrict(fakePs(driver(name)), UDID), 'busy', name);
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(driver(name, OTHER)), UDID),
      'unknown',
      `${name}: a container path in process text is not kernel evidence`,
    );
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(`20 /tmp/${name}\n`), UDID),
      'unknown',
      name,
    );
  }
  for (const name of ['QaReN-Runner', 'XCTRunner', 'ExampleUITests-Runner']) {
    assert.equal(await detectIosExternalRunner(fakePs(driver(name)), UDID), null);
  }
  assert.ok(await detectIosExternalRunner(fakePs(driver('WebDriverAgentRunner-Runner')), UDID));
  assert.equal(
    await detectIosExternalRunner(fakePs(driver('WebDriverAgentRunner-Runner', OTHER)), UDID),
    null,
  );
  assert.equal(await detectIosExternalRunner(fakePs('broken output'), UDID), null);
  assert.equal(await detectIosExternalRunner(fakePs(ordinary, 'diagnostic'), UDID), null);
});

test('CLI, shell, Java and xcodebuild signatures are conservative, not arbitrary prompt words', async () => {
  for (const command of [
    '/opt/bin/maestro test',
    '/bin/sh /opt/bin/maestro test',
    'java -classpath lib maestro.cli.AppKt mcp',
    '/Xcode/usr/bin/xcodebuild test -scheme Example',
    '/Xcode/usr/bin/xcodebuild test-without-building -xctestrun /tmp/example.xctestrun',
  ]) {
    assert.equal(await probeIosExternalRunnerStrict(fakePs(`20 ${command}\n`), UDID), 'unknown');
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(`20 ${command} --device ${UDID}\n`), UDID),
      command.startsWith('/bin/sh ') ? 'unknown' : 'busy',
    );
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(`20 ${command} --log ${OTHER}\n`), UDID),
      'unknown',
    );
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(`20 ${command} --device ${UDID}-extra\n`), UDID),
      'unknown',
    );
  }
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs(
        `20 /bin/agent prompt Maestro WebDriverAgent QarenIosRunner XCTRunner xcodebuild test ${UDID}\n`,
      ),
      UDID,
    ),
    'clear',
  );
  assert.equal(
    await probeIosExternalRunnerStrict(fakePs('20 xcodebuild build -scheme Example\n'), UDID),
    'clear',
  );
  assert.equal(
    await probeIosExternalRunnerStrict(fakePs(`${ordinary}${driver('XCTRunner')}`), UDID),
    'busy',
  );
  assert.equal(
    await probeIosExternalRunnerStrict(fakePs(`${driver('XCTRunner')}bad row\n`), UDID),
    'unknown',
  );
});

test('only kernel evidence scopes a driver away to other simulators', async () => {
  const SECOND = 'CCCCCCCC-4444-5555-6666-DDDDDDDDDDDD';
  const xcodebuild = '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild';
  const maestro = '/opt/bin/maestro';
  const java = '/Library/Java/bin/java';
  const inOther = `/Users/t/Library/Developer/CoreSimulator/Devices/${OTHER}/data/X.app/XCTRunner`;
  const run = ['xcodebuild', 'test-without-building', '-scheme', 'QarenIosRunner'];
  const cases: Array<[string, string, string[], 'clear' | 'busy' | 'unknown', string?]> = [
    ['runner app in another simulator', inOther, ['XCTRunner'], 'clear'],
    [
      'destination id',
      xcodebuild,
      [...run, '-destination', `platform=iOS Simulator,id=${OTHER}`],
      'clear',
    ],
    [
      'two destination ids',
      xcodebuild,
      [...run, '-destination', `id=${OTHER}`, '-destination', `id=${SECOND}`],
      'clear',
    ],
    ['our destination', xcodebuild, [...run, '-destination', `id=${UDID}`], 'busy'],
    [
      'name destination',
      xcodebuild,
      [...run, '-destination', 'platform=iOS Simulator,name=iPhone 17'],
      'unknown',
    ],
    [
      'generic destination',
      xcodebuild,
      [...run, '-destination', 'generic/platform=iOS Simulator'],
      'unknown',
    ],
    [
      'mixed destinations',
      xcodebuild,
      [...run, '-destination', `id=${OTHER}`, '-destination', 'name=iPhone 17'],
      'unknown',
    ],
    ['no destination', xcodebuild, [...run, '-xctestrun', '/tmp/x.xctestrun'], 'unknown'],
    [
      'destination words inside one argument',
      xcodebuild,
      [...run, '-resultBundlePath', `/tmp/x -destination id=${OTHER}`],
      'unknown',
    ],
    ['maestro device flag', maestro, ['maestro', '--device', OTHER, 'test', 'flow.yaml'], 'clear'],
    ['maestro device list', maestro, ['maestro', 'test', `--device=${OTHER},${SECOND}`], 'clear'],
    [
      'maestro partial list',
      maestro,
      ['maestro', 'test', '--device', `${OTHER},not-a-udid`],
      'unknown',
    ],
    ['maestro without device', maestro, ['maestro', 'test', '--log', OTHER], 'unknown'],
    [
      'jvm maestro device flag',
      java,
      ['java', '-classpath', 'lib', 'maestro.cli.AppKt', '--device', OTHER, 'test'],
      'clear',
    ],
    [
      'executable contradicts argv',
      '/usr/bin/python3',
      [...run, '-destination', `id=${OTHER}`],
      'unknown',
      xcodebuild,
    ],
  ];
  for (const [name, executable, argv, expected, shown = executable] of cases) {
    const observe = async (pid: number, _timeout: number, withArgv?: boolean) => {
      assert.equal(withArgv, true, name);
      return { v: 1, pid, birth: { seconds: 1, micros: 0 }, executable, argv };
    };
    const line = `20 ${shown} ${argv.slice(1).join(' ')}`.trimEnd();
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(`${ordinary}${line}\n`), UDID, observe),
      expected,
      name,
    );
  }
  const unscoped = async (pid: number) => ({
    v: 1,
    pid,
    birth: { seconds: 1, micros: 0 },
    executable: pid === 20 ? inOther : maestro,
    argv: pid === 20 ? ['XCTRunner'] : ['maestro', 'test', 'flow.yaml'],
  });
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs(`20 ${inOther}\n21 ${maestro} test flow.yaml\n`),
      UDID,
      unscoped,
    ),
    'unknown',
    'a scoped driver does not excuse an unscoped one',
  );
  const shell = async (pid: number) => ({
    v: 1,
    pid,
    birth: { seconds: 1, micros: 0 },
    executable: '/bin/sh',
    argv: ['/bin/sh', maestro, '--device', OTHER, 'test'],
  });
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs(`20 /bin/sh ${maestro} --device ${OTHER} test\n`),
      UDID,
      shell,
    ),
    'unknown',
    'a shell-wrapped Maestro stays unresolved even with a device flag',
  );
});

const spacedXcode = '/Applications/Xcode 26.app/Contents/Developer/usr/bin/xcodebuild';
const xcodeArgv = (device = OTHER, action = 'test', executable = spacedXcode) => [
  executable,
  action,
  '-destination',
  `id=${device}`,
];
const xcodeIdentity = (executable = spacedXcode, pid = 20) => ({
  v: 1,
  pid,
  birth: { seconds: 1, micros: 0 },
  executable,
});

test('direct Xcode spelling correction preserves the admission outcomes', async (t) => {
  const absolute = spacedXcode.replace('Xcode 26.app', 'Xcode.app');
  for (const [name, argv, expected, executable = argv[0]] of [
    ['bare build', ['xcodebuild', 'build', '-scheme', 'Example'], 'clear'],
    ['absolute build', [absolute, 'build', '-scheme', 'Example'], 'clear'],
    ['spaced build', [spacedXcode, 'build', '-scheme', 'Example'], 'clear'],
    [
      'generic build',
      [
        absolute,
        '-workspace',
        'App.xcworkspace',
        '-scheme',
        'App',
        '-configuration',
        'Debug',
        '-sdk',
        'iphonesimulator',
        '-destination',
        'generic/platform=iOS Simulator',
        '-derivedDataPath',
        '/tmp/dd',
      ],
      'clear',
    ],
    [
      'build other destination',
      [absolute, 'build', '-scheme', 'App', '-destination', `id=${OTHER}`],
      'clear',
    ],
    [
      'build named destination',
      [
        absolute,
        'build',
        '-scheme',
        'App',
        '-destination',
        'platform=iOS Simulator,name=iPhone 17',
      ],
      'clear',
    ],
    [
      'build selected destination',
      [absolute, 'build', '-scheme', 'App', '-destination', `id=${UDID}`],
      'busy',
    ],
    [
      'build mixed selected destination',
      [
        spacedXcode,
        'build',
        '-destination',
        'generic/platform=iOS Simulator',
        '-destination',
        `platform=iOS Simulator,id=${UDID.toLowerCase()}`,
      ],
      'busy',
    ],
    ['archive', [absolute, 'archive', '-scheme', 'App'], 'clear'],
    ['build for testing', [absolute, 'build-for-testing', '-scheme', 'App'], 'clear'],
    ['aliased build', ['/opt/bin/xcodebuild', 'build', '-scheme', 'App'], 'clear', absolute],
    ['build with scheme named test', [absolute, 'build', '-scheme', 'test'], 'unknown'],
    ['absolute other test', xcodeArgv(OTHER, 'test', absolute), 'clear'],
    ['spaced other test', xcodeArgv(), 'clear'],
    ['absolute selected test', xcodeArgv(UDID, 'test', absolute), 'busy'],
  ] as const) {
    await t.test(name, async () => {
      const calls: Array<boolean | undefined> = [];
      const result = await probeIosExternalRunnerStrict(
        fakePs(`20 ${argv.join(' ')}\n`),
        UDID,
        async (pid, timeout, withArgv, inspection) => {
          calls.push(withArgv);
          assert.ok(timeout > 0 && timeout <= 1_000);
          assert.equal(inspection, undefined);
          return { ...xcodeIdentity(executable, pid), ...(withArgv ? { argv } : {}) };
        },
      );
      assert.equal(result, expected);
      assert.deepEqual(
        calls,
        name === 'bare build' || name === 'absolute selected test'
          ? []
          : name === 'absolute other test' || name === 'build with scheme named test'
            ? [true]
            : [undefined, true],
      );
    });
  }
});

test('unresolved direct Xcode tests require exact complete destination pairs', async (t) => {
  const second = 'CCCCCCCC-4444-5555-6666-DDDDDDDDDDDD';
  const destinations = ['-destination', `id=${OTHER}`, '-destination', `id=${second}`];
  for (const executable of spacedExecutables.filter((path) => path.endsWith('/xcodebuild'))) {
    for (const action of ['test', 'test-without-building']) {
      for (const [scope, expected] of [
        [['-destination', `id=${OTHER.toLowerCase()}`], 'clear'],
        [['-destination', `id=${UDID.toLowerCase()}`], 'busy'],
        [destinations, 'clear'],
        [[...destinations, '-destination', `id=${UDID}`], 'busy'],
      ] as const) {
        await t.test(`${executable} ${action} ${expected} ${scope.join(' ')}`, async () => {
          const argv = [executable, action, ...scope];
          const calls: Array<boolean | undefined> = [];
          assert.equal(
            await probeIosExternalRunnerStrict(
              fakePs(`20 ${argv.join(' ')}\n`),
              UDID,
              async (pid, timeout, withArgv) => {
                calls.push(withArgv);
                assert.ok(timeout > 0 && timeout <= 1_000);
                return { ...xcodeIdentity(executable, pid), ...(withArgv ? { argv } : {}) };
              },
            ),
            expected,
          );
          assert.deepEqual(calls, [undefined, true]);
        });
      }
    }
  }
});

test('unresolved Xcode refuses unattested argv and tests without exact scope', async (t) => {
  const valid = xcodeArgv();
  const invalid: Array<[string, unknown, string?]> = [
    ['missing', undefined],
    ['null', null],
    ['wrong type', valid.join(' ')],
    ['empty', [], valid.join(' ')],
    ['partial', valid.slice(0, 2)],
    ['nonstring', [...valid, null]],
    ['empty element', [...valid, '']],
    ['corrupt element', [...valid, '\0'], valid.join(' ')],
    ['replacement character', [...valid, '\ufffd'], valid.join(' ')],
    ['missing destination value', valid.slice(0, 3)],
    ['extra operand', [...valid, 'Example']],
    ['unknown option', [...valid, '-scheme', 'Example']],
    ['option operand is test', [spacedXcode, '-unknown', ...valid.slice(1)]],
    ['multiple actions', [...valid, 'test-without-building']],
    ['argv zero mismatch', ['/usr/bin/python3', ...valid.slice(1)], valid.join(' ')],
    ['argv zero alias', ['/opt/bin/xcodebuild', ...valid.slice(1)], valid.join(' ')],
    ['argv zero bare', ['xcodebuild', ...valid.slice(1)], valid.join(' ')],
    [
      'scan action contradiction',
      valid,
      [spacedXcode, 'unknown-action', ...valid.slice(2)].join(' '),
    ],
    ['scan destination contradiction', valid, xcodeArgv(UDID).join(' ')],
    ['quoted scan', valid, `"${spacedXcode}" ${valid.slice(1).join(' ')}`],
    ['flattened destination words', [spacedXcode, 'test', `-destination id=${OTHER}`]],
    ['duplicate ids', [spacedXcode, 'test', '-destination', `id=${OTHER},id=${UDID}`]],
    [
      'compound destination',
      [spacedXcode, 'test', '-destination', `platform=iOS Simulator,id=${OTHER}`],
    ],
    ['named destination', [spacedXcode, 'test', '-destination', 'name=iPhone 17']],
    [
      'generic destination',
      [spacedXcode, 'test', '-destination', 'generic/platform=iOS Simulator'],
    ],
    ['mixed scope', [...valid, '-destination', 'id=not-a-udid']],
    ['oversized argv', [...valid, 'x'.repeat(8_192)]],
    ['build oversized argv', [spacedXcode, 'build', 'x'.repeat(8_192)]],
    ['build scan contradiction', [spacedXcode, 'build'], [spacedXcode, 'test'].join(' ')],
    [
      'oversized valid pairs',
      [spacedXcode, 'test', ...Array.from({ length: 180 }, () => valid.slice(2)).flat()],
    ],
  ];
  for (const [
    name,
    argv,
    shown = Array.isArray(argv) ? argv.join(' ') : valid.join(' '),
  ] of invalid) {
    await t.test(name, async () => {
      const result = await probeIosExternalRunnerAdmission(
        fakePs(`20 ${shown}\n`),
        UDID,
        async () => ({ ...xcodeIdentity(), argv }),
      );
      assert.deepEqual(result, {
        status: 'unknown',
        evidence: { reason: 'executable_identity_unproven', pid: 20 },
      });
    });
  }
});

test('unresolved Xcode revalidates identity and preserves observer failure reasons', async (t) => {
  const argv = xcodeArgv();
  const identity = xcodeIdentity();
  const scan = fakePs(`20 ${argv.join(' ')}\n`);
  const invalid = [
    null,
    { ...identity, pid: 21 },
    { ...identity, v: 2 },
    { ...identity, birth: { seconds: 0, micros: 0 } },
    { ...identity, birth: { seconds: 1, micros: -1 } },
    { ...identity, birth: { seconds: 1, micros: 1_000_000 } },
    { ...identity, birth: { seconds: 1.5, micros: 0 } },
    { ...identity, birth: { seconds: Math.ceil(Date.now() / 1_000) + 10, micros: 0 } },
    { ...identity, executable: 'relative/xcodebuild' },
    { ...identity, executable: `${spacedXcode}/` },
    { ...identity, executable: `/\0/${spacedXcode}` },
    { ...identity, executable: `/${'x'.repeat(4_096)}/xcodebuild` },
  ];
  for (const [i, value] of invalid.entries()) {
    for (const phase of ['identity', 'argv']) {
      await t.test(`invalid identity ${i} at ${phase}`, async () => {
        assert.deepEqual(
          await probeIosExternalRunnerAdmission(scan, UDID, async (_pid, _timeout, withArgv) =>
            phase === 'identity' || withArgv ? value && { ...value, argv } : identity,
          ),
          { status: 'unknown', evidence: { reason: 'executable_identity_unproven', pid: 20 } },
        );
      });
    }
  }
  for (const changed of [
    { ...identity, birth: { seconds: 2, micros: 0 } },
    { ...identity, birth: { seconds: 1, micros: 1 } },
    xcodeIdentity(spacedXcode.replace('26', '27')),
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(scan, UDID, async (_pid, _timeout, withArgv) =>
        withArgv ? { ...changed, argv: [changed.executable, ...argv.slice(1)] } : identity,
      ),
      'unknown',
    );
  }
  assert.deepEqual(await probeIosExternalRunnerAdmission(scan, UDID), {
    status: 'unknown',
    evidence: { reason: 'observer_unavailable', candidates: 1 },
  });
  for (const reason of [
    'observer_failed',
    'observer_timeout',
    'observer_stderr',
    'observer_output_oversize',
    'observer_invalid_json',
  ]) {
    for (const phase of ['identity', 'argv']) {
      await t.test(`${reason} at ${phase}`, async () => {
        assert.deepEqual(
          await probeIosExternalRunnerAdmission(scan, UDID, async (_pid, _timeout, withArgv) =>
            phase === 'identity' || withArgv ? { observationFailure: reason } : identity,
          ),
          { status: 'unknown', evidence: { reason, pid: 20 } },
        );
      });
    }
  }
  assert.deepEqual(
    await probeIosExternalRunnerAdmission(scan, UDID, async (_pid, _timeout, withArgv) => {
      if (withArgv) throw new Error(secret);
      return identity;
    }),
    { status: 'unknown', evidence: { reason: 'observer_failed', pid: 20 } },
  );
});

test('unresolved Xcode refuses container paths even with exact destination proof', async (t) => {
  const executable = `/Users/test/Library/Developer/CoreSimulator/Devices/${OTHER}/data/Xcode 26.app/Contents/Developer/usr/bin/xcodebuild`;
  for (const device of [UDID, OTHER]) {
    await t.test(device, async () => {
      const argv = xcodeArgv(device, 'test', executable);
      assert.deepEqual(
        await probeIosExternalRunnerAdmission(
          fakePs(`20 ${argv.join(' ')}\n`),
          UDID,
          async (pid, _timeout, withArgv) => ({
            ...xcodeIdentity(executable, pid),
            ...(withArgv ? { argv } : {}),
          }),
        ),
        { status: 'unknown', evidence: { reason: 'executable_identity_unproven', pid: 20 } },
        device,
      );
    });
  }
});

test('unresolved Xcode does not traverse wrappers or excuse another candidate', async () => {
  const argv = xcodeArgv();
  for (const [wrapper, expected] of [
    ['/bin/sh', 'unknown'],
    ['/usr/bin/env', 'unknown'],
    ['/usr/bin/java', 'unknown'],
    // An interpreter cannot host xcodebuild; a real one is its own row.
    ['/usr/bin/python3', 'clear'],
    ['/usr/bin/node', 'clear'],
  ] as const) {
    assert.equal(
      await probeIosExternalRunnerStrict(
        fakePs(`20 ${wrapper} ${argv.join(' ')}\n`),
        UDID,
        async () => ({ ...xcodeIdentity(wrapper), argv: [wrapper, ...argv] }),
      ),
      expected,
      wrapper,
    );
  }
  for (const [other, expected] of [
    [[spacedXcode, 'test', '-scheme', 'Example'], 'unknown'],
    [[spacedXcode, 'build'], 'clear'],
  ] as const) {
    assert.equal(
      await probeIosExternalRunnerStrict(
        fakePs(`20 ${argv.join(' ')}\n21 ${other.join(' ')}\n`),
        UDID,
        async (pid, _timeout, withArgv) => ({
          ...xcodeIdentity(spacedXcode, pid),
          ...(withArgv ? { argv: pid === 20 ? argv : other } : {}),
        }),
      ),
      expected,
    );
  }
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs(`20 ${argv.join(' ')}\n${driver('XCTRunner').replace(/^20 /, '21 ')}`),
      UDID,
      async (pid, _timeout, withArgv) => ({
        ...xcodeIdentity(spacedXcode, pid),
        ...(withArgv ? { argv } : {}),
      }),
    ),
    'busy',
  );
});

test('unresolved Xcode shares its one-second allowance and absolute probe deadline', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const argv = xcodeArgv();
  for (const [elapsed, expected, callsExpected] of [
    [400, 'clear', [1_000, 600]],
    [1_000, 'unknown', [1_000]],
    [20_000, 'unknown', [1_000]],
  ] as const) {
    now = 0;
    const timeouts: number[] = [];
    const result = await probeIosExternalRunnerAdmission(
      fakePs(`20 ${argv.join(' ')}\n`),
      UDID,
      async (_pid, timeout, withArgv) => {
        timeouts.push(timeout);
        now += withArgv ? 0 : elapsed;
        return { ...xcodeIdentity(), ...(withArgv ? { argv } : {}) };
      },
    );
    assert.equal(result.status, expected);
    if (elapsed === 1_000) assert.equal(result.evidence?.reason, 'observer_timeout');
    if (elapsed === 20_000) assert.equal(result.evidence?.reason, 'deadline_exceeded');
    assert.deepEqual(timeouts, callsExpected);
  }
  for (const [scanTime, secondReadTime, reason, expectedTimeouts] of [
    [0, 1_000, 'observer_timeout', [1_000, 600]],
    [19_500, 100, 'deadline_exceeded', [500, 100]],
  ] as const) {
    now = 0;
    const timeouts: number[] = [];
    const scan = fakePs(`20 ${argv.join(' ')}\n`);
    const delayedScan = (async (...args: Parameters<typeof execFile>) => {
      now = scanTime;
      return scan(...args);
    }) as unknown as typeof execFile;
    assert.deepEqual(
      await probeIosExternalRunnerAdmission(delayedScan, UDID, async (_pid, timeout, withArgv) => {
        timeouts.push(timeout);
        now += withArgv ? secondReadTime : 400;
        return { ...xcodeIdentity(), ...(withArgv ? { argv } : {}) };
      }),
      { status: 'unknown', evidence: { reason, pid: 20 } },
    );
    assert.deepEqual(timeouts, expectedTimeouts);
  }
  now = 0;
  const rows = Array.from({ length: 65 }, (_, i) => `${i + 20} ${argv.join(' ')}\n`).join('');
  assert.deepEqual(
    await probeIosExternalRunnerAdmission(fakePs(rows), UDID, async () => {
      assert.fail('candidate cap must precede observation');
    }),
    { status: 'unknown', evidence: { reason: 'candidate_budget_exceeded', candidates: 65 } },
  );
});

test('attested unscoped MCP controls coexist while observed device automation still blocks', async () => {
  const controls =
    '20 /usr/bin/java -classpath lib maestro.cli.AppKt mcp\n' +
    '21 /opt/jdk/bin/java -classpath lib maestro.cli.AppKt mcp\n';
  const observe = async (pid: number) => ({
    v: 1,
    pid,
    birth: { seconds: 1, micros: 0 },
    executable: pid === 20 ? '/usr/bin/java' : '/opt/jdk/bin/java',
    argv: [
      pid === 20 ? '/usr/bin/java' : '/opt/jdk/bin/java',
      '-classpath',
      'lib',
      'maestro.cli.AppKt',
      'mcp',
    ],
  });
  assert.equal(await probeIosExternalRunnerStrict(fakePs(ordinary + controls), UDID), 'unknown');
  assert.equal(
    await probeIosExternalRunnerStrict(fakePs(ordinary + controls), UDID, observe),
    'clear',
  );
  assert.equal(
    await probeIosExternalRunnerStrict(fakePs(ordinary + controls), UDID, async () => null),
    'unknown',
  );
  for (const invalid of [
    { v: 1, pid: 99, birth: { seconds: 1, micros: 0 }, executable: '/usr/bin/java' },
    { v: 1, pid: 20, birth: { seconds: 1, micros: 0 }, executable: '/usr/bin/node' },
    { v: 2, pid: 20, birth: { seconds: 1, micros: 0 }, executable: '/usr/bin/java' },
    {
      v: 1,
      pid: 20,
      birth: { seconds: Math.ceil(Date.now() / 1_000) + 10, micros: 0 },
      executable: '/usr/bin/java',
    },
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(ordinary + controls), UDID, async () => ({
        ...invalid,
        argv: ['/usr/bin/java', '-classpath', 'lib', 'maestro.cli.AppKt', 'mcp'],
      })),
      'unknown',
    );
  }
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs(ordinary + controls + driver('WebDriverAgentRunner-Runner').replace(/^20 /, '22 ')),
      UDID,
      observe,
    ),
    'busy',
  );
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs(ordinary + controls + '22 /usr/bin/java -classpath lib maestro.cli.AppKt test\n'),
      UDID,
      observe,
    ),
    'unknown',
  );
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs('20 /usr/bin/java -classpath lib maestro.cli.AppKt mcp --device ' + UDID + '\n'),
      UDID,
      observe,
    ),
    'busy',
  );
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs(`20 /usr/bin/java -classpath lib maestro.cli.AppKt --device ${UDID} mcp\n`),
      UDID,
      observe,
    ),
    'busy',
  );
});

test('MCP admission uses attested argv rather than kernel-path spelling', async () => {
  for (const launched of ['java', '/opt/java/current/bin/java', ambiguousJvms[0]]) {
    const argv = [launched, '-classpath', '/Users/Test User/lib/*', 'maestro.cli.AppKt', 'mcp'];
    const calls: Array<boolean | undefined> = [];
    const observe = async (pid: number, timeout: number, withArgv?: boolean) => {
      calls.push(withArgv);
      assert.ok(timeout > 0 && timeout <= 1_000);
      return {
        v: 1,
        pid,
        birth: { seconds: 1, micros: 0 },
        executable: '/opt/java/versions/21/bin/java',
        argv,
      };
    };
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(`20 ${argv.join(' ')}\n`), UDID, observe),
      'clear',
      launched,
    );
    // An unresolved path reads identity first and exact argv only once the kernel proves a JVM.
    assert.deepEqual(calls, launched === ambiguousJvms[0] ? [undefined, true] : [true]);
  }
  const argv = [ambiguousJvms[0], '-classpath', 'lib', 'maestro.cli.AppKt', 'mcp'];
  assert.deepEqual(
    await probeIosExternalRunnerAdmission(
      fakePs(`20 ${argv.join(' ')}\n`),
      UDID,
      async (pid, _timeout, withArgv) => ({
        v: 1,
        pid,
        birth: { seconds: 1, micros: 0 },
        executable: withArgv ? '/opt/bin/agent' : '/opt/java/versions/21/bin/java',
        argv,
      }),
    ),
    { status: 'unknown', evidence: { reason: 'executable_identity_unproven', pid: 20 } },
    'the argv read must observe the same executable',
  );
});

test('controller coexistence requires complete consistent native argv, not just Java identity', async () => {
  const argv = ['/usr/bin/java', '-classpath', 'lib', 'maestro.cli.AppKt', 'mcp'];
  const scan = fakePs(`20 ${argv.join(' ')}\n`);
  const identity = { v: 1, pid: 20, birth: { seconds: 1, micros: 0 }, executable: '/usr/bin/java' };
  for (const invalid of [
    undefined,
    null,
    [],
    'mcp',
    [null, ...argv.slice(1)],
    [...argv.slice(0, 4), 'test'],
    [...argv, '--device', UDID],
    [argv[0], '-classpath', 'lib maestro.cli.AppKt mcp'],
    [argv[0], '-classpath', '', 'maestro.cli.AppKt', 'mcp'],
    [argv[0], '-classpath', 'lib\0', 'maestro.cli.AppKt', 'mcp'],
    [argv[0], '-classpath', 'lib', 'other.Main', 'mcp'],
    [argv[0], '-classpath', 'lib', 'maestro.cli.AppKt', 'mcp', ''],
    [argv[0], '-classpath', 'x'.repeat(16_384), 'maestro.cli.AppKt', 'mcp'],
    [argv[0], '-classpath', 'lib', 'maestro.cli.Other', 'mcp'],
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(scan, UDID, async () => ({ ...identity, argv: invalid })),
      'unknown',
    );
  }
});

test('attested aliased controllers do not excuse target drivers or unresolved automation', async () => {
  const argv = ['/opt/java/current/bin/java', '-classpath', 'lib', 'maestro.cli.AppKt', 'mcp'];
  const controller = `20 ${argv.join(' ')}\n`;
  const observe = async (pid: number) => ({
    v: 1,
    pid,
    birth: { seconds: 1, micros: 0 },
    executable: '/opt/java/versions/21/bin/java',
    argv: pid === 20 ? argv : ['java', '-classpath', 'lib', 'maestro.cli.AppKt', 'test'],
  });
  for (const [other, expected] of [
    [driver('XCTRunner').replace(/^20 /, '21 '), 'busy'],
    ['21 java -classpath lib maestro.cli.AppKt test\n', 'unknown'],
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(controller + other), UDID, observe),
      expected,
    );
  }
});

test('ambiguous JVM paths preserve the Java/Maestro conjunction for CLI and MCP', async () => {
  for (const jvm of ambiguousJvms) {
    for (const quote of ['', '"', "'"]) {
      for (const mode of ['test', 'mcp']) {
        for (const scope of ['', ` --device ${UDID}`, ` --device ${OTHER}`]) {
          const command = maestroJava(`${quote}${jvm}${quote}`, mode, scope);
          assert.equal(
            await probeIosExternalRunnerStrict(fakePs(`20 ${command}\n`), UDID),
            'unknown',
            command,
          );
          assert.equal(
            await detectIosExternalRunner(fakePs(`20 ${command}\n`), UDID),
            null,
            'legacy unchanged',
          );
        }
      }
    }
  }
  for (const mode of ['test', 'mcp']) {
    for (const entrypoint of ['maestro.cli.AppKt', 'maestro.cli.AppKt$Main', 'MAESTRO.CLI.AppKt']) {
      const command = maestroJava('/usr/bin/java', mode, ` --device ${UDID}`).replace(
        'maestro.cli.AppKt',
        entrypoint,
      );
      assert.equal(await probeIosExternalRunnerStrict(fakePs(`20 ${command}\n`), UDID), 'busy');
      assert.ok(await detectIosExternalRunner(fakePs(`20 ${command}\n`), UDID));
      const ambiguous = command.replace('/usr/bin/java', ambiguousJvms[0]);
      assert.equal(
        await probeIosExternalRunnerStrict(fakePs(`20 ${ambiguous}\n`), UDID),
        'unknown',
      );
    }
  }
});

test('Java fallback requires both a java executable path fragment and the Maestro entrypoint field in one command', async () => {
  for (const jvm of ambiguousJvms) {
    for (const quote of ['', '"', "'"]) {
      for (const entrypoint of [
        'com.example.Main',
        'notmaestro.cli.AppKt',
        'maestro.cli.',
        'maestro.cli.AppKt-extra',
        '-Dentry=maestro.cli.AppKt',
        '/tmp/maestro.cli.AppKt',
      ]) {
        const command = `${quote}${jvm}${quote} -classpath /tmp/lib ${entrypoint} --device ${UDID}`;
        assert.equal(
          await probeIosExternalRunnerStrict(fakePs(`20 ${command}\n`), UDID),
          'clear',
          command,
        );
      }
      const prompt = maestroJava(`${quote}${jvm}${quote}`, 'mcp', ` --device ${UDID}`);
      assert.equal(
        await probeIosExternalRunnerStrict(fakePs(`20 /usr/bin/agent review ${prompt}\n`), UDID),
        'unknown',
      );
      for (const suffix of ['w', '-helper', '.bak']) {
        assert.equal(
          await probeIosExternalRunnerStrict(
            fakePs(`20 ${maestroJava(`${quote}${jvm}${suffix}${quote}`, 'test')}\n`),
            UDID,
          ),
          'clear',
        );
      }
    }
  }
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs(`20 /usr/bin/agent review java maestro.cli.AppKt ${UDID}\n`),
      UDID,
    ),
    'clear',
  );
  assert.equal(
    await probeIosExternalRunnerStrict(
      fakePs(
        `20 ${ambiguousJvms[0]} com.example.Main\n21 /usr/bin/agent review maestro.cli.AppKt\n`,
      ),
      UDID,
    ),
    'clear',
  );
});

test('covered-family checklist keeps every legacy and strict-only driver family non-clear under path ambiguity', async () => {
  const families = [
    ['Maestro CLI', '/tools/maestro test', true],
    ['Maestro iOS runner', '/tools/maestro-driver-iosUITests-Runner', true],
    ['Maestro shell script', '/bin/sh /tools/maestro.sh test', true],
    ['WebDriverAgent', '/tools/WebDriverAgent', true],
    ['WebDriverAgentRunner', '/tools/WebDriverAgentRunner', true],
    ['WebDriverAgent-Runner', '/tools/WebDriverAgent-Runner', true],
    ['WebDriverAgentRunner-Runner', '/tools/WebDriverAgentRunner-Runner', true],
    ['Java Maestro CLI', maestroJava('/tools/java', 'test'), true],
    ['Java Maestro MCP', maestroJava('/tools/java', 'mcp'), true],
    ['Maestro xctestrun', '/tools/xcodebuild -xctestrun /tmp/maestro-config.xctestrun', true],
    [
      'WebDriverAgent xctestrun',
      '/tools/xcodebuild -xctestrun /tmp/WebDriverAgent.xctestrun',
      true,
    ],
    ['QarenIosRunner', '/tools/QaReN-Runner', false],
    ['XCTRunner', '/tools/XCTRunner', false],
    ['generic UITests runner', '/tools/ExampleUITests-Runner', false],
    ['generic xcodebuild test', '/tools/xcodebuild test -scheme Example', false],
    [
      'generic xcodebuild test-without-building',
      '/tools/xcodebuild test-without-building -scheme Example',
      false,
    ],
  ] as const;
  for (const [family, command, legacy] of families) {
    assert.equal(isIosExternalRunnerProcessLine(`20 ${command}`), legacy, family);
    for (const scope of ['', ` --device ${UDID}`]) {
      const ambiguous = `${command.replace('/tools/', `/tools/Test 'QA' - /`)}${scope}`;
      assert.equal(
        await probeIosExternalRunnerStrict(fakePs(`20 ${ambiguous}\n`), UDID),
        'unknown',
        family,
      );
    }
  }
});

test('strict detector never clears ambiguous spaced executable paths, including quoted paths', async () => {
  for (const executable of spacedExecutables) {
    for (const quote of ['', '"', "'"]) {
      const command = `${quote}${executable}${quote} test -destination id=${UDID}`;
      const output = `20 ${command}\n`;
      assert.equal(await probeIosExternalRunnerStrict(fakePs(output), UDID), 'unknown', command);
      assert.equal(await detectIosExternalRunner(fakePs(output), UDID), null, 'legacy unchanged');
      assert.equal(
        await probeIosExternalRunnerStrict(fakePs(output.replaceAll(UDID, OTHER)), UDID),
        'unknown',
      );
      assert.equal(
        await probeIosExternalRunnerStrict(fakePs(`20 ${quote}${executable}${quote}\n`), UDID),
        'unknown',
      );
    }
  }
});

test('strict detector refuses ambiguous shell script paths and unresolved leading options', async () => {
  for (const shell of shellPrefixes) {
    for (const script of spacedShellScripts) {
      for (const quote of ['', '"', "'"]) {
        const command = `${shell} ${quote}${script}${quote} test --device ${UDID}`;
        const output = `20 ${command}\n`;
        assert.equal(await probeIosExternalRunnerStrict(fakePs(output), UDID), 'unknown', command);
        if (!script.includes(' /')) {
          assert.equal(
            await detectIosExternalRunner(fakePs(output), UDID),
            null,
            'legacy unchanged',
          );
        }
        assert.equal(
          await probeIosExternalRunnerStrict(fakePs(output.replaceAll(UDID, OTHER)), UDID),
          'unknown',
        );
      }
    }
  }
  for (const command of [
    `/bin/sh ${'-e '.repeat(40)}${spacedShellScripts[0]} test`,
    `/bin/sh --unrecognized-option ${spacedShellScripts[0]} test`,
    '/bin/sh -o',
  ]) {
    assert.equal(await probeIosExternalRunnerStrict(fakePs(`20 ${command}\n`), UDID), 'unknown');
  }
});

test('strict executable ambiguity keeps word-only prompts clear and never attributes prompt paths as busy', async () => {
  const prompts = [
    `review Maestro WebDriverAgent QarenIosRunner XCTRunner My AppUITests-Runner ${UDID}`,
    ...spacedExecutables.map((executable) => `review ${executable} test -destination id=${UDID}`),
    ...spacedShellScripts.map((script) => `review ${script} test --device ${UDID}`),
  ];
  for (const prompt of prompts) {
    for (const command of [
      `/usr/bin/agent ${prompt}`,
      `/usr/bin/agent --prompt "${prompt}"`,
      `/usr/bin/node /tmp/agent.mjs "${prompt}"`,
      `"/usr/bin/agent" --prompt "${prompt}"`,
      `/bin/sh /tmp/agent.sh --prompt "${prompt}"`,
      `/bin/bash -eu -- /tmp/agent.sh --prompt "${prompt}"`,
      `/bin/sh -c '${prompt}'`,
      `/bin/bash -lc '${prompt}'`,
    ]) {
      const status = await probeIosExternalRunnerStrict(fakePs(`20 ${command}\n`), UDID);
      if (prompt === prompts[0]) assert.equal(status, 'clear', command);
      // Unescaped ps text cannot always distinguish a driver path in argv from the executable.
      else assert.notEqual(status, 'busy', command);
    }
  }
});

test('an agent CLI is classified by kernel identity, never by its one-argument prompt', async () => {
  const prompt =
    `QA brief: run maestro test, /opt/homebrew/bin/maestro test --device ${UDID}, ` +
    `${spacedExecutables[1]} test-without-building -destination id=${UDID}, ` +
    `/tmp/build/QarenIosRunner.app/QarenIosRunner, /tmp/XCTRunner, java -cp lib maestro.cli.AppKt mcp. ` +
    'x'.repeat(9_000);
  const agents: Array<[string, string]> = [
    ['/opt/node/bin/node', `node /opt/node/bin/agent exec ${prompt}`],
    ['/usr/bin/python3', `/usr/bin/python3 /opt/bin/agent ${prompt}`],
    ['/opt/bin/agent-native', `/opt/bin/agent-native exec ${prompt}`],
  ];
  const xcodebuild = '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild';
  const realXcode = [xcodebuild, 'test-without-building', '-destination', `id=${UDID}`];
  const realMaestro = ['/opt/homebrew/bin/maestro', 'test', '--device', UDID, 'flow.yaml'];
  for (const [executable, command] of agents) {
    const row = `20 ${command}\n`;
    const observed: Array<boolean | undefined> = [];
    const observe = async (pid: number, _timeout: number, withArgv?: boolean) => {
      if (pid === 20) observed.push(withArgv);
      const argv = pid === 21 ? realXcode : pid === 22 ? realMaestro : undefined;
      return {
        v: 1,
        pid,
        birth: { seconds: 1, micros: 0 },
        executable: argv?.[0] ?? executable,
        ...(withArgv && argv ? { argv } : {}),
      };
    };
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(row), UDID, observe),
      'clear',
      executable,
    );
    assert.deepEqual(observed, [undefined], 'the prompt never needs exact argv');
    assert.equal(
      await probeIosExternalRunnerStrict(fakePs(`20 ${command.slice(0, 40)} ${UDID}\n`), UDID),
      'clear',
      'a prompt naming only the device needs no observer',
    );
    for (const real of [realXcode, realMaestro]) {
      const pid = real === realXcode ? 21 : 22;
      assert.deepEqual(
        await probeIosExternalRunnerAdmission(
          fakePs(`${row}${pid} ${real.join(' ')}\n`),
          UDID,
          observe,
        ),
        { status: 'busy', evidence: { reason: 'driver_on_selected_device', pid } },
        real[0],
      );
    }
  }
});

test('a shell running a -c string is classified by kernel identity, never by that string', async () => {
  const source =
    '/repo/packages/qaren-ios-runner/QarenIosRunner/QarenIosRunnerUITests/Runner.swift';
  const script = `sed -n 1,80p ${source}; /opt/homebrew/bin/maestro test --device ${UDID} /tmp/XCTRunner`;
  const xcodebuild = '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild';
  const realXcode = [xcodebuild, 'test-without-building', '-destination', `id=${UDID}`];
  const runner = driver('QaReN-Runner').slice(3, -1);
  for (const [executable, command] of [
    ['/bin/zsh', `/bin/zsh -lc "${script}"`],
    ['/bin/bash', `/bin/bash -c '${script} ${'x'.repeat(9_000)}'`],
    ['/bin/sh', `sh -eu -c '${script}'`],
    ['/bin/bash', `/bin/sh -eu -c '${script}'`],
    ['/bin/bash', `sh -eu -c '${script}'`],
  ]) {
    const row = `20 ${command}\n`;
    const observed: Array<boolean | undefined> = [];
    const observe = async (pid: number, _timeout: number, withArgv?: boolean) => {
      if (pid === 20) observed.push(withArgv);
      return {
        v: 1,
        pid,
        birth: { seconds: 1, micros: 0 },
        executable: pid === 21 ? xcodebuild : pid === 22 ? runner : executable,
        ...(pid === 21 && withArgv ? { argv: realXcode } : {}),
      };
    };
    assert.deepEqual(
      await probeIosExternalRunnerAdmission(fakePs(row), UDID, observe),
      { status: 'clear' },
      command.slice(0, 40),
    );
    assert.deepEqual(observed, [undefined], 'the command string never needs exact argv');
    assert.deepEqual(
      await probeIosExternalRunnerAdmission(
        fakePs(`${row}21 ${realXcode.join(' ')}\n`),
        UDID,
        observe,
      ),
      { status: 'busy', evidence: { reason: 'driver_on_selected_device', pid: 21 } },
    );
    assert.deepEqual(
      await probeIosExternalRunnerAdmission(fakePs(`${row}22 ${runner}\n`), UDID, observe),
      { status: 'busy', evidence: { reason: 'driver_on_selected_device', pid: 22 } },
    );
  }
  for (const [executable, command] of [
    ['/bin/sh', `/bin/sh /opt/homebrew/bin/maestro test --device ${OTHER}`],
    ['/bin/bash', `/bin/sh /opt/homebrew/bin/maestro test --device ${OTHER}`],
    ['/bin/bash', `/tmp/sh -c "${script}"`],
    ['/bin/zsh', `/bin/bash -lc "${script}"`],
    ['/bin/zsh', `/tmp/agent -lc "${script}"`],
    ['/tmp/XCTRunner.app/zsh', `/tmp/XCTRunner.app/zsh -c "${script}"`],
    ['/usr/bin/env', `/usr/bin/env -S "${script}"`],
  ]) {
    const observe = async (pid: number) => ({
      v: 1,
      pid,
      birth: { seconds: 1, micros: 0 },
      executable,
    });
    assert.deepEqual(
      await probeIosExternalRunnerAdmission(fakePs(`20 ${command}\n`), UDID, observe),
      { status: 'unknown', evidence: { reason: 'executable_identity_unproven', pid: 20 } },
      command,
    );
  }
});

test('strict path ambiguity scans long commands without treating length alone as relevant', async () => {
  const command = `/usr/bin/agent ${'word '.repeat(4_000)}`;
  assert.equal(await probeIosExternalRunnerStrict(fakePs(`20 ${command}\n`), UDID), 'clear');
  assert.equal(
    await probeIosExternalRunnerStrict(fakePs(`20 ${command}${spacedExecutables[0]}\n`), UDID),
    'unknown',
  );
});

test('strict probe validates the device before attempting a scan', async () => {
  let calls = 0;
  const spy = (async () => {
    calls++;
    return { stdout: ordinary };
  }) as unknown as typeof execFile;
  for (const device of [undefined, '', 'UDID', secret, `--${UDID}`, `${UDID}\n`]) {
    assert.equal(await probeIosExternalRunnerStrict(spy, device), 'unknown');
  }
  assert.equal(calls, 0);
});

async function fixture(run: (root: string, marker: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'qaren-preflight-'));
  const marker = join(root, 'called');
  try {
    await writeFile(
      join(root, 'ps'),
      `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_PS_MARKER, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_PS_MODE === 'timeout') setInterval(() => {}, 1000);
else if (process.env.FAKE_PS_MODE === 'large-table') {
  const command = '/usr/bin/agent --prompt ' + 'ordinary '.repeat(128);
  const rows = Array.from({ length: 4000 }, (_, i) => (i + 100) + ' ' + command + '\\n').join('');
  if (Buffer.byteLength(rows) <= 4 * 1024 * 1024) throw new Error('fixture must exceed 4 MB');
  process.stdout.write(rows + (process.env.FAKE_PS_TAIL || ''));
  process.stderr.write(process.env.FAKE_PS_STDERR || '');
  process.exitCode = Number(process.env.FAKE_PS_EXIT || 0);
}
else {
  process.stdout.write(process.env.FAKE_PS_MODE === 'overflow' ? 'x'.repeat(2 * 1024 * 1024) : (process.env.FAKE_PS_STDOUT || ''));
  process.stderr.write(process.env.FAKE_PS_STDERR || '');
  process.exitCode = Number(process.env.FAKE_PS_EXIT || 0);
}
`,
      { mode: 0o755 },
    );
    await run(root, marker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function invoke(
  root: string,
  marker: string,
  argv = args,
  env: Record<string, string> = {},
  nodeArgs = [entry],
) {
  return new Promise<{ code: number | string | null; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [...nodeArgs, ...argv],
        {
          env: {
            ...process.env,
            PATH: root,
            FAKE_PS_MARKER: marker,
            FAKE_PS_STDOUT: ordinary,
            ...env,
          },
          timeout: 8_000,
          encoding: 'utf8',
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? (error.code ?? null) : 0, stdout, stderr }),
      );
    },
  );
}

function assertResult(result: Awaited<ReturnType<typeof invoke>>, status: string, deviceId = UDID) {
  assert.equal(result.code, status === 'clear' ? 0 : 4);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.split('\n').length, 2, 'exactly one newline-terminated object');
  const { evidence, ...envelope } = JSON.parse(result.stdout);
  assert.deepEqual(envelope, { v: 1, platform: 'ios', deviceId, status });
  if (status === 'clear') assert.equal(evidence, undefined);
  else if (deviceId !== '') assert.equal(typeof evidence?.reason, 'string');
  assert.ok(!result.stdout.includes(secret));
}

test('ANT-599: actual admission CLI admits a complete process table over 4 MB', async () => {
  await fixture(async (root, marker) => {
    const result = await invoke(root, marker, args, { FAKE_PS_MODE: 'large-table' });
    assert.equal(JSON.parse(result.stdout).status, 'clear');
    assertResult(result, 'clear');
  });
});

test('ANT-599: oversized scans retain late conflicts and fail closed on incomplete evidence', async () => {
  await fixture(async (root, marker) => {
    for (const [env, status] of [
      [{ FAKE_PS_TAIL: driver('XCTRunner') }, 'busy'],
      [{ FAKE_PS_TAIL: driver('XCTRunner', OTHER) }, 'unknown'],
      [{ FAKE_PS_TAIL: `${driver('XCTRunner')}malformed\n` }, 'unknown'],
      [{ FAKE_PS_TAIL: '100 /usr/bin/login\n' }, 'unknown'],
      [{ FAKE_PS_TAIL: '5000 /usr/bin/lo\ufffdgin\n' }, 'unknown'],
      [{ FAKE_PS_TAIL: `${driver('XCTRunner')}5000 /usr/bin/login` }, 'unknown'],
      [{ FAKE_PS_TAIL: driver('XCTRunner'), FAKE_PS_STDERR: secret }, 'unknown'],
      [{ FAKE_PS_EXIT: '1' }, 'unknown'],
    ] as const) {
      assertResult(
        await invoke(root, marker, args, { FAKE_PS_MODE: 'large-table', ...env }),
        status,
      );
    }
  });
});

test('ANT-599: the sibling warning probe sees a driver after an oversized process table', async () => {
  await fixture(async (root, marker) => {
    const moduleUrl = new URL('../../../dist/runners/external-runner-detect.js', import.meta.url)
      .href;
    const result = await invoke(
      root,
      marker,
      [],
      { FAKE_PS_MODE: 'large-table', FAKE_PS_TAIL: driver('WebDriverAgentRunner-Runner') },
      [
        '--input-type=module',
        '--eval',
        `const { detectIosExternalRunner } = await import(${JSON.stringify(moduleUrl)});
process.stdout.write(JSON.stringify(await detectIosExternalRunner(undefined, ${JSON.stringify(UDID)})));`,
      ],
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const warning = JSON.parse(result.stdout);
    assert.equal(warning.code, 'IOS_XCUITEST_COMPETITOR');
    assert.deepEqual(warning.processLines, [driver('WebDriverAgentRunner-Runner').trim()]);
  });
});

test('real CLI runs only the fake PATH ps and agrees on exit/status without leaking diagnostics', async () => {
  await fixture(async (root, marker) => {
    for (const [env, status] of [
      [{}, 'clear'],
      [{ FAKE_PS_STDOUT: driver('WebDriverAgentRunner-Runner') }, 'busy'],
      [{ FAKE_PS_STDOUT: driver('QaReN-Runner') }, 'busy'],
      [{ FAKE_PS_STDOUT: driver('WebDriverAgentRunner-Runner', OTHER) }, 'unknown'],
      [{ FAKE_PS_STDOUT: `20 maestro mcp --output ${secret}\n` }, 'unknown'],
      [
        {
          FAKE_PS_STDOUT: `20 maestro test --device ${UDID} ${secret}\n`,
          RN_IOS_FOREIGN_GUARD: '0',
        },
        'busy',
      ],
      [{ FAKE_PS_STDOUT: '' }, 'unknown'],
      [{ FAKE_PS_STDOUT: ordinary.trimEnd() }, 'unknown'],
      [{ FAKE_PS_STDOUT: `malformed ${secret}\n` }, 'unknown'],
      [{ FAKE_PS_STDERR: secret }, 'unknown'],
      [{ FAKE_PS_EXIT: '1', FAKE_PS_STDERR: secret }, 'unknown'],
      [{ FAKE_PS_MODE: 'overflow' }, 'unknown'],
      [{ FAKE_PS_MODE: 'timeout' }, 'unknown'],
    ] as const) {
      assertResult(await invoke(root, marker, args, env), status);
    }
    const calls = (await readFile(marker, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 13);
    for (const call of calls) assert.deepEqual(JSON.parse(call), ['axww', '-o', 'pid=,command=']);
    await rm(join(root, 'ps'));
    assertResult(await invoke(root, marker), 'unknown');
  });
});

test('actual CLI refuses spaced executable paths through fake ps without leaking them', async () => {
  await fixture(async (root, marker) => {
    for (const executable of spacedExecutables) {
      for (const quote of ['', '"', "'"]) {
        assertResult(
          await invoke(root, marker, args, {
            FAKE_PS_STDOUT: `20 ${quote}${executable}${quote} test -destination id=${UDID} --log ${secret}\n`,
          }),
          'unknown',
        );
      }
    }
    for (const script of spacedShellScripts) {
      for (const quote of ['', '"', "'"]) {
        assertResult(
          await invoke(root, marker, args, {
            FAKE_PS_STDOUT: `20 /bin/sh -eu -- ${quote}${script}${quote} test --device ${UDID} --log ${secret}\n`,
          }),
          'unknown',
        );
      }
    }
  });
});

test('actual CLI refuses ambiguous JVM Maestro CLI and MCP processes, but admits non-Maestro Java', async () => {
  await fixture(async (root, marker) => {
    for (const jvm of ambiguousJvms) {
      for (const quote of ['', '"', "'"]) {
        for (const mode of ['test', 'mcp']) {
          for (const scope of ['', ` --device ${UDID}`]) {
            const command = maestroJava(`${quote}${jvm}${quote}`, mode, scope);
            assertResult(
              await invoke(root, marker, args, { FAKE_PS_STDOUT: `20 ${command}\n` }),
              'unknown',
            );
          }
        }
        assertResult(
          await invoke(root, marker, args, {
            FAKE_PS_STDOUT: `20 ${quote}${jvm}${quote} com.example.Main\n`,
          }),
          'clear',
        );
      }
    }
  });
});

test('actual CLI rejects all invalid arguments without spawning ps or reflecting their values', async () => {
  await fixture(async (root, marker) => {
    for (const invalid of [
      [],
      ['--platform', 'ios'],
      ['--device', UDID],
      [...args, '--extra'],
      ['--platform', 'android', '--device', UDID],
      ['--platform', secret, '--device', UDID],
      ['--device', UDID, '--device', OTHER],
      ['--platform', 'ios', '--platform', 'ios'],
      ['--unknown', secret, '--device', UDID],
      ['--platform=ios', '--device', UDID],
      ['--platform', 'ios', '--device', secret],
      ['--platform', 'ios', '--device', ''],
      ['--platform', 'ios', '--device', `${UDID}\n`],
      ['--platform', 'ios', '--device', 'UDID'],
      [...args, '--process-observer', 'relative'],
      [...args, '--process-observer', ''],
    ]) {
      assertResult(await invoke(root, marker, invalid), 'unknown', '');
      assert.deepEqual(await freshInstallPreflight(invalid), {
        v: 1,
        platform: 'ios',
        deviceId: '',
        status: 'unknown',
      });
    }
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  });
});

test('CLI identity disambiguation keeps observer output private and refuses unknown acquisition', async () => {
  await fixture(async (root, marker) => {
    const observer = join(root, 'observer');
    await writeFile(
      observer,
      `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_OBSERVER_MARKER, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_OBSERVER_MODE === 'timeout') setInterval(() => {}, 1000);
else {
  process.stdout.write(process.env.FAKE_OBSERVER_OUTPUT || '');
  process.stderr.write(process.env.FAKE_OBSERVER_STDERR || '');
  process.exitCode = Number(process.env.FAKE_OBSERVER_EXIT || 0);
}
`,
      { mode: 0o755 },
    );
    const output = {
      v: 1,
      pid: 20,
      birth: { seconds: 1, micros: 0 },
      executable: '/tools/agent',
    };
    const observerMarker = join(root, 'observed');
    const env = {
      FAKE_PS_STDOUT: `20 agent ${'word '.repeat(4000)}/tmp/WebDriverAgent ${secret}\n`,
      FAKE_OBSERVER_MARKER: observerMarker,
      FAKE_OBSERVER_OUTPUT: JSON.stringify(output),
    };
    for (const [change, status] of [
      [{}, 'clear'],
      [{ FAKE_OBSERVER_OUTPUT: JSON.stringify({ ...output, pid: 21 }) }, 'unknown'],
      [{ FAKE_OBSERVER_OUTPUT: JSON.stringify({ ...output, executable: '/bin/bash' }) }, 'unknown'],
      [{ FAKE_OBSERVER_OUTPUT: `not-json ${secret}` }, 'unknown'],
      [{ FAKE_OBSERVER_OUTPUT: 'x'.repeat(40_000) }, 'unknown'],
      [{ FAKE_OBSERVER_STDERR: secret }, 'unknown'],
      [{ FAKE_OBSERVER_EXIT: '4' }, 'unknown'],
      [{ FAKE_OBSERVER_MODE: 'timeout' }, 'unknown'],
    ] as const) {
      assertResult(
        await invoke(root, marker, [...args, '--process-observer', observer], {
          ...env,
          ...change,
        }),
        status,
      );
    }
    for (const call of (await readFile(observerMarker, 'utf8')).trim().split('\n'))
      assert.deepEqual(JSON.parse(call), ['--internal-process-observation', '20']);
    const inspected = {
      ...output,
      executable: '/usr/local/bin/node',
      iosPathInspection: { status: 'complete', unresolvedPath: 'absent' },
    };
    const inspectedEnv = { ...env, FAKE_PS_STDOUT: `20 node -e ${'x'.repeat(35_000)}${secret}\n` };
    for (const [observation, status] of [
      [inspected, 'clear'],
      [{ ...inspected, iosPathInspection: undefined }, 'clear'],
      [
        { ...inspected, iosPathInspection: { status: 'complete', unresolvedPath: 'present' } },
        'clear',
      ],
    ] as const) {
      assertResult(
        await invoke(root, marker, [...args, '--process-observer', observer], {
          ...inspectedEnv,
          FAKE_OBSERVER_OUTPUT: JSON.stringify(observation),
        }),
        status,
      );
    }
    const controllerArgv = [
      '/opt/java/current/bin/java',
      '-classpath',
      secret,
      'maestro.cli.AppKt',
      'mcp',
    ];
    const controllerEnv = {
      ...env,
      FAKE_PS_STDOUT: `20 ${controllerArgv.join(' ')}\n`,
      FAKE_OBSERVER_OUTPUT: JSON.stringify({
        ...output,
        executable: '/opt/java/21/bin/java',
        argv: controllerArgv,
      }),
    };
    assertResult(
      await invoke(root, marker, [...args, '--process-observer', observer], controllerEnv),
      'clear',
    );
    const calls = (await readFile(observerMarker, 'utf8')).trim().split('\n');
    assert.deepEqual(JSON.parse(calls.at(-1)!), ['--internal-process-observation', '20', '--argv']);
    assertResult(
      await invoke(root, marker, [...args, '--process-observer', observer], {
        ...controllerEnv,
        FAKE_OBSERVER_OUTPUT: JSON.stringify({ ...output, executable: '/opt/java/21/bin/java' }),
      }),
      'unknown',
    );
    await rm(observer);
    assertResult(
      await invoke(root, marker, [...args, '--process-observer', observer], env),
      'unknown',
    );
  });
});

test('direct invocation follows realpaths, preserves exact UDID, and imports have no scan or output', async () => {
  await fixture(async (root, marker) => {
    const link = join(root, 'preflight.mjs');
    await symlink(entry, link);
    assertResult(
      await invoke(root, marker, ['--device', UDID.toLowerCase(), '--platform', 'ios'], {}, [link]),
      'clear',
      UDID.toLowerCase(),
    );
    await rm(marker);
    const imported = await invoke(root, marker, [], {}, [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(entry)});`,
    ]);
    assert.deepEqual(imported, { code: 0, stdout: '', stderr: '' });
    const importer = join(root, 'importer.mts');
    await writeFile(importer, `await import(${JSON.stringify(entry)});\n`);
    assert.deepEqual(await invoke(root, marker, args, {}, [importer]), {
      code: 0,
      stdout: '',
      stderr: '',
    });
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  });
});

const SERIAL = 'emulator-5554';
const ANDROID_HEADER = 'USER PID PPID VSZ RSS WCHAN ADDR S NAME\n';
const androidIdle = `${ANDROID_HEADER}root 1 0 0 0 0 0 S init\nu0_a1 99 1 0 0 0 0 S dev.lykhoyda.rndevagent.androidrunner\nshell 101 1 0 0 0 0 S dev.lykhoyda.rndevagent.androidrunner.test\n`;
const androidRow = (name: string) => `shell 4242 1 0 0 0 0 S ${name}\n`;

function fakeAdb(result: { stdout: string } | Error): typeof execFile {
  return (async (bin: string, argv: string[], opts: object) => {
    assert.equal(bin, 'adb');
    assert.deepEqual(argv, ['-s', SERIAL, 'shell', 'ps', '-A']);
    assert.deepEqual(opts, { timeout: 2_000, encoding: 'utf8' });
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof execFile;
}

test('Android strict admission is clear only for a readable process table without a foreign driver', async () => {
  const { probeAndroidExternalRunnerAdmission } =
    await import('../../../dist/runners/external-runner-detect.js');
  assert.deepEqual(
    await probeAndroidExternalRunnerAdmission(SERIAL, fakeAdb({ stdout: androidIdle })),
    {
      status: 'clear',
    },
  );
  for (const [name, matched] of [
    ['uiautomator', 'uiautomator'],
    ['io.appium.uiautomator2.server.test', 'io.appium.uiautomator2.server.test'],
    ['dev.mobile.maestro', 'dev.mobile.maestro'],
    ['com.example.instrumentation', 'com.example.instrumentation'],
  ]) {
    assert.deepEqual(
      await probeAndroidExternalRunnerAdmission(
        SERIAL,
        fakeAdb({ stdout: `${androidIdle}${androidRow(name)}${androidRow('uiautomator')}` }),
      ),
      { status: 'busy', matched },
    );
  }
  const timeout = Object.assign(new Error('adb timed out'), { killed: true, signal: 'SIGTERM' });
  for (const result of [
    new Error('adb: device offline'),
    timeout,
    { stdout: '' },
    { stdout: ' \n\n' },
  ]) {
    assert.deepEqual(await probeAndroidExternalRunnerAdmission(SERIAL, fakeAdb(result)), {
      status: 'unknown',
    });
  }
});

test('the advisory Android detector keeps its patterns and still steps aside on failure', async () => {
  const { detectAndroidExternalRunner } =
    await import('../../../dist/runners/external-runner-detect.js');
  const exec = (stdout: string) => (async () => ({ stdout })) as unknown as typeof execFile;
  assert.equal(await detectAndroidExternalRunner(exec(androidRow('dev.mobile.maestro'))), null);
  assert.equal(await detectAndroidExternalRunner(exec(androidIdle)), null);
  assert.equal(
    (await detectAndroidExternalRunner(exec(androidRow('uiautomator'))))?.processLines.length,
    1,
  );
  const failing = (async () => {
    throw new Error('adb: device offline');
  }) as unknown as typeof execFile;
  assert.equal(await detectAndroidExternalRunner(failing), null);
});

test('CLI Android admission scans the selected emulator and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qaren-preflight-android-'));
  const marker = join(root, 'called');
  try {
    await writeFile(
      join(root, 'adb'),
      `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_ADB_MARKER, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_ADB_MODE === 'timeout') setInterval(() => {}, 1000);
else {
  process.stdout.write(process.env.FAKE_ADB_STDOUT || '');
  process.exitCode = Number(process.env.FAKE_ADB_EXIT || 0);
}
`,
      { mode: 0o755 },
    );
    const run = (argv: string[], env: Record<string, string>) =>
      new Promise<{ code: number | string | null; stdout: string; stderr: string }>((resolve) => {
        execFile(
          process.execPath,
          [entry, ...argv],
          {
            env: { ...process.env, PATH: root, FAKE_ADB_MARKER: marker, ...env },
            timeout: 8_000,
            encoding: 'utf8',
          },
          (error, stdout, stderr) =>
            resolve({ code: error ? (error.code ?? null) : 0, stdout, stderr }),
        );
      });
    const android = ['--platform', 'android', '--device', SERIAL];
    for (const [env, status] of [
      [{ FAKE_ADB_STDOUT: androidIdle }, 'clear'],
      [{ FAKE_ADB_STDOUT: `${androidIdle}${androidRow('uiautomator')}` }, 'busy'],
      [{ FAKE_ADB_STDOUT: `${androidIdle}${androidRow('dev.mobile.maestro')}` }, 'busy'],
      [{ FAKE_ADB_STDOUT: '' }, 'unknown'],
      [{ FAKE_ADB_STDOUT: androidIdle, FAKE_ADB_EXIT: '1' }, 'unknown'],
      [{ FAKE_ADB_MODE: 'timeout' }, 'unknown'],
    ] as const) {
      const result = await run(android, env);
      assert.equal(result.code, status === 'clear' ? 0 : 4, status);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {
        v: 1,
        platform: 'android',
        deviceId: SERIAL,
        status,
      });
    }
    for (const call of (await readFile(marker, 'utf8')).trim().split('\n'))
      assert.deepEqual(JSON.parse(call), ['-s', SERIAL, 'shell', 'ps', '-A']);
    await rm(marker);
    for (const invalid of [
      ['--platform', 'android', '--device', 'emulator-'],
      ['--platform', 'android', '--device', '127.0.0.1:5555'],
      ['--platform', 'android', '--device', `${SERIAL}\n`],
      ['--platform', 'android', '--device', `${SERIAL} -s other`],
      [...android, '--process-observer', '/usr/bin/true'],
    ]) {
      const result = await run(invalid, { FAKE_ADB_STDOUT: androidIdle });
      assert.equal(result.code, 4);
      assert.deepEqual(JSON.parse(result.stdout), {
        v: 1,
        platform: 'ios',
        deviceId: '',
        status: 'unknown',
      });
    }
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
