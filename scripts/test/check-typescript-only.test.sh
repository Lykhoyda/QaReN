#!/usr/bin/env bash
# Tests for scripts/check-typescript-only.sh — the TS-only-for-new-code gate.
# Run: bash scripts/test/check-typescript-only.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-typescript-only.sh"

fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fixture repo: a git repo with a mix of baseline, new, and excluded JS.
git -C "$TMP" init -q
git -C "$TMP" config commit.gpgsign false
mkdir -p "$TMP/packages/qaren-core/dist" "$TMP/packages/qaren-cli/observe/dist" "$TMP/.yarn/releases" "$TMP/test/unit" "$TMP/scripts"
echo "x" > "$TMP/test/unit/legacy.test.js"
echo "x" > "$TMP/scripts/tool.mjs"
echo "x" > "$TMP/packages/qaren-core/dist/generated.js"
echo "x" > "$TMP/packages/qaren-cli/observe/dist/generated.js"
echo "x" > "$TMP/.yarn/releases/yarn-4.17.0.cjs"
git -C "$TMP" add -A
git -C "$TMP" -c user.email=t@t -c user.name=t commit -qm fixture

BASE="$TMP/baseline.txt"
printf 'test/unit/legacy.test.js\nscripts/tool.mjs\n' > "$BASE"

# 1. Baseline-covered JS passes; dist/ outputs and Yarn releases are ignored.
if REPO_ROOT="$TMP" BASELINE_FILE="$BASE" bash "$SCRIPT" >/dev/null; then
  ok "baseline + exclusions pass"
else bad "expected pass with full baseline"; fi

# 2. A NEW unlisted .js fails and is named in the output.
echo "x" > "$TMP/test/unit/fresh.test.js"
git -C "$TMP" add -A
OUT="$(REPO_ROOT="$TMP" BASELINE_FILE="$BASE" bash "$SCRIPT" 2>&1)"
if [ $? -ne 0 ] && echo "$OUT" | grep -q "fresh.test.js"; then
  ok "new unlisted js rejected and named"
else bad "expected rejection naming fresh.test.js, got: $OUT"; fi

# 3. Removing a baseline file (migration) still passes — shrink is free.
git -C "$TMP" rm -qf test/unit/legacy.test.js
git -C "$TMP" rm -qf test/unit/fresh.test.js
if REPO_ROOT="$TMP" BASELINE_FILE="$BASE" bash "$SCRIPT" >/dev/null; then
  ok "baseline shrink (migration) passes without editing baseline"
else bad "migration should not require baseline edit"; fi

# 4. Missing baseline is a hard error.
if REPO_ROOT="$TMP" BASELINE_FILE="$TMP/nope.txt" bash "$SCRIPT" >/dev/null 2>&1; then
  bad "missing baseline should fail"
else ok "missing baseline errors"; fi

exit $fail
