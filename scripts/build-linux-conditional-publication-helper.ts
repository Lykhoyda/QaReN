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
const outputDirectory = join(repoRoot, 'packages', 'qaren-core', 'native');
const source = `typedef unsigned long u64;
typedef long i64;
typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;

struct statx_timestamp { i64 sec; u32 nsec; int reserved; };
struct statx {
  u32 mask; u32 block_size; u64 attributes; u32 links; u32 uid; u32 gid;
  u16 mode; u16 spare0; u64 ino; u64 size; u64 blocks; u64 attributes_mask;
  struct statx_timestamp atime; struct statx_timestamp btime;
  struct statx_timestamp ctime; struct statx_timestamp mtime;
  u32 rdev_major; u32 rdev_minor; u32 dev_major; u32 dev_minor;
  u64 mount_id; u32 dio_mem_align; u32 dio_offset_align; u64 spare3[12];
};

#define AT_FDCWD -100
#define AT_EMPTY_PATH 0x1000
#define AT_SYMLINK_NOFOLLOW 0x100
#define O_RDONLY 0
#define O_NOFOLLOW 0x20000
#define O_CLOEXEC 0x80000
#define O_DIRECTORY 0x10000
#define RENAME_EXCHANGE 2
#define RENAME_NOREPLACE 1
#define STATX_BASIC_STATS 0x7ff
#define S_IFMT 0170000
#define S_IFREG 0100000
#define S_IFDIR 0040000

#if defined(__x86_64__)
#define SYS_CLOSE 3
#define SYS_PREAD64 17
#define SYS_OPENAT 257
#define SYS_LINKAT 265
#define SYS_UNLINKAT 263
#define SYS_RENAMEAT2 316
#define SYS_STATX 332
#define SYS_EXECVEAT 322
#define SYS_WRITE 1
#define SYS_GETDENTS64 217
static long syscall6(long number, long a1, long a2, long a3, long a4, long a5, long a6) {
  register long r10 __asm__("r10") = a4;
  register long r8 __asm__("r8") = a5;
  register long r9 __asm__("r9") = a6;
  long result;
  __asm__ volatile("syscall" : "=a"(result) : "a"(number), "D"(a1), "S"(a2),
                   "d"(a3), "r"(r10), "r"(r8), "r"(r9) : "rcx", "r11", "memory");
  return result;
}
__asm__(".global _start\\n_start:\\nmov (%rsp), %rdi\\nlea 8(%rsp), %rsi\\n"
        "call helper_main\\nmov %eax, %edi\\nmov $60, %eax\\nsyscall\\n");
#elif defined(__aarch64__)
#define SYS_CLOSE 57
#define SYS_PREAD64 67
#define SYS_OPENAT 56
#define SYS_LINKAT 37
#define SYS_UNLINKAT 35
#define SYS_RENAMEAT2 276
#define SYS_STATX 291
#define SYS_EXECVEAT 281
#define SYS_WRITE 64
#define SYS_GETDENTS64 61
static long syscall6(long number, long a1, long a2, long a3, long a4, long a5, long a6) {
  register long x0 __asm__("x0") = a1;
  register long x1 __asm__("x1") = a2;
  register long x2 __asm__("x2") = a3;
  register long x3 __asm__("x3") = a4;
  register long x4 __asm__("x4") = a5;
  register long x5 __asm__("x5") = a6;
  register long x8 __asm__("x8") = number;
  __asm__ volatile("svc 0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x3), "r"(x4),
                   "r"(x5), "r"(x8) : "memory");
  return x0;
}
__asm__(".global _start\\n_start:\\nldr x0, [sp]\\nadd x1, sp, #8\\n"
        "bl helper_main\\nmov x8, #93\\nsvc #0\\n");
#else
#error unsupported architecture
#endif

static long call4(long number, long a1, long a2, long a3, long a4) {
  return syscall6(number, a1, a2, a3, a4, 0, 0);
}
static long call5(long number, long a1, long a2, long a3, long a4, long a5) {
  return syscall6(number, a1, a2, a3, a4, a5, 0);
}
static int regular(const struct statx *value) { return (value->mode & S_IFMT) == S_IFREG; }
static int directory(const struct statx *value) { return (value->mode & S_IFMT) == S_IFDIR; }
static int same_file(const struct statx *left, const struct statx *right) {
  return left->ino == right->ino && left->dev_major == right->dev_major &&
      left->dev_minor == right->dev_minor;
}
static int parse_u64(const char *value, u64 *result) {
  if (!value || !*value) return 0;
  u64 parsed = 0;
  for (const char *cursor = value; *cursor; cursor++) {
    if (*cursor < '0' || *cursor > '9') return 0;
    u64 digit = (u64)(*cursor - '0');
    if (parsed > (~(u64)0 - digit) / 10) return 0;
    parsed = parsed * 10 + digit;
  }
  *result = parsed;
  return 1;
}
static int safe_name(const char *value) {
  if (!*value || (value[0] == '.' && value[1] == 0) ||
      (value[0] == '.' && value[1] == '.' && value[2] == 0)) return 0;
  for (; *value; value++) if (*value == '/') return 0;
  return 1;
}
static u64 text_length(const char *value) {
  u64 length = 0;
  while (value[length]) length++;
  return length;
}
static u64 device_number(const struct statx *value) {
  u64 major = value->dev_major;
  u64 minor = value->dev_minor;
  return ((major & 0xfff) << 8) | (minor & 0xff) |
      ((minor & ~(u64)0xff) << 12) | ((major & ~(u64)0xfff) << 32);
}
static long open_read(const char *path) {
  return call4(SYS_OPENAT, AT_FDCWD, (long)path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC, 0);
}
static int descriptor_stat(long fd, struct statx *value) {
  char empty = 0;
  return call5(SYS_STATX, fd, (long)&empty, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
               STATX_BASIC_STATS, (long)value) == 0;
}
static int write_all(const void *bytes, u64 size) {
  const u8 *cursor = bytes;
  while (size > 0) {
    long written = syscall6(SYS_WRITE, 1, (long)cursor, size, 0, 0, 0);
    if (written <= 0) return 0;
    cursor += written;
    size -= (u64)written;
  }
  return 1;
}
static long open_verified_directory(const char *path, u64 expected_dev, u64 expected_ino) {
  long directory_fd = call4(
      SYS_OPENAT, AT_FDCWD, (long)path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_DIRECTORY, 0);
  struct statx directory_stat;
  if (directory_fd < 0 || !descriptor_stat(directory_fd, &directory_stat) ||
      !directory(&directory_stat) || device_number(&directory_stat) != expected_dev ||
      directory_stat.ino != expected_ino) {
    if (directory_fd >= 0) syscall6(SYS_CLOSE, directory_fd, 0, 0, 0, 0, 0);
    return -1;
  }
  return directory_fd;
}
static long open_relative_regular(long directory_fd, const char *relative_path) {
  if (!*relative_path || *relative_path == '/') return -1;
  long current = directory_fd;
  const char *cursor = relative_path;
  for (;;) {
    char component[256];
    u64 length = 0;
    while (cursor[length] && cursor[length] != '/') {
      if (length + 1 >= sizeof(component)) return -1;
      component[length] = cursor[length];
      length++;
    }
    component[length] = 0;
    if (!safe_name(component)) return -1;
    int last = cursor[length] == 0;
    long next = call4(
        SYS_OPENAT,
        current,
        (long)component,
        O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (last ? 0 : O_DIRECTORY),
        0);
    if (current != directory_fd) syscall6(SYS_CLOSE, current, 0, 0, 0, 0, 0);
    if (next < 0) return -1;
    current = next;
    if (last) break;
    cursor += length + 1;
    if (!*cursor) {
      syscall6(SYS_CLOSE, current, 0, 0, 0, 0, 0);
      return -1;
    }
  }
  struct statx opened;
  if (!descriptor_stat(current, &opened) || !regular(&opened)) {
    syscall6(SYS_CLOSE, current, 0, 0, 0, 0, 0);
    return -1;
  }
  return current;
}
struct linux_dirent64 {
  u64 ino;
  i64 offset;
  u16 record_length;
  u8 type;
  char name[];
};
static int read_directory_entry(
    const char *directory_path,
    const char *relative_path,
    u64 expected_dev,
    u64 expected_ino) {
  long directory_fd = open_verified_directory(directory_path, expected_dev, expected_ino);
  if (directory_fd < 0) return 10;
  long entry_fd = open_relative_regular(directory_fd, relative_path);
  syscall6(SYS_CLOSE, directory_fd, 0, 0, 0, 0, 0);
  if (entry_fd < 0) return 10;
  u8 buffer[16384];
  u64 offset = 0;
  for (;;) {
    long count = call4(SYS_PREAD64, entry_fd, (long)buffer, sizeof(buffer), offset);
    if (count < 0) return 11;
    if (count == 0) break;
    if (!write_all(buffer, (u64)count)) return 11;
    offset += (u64)count;
  }
  syscall6(SYS_CLOSE, entry_fd, 0, 0, 0, 0, 0);
  return 0;
}
static int list_directory(const char *directory_path, u64 expected_dev, u64 expected_ino) {
  long directory_fd = open_verified_directory(directory_path, expected_dev, expected_ino);
  if (directory_fd < 0) return 10;
  u8 buffer[16384];
  for (;;) {
    long count = syscall6(SYS_GETDENTS64, directory_fd, (long)buffer, sizeof(buffer), 0, 0, 0);
    if (count < 0) return 11;
    if (count == 0) break;
    long offset = 0;
    while (offset < count) {
      struct linux_dirent64 *entry = (struct linux_dirent64 *)(buffer + offset);
      if (entry->record_length == 0 || offset + entry->record_length > count) return 11;
      if (!(entry->name[0] == '.' && entry->name[1] == 0) &&
          !(entry->name[0] == '.' && entry->name[1] == '.' && entry->name[2] == 0)) {
        u64 length = text_length(entry->name) + 1;
        if (!write_all(entry->name, length)) return 11;
      }
      offset += entry->record_length;
    }
  }
  syscall6(SYS_CLOSE, directory_fd, 0, 0, 0, 0, 0);
  return 0;
}
static int path_stat(const char *path, struct statx *value) {
  long fd = open_read(path);
  if (fd < 0) return 0;
  int ok = descriptor_stat(fd, value);
  syscall6(SYS_CLOSE, fd, 0, 0, 0, 0, 0);
  return ok;
}
static int equal_bytes(const u8 *left, const u8 *right, u64 size) {
  for (u64 index = 0; index < size; index++) if (left[index] != right[index]) return 0;
  return 1;
}
static int same_content(long left, long right) {
  struct statx left_stat;
  struct statx right_stat;
  if (!descriptor_stat(left, &left_stat) || !descriptor_stat(right, &right_stat) ||
      !regular(&left_stat) || !regular(&right_stat) || left_stat.size != right_stat.size) return 0;
  u8 left_buffer[4096];
  u8 right_buffer[4096];
  u64 offset = 0;
  while (offset < left_stat.size) {
    u64 wanted = left_stat.size - offset;
    if (wanted > sizeof(left_buffer)) wanted = sizeof(left_buffer);
    long left_read = call4(SYS_PREAD64, left, (long)left_buffer, wanted, offset);
    long right_read = call4(SYS_PREAD64, right, (long)right_buffer, wanted, offset);
    if (left_read <= 0 || right_read != left_read ||
        !equal_bytes(left_buffer, right_buffer, (u64)left_read)) return 0;
    offset += (u64)left_read;
  }
  return 1;
}

__attribute__((visibility("hidden"))) int helper_main(long argc, char **argv) {
  if (argc >= 7 && argv[1][0] == '-' && argv[1][1] == '-' && argv[1][2] == 'e' &&
      argv[1][3] == 'x' && argv[1][4] == 'e' && argv[1][5] == 'c' &&
      argv[1][6] == '-' && argv[1][7] == 'f' && argv[1][8] == 'i' &&
      argv[1][9] == 'l' && argv[1][10] == 'e' && argv[1][11] == 0) {
    long executable_fd = open_read(argv[2]);
    struct statx executable_stat;
    u64 expected_dev;
    u64 expected_ino;
    if (executable_fd < 0 || !parse_u64(argv[3], &expected_dev) ||
        !parse_u64(argv[4], &expected_ino) || argv[5][0] != '-' || argv[5][1] != '-' ||
        argv[5][2] != 0 ||
        !descriptor_stat(executable_fd, &executable_stat) || !regular(&executable_stat) ||
        device_number(&executable_stat) != expected_dev || executable_stat.ino != expected_ino)
      return 10;
    argv[5] = argv[2];
    char **environment = argv + argc + 1;
    char empty = 0;
    syscall6(SYS_EXECVEAT, executable_fd, (long)&empty, (long)&argv[5],
             (long)environment, AT_EMPTY_PATH, 0);
    return 11;
  }
  if (argc == 4 && argv[1][0] == '-' && argv[1][1] == '-' && argv[1][2] == 'r' &&
      argv[1][3] == 'e' && argv[1][4] == 'n' && argv[1][5] == 'a' &&
      argv[1][6] == 'm' && argv[1][7] == 'e' && argv[1][8] == '-' &&
      argv[1][9] == 'n' && argv[1][10] == 'o' && argv[1][11] == '-' &&
      argv[1][12] == 'r' && argv[1][13] == 'e' && argv[1][14] == 'p' &&
      argv[1][15] == 'l' && argv[1][16] == 'a' && argv[1][17] == 'c' &&
      argv[1][18] == 'e' && argv[1][19] == 0) {
    struct statx source_stat;
    if (!path_stat(argv[2], &source_stat) || !directory(&source_stat)) return 10;
    long result = syscall6(SYS_RENAMEAT2, AT_FDCWD, (long)argv[2], AT_FDCWD,
                           (long)argv[3], RENAME_NOREPLACE, 0);
    if (result != 0) return result == -17 ? 10 : 11;
    struct statx published_stat;
    if (!path_stat(argv[3], &published_stat) || !same_file(&published_stat, &source_stat)) return 12;
    return 0;
  }
  if (argc == 4 && argv[1][0] == '-' && argv[1][1] == '-' && argv[1][2] == 'e' &&
      argv[1][3] == 'x' && argv[1][4] == 'c' && argv[1][5] == 'h' &&
      argv[1][6] == 'a' && argv[1][7] == 'n' && argv[1][8] == 'g' &&
      argv[1][9] == 'e' && argv[1][10] == 0) {
    struct statx left_stat;
    struct statx right_stat;
    if (!path_stat(argv[2], &left_stat) || !path_stat(argv[3], &right_stat) ||
        !directory(&left_stat) || !directory(&right_stat) ||
        left_stat.dev_major != right_stat.dev_major || left_stat.dev_minor != right_stat.dev_minor)
      return 10;
    if (syscall6(SYS_RENAMEAT2, AT_FDCWD, (long)argv[2], AT_FDCWD,
                 (long)argv[3], RENAME_EXCHANGE, 0) != 0) return 11;
    struct statx published_left;
    struct statx published_right;
    if (!path_stat(argv[2], &published_left) || !path_stat(argv[3], &published_right) ||
        !same_file(&published_left, &right_stat) || !same_file(&published_right, &left_stat))
      return 12;
    return 0;
  }
  if (argc == 7 && argv[1][0] == '-' && argv[1][1] == '-' && argv[1][2] == 'l' &&
      argv[1][3] == 'i' && argv[1][4] == 'n' && argv[1][5] == 'k' &&
      argv[1][6] == '-' && argv[1][7] == 'i' && argv[1][8] == 'n' &&
      argv[1][9] == 't' && argv[1][10] == 'o' && argv[1][11] == '-' &&
      argv[1][12] == 'd' && argv[1][13] == 'i' && argv[1][14] == 'r' &&
      argv[1][15] == 'e' && argv[1][16] == 'c' && argv[1][17] == 't' &&
      argv[1][18] == 'o' && argv[1][19] == 'r' && argv[1][20] == 'y' &&
      argv[1][21] == 0) {
    if (!safe_name(argv[4])) return 2;
    long directory_fd = open_read(argv[3]);
    long candidate_fd = open_read(argv[2]);
    struct statx directory_stat;
    struct statx candidate_stat;
    u64 expected_dev;
    u64 expected_ino;
    if (directory_fd < 0) return 10;
    if (candidate_fd < 0 || !parse_u64(argv[5], &expected_dev) ||
        !parse_u64(argv[6], &expected_ino)) return 2;
    if (!descriptor_stat(directory_fd, &directory_stat) ||
        !descriptor_stat(candidate_fd, &candidate_stat) || !directory(&directory_stat) ||
        !regular(&candidate_stat) || device_number(&directory_stat) != expected_dev ||
        directory_stat.ino != expected_ino ||
        directory_stat.dev_major != candidate_stat.dev_major ||
        directory_stat.dev_minor != candidate_stat.dev_minor) return 10;
    long result = call5(SYS_LINKAT, AT_FDCWD, (long)argv[2], directory_fd, (long)argv[4], 0);
    if (result != 0) return result == -17 ? 10 : 11;
    long published_fd = call4(SYS_OPENAT, directory_fd, (long)argv[4],
                              O_RDONLY | O_NOFOLLOW | O_CLOEXEC, 0);
    struct statx published_stat;
    if (published_fd < 0 || !descriptor_stat(published_fd, &published_stat) ||
        !same_file(&published_stat, &candidate_stat)) return 12;
    return 0;
  }
  if (argc == 6 && argv[1][0] == '-' && argv[1][1] == '-' && argv[1][2] == 'r' &&
      argv[1][3] == 'e' && argv[1][4] == 'a' && argv[1][5] == 'd' &&
      argv[1][6] == '-' && argv[1][7] == 'd' && argv[1][8] == 'i' &&
      argv[1][9] == 'r' && argv[1][10] == 'e' && argv[1][11] == 'c' &&
      argv[1][12] == 't' && argv[1][13] == 'o' && argv[1][14] == 'r' &&
      argv[1][15] == 'y' && argv[1][16] == '-' && argv[1][17] == 'e' &&
      argv[1][18] == 'n' && argv[1][19] == 't' && argv[1][20] == 'r' &&
      argv[1][21] == 'y' && argv[1][22] == 0) {
    u64 expected_dev;
    u64 expected_ino;
    if (!parse_u64(argv[4], &expected_dev) || !parse_u64(argv[5], &expected_ino)) return 2;
    return read_directory_entry(argv[2], argv[3], expected_dev, expected_ino);
  }
  if (argc == 5 && argv[1][0] == '-' && argv[1][1] == '-' && argv[1][2] == 'l' &&
      argv[1][3] == 'i' && argv[1][4] == 's' && argv[1][5] == 't' &&
      argv[1][6] == '-' && argv[1][7] == 'd' && argv[1][8] == 'i' &&
      argv[1][9] == 'r' && argv[1][10] == 'e' && argv[1][11] == 'c' &&
      argv[1][12] == 't' && argv[1][13] == 'o' && argv[1][14] == 'r' &&
      argv[1][15] == 'y' && argv[1][16] == 0) {
    u64 expected_dev;
    u64 expected_ino;
    if (!parse_u64(argv[3], &expected_dev) || !parse_u64(argv[4], &expected_ino)) return 2;
    return list_directory(argv[2], expected_dev, expected_ino);
  }
  if (argc != 7) return 2;
  const char *target_path = argv[2];
  const char *candidate_path = argv[3];
  const char *expected_path = argv[4];
  long target = open_read(target_path);
  long candidate = open_read(candidate_path);
  long expected = open_read(expected_path);
  if (target < 0 || candidate < 0 || expected < 0) return 11;
  struct statx target_stat;
  struct statx candidate_stat;
  u64 expected_dev;
  u64 expected_ino;
  if (!parse_u64(argv[5], &expected_dev) || !parse_u64(argv[6], &expected_ino)) return 2;
  if (!descriptor_stat(target, &target_stat) || !descriptor_stat(candidate, &candidate_stat) ||
      !regular(&target_stat) || !regular(&candidate_stat) ||
      device_number(&target_stat) != expected_dev || target_stat.ino != expected_ino ||
      target_stat.dev_major != candidate_stat.dev_major ||
      target_stat.dev_minor != candidate_stat.dev_minor || !same_content(target, expected)) return 10;
  if (syscall6(SYS_RENAMEAT2, AT_FDCWD, (long)target_path, AT_FDCWD,
               (long)candidate_path, RENAME_EXCHANGE, 0) != 0) return 11;
  struct statx published_stat;
  struct statx displaced_stat;
  int target_is_candidate = path_stat(target_path, &published_stat) &&
      same_file(&published_stat, &candidate_stat);
  int candidate_has_expected = path_stat(candidate_path, &displaced_stat) &&
      same_file(&displaced_stat, &target_stat) && same_content(target, expected);
  if (!target_is_candidate) return 10;
  if (!candidate_has_expected) {
    if (syscall6(SYS_RENAMEAT2, AT_FDCWD, (long)target_path, AT_FDCWD,
                 (long)candidate_path, RENAME_EXCHANGE, 0) != 0) return 12;
    return 10;
  }
  if (call4(SYS_UNLINKAT, AT_FDCWD, (long)candidate_path, 0, 0) != 0) return 11;
  return 0;
}
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const compiler = '/usr/bin/clang';
const compilerVersion = 'Apple clang version 21.0.0 (clang-2100.0.123.102)';
const compilerArguments = [
  '-target',
  '<target>',
  '-x',
  'c',
  '<source>',
  '-c',
  '-Os',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-ffreestanding',
  '-fno-builtin',
  '-fno-stack-protector',
  '-fno-asynchronous-unwind-tables',
  '-fno-unwind-tables',
  '-fno-exceptions',
  '-o',
  '<output>',
];
const architectures = {
  x64: { target: 'x86_64-linux-gnu', elfMachine: 62 },
  arm64: { target: 'aarch64-linux-gnu', elfMachine: 183 },
};

function recipeSha256(settings) {
  return sha256(
    JSON.stringify({
      sourceSha256: sha256(source),
      compiler,
      compilerVersion,
      compilerArguments,
      target: settings.target,
      elfFormat: 'single-rx-segment-v1',
    }),
  );
}
function outputFor(architecture) {
  return join(outputDirectory, `linux-conditional-publication-${architecture}`);
}
function manifestFor(architecture) {
  return `${outputFor(architecture)}.json`;
}

function section(binary, name) {
  const sectionOffset = Number(binary.readBigUInt64LE(40));
  const sectionSize = binary.readUInt16LE(58);
  const sectionCount = binary.readUInt16LE(60);
  const namesIndex = binary.readUInt16LE(62);
  const header = (index) => sectionOffset + index * sectionSize;
  const namesHeader = header(namesIndex);
  const namesOffset = Number(binary.readBigUInt64LE(namesHeader + 24));
  for (let index = 0; index < sectionCount; index++) {
    const offset = header(index);
    const nameOffset = namesOffset + binary.readUInt32LE(offset);
    let end = nameOffset;
    while (binary[end] !== 0) end++;
    if (binary.toString('utf8', nameOffset, end) !== name) continue;
    return {
      index,
      header: offset,
      offset: Number(binary.readBigUInt64LE(offset + 24)),
      size: Number(binary.readBigUInt64LE(offset + 32)),
      link: binary.readUInt32LE(offset + 40),
      entrySize: Number(binary.readBigUInt64LE(offset + 56)),
    };
  }
  throw new Error(`missing ${name} section`);
}

function executableFromObject(path, expectedMachine) {
  const object = readFileSync(path);
  if (object.readUInt16LE(18) !== expectedMachine)
    throw new Error('unexpected object architecture');
  const text = section(object, '.text');
  const code = Buffer.from(object.subarray(text.offset, text.offset + text.size));
  for (const name of ['.rela.text', '.rel.text']) {
    try {
      const relocations = section(object, name);
      if (name === '.rel.text' && relocations.size !== 0) throw new Error(`unsupported ${name}`);
      const sectionOffset = Number(object.readBigUInt64LE(40));
      const sectionSize = object.readUInt16LE(58);
      const symbolHeader = sectionOffset + relocations.link * sectionSize;
      const symbolOffset = Number(object.readBigUInt64LE(symbolHeader + 24));
      const symbolEntrySize = Number(object.readBigUInt64LE(symbolHeader + 56));
      for (let offset = 0; offset < relocations.size; offset += relocations.entrySize) {
        const relocation = relocations.offset + offset;
        const place = Number(object.readBigUInt64LE(relocation));
        const info = object.readBigUInt64LE(relocation + 8);
        const symbolIndex = Number(info >> 32n);
        const type = Number(info & 0xffffffffn);
        const addend = Number(object.readBigInt64LE(relocation + 16));
        const symbol = symbolOffset + symbolIndex * symbolEntrySize;
        const value = Number(object.readBigUInt64LE(symbol + 8));
        const displacement = value + addend - place;
        if (expectedMachine === 62 && type === 4) {
          code.writeInt32LE(displacement, place);
        } else if (expectedMachine === 183 && type === 283 && displacement % 4 === 0) {
          const instruction = code.readUInt32LE(place);
          code.writeUInt32LE(
            ((instruction & 0xfc000000) | ((displacement >> 2) & 0x03ffffff)) >>> 0,
            place,
          );
        } else {
          throw new Error(`unsupported ELF relocation ${type}`);
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('missing ')) throw error;
    }
  }
  const codeOffset = 0x1000;
  const base = 0x400000;
  const executable = Buffer.alloc(codeOffset + code.length);
  executable.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  executable.writeUInt16LE(2, 16);
  executable.writeUInt16LE(expectedMachine, 18);
  executable.writeUInt32LE(1, 20);
  executable.writeBigUInt64LE(BigInt(base + codeOffset), 24);
  executable.writeBigUInt64LE(64n, 32);
  executable.writeUInt16LE(64, 52);
  executable.writeUInt16LE(56, 54);
  executable.writeUInt16LE(1, 56);
  executable.writeUInt32LE(1, 64);
  executable.writeUInt32LE(5, 68);
  executable.writeBigUInt64LE(BigInt(base), 80);
  executable.writeBigUInt64LE(BigInt(base), 88);
  executable.writeBigUInt64LE(BigInt(executable.length), 96);
  executable.writeBigUInt64LE(BigInt(executable.length), 104);
  executable.writeBigUInt64LE(0x1000n, 112);
  code.copy(executable, codeOffset);
  return executable;
}

function verifyPackagedHelper(architecture, settings) {
  const output = outputFor(architecture);
  const manifestPath = manifestFor(architecture);
  if (!existsSync(output) || !existsSync(manifestPath))
    throw new Error(`missing ${architecture} helper`);
  const binary = readFileSync(output);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.sourceSha256 !== sha256(source) ||
    manifest.recipeSha256 !== recipeSha256(settings) ||
    manifest.binarySha256 !== sha256(binary) ||
    binary.readUInt32BE(0) !== 0x7f454c46 ||
    binary[4] !== 2 ||
    binary[5] !== 1 ||
    binary.readUInt16LE(18) !== settings.elfMachine
  ) {
    throw new Error(`stale ${architecture} helper`);
  }
}

const forceRebuild = process.argv.includes('--force-rebuild');
if (!forceRebuild) {
  try {
    for (const [architecture, settings] of Object.entries(architectures))
      verifyPackagedHelper(architecture, settings);
  } catch (error) {
    console.error(
      `build-linux-conditional-publication-helper: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

mkdirSync(outputDirectory, { recursive: true });
for (const [architecture, settings] of Object.entries(architectures)) {
  const output = outputFor(architecture);
  const sourcePath = `${output}.c.tmp-${process.pid}`;
  const objectPath = `${output}.o.tmp-${process.pid}`;
  const temporaryOutput = `${output}.tmp-${process.pid}`;
  writeFileSync(sourcePath, source, { encoding: 'utf8', mode: 0o600 });
  const result = spawnSync(
    compiler,
    compilerArguments.map((argument) => {
      if (argument === '<target>') return settings.target;
      if (argument === '<source>') return sourcePath;
      if (argument === '<output>') return objectPath;
      return argument;
    }),
    { stdio: 'inherit' },
  );
  rmSync(sourcePath, { force: true });
  if (result.error || result.status !== 0) {
    rmSync(objectPath, { force: true });
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
  writeFileSync(temporaryOutput, executableFromObject(objectPath, settings.elfMachine));
  rmSync(objectPath, { force: true });
  chmodSync(temporaryOutput, 0o755);
  renameSync(temporaryOutput, output);
  writeFileSync(
    manifestFor(architecture),
    `${JSON.stringify(
      {
        sourceSha256: sha256(source),
        recipeSha256: recipeSha256(settings),
        binarySha256: sha256(readFileSync(output)),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  verifyPackagedHelper(architecture, settings);
}
