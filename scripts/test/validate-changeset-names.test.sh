#!/usr/bin/env bash
# Regression test for validate-changeset-names.sh — the CI guard that fails a PR
# whose changeset frontmatter references a package name that is not a real
# workspace package. Without it a typo'd name (B215 / PR #314: "qaren"
# instead of "qaren") passes PR CI and only explodes later in
# release.yml's `changeset version` on main, blocking every subsequent release.
#
# Run: bash scripts/test/validate-changeset-names.test.sh
#
# Test seams (see validate-changeset-names.sh):
#   REPO_ROOT           where to look for .changeset/ (default: repo root)
#   WORKSPACE_PACKAGES  newline/space-separated valid names (overrides workspace scan)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/validate-changeset-names.sh"

fail=0
check() { # description expected_exit actual_exit
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected exit $2, got $3"
    fail=1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.changeset"
echo "# changesets readme" > "$tmp/.changeset/README.md"

VALID='qaren
qaren-core'

reset_changesets() { find "$tmp/.changeset" -maxdepth 1 -type f -name '*.md' ! -name 'README.md' -delete; }

# 1. valid package name -> passes
printf -- '---\n"qaren": patch\n---\nfix\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "valid name passes" 0 $?
reset_changesets

# 2. invalid package name (the B215 case) -> fails
printf -- '---\n"qaren-plugin": patch\n---\nfix\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "invalid name (B215 qaren-plugin) fails" 1 $?
reset_changesets

# 3. the other valid workspace package name -> passes
printf -- '---\n"qaren-core": minor\n---\nfix\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "second valid name passes" 0 $?
reset_changesets

# 4. multiple valid names in one changeset -> passes
printf -- '---\n"qaren": patch\n"qaren-core": minor\n---\nfix\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "multiple valid names pass" 0 $?
reset_changesets

# 5. mix of valid + invalid in one changeset -> fails
printf -- '---\n"qaren": patch\n"qaren-plugin": minor\n---\nfix\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "mixed valid+invalid fails" 1 $?
reset_changesets

# 6. only README present (no changesets) -> passes (nothing to validate)
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "no changesets passes" 0 $?

# 7. empty changeset (frontmatter, no package bump lines) -> passes
printf -- '---\n---\nrelease note only\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "empty changeset passes" 0 $?
reset_changesets

# 8. two changeset files, one valid + one invalid -> fails
printf -- '---\n"qaren": patch\n---\nok\n' > "$tmp/.changeset/good.md"
printf -- '---\n"qaren-plugin": patch\n---\nbad\n' > "$tmp/.changeset/bad.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "one bad changeset among many fails" 1 $?
reset_changesets

# 9. valid names derived from a real workspace (no WORKSPACE_PACKAGES override)
mkdir -p "$tmp/pkg-a" "$tmp/pkg-b"
printf -- '{"name":"qaren"}\n' > "$tmp/pkg-a/package.json"
printf -- '{"name":"qaren-core"}\n' > "$tmp/pkg-b/package.json"
printf -- '{"private":true,"workspaces":["pkg-a","pkg-b"]}\n' > "$tmp/package.json"
printf -- '---\n"qaren-core": patch\n---\nok\n' > "$tmp/.changeset/a.md"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "name validated against scanned workspace passes" 0 $?
printf -- '---\n"qaren-plugin": patch\n---\nbad\n' > "$tmp/.changeset/a.md"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "bad name validated against scanned workspace fails" 1 $?
rm -f "$tmp/package.json"; rm -rf "$tmp/pkg-a" "$tmp/pkg-b"; reset_changesets

# 10. CRLF line endings (a Windows-authored changeset): the trailing \r must not
# hide a bad name. Relies on [[:space:]] matching \r in both BSD + GNU awk/sed.
printf -- '---\r\n"qaren-plugin": patch\r\n---\r\nbad\r\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "CRLF bad name fails" 1 $?
printf -- '---\r\n"qaren": patch\r\n---\r\nok\r\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "CRLF valid name passes" 0 $?
reset_changesets

# 11. unquoted key (valid) -> passes
printf -- '---\nqaren: patch\n---\nok\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "unquoted valid key passes" 0 $?
reset_changesets

# 12. unquoted key (invalid) -> fails
printf -- '---\nqaren-plugin: patch\n---\nbad\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "unquoted invalid key fails" 1 $?
reset_changesets

# 13. single-quoted key (valid YAML) -> passes (no false positive)
printf -- "---\n'qaren': patch\n---\nok\n" > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "single-quoted valid key passes" 0 $?
reset_changesets

# 14. quoted BUMP VALUE with a bad name -> must still fail (no false negative)
printf -- '---\n"qaren-plugin": "patch"\n---\nbad\n' > "$tmp/.changeset/a.md"
WORKSPACE_PACKAGES="$VALID" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "quoted bump value with bad name fails" 1 $?
reset_changesets

# 15. fail-open: workspace set underivable (no package.json, no override) -> exit 0
printf -- '---\n"qaren-plugin": patch\n---\nbad\n' > "$tmp/.changeset/a.md"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "fail-open when workspace undeterminable" 0 $?
reset_changesets

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
