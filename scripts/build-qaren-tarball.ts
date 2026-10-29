#!/usr/bin/env node
// Builds a reproducible macOS CLI runtime; copyDarwinNative owns its native-helper inventory.
//
// Usage:
//   node scripts/build-qaren-tarball.ts --version <v> --platform darwin-arm64 \
//     [--runner-manifest <runner-manifest.json>] [--out-dir <dir>]
//
// Prints name=, sha256= and bytes= lines on stdout; build logs go to stderr.
// Two builds of one commit with the same toolchain produce identical bytes.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const CORE_DIST = join(ROOT, 'packages', 'qaren-core', 'dist');
const CLI_DIR = join(ROOT, 'packages', 'qaren-cli');

export const RUST_TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
} as const;
export type QarenPlatform = keyof typeof RUST_TARGETS;

// Every entry the CLI spawns from its runtime directory (packages/qaren-cli/src/core.rs).
export const SPAWNED_ENTRIES = ['qa/walk.js', 'qa/fresh-install-preflight.js'] as const;
const NATIVE_RUNNERS = ['qaren-ios-runner', 'rn-android-runner'] as const;

// Bundled CommonJS dependencies call require(); an ESM bundle only has one if we give it.
const REQUIRE_BANNER =
  "import { createRequire as __qarenCreateRequire } from 'node:module';\n" +
  'globalThis.require ??= __qarenCreateRequire(import.meta.url);';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Source builds are <release>-dev.<commit> (scripts/install-qaren-from-source.sh).
const DEV_SUFFIX_RE = /-dev\.[0-9a-f]+$/;

export function releaseOf(version: string): string {
  return version.replace(DEV_SUFFIX_RE, '');
}

export function tarballName(version: string, platform: QarenPlatform): string {
  return `qaren-${version}-${platform}.tar.gz`;
}

// A source build vouches for no published runner, so its runtime builds the runners from source.
export function sourceRunnerManifest(version: string): string {
  return JSON.stringify({ version, assets: { ios: [], android: [] } }, null, 2) + '\n';
}

// The runtime copy names only the runner zips: a tarball can never vouch for itself.
export function runtimeRunnerManifest(text: string, version: string): string {
  const manifest = JSON.parse(text) as {
    version?: unknown;
    xcodeBuildVersion?: unknown;
    assets?: { ios?: unknown; android?: unknown };
  };
  if (manifest.version !== version) {
    throw new Error(
      `the runner manifest vouches for v${String(manifest.version)}, not v${version}`,
    );
  }
  const { ios, android } = manifest.assets ?? {};
  if (!Array.isArray(ios) || !Array.isArray(android)) {
    throw new Error('the runner manifest lists no ios and android assets');
  }
  const runtime: Record<string, unknown> = { version, assets: { ios, android } };
  if (manifest.xcodeBuildVersion) runtime.xcodeBuildVersion = manifest.xcodeBuildVersion;
  return JSON.stringify(runtime, null, 2) + '\n';
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (!/^[\x20-\x7e]+$/.test(path)) throw new Error(`refusing non-ASCII tar path: ${path}`);
  if (path.length <= 100) return { name: path, prefix: '' };
  const body = path.endsWith('/') ? path.slice(0, -1) : path;
  for (let cut = body.indexOf('/'); cut !== -1; cut = body.indexOf('/', cut + 1)) {
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (prefix.length <= 155 && name.length <= 100) return { name, prefix };
  }
  throw new Error(`tar path too long for ustar: ${path}`);
}

function ustarHeader(path: string, mode: number, size: number, mtime: number, type: '0' | '5') {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitUstarPath(path);
  header.write(name, 0, 100, 'ascii');
  header.write(octal(mode, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(mtime, 12), 136, 12, 'ascii');
  header.write(' '.repeat(8), 148, 8, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

// A deterministic gzip'd ustar of everything under dir: sorted entries, one
// mtime, uid/gid 0, modes 0755/0644 only, no owner names, no extended headers.
export function packDirectory(dir: string, mtime: number): Buffer {
  const blocks: Buffer[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative)).sort()) {
      const path = relative ? `${relative}/${entry}` : entry;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) {
        blocks.push(ustarHeader(`${path}/`, 0o755, 0, mtime, '5'));
        walk(path);
      } else if (stat.isFile()) {
        const data = readFileSync(join(dir, path));
        const mode = stat.mode & 0o111 ? 0o755 : 0o644;
        blocks.push(ustarHeader(path, mode, data.length, mtime, '0'), data);
        blocks.push(Buffer.alloc((512 - (data.length % 512)) % 512));
      } else {
        throw new Error(`refusing to pack ${path}: only regular files and directories ship`);
      }
    }
  };
  walk('');
  blocks.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
  // The OS byte is the only build-host field gzip writes (mtime is already zero).
  gz[9] = 0xff;
  return gz;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(command, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function sourceDateEpoch(): number {
  const raw = process.env.SOURCE_DATE_EPOCH ?? run('git', ['log', '-1', '--format=%ct']).trim();
  const epoch = Number(raw);
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error(`bad SOURCE_DATE_EPOCH: ${raw}`);
  return epoch;
}

function cargoVersion(): string {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(CLI_DIR, 'Cargo.toml'), 'utf8'));
  if (!match) throw new Error('packages/qaren-cli/Cargo.toml has no version');
  return match[1];
}

// With rust-src installed rustc maps std back to the local sysroot; map it to rustc's own prefix.
function rustSourceRemap(): string[] {
  const rustc = process.env.RUSTC ?? 'rustc';
  const sysroot = run(rustc, ['--print', 'sysroot']).trim();
  const hash = /^commit-hash: ([0-9a-f]{40})$/m.exec(run(rustc, ['-vV']))?.[1];
  if (!sysroot || !hash) return [];
  return [`--remap-path-prefix=${join(sysroot, 'lib', 'rustlib', 'src', 'rust')}=/rustc/${hash}`];
}

function buildCli(platform: QarenPlatform, version: string): string {
  const target = RUST_TARGETS[platform];
  const targetDir = resolve(process.env.CARGO_TARGET_DIR ?? join(CLI_DIR, 'target'));
  const cargoHome = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
  const inherited = process.env.CARGO_ENCODED_RUSTFLAGS
    ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
    : (process.env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
  const flags = [
    ...inherited,
    `--remap-path-prefix=${ROOT}=/qaren`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${targetDir}=/target`,
    ...rustSourceRemap(),
    // The linker's debug map names std's rlibs by absolute path and LC_UUID is hashed over it,
    // so drop that map: the UUID then no longer depends on where the toolchain is installed.
    '-C',
    'link-arg=-Wl,-S',
  ];
  const env = {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f'),
    QAREN_VERSION: version,
    QAREN_BUILD_COMMIT: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim(),
  };
  delete env.RUSTFLAGS;
  execFileSync(
    'cargo',
    [
      'build',
      '--release',
      '--locked',
      '--target',
      target,
      '--target-dir',
      targetDir,
      '--manifest-path',
      join(CLI_DIR, 'Cargo.toml'),
    ],
    { cwd: ROOT, env, stdio: ['ignore', 2, 'inherit'] },
  );
  return join(targetDir, target, 'release', 'qaren');
}

async function bundleEntries(runtimeDir: string): Promise<void> {
  for (const entry of SPAWNED_ENTRIES) {
    await build({
      absWorkingDir: ROOT,
      entryPoints: [join(CORE_DIST, entry)],
      outfile: join(runtimeDir, entry),
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      banner: { js: REQUIRE_BANNER },
      legalComments: 'none',
      logLevel: 'warning',
    });
  }
}

function copyTrackedRunnerSources(runtimeDir: string): void {
  for (const runner of NATIVE_RUNNERS) {
    const prefix = `packages/${runner}/`;
    const files = run('git', ['ls-files', '-z', '--', prefix]).split('\0').filter(Boolean);
    if (files.length === 0) throw new Error(`no tracked sources under ${prefix}`);
    for (const file of files) {
      const dest = join(runtimeDir, 'runners', runner, file.slice(prefix.length));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(ROOT, file), dest);
    }
  }
}

export function copyDarwinNative(nativeDir: string, runtimeDir: string): void {
  const dest = join(runtimeDir, 'native');
  mkdirSync(dest, { recursive: true });
  for (const name of ['darwin-process-birth', 'darwin-process-birth.json']) {
    copyFileSync(join(nativeDir, name), join(dest, name));
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version;
  const platform = args.platform as QarenPlatform;
  if (!version || !VERSION_RE.test(version) || !(platform in RUST_TARGETS)) {
    console.error(
      'usage: build-qaren-tarball.ts --version <v> --platform darwin-arm64 ' +
        '[--runner-manifest <path>] [--out-dir <dir>]',
    );
    process.exit(2);
  }
  const release = releaseOf(version);
  if (cargoVersion() !== release) {
    throw new Error(`Cargo.toml is v${cargoVersion()}, not the requested v${release}`);
  }
  const head = run('git', ['rev-parse', '--short=12', 'HEAD']).trim();
  if (release !== version && version !== `${release}-dev.${head}`) {
    throw new Error(`v${version} is not this checkout's source version ${release}-dev.${head}`);
  }
  const runtimeManifest =
    release === version
      ? runtimeRunnerManifest(
          readFileSync(
            resolve(args['runner-manifest'] ?? join(ROOT, 'runner-manifest.json')),
            'utf8',
          ),
          version,
        )
      : sourceRunnerManifest(version);
  const outDir = resolve(args['out-dir'] ?? join(CLI_DIR, 'target', 'qaren-tarball'));
  const mtime = sourceDateEpoch();

  execFileSync('corepack', ['yarn', 'build:core'], { cwd: ROOT, stdio: ['ignore', 2, 'inherit'] });
  const binary = buildCli(platform, version);

  const stage = mkdtempSync(join(tmpdir(), 'qaren-tarball-'));
  try {
    const top = join(stage, `qaren-${version}-${platform}`);
    const runtimeDir = join(top, 'runtime');
    mkdirSync(join(top, 'bin'), { recursive: true });
    copyFileSync(binary, join(top, 'bin', 'qaren'));
    await bundleEntries(runtimeDir);
    copyDarwinNative(join(CORE_DIST, 'native'), runtimeDir);
    copyTrackedRunnerSources(runtimeDir);
    // Bundled modules resolve <runtime>/runner-manifest.json and <runtime>/package.json
    // from import.meta.dirname (qaren-core/src/runners/runtime-paths.ts).
    writeFileSync(join(runtimeDir, 'runner-manifest.json'), runtimeManifest);
    writeFileSync(
      join(runtimeDir, 'package.json'),
      JSON.stringify({ name: 'qaren-runtime', version, private: true, type: 'module' }, null, 2) +
        '\n',
    );
    writeFileSync(join(top, 'VERSION'), `${version}\n`);

    const tarball = packDirectory(stage, mtime);
    const name = tarballName(version, platform);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, name), tarball);
    console.log(`name=${name}`);
    console.log(`sha256=${createHash('sha256').update(tarball).digest('hex')}`);
    console.log(`bytes=${tarball.length}`);
    console.error(`wrote ${join(outDir, name)}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
