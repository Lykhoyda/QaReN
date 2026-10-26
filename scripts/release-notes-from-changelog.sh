#!/usr/bin/env bash
# Render GitHub release notes for one plugin version from its CHANGELOG section.
# Usage: release-notes-from-changelog.sh <version> [changelog-path]
# Falls back to the fixed runner-artifacts one-liner when the section is missing
# or empty, so a release is never blocked by the changelog.
set -uo pipefail

VERSION="${1:?usage: $0 <version> [changelog-path]}"
CHANGELOG="${2:-$(cd "$(dirname "$0")/.." && pwd)/packages/qaren-plugin/CHANGELOG.md}"
FOOTER="Prebuilt runner artifacts for v$VERSION (rn-fast-runner iOS, rn-android-runner)."

entries=""
if [ -f "$CHANGELOG" ]; then
  entries="$(awk -v v="$VERSION" '
    /^## / { on = ($2 == v); next }
    !on { next }
    /^### / { next }
    /^- Updated dependencies/ { skip = 1; next }
    skip && /^[[:space:]]/ { next }
    { skip = 0 }
    /^- [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]: / { sub(/^- [0-9a-f]+: /, "- ") }
    { line[++n] = $0; if ($0 ~ /[^[:space:]]/) { if (!first) first = n; last = n } }
    END { for (i = first; i > 0 && i <= last; i++) print line[i] }
  ' "$CHANGELOG")"
fi

if [ -z "$entries" ]; then
  printf '%s\n' "$FOOTER"
  exit 0
fi

printf "## What's changed\n\n%s\n\n%s\n" "$entries" "$FOOTER"
