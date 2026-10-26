#!/usr/bin/env node
// Post-`changeset version` hook: mirror the packages/qaren-plugin/package.json
// version into the three host manifests, the two marketplaces and the CLI crate.
// Run via `yarn version-packages`.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ROOT = join(REPO_ROOT, 'packages', 'qaren-plugin');

const synth = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf-8'));
const newVersion = synth.version;
if (typeof newVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(newVersion)) {
  console.error(
    `sync-plugin-manifest: packages/qaren-plugin/package.json has invalid version ${JSON.stringify(newVersion)} — expected semver.`,
  );
  process.exit(1);
}

let oldVersion = null;
for (const rel of [
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.codex-plugin/plugin.json',
]) {
  const path = join(PLUGIN_ROOT, rel);
  const manifest = JSON.parse(readFileSync(path, 'utf-8'));
  oldVersion ??= manifest.version;
  manifest.version = newVersion;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

for (const rel of ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json']) {
  const path = join(REPO_ROOT, rel);
  const marketplace = JSON.parse(readFileSync(path, 'utf-8'));
  const entry = (marketplace.plugins ?? []).find((p) => p.name === 'qaren');
  if (!entry) {
    console.error(`sync-plugin-manifest: ${rel} has no plugins[].name === 'qaren' entry`);
    process.exit(1);
  }
  entry.version = newVersion;
  writeFileSync(path, JSON.stringify(marketplace, null, 2) + '\n', 'utf-8');
}

const cargoToml = join(REPO_ROOT, 'packages', 'qaren-cli', 'Cargo.toml');
const cargoLock = join(REPO_ROOT, 'packages', 'qaren-cli', 'Cargo.lock');
writeFileSync(
  cargoToml,
  readFileSync(cargoToml, 'utf-8').replace(/^version = "[^"]+"/m, `version = "${newVersion}"`),
  'utf-8',
);
writeFileSync(
  cargoLock,
  readFileSync(cargoLock, 'utf-8').replace(
    /(\[\[package\]\]\nname = "qaren"\nversion = ")[^"]+/,
    `$1${newVersion}`,
  ),
  'utf-8',
);

console.log(
  `sync-plugin-manifest: ${oldVersion} → ${newVersion} (host manifests + marketplaces + qaren-cli crate)`,
);
