// The release trust-root transaction: the first default-branch commit that
// advertises plugin version V must already carry runner-manifest.json for V,
// its named zips must already be public at vV with the producer's exact
// digests and lengths, and nothing rebuilds or replaces those bytes afterwards.
//
// The publication decision is tested through its exported functions; the
// workflow legs are tested by EXECUTING their steps the way the runner does
// (its own default shell, one process per step, abort on failure) against a
// real local git remote and a recording `gh` double, then asserting the
// resulting refs, releases, tags, uploads and CLI call sequence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPreparedCandidate,
  assertVersion,
  decideRunnerPublication,
  expectedRunnerAssets,
  isNewerVersion,
} from '../../../../scripts/runner-manifest-publication.mts';
import {
  ghCommands,
  installGhStub,
  loadWorkflow,
  resolveExpressions,
  runJobSteps,
  shellCommands,
  type GhCheckRun,
  type GhPullRequest,
  type GhSeedRelease,
  type GhStub,
  type JobRun,
  type Workflow,
  type WorkflowStep,
} from '../helpers/workflow-job-runner.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const release = loadWorkflow(join(repoRoot, '.github', 'workflows', 'release.yml'));
const artifacts = loadWorkflow(join(repoRoot, '.github', 'workflows', 'runner-artifacts.yml'));
const ci = loadWorkflow(join(repoRoot, '.github', 'workflows', 'ci.yml'));
const sweepWorkflow = loadWorkflow(
  join(repoRoot, '.github', 'workflows', 'runner-artifacts-sweep.yml'),
);

const ADVERTISED = '0.76.6';
const VERSION = '0.76.7';
const TAG = `v${VERSION}`;
const IOS_ZIP = `rn-fast-runner-${VERSION}-sim.zip`;
const ANDROID_ZIP = `rn-android-runner-${VERSION}.zip`;
const QAREN_ARM64_TGZ = `qaren-${VERSION}-darwin-arm64.tar.gz`;
const IOS_BYTES = 'ios-runner-zip-bytes';
const ANDROID_BYTES = 'android-runner-zip-bytes';
const QAREN_ARM64_BYTES = 'qaren-arm64-tarball-bytes';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REPO = 'Lykhoyda/rn-dev-agent';

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex');
}

function producer() {
  return {
    ios: { sha256: sha256(IOS_BYTES), bytes: IOS_BYTES.length },
    android: { sha256: sha256(ANDROID_BYTES), bytes: ANDROID_BYTES.length },
    qaren: {
      'darwin-arm64': { sha256: sha256(QAREN_ARM64_BYTES), bytes: QAREN_ARM64_BYTES.length },
    },
  };
}

// The manifest scripts/build-runner-manifest.mts produces for the seeded zips,
// serialised the way it writes the file.
function manifestFor(
  version = VERSION,
  ios = IOS_BYTES,
  android = ANDROID_BYTES,
  arm64 = QAREN_ARM64_BYTES,
): string {
  const tarball = (platform: string, bytes: string) => ({
    name: `qaren-${version}-${platform}.tar.gz`,
    sha256: sha256(bytes),
    bytes: bytes.length,
  });
  return (
    JSON.stringify(
      {
        version,
        assets: {
          ios: [
            { name: `rn-fast-runner-${version}-sim.zip`, sha256: sha256(ios), bytes: ios.length },
          ],
          android: [
            {
              name: `rn-android-runner-${version}.zip`,
              sha256: sha256(android),
              bytes: android.length,
            },
          ],
          qaren: {
            'darwin-arm64': tarball('darwin-arm64', arm64),
          },
        },
      },
      null,
      2,
    ) + '\n'
  );
}

const ALL_ASSETS = [IOS_ZIP, ANDROID_ZIP, QAREN_ARM64_TGZ];

function candidate(overrides: Record<string, unknown> = {}) {
  const manifest = manifestFor();
  return {
    candidateSha: SHA_A,
    pluginVersion: VERSION,
    advertisedVersion: ADVERTISED,
    repoManifest: manifest,
    pluginManifest: manifest,
    producer: producer(),
    ...overrides,
  };
}

function published(overrides: Record<string, unknown> = {}) {
  return {
    ...candidate(),
    release: {
      isDraft: false,
      targetCommitish: SHA_A,
      tagName: TAG,
      assets: [...ALL_ASSETS.map((name) => ({ name })), { name: 'runner-manifest.json' }],
    },
    tagSha: SHA_A,
    publishedManifest: manifestFor(),
    ...overrides,
  };
}

// --- the prepared candidate ---

test('a self-consistent candidate matching the producer handoff is prepared', () => {
  const prepared = assertPreparedCandidate(candidate());
  assert.equal(prepared.version, VERSION);
  assert.deepEqual(prepared.expected, {
    ios: IOS_ZIP,
    android: ANDROID_ZIP,
    qaren: { 'darwin-arm64': QAREN_ARM64_TGZ },
    manifest: 'runner-manifest.json',
  });
});

test('a candidate must advertise a version newer than main', () => {
  assert.throws(
    () => assertPreparedCandidate(candidate({ advertisedVersion: VERSION })),
    /not newer/,
  );
  assert.throws(
    () => assertPreparedCandidate(candidate({ advertisedVersion: '0.77.0' })),
    /not newer/,
  );
  assert.throws(
    () => assertPreparedCandidate(candidate({ advertisedVersion: undefined })),
    /not a release version/,
  );
});

test('version precedence follows semver, including numeric prerelease identifiers', () => {
  assert.equal(isNewerVersion('1.0.9', '1.0.8'), true);
  assert.equal(isNewerVersion('1.0.8', '1.0.8'), false);
  assert.equal(isNewerVersion('1.0.8', '1.0.9'), false);
  assert.equal(isNewerVersion('1.1.0', '1.0.9'), true);
  assert.equal(isNewerVersion('1.0.9', '1.0.9-rc.1'), true);
  assert.equal(isNewerVersion('1.0.9-rc.1', '1.0.9'), false);
  assert.equal(isNewerVersion('1.0.9-beta.10', '1.0.9-beta.2'), true);
  assert.equal(isNewerVersion('1.0.9-beta.2', '1.0.9-beta.10'), false);
  assert.equal(isNewerVersion('1.0.9-beta.2', '1.0.9-alpha.9'), true);
  assert.equal(isNewerVersion('1.0.9-beta', '1.0.9-beta.1'), false);
  assert.equal(isNewerVersion('1.0.9-rc.1', '1.0.9-1'), true);
});

test('the trust root must vouch for exactly the candidate version', () => {
  const stale = manifestFor(ADVERTISED);
  assert.throws(
    () => assertPreparedCandidate(candidate({ repoManifest: stale, pluginManifest: stale })),
    /trust root is v0\.76\.6 while plugin\.json is v0\.76\.7/,
  );
  assert.throws(
    () => assertPreparedCandidate(candidate({ repoManifest: 'not json' })),
    /missing or unparseable/,
  );
});

test('the distributed plugin copy must be present and identical to the root', () => {
  // packages/qaren-plugin is the one directory every host installs, so it
  // carries the single host copy of the trust root.
  assert.throws(
    () => assertPreparedCandidate(candidate({ pluginManifest: manifestFor(VERSION, 'x') })),
    /plugin runner-manifest\.json copy .* differs/,
  );
  assert.throws(
    () => assertPreparedCandidate(candidate({ pluginManifest: undefined })),
    /plugin runner-manifest\.json copy is missing/,
  );
});

test('property order never decides identity of the plugin copy', () => {
  const reordered = JSON.stringify({ assets: JSON.parse(manifestFor()).assets, version: VERSION });
  assert.doesNotThrow(() => assertPreparedCandidate(candidate({ pluginManifest: reordered })));
});

test('the full pair with exact names is required', () => {
  const parsed = JSON.parse(manifestFor());
  const noAndroid = JSON.stringify({ ...parsed, assets: { ios: parsed.assets.ios, android: [] } });
  assert.throws(
    () =>
      assertPreparedCandidate(
        candidate({
          repoManifest: noAndroid,
          pluginManifest: noAndroid,
        }),
      ),
    /exactly one android asset/,
  );
  const renamed = manifestFor().replace(IOS_ZIP, 'rn-fast-runner-latest-sim.zip');
  assert.throws(
    () => assertPreparedCandidate(candidate({ repoManifest: renamed, pluginManifest: renamed })),
    /ios asset is rn-fast-runner-latest-sim\.zip, expected rn-fast-runner-0\.76\.7-sim\.zip/,
  );
});

test('only the Apple silicon qaren tarball with the exact name is required', () => {
  const parsed = JSON.parse(manifestFor());
  const variant = (qaren: unknown) => {
    const text = JSON.stringify({ ...parsed, assets: { ...parsed.assets, qaren } });
    return candidate({ repoManifest: text, pluginManifest: text });
  };
  assert.throws(() => assertPreparedCandidate(variant(undefined)), /lists no qaren tarballs/);
  assert.throws(() => assertPreparedCandidate(variant([])), /lists no qaren tarballs/);
  assert.throws(
    () => assertPreparedCandidate(variant({})),
    /exactly the Apple silicon qaren tarball/,
  );
  for (const unsupported of ['darwin-x64', 'linux-x64']) {
    assert.throws(
      () =>
        assertPreparedCandidate(
          variant({ ...parsed.assets.qaren, [unsupported]: parsed.assets.qaren['darwin-arm64'] }),
        ),
      /exactly the Apple silicon qaren tarball/,
    );
  }
  const renamed = {
    'darwin-arm64': {
      ...parsed.assets.qaren['darwin-arm64'],
      name: 'qaren-latest-darwin-arm64.tar.gz',
    },
  };
  assert.throws(
    () => assertPreparedCandidate(variant(renamed)),
    /qaren darwin-arm64 asset is qaren-latest-darwin-arm64\.tar\.gz, expected qaren-0\.76\.7-darwin-arm64\.tar\.gz/,
  );
});

test('the trust root must carry the producer handoff digests and lengths exactly', () => {
  const tampered = { ...producer(), ios: { sha256: sha256('other'), bytes: IOS_BYTES.length } };
  assert.throws(
    () => assertPreparedCandidate(candidate({ producer: tampered })),
    /ios digest .* does not match the producer handoff/,
  );
  const short = {
    ...producer(),
    android: { sha256: sha256(ANDROID_BYTES), bytes: ANDROID_BYTES.length - 1 },
  };
  assert.throws(
    () => assertPreparedCandidate(candidate({ producer: short })),
    /android digest .* does not match/,
  );
  assert.throws(
    () => assertPreparedCandidate(candidate({ producer: { ios: producer().ios } })),
    /no producer handoff identity for android/,
  );
  const rebuilt = {
    ...producer(),
    qaren: { ...producer().qaren, 'darwin-arm64': { sha256: sha256('rebuilt'), bytes: 7 } },
  };
  assert.throws(
    () => assertPreparedCandidate(candidate({ producer: rebuilt })),
    /qaren darwin-arm64 digest .* does not match the producer handoff/,
  );
  const { qaren: _qaren, ...runnersOnly } = producer();
  assert.throws(
    () => assertPreparedCandidate(candidate({ producer: runnersOnly })),
    /no producer handoff identity for qaren darwin-arm64/,
  );
  assert.throws(
    () =>
      assertPreparedCandidate(
        candidate({ producer: { ...producer(), ios: { sha256: 'abc', bytes: 1 } } }),
      ),
    /not a SHA-256/,
  );
  assert.throws(
    () =>
      assertPreparedCandidate(
        candidate({ producer: { ...producer(), ios: { sha256: sha256(IOS_BYTES), bytes: '' } } }),
      ),
    /not a positive byte count/,
  );
});

test('a candidate is identified by a full commit SHA', () => {
  assert.throws(
    () => assertPreparedCandidate(candidate({ candidateSha: 'main' })),
    /not a full commit SHA/,
  );
  assert.throws(
    () => assertPreparedCandidate(candidate({ candidateSha: SHA_A.slice(0, 7) })),
    /not a full commit SHA/,
  );
});

test('only exact SemVer releases are accepted as versions', () => {
  for (const bad of ['1.2', '01.2.3', '1.2.3-01', '1.2.3-alpha..1', 'v1.2.3', '', undefined]) {
    assert.throws(() => assertVersion(bad), /not a release version/);
  }
  assert.equal(assertVersion('1.2.3-rc.1'), '1.2.3-rc.1');
});

test('expected release asset names stay pinned to the client download contract', () => {
  assert.deepEqual(expectedRunnerAssets('1.0.9'), {
    ios: 'rn-fast-runner-1.0.9-sim.zip',
    android: 'rn-android-runner-1.0.9.zip',
    qaren: {
      'darwin-arm64': 'qaren-1.0.9-darwin-arm64.tar.gz',
    },
    manifest: 'runner-manifest.json',
  });
});

// --- deciding against the release state ---

test('an unreadable release state is never read as "no release"', () => {
  assert.throws(() => decideRunnerPublication(candidate()), /could not be determined/);
  assert.throws(
    () => decideRunnerPublication(candidate({ release: undefined })),
    /could not be determined/,
  );
  assert.throws(
    () => decideRunnerPublication(candidate({ release: { isDraft: false } })),
    /not a release listing/,
  );
});

test('no release and no tag means publish', () => {
  const decision = decideRunnerPublication(candidate({ release: null, tagSha: null }));
  assert.equal(decision.action, 'publish');
});

test('a tag already bound to another commit refuses both a fresh publication and a draft rebuild', () => {
  assert.throws(
    () => decideRunnerPublication(candidate({ release: null, tagSha: SHA_B })),
    /already points at b{40}, not the candidate/,
  );
  assert.throws(
    () =>
      decideRunnerPublication(
        candidate({
          release: { isDraft: true, targetCommitish: SHA_A, assets: [] },
          tagSha: SHA_B,
        }),
      ),
    /already points at/,
  );
  assert.equal(
    decideRunnerPublication(candidate({ release: null, tagSha: SHA_A })).action,
    'publish',
  );
});

test('a draft is prepublication state and is replaced from the retained bytes', () => {
  for (const target of [SHA_A, SHA_B]) {
    const decision = decideRunnerPublication(
      candidate({
        release: { isDraft: true, targetCommitish: target, assets: [{ name: IOS_ZIP }] },
        tagSha: null,
      }),
    );
    assert.equal(decision.action, 'replace-draft');
  }
});

test('a release already published from this exact candidate is a no-op retry', () => {
  const decision = decideRunnerPublication(published());
  assert.equal(decision.action, 'already-public');
  const reordered = JSON.stringify({ assets: JSON.parse(manifestFor()).assets, version: VERSION });
  assert.equal(
    decideRunnerPublication(published({ publishedManifest: reordered })).action,
    'already-public',
  );
});

test('a published release that diverges is refused, never replaced', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ tagSha: SHA_B }, /published from b{40}, not the candidate/],
    [
      { tagSha: null, release: { ...published().release, targetCommitish: SHA_B } },
      /published from b{40}/,
    ],
    [
      {
        release: {
          ...published().release,
          assets: [{ name: IOS_ZIP }, { name: 'runner-manifest.json' }],
        },
      },
      /without both runner zips/,
    ],
    [
      {
        release: {
          ...published().release,
          assets: [{ name: IOS_ZIP }, { name: ANDROID_ZIP }, { name: 'runner-manifest.json' }],
        },
      },
      /without the Apple silicon qaren tarball/,
    ],
    [
      {
        release: {
          ...published().release,
          assets: ALL_ASSETS.map((name) => ({ name })),
        },
      },
      /without its runner-manifest\.json/,
    ],
    [{ publishedManifest: null }, /could not be read/],
    [
      { publishedManifest: manifestFor(VERSION, 'replacement-bytes') },
      /differs from the candidate/,
    ],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(() => decideRunnerPublication(published(overrides)), expected);
    assert.throws(
      () => decideRunnerPublication(published(overrides)),
      /published-but-not-advertised.*new version/,
    );
  }
});

// --- executing the workflow legs ---

type Fixture = {
  root: string;
  origin: string;
  base: string;
  candidate: string;
  head: string | null;
  gh: GhStub;
  cleanup: () => void;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  }).toString();
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const MANIFEST_PATHS = ['runner-manifest.json', 'packages/qaren-plugin/runner-manifest.json'];

type FixtureOptions = {
  // Also commit the generated trust root onto the candidate: the release head H.
  prepared?: boolean;
  candidateExtraFiles?: Record<string, string>;
  releases?: Record<string, GhSeedRelease>;
  tags?: Record<string, string>;
  checks?: Record<string, GhCheckRun[]>;
  prs?: GhPullRequest[];
};

function createFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'release-trust-root-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);

  mkdirSync(seed);
  git(seed, 'init', '--quiet', '--initial-branch=main');
  write(seed, 'packages/qaren-plugin/.claude-plugin/plugin.json', `{"version": "${ADVERTISED}"}\n`);
  write(
    seed,
    'packages/qaren-plugin/package.json',
    `{"name": "qaren", "version": "${ADVERTISED}"}\n`,
  );
  write(
    seed,
    'packages/qaren-plugin/CHANGELOG.md',
    `# qaren\n\n## ${ADVERTISED}\n\n### Patch Changes\n\n- older change\n`,
  );
  write(
    seed,
    'packages/qaren-cli/Cargo.toml',
    `[package]\nname = "qaren"\nversion = "${ADVERTISED}"\n`,
  );
  write(
    seed,
    'packages/qaren-cli/Cargo.lock',
    `[[package]]\nname = "qaren"\nversion = "${ADVERTISED}"\n`,
  );
  for (const path of MANIFEST_PATHS)
    write(seed, path, manifestFor(ADVERTISED, 'old-ios', 'old-android'));
  write(seed, 'packages/rn-fast-runner/README.md', 'ios runner sources\n');
  write(seed, 'packages/rn-android-runner/README.md', 'android runner sources\n');
  write(seed, 'README.md', 'unrelated repository content\n');
  write(seed, '.changeset/pending.md', "---\n'qaren': patch\n---\n\nA change.\n");
  for (const script of [
    'build-runner-manifest.mts',
    'runner-manifest-publication.mts',
    'release-notes-from-changelog.sh',
    'check-public-runner-assets.sh',
  ]) {
    mkdirSync(join(seed, 'scripts'), { recursive: true });
    copyFileSync(join(repoRoot, 'scripts', script), join(seed, 'scripts', script));
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  const base = git(seed, 'rev-parse', 'HEAD').trim();
  git(seed, 'remote', 'add', 'origin', `file://${origin}`);
  git(seed, 'push', '--quiet', 'origin', 'main');

  // What `corepack yarn version-packages` generates: one commit on top of main.
  git(seed, 'checkout', '--quiet', '-b', 'changeset-release/main');
  write(seed, 'packages/qaren-plugin/.claude-plugin/plugin.json', `{"version": "${VERSION}"}\n`);
  write(seed, 'packages/qaren-plugin/package.json', `{"name": "qaren", "version": "${VERSION}"}\n`);
  write(
    seed,
    'packages/qaren-cli/Cargo.toml',
    `[package]\nname = "qaren"\nversion = "${VERSION}"\n`,
  );
  write(
    seed,
    'packages/qaren-cli/Cargo.lock',
    `[[package]]\nname = "qaren"\nversion = "${VERSION}"\n`,
  );
  write(
    seed,
    'packages/qaren-plugin/CHANGELOG.md',
    `# qaren\n\n## ${VERSION}\n\n### Patch Changes\n\n- abc1234: A change.\n\n## ${ADVERTISED}\n\n### Patch Changes\n\n- older change\n`,
  );
  rmSync(join(seed, '.changeset/pending.md'));
  for (const [path, content] of Object.entries(options.candidateExtraFiles ?? {}))
    write(seed, path, content);
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'chore(release): version packages');
  const candidateSha = git(seed, 'rev-parse', 'HEAD').trim();
  let head: string | null = null;
  if (options.prepared) {
    for (const path of MANIFEST_PATHS) write(seed, path, manifestFor());
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', `chore(release): runner trust root for v${VERSION}`);
    head = git(seed, 'rev-parse', 'HEAD').trim();
  }
  git(seed, 'push', '--quiet', 'origin', 'changeset-release/main');
  git(seed, 'checkout', '--quiet', 'main');

  const gh = installGhStub(root, {
    releases: options.releases,
    tags: options.tags,
    checks: options.checks,
    prs: options.prs,
    nextPr: 11,
    gitDir: origin,
  });
  return {
    root,
    origin,
    base,
    candidate: candidateSha,
    head,
    gh,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}

let cloneCounter = 0;

// actions/checkout at a ref: a shallow single-branch clone (or a detached SHA).
function checkout(fixture: Fixture, ref: string): string {
  const dir = join(fixture.root, `checkout-${cloneCounter++}`);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    git(fixture.root, 'clone', '--quiet', `file://${fixture.origin}`, dir);
    git(dir, 'checkout', '--quiet', '--detach', ref);
  } else {
    git(
      fixture.root,
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      ref,
      `file://${fixture.origin}`,
      dir,
    );
  }
  return dir;
}

function fullClone(fixture: Fixture): string {
  const dir = join(fixture.root, `clone-${cloneCounter++}`);
  git(fixture.root, 'clone', '--quiet', `file://${fixture.origin}`, dir);
  return dir;
}

function advanceMain(fixture: Fixture): string {
  const dir = fullClone(fixture);
  write(dir, 'README.md', `unrelated work on main ${cloneCounter}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'unrelated work on main');
  git(dir, 'push', '--quiet', 'origin', 'main');
  return git(dir, 'rev-parse', 'HEAD').trim();
}

function originRef(fixture: Fixture, ref: string): string | null {
  const out = git(
    fixture.root,
    '--git-dir',
    fixture.origin,
    'rev-parse',
    '--verify',
    '--quiet',
    ref,
  ).trim();
  return out === '' ? null : out;
}

function handoff(dir: string, ios = IOS_BYTES, android = ANDROID_BYTES): void {
  write(dir, `handoff/${IOS_ZIP}`, ios);
  write(dir, `handoff/${ANDROID_ZIP}`, android);
  write(dir, `handoff/${QAREN_ARM64_TGZ}`, QAREN_ARM64_BYTES);
}

function ghCalls(fixture: Fixture): string[] {
  return ghCommands(fixture.gh.calls());
}

function baseEnv(fixture: Fixture): Record<string, string> {
  return {
    ...fixture.gh.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GITHUB_STEP_SUMMARY: join(fixture.root, 'summary.md'),
  };
}

const HEAD_EXPR =
  "needs.version.outputs.resume == 'true' && needs.version.outputs.head-sha || needs.finalize.outputs.head-sha";

function releaseCtx(
  fixture: Fixture,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const head = fixture.head ?? '';
  const p = producer();
  return {
    'secrets.GITHUB_TOKEN': 'stub-token',
    'github.repository': REPO,
    'github.sha': fixture.base,
    'github.run_id': '4242',
    'needs.version.outputs.candidate-sha': fixture.candidate,
    'needs.version.outputs.version': VERSION,
    'needs.version.outputs.advertised-version': ADVERTISED,
    'needs.version.outputs.pr-number': '11',
    'needs.version.outputs.resume': 'false',
    'needs.version.outputs.head-sha': '',
    'needs.finalize.outputs.head-sha': head,
    [HEAD_EXPR]: head,
    'needs.prepare.outputs.ios-sha256': p.ios.sha256,
    'needs.prepare.outputs.ios-bytes': String(p.ios.bytes),
    'needs.prepare.outputs.ios-tree': '',
    'needs.prepare.outputs.android-sha256': p.android.sha256,
    'needs.prepare.outputs.android-bytes': String(p.android.bytes),
    'needs.prepare.outputs.android-tree': '',
    'needs.prepare.outputs.qaren-darwin-arm64-sha256': p.qaren['darwin-arm64'].sha256,
    'needs.prepare.outputs.qaren-darwin-arm64-bytes': String(p.qaren['darwin-arm64'].bytes),
    ...overrides,
  };
}

function stepStdout(run: JobRun, name: string): string {
  const step = run.steps.find((s) => s.name === name);
  assert.ok(step, `the job never ran the step "${name}"`);
  return step.stdout;
}

function steps(workflow: Workflow, jobId: string): WorkflowStep[] {
  return workflow.jobs[jobId].steps ?? [];
}

function stepNames(workflow: Workflow, jobId: string): string[] {
  return steps(workflow, jobId).flatMap((s) => (s.run !== undefined && s.name ? [s.name] : []));
}

const PENDING_STEP = 'Retire armed auto-merge and detect a published candidate awaiting its merge';
const CANDIDATE_STEP = 'Pin the generated candidate and check its delta against main';

function versionPr(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    number: 11,
    headRefName: 'changeset-release/main',
    baseRefName: 'main',
    state: 'OPEN',
    autoMerge: null,
    ...overrides,
  };
}

function runVersionStep(fixture: Fixture, step: string) {
  return runJobSteps({
    workflow: release,
    jobId: 'version',
    cwd: fullClone(fixture),
    ctx: releaseCtx(fixture),
    env: baseEnv(fixture),
    only: [step],
  });
}

// --- version: retire auto-merge, resume a published candidate, pin P ---

test('no open Version PR: nothing to resume and nothing to retire', () => {
  const fixture = createFixture();
  try {
    const run = runVersionStep(fixture, PENDING_STEP);
    assert.ok(run.ok, run.failed?.stderr);
    assert.equal(run.outputs.pending.resume, 'false');
    assert.equal(run.outputs.pending['advertised-version'], ADVERTISED);
    assert.ok(!ghCalls(fixture).some((c) => c.startsWith('pr merge')));
  } finally {
    fixture.cleanup();
  }
});

test('an inherited armed auto-merge is retired before the branch is touched', () => {
  const fixture = createFixture({ prs: [versionPr({ autoMerge: 'squash' })] });
  try {
    const run = runVersionStep(fixture, PENDING_STEP);
    assert.ok(run.ok, run.failed?.stderr);
    assert.equal(run.outputs.pending.resume, 'false');
    assert.ok(ghCalls(fixture).includes('pr merge --disable-auto 11'));
    assert.equal(fixture.gh.state().prs[0].autoMerge, null);
  } finally {
    fixture.cleanup();
  }
});

test('an unpublished candidate is not resumed: main advancing regenerates it', () => {
  const fixture = createFixture({
    prepared: true,
    prs: [versionPr()],
    releases: { [TAG]: { assets: { [IOS_ZIP]: IOS_BYTES }, draft: true } },
  });
  try {
    const run = runVersionStep(fixture, PENDING_STEP);
    assert.ok(run.ok, run.failed?.stderr);
    assert.equal(run.outputs.pending.resume, 'false');
  } finally {
    fixture.cleanup();
  }
});

test('a published candidate whose tag is the PR head is resumed, never regenerated', () => {
  const fixture = createFixture({ prepared: true, prs: [versionPr()] });
  try {
    const head = fixture.head!;
    const state = fixture.gh.state();
    state.releases[TAG] = {
      assets: {
        ...Object.fromEntries(ALL_ASSETS.map((name) => [name, { uploads: 1 }])),
        'runner-manifest.json': { uploads: 1 },
      },
      draft: false,
      target: head,
    };
    state.tags[TAG] = head;
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runVersionStep(fixture, PENDING_STEP);
    assert.ok(run.ok, run.failed?.stderr);
    assert.equal(run.outputs.pending.resume, 'true');
    assert.equal(run.outputs.pending['head-sha'], head);
    assert.equal(run.outputs.pending['pr-number'], '11');
    assert.equal(run.outputs.pending.version, VERSION);
  } finally {
    fixture.cleanup();
  }
});

test('a lookup that cannot be read is never taken as "nothing published"', () => {
  for (const fail of ['api repos/{owner}/{repo}/git/ref', 'api repos/{owner}/{repo}/releases']) {
    const fixture = createFixture({ prepared: true, prs: [versionPr()], tags: { [TAG]: SHA_B } });
    try {
      const run = runJobSteps({
        workflow: release,
        jobId: 'version',
        cwd: fullClone(fixture),
        ctx: releaseCtx(fixture),
        env: { ...baseEnv(fixture), GH_STUB_FAIL: fail },
        only: [PENDING_STEP],
      });
      assert.equal(run.ok, false, fail);
      assert.match(run.failed!.stderr, /refusing to guess/);
      assert.equal(run.outputs.pending?.resume, undefined);
    } finally {
      fixture.cleanup();
    }
  }
});

test('the generated candidate is pinned as one commit on top of main with only generated paths', () => {
  const fixture = createFixture();
  try {
    const run = runVersionStep(fixture, CANDIDATE_STEP);
    assert.ok(run.ok, run.failed?.stderr);
    assert.equal(run.outputs.candidate.sha, fixture.candidate);
    assert.equal(run.outputs.candidate.version, VERSION);
  } finally {
    fixture.cleanup();
  }
});

test('a candidate carrying a path the generator never writes is refused', () => {
  const fixture = createFixture({
    candidateExtraFiles: { 'packages/qaren-core/src/index.ts': 'export {};\n' },
  });
  try {
    const run = runVersionStep(fixture, CANDIDATE_STEP);
    assert.equal(run.ok, false);
    assert.match(
      run.failed!.stderr,
      /changes paths a version bump never generates: packages\/qaren-core\/src\/index\.ts/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('a candidate that is not one commit on top of the pushed main is refused', () => {
  const fixture = createFixture();
  try {
    advanceMain(fixture);
    const run = runJobSteps({
      workflow: release,
      jobId: 'version',
      cwd: fullClone(fixture),
      ctx: releaseCtx(fixture, { 'github.sha': originRef(fixture, 'refs/heads/main')! }),
      env: baseEnv(fixture),
      only: [CANDIDATE_STEP],
    });
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /not one generated commit on top of main/);
  } finally {
    fixture.cleanup();
  }
});

test('the qaren crate version bump is a generated path', () => {
  const fixture = createFixture();
  try {
    const changed = git(
      fixture.root,
      '--git-dir',
      fixture.origin,
      'diff',
      '--name-only',
      fixture.base,
      fixture.candidate,
    );
    assert.match(changed, /packages\/qaren-cli\/Cargo\.toml/);
    assert.match(changed, /packages\/qaren-cli\/Cargo\.lock/);
    const run = runVersionStep(fixture, CANDIDATE_STEP);
    assert.ok(run.ok, run.failed?.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('a candidate whose native runner sources differ from main is refused even on a generated path', () => {
  const fixture = createFixture({
    candidateExtraFiles: { 'packages/rn-android-runner/package.json': '{"version": "0.2.0"}\n' },
  });
  try {
    const run = runVersionStep(fixture, CANDIDATE_STEP);
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /native inputs under packages\/rn-android-runner differ/);
  } finally {
    fixture.cleanup();
  }
});

// --- finalize: trust root from the retained bytes, committed as H ---

function runFinalize(
  fixture: Fixture,
  { ctx = {}, tamper }: { ctx?: Record<string, string>; tamper?: () => void } = {},
) {
  const dir = checkout(fixture, fixture.candidate);
  handoff(dir);
  tamper?.();
  return {
    dir,
    run: runJobSteps({
      workflow: release,
      jobId: 'finalize',
      cwd: dir,
      ctx: releaseCtx(fixture, ctx),
      env: baseEnv(fixture),
    }),
  };
}

test('finalize generates root + plugin copy from the retained bytes and pins H on the version branch', () => {
  const fixture = createFixture();
  try {
    const { run } = runFinalize(fixture);
    assert.ok(run.ok, run.failed?.stderr);
    const head = run.outputs.commit.sha;
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(originRef(fixture, 'refs/heads/changeset-release/main'), head);
    assert.equal(
      git(fixture.root, '--git-dir', fixture.origin, 'rev-parse', `${head}^`).trim(),
      fixture.candidate,
    );
    for (const path of MANIFEST_PATHS) {
      assert.equal(
        git(fixture.root, '--git-dir', fixture.origin, 'show', `${head}:${path}`),
        manifestFor(),
      );
    }
    const changed = git(
      fixture.root,
      '--git-dir',
      fixture.origin,
      'diff',
      '--name-only',
      fixture.candidate,
      head,
    )
      .trim()
      .split('\n')
      .sort();
    assert.deepEqual(changed, [...MANIFEST_PATHS].sort());
    assert.equal(originRef(fixture, 'refs/heads/main'), fixture.base, 'main is never written');
  } finally {
    fixture.cleanup();
  }
});

test('a retained zip that does not match the producer identity stops finalize before anything is generated', () => {
  const fixture = createFixture();
  try {
    const { run } = runFinalize(fixture, {
      ctx: { 'needs.prepare.outputs.ios-sha256': sha256('substituted') },
    });
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /retained sha256 .* != producer/);
    assert.equal(originRef(fixture, 'refs/heads/changeset-release/main'), fixture.candidate);
  } finally {
    fixture.cleanup();
  }
});

test('a retained zip of the wrong length is refused', () => {
  const fixture = createFixture();
  try {
    const { run } = runFinalize(fixture, {
      ctx: { 'needs.prepare.outputs.android-bytes': String(ANDROID_BYTES.length + 1) },
    });
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /retained length .* != producer/);
  } finally {
    fixture.cleanup();
  }
});

test('a retained qaren tarball that does not match the producer identity stops finalize', () => {
  const fixture = createFixture();
  try {
    const { run } = runFinalize(fixture, {
      ctx: { 'needs.prepare.outputs.qaren-darwin-arm64-sha256': sha256('substituted') },
    });
    assert.equal(run.ok, false);
    assert.match(
      run.failed!.stderr,
      /qaren-0\.76\.7-darwin-arm64\.tar\.gz: retained sha256 .* != producer/,
    );
    assert.equal(originRef(fixture, 'refs/heads/changeset-release/main'), fixture.candidate);
  } finally {
    fixture.cleanup();
  }
});

test('a missing retained zip is a partial handoff and refuses', () => {
  const fixture = createFixture();
  try {
    const dir = checkout(fixture, fixture.candidate);
    write(dir, `handoff/${IOS_ZIP}`, IOS_BYTES);
    const run = runJobSteps({
      workflow: release,
      jobId: 'finalize',
      cwd: dir,
      ctx: releaseCtx(fixture),
      env: baseEnv(fixture),
    });
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /retained rn-android-runner-0\.76\.7\.zip is missing/);
  } finally {
    fixture.cleanup();
  }
});

test('finalize refuses to land on a version branch that moved away from its candidate', () => {
  const fixture = createFixture();
  try {
    const dir = checkout(fixture, fixture.candidate);
    handoff(dir);
    // The branch is regenerated underneath this run (main advanced).
    const other = fullClone(fixture);
    git(other, 'checkout', '--quiet', 'changeset-release/main');
    write(other, 'packages/qaren-plugin/CHANGELOG.md', 'regenerated\n');
    git(other, 'commit', '--quiet', '-am', 'chore(release): version packages');
    git(other, 'push', '--quiet', 'origin', 'changeset-release/main');
    const moved = originRef(fixture, 'refs/heads/changeset-release/main');
    const run = runJobSteps({
      workflow: release,
      jobId: 'finalize',
      cwd: dir,
      ctx: releaseCtx(fixture),
      env: baseEnv(fixture),
    });
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /stale info|rejected/);
    assert.equal(originRef(fixture, 'refs/heads/changeset-release/main'), moved);
  } finally {
    fixture.cleanup();
  }
});

// --- validate: the prepared trust root against the handoff and native inputs ---

const PREPARED_STEP = 'Prepared trust root matches the retained bytes and the native inputs';

function treeCtx(fixture: Fixture, ref: string): Record<string, string> {
  return {
    'needs.prepare.outputs.ios-tree': git(
      fixture.root,
      '--git-dir',
      fixture.origin,
      'rev-parse',
      `${ref}:packages/rn-fast-runner`,
    ).trim(),
    'needs.prepare.outputs.android-tree': git(
      fixture.root,
      '--git-dir',
      fixture.origin,
      'rev-parse',
      `${ref}:packages/rn-android-runner`,
    ).trim(),
  };
}

test('validate accepts H when the trust root equals the producer handoff and native inputs are unchanged', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const run = runJobSteps({
      workflow: release,
      jobId: 'validate',
      cwd: checkout(fixture, fixture.head!),
      ctx: releaseCtx(fixture, treeCtx(fixture, fixture.candidate)),
      env: baseEnv(fixture),
      only: [PREPARED_STEP],
    });
    assert.ok(run.ok, run.failed?.stderr);
    assert.match(stepStdout(run, PREPARED_STEP), /action=prepared/);
  } finally {
    fixture.cleanup();
  }
});

test('validate refuses H when the producer built other native inputs or other bytes', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const trees = treeCtx(fixture, fixture.candidate);
    const otherTree = runJobSteps({
      workflow: release,
      jobId: 'validate',
      cwd: checkout(fixture, fixture.head!),
      ctx: releaseCtx(fixture, { ...trees, 'needs.prepare.outputs.ios-tree': SHA_B }),
      env: baseEnv(fixture),
      only: [PREPARED_STEP],
    });
    assert.equal(otherTree.ok, false);
    assert.match(otherTree.failed!.stderr, /iOS runner sources differ/);
    const otherBytes = runJobSteps({
      workflow: release,
      jobId: 'validate',
      cwd: checkout(fixture, fixture.head!),
      ctx: releaseCtx(fixture, {
        ...trees,
        'needs.prepare.outputs.android-sha256': sha256('rebuilt'),
      }),
      env: baseEnv(fixture),
      only: [PREPARED_STEP],
    });
    assert.equal(otherBytes.ok, false);
    assert.match(otherBytes.failed!.stderr, /does not match the producer handoff/);
    const otherTarball = runJobSteps({
      workflow: release,
      jobId: 'validate',
      cwd: checkout(fixture, fixture.head!),
      ctx: releaseCtx(fixture, {
        ...trees,
        'needs.prepare.outputs.qaren-darwin-arm64-bytes': '1',
      }),
      env: baseEnv(fixture),
      only: [PREPARED_STEP],
    });
    assert.equal(otherTarball.ok, false);
    assert.match(otherTarball.failed!.stderr, /qaren darwin-arm64 digest .* does not match/);
  } finally {
    fixture.cleanup();
  }
});

test('validate refuses a release head that is more than the candidate plus its trust root', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const dir = checkout(fixture, fixture.head!);
    write(dir, 'README.md', 'slipped in after the producer built the tarballs\n');
    git(dir, 'commit', '--quiet', '-am', 'extra');
    const extra = runJobSteps({
      workflow: release,
      jobId: 'validate',
      cwd: dir,
      ctx: releaseCtx(fixture, {
        ...treeCtx(fixture, fixture.candidate),
        'needs.finalize.outputs.head-sha': git(dir, 'rev-parse', 'HEAD').trim(),
      }),
      env: baseEnv(fixture),
      only: [PREPARED_STEP],
    });
    assert.equal(extra.ok, false);
    assert.match(extra.failed!.stderr, /is not one commit on top of the candidate/);
  } finally {
    fixture.cleanup();
  }
});

test('validate fetches the candidate parent its trust-root check compares against', () => {
  // The fixture clones fully; the hosted checkout is shallow unless told otherwise.
  const checkoutStep = steps(release, 'validate').find((s) =>
    s.uses?.startsWith('actions/checkout@'),
  );
  assert.ok(Number(checkoutStep?.with?.['fetch-depth']) >= 2);
});

test('validate reaches its verdict offline: no release asset is ever consulted', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const run = runJobSteps({
      workflow: release,
      jobId: 'validate',
      cwd: checkout(fixture, fixture.head!),
      ctx: releaseCtx(fixture, treeCtx(fixture, fixture.candidate)),
      env: baseEnv(fixture),
      only: [PREPARED_STEP],
    });
    assert.ok(run.ok, run.failed?.stderr);
    assert.deepEqual(ghCalls(fixture), []);
  } finally {
    fixture.cleanup();
  }
  // The remaining steps (dist freshness, unit/integration tests, version sync)
  // cannot run in the fixture; their commands are checked as commands.
  for (const step of steps(release, 'validate')) {
    if (!step.run) continue;
    for (const tokens of shellCommands(step.run).map(withoutGlobalOptions)) {
      assert.notEqual(tokens[0], 'gh', `validate step "${step.name}": ${tokens.join(' ')}`);
    }
  }
});

// --- publish: draft targeting H, read back, then published ---

const READ_STEP = "Read the candidate's files by SHA";
const HANDOFF_STEP = 'Verify the handoff against the producer identity and the candidate';
const DECIDE_STEP = 'Decide against the release state for this version';
const RETIRE_STEP = 'Retire the stale draft (prepublication state only)';
const STAGE_STEP = 'Stage the draft release from the retained bytes, targeting the candidate';
const READBACK_STEP = 'Read the release back and compare every byte with the candidate trust root';
const PUBLISH_STEP = 'Publish the verified draft';
const CONFIRM_STEP = 'Confirm the public release is from the exact candidate';

function runPublish(
  fixture: Fixture,
  only: string[],
  { ctx = {}, env = {} }: { ctx?: Record<string, string>; env?: Record<string, string> } = {},
) {
  const dir = checkout(fixture, 'main');
  handoff(dir);
  return runJobSteps({
    workflow: release,
    jobId: 'publish',
    cwd: dir,
    ctx: releaseCtx(fixture, ctx),
    env: { ...baseEnv(fixture), ...env },
    only,
  });
}

const PUBLISH_PATH = [
  READ_STEP,
  HANDOFF_STEP,
  DECIDE_STEP,
  STAGE_STEP,
  READBACK_STEP,
  PUBLISH_STEP,
  CONFIRM_STEP,
];

test('first publication stages a draft targeting H, uploads the retained bytes once, reads them back, then publishes', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const run = runPublish(fixture, PUBLISH_PATH);
    assert.ok(run.ok, run.failed?.stderr);
    assert.equal(run.outputs.decide.action, 'publish');
    const state = fixture.gh.state();
    assert.equal(state.releases[TAG].draft, false);
    assert.equal(state.releases[TAG].target, fixture.head);
    assert.equal(state.tags[TAG], fixture.head);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(state.releases[TAG].assets).map(([name, a]) => [name, a.uploads]),
      ),
      {
        [IOS_ZIP]: 1,
        [ANDROID_ZIP]: 1,
        [QAREN_ARM64_TGZ]: 1,
        'runner-manifest.json': 1,
      },
    );
    assert.equal(
      readFileSync(fixture.gh.assetPath(TAG, 'runner-manifest.json'), 'utf8'),
      manifestFor(),
    );
    const calls = ghCalls(fixture);
    assert.ok(
      calls.some((c) => c.startsWith(`release create ${TAG} --draft --target ${fixture.head}`)),
      calls.join('\n'),
    );
    const create = calls.findIndex((c) => c.startsWith('release create'));
    const publish = calls.findIndex((c) => c === `release edit ${TAG} --draft=false`);
    const readback = calls.findIndex((c) => c.startsWith(`release download ${TAG} --dir readback`));
    assert.ok(create < readback && readback < publish, 'draft -> read back -> publish');
    assert.ok(!calls.some((c) => c.includes('--clobber')), 'no upload ever clobbers');
    assert.ok(!calls.some((c) => c.startsWith('release delete')));
  } finally {
    fixture.cleanup();
  }
});

test('a rerun after publication is a no-op retry: nothing is created, uploaded or re-published', () => {
  const fixture = createFixture({ prepared: true });
  try {
    assert.ok(runPublish(fixture, PUBLISH_PATH).ok);
    const before = fixture.gh.state();
    const run = runPublish(fixture, [
      READ_STEP,
      HANDOFF_STEP,
      DECIDE_STEP,
      READBACK_STEP,
      CONFIRM_STEP,
    ]);
    assert.ok(run.ok, run.failed?.stderr);
    assert.equal(run.outputs.decide.action, 'already-public');
    assert.deepEqual(fixture.gh.state().releases, before.releases);
    const calls = ghCalls(fixture).slice(fixture.gh.calls().length / 2);
    assert.ok(!calls.some((c) => /^release (create|upload|edit|delete)/.test(c)), calls.join('\n'));
  } finally {
    fixture.cleanup();
  }
});

test("a stale draft from an earlier candidate is retired and rebuilt from this run's retained bytes", () => {
  const fixture = createFixture({
    prepared: true,
    releases: {
      [TAG]: { assets: { [IOS_ZIP]: 'draft-from-an-older-candidate' }, draft: true, target: SHA_B },
    },
  });
  try {
    const run = runPublish(fixture, [
      READ_STEP,
      HANDOFF_STEP,
      DECIDE_STEP,
      RETIRE_STEP,
      STAGE_STEP,
      READBACK_STEP,
      PUBLISH_STEP,
      CONFIRM_STEP,
    ]);
    assert.ok(run.ok, run.failed?.stderr);
    assert.equal(run.outputs.decide.action, 'replace-draft');
    const state = fixture.gh.state();
    assert.equal(state.releases[TAG].target, fixture.head);
    assert.equal(readFileSync(fixture.gh.assetPath(TAG, IOS_ZIP), 'utf8'), IOS_BYTES);
    const calls = ghCalls(fixture);
    assert.ok(
      calls.indexOf(`release delete ${TAG} --yes`) <
        calls.findIndex((c) => c.startsWith('release create')),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a release already published from another head refuses before any write', () => {
  const fixture = createFixture({
    prepared: true,
    releases: {
      [TAG]: {
        assets: {
          [IOS_ZIP]: IOS_BYTES,
          [ANDROID_ZIP]: ANDROID_BYTES,
          [QAREN_ARM64_TGZ]: QAREN_ARM64_BYTES,
          'runner-manifest.json': manifestFor(),
        },
        draft: false,
        target: SHA_B,
      },
    },
    tags: { [TAG]: SHA_B },
  });
  try {
    const run = runPublish(fixture, PUBLISH_PATH);
    assert.equal(run.ok, false);
    assert.equal(run.failed!.name, DECIDE_STEP);
    assert.match(run.failed!.stderr, /published from b{40}, not the candidate/);
    assert.match(run.failed!.stderr, /published-but-not-advertised/);
    assert.ok(!ghCalls(fixture).some((c) => /^release (create|upload|edit|delete)/.test(c)));
  } finally {
    fixture.cleanup();
  }
});

test('a tag bound elsewhere regenerates the candidate; publish alone refuses it', () => {
  const fixture = createFixture({
    prepared: true,
    prs: [versionPr()],
    tags: { [TAG]: SHA_B },
    releases: { [TAG]: { assets: {}, draft: false, target: SHA_B } },
  });
  try {
    const pending = runVersionStep(fixture, PENDING_STEP);
    assert.ok(pending.ok, pending.failed?.stderr);
    assert.equal(pending.outputs.pending.resume, 'false');
    const publish = runPublish(fixture, PUBLISH_PATH);
    assert.equal(publish.ok, false);
    assert.equal(publish.failed!.name, DECIDE_STEP);
    assert.match(publish.failed!.stderr, /published from b{40}, not the candidate/);
    assert.match(publish.failed!.stderr, /published-but-not-advertised/);
    assert.ok(!ghCalls(fixture).some((c) => /^release (create|upload|edit|delete)/.test(c)));
  } finally {
    fixture.cleanup();
  }
});

test('a published release missing a zip is partial and refuses', () => {
  const fixture = createFixture({
    prepared: true,
    releases: {
      [TAG]: {
        assets: { [IOS_ZIP]: IOS_BYTES, 'runner-manifest.json': manifestFor() },
        draft: false,
        target: SHA_A,
      },
    },
  });
  try {
    const head = fixture.head!;
    const state = fixture.gh.state();
    state.releases[TAG].target = head;
    state.tags[TAG] = head;
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runPublish(fixture, PUBLISH_PATH);
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /without both runner zips/);
  } finally {
    fixture.cleanup();
  }
});

test('a published release missing a qaren tarball is partial and refuses', () => {
  const fixture = createFixture({
    prepared: true,
    releases: {
      [TAG]: {
        assets: {
          [IOS_ZIP]: IOS_BYTES,
          [ANDROID_ZIP]: ANDROID_BYTES,
          'runner-manifest.json': manifestFor(),
        },
        draft: false,
        target: SHA_A,
      },
    },
  });
  try {
    const head = fixture.head!;
    const state = fixture.gh.state();
    state.releases[TAG].target = head;
    state.tags[TAG] = head;
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runPublish(fixture, PUBLISH_PATH);
    assert.equal(run.ok, false);
    assert.equal(run.failed!.name, DECIDE_STEP);
    assert.match(run.failed!.stderr, /without the Apple silicon qaren tarball/);
  } finally {
    fixture.cleanup();
  }
});

test('tampered public bytes fail the read-back and are never re-published', () => {
  const fixture = createFixture({ prepared: true });
  try {
    assert.ok(runPublish(fixture, PUBLISH_PATH).ok);
    writeFileSync(fixture.gh.assetPath(TAG, ANDROID_ZIP), 'replacement-bytes-of-the-same-length');
    const run = runPublish(fixture, [
      READ_STEP,
      HANDOFF_STEP,
      DECIDE_STEP,
      READBACK_STEP,
      CONFIRM_STEP,
    ]);
    assert.equal(run.ok, false);
    assert.equal(run.failed!.name, READBACK_STEP);
    assert.match(run.failed!.stderr, /release sha256 .* != candidate/);
    assert.ok(!ghCalls(fixture).some((c) => c.includes('--clobber')));
  } finally {
    fixture.cleanup();
  }
});

test('a staged draft whose bytes were swapped before publication never publishes', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const run = runPublish(fixture, [READ_STEP, HANDOFF_STEP, DECIDE_STEP, STAGE_STEP], {});
    assert.ok(run.ok, run.failed?.stderr);
    writeFileSync(fixture.gh.assetPath(TAG, QAREN_ARM64_TGZ), 'swapped');
    const readback = runPublish(fixture, [READ_STEP, READBACK_STEP, PUBLISH_STEP, CONFIRM_STEP]);
    assert.equal(readback.ok, false);
    assert.equal(readback.failed!.name, READBACK_STEP);
    assert.equal(fixture.gh.state().releases[TAG].draft, true, 'stays a draft');
    assert.equal(fixture.gh.state().tags[TAG], undefined, 'no tag is created');
  } finally {
    fixture.cleanup();
  }
});

test('retained bytes that disagree with the candidate trust root are refused before the release is touched', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const dir = checkout(fixture, 'main');
    handoff(dir, 'different-ios-bytes');
    const run = runJobSteps({
      workflow: release,
      jobId: 'publish',
      cwd: dir,
      ctx: releaseCtx(fixture, {
        'needs.prepare.outputs.ios-sha256': sha256('different-ios-bytes'),
      }),
      env: baseEnv(fixture),
      only: PUBLISH_PATH,
    });
    assert.equal(run.ok, false);
    assert.equal(run.failed!.name, HANDOFF_STEP);
    assert.match(run.failed!.stderr, /!= candidate trust root/);
    assert.ok(!ghCalls(fixture).some((c) => c.startsWith('release')));
  } finally {
    fixture.cleanup();
  }
});

test('a release listing that cannot be read is never taken as "no release"', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const run = runPublish(fixture, PUBLISH_PATH, { env: { GH_STUB_FAIL: 'release view,api' } });
    assert.equal(run.ok, false);
    assert.equal(run.failed!.name, DECIDE_STEP);
    assert.match(run.failed!.stderr, /refusing to guess/);
    assert.ok(!ghCalls(fixture).some((c) => c.startsWith('release create')));
  } finally {
    fixture.cleanup();
  }
});

test('a candidate that does not advertise the pinned version is refused', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const run = runPublish(fixture, PUBLISH_PATH, {
      ctx: { 'needs.version.outputs.version': '0.76.8' },
    });
    assert.equal(run.ok, false);
    assert.equal(run.failed!.name, READ_STEP);
  } finally {
    fixture.cleanup();
  }
});

test('a resumed published candidate is read back byte for byte before its merge', () => {
  const fixture = createFixture({ prepared: true });
  try {
    assert.ok(runPublish(fixture, PUBLISH_PATH).ok);
    const resumed = runJobSteps({
      workflow: release,
      jobId: 'publish',
      cwd: checkout(fixture, 'main'),
      ctx: releaseCtx(fixture, {
        'needs.version.outputs.resume': 'true',
        'needs.version.outputs.head-sha': fixture.head!,
        'needs.finalize.outputs.head-sha': '',
      }),
      env: baseEnv(fixture),
      only: [READ_STEP, READBACK_STEP, CONFIRM_STEP],
    });
    assert.ok(resumed.ok, resumed.failed?.stderr);
    writeFileSync(fixture.gh.assetPath(TAG, IOS_ZIP), 'swapped-after-publication');
    const tampered = runJobSteps({
      workflow: release,
      jobId: 'publish',
      cwd: checkout(fixture, 'main'),
      ctx: releaseCtx(fixture, {
        'needs.version.outputs.resume': 'true',
        'needs.version.outputs.head-sha': fixture.head!,
        'needs.finalize.outputs.head-sha': '',
      }),
      env: baseEnv(fixture),
      only: [READ_STEP, READBACK_STEP, CONFIRM_STEP],
    });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.failed!.name, READBACK_STEP);
  } finally {
    fixture.cleanup();
  }
});

// --- merge: readiness on the exact head, then --match-head-commit ---

function check(conclusion: string | null, status = 'completed'): GhCheckRun {
  return {
    name: 'Build & Test',
    status,
    conclusion,
    html_url: 'https://github.com/x/actions/runs/1/job/2',
    app: { slug: 'github-actions' },
  };
}

function runMerge(fixture: Fixture, ctx: Record<string, string> = {}) {
  return runJobSteps({
    workflow: release,
    jobId: 'merge',
    cwd: fixture.root,
    ctx: releaseCtx(fixture, ctx),
    env: { ...baseEnv(fixture), READINESS_WAIT_MINUTES: '0', READINESS_POLL_SECONDS: '0' },
  });
}

// A release published from H the way the publish job leaves it.
function publishedFixture(options: FixtureOptions = {}): Fixture {
  const fixture = createFixture({ prepared: true, prs: [versionPr()], ...options });
  const head = fixture.head!;
  const state = fixture.gh.state();
  state.releases[TAG] = {
    assets: {
      ...Object.fromEntries(ALL_ASSETS.map((name) => [name, { uploads: 1 }])),
      'runner-manifest.json': { uploads: 1 },
    },
    draft: false,
    target: head,
  };
  state.tags[TAG] = head;
  writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
  mkdirSync(dirname(fixture.gh.assetPath(TAG, IOS_ZIP)), { recursive: true });
  writeFileSync(fixture.gh.assetPath(TAG, IOS_ZIP), IOS_BYTES);
  writeFileSync(fixture.gh.assetPath(TAG, ANDROID_ZIP), ANDROID_BYTES);
  writeFileSync(fixture.gh.assetPath(TAG, QAREN_ARM64_TGZ), QAREN_ARM64_BYTES);
  writeFileSync(fixture.gh.assetPath(TAG, 'runner-manifest.json'), manifestFor());
  return fixture;
}

test('with the release public and Build & Test green on H, exactly H is squash-merged', () => {
  const fixture = publishedFixture();
  try {
    const state = fixture.gh.state();
    state.checks[fixture.head!] = [check('success')];
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runMerge(fixture);
    assert.ok(run.ok, run.failed?.stderr);
    assert.equal(fixture.gh.state().prs[0].state, 'MERGED');
    assert.ok(
      ghCalls(fixture).includes(`pr merge --squash --match-head-commit ${fixture.head} 11`),
    );
    assert.ok(!ghCalls(fixture).some((c) => c.includes('--auto')), 'never auto-merge');
  } finally {
    fixture.cleanup();
  }
});

test('a bot-opened PR whose CI still awaits approval fails with the approve/rerun instruction and merges nothing', () => {
  const fixture = publishedFixture();
  try {
    const run = runMerge(fixture);
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /Approve and run/);
    assert.match(run.failed!.stderr, /re-run this workflow's failed jobs/);
    assert.equal(fixture.gh.state().prs[0].state, 'OPEN');
    assert.ok(!ghCalls(fixture).some((c) => c.startsWith('pr merge')));
  } finally {
    fixture.cleanup();
  }
});

test('a queued or running check is waited for, not treated as failure', () => {
  const fixture = publishedFixture();
  try {
    const state = fixture.gh.state();
    state.checks[fixture.head!] = [check(null, 'in_progress')];
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runMerge(fixture);
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /no successful Build & Test check on .* yet \(in_progress/);
  } finally {
    fixture.cleanup();
  }
});

test('a failed Build & Test on H refuses and names the rerun, never a bypass', () => {
  const fixture = publishedFixture();
  try {
    const state = fixture.gh.state();
    state.checks[fixture.head!] = [check('failure')];
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runMerge(fixture);
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /concluded failure .* rerun that CI run/);
    assert.ok(!ghCalls(fixture).some((c) => c.startsWith('pr merge')));
  } finally {
    fixture.cleanup();
  }
});

test('a check that passed on another head never counts for H', () => {
  const fixture = publishedFixture();
  try {
    const state = fixture.gh.state();
    state.checks[fixture.candidate] = [check('success')];
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runMerge(fixture);
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /no successful Build & Test check/);
  } finally {
    fixture.cleanup();
  }
});

test('a PR head that moved after publication voids readiness before any check is consulted', () => {
  const fixture = publishedFixture();
  try {
    const other = fullClone(fixture);
    git(other, 'checkout', '--quiet', 'changeset-release/main');
    write(other, 'README.md', 'rebased\n');
    git(other, 'commit', '--quiet', '-am', 'rebase');
    git(other, 'push', '--quiet', 'origin', 'changeset-release/main');
    const state = fixture.gh.state();
    state.checks[originRef(fixture, 'refs/heads/changeset-release/main')!] = [check('success')];
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runMerge(fixture);
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /head moved from the published candidate/);
    assert.match(run.failed!.stderr, /published-but-not-advertised/);
    assert.ok(!ghCalls(fixture).some((c) => c.includes('check-runs')));
    assert.ok(!ghCalls(fixture).some((c) => c.startsWith('pr merge')));
  } finally {
    fixture.cleanup();
  }
});

test('publication order: a draft or absent release never merges even with a green check', () => {
  const draft = createFixture({
    prepared: true,
    prs: [versionPr()],
    releases: { [TAG]: { assets: {}, draft: true } },
  });
  try {
    const state = draft.gh.state();
    state.checks[draft.head!] = [check('success')];
    writeFileSync(join(draft.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runMerge(draft);
    assert.equal(run.ok, false);
    assert.equal(run.failed!.name, 'Require the public release from the exact candidate');
    assert.ok(!ghCalls(draft).some((c) => c.startsWith('pr merge')));
  } finally {
    draft.cleanup();
  }
  const absent = createFixture({ prepared: true, prs: [versionPr()] });
  try {
    const run = runMerge(absent);
    assert.equal(run.ok, false);
    assert.equal(run.failed!.name, 'Require the public release from the exact candidate');
  } finally {
    absent.cleanup();
  }
});

test('a tag that no longer points at H refuses the merge', () => {
  const fixture = publishedFixture({ tags: { [TAG]: SHA_B } });
  try {
    const state = fixture.gh.state();
    state.tags[TAG] = SHA_B;
    state.checks[fixture.head!] = [check('success')];
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runMerge(fixture);
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /points at b{40}, not the candidate/);
  } finally {
    fixture.cleanup();
  }
});

// --- ci.yml: postpublication public-asset assertion ---

const CI_STEP = 'Published runner assets match the trust root';

function runCi(
  fixture: Fixture,
  dir: string,
  ctx: Record<string, string>,
  env: Record<string, string> = {},
) {
  return runJobSteps({
    workflow: ci,
    jobId: 'core-tests',
    cwd: dir,
    ctx: {
      'secrets.GITHUB_TOKEN': 'stub-token',
      'github.repository': REPO,
      'github.base_ref': '',
      'github.event.before': '',
      ...ctx,
    },
    env: { ...baseEnv(fixture), ...env },
    only: [CI_STEP],
  });
}

test('the release PR run asserts the public bytes of the version it advertises', () => {
  const fixture = publishedFixture();
  try {
    const run = runCi(fixture, checkout(fixture, fixture.head!), { 'github.base_ref': 'main' });
    assert.ok(run.ok, run.failed?.stderr);
    assert.match(
      stepStdout(run, CI_STEP),
      /public runner assets for v0\.76\.7 match the trust root/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('before publication the release PR run fails on the missing release — the required check cannot pass early', () => {
  const fixture = createFixture({ prepared: true });
  try {
    const run = runCi(fixture, checkout(fixture, fixture.head!), { 'github.base_ref': 'main' });
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /release v0\.76\.7 is not published/);
  } finally {
    fixture.cleanup();
  }
});

test('an ordinary PR that keeps the base version and root stays offline', () => {
  const fixture = createFixture();
  try {
    const run = runCi(fixture, checkout(fixture, 'main'), { 'github.base_ref': 'main' });
    assert.ok(run.ok, run.failed?.stderr);
    assert.match(stepStdout(run, CI_STEP), /staying offline/);
    assert.deepEqual(ghCalls(fixture), []);
  } finally {
    fixture.cleanup();
  }
});

test('a manifest edit without a version bump still faces the public bytes', () => {
  const fixture = createFixture();
  try {
    const dir = checkout(fixture, 'main');
    for (const path of MANIFEST_PATHS)
      write(dir, path, manifestFor(ADVERTISED, 'edited-ios', 'old-android'));
    const run = runCi(fixture, dir, { 'github.base_ref': 'main' });
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /release v0\.76\.6 is not published/);
  } finally {
    fixture.cleanup();
  }
});

test('the push of the merged version to main is asserted against the previous head', () => {
  const fixture = publishedFixture();
  try {
    const run = runCi(fixture, checkout(fixture, fixture.head!), {
      'github.event.before': fixture.base,
    });
    assert.ok(run.ok, run.failed?.stderr);
    assert.ok(ghCalls(fixture).some((c) => c.startsWith('release download')));
  } finally {
    fixture.cleanup();
  }
});

test('a failed asset transfer fails as itself, never as a missing or divergent public byte', () => {
  const fixture = publishedFixture();
  try {
    const run = runCi(
      fixture,
      checkout(fixture, fixture.head!),
      { 'github.base_ref': 'main' },
      { GH_STUB_FAIL: 'release download' },
    );
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /a failed transfer is not divergence/);
    assert.doesNotMatch(run.failed!.stderr, /carries no|!= trust root/);
  } finally {
    fixture.cleanup();
  }
});

test('a stale root, tampered bytes, a wrong length, a missing zip, a draft or a divergent manifest asset all fail', () => {
  const cases: Array<[string, (f: Fixture) => void, RegExp]> = [
    [
      'tampered',
      (f) => writeFileSync(f.gh.assetPath(TAG, IOS_ZIP), 'tampered-bytes-same-len'),
      /public sha256 .* != trust root/,
    ],
    [
      'length',
      (f) => writeFileSync(f.gh.assetPath(TAG, ANDROID_ZIP), ANDROID_BYTES + 'x'),
      /public sha256|public length/,
    ],
    [
      'missing',
      (f) => {
        const s = f.gh.state();
        delete s.releases[TAG].assets[ANDROID_ZIP];
        writeFileSync(join(f.root, 'gh-state', 'state.json'), JSON.stringify(s));
      },
      /carries no rn-android-runner/,
    ],
    [
      'draft',
      (f) => {
        const s = f.gh.state();
        s.releases[TAG].draft = true;
        writeFileSync(join(f.root, 'gh-state', 'state.json'), JSON.stringify(s));
      },
      /not published/,
    ],
    [
      'manifest',
      (f) => writeFileSync(f.gh.assetPath(TAG, 'runner-manifest.json'), manifestFor(VERSION, 'x')),
      /differs from the trust root/,
    ],
    [
      'tarball',
      (f) => writeFileSync(f.gh.assetPath(TAG, QAREN_ARM64_TGZ), 'tampered-arm64-tarball-xx'),
      /qaren-0\.76\.7-darwin-arm64\.tar\.gz: public sha256 .* != trust root/,
    ],
    [
      'missing tarball',
      (f) => {
        const s = f.gh.state();
        delete s.releases[TAG].assets[QAREN_ARM64_TGZ];
        writeFileSync(join(f.root, 'gh-state', 'state.json'), JSON.stringify(s));
      },
      /carries no qaren-0\.76\.7-darwin-arm64\.tar\.gz/,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const fixture = publishedFixture();
    try {
      mutate(fixture);
      const run = runCi(fixture, checkout(fixture, fixture.head!), { 'github.base_ref': 'main' });
      assert.equal(run.ok, false, label);
      assert.match(run.failed!.stderr, expected, label);
      assert.ok(
        !ghCalls(fixture).some((c) => c.startsWith('release upload')),
        `${label}: CI never writes`,
      );
    } finally {
      fixture.cleanup();
    }
  }
  const divergentCopy = createFixture({ prepared: true });
  try {
    const dir = checkout(divergentCopy, divergentCopy.head!);
    write(dir, 'packages/qaren-plugin/runner-manifest.json', manifestFor(VERSION, 'other-ios'));
    const run = runCi(divergentCopy, dir, { 'github.base_ref': 'main' });
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /qaren-plugin\/runner-manifest\.json is missing or differs/);
  } finally {
    divergentCopy.cleanup();
  }
  const stale = createFixture({ prepared: true });
  try {
    const dir = checkout(stale, stale.head!);
    for (const path of MANIFEST_PATHS) write(dir, path, manifestFor(ADVERTISED));
    const run = runCi(stale, dir, { 'github.base_ref': 'main' });
    assert.equal(run.ok, false);
    assert.match(
      run.failed!.stderr,
      /vouches for v0\.76\.6 while plugin\.json advertises v0\.76\.7/,
    );
  } finally {
    stale.cleanup();
  }
});

// --- the sweep: verify, repair only a missing manifest asset ---

const SWEEP_STEP =
  "Public runner assets match main's trust root (repair a missing manifest asset only)";

function runSweep(fixture: Fixture) {
  return runJobSteps({
    workflow: sweepWorkflow,
    jobId: 'sweep',
    cwd: checkout(fixture, fixture.head!),
    ctx: { 'secrets.GITHUB_TOKEN': 'stub-token', 'github.repository': REPO },
    env: baseEnv(fixture),
    only: [SWEEP_STEP],
  });
}

test('the sweep re-attaches a missing manifest asset from the trust root and never touches a zip', () => {
  const fixture = publishedFixture();
  try {
    const state = fixture.gh.state();
    delete state.releases[TAG].assets['runner-manifest.json'];
    rmSync(fixture.gh.assetPath(TAG, 'runner-manifest.json'));
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const run = runSweep(fixture);
    assert.ok(run.ok, run.failed?.stderr);
    assert.match(stepStdout(run, SWEEP_STEP), /re-attached the missing runner-manifest\.json/);
    assert.equal(
      readFileSync(fixture.gh.assetPath(TAG, 'runner-manifest.json'), 'utf8'),
      manifestFor(),
    );
    const uploads = ghCalls(fixture).filter((c) => c.startsWith('release upload'));
    assert.equal(uploads.length, 1);
    assert.ok(!uploads[0].includes('.zip') && !uploads[0].includes('--clobber'));
  } finally {
    fixture.cleanup();
  }
});

test('the sweep fails on divergent public bytes instead of rebuilding or replacing them', () => {
  const fixture = publishedFixture();
  try {
    writeFileSync(fixture.gh.assetPath(TAG, IOS_ZIP), 'rebuilt-by-someone-else');
    const run = runSweep(fixture);
    assert.equal(run.ok, false);
    assert.match(run.failed!.stderr, /public sha256 .* != trust root/);
    assert.ok(!ghCalls(fixture).some((c) => /^release (upload|create|edit|delete)/.test(c)));
  } finally {
    fixture.cleanup();
  }
});

// --- the producer ---

test('the producer refuses anything but a full candidate SHA before checking out', () => {
  for (const jobId of ['build-ios', 'build-android', 'build-qaren']) {
    for (const [ref, ok] of [
      [SHA_A, true],
      ['main', false],
      ['', false],
      [SHA_A.slice(0, 12), false],
      ['refs/heads/main', false],
    ] as const) {
      const run = runJobSteps({
        workflow: artifacts,
        jobId,
        cwd: repoRoot,
        ctx: { 'inputs.ref': ref },
        env: {},
        only: ['Refuse anything but a full candidate SHA'],
      });
      assert.equal(run.ok, ok, `${jobId} ref='${ref}'`);
    }
  }
});

// --- structure pinned across both workflows ---

// Global options never hide a subcommand: `git -c k=v push` and
// `gh -R owner/repo pr merge` match the same as their bare spellings.
function withoutGlobalOptions(tokens: string[]): string[] {
  const out = [...tokens];
  if (out[0] === 'git') {
    while (out.length > 1 && out[1].startsWith('-')) {
      out.splice(
        1,
        out[1].startsWith('--') && out[1].includes('=')
          ? 1
          : /^-(c|C)$|^--(git-dir|work-tree|namespace)$/.test(out[1])
            ? 2
            : 1,
      );
    }
  } else if (out[0] === 'gh') {
    while (out.length > 1 && out[1].startsWith('-')) {
      out.splice(1, /^(-R|--repo)$/.test(out[1]) ? 2 : 1);
    }
  }
  return out;
}

function everyRun(workflow: Workflow): Array<{ jobId: string; step: WorkflowStep }> {
  return Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
    (job.steps ?? []).flatMap((step) => (step.run ? [{ jobId, step }] : [])),
  );
}

test('the producer is a read-only callable: no release writes, no branch pushes, no persisted credential', () => {
  assert.deepEqual(artifacts.permissions, { contents: 'read' });
  // GitHub validates a called workflow's nested-job permissions against the
  // CALLING job at run startup and ignores the nested `if:`, so any job here
  // asking for more than the caller's contents: read rejects every release run.
  assert.deepEqual(
    Object.fromEntries(Object.entries(artifacts.jobs).map(([id, job]) => [id, job.permissions])),
    { 'build-ios': undefined, 'build-android': undefined, 'build-qaren': undefined },
  );
  for (const jobId of ['build-ios', 'build-android', 'build-qaren']) {
    const job = artifacts.jobs[jobId];
    const checkoutStep = (job.steps ?? []).find((s) => s.uses?.startsWith('actions/checkout@'));
    assert.equal(checkoutStep?.with?.ref, '${{ inputs.ref }}');
    assert.equal(String(checkoutStep?.with?.['persist-credentials']), 'false');
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      for (const tokens of shellCommands(step.run).map(withoutGlobalOptions)) {
        assert.notEqual(tokens[0], 'gh', `${jobId}: ${tokens.join(' ')}`);
        assert.ok(!(tokens[0] === 'git' && tokens[1] === 'push'), `${jobId}: ${tokens.join(' ')}`);
      }
    }
  }
  const on = (artifacts as unknown as { on: Record<string, unknown> }).on;
  assert.deepEqual(Object.keys(on), ['workflow_call'], 'callable only: no mutable-main builds');
  const sweepOn = (sweepWorkflow as unknown as { on: Record<string, unknown> }).on;
  assert.deepEqual(Object.keys(sweepOn).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(sweepWorkflow.permissions, { contents: 'read' });
  assert.deepEqual(sweepWorkflow.jobs.sweep.permissions, { contents: 'write' });
  assert.match(String(sweepWorkflow.jobs.sweep.if), /github\.ref == 'refs\/heads\/main'/);
  const sweepCheckout = (sweepWorkflow.jobs.sweep.steps ?? []).find((s) =>
    s.uses?.startsWith('actions/checkout@'),
  );
  assert.equal(sweepCheckout?.with?.ref, 'main');
  assert.equal(String(sweepCheckout?.with?.['persist-credentials']), 'false');
});

test('no step in either workflow clobbers a release asset, arms auto-merge or pushes main', () => {
  for (const workflow of [release, artifacts, sweepWorkflow]) {
    for (const { jobId, step } of everyRun(workflow)) {
      for (const tokens of shellCommands(step.run!).map(withoutGlobalOptions)) {
        const line = tokens.join(' ');
        assert.ok(!tokens.includes('--clobber'), `${jobId}: ${line}`);
        assert.ok(
          !(
            tokens[0] === 'gh' &&
            tokens[1] === 'pr' &&
            tokens[2] === 'merge' &&
            tokens.includes('--auto')
          ),
          `${jobId}: ${line}`,
        );
        if (tokens[0] === 'git' && tokens[1] === 'push') {
          assert.ok(
            tokens.some((t) => t.startsWith('HEAD:refs/heads/changeset-release/main')),
            `${jobId}: ${line}`,
          );
          assert.ok(
            tokens.some((t) =>
              t.startsWith('--force-with-lease=refs/heads/changeset-release/main:'),
            ),
            `${jobId}: ${line}`,
          );
        }
      }
    }
  }
});

test('the release transaction is ordered: prepare -> finalize -> validate -> publish -> merge, merge by exact head', () => {
  assert.equal(release.jobs.prepare.needs, 'version');
  assert.equal(
    (release.jobs.prepare as unknown as { uses: string }).uses,
    './.github/workflows/runner-artifacts.yml',
  );
  assert.deepEqual(release.jobs.prepare.permissions, { contents: 'read' });
  for (const [id, job] of Object.entries(artifacts.jobs)) {
    for (const [scope, level] of Object.entries(job.permissions ?? {})) {
      assert.ok(
        scope === 'contents' && level !== 'write',
        `nested job "${id}" requests ${scope}: ${level}, exceeding prepare's contents: read`,
      );
    }
  }
  assert.deepEqual(release.jobs.finalize.needs, ['version', 'prepare']);
  assert.deepEqual(release.jobs.validate.needs, ['version', 'prepare', 'finalize']);
  assert.deepEqual(release.jobs.publish.needs, ['version', 'prepare', 'finalize', 'validate']);
  assert.deepEqual(release.jobs.merge.needs, ['version', 'finalize', 'publish']);
  assert.match(String(release.jobs.publish.if), /needs\.validate\.result == 'success'/);
  assert.match(String(release.jobs.merge.if), /needs\.publish\.result == 'success'/);
  const mergeStep = steps(release, 'merge').find((s) => s.name === 'Merge exactly the candidate');
  assert.ok(
    shellCommands(mergeStep!.run!).some(
      (t) =>
        t[0] === 'gh' && t[1] === 'pr' && t[2] === 'merge' && t.includes('--match-head-commit'),
    ),
  );
  const artifactSteps = [...steps(release, 'finalize'), ...steps(release, 'publish')].filter((s) =>
    s.uses?.startsWith('actions/download-artifact@'),
  );
  assert.equal(artifactSteps.length, 2);
  const expectedIds = {
    'ios-artifact-id': '101',
    'android-artifact-id': '102',
    'qaren-darwin-arm64-artifact-id': '103',
  };
  const producerIds = {
    'jobs.build-ios.outputs.artifact-id': expectedIds['ios-artifact-id'],
    'jobs.build-android.outputs.artifact-id': expectedIds['android-artifact-id'],
    'jobs.build-qaren.outputs.darwin-arm64-artifact-id':
      expectedIds['qaren-darwin-arm64-artifact-id'],
  };
  const exposedOutputs = (
    artifacts as unknown as {
      on: { workflow_call: { outputs: Record<string, { value: string }> } };
    }
  ).on.workflow_call.outputs;
  const prepareOutputs = Object.fromEntries(
    Object.entries(expectedIds).map(([name, id]) => {
      assert.ok(exposedOutputs[name], `producer must expose ${name}`);
      const resolved = resolveExpressions(exposedOutputs[name].value, producerIds);
      assert.equal(resolved, id, `producer output ${name}`);
      return [`needs.prepare.outputs.${name}`, resolved];
    }),
  );
  for (const step of artifactSteps) {
    const ids = resolveExpressions(String(step.with?.['artifact-ids']), prepareOutputs)
      .split(',')
      .map((id) => id.trim());
    assert.deepEqual(new Set(ids), new Set(Object.values(expectedIds)));
  }
  for (const name of [RETIRE_STEP]) {
    assert.equal(
      steps(release, 'publish').find((s) => s.name === name)?.if,
      "steps.decide.outputs.action == 'replace-draft'",
    );
  }
  for (const name of [STAGE_STEP, PUBLISH_STEP]) {
    assert.equal(
      steps(release, 'publish').find((s) => s.name === name)?.if,
      "steps.decide.outputs.action == 'publish' || steps.decide.outputs.action == 'replace-draft'",
    );
  }
  assert.equal(
    steps(release, 'publish').find((s) => s.name === READBACK_STEP)?.if,
    undefined,
    'read-back runs on every path',
  );
  assert.ok(stepNames(release, 'version').includes(PENDING_STEP));
  const changesets = steps(release, 'version').find((s) =>
    s.uses?.startsWith('changesets/action@'),
  );
  assert.equal(changesets?.if, "steps.pending.outputs.resume != 'true'");
});

test('the public-asset assertion feeds the required Build & Test aggregate through core-tests', () => {
  assert.ok(stepNames(ci, 'core-tests').includes(CI_STEP));
  assert.ok((ci.jobs.test.needs as string[]).includes('core-tests'));
  assert.equal((ci.jobs.test as unknown as { name: string }).name, 'Build & Test');
  assert.ok(existsSync(join(repoRoot, 'scripts', 'check-public-runner-assets.sh')));
});

// --- the whole transaction: main never advertises a version its bundled trust
// root does not describe, and the named zips are already public when it does ---

const trace = process.env.RELEASE_TRUST_ROOT_TRANSCRIPT ? console.log : () => {};

function rootOf(fixture: Fixture, ref: string): { version: string; ios: string; android: string } {
  const root = JSON.parse(
    git(fixture.root, '--git-dir', fixture.origin, 'show', `${ref}:runner-manifest.json`),
  );
  return {
    version: root.version,
    ios: `${root.assets.ios[0].name} sha256=${root.assets.ios[0].sha256.slice(0, 12)}… ${root.assets.ios[0].bytes}B`,
    android: `${root.assets.android[0].name} sha256=${root.assets.android[0].sha256.slice(0, 12)}… ${root.assets.android[0].bytes}B`,
  };
}

function advertisedVersion(fixture: Fixture, ref: string): string {
  return JSON.parse(
    git(
      fixture.root,
      '--git-dir',
      fixture.origin,
      'show',
      `${ref}:packages/qaren-plugin/.claude-plugin/plugin.json`,
    ),
  ).version;
}

test('end to end: the first main commit advertising V carries V’s trust root and its zips are already public', () => {
  const fixture = createFixture({ prs: [versionPr()] });
  try {
    trace(
      `main before      ${fixture.base.slice(0, 12)} advertises ${advertisedVersion(fixture, 'refs/heads/main')}, root ${rootOf(fixture, 'refs/heads/main').version}`,
    );

    const pending = runVersionStep(fixture, PENDING_STEP);
    assert.ok(pending.ok, pending.failed?.stderr);
    assert.notEqual(pending.outputs.pending.resume, 'true');
    const pinned = runVersionStep(fixture, CANDIDATE_STEP);
    assert.ok(pinned.ok, pinned.failed?.stderr);
    assert.equal(pinned.outputs.candidate.version, VERSION);

    // P is what the pre-fix transaction merged: it advertises V while the
    // bundled trust root still describes V-1 and no zip for V is public.
    assert.equal(advertisedVersion(fixture, fixture.candidate), VERSION);
    assert.equal(rootOf(fixture, fixture.candidate).version, ADVERTISED);
    assert.equal(fixture.gh.state().releases[TAG], undefined);
    trace(
      `candidate P      ${fixture.candidate.slice(0, 12)} advertises ${advertisedVersion(fixture, fixture.candidate)}, root ${rootOf(fixture, fixture.candidate).version}  <- the lag`,
    );

    const finalized = runFinalize(fixture);
    assert.ok(finalized.run.ok, finalized.run.failed?.stderr);
    const head = finalized.run.outputs.commit.sha;
    const atHead = { 'needs.finalize.outputs.head-sha': head, [HEAD_EXPR]: head };
    trace(
      `release head H   ${head.slice(0, 12)} advertises ${advertisedVersion(fixture, head)}, root ${rootOf(fixture, head).version}`,
    );

    const beforeValidate = ghCalls(fixture).length;
    const validated = runJobSteps({
      workflow: release,
      jobId: 'validate',
      cwd: checkout(fixture, head),
      ctx: releaseCtx(fixture, { ...treeCtx(fixture, fixture.candidate), ...atHead }),
      env: baseEnv(fixture),
      only: [PREPARED_STEP],
    });
    assert.ok(validated.ok, validated.failed?.stderr);
    assert.equal(ghCalls(fixture).length, beforeValidate, 'validation is offline');

    const publishRun = runPublish(fixture, PUBLISH_PATH, { ctx: atHead });
    assert.ok(publishRun.ok, publishRun.failed?.stderr);
    assert.equal(publishRun.outputs.decide.action, 'publish');
    assert.equal(fixture.gh.state().releases[TAG].draft, false);
    assert.equal(fixture.gh.state().releases[TAG].target, head);
    assert.equal(
      originRef(fixture, 'refs/heads/main'),
      fixture.base,
      'the bytes are public while main still advertises V-1',
    );
    trace(
      `published        ${TAG} -> ${head.slice(0, 12)} while main is still ${advertisedVersion(fixture, 'refs/heads/main')}`,
    );

    const ciRun = runCi(fixture, checkout(fixture, head), { 'github.base_ref': 'main' });
    assert.ok(ciRun.ok, ciRun.failed?.stderr);
    trace(`CI on H          ${stepStdout(ciRun, CI_STEP).trim().split('\n').pop()}`);

    const state = fixture.gh.state();
    state.checks[head] = [check('success')];
    writeFileSync(join(fixture.root, 'gh-state', 'state.json'), JSON.stringify(state));
    const merged = runMerge(fixture, atHead);
    assert.ok(merged.ok, merged.failed?.stderr);
    assert.ok(ghCalls(fixture).includes(`pr merge --squash --match-head-commit ${head} 11`));

    // The squash lands exactly H's tree on main, so H is what an install made
    // the instant the version becomes visible reads.
    assert.equal(fixture.gh.state().prs[0].state, 'MERGED');
    assert.equal(originRef(fixture, 'refs/heads/main'), fixture.base, 'nothing else reached main');
    assert.equal(advertisedVersion(fixture, head), VERSION);
    const root = rootOf(fixture, head);
    assert.equal(root.version, VERSION);
    for (const path of MANIFEST_PATHS) {
      assert.equal(
        git(fixture.root, '--git-dir', fixture.origin, 'show', `${head}:${path}`),
        manifestFor(),
        `${path} is the same trust root`,
      );
    }
    const bundled = JSON.parse(
      git(fixture.root, '--git-dir', fixture.origin, 'show', `${head}:runner-manifest.json`),
    );
    for (const asset of [
      bundled.assets.ios[0],
      bundled.assets.android[0],
      ...Object.values(
        bundled.assets.qaren as Record<string, { name: string; sha256: string; bytes: number }>,
      ),
    ]) {
      const bytes = readFileSync(fixture.gh.assetPath(TAG, asset.name));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.name);
      assert.equal(bytes.length, asset.bytes, asset.name);
    }
    trace(
      `merged           squash --match-head-commit ${head.slice(0, 12)} -> main advertises ${advertisedVersion(fixture, head)}, root ${root.version}`,
    );
    trace(`  bundled root   ${root.ios}`);
    trace(`                 ${root.android}`);
    trace(
      `  public ${TAG}  both zips + runner-manifest.json, bytes verified against the bundled root`,
    );
  } finally {
    fixture.cleanup();
  }
});
