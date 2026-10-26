#!/usr/bin/env bash
# Regression test for require-changeset.sh — the CI guard that fails a PR which
# changes shippable MCP source (packages/qaren-core/src/) without a changeset.
# Without this guard a behavior fix merges to main unversioned and is
# undeliverable to marketplace installs (GH #189 / v0.44.45 post-mortem: #188
# shipped the runFlow fix with no version bump, so users never got it).
#
# Run: bash scripts/test/require-changeset.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/require-changeset.sh"

fail=0
check() { # description expected_exit actual_exit
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected exit $2, got $3"
    fail=1
  fi
}

# Fake repo root with a .changeset/ dir holding only README (= "no changeset").
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.changeset"
echo "# changesets readme" > "$tmp/.changeset/README.md"

# 1. shippable src changed, NO changeset -> MUST fail (the #188/#189 case)
CHANGED_FILES=$'packages/qaren-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change without changeset fails" 1 $?

# 2. shippable src changed, but changeset bumps ONLY qaren-core -> MUST fail.
# qaren-core is the internal package; it ships to users only via the plugin
# manifest, which is bumped by a qaren changeset. A core-only bump
# leaves plugin.json/marketplace.json pinned, so the change never reaches installs
# (the #361/#363 delivery-gap that this guard now closes).
printf -- '---\n"qaren-core": patch\n---\nfix\n' > "$tmp/.changeset/brave-lions.md"
CHANGED_FILES=$'packages/qaren-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with core-only changeset fails (no plugin bump)" 1 $?
rm -f "$tmp/.changeset/brave-lions.md"

# 2b. shippable src changed, changeset bumps qaren -> passes
printf -- '---\n"qaren": minor\n---\nship it\n' > "$tmp/.changeset/keen-otters.md"
CHANGED_FILES=$'packages/qaren-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with qaren changeset passes" 0 $?
rm -f "$tmp/.changeset/keen-otters.md"

# 2c. shippable src changed, changeset bumps BOTH cdp + plugin (the ideal) -> passes
printf -- '---\n"qaren-core": patch\n"qaren": patch\n---\nfix + ship\n' > "$tmp/.changeset/wise-pandas.md"
CHANGED_FILES=$'packages/qaren-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with core+plugin changeset passes" 0 $?
rm -f "$tmp/.changeset/wise-pandas.md"

# 2d. core-only FRONTMATTER, but the BODY merely mentions qaren -> MUST fail.
# The guard must parse frontmatter package keys, not scan the whole file — else a
# release note that name-drops the plugin would falsely satisfy the manifest-bump
# requirement (Codex PR #364 P1).
printf -- '---\n"qaren-core": patch\n---\nNote: a future change should also add "qaren": patch to ship it.\n' > "$tmp/.changeset/sly-foxes.md"
CHANGED_FILES=$'packages/qaren-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with core-only changeset mentioning plugin in BODY fails" 1 $?
rm -f "$tmp/.changeset/sly-foxes.md"

# 2e. shippable src changed, plugin key uses valid YAML SINGLE quotes -> passes
# (Codex PR #364 P2: must accept 'qaren' as well as "qaren").
printf -- "---\n'qaren': patch\n---\nship\n" > "$tmp/.changeset/glad-bats.md"
CHANGED_FILES=$'packages/qaren-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with single-quoted plugin changeset passes" 0 $?
rm -f "$tmp/.changeset/glad-bats.md"

# 3. only non-shippable changes (tests / docs / CI) -> passes without a changeset
CHANGED_FILES=$'packages/qaren-core/test/unit/x.test.js\napps/docs-site/foo.mdx\n.github/workflows/ci.yml' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "non-src change without changeset passes" 0 $?

# 3b–3d. GH #439: commands/hooks/agents/skills are shipped plugin surface — a PR
# touching them merges into user installs exactly like core src, so it MUST
# carry a plugin changeset (the #189/#361 delivery-gap class for these surfaces).
CHANGED_FILES=$'packages/qaren-plugin/commands/check.md' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "plugin command change without changeset fails" 1 $?

CHANGED_FILES=$'packages/qaren-plugin/skills/using-qaren/SKILL.md' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "plugin skill change without changeset fails" 1 $?

CHANGED_FILES=$'packages/qaren-cli/src/main.rs\npackages/qaren-plugin/hooks/hooks.json' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "cli source + hook change without changeset fails" 1 $?

CHANGED_FILES=$'packages/qaren-plugin/scripts/ensure-qaren.sh' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "plugin installer change without changeset fails" 1 $?

# 3e. plugin-surface change WITH a qaren changeset -> passes
printf -- '---\n"qaren": patch\n---\nship surface\n' > "$tmp/.changeset/calm-owls.md"
CHANGED_FILES=$'packages/qaren-plugin/commands/check.md' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "plugin-surface change with plugin changeset passes" 0 $?
CHANGED_FILES=$'packages/qaren-plugin/scripts/ensure-qaren.sh' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "plugin installer change with plugin changeset passes" 0 $?
rm -f "$tmp/.changeset/calm-owls.md"

# 3f. release-PR paths (manifests, CHANGELOG, runner-manifest, core mirrors)
# stay EXCLUDED — the Version Packages bot PR must not be asked for a changeset,
# and the qaren-core/scripts mirrors are build outputs of watched src.
CHANGED_FILES=$'packages/qaren-plugin/package.json\npackages/qaren-plugin/.claude-plugin/plugin.json\n.claude-plugin/marketplace.json\npackages/qaren-plugin/CHANGELOG.md\nrunner-manifest.json\npackages/qaren-cli/Cargo.toml' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "manifest/CHANGELOG/version-only change without changeset passes" 0 $?

# 4. empty diff -> passes
CHANGED_FILES="" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "empty diff passes" 0 $?

# 5. changeset-only PR (adds a changeset, changes nothing else) -> MUST fail.
# GH #578 phantom-0.70.5 post-mortem: the fddcfae/#601 changeset-only merge made
# `changeset version` mint a 0.70.5 changelog entry for the ensure-idb Python
# 3.14 fix 11 releases before the code shipped (0.76.0).
CHANGED_FILES=$'.changeset/lone-claims.md' ADDED_FILES=$'.changeset/lone-claims.md' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "changeset-only addition fails (phantom 0.70.5 class)" 1 $?

# 5b. changeset deletion/reword-only (nothing ADDED) -> passes — the Version
# Packages bot deletes consumed changesets, and pending-changeset text edits
# describe already-merged code.
CHANGED_FILES=$'.changeset/stale-entry.md' ADDED_FILES='' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "changeset deletion/reword-only passes" 0 $?

# 5c. changeset ADDED alongside the change it describes -> passes
printf -- '---\n"qaren": patch\n---\nship\n' > "$tmp/.changeset/paired-claims.md"
CHANGED_FILES=$'.changeset/paired-claims.md\npackages/qaren-core/src/utils.ts' \
  ADDED_FILES=$'.changeset/paired-claims.md' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "changeset addition alongside code passes" 0 $?
rm -f "$tmp/.changeset/paired-claims.md"

# 5d. multiple changesets added, still nothing outside .changeset/ -> MUST fail
CHANGED_FILES=$'.changeset/one.md\n.changeset/two.md' ADDED_FILES=$'.changeset/one.md\n.changeset/two.md' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "multi-changeset-only addition fails" 1 $?

# 5e. a regenerated changeset arrives as a rename pair (old deleted, new added):
# with git's default rename detection the addition would be invisible and the
# phantom claim would merge. Seam form of the git-mode case below.
CHANGED_FILES=$'.changeset/old-claims.md\n.changeset/new-claims.md' ADDED_FILES=$'.changeset/new-claims.md' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "renamed changeset-only addition fails" 1 $?

# 6. git-mode diff failure ($tmp is not a git repo) -> MUST fail closed instead
# of passing on an empty changed-file list.
env -u CHANGED_FILES -u ADDED_FILES REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "git diff failure fails closed" 1 $?

# 7. git mode, real repo: a changeset-only PR that RENAMES a pending changeset
# still declares a fresh release claim with no shipped code. git pairs it as
# `R old -> new` by default, so the guard must disable rename detection to see
# the addition.
gitrepo="$(mktemp -d)"
trap 'rm -rf "$tmp" "$gitrepo"' EXIT
(
  set -e
  cd "$gitrepo"
  git init -q -b main .
  git config user.email test@example.com
  git config user.name test
  mkdir .changeset
  echo "# changesets readme" > .changeset/README.md
  printf -- '---\n"qaren": patch\n---\nclaim\n' > .changeset/old-name.md
  git add -A
  git commit -qm base
  git checkout -qb feature
  git mv .changeset/old-name.md .changeset/new-name.md
  git commit -qam regenerate
) >/dev/null 2>&1
env -u CHANGED_FILES -u ADDED_FILES REPO_ROOT="$gitrepo" BASE_REF=main bash "$GUARD" >/dev/null 2>&1
check "git-mode renamed changeset-only PR fails" 1 $?

# 7b. git mode: deleting a pending changeset (Version Packages bot) still passes.
(
  set -e
  cd "$gitrepo"
  git checkout -q main
  git checkout -qb consume
  git rm -q .changeset/new-name.md 2>/dev/null || git rm -q .changeset/old-name.md
  git commit -qm consume
) >/dev/null 2>&1
env -u CHANGED_FILES -u ADDED_FILES REPO_ROOT="$gitrepo" BASE_REF=main bash "$GUARD" >/dev/null 2>&1
check "git-mode changeset deletion passes" 0 $?

# 7c. Git mode distinguishes comment-only TypeScript maintenance from release
# changes, including JavaScript comments embedded in an injected program.
comment_repo="$(mktemp -d)"
trap 'rm -rf "$tmp" "$gitrepo" "$comment_repo"' EXIT
(
  set -e
  cd "$comment_repo"
  git init -q -b main .
  git config user.email test@example.com
  git config user.name test
  mkdir -p .changeset packages/qaren-core/src/tools
  echo "# changesets readme" > .changeset/README.md
  printf '%s\n' \
    '/**' \
    ' * old rationale' \
    ' */' \
    'export const injected = `(function() {' \
    '  // old injected rationale' \
    '  return 1;' \
    '})()`;' > packages/qaren-core/src/tools/example.ts
  git add -A
  git commit -qm base
  git checkout -qb comments
  printf '%s\n' \
    '/**' \
    ' * first-party rationale' \
    ' */' \
    'export const injected = `(function() {' \
    '  // first-party injected rationale' \
    '  return 1;' \
    '})()`;' > packages/qaren-core/src/tools/example.ts
  git commit -qam comments
) >/dev/null 2>&1
env -u CHANGED_FILES -u ADDED_FILES REPO_ROOT="$comment_repo" BASE_REF=main bash "$GUARD" >/dev/null 2>&1
check "git-mode comment-only src change passes" 0 $?

(
  set -e
  cd "$comment_repo"
  sed -i.bak 's/return 1/return 2/' packages/qaren-core/src/tools/example.ts
  rm packages/qaren-core/src/tools/example.ts.bak
  git commit -qam behavior
) >/dev/null 2>&1
env -u CHANGED_FILES -u ADDED_FILES REPO_ROOT="$comment_repo" BASE_REF=main bash "$GUARD" >/dev/null 2>&1
check "git-mode code plus comments still requires changeset" 1 $?

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
