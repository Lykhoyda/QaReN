#!/usr/bin/env bash
# Syncs every host manifest and the CLI crate version from the changesets-managed
# plugin package (packages/qaren-plugin/package.json) and guards against
# hardcoded version literals drifting into core source.
# Run as: pre-commit hook, CI check, or manual `./scripts/sync-versions.sh [--fix]`
# Test seam (scripts/test/sync-versions.test.sh): REPO_ROOT points at a fake checkout.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PLUGIN_ROOT="$REPO_ROOT/packages/qaren-plugin"
SYNTHETIC_PKG_JSON="$PLUGIN_ROOT/package.json"
CARGO_TOML="$REPO_ROOT/packages/qaren-cli/Cargo.toml"
CARGO_LOCK="$REPO_ROOT/packages/qaren-cli/Cargo.lock"
CORE_SRC_DIR="$REPO_ROOT/packages/qaren-core/src"
MANIFESTS=(
  "$PLUGIN_ROOT/.claude-plugin/plugin.json"
  "$PLUGIN_ROOT/.cursor-plugin/plugin.json"
  "$PLUGIN_ROOT/.codex-plugin/plugin.json"
  "$REPO_ROOT/.claude-plugin/marketplace.json"
  "$REPO_ROOT/.cursor-plugin/marketplace.json"
)

# GNU sed attaches -i's suffix; BSD sed needs `-i ''`. version-packages runs --fix on Ubuntu.
replace_in_place() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$1" "$2"
  else
    sed -i '' "$1" "$2"
  fi
}

json_version() { grep '"version"' "$1" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/'; }
synth_version=$(json_version "$SYNTHETIC_PKG_JSON")
cargo_version=$(grep -m1 '^version = ' "$CARGO_TOML" | sed 's/version = "\(.*\)"/\1/')
lock_version=$(awk '/^\[\[package\]\]/{n=0} /^name = "qaren"$/{n=1} n && /^version = /{gsub(/"/,"",$3); print $3; exit}' "$CARGO_LOCK")

mismatch=""
for manifest in "${MANIFESTS[@]}"; do
  v=$(json_version "$manifest")
  if [ "$v" != "$synth_version" ]; then
    mismatch="${mismatch}${mismatch:+ }${manifest#"$REPO_ROOT/"}=$v"
  fi
done
if [ "$cargo_version" != "$synth_version" ]; then
  mismatch="${mismatch}${mismatch:+ }packages/qaren-cli/Cargo.toml=$cargo_version"
fi
if [ "$lock_version" != "$synth_version" ]; then
  mismatch="${mismatch}${mismatch:+ }packages/qaren-cli/Cargo.lock=$lock_version"
fi

if [ -n "$mismatch" ]; then
  if [ "${1:-}" = "--fix" ]; then
    for manifest in "${MANIFESTS[@]}"; do
      v=$(json_version "$manifest")
      replace_in_place "s/\"version\": \"$v\"/\"version\": \"$synth_version\"/" "$manifest"
    done
    perl -0pi -e "s/^version = \"\Q$cargo_version\E\"/version = \"$synth_version\"/m" "$CARGO_TOML"
    perl -0pi -e "s/(\[\[package\]\]\nname = \"qaren\"\nversion = \")[^\"]+/\${1}$synth_version/" "$CARGO_LOCK"
    echo "synced host manifests + marketplaces + qaren-cli/Cargo.toml -> $synth_version"
    exec bash "$0"
  else
    echo "ERROR: version mismatch (source of truth packages/qaren-plugin/package.json=$synth_version) — $mismatch"
    echo "Run: ./scripts/sync-versions.sh --fix"
    echo "(or use \`yarn version-packages\` from repo root to bump via changesets)"
    exit 1
  fi
else
  echo "versions in sync: $synth_version"
fi

# B110 guard — detect hardcoded `version: '...'` literals in TypeScript source.
# Exemption: domain/engine-pin.ts holds the maestro-runner PIN (GH #397), a
# deliberate third-party version literal pinned by gh-397-pin-sync.test.ts.
if [ -d "$CORE_SRC_DIR" ]; then
  hardcoded=$(grep -rn -E "version:[[:space:]]*['\"][0-9]+\.[0-9]+\.[0-9]+" "$CORE_SRC_DIR" --exclude=engine-pin.ts --exclude-dir=node_modules 2>/dev/null || true)
  if [ -n "$hardcoded" ]; then
    echo "ERROR: hardcoded version literal found in src/ (B110 regression)"
    echo "$hardcoded"
    echo "Fix: read version from package.json at module load instead."
    exit 1
  fi
fi
