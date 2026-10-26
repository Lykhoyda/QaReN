import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveTrustedSystemExecutable,
  type TrustedSystemExecutableDependencies,
} from '../util/trusted-system-executable.js';

export interface ProcessBirth {
  pid: number;
  source: 'darwin-libproc' | 'linux-proc' | 'windows-powershell';
  token: string;
}

export type ProcessBirthProbe =
  | { status: 'present'; birth: ProcessBirth }
  | { status: 'absent'; reason?: 'foreign' }
  | { status: 'unknown' };

export type ProcessSignalPermission = 'permitted' | 'denied' | 'absent' | 'unknown';

interface ProcessBirthDependencies {
  platform?: NodeJS.Platform;
  executableDependencies?: TrustedSystemExecutableDependencies;
  read?: (path: string) => string;
  readBinary?: (path: string) => Buffer;
  readDescriptor?: (fd: number) => Buffer;
  run?: (command: string, args: readonly string[]) => string;
  runVerifiedHelper?: (path: string, pid: number, requirement: string) => string;
  canonicalize?: (path: string) => string;
  lstat?: (path: string) => Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'uid'> & {
    isFile(): boolean;
  };
  helperPath?: () => string;
  open?: (path: string, flags: number) => number;
  close?: (fd: number) => void;
  fstat?: (fd: number) => Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'uid'> & {
    isFile(): boolean;
  };
  signalPermission?: (pid: number) => ProcessSignalPermission;
  uid?: number;
}

export interface VerifiedDarwinProcessBirthHelper {
  path: string;
  requirement: string;
}

export interface VerifiedNativePublicationHelper {
  path: string;
  sha256: string;
}

const DARWIN_HELPER_MANIFEST = {
  sourceSha256: 'f97feaa1c0434cd2ee31c0dce56c9308eb17f893a6a771ac1333b62fcec8b702',
  recipeSha256: '9617fe093885ac5c1043b39aa467754db8427080b52ebafea6f780535c2b3685',
  stableBinarySha256: '9887a09246c4fc9c7765ef8fee2ae30027bcf0b9227ae408e48682107e4d88b8',
  binarySha256: '49db19d9cd0ca2e7a78379c1e4b9551532d85447c043c51f06c6e03573c104ad',
  cdhashes: [
    'cebd22e7adf08990d4ff69b3156de03962d44b74',
    'e3de1b27f4da23957a3acf60ae8f01c6402bd424',
  ],
} as const;

const LINUX_PUBLICATION_HELPER_SHA256 = {
  x64: '93bcb6e186470efd2a0944756d7b2de790182b59a5dcb3377334291076ad6032',
  arm64: '1d0f2fc75e9eff675f8fd5ca329eca03950339796d2f339a4f59a85c2f97ba63',
} as const;

function defaultRun(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
  } catch (error) {
    if (
      command === '/bin/ps' &&
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 1
    ) {
      return '';
    }
    throw error;
  }
}

const VERIFIED_HELPER_SCRIPT = `
set -euo pipefail
helper_pid=
cleanup() {
  if [[ -n "$helper_pid" ]]; then
    /bin/kill -CONT "$helper_pid" 2>/dev/null || true
    /bin/kill -KILL "$helper_pid" 2>/dev/null || true
    wait "$helper_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM
coproc "$1" "$2" --hold
helper_pid=$!
IFS= read -r -p result
attempt=0
state=
while (( attempt < 100 )); do
  state=$(/bin/ps -p "$helper_pid" -o state= 2>/dev/null || true)
  [[ "$state" == T* ]] && break
  [[ -z "$state" || "$state" == Z* ]] && exit 1
  /bin/sleep 0.01
  (( attempt += 1 ))
done
[[ "$state" == T* ]]
/usr/bin/codesign --verify --strict "-R=$3" "$1" >/dev/null 2>&1
/usr/bin/codesign --verify --strict "+$helper_pid" >/dev/null 2>&1
live_cdhash=$(
  /usr/bin/codesign --display --verbose=4 "+$helper_pid" 2>&1 |
    /usr/bin/awk -F= '/^CDHash=/{print tolower($2); exit}'
)
[[ "$live_cdhash" != *[^0-9a-f]* ]]
[[ "\${#live_cdhash}" == 40 ]]
expected_cdhash="H\\"\${live_cdhash}\\""
[[ "$3" == *"$expected_cdhash"* ]]
/bin/kill -CONT "$helper_pid"
attempt=0
while (( attempt < 100 )); do
  state=$(/bin/ps -p "$helper_pid" -o state= 2>/dev/null || true)
  [[ -z "$state" || "$state" == Z* ]] && break
  /bin/sleep 0.01
  (( attempt += 1 ))
done
[[ -z "$state" || "$state" == Z* ]]
wait "$helper_pid" 2>/dev/null || true
helper_pid=
trap - EXIT HUP INT TERM
print -r -- "$result"
`;

function defaultRunVerifiedHelper(path: string, pid: number, requirement: string): string {
  return execFileSync(
    '/bin/zsh',
    ['-f', '-c', VERIFIED_HELPER_SCRIPT, 'rn-process-birth', path, String(pid), requirement],
    {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    },
  );
}

function token(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export function darwinProcessBirthHelperPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, 'native', 'darwin-process-birth'),
    join(moduleDirectory, '..', 'native', 'darwin-process-birth'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function sameFile(
  before: Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'uid'>,
  after: Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'uid'>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.uid === after.uid
  );
}

export function darwinProcessBirthRequirement(): string {
  return `(${DARWIN_HELPER_MANIFEST.cdhashes.map((cdhash) => `cdhash H"${cdhash}"`).join(' or ')})`;
}

function verifyDarwinProcessBirthHelper(
  dependencies: ProcessBirthDependencies,
): VerifiedDarwinProcessBirthHelper {
  const helper = (dependencies.helperPath ?? darwinProcessBirthHelperPath)();
  const manifestPath = `${helper}.json`;
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  const metadata = dependencies.lstat ?? lstatSync;
  const descriptorMetadata = dependencies.fstat ?? fstatSync;
  const readBinary = dependencies.readBinary ?? ((path: string) => readFileSync(path));
  const readDescriptor =
    dependencies.readDescriptor ??
    ((fd: number) => {
      const size = descriptorMetadata(fd).size;
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    });
  const open = dependencies.open ?? openSync;
  const close = dependencies.close ?? closeSync;
  const uid = dependencies.uid ?? process.getuid?.();

  if (canonicalize(helper) !== helper || canonicalize(manifestPath) !== manifestPath) {
    throw new Error('Darwin process-birth helper path is not canonical');
  }
  const helperBefore = metadata(helper);
  const manifestBefore = metadata(manifestPath);
  const trustedOwners = new Set([0, ...(uid === undefined ? [] : [uid])]);
  if (
    !helperBefore.isFile() ||
    !manifestBefore.isFile() ||
    !trustedOwners.has(helperBefore.uid) ||
    !trustedOwners.has(manifestBefore.uid) ||
    (helperBefore.mode & 0o022) !== 0 ||
    (manifestBefore.mode & 0o022) !== 0 ||
    (helperBefore.mode & 0o111) === 0
  ) {
    throw new Error('Darwin process-birth helper metadata is untrusted');
  }
  const manifestBytes = readBinary(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  if (
    Object.entries(DARWIN_HELPER_MANIFEST).some(
      ([key, expected]) => JSON.stringify(manifest[key]) !== JSON.stringify(expected),
    )
  ) {
    throw new Error('Darwin process-birth helper provenance is invalid');
  }

  const fd = open(helper, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = descriptorMetadata(fd);
    if (
      !opened.isFile() ||
      !sameFile(helperBefore, opened) ||
      createHash('sha256').update(readDescriptor(fd)).digest('hex') !==
        DARWIN_HELPER_MANIFEST.binarySha256 ||
      !sameFile(manifestBefore, metadata(manifestPath))
    ) {
      throw new Error('Darwin process-birth helper changed during verification');
    }
    return {
      path: helper,
      requirement: darwinProcessBirthRequirement(),
    };
  } finally {
    close(fd);
  }
}

export async function withVerifiedDarwinProcessBirthHelper<T>(
  callback: (helper: VerifiedDarwinProcessBirthHelper) => Promise<T>,
): Promise<T> {
  return callback(verifyDarwinProcessBirthHelper({}));
}

export function verifiedNativePublicationHelper(): VerifiedNativePublicationHelper {
  if (process.platform === 'darwin') {
    const helper = verifyDarwinProcessBirthHelper({});
    return { path: helper.path, sha256: DARWIN_HELPER_MANIFEST.binarySha256 };
  }
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
    return {
      path: verifiedLinuxPublicationHelper(process.arch),
      sha256: LINUX_PUBLICATION_HELPER_SHA256[process.arch],
    };
  }
  throw new Error('Native runner execution binding is unavailable on this platform.');
}

export function publishFileIfUnchangedDarwin(
  targetFd: number,
  targetPath: string,
  candidatePath: string,
  expectedPath: string,
): boolean {
  if (process.platform === 'linux') {
    return publishFileIfUnchangedLinux(targetFd, targetPath, candidatePath, expectedPath);
  }
  if (process.platform !== 'darwin') return false;
  const target = fstatSync(targetFd);
  if (!target.isFile()) return false;
  const helper = verifyDarwinProcessBirthHelper({});
  const boundPath = `${helper.path}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  copyFileSync(helper.path, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(boundPath, 0o700);
  try {
    const digest = createHash('sha256').update(readFileSync(boundPath)).digest('hex');
    if (digest !== DARWIN_HELPER_MANIFEST.binarySha256) {
      throw new Error('Conditional action publication helper changed before execution.');
    }
    execFileSync(
      boundPath,
      [
        '--publish-if-unchanged',
        targetPath,
        candidatePath,
        expectedPath,
        String(target.dev),
        String(target.ino),
      ],
      { stdio: 'ignore', timeout: 2_000 },
    );
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 10) return false;
    throw error;
  } finally {
    unlinkSync(boundPath);
  }
}

export function linkFileIntoVerifiedDirectory(
  directoryFd: number,
  candidatePath: string,
  targetPath: string,
): boolean {
  const directory = fstatSync(directoryFd);
  if (!directory.isDirectory() || dirname(targetPath) === targetPath) return false;
  if (process.platform === 'darwin') {
    const helper = verifyDarwinProcessBirthHelper({});
    return runVerifiedPublicationHelper(helper.path, DARWIN_HELPER_MANIFEST.binarySha256, [
      '--link-into-directory',
      candidatePath,
      dirname(targetPath),
      targetPath.slice(dirname(targetPath).length + 1),
      String(directory.dev),
      String(directory.ino),
    ]);
  }
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
    const helperPath = verifiedLinuxPublicationHelper(process.arch);
    return runVerifiedPublicationHelper(helperPath, LINUX_PUBLICATION_HELPER_SHA256[process.arch], [
      '--link-into-directory',
      candidatePath,
      dirname(targetPath),
      targetPath.slice(dirname(targetPath).length + 1),
      String(directory.dev),
      String(directory.ino),
    ]);
  }
  return false;
}

function runVerifiedPublicationHelper(
  helperPath: string,
  expectedSha256: string,
  args: readonly string[],
): boolean {
  const boundPath = `${helperPath}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  copyFileSync(helperPath, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(boundPath, 0o700);
  try {
    if (createHash('sha256').update(readFileSync(boundPath)).digest('hex') !== expectedSha256) {
      throw new Error('Conditional action publication helper changed before execution.');
    }
    execFileSync(boundPath, [...args], { stdio: 'ignore', timeout: 2_000 });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 10) return false;
    throw error;
  } finally {
    unlinkSync(boundPath);
  }
}

function verifiedFilesystemHelper(): { path: string; sha256: string } {
  if (process.platform === 'darwin') {
    const helper = verifyDarwinProcessBirthHelper({});
    return { path: helper.path, sha256: DARWIN_HELPER_MANIFEST.binarySha256 };
  }
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
    const architecture = process.arch;
    return {
      path: verifiedLinuxPublicationHelper(architecture),
      sha256: LINUX_PUBLICATION_HELPER_SHA256[architecture],
    };
  }
  throw new Error(
    `Verified directory reads are unavailable on ${process.platform}/${process.arch}.`,
  );
}

function runVerifiedFilesystemHelper(args: readonly string[]): Buffer {
  const helper = verifiedFilesystemHelper();
  const boundPath = `${helper.path}.read.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  copyFileSync(helper.path, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(boundPath, 0o700);
  try {
    if (createHash('sha256').update(readFileSync(boundPath)).digest('hex') !== helper.sha256) {
      throw new Error('Verified directory helper changed before execution.');
    }
    return execFileSync(boundPath, [...args], {
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } finally {
    unlinkSync(boundPath);
  }
}

export function readFileFromVerifiedDirectory(
  directoryPath: string,
  identity: { dev: string; ino: string },
  relativePath: string,
): Buffer {
  return runVerifiedFilesystemHelper([
    '--read-directory-entry',
    directoryPath,
    relativePath,
    identity.dev,
    identity.ino,
  ]);
}

export function listVerifiedDirectory(
  directoryPath: string,
  identity: { dev: string; ino: string },
): string[] {
  const output = runVerifiedFilesystemHelper([
    '--list-directory',
    directoryPath,
    identity.dev,
    identity.ino,
  ]);
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error('Verified directory listing was malformed.');
  return output
    .subarray(0, -1)
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0 && entry !== '.' && entry !== '..' && !entry.includes('/'));
}

function linuxConditionalPublicationHelperPath(architecture: 'x64' | 'arm64'): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const name = `linux-conditional-publication-${architecture}`;
  const candidates = [
    join(moduleDirectory, 'native', name),
    join(moduleDirectory, '..', 'native', name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function verifiedLinuxPublicationHelper(architecture: 'x64' | 'arm64'): string {
  const helperPath = linuxConditionalPublicationHelperPath(architecture);
  if (realpathSync(helperPath) !== helperPath) {
    throw new Error('Linux conditional publication helper path is not canonical.');
  }
  const before = lstatSync(helperPath);
  const uid = process.getuid?.();
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !new Set([0, ...(uid === undefined ? [] : [uid])]).has(before.uid) ||
    (before.mode & 0o022) !== 0 ||
    (before.mode & 0o111) === 0
  ) {
    throw new Error('Linux conditional publication helper metadata is untrusted.');
  }
  const helperFd = openSync(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(helperFd);
    if (
      !opened.isFile() ||
      !sameFile(before, opened) ||
      createHash('sha256').update(readFileSync(helperFd)).digest('hex') !==
        LINUX_PUBLICATION_HELPER_SHA256[architecture]
    ) {
      throw new Error('Linux conditional publication helper changed during verification.');
    }
  } finally {
    closeSync(helperFd);
  }
  return helperPath;
}

function publishFileIfUnchangedLinux(
  targetFd: number,
  targetPath: string,
  candidatePath: string,
  expectedPath: string,
): boolean {
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    return false;
  }
  const architecture = process.arch;
  const helperPath = verifiedLinuxPublicationHelper(architecture);
  const target = fstatSync(targetFd);
  if (!target.isFile()) return false;
  const boundPath = `${helperPath}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  copyFileSync(helperPath, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(boundPath, 0o700);
  try {
    if (
      createHash('sha256').update(readFileSync(boundPath)).digest('hex') !==
      LINUX_PUBLICATION_HELPER_SHA256[architecture]
    ) {
      throw new Error('Conditional action publication helper changed before execution.');
    }
    execFileSync(
      boundPath,
      [
        '--publish-if-unchanged',
        targetPath,
        candidatePath,
        expectedPath,
        String(target.dev),
        String(target.ino),
      ],
      { stdio: 'ignore', timeout: 2_000 },
    );
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 10) return false;
    throw error;
  } finally {
    unlinkSync(boundPath);
  }
}

export function readProcessBirth(
  pid: number,
  dependencies: ProcessBirthDependencies = {},
): ProcessBirth | null {
  const probe = probeProcessBirth(pid, dependencies);
  return probe.status === 'present' ? probe.birth : null;
}

export function defaultProcessSignalPermission(pid: number): ProcessSignalPermission {
  try {
    process.kill(pid, 0);
    return 'permitted';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    if (code === 'EPERM') return 'denied';
    return 'unknown';
  }
}

/** GH #792: an unreadable identity is not the same as an unprovable one. */
export function probeProcessBirth(
  pid: number,
  dependencies: ProcessBirthDependencies = {},
): ProcessBirthProbe {
  const probe = probeRecordedProcessBirth(pid, dependencies);
  if (probe.status !== 'unknown') return probe;
  // 0 and negatives address process groups, not processes.
  if (!Number.isSafeInteger(pid) || pid <= 0) return probe;
  // NOTE: POSIX only — on Windows `uv_kill` opens the target for PROCESS_TERMINATE even
  // for signal 0, so this denies a live same-user process. An unreadable identity that is
  // not disproved this way stays `unknown`; absence is the platform branches' job.
  if ((dependencies.platform ?? process.platform) === 'win32') return probe;
  const permission = (dependencies.signalPermission ?? defaultProcessSignalPermission)(pid);
  return permission === 'denied' ? { status: 'absent', reason: 'foreign' } : probe;
}

function probeRecordedProcessBirth(
  pid: number,
  dependencies: ProcessBirthDependencies,
): ProcessBirthProbe {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'unknown' };

  const platform = dependencies.platform ?? process.platform;
  const read = dependencies.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const run = dependencies.run ?? defaultRun;
  const runVerifiedHelper = dependencies.runVerifiedHelper ?? defaultRunVerifiedHelper;

  try {
    if (platform === 'darwin') {
      const observed = run('/bin/ps', ['-p', String(pid), '-o', 'pid=,state=']).trim();
      if (observed.length === 0) return { status: 'absent' };
      const observedFields = /^(\d+)(?:\s+(\S+))?$/.exec(observed);
      if (!observedFields || Number(observedFields[1]) !== pid) return { status: 'unknown' };
      // A zombie has already terminated; it runs no code and its pid cannot be
      // reused until the parent reaps it. Reporting it as absent — rather than
      // as an unreadable identity — is what lets a caller prove a stop it just
      // performed (GH #707).
      if (observedFields[2]?.startsWith('Z')) return { status: 'absent' };
      const helper = verifyDarwinProcessBirthHelper(dependencies);
      const processInfo = runVerifiedHelper(helper.path, pid, helper.requirement).trim();
      const processMatch = /^(\d+):(\d+):(\d+)$/.exec(processInfo);
      if (!processMatch || Number(processMatch[1]) !== pid) return { status: 'unknown' };
      const bootSession = run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']).trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootSession)) {
        return { status: 'unknown' };
      }
      return {
        status: 'present',
        birth: {
          pid,
          source: 'darwin-libproc',
          token: token([platform, bootSession.toLowerCase(), processMatch[2], processMatch[3]]),
        },
      };
    }

    if (platform === 'linux') {
      const boot = read('/proc/sys/kernel/random/boot_id').trim();
      let stat: string;
      try {
        stat = read(`/proc/${pid}/stat`).trim();
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? { status: 'absent' }
          : { status: 'unknown' };
      }
      const commandEnd = stat.lastIndexOf(')');
      const fields =
        commandEnd >= 0
          ? stat
              .slice(commandEnd + 1)
              .trim()
              .split(/\s+/)
          : [];
      if (fields[0] === 'Z') return { status: 'absent' };
      const started = fields[19];
      if (!boot || !started || !/^\d+$/.test(started)) return { status: 'unknown' };
      return {
        status: 'present',
        birth: { pid, source: 'linux-proc', token: token([platform, boot, started]) },
      };
    }

    if (platform === 'win32') {
      const powershell = resolveTrustedSystemExecutable(
        'powershell',
        platform,
        dependencies.executableDependencies,
      );
      if (!powershell) return { status: 'unknown' };
      const script =
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
        `if ($null -eq $p) { 'ABSENT' } else { $p.StartTime.ToUniversalTime().Ticks }`;
      const started = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script]).trim();
      if (started === 'ABSENT') return { status: 'absent' };
      if (!/^\d+$/.test(started)) return { status: 'unknown' };
      return {
        status: 'present',
        birth: { pid, source: 'windows-powershell', token: token([platform, started]) },
      };
    }
  } catch {
    return { status: 'unknown' };
  }

  return { status: 'unknown' };
}

export function processBirthMatches(
  expected: Pick<ProcessBirth, 'pid' | 'token'>,
  dependencies: ProcessBirthDependencies = {},
): boolean {
  const observed = readProcessBirth(expected.pid, dependencies);
  return observed !== null && observed.token === expected.token;
}
