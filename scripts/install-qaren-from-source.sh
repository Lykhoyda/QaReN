#!/usr/bin/env bash
# Installs qaren from this checkout the way a release would: builds the tarball as version
# <release>-dev.<commit>, vouches for it in a temporary copy of the plugin, then installs it through
# ensure-qaren.sh --install, so it never replaces a release runtime.
# --link writes only $HOME/.local/bin/qaren; link details and shadow warnings go to stderr.
# stdout is the installed binary path; PATH linking follows packages/qaren-cli/README.md.
#
# Run: bash scripts/install-qaren-from-source.sh [--link]
set -euo pipefail

LINK=()
case "${1:-}" in
  "") ;;
  --link) LINK=(--link) ;;
  --help | -h)
    echo 'usage: install-qaren-from-source.sh [--link]'
    echo "  --link  Link this build at \$HOME/.local/bin/qaren, replacing a release/dev install link there."
    echo '          Other PATH entries are left alone; shadow warnings and the written link go to stderr.'
    exit 0
    ;;
  *) echo "usage: install-qaren-from-source.sh [--link]" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

need() { echo "install-qaren-from-source: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || need "qaren 2.0 builds on Apple silicon Macs only"
command -v node >/dev/null 2>&1 || need "Node 24 or newer is required: install it from https://nodejs.org"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || need "Node 24 or newer is required; found $(node --version)"
command -v corepack >/dev/null 2>&1 || need "corepack is required; it ships with Node 24"
command -v cargo >/dev/null 2>&1 || need "Rust is required: install it from https://rustup.rs"

corepack yarn install --immutable >&2
# qaren update (packages/qaren-cli/src/commands/update.rs) derives the same version.
V="$(node -p "require('./packages/qaren-plugin/.claude-plugin/plugin.json').version")-dev.$(git rev-parse --short=12 HEAD)"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
TARBALL="$OUT/qaren-$V-darwin-arm64.tar.gz"

node scripts/build-qaren-tarball.ts --version "$V" --platform darwin-arm64 --out-dir "$OUT" >&2
cp -R packages/qaren-plugin "$OUT/plugin"
node scripts/build-runner-manifest.mts --version "$V" --qaren-darwin-arm64 "$TARBALL" --out "$OUT/plugin/runner-manifest.json" >&2
bash "$OUT/plugin/scripts/ensure-qaren.sh" --install --from-file "$TARBALL" ${LINK[@]+"${LINK[@]}"}
