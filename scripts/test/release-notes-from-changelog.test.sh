#!/usr/bin/env bash
# Guard for the release-notes renderer used by release.yml's publish job: the
# CHANGELOG section for a version must become the notes body (hashes and
# "Updated dependencies" dropped), and a missing section must fall back to the
# fixed one-liner so a release is never blocked.
#
# Run: bash scripts/test/release-notes-from-changelog.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/release-notes-from-changelog.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/CHANGELOG.md" <<'MD'
# qaren

## 1.0.8

### Patch Changes

- f1d414e: Print snapshot and find element refs as `@eN`, matching the pinned form the current frame authorises for press, and accept a copied bare `eN` at the argv boundary (GH #979).
- fa2cd21: Refuse managed-dev-client replay of flows that clear app state, and make login-path refusals name the actual next step.
- bc86d57: Add the `rn-pr-qa` agent and `/qa-pr` workflow so a GitHub PR can be device-tested on iOS simulator, Android emulator, and physical device.
- Updated dependencies [f1d414e]
- Updated dependencies [fa2cd21]
  - qaren-core@1.0.8

## 1.0.7

### Patch Changes

- Updated dependencies [b352043]
  - qaren-core@1.0.7
MD

expected_108="## What's changed

- Print snapshot and find element refs as \`@eN\`, matching the pinned form the current frame authorises for press, and accept a copied bare \`eN\` at the argv boundary (GH #979).
- Refuse managed-dev-client replay of flows that clear app state, and make login-path refusals name the actual next step.
- Add the \`rn-pr-qa\` agent and \`/qa-pr\` workflow so a GitHub PR can be device-tested on iOS simulator, Android emulator, and physical device.

Prebuilt runner artifacts for v1.0.8 (rn-fast-runner iOS, rn-android-runner)."

fail=0
check() {
  local label="$1" version="$2" expected="$3" actual
  actual="$(bash "$SCRIPT" "$version" "$tmp/CHANGELOG.md")"
  if [ "$actual" = "$expected" ]; then
    echo "ok: $label"
  else
    echo "FAIL: $label"
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual")
    fail=1
  fi
}

check "1.0.8 section renders under What's changed with hashes and dependency noise dropped" \
  1.0.8 "$expected_108"
check "section with only dependency bumps falls back to the one-liner" \
  1.0.7 "Prebuilt runner artifacts for v1.0.7 (rn-fast-runner iOS, rn-android-runner)."
check "missing section falls back to the one-liner" \
  2.0.0 "Prebuilt runner artifacts for v2.0.0 (rn-fast-runner iOS, rn-android-runner)."

actual="$(bash "$SCRIPT" 1.0.8 "$tmp/does-not-exist.md")"
if [ "$actual" = "Prebuilt runner artifacts for v1.0.8 (rn-fast-runner iOS, rn-android-runner)." ]; then
  echo "ok: missing changelog file falls back to the one-liner"
else
  echo "FAIL: missing changelog file"; fail=1
fi

exit $fail
