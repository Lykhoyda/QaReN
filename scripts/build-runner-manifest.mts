#!/usr/bin/env node
// Generates the offline SHA-256 and byte-length trust root for runner zips and an optional qaren tarball.
//
// Usage (CI, after building the zips):
//   node scripts/build-runner-manifest.mts \
//     --version 0.62.3 \
//     --ios path/to/rn-fast-runner-0.62.3-sim.zip \
//     --android path/to/rn-android-runner-0.62.3.zip \
//     --xcode-build-version 15.4 \
//     --qaren-darwin-arm64 path/to/qaren-0.62.3-darwin-arm64.tar.gz \
//     --out runner-manifest.json

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export function hashAsset(filePath) {
  const buf = readFileSync(filePath);
  return {
    name: basename(filePath),
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: statSync(filePath).size,
  };
}

export const QAREN_PLATFORMS = ['darwin-arm64'];

export function assembleManifest({
  version,
  xcodeBuildVersion,
  iosZip,
  androidZip,
  qarenTarballs = {},
}) {
  const manifest = { version, assets: { ios: [], android: [] } };
  if (xcodeBuildVersion) manifest.xcodeBuildVersion = xcodeBuildVersion;
  if (iosZip) manifest.assets.ios.push(hashAsset(iosZip));
  if (androidZip) manifest.assets.android.push(hashAsset(androidZip));
  const qaren = {};
  for (const platform of QAREN_PLATFORMS) {
    if (qarenTarballs[platform]) qaren[platform] = hashAsset(qarenTarballs[platform]);
  }
  if (Object.keys(qaren).length > 0) manifest.assets.qaren = qaren;
  return manifest;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    console.error(
      'usage: build-runner-manifest.mts --version <v> [--ios <zip>] [--android <zip>] ' +
        '[--xcode-build-version <v>] [--qaren-darwin-arm64 <tgz>] ' +
        '[--out <path>]',
    );
    process.exit(1);
  }
  const manifest = assembleManifest({
    version: args.version,
    xcodeBuildVersion: args['xcode-build-version'],
    iosZip: args.ios,
    androidZip: args.android,
    qarenTarballs: Object.fromEntries(
      QAREN_PLATFORMS.map((platform) => [platform, args[`qaren-${platform}`]]),
    ),
  });
  const out = args.out ?? 'runner-manifest.json';
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `wrote ${out} (ios: ${manifest.assets.ios.length}, android: ${manifest.assets.android.length}, ` +
      `qaren: ${Object.keys(manifest.assets.qaren ?? {}).length})`,
  );
}

// Run main only when executed directly, so tests can import the pure helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
