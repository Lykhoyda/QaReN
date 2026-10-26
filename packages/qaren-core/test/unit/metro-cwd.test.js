import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  parseLsofPid,
  parseLsofCwd,
  cwdForPort,
  cwdForProcess,
  parseWindowsMetroRoot,
  pathMatchesRoot,
  _resetMetroCwdCacheForTest,
} from '../../dist/cdp/metro-cwd.js';

test('parseLsofPid: first numeric line from `lsof -ti` output', () => {
  assert.equal(parseLsofPid('12345\n'), 12345);
  assert.equal(parseLsofPid('12345\n12346\n'), 12345);
});

test('parseLsofPid: null on empty / non-numeric', () => {
  assert.equal(parseLsofPid(''), null);
  assert.equal(parseLsofPid('\n  \n'), null);
});

test('parseLsofCwd: extracts the n-field from `lsof -Fn` machine output', () => {
  const out = 'p12345\nfcwd\nn/Users/anton/GitHub/ix3030/test-app\n';
  assert.equal(parseLsofCwd(out), '/Users/anton/GitHub/ix3030/test-app');
});

test('parseLsofCwd: null when no n-field present', () => {
  assert.equal(parseLsofCwd('p12345\nfcwd\n'), null);
});

test('cwdForPort: composes pid→cwd via injected exec', () => {
  _resetMetroCwdCacheForTest();
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('-ti')) return '777\n';
    return 'p777\nfcwd\nn/repo/worktreeA\n';
  };
  assert.equal(
    cwdForPort(8081, exec, 'darwin', { exists: (path) => path === '/usr/sbin/lsof' }),
    '/repo/worktreeA',
  );
});

test('cwdForPort: re-resolves PID and CWD every call so PID reuse cannot retain a stale root', () => {
  _resetMetroCwdCacheForTest();
  let pidCalls = 0;
  let cwdCalls = 0;
  const exec = (cmd, args) => {
    if (args.includes('-ti')) {
      pidCalls++;
      return '777\n';
    }
    cwdCalls++;
    return 'p777\nfcwd\nn/repo/worktreeA\n';
  };
  const executableDependencies = { exists: (path) => path === '/usr/sbin/lsof' };
  cwdForPort(8081, exec, 'darwin', executableDependencies);
  cwdForPort(8081, exec, 'darwin', executableDependencies);
  assert.equal(pidCalls, 2);
  assert.equal(cwdCalls, 2);
});

test('cwdForProcess: resolves Linux process cwd through procfs', () => {
  assert.equal(
    cwdForProcess(777, 'linux', undefined, (path) => {
      assert.equal(path, '/proc/777/cwd');
      return '/repo/worktreeA';
    }),
    '/repo/worktreeA',
  );
});

test('cwdForProcess: accepts an explicit Windows Metro project root', () => {
  const powershell = 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  let command = '';
  assert.equal(
    cwdForProcess(
      777,
      'win32',
      (executable) => {
        command = executable;
        return 'node metro.js start --projectRoot "C:\\repo\\worktreeA"';
      },
      undefined,
      {
        environment: { SystemRoot: 'D:\\Windows' },
        exists: (path) => path === powershell,
      },
    ),
    resolve('C:\\repo\\worktreeA'),
  );
  assert.equal(command, powershell);
});

test('cwdForProcess: rejects a Windows Metro root inferred only from dependency layout', () => {
  const commandLine =
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\worktreeA\\node_modules\\expo\\bin\\cli" start';
  assert.equal(parseWindowsMetroRoot(commandLine), null);
  assert.equal(
    cwdForProcess(777, 'win32', () => commandLine, undefined, {
      exists: (path) => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }),
    null,
  );
});

test('cwdForPort: resolves Windows listener ownership before proving the Metro root', () => {
  const calls = [];
  const exec = (_cmd, args) => {
    calls.push(args.join(' '));
    if (args.some((arg) => arg.includes('Get-NetTCPConnection'))) return '777\n';
    return 'node metro.js start --projectRoot "C:\\repo\\worktreeA"';
  };

  assert.equal(
    cwdForPort(8081, exec, 'win32', {
      exists: (path) => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }),
    resolve('C:\\repo\\worktreeA'),
  );
  assert.equal(
    calls.some((call) => call.includes('Get-NetTCPConnection')),
    true,
  );
});

test('cwdForPort: fail-open — null when exec throws or returns junk', () => {
  _resetMetroCwdCacheForTest();
  const throwing = () => {
    throw new Error('lsof not found');
  };
  assert.equal(cwdForPort(8081, throwing), null);
  _resetMetroCwdCacheForTest();
  const noPid = (cmd, args) => (args.includes('-ti') ? '' : '');
  assert.equal(cwdForPort(8081, noPid), null);
});

test('pathMatchesRoot: equal paths match', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeA', '/repo/worktreeA'), true);
});

test('pathMatchesRoot: serving cwd nested under root matches (monorepo app subdir, both directions)', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeA/app', '/repo/worktreeA'), true);
  assert.equal(pathMatchesRoot('/repo/worktreeA', '/repo/worktreeA/app'), true);
});

test('pathMatchesRoot: sibling worktrees do NOT match (the #303 case)', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeB', '/repo/worktreeA'), false);
});

test('pathMatchesRoot: shared prefix without a separator boundary does NOT match', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeA-2', '/repo/worktreeA'), false);
});

test('pathMatchesRoot: null/undefined operands → false (fail-open)', () => {
  assert.equal(pathMatchesRoot(null, '/repo/worktreeA'), false);
  assert.equal(pathMatchesRoot('/repo/worktreeA', undefined), false);
});
