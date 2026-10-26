#!/usr/bin/env bash
# Regression for sync-versions.sh --fix: GNU sed treats `sed -i '' expr file` as
# `can't read <expr>` and exits 2, and version-packages runs --fix on Ubuntu.
#
# Run: bash scripts/test/sync-versions.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/sync-versions.sh"

fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected '$2', got '$3'"
    fail=1
  fi
}

if sed --version >/dev/null 2>&1; then
  probe="$(mktemp)"
  printf '%s\n' '{"version": "1.0.8"}' > "$probe"
  sed -i '' 's/"version": "1.0.8"/"version": "1.2.3"/' "$probe" >/dev/null 2>&1
  check "GNU sed -i '' exits 2 (the old fixer)" 2 "$?"
  rm -f "$probe"
else
  echo "ok: skip GNU sed -i '' probe (not GNU sed)"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p \
  "$tmp/packages/qaren-plugin/.claude-plugin" \
  "$tmp/packages/qaren-plugin/.cursor-plugin" \
  "$tmp/packages/qaren-plugin/.codex-plugin" \
  "$tmp/packages/qaren-cli" \
  "$tmp/.claude-plugin" \
  "$tmp/.cursor-plugin"

printf '%s\n' '{"name": "qaren", "version": "1.2.3"}' > "$tmp/packages/qaren-plugin/package.json"
for m in .claude-plugin .cursor-plugin .codex-plugin; do
  printf '%s\n' '{"name": "qaren", "version": "1.0.8"}' > "$tmp/packages/qaren-plugin/$m/plugin.json"
done
printf '%s\n' '{"plugins": [{"name": "qaren", "version": "1.0.8"}]}' > "$tmp/.claude-plugin/marketplace.json"
printf '%s\n' '{"plugins": [{"name": "qaren", "version": "1.0.8"}]}' > "$tmp/.cursor-plugin/marketplace.json"
printf '[package]\nname = "qaren"\nversion = "1.0.8"\n\n[dependencies]\nserde = { version = "1.0.8" }\n' > "$tmp/packages/qaren-cli/Cargo.toml"
printf '[[package]]\nname = "serde"\nversion = "1.0.8"\n\n[[package]]\nname = "qaren"\nversion = "1.0.8"\n' > "$tmp/packages/qaren-cli/Cargo.lock"

REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "drift is reported as exit 1" 1 "$?"

REPO_ROOT="$tmp" bash "$GUARD" --fix >/dev/null 2>&1
check "--fix exits 0" 0 "$?"

REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "in sync after --fix" 0 "$?"

for m in .claude-plugin .cursor-plugin .codex-plugin; do
  check "$m/plugin.json bumped" 1 "$(grep -c '"version": "1.2.3"' "$tmp/packages/qaren-plugin/$m/plugin.json")"
done
check ".claude-plugin/marketplace.json bumped" 1 "$(grep -c '"version": "1.2.3"' "$tmp/.claude-plugin/marketplace.json")"
check ".cursor-plugin/marketplace.json bumped" 1 "$(grep -c '"version": "1.2.3"' "$tmp/.cursor-plugin/marketplace.json")"
check "Cargo.toml package version bumped" 1 "$(grep -c '^version = "1.2.3"' "$tmp/packages/qaren-cli/Cargo.toml")"
check "Cargo.toml dependency version untouched" 1 "$(grep -c 'serde = { version = "1.0.8" }' "$tmp/packages/qaren-cli/Cargo.toml")"
check "Cargo.lock bumps only the qaren entry" "serde 1.0.8 qaren 1.2.3" \
  "$(awk '/^name/{n=$3} /^version/{printf "%s %s ", n, $3}' "$tmp/packages/qaren-cli/Cargo.lock" | tr -d '"' | sed 's/ $//')"

printf '[[package]]\nname = "serde"\nversion = "1.0.8"\n\n[[package]]\nname = "qaren"\nversion = "1.0.8"\n' > "$tmp/packages/qaren-cli/Cargo.lock"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "lock-only drift is reported as exit 1" 1 "$?"
REPO_ROOT="$tmp" bash "$GUARD" --fix >/dev/null 2>&1
check "lock-only drift is fixed" 0 "$?"
check "Cargo.lock qaren entry re-synced" "serde 1.0.8 qaren 1.2.3" \
  "$(awk '/^name/{n=$3} /^version/{printf "%s %s ", n, $3}' "$tmp/packages/qaren-cli/Cargo.lock" | tr -d '"' | sed 's/ $//')"

exit $fail
