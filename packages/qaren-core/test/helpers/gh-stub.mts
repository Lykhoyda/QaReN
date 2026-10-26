#!/usr/bin/env node
// A gh(1) test double for workflow-step simulations. It keeps releases (with
// draft/target/tag state), pull requests and check runs in a JSON state file,
// records every invocation, and answers --json/--jq queries by running the REAL
// jq over the projected records, so a workflow's own filter is exercised rather
// than re-implemented here.
//
// Env:
//   GH_STUB_STATE            directory holding state.json, calls.jsonl, assets/
//   GH_STUB_FAIL             comma-separated "<group> <sub>" pairs to fail
//   GH_STUB_GIT_DIR          fixture repository the stub resolves refs against

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const stateDir = process.env.GH_STUB_STATE;
if (!stateDir) die('gh stub: GH_STUB_STATE is not set');
const statePath = join(stateDir, 'state.json');
const assetsDir = join(stateDir, 'assets');

const argv = process.argv.slice(2);
appendFileSync(join(stateDir, 'calls.jsonl'), JSON.stringify(argv) + '\n');

// Operands only: a flag that takes a value consumes it, so `--match-head-commit
// <sha> <number>` still leaves the PR number as the operand.
const BOOLEAN_FLAGS = new Set([
  '--draft',
  '--yes',
  '--squash',
  '--merge',
  '--rebase',
  '--auto',
  '--disable-auto',
  '--clobber',
  '--paginate',
  '--admin',
  '--latest',
  '--prerelease',
  '--verify-tag',
]);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('-')) positional.push(a);
  else if (!a.includes('=') && !BOOLEAN_FLAGS.has(a)) i++;
}
const command = positional.slice(0, 2).join(' ');
const injected = (process.env.GH_STUB_FAIL ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (injected.some((f) => command.startsWith(f))) {
  die(`gh stub: injected failure for \`gh ${command}\``);
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readState() {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function flag(name) {
  const i = argv.indexOf(name);
  if (i !== -1) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 1);
}

function flags(name) {
  return argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
}

function has(name) {
  return argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
}

// The workflow's own --jq filter is applied by real jq; the stub only decides
// what records exist, never what a filter means.
function emit(value) {
  const filter = flag('--jq') ?? flag('-q');
  const json = JSON.stringify(value);
  if (!filter) {
    process.stdout.write(json + '\n');
    return;
  }
  const jq = spawnSync('jq', ['-r', filter], { input: json, encoding: 'utf8' });
  if (jq.error) die(`gh stub: jq is required to answer --jq queries (${jq.error.message})`);
  if (jq.status !== 0) die(`gh stub: jq failed: ${jq.stderr}`);
  process.stdout.write(jq.stdout);
}

function project(record, fieldSpec) {
  const fields = (fieldSpec ?? '').split(',').filter(Boolean);
  return Object.fromEntries(fields.map((f) => [f, record[f]]));
}

function assetPath(tag, name) {
  return join(assetsDir, tag.replace(/[^\w.-]/g, '_'), name);
}

function gitDir() {
  return process.env.GH_STUB_GIT_DIR;
}

function git(...args) {
  const result = spawnSync('git', ['--git-dir', gitDir(), ...args], { encoding: 'utf8' });
  if (result.status !== 0) die(`gh stub: git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function notFound(message) {
  process.stdout.write(JSON.stringify({ message: 'Not Found', status: '404' }));
  die(`gh: ${message} (HTTP 404)`);
}

const state = readState();
state.tags ??= {};
state.checks ??= {};
const [group, sub] = argv;

function releaseAssetRecords(release) {
  return Object.keys(release.assets).map((name) => ({ name }));
}

function prRecord(pr) {
  const headRefOid =
    pr.headRefOid ??
    (gitDir() && pr.headRepo == null ? git('rev-parse', `refs/heads/${pr.headRefName}`) : null);
  return {
    number: pr.number,
    state: pr.state,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid,
    autoMergeRequest: pr.autoMerge ? { mergeMethod: pr.autoMerge.toUpperCase() } : null,
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
  };
}

function findPr(ref) {
  return state.prs.find((p) => String(p.number) === String(ref));
}

if (group === 'release' && sub === 'view') {
  const tag = positional[2];
  const release = state.releases[tag];
  // gh(1)'s own wording for an absent release; drafts ARE resolved by gh.
  if (!release) die('release not found');
  if (has('--json')) {
    emit(
      project(
        {
          isDraft: release.draft === true,
          targetCommitish: release.target ?? 'main',
          tagName: tag,
          assets: releaseAssetRecords(release),
        },
        flag('--json'),
      ),
    );
  } else process.stdout.write(`${tag}\n`);
} else if (group === 'release' && sub === 'create') {
  const tag = positional[2];
  if (state.releases[tag]) die(`a release with tag ${tag} already exists`);
  const draft = has('--draft');
  const target = flag('--target') ?? 'main';
  state.releases[tag] = { assets: {}, draft, target };
  if (!draft && !state.tags[tag]) state.tags[tag] = target;
  writeState(state);
  process.stdout.write(
    `https://github.com/${process.env.GH_REPO ?? 'owner/repo'}/releases/${tag}\n`,
  );
} else if (group === 'release' && sub === 'edit') {
  const tag = positional[2];
  const release = state.releases[tag];
  if (!release) die('release not found');
  if (flag('--draft') === 'false') {
    release.draft = false;
    // Publishing creates the tag at target_commitish unless it already exists.
    if (!state.tags[tag]) state.tags[tag] = release.target ?? 'main';
  }
  writeState(state);
} else if (group === 'release' && sub === 'delete') {
  const tag = positional[2];
  if (!state.releases[tag]) die('release not found');
  if (!has('--yes')) die('gh stub: refusing to delete without --yes');
  delete state.releases[tag];
  rmSync(join(assetsDir, tag.replace(/[^\w.-]/g, '_')), { recursive: true, force: true });
  writeState(state);
} else if (group === 'release' && sub === 'download') {
  const tag = positional[2];
  const release = state.releases[tag];
  if (!release) die(`release not found: ${tag}`);
  const patterns = flags('--pattern');
  const wanted = patterns.filter((p) => release.assets[p]);
  if (wanted.length === 0) die(`no assets match the given patterns: ${patterns.join(', ')}`);
  const out = flag('--output');
  const dir = flag('--dir');
  if (out && wanted.length > 1) die('--output can only be used with a single asset');
  for (const name of wanted) {
    const target = out ?? (dir ? join(dir, name) : name);
    if (existsSync(target) && !has('--clobber') && !out) die(`${target} already exists`);
    copyFileSync(assetPath(tag, name), target);
  }
} else if (group === 'release' && sub === 'upload') {
  const tag = positional[2];
  const release = state.releases[tag];
  if (!release) die(`release not found: ${tag}`);
  const files = positional.slice(3);
  for (const file of files) {
    const name = basename(file);
    if (release.assets[name] && !has('--clobber')) {
      die(`an asset called ${name} already exists — pass --clobber to replace it`);
    }
    const target = assetPath(tag, name);
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(file, target);
    release.assets[name] = { uploads: (release.assets[name]?.uploads ?? 0) + 1 };
  }
  writeState(state);
} else if (group === 'api') {
  const endpoint = (positional[1] ?? '').replace(
    '{owner}/{repo}',
    process.env.GH_REPO ?? 'owner/repo',
  );
  const [path, query] = endpoint.split('?');
  if (/^repos\/[^/]+\/[^/]+\/releases\/tags\/.+$/.test(path)) {
    // A by-tag lookup answers 404 the way the REST API does — also for a
    // draft, which has no tag yet — with the error body on stdout so a caller
    // reads `.status` instead of parsing a CLI message.
    const tag = path.slice(path.lastIndexOf('/') + 1);
    const release = state.releases[tag];
    if (!release || release.draft) notFound('Not Found');
    emit({
      tag_name: tag,
      draft: false,
      target_commitish: release.target ?? 'main',
      assets: releaseAssetRecords(release),
    });
  } else if (/^repos\/[^/]+\/[^/]+\/git\/ref\/tags\/.+$/.test(path)) {
    const tag = path.slice(path.lastIndexOf('/') + 1);
    if (!state.tags[tag]) notFound('Not Found');
    emit({ ref: `refs/tags/${tag}`, object: { sha: state.tags[tag], type: 'commit' } });
  } else if (/^repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/.test(path)) {
    const sha = path.split('/').at(-2);
    const params = new URLSearchParams(query ?? '');
    const name = params.get('check_name');
    let runs = (state.checks[sha] ?? []).filter((run) => !name || run.name === name);
    // filter=latest (the API default) keeps only the newest run per name;
    // seeded arrays are in creation order.
    if ((params.get('filter') ?? 'latest') === 'latest') {
      runs = [...new Map(runs.map((run) => [run.name, run])).values()];
    }
    emit({ total_count: runs.length, check_runs: runs });
  } else {
    die(`gh stub: unsupported api endpoint: ${endpoint}`);
  }
} else if (group === 'pr' && sub === 'list') {
  const head = flag('--head');
  const base = flag('--base');
  const wantState = (flag('--state') ?? 'open').toUpperCase();
  const matches = state.prs.filter(
    (pr) =>
      (!head || pr.headRefName === head) &&
      (!base || pr.baseRefName === base) &&
      (wantState === 'ALL' || pr.state === wantState),
  );
  emit(
    matches
      .slice(0, Number(flag('--limit') ?? 30))
      .map((pr) => project(prRecord(pr), flag('--json'))),
  );
} else if (group === 'pr' && sub === 'view') {
  const pr = findPr(positional[2]);
  if (!pr) die(`no pull requests found for "${positional[2]}"`);
  emit(project(prRecord(pr), flag('--json')));
} else if (group === 'pr' && sub === 'merge') {
  const pr = findPr(positional[2]);
  if (!pr || pr.state !== 'OPEN') die(`no open pull request found for "${positional[2] ?? ''}"`);
  if (has('--admin')) die('gh stub: --admin is not available to this token');
  if (has('--disable-auto')) {
    if (!pr.autoMerge) die('gh stub: auto-merge is not enabled for this pull request');
    pr.autoMerge = null;
    writeState(state);
    process.stdout.write(`✓ Auto-merge disabled for pull request #${pr.number}\n`);
  } else if (has('--auto')) {
    pr.autoMerge = has('--squash') ? 'squash' : 'merge';
    writeState(state);
    process.stdout.write(
      `✓ Pull request #${pr.number} will be automatically merged when all requirements are met\n`,
    );
  } else {
    const expected = flag('--match-head-commit');
    const head = prRecord(pr).headRefOid;
    if (expected && expected !== head) {
      die(`gh stub: head commit ${head} does not match the expected ${expected}`);
    }
    // The base branch requires "Build & Test": GitHub refuses the merge until
    // that check has succeeded on the head commit.
    const check = (state.checks[head] ?? []).filter((run) => run.name === 'Build & Test').at(-1);
    if (!check || check.conclusion !== 'success') {
      die('gh stub: the base branch requires all checks to pass');
    }
    pr.state = 'MERGED';
    pr.mergeCommit = `merge-of-${head.slice(0, 12)}`;
    writeState(state);
    process.stdout.write(`✓ Squashed and merged pull request #${pr.number}\n`);
  }
} else {
  die(`gh stub: unsupported invocation: gh ${argv.join(' ')}`);
}
