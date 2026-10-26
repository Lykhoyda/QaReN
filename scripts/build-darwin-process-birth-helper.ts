#!/usr/bin/env node
const {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { dirname, join } = require('node:path');

const repoRoot = dirname(__dirname);
const output = join(repoRoot, 'packages', 'qaren-core', 'native', 'darwin-process-birth');
const manifestOutput = `${output}.json`;
const temporaryOutput = `${output}.tmp-${process.pid}`;
const temporarySource = `${output}.c.tmp-${process.pid}`;
const source = `#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

extern char **environ;

static int same_content(int left, int right) {
  struct stat left_stat = {0};
  struct stat right_stat = {0};
  if (fstat(left, &left_stat) != 0 || fstat(right, &right_stat) != 0) return 0;
  if (!S_ISREG(left_stat.st_mode) || !S_ISREG(right_stat.st_mode) ||
      left_stat.st_size != right_stat.st_size) return 0;
  unsigned char left_buffer[16384];
  unsigned char right_buffer[16384];
  off_t offset = 0;
  while (offset < left_stat.st_size) {
    size_t wanted = sizeof(left_buffer);
    if (left_stat.st_size - offset < (off_t)wanted) wanted = (size_t)(left_stat.st_size - offset);
    ssize_t left_read = pread(left, left_buffer, wanted, offset);
    ssize_t right_read = pread(right, right_buffer, wanted, offset);
    if (left_read <= 0 || right_read != left_read ||
        memcmp(left_buffer, right_buffer, (size_t)left_read) != 0) return 0;
    offset += left_read;
  }
  return 1;
}

static int publish_if_unchanged(
    const char *target_path,
    const char *candidate_path,
    const char *expected_path,
    uint64_t expected_dev,
    uint64_t expected_ino) {
  int target = open(target_path, O_RDONLY | O_NOFOLLOW);
  int candidate = open(candidate_path, O_RDONLY | O_NOFOLLOW);
  int expected = open(expected_path, O_RDONLY | O_NOFOLLOW);
  if (target < 0 || candidate < 0 || expected < 0) return 11;

  struct stat target_stat = {0};
  struct stat candidate_stat = {0};
  if (fstat(target, &target_stat) != 0 || fstat(candidate, &candidate_stat) != 0 ||
      !S_ISREG(target_stat.st_mode) || !S_ISREG(candidate_stat.st_mode) ||
      (uint64_t)target_stat.st_dev != expected_dev ||
      (uint64_t)target_stat.st_ino != expected_ino ||
      target_stat.st_dev != candidate_stat.st_dev || !same_content(target, expected)) {
    return 10;
  }

  if (renamex_np(target_path, candidate_path, RENAME_SWAP) != 0) return 11;

  struct stat published_path = {0};
  struct stat displaced_path = {0};
  int target_is_candidate = lstat(target_path, &published_path) == 0 &&
      !S_ISLNK(published_path.st_mode) && published_path.st_dev == candidate_stat.st_dev &&
      published_path.st_ino == candidate_stat.st_ino;
  int candidate_has_expected = lstat(candidate_path, &displaced_path) == 0 &&
      !S_ISLNK(displaced_path.st_mode) && displaced_path.st_dev == target_stat.st_dev &&
      displaced_path.st_ino == target_stat.st_ino && same_content(target, expected);
  if (!target_is_candidate) return 10;
  int unchanged = candidate_has_expected;
  if (!unchanged) {
    if (renamex_np(target_path, candidate_path, RENAME_SWAP) != 0) return 12;
    return 10;
  }
  if (unlink(candidate_path) != 0) return 11;
  return 0;
}

static int link_into_directory(
    const char *candidate_path,
    const char *directory_path,
    const char *target_name,
    uint64_t expected_dev,
    uint64_t expected_ino) {
  if (!*target_name || strcmp(target_name, ".") == 0 || strcmp(target_name, "..") == 0 ||
      strchr(target_name, '/') != NULL) return 2;
  int directory = open(directory_path, O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
  int candidate = open(candidate_path, O_RDONLY | O_NOFOLLOW);
  if (directory < 0) return 10;
  if (candidate < 0) return 11;
  struct stat directory_stat = {0};
  struct stat candidate_stat = {0};
  if (fstat(directory, &directory_stat) != 0 || fstat(candidate, &candidate_stat) != 0 ||
      !S_ISDIR(directory_stat.st_mode) || !S_ISREG(candidate_stat.st_mode) ||
      (uint64_t)directory_stat.st_dev != expected_dev ||
      (uint64_t)directory_stat.st_ino != expected_ino ||
      directory_stat.st_dev != candidate_stat.st_dev) return 10;
  if (linkat(AT_FDCWD, candidate_path, directory, target_name, 0) != 0) {
    return errno == EEXIST ? 10 : 11;
  }
  int published = openat(directory, target_name, O_RDONLY | O_NOFOLLOW);
  struct stat published_stat = {0};
  if (published < 0 || fstat(published, &published_stat) != 0 ||
      published_stat.st_dev != candidate_stat.st_dev ||
      published_stat.st_ino != candidate_stat.st_ino) return 12;
  return 0;
}

static int parse_identity(const char *raw_dev, const char *raw_ino, uint64_t *dev, uint64_t *ino) {
  char *dev_end = NULL;
  char *ino_end = NULL;
  errno = 0;
  *dev = strtoull(raw_dev, &dev_end, 10);
  *ino = strtoull(raw_ino, &ino_end, 10);
  return errno == 0 && dev_end != raw_dev && *dev_end == '\\0' &&
      ino_end != raw_ino && *ino_end == '\\0';
}

static int open_verified_directory(
    const char *directory_path,
    uint64_t expected_dev,
    uint64_t expected_ino) {
  int directory = open(directory_path, O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
  struct stat opened = {0};
  if (directory < 0 || fstat(directory, &opened) != 0 || !S_ISDIR(opened.st_mode) ||
      (uint64_t)opened.st_dev != expected_dev || (uint64_t)opened.st_ino != expected_ino) {
    if (directory >= 0) close(directory);
    return -1;
  }
  return directory;
}

static int open_relative_regular(int directory, const char *relative_path) {
  size_t length = strlen(relative_path);
  if (length == 0 || length >= PATH_MAX || relative_path[0] == '/') return -1;
  char path[PATH_MAX];
  memcpy(path, relative_path, length + 1);
  int current = dup(directory);
  if (current < 0) return -1;
  char *component = path;
  while (*component) {
    char *slash = strchr(component, '/');
    if (slash) *slash = '\\0';
    if (!*component || strcmp(component, ".") == 0 || strcmp(component, "..") == 0) {
      close(current);
      return -1;
    }
    int next = openat(
        current,
        component,
        O_RDONLY | O_NOFOLLOW | (slash ? O_DIRECTORY : 0));
    close(current);
    if (next < 0) return -1;
    current = next;
    if (!slash) break;
    component = slash + 1;
  }
  struct stat opened = {0};
  if (fstat(current, &opened) != 0 || !S_ISREG(opened.st_mode)) {
    close(current);
    return -1;
  }
  return current;
}

static int write_all(int output, const void *bytes, size_t length) {
  const unsigned char *cursor = bytes;
  while (length > 0) {
    ssize_t written = write(output, cursor, length);
    if (written <= 0) return 0;
    cursor += written;
    length -= (size_t)written;
  }
  return 1;
}

static int read_directory_entry(
    const char *directory_path,
    const char *relative_path,
    uint64_t expected_dev,
    uint64_t expected_ino) {
  int directory = open_verified_directory(directory_path, expected_dev, expected_ino);
  if (directory < 0) return 10;
  int entry = open_relative_regular(directory, relative_path);
  close(directory);
  if (entry < 0) return 10;
  unsigned char buffer[16384];
  for (;;) {
    ssize_t count = read(entry, buffer, sizeof(buffer));
    if (count < 0) {
      close(entry);
      return 11;
    }
    if (count == 0) break;
    if (!write_all(STDOUT_FILENO, buffer, (size_t)count)) {
      close(entry);
      return 11;
    }
  }
  close(entry);
  return 0;
}

static int list_directory(
    const char *directory_path,
    uint64_t expected_dev,
    uint64_t expected_ino) {
  int directory = open_verified_directory(directory_path, expected_dev, expected_ino);
  if (directory < 0) return 10;
  DIR *stream = fdopendir(directory);
  if (!stream) {
    close(directory);
    return 11;
  }
  errno = 0;
  struct dirent *entry = NULL;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    size_t length = strlen(entry->d_name) + 1;
    if (!write_all(STDOUT_FILENO, entry->d_name, length)) {
      closedir(stream);
      return 11;
    }
  }
  int result = errno == 0 ? 0 : 11;
  closedir(stream);
  return result;
}

int main(int argc, char **argv) {
  if (argc >= 7 && strcmp(argv[1], "--exec-file") == 0) {
    char *dev_end = NULL;
    char *ino_end = NULL;
    errno = 0;
    uint64_t expected_dev = strtoull(argv[3], &dev_end, 10);
    uint64_t expected_ino = strtoull(argv[4], &ino_end, 10);
    if (errno != 0 || dev_end == argv[3] || *dev_end != '\\0' ||
        ino_end == argv[4] || *ino_end != '\\0' || strcmp(argv[5], "--") != 0) return 2;
    int executable = open(argv[2], O_RDONLY | O_NOFOLLOW);
    struct stat executable_stat = {0};
    if (executable < 0 || fstat(executable, &executable_stat) != 0 ||
        !S_ISREG(executable_stat.st_mode) || (uint64_t)executable_stat.st_dev != expected_dev ||
        (uint64_t)executable_stat.st_ino != expected_ino) return 10;
    struct stat path_stat = {0};
    if (lstat(argv[2], &path_stat) != 0 || S_ISLNK(path_stat.st_mode) ||
        path_stat.st_dev != executable_stat.st_dev || path_stat.st_ino != executable_stat.st_ino)
      return 10;
    argv[5] = argv[2];
    execve(argv[2], &argv[5], environ);
    return 11;
  }
  if (argc == 4 && strcmp(argv[1], "--rename-no-replace") == 0) {
    struct stat source = {0};
    if (lstat(argv[2], &source) != 0 || !S_ISDIR(source.st_mode)) return 10;
    if (renamex_np(argv[2], argv[3], RENAME_EXCL) != 0) return errno == EEXIST ? 10 : 11;
    struct stat published = {0};
    if (lstat(argv[3], &published) != 0 || published.st_dev != source.st_dev ||
        published.st_ino != source.st_ino) return 12;
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "--exchange") == 0) {
    struct stat left = {0};
    struct stat right = {0};
    if (lstat(argv[2], &left) != 0 || lstat(argv[3], &right) != 0 ||
        !S_ISDIR(left.st_mode) || !S_ISDIR(right.st_mode) || left.st_dev != right.st_dev) return 10;
    if (renamex_np(argv[2], argv[3], RENAME_SWAP) != 0) return 11;
    struct stat published_left = {0};
    struct stat published_right = {0};
    if (lstat(argv[2], &published_left) != 0 || lstat(argv[3], &published_right) != 0 ||
        published_left.st_dev != right.st_dev || published_left.st_ino != right.st_ino ||
        published_right.st_dev != left.st_dev || published_right.st_ino != left.st_ino) return 12;
    return 0;
  }
  if (argc == 7 && strcmp(argv[1], "--publish-if-unchanged") == 0) {
    char *dev_end = NULL;
    char *ino_end = NULL;
    errno = 0;
    uint64_t expected_dev = strtoull(argv[5], &dev_end, 10);
    uint64_t expected_ino = strtoull(argv[6], &ino_end, 10);
    if (errno != 0 || dev_end == argv[5] || *dev_end != '\\0' ||
        ino_end == argv[6] || *ino_end != '\\0') return 2;
    return publish_if_unchanged(argv[2], argv[3], argv[4], expected_dev, expected_ino);
  }
  if (argc == 7 && strcmp(argv[1], "--link-into-directory") == 0) {
    char *dev_end = NULL;
    char *ino_end = NULL;
    errno = 0;
    uint64_t expected_dev = strtoull(argv[5], &dev_end, 10);
    uint64_t expected_ino = strtoull(argv[6], &ino_end, 10);
    if (errno != 0 || dev_end == argv[5] || *dev_end != '\\0' ||
        ino_end == argv[6] || *ino_end != '\\0') return 2;
    return link_into_directory(argv[2], argv[3], argv[4], expected_dev, expected_ino);
  }
  if (argc == 6 && strcmp(argv[1], "--read-directory-entry") == 0) {
    uint64_t expected_dev = 0;
    uint64_t expected_ino = 0;
    if (!parse_identity(argv[4], argv[5], &expected_dev, &expected_ino)) return 2;
    return read_directory_entry(argv[2], argv[3], expected_dev, expected_ino);
  }
  if (argc == 5 && strcmp(argv[1], "--list-directory") == 0) {
    uint64_t expected_dev = 0;
    uint64_t expected_ino = 0;
    if (!parse_identity(argv[3], argv[4], &expected_dev, &expected_ino)) return 2;
    return list_directory(argv[2], expected_dev, expected_ino);
  }
  if (argc == 8 && strcmp(argv[1], "--publish-if-unchanged") == 0 &&
      strcmp(argv[7], "--hold") == 0) {
    if (printf("READY\\n") < 0 || fflush(stdout) != 0 || raise(SIGSTOP) != 0) return 4;
    char *next_argv[] = {argv[0], argv[1], argv[2], argv[3], argv[4], argv[5], argv[6]};
    return main(7, next_argv);
  }
  if (argc != 2 && (argc != 3 || strcmp(argv[2], "--hold") != 0)) return 2;

  errno = 0;
  char *end = NULL;
  long raw_pid = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\\0' || raw_pid <= 0 || raw_pid > INT32_MAX) {
    return 2;
  }

  struct proc_bsdinfo info = {0};
  int observed_size =
      proc_pidinfo((int)raw_pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (observed_size != (int)sizeof(info) || info.pbi_pid != (uint32_t)raw_pid) {
    return 3;
  }

  printf("%u:%" PRIu64 ":%" PRIu64 "\\n",
         info.pbi_pid,
         info.pbi_start_tvsec,
         info.pbi_start_tvusec);
  if (argc == 3) {
    if (fflush(stdout) != 0 || raise(SIGSTOP) != 0) return 4;
  }
  return 0;
}
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const compiler = '/usr/bin/xcrun';
const compilerVersion = 'Apple clang version 21.0.0 (clang-2100.0.123.102)';
const sdkVersion = '26.4';
const compilerArguments = [
  '--sdk',
  'macosx',
  'clang',
  '-x',
  'c',
  '<source>',
  '-Os',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-arch',
  'arm64',
  '-arch',
  'x86_64',
  '-mmacosx-version-min=11.0',
  '-isysroot',
  '<sdk>',
  '-o',
  '<output>',
];
const signer = '/usr/bin/codesign';
const signerArguments = [
  '--force',
  '--sign',
  '-',
  '--identifier',
  'dev.rn-dev-agent.process-birth',
  '<output>',
];
const recipeSha256 = sha256(
  JSON.stringify({
    sourceSha256: sha256(source),
    compiler,
    compilerVersion,
    compilerArguments,
    sdkVersion,
    uuidScheme: 'sha256-recipe-cputype-v1',
    signer,
    signerArguments,
  }),
);

function runCodesign(arguments_) {
  return spawnSync(signer, arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function detailValue(details, name) {
  const line = details
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}=`) || candidate.startsWith(`${name} `));
  return (
    line
      ?.slice(name.length)
      .replace(/^(?:=|\s+)/, '')
      .trim() ?? null
  );
}

function assignments(value) {
  return Object.fromEntries(
    [...value.matchAll(/([a-z][a-z0-9_-]*)=([^\s]+)/gi)].map((match) => [match[1], match[2]]),
  );
}

function hasExpectedArchitectureSignature(path, architecture) {
  const details = runCodesign(['--display', '--verbose=4', '--arch', architecture, path]);
  if (details.error || details.status !== 0) return false;
  const codeDirectory = assignments(detailValue(details.stderr, 'CodeDirectory') ?? '');
  const hashType = detailValue(details.stderr, 'Hash type') ?? '';
  const hashTypeFields = assignments(hashType);
  const requirementsMetadata = assignments(
    detailValue(details.stderr, 'Internal requirements') ?? '',
  );
  if (
    detailValue(details.stderr, 'Identifier') !== 'dev.rn-dev-agent.process-birth' ||
    codeDirectory.v !== '20400' ||
    codeDirectory.flags !== '0x2(adhoc)' ||
    codeDirectory.location !== 'embedded' ||
    hashType.split(/\s+/, 1)[0] !== 'sha256' ||
    hashTypeFields.size !== '32' ||
    detailValue(details.stderr, 'Hash choices') !== 'sha256' ||
    detailValue(details.stderr, 'CMSDigestType') !== '2' ||
    detailValue(details.stderr, 'Executable Segment flags') !== '0x1' ||
    detailValue(details.stderr, 'Signature') !== 'adhoc' ||
    detailValue(details.stderr, 'Info.plist') !== 'not bound' ||
    detailValue(details.stderr, 'TeamIdentifier') !== 'not set' ||
    detailValue(details.stderr, 'Sealed Resources') !== 'none' ||
    requirementsMetadata.count !== '0'
  ) {
    return false;
  }

  const requirements = runCodesign([
    '--display',
    '--arch',
    architecture,
    '--requirements',
    '-',
    path,
  ]);
  if (
    requirements.error ||
    requirements.status !== 0 ||
    !/^#\s*designated\s*=>\s*cdhash\s+H"[0-9a-f]{40}"$/i.test(requirements.stdout.trim())
  ) {
    return false;
  }

  const entitlements = runCodesign([
    '--display',
    '--arch',
    architecture,
    '--entitlements',
    '-',
    path,
  ]);
  return (
    !entitlements.error && entitlements.status === 0 && entitlements.stdout.trim().length === 0
  );
}

function hasExpectedCodeSignature(path) {
  const verification = runCodesign(['--verify', '--strict', path]);
  return (
    !verification.error &&
    verification.status === 0 &&
    ['arm64', 'x86_64'].every((architecture) =>
      hasExpectedArchitectureSignature(path, architecture),
    )
  );
}

function codeDirectoryHashes(path) {
  return ['arm64', 'x86_64'].map((architecture) => {
    const details = runCodesign(['--display', '--verbose=4', '--arch', architecture, path]);
    const cdhash = detailValue(details.stderr, 'CDHash');
    if (details.error || details.status !== 0 || !/^[0-9a-f]{40}$/i.test(cdhash ?? '')) {
      throw new Error('build-darwin-process-birth-helper: helper CDHash is invalid');
    }
    return cdhash.toLowerCase();
  });
}

function commandOutput(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message || result.stderr.trim() || `${command} exited with ${result.status}`,
    );
  }
  return result.stdout.trim();
}

function resolveSdkPath() {
  const activeCompilerVersion = commandOutput(compiler, [
    '--sdk',
    'macosx',
    'clang',
    '--version',
  ]).split('\n')[0];
  if (activeCompilerVersion !== compilerVersion) {
    throw new Error(
      `build-darwin-process-birth-helper: expected ${compilerVersion}, received ${activeCompilerVersion}`,
    );
  }
  const activeSdkVersion = commandOutput(compiler, ['--sdk', 'macosx', '--show-sdk-version']);
  if (activeSdkVersion !== sdkVersion) {
    throw new Error(
      `build-darwin-process-birth-helper: expected macOS SDK ${sdkVersion}, received ${activeSdkVersion}`,
    );
  }
  return commandOutput(compiler, ['--sdk', 'macosx', '--show-sdk-path']);
}

function verifyPackagedHelper() {
  if (!existsSync(output) || !existsSync(manifestOutput)) {
    throw new Error('build-darwin-process-birth-helper: packaged helper provenance is missing');
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestOutput, 'utf8'));
  } catch {
    throw new Error('build-darwin-process-birth-helper: helper provenance is invalid');
  }
  if (manifest.sourceSha256 !== sha256(source)) {
    throw new Error('build-darwin-process-birth-helper: packaged helper source is stale');
  }
  if (manifest.recipeSha256 !== recipeSha256) {
    throw new Error('build-darwin-process-birth-helper: packaged helper recipe is stale');
  }
  if (manifest.binarySha256 !== sha256(readFileSync(output))) {
    throw new Error('build-darwin-process-birth-helper: packaged helper binary is stale');
  }
  if (manifest.stableBinarySha256 !== stableMachOSha256(output)) {
    throw new Error('build-darwin-process-birth-helper: packaged helper content is stale');
  }
  if (
    !Array.isArray(manifest.cdhashes) ||
    manifest.cdhashes.length !== 2 ||
    !manifest.cdhashes.every((cdhash) => /^[0-9a-f]{40}$/.test(cdhash)) ||
    (process.platform === 'darwin' &&
      JSON.stringify(manifest.cdhashes) !== JSON.stringify(codeDirectoryHashes(output)))
  ) {
    throw new Error('build-darwin-process-birth-helper: packaged helper CDHashes are stale');
  }
  processMachOUuids(output, false);
  if (process.platform === 'darwin' && !hasExpectedCodeSignature(output)) {
    throw new Error('build-darwin-process-birth-helper: packaged helper signature is invalid');
  }
}

function stableMachOSha256(path) {
  const binary = Buffer.from(readFileSync(path));
  if (binary.readUInt32BE(0) !== 0xcafebabe) {
    throw new Error('build-darwin-process-birth-helper: expected a universal Mach-O helper');
  }
  const architectureCount = binary.readUInt32BE(4);
  for (let index = 0; index < architectureCount; index += 1) {
    const architectureOffset = 8 + index * 20;
    const sliceOffset = binary.readUInt32BE(architectureOffset + 8);
    const sliceSize = binary.readUInt32BE(architectureOffset + 12);
    if (binary.readUInt32LE(sliceOffset) !== 0xfeedfacf) {
      throw new Error('build-darwin-process-birth-helper: expected a 64-bit Mach-O slice');
    }
    const commandCount = binary.readUInt32LE(sliceOffset + 16);
    let commandOffset = sliceOffset + 32;
    let foundSignature = false;
    for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
      const command = binary.readUInt32LE(commandOffset);
      const commandSize = binary.readUInt32LE(commandOffset + 4);
      if (command === 0x1d && commandSize >= 16) {
        const signatureOffset = sliceOffset + binary.readUInt32LE(commandOffset + 8);
        const signatureSize = binary.readUInt32LE(commandOffset + 12);
        const signatureEnd = signatureOffset + signatureSize;
        if (
          signatureSize === 0 ||
          signatureOffset < sliceOffset ||
          signatureEnd > sliceOffset + sliceSize
        ) {
          throw new Error('build-darwin-process-birth-helper: invalid Mach-O signature');
        }
        binary.fill(0, signatureOffset, signatureEnd);
        foundSignature = true;
      }
      if (command === 0x32 && commandSize >= 24) {
        binary.writeUInt32LE(0, commandOffset + 16);
        const toolCount = binary.readUInt32LE(commandOffset + 20);
        if (commandSize < 24 + toolCount * 8) {
          throw new Error('build-darwin-process-birth-helper: invalid build-version command');
        }
        for (let toolIndex = 0; toolIndex < toolCount; toolIndex += 1) {
          binary.writeUInt32LE(0, commandOffset + 28 + toolIndex * 8);
        }
      }
      commandOffset += commandSize;
      if (commandOffset > sliceOffset + sliceSize) {
        throw new Error('build-darwin-process-birth-helper: invalid Mach-O load commands');
      }
    }
    if (!foundSignature) {
      throw new Error('build-darwin-process-birth-helper: missing Mach-O signature');
    }
  }
  return sha256(binary);
}

function processMachOUuids(path, shouldNormalize) {
  const binary = readFileSync(path);
  if (binary.readUInt32BE(0) !== 0xcafebabe) {
    throw new Error('build-darwin-process-birth-helper: expected a universal Mach-O helper');
  }
  const architectureCount = binary.readUInt32BE(4);
  for (let index = 0; index < architectureCount; index += 1) {
    const architectureOffset = 8 + index * 20;
    const cpuType = binary.readUInt32BE(architectureOffset);
    const sliceOffset = binary.readUInt32BE(architectureOffset + 8);
    const sliceSize = binary.readUInt32BE(architectureOffset + 12);
    if (binary.readUInt32LE(sliceOffset) !== 0xfeedfacf) {
      throw new Error('build-darwin-process-birth-helper: expected a 64-bit Mach-O slice');
    }
    const commandCount = binary.readUInt32LE(sliceOffset + 16);
    let commandOffset = sliceOffset + 32;
    let foundUuid = false;
    for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
      const command = binary.readUInt32LE(commandOffset);
      const commandSize = binary.readUInt32LE(commandOffset + 4);
      if (command === 0x1b && commandSize === 24) {
        const uuid = createHash('sha256')
          .update(recipeSha256)
          .update(String(cpuType))
          .digest()
          .subarray(0, 16);
        if (shouldNormalize) {
          uuid.copy(binary, commandOffset + 8);
        } else if (!binary.subarray(commandOffset + 8, commandOffset + 24).equals(uuid)) {
          throw new Error('build-darwin-process-birth-helper: packaged helper source is stale');
        }
        foundUuid = true;
      }
      commandOffset += commandSize;
      if (commandOffset > sliceOffset + sliceSize) {
        throw new Error('build-darwin-process-birth-helper: invalid Mach-O load commands');
      }
    }
    if (!foundUuid) {
      throw new Error('build-darwin-process-birth-helper: missing Mach-O UUID command');
    }
  }
  if (shouldNormalize) writeFileSync(path, binary);
}

if (process.platform !== 'darwin' || process.argv.includes('--verify-only')) {
  try {
    verifyPackagedHelper();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

const forceRebuild = process.argv.includes('--force-rebuild');
let packagedHelperCurrent = true;
try {
  verifyPackagedHelper();
} catch {
  packagedHelperCurrent = false;
}
if (packagedHelperCurrent && !forceRebuild) process.exit(0);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(temporarySource, source, { encoding: 'utf8', mode: 0o600 });
let sdkPath;
try {
  sdkPath = resolveSdkPath();
} catch (error) {
  rmSync(temporarySource, { force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const result = spawnSync(
  compiler,
  compilerArguments.map((argument) => {
    if (argument === '<source>') return temporarySource;
    if (argument === '<sdk>') return sdkPath;
    if (argument === '<output>') return temporaryOutput;
    return argument;
  }),
  {
    stdio: 'inherit',
  },
);
rmSync(temporarySource, { force: true });

if (result.error || result.status !== 0) {
  rmSync(temporaryOutput, { force: true });
  if (result.error) {
    console.error(`build-darwin-process-birth-helper: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}

processMachOUuids(temporaryOutput, true);
const signResult = spawnSync(
  signer,
  signerArguments.map((argument) => (argument === '<output>' ? temporaryOutput : argument)),
  { stdio: 'inherit' },
);
if (signResult.error || signResult.status !== 0) {
  rmSync(temporaryOutput, { force: true });
  if (signResult.error) {
    console.error(`build-darwin-process-birth-helper: ${signResult.error.message}`);
  }
  process.exit(signResult.status ?? 1);
}

chmodSync(temporaryOutput, 0o755);
if (packagedHelperCurrent) {
  const manifest = JSON.parse(readFileSync(manifestOutput, 'utf8'));
  if (stableMachOSha256(temporaryOutput) !== manifest.stableBinarySha256) {
    rmSync(temporaryOutput, { force: true });
    console.error(
      'build-darwin-process-birth-helper: source rebuild does not match packaged helper',
    );
    process.exit(1);
  }
  rmSync(temporaryOutput, { force: true });
  verifyPackagedHelper();
  process.exit(0);
}
renameSync(temporaryOutput, output);
writeFileSync(
  manifestOutput,
  `${JSON.stringify(
    {
      sourceSha256: sha256(source),
      recipeSha256,
      stableBinarySha256: stableMachOSha256(output),
      binarySha256: sha256(readFileSync(output)),
      cdhashes: codeDirectoryHashes(output),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
verifyPackagedHelper();
