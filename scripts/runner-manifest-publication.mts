#!/usr/bin/env node
// Decision seam for the release trust-root transaction (.github/workflows/release.yml).
//
// release.yml binds finalized head H to producer candidate P by allowing only the trust-root delta.
// Retained producer digests are the authority; public assets never redefine what gets published.
//
// Stages:
//   prepared  H is self-consistent and matches the producer handoff (offline).
//   publish   additionally decides against the release state for vV:
//             publish | replace-draft | already-public, or refuse.
//
// Usage (CI):
//   node scripts/runner-manifest-publication.mts --stage prepared|publish \
//     --candidate-sha <H> --plugin-version <V> --advertised-version <main V> \
//     --repo-manifest runner-manifest.json \
//     --plugin-manifest packages/qaren-plugin/runner-manifest.json \
//     --ios-sha256 <hex> --ios-bytes <n> --android-sha256 <hex> --android-bytes <n> \
//     --qaren-darwin-arm64-sha256 <hex> --qaren-darwin-arm64-bytes <n> \
//     [--release release.json --tag-sha <sha-or-empty> --published-manifest published.json]

import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NUMERIC = '0|[1-9]\\d*';
const PRERELEASE_ID = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const VERSION_RE = new RegExp(
  `^(?:${NUMERIC})\\.(?:${NUMERIC})\\.(?:${NUMERIC})(?:-${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*)?$`,
);
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`not a release version: ${JSON.stringify(version)}`);
  }
  return version;
}

export const QAREN_PLATFORMS = ['darwin-arm64'];

export function expectedRunnerAssets(version) {
  assertVersion(version);
  return {
    ios: `rn-fast-runner-${version}-sim.zip`,
    android: `rn-android-runner-${version}.zip`,
    qaren: Object.fromEntries(
      QAREN_PLATFORMS.map((platform) => [platform, `qaren-${version}-${platform}.tar.gz`]),
    ),
    manifest: 'runner-manifest.json',
  };
}

function splitVersion(version) {
  const dash = version.indexOf('-');
  const core = dash === -1 ? version : version.slice(0, dash);
  const pre = dash === -1 ? null : version.slice(dash + 1).split('.');
  return { core: core.split('.').map(Number), pre };
}

// Semver precedence: numeric identifiers compare numerically and rank below
// alphanumeric ones; a shorter prerelease list ranks lower; no prerelease
// ranks above any prerelease of the same core.
function comparePrerelease(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      if (Number(a[i]) !== Number(b[i])) return Number(a[i]) - Number(b[i]);
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

export function isNewerVersion(candidate, advertised) {
  const c = splitVersion(assertVersion(candidate));
  const a = splitVersion(assertVersion(advertised));
  for (let i = 0; i < 3; i++) {
    if (c.core[i] !== a.core[i]) return c.core[i] > a.core[i];
  }
  if (c.pre === null) return a.pre !== null;
  if (a.pre === null) return false;
  return comparePrerelease(c.pre, a.pre) > 0;
}

function parseManifest(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Key order must not decide publication: two manifests that differ only in
// property order describe the same trust root.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function refuse(message) {
  throw new Error(message);
}

function assertSha(label, value) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    refuse(`${label} is not a full commit SHA: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertDigest(label, value) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    refuse(`${label} is not a SHA-256 hex digest: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertBytes(label, value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n) || n <= 0) refuse(`${label} is not a positive byte count: ${value}`);
  return n;
}

export function assertPreparedCandidate(input) {
  const candidateSha = assertSha('candidate SHA', input.candidateSha);
  const version = assertVersion(input.pluginVersion);
  if (!isNewerVersion(version, input.advertisedVersion)) {
    refuse(
      `candidate v${version} is not newer than the advertised v${input.advertisedVersion}: ` +
        'a historical or already advertised version can never be re-prepared',
    );
  }
  const expected = expectedRunnerAssets(version);
  const manifest = parseManifest(input.repoManifest);
  if (manifest === null) refuse('the candidate runner-manifest.json is missing or unparseable');
  if (manifest.version !== version) {
    refuse(`the candidate trust root is v${manifest.version} while plugin.json is v${version}`);
  }
  // packages/qaren-plugin is the one directory every host installs.
  const pluginCopy = parseManifest(input.pluginManifest);
  if (pluginCopy === null || canonical(pluginCopy) !== canonical(manifest)) {
    refuse('the plugin runner-manifest.json copy is missing or differs from the candidate root');
  }
  const producer = input.producer ?? {};
  const matchHandoff = (label, asset, expectedName, handoff) => {
    if (asset?.name !== expectedName) {
      refuse(`the candidate ${label} asset is ${asset?.name}, expected ${expectedName}`);
    }
    if (!handoff) refuse(`no producer handoff identity for ${label}`);
    const sha256 = assertDigest(`producer ${label} sha256`, handoff.sha256);
    const bytes = assertBytes(`producer ${label} bytes`, handoff.bytes);
    if (asset.sha256 !== sha256 || asset.bytes !== bytes) {
      refuse(
        `the candidate ${label} digest (${asset.sha256}/${asset.bytes}) does not match the ` +
          `producer handoff (${sha256}/${bytes})`,
      );
    }
  };
  for (const platform of ['ios', 'android']) {
    const assets = manifest.assets?.[platform];
    if (!Array.isArray(assets) || assets.length !== 1) {
      refuse(`the candidate trust root must list exactly one ${platform} asset`);
    }
    matchHandoff(platform, assets[0], expected[platform], producer[platform]);
  }
  const qaren = manifest.assets?.qaren;
  if (!qaren || typeof qaren !== 'object' || Array.isArray(qaren)) {
    refuse('the candidate trust root lists no qaren tarballs');
  }
  const platforms = Object.keys(qaren).sort();
  if (canonical(platforms) !== canonical([...QAREN_PLATFORMS].sort())) {
    refuse(
      'the candidate trust root must list exactly the Apple silicon qaren tarball ' +
        `(${QAREN_PLATFORMS.join(', ')}), got ${platforms.join(', ') || 'none'}`,
    );
  }
  for (const platform of QAREN_PLATFORMS) {
    matchHandoff(
      `qaren ${platform}`,
      qaren[platform],
      expected.qaren[platform],
      producer.qaren?.[platform],
    );
  }
  return { candidateSha, version, expected, manifest };
}

// Release state for vV as the workflow observed it:
//   undefined            the API could not be read — never "absent"
//   null                 GitHub itself reported no release (and no draft)
//   { isDraft, targetCommitish, assets: [{ name }] }
function releaseState(input) {
  if (input.release === undefined) {
    refuse('the release state could not be determined — refusing to guess');
  }
  if (input.release === null) return null;
  const release = input.release;
  if (typeof release !== 'object' || !Array.isArray(release.assets)) {
    refuse('the release record is not a release listing');
  }
  return release;
}

export function decideRunnerPublication(input) {
  const prepared = assertPreparedCandidate(input);
  const { candidateSha, version, expected, manifest } = prepared;
  const release = releaseState(input);
  const tagSha = input.tagSha ? assertSha(`tag v${version}`, input.tagSha) : null;
  const names = new Set((release?.assets ?? []).map((asset) => asset.name));
  const published = parseManifest(input.publishedManifest);

  if (release === null || release.isDraft) {
    // A tag bound to another commit can never be reused for this candidate,
    // whether the release is still to be created or a draft is rebuilt.
    if (tagSha !== null && tagSha !== candidateSha) {
      refuse(`tag v${version} already points at ${tagSha}, not the candidate ${candidateSha}`);
    }
  }
  if (release === null) {
    return { ...prepared, action: 'publish', reason: `no release v${version} exists yet` };
  }
  if (release.isDraft) {
    return {
      ...prepared,
      action: 'replace-draft',
      reason: `a draft v${version} exists; it is prepublication state and is rebuilt from the retained bytes`,
    };
  }
  const identity = tagSha ?? release.targetCommitish;
  const divergence =
    identity !== candidateSha
      ? `release v${version} is published from ${identity}, not the candidate ${candidateSha}`
      : !names.has(expected.ios) || !names.has(expected.android)
        ? `release v${version} is published without both runner zips`
        : Object.values(expected.qaren).some((name) => !names.has(name))
          ? `release v${version} is published without the Apple silicon qaren tarball`
          : !names.has(expected.manifest)
            ? `release v${version} is published without its runner-manifest.json`
            : published === null
              ? `the published runner-manifest.json for v${version} could not be read`
              : canonical(published) !== canonical(manifest)
                ? `the published runner-manifest.json for v${version} differs from the candidate`
                : null;
  if (divergence) {
    refuse(
      `${divergence}. A published release is never replaced: ` +
        'v' +
        version +
        ' stays published-but-not-advertised; ship changed content as a new version.',
    );
  }
  return {
    ...prepared,
    action: 'already-public',
    reason: `release v${version} is already published from the candidate ${candidateSha}`,
  };
}

function readIfPresent(path) {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function parseRelease(path) {
  const text = readIfPresent(path);
  if (text === null || text.trim() === '') return undefined;
  const parsed = JSON.parse(text);
  return parsed === null ? null : parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = {
    candidateSha: args['candidate-sha'],
    pluginVersion: args['plugin-version'],
    advertisedVersion: args['advertised-version'],
    repoManifest: readIfPresent(args['repo-manifest']),
    pluginManifest: readIfPresent(args['plugin-manifest']),
    producer: {
      ios: { sha256: args['ios-sha256'], bytes: args['ios-bytes'] },
      android: { sha256: args['android-sha256'], bytes: args['android-bytes'] },
      qaren: Object.fromEntries(
        QAREN_PLATFORMS.map((platform) => [
          platform,
          {
            sha256: args[`qaren-${platform}-sha256`],
            bytes: args[`qaren-${platform}-bytes`],
          },
        ]),
      ),
    },
  };
  const stage = args.stage ?? 'prepared';
  let decision;
  if (stage === 'prepared') {
    decision = {
      ...assertPreparedCandidate(input),
      action: 'prepared',
      reason: 'candidate is prepared',
    };
  } else if (stage === 'publish') {
    decision = decideRunnerPublication({
      ...input,
      release: parseRelease(args.release),
      tagSha: args['tag-sha'] || null,
      publishedManifest: readIfPresent(args['published-manifest']),
    });
  } else {
    throw new Error(`unknown --stage ${stage}`);
  }
  const lines = [
    `version=${decision.version}`,
    `action=${decision.action}`,
    `ios=${decision.expected.ios}`,
    `android=${decision.expected.android}`,
    ...QAREN_PLATFORMS.map((platform) => `qaren-${platform}=${decision.expected.qaren[platform]}`),
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  console.log(decision.reason);
  console.log(lines.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
