#!/usr/bin/env bash
# CI guard (GH #316 / B215 / PR #314 post-mortem): every package name in a
# pending .changeset/*.md frontmatter MUST be a real workspace package. A typo
# (e.g. "qaren-plugin" instead of the version-source package "qaren")
# passes the existence-only require-changeset gate, then aborts release.yml's
# `changeset version` on main with "Found changeset … for package X which is not
# in the workspace" — silently blocking every subsequent release until fixed.
# Catch it on the PR, not on main.
#
# Validates ALL present changesets (additive to require-changeset.sh, which only
# asks whether a changeset EXISTS — this asks whether the ones present are valid).
#
# Test seams (scripts/test/validate-changeset-names.test.sh):
#   REPO_ROOT           where to look for .changeset/ + package.json (default: repo root)
#   WORKSPACE_PACKAGES  newline/space-separated valid names (overrides workspace scan)
set -uo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Build the set of valid package names, newline-separated.
if [ -n "${WORKSPACE_PACKAGES+x}" ]; then
  # Intentional word-split: normalize space/newline-separated input to newlines.
  # shellcheck disable=SC2086
  valid="$(printf '%s\n' $WORKSPACE_PACKAGES)"
else
  valid=""
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    # $pattern is left unquoted so workspace globs (e.g. packages/*) expand;
    # a literal path yields itself.
    for pj in "$ROOT"/$pattern/package.json; do
      [ -f "$pj" ] || continue
      name="$(jq -r '.name // empty' "$pj" 2>/dev/null || true)"
      [ -n "$name" ] && valid="${valid}${name}"$'\n'
    done
  done < <(jq -r '.workspaces[]?' "$ROOT/package.json" 2>/dev/null || true)
fi

# Fail open: a name validator that cannot enumerate the workspace must not block
# every PR. The authoritative check still runs at release time.
if [ -z "${valid//[[:space:]]/}" ]; then
  echo "validate-changeset-names: WARNING — could not determine workspace package names; skipping validation." >&2
  exit 0
fi

is_valid() { printf '%s\n' "$valid" | grep -Fxq -- "$1"; }

changesets="$(find "$ROOT/.changeset" -maxdepth 1 -type f -name '*.md' ! -name 'README.md' 2>/dev/null || true)"

if [ -z "$changesets" ]; then
  echo "validate-changeset-names: no changesets present — nothing to validate."
  exit 0
fi

errors=""
while IFS= read -r file; do
  [ -n "$file" ] || continue
  # Frontmatter = lines strictly between the first and second '---' delimiters.
  frontmatter="$(awk '$0 ~ /^---[[:space:]]*$/ { d++; next } d==1 { print }' "$file")"
  while IFS= read -r line; do
    case "$line" in *:*) ;; *) continue ;; esac
    val="${line#*:}"
    val="$(printf '%s' "$val" | sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
    case "$val" in
      patch|minor|major) ;;
      *) continue ;;
    esac
    key="${line%%:*}"
    key="$(printf '%s' "$key" | sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    key="${key#\"}"; key="${key%\"}"; key="${key#\'}"; key="${key%\'}"
    [ -n "$key" ] || continue
    if ! is_valid "$key"; then
      errors="${errors}  ${file##*/}: \"${key}\""$'\n'
    fi
  done <<EOF
$frontmatter
EOF
done <<EOF
$changesets
EOF

if [ -n "$errors" ]; then
  echo "ERROR: changeset references package name(s) not in the workspace:" >&2
  printf '%s' "$errors" >&2
  echo >&2
  echo "Valid workspace packages:" >&2
  printf '%s\n' "$valid" | grep -v '^$' | sed 's/^/  /' >&2
  cat >&2 <<'MSG'

A changeset with an unknown package name passes PR CI but aborts
`changeset version` in release.yml on main, blocking every subsequent
release (GH #316 / B215 / PR #314).

Fix: edit the changeset frontmatter to use a real workspace package name
(see the list above). The version-source package is "qaren".
MSG
  exit 1
fi

echo "validate-changeset-names: all changeset package names are valid workspace packages."
printf '%s\n' "$changesets" | sed 's/^/  /'
exit 0
