#!/usr/bin/env bash
# CI guard (GH #189 / v0.44.45 post-mortem): a PR that changes shippable
# source MUST include a changeset, so the change earns a version bump + release.
# Without this, behavior fixes merge to main unversioned and never reach
# marketplace installs — #188 shipped the runFlow fix with no bump, so users
# never got it and it was re-reported as #189. Runs on pull_request; see
# .github/workflows/ci.yml.
#
# Test seams (scripts/test/require-changeset.test.sh):
#   CHANGED_FILES  newline-separated changed paths (overrides git diff)
#   ADDED_FILES    newline-separated added paths (used with CHANGED_FILES)
#   REPO_ROOT      where to look for .changeset/ (default: repo root)
#   BASE_REF       git diff base when CHANGED_FILES is unset (default origin/main)
set -uo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BASE_REF="${BASE_REF:-origin/main}"
# Shippable surface: the core and CLI sources plus the hand-authored plugin
# surface (commands/skills/hooks/scripts) that marketplace installs run directly. Tests,
# docs, CI, and the plugin manifests/CHANGELOGs (the changeset output) stay excluded.
WATCHED='^packages/qaren-core/src/|^packages/qaren-cli/src/|^packages/qaren-plugin/(commands|skills|hooks|scripts)/'

git_diff_mode=false
if [ -n "${CHANGED_FILES+x}" ]; then
  changed="$CHANGED_FILES"
elif ! changed="$(git -C "$ROOT" diff --name-only "${BASE_REF}...HEAD")"; then
  echo "ERROR: require-changeset: git diff against ${BASE_REF} failed — refusing to pass without a changed-file list." >&2
  exit 1
else
  git_diff_mode=true
fi

# Inverse guard (GH #578 phantom-0.70.5 post-mortem): a PR that ADDS a changeset
# while changing nothing outside .changeset/ declares a release claim with no
# shipped change — `changeset version` then mints a changelog entry for behavior
# that never landed (the fddcfae/#601 changeset-only merge made 0.70.5 claim the
# ensure-idb Python 3.14 fix 11 releases before the code shipped in 0.76.0).
# Deleting or rewording a pending changeset stays allowed (Version Packages bot).
if [ -n "${CHANGED_FILES+x}" ]; then
  added="${ADDED_FILES-}"
elif ! added="$(git -C "$ROOT" diff --no-renames --diff-filter=A --name-only "${BASE_REF}...HEAD" -- '.changeset')"; then
  echo "ERROR: require-changeset: git diff against ${BASE_REF} failed — refusing to pass without an added-file list." >&2
  exit 1
fi
non_changeset_changed="$(printf '%s\n' "$changed" | grep -v '^\.changeset/' | grep -v '^$' || true)"
added_changesets="$(printf '%s\n' "$added" | grep -E '^\.changeset/[^/]+\.md$' | grep -vE '^\.changeset/README\.md$' || true)"
if [ -z "$non_changeset_changed" ] && [ -n "$added_changesets" ]; then
  echo "ERROR: this PR adds a changeset but changes nothing outside .changeset/:" >&2
  printf '%s\n' "$added_changesets" | sed 's/^/  /' >&2
  cat >&2 <<'MSG'

A changeset that merges without the change it describes becomes a phantom
changelog entry at the next `changeset version` (GH #578 post-mortem: the
fddcfae/#601 changeset-only merge made 0.70.5 claim the ensure-idb
Python 3.14 fix 11 releases before the code shipped in 0.76.0).

Fix: land the changeset in the same PR as the change it describes.
MSG
  exit 1
fi

src_changed="$(printf '%s\n' "$changed" | grep -E "$WATCHED" || true)"

# Source comments ship in bundled artifacts but do not change product behavior.
# Seam-driven tests stay conservative because they provide paths, not diff content.
if [ "$git_diff_mode" = true ] && [ -n "$src_changed" ]; then
  release_src_changed=""
  while IFS= read -r source_file; do
    [ -n "$source_file" ] || continue
    if [[ "$source_file" != packages/qaren-core/src/*.ts && "$source_file" != packages/qaren-cli/src/*.rs ]] ||
      ! git -C "$ROOT" diff --no-ext-diff --unified=999999 \
        "${BASE_REF}...HEAD" -- "$source_file" |
        awk '
          function visit(stream, line, changed, trimmed, comment, close_at, tail) {
            trimmed = line
            sub(/^[[:space:]]*/, "", trimmed)
            comment = in_block[stream] || trimmed ~ /^\/\*/
            if (comment) {
              close_at = index(trimmed, "*/")
              if (close_at) {
                tail = substr(trimmed, close_at + 2)
                in_block[stream] = 0
                if (tail !~ /^[[:space:]]*$/) comment = 0
              } else {
                in_block[stream] = 1
              }
            }
            if (changed && line !~ /^[[:space:]]*$/ && trimmed !~ /^\/\// && !comment) bad = 1
          }
          /^@@ / { in_hunk = 1; next }
          !in_hunk { next }
          /^-/ { visit("old", substr($0, 2), 1); next }
          /^\+/ { visit("new", substr($0, 2), 1); next }
          /^ / {
            visit("old", substr($0, 2), 0)
            visit("new", substr($0, 2), 0)
          }
          END { exit bad }
        '; then
      release_src_changed="${release_src_changed}${release_src_changed:+$'\n'}${source_file}"
    fi
  done < <(printf '%s\n' "$src_changed")
  src_changed="$release_src_changed"
fi

if [ -z "$src_changed" ]; then
  echo "require-changeset: no shippable src changes — changeset not required."
  exit 0
fi

changesets="$(find "$ROOT/.changeset" -maxdepth 1 -type f -name '*.md' ! -name 'README.md' 2>/dev/null || true)"

if [ -z "$changesets" ]; then
  echo "ERROR: this PR changes shippable source but has NO changeset:" >&2
  printf '%s\n' "$src_changed" | sed 's/^/  /' >&2
  cat >&2 <<'MSG'

A behavior change without a changeset ships to main unversioned and is
undeliverable to marketplace installs (GH #189 / v0.44.45 post-mortem).

Fix: run `corepack yarn changeset`, describe the change, and commit the generated
.changeset/*.md file. Docs / test / CI-only PRs do not need one.
MSG
  exit 1
fi

# A changeset exists — but only the `qaren` package (the plugin, versioned
# through packages/qaren-plugin/package.json) is released; a changeset that
# bumps only `qaren-core` leaves the manifests pinned and ships nothing.
# Parse ONLY the frontmatter package keys, not the whole file (Codex PR #364 P1).
plugin_changeset=""
while IFS= read -r file; do
  [ -n "$file" ] || continue
  frontmatter="$(awk '$0 ~ /^---[[:space:]]*$/ { d++; next } d==1 { print }' "$file")"
  if printf '%s\n' "$frontmatter" | grep -Eq "^[[:space:]]*[\"']?qaren[\"']?[[:space:]]*:"; then
    plugin_changeset="$file"
    break
  fi
done < <(printf '%s\n' "$changesets")

if [ -z "$plugin_changeset" ]; then
  echo "ERROR: this PR changes shippable source but no changeset bumps qaren:" >&2
  printf '%s\n' "$src_changed" | sed 's/^/  /' >&2
  cat >&2 <<'MSG'

A `qaren-core`-only changeset bumps an internal package but NOT the plugin
manifests, so the change ships to main but never reaches an install.

Fix: add a `qaren` entry to a changeset, e.g.:

  ---
  "qaren": patch
  ---
MSG
  exit 1
fi

echo "require-changeset: shippable src changed AND a qaren changeset is present — OK."
printf '%s\n' "$changesets" | sed 's/^/  /'
exit 0
