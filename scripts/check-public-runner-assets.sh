#!/usr/bin/env bash
# Postpublication readiness: the plugin version this checkout advertises must
# already have its exact runner bytes public. Fetches the runner zips and qaren
# tarballs named by the committed trust root from release v<plugin version> and
# fails on a missing release or asset, a draft, or any SHA-256 / length
# difference. Nothing here ever rebuilds, replaces or re-hashes a public byte.
#
# A checkout whose version AND root manifest equal its base (BASE_REF for pull
# requests, EVENT_BEFORE for pushes) stays offline: those bytes were asserted
# when they landed.
#
# Usage: check-public-runner-assets.sh [--repair]
#   --repair  re-upload a MISSING runner-manifest.json asset from the trust
#             root (needs contents: write). A divergent asset is never repaired.
#
# PUBLICATION_WAIT_SECONDS (default 0) is a polling budget: while it lasts, a
# release that is not readable as published is asked for again instead of
# failing this check. ci.yml sets it only for the Version Packages pull
# request, whose run starts when release.yml pushes the release head and so
# before release.yml has published that head's release. It bounds the pauses
# between lookups, not a lookup that is under way. A refusal after a spent
# budget carries a code: RELEASE_UNPUBLISHED_AFTER_WAIT,
# RELEASE_DRAFT_AFTER_WAIT or RELEASE_UNREADABLE_AFTER_WAIT.
# PUBLICATION_POLL_SECONDS (default 15) is the pause between two lookups.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPAIR=false
for arg in "$@"; do
  case "$arg" in
    --repair) REPAIR=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

fail() { echo "::error::$*" >&2; exit 1; }

PLUGIN="$ROOT/packages/qaren-plugin/.claude-plugin/plugin.json"
MANIFEST="$ROOT/runner-manifest.json"
V=$(jq -r '.version' "$PLUGIN")
MV=$(jq -r '.version // empty' "$MANIFEST")
[ "$MV" = "$V" ] || fail "runner-manifest.json vouches for v$MV while plugin.json advertises v$V — the trust root is stale"
cmp -s "$ROOT/packages/qaren-plugin/runner-manifest.json" "$MANIFEST" \
  || fail "packages/qaren-plugin/runner-manifest.json is missing or differs from the root trust root"

BASE=""
if [ -n "${BASE_REF:-}" ]; then
  git -C "$ROOT" fetch --quiet --depth=1 origin "$BASE_REF"
  BASE=FETCH_HEAD
elif [ -n "${EVENT_BEFORE:-}" ] && [ "$EVENT_BEFORE" != "0000000000000000000000000000000000000000" ]; then
  if git -C "$ROOT" fetch --quiet --depth=1 origin "$EVENT_BEFORE" 2>/dev/null; then
    BASE=$EVENT_BEFORE
  fi
fi
# Offline only when the base already carried this exact version AND root:
# a manifest edit without a version bump must still face the public bytes.
if [ -n "$BASE" ] \
   && [ "$(git -C "$ROOT" show "$BASE:packages/qaren-plugin/.claude-plugin/plugin.json" 2>/dev/null | jq -r '.version')" = "$V" ] \
   && [ "$(git -C "$ROOT" show "$BASE:runner-manifest.json")" = "$(cat "$MANIFEST")" ]; then
  echo "the base already carried this exact v$V trust root; its public assets were asserted when it landed — staying offline"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Only the API's own 404 means "not published", and only an answer that says
# draft: false means "published". A by-tag lookup normally answers 404 for a
# draft; a credential that is shown the draft gets draft: true instead. Any
# other answer is unreadable and never read as anything at all. While the
# polling budget lasts, each of the three "not published yet" states is asked
# for again; when it is spent, each fails as itself.
WAIT_SECONDS=${PUBLICATION_WAIT_SECONDS:-0}
POLL_SECONDS=${PUBLICATION_POLL_SECONDS:-15}
case "$WAIT_SECONDS" in '' | *[!0-9]*) fail "PUBLICATION_WAIT_SECONDS must be a whole number of seconds, not '$WAIT_SECONDS'; next: correct it in the step that calls this script" ;; esac
case "$POLL_SECONDS" in '' | *[!0-9]*) fail "PUBLICATION_POLL_SECONDS must be a whole number of seconds, not '$POLL_SECONDS'; next: correct it in the step that calls this script" ;; esac
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
# With a budget, a refusal names its code, the budget and the next step.
UNPUBLISHED="" DRAFT="" UNREADABLE="" ONCE_PUBLISHED="" CHECK_API="" WAITED=""
if [ "$WAIT_SECONDS" -gt 0 ]; then
  WAITED=" (asked again for ${WAIT_SECONDS}s)"
  UNPUBLISHED="RELEASE_UNPUBLISHED_AFTER_WAIT: "
  DRAFT="RELEASE_DRAFT_AFTER_WAIT: "
  UNREADABLE="RELEASE_UNREADABLE_AFTER_WAIT: "
  ONCE_PUBLISHED=" (asked again for ${WAIT_SECONDS}s); next: once the Release workflow run has published v$V, re-run this job"
  CHECK_API=" (asked again for ${WAIT_SECONDS}s); next: check that the GitHub API answers and whether release v$V is public, then re-run this job"
fi
ANNOUNCED=false
while :; do
  if gh api "repos/{owner}/{repo}/releases/tags/v$V" > "$TMP/release.json" 2> "$TMP/release.err"; then
    # An answer that says nothing readable about draft is malformed, never a draft.
    STATE=$(jq -r 'if .draft == false then "published" elif .draft == true then "draft" else "malformed" end' "$TMP/release.json" 2>/dev/null) || STATE=malformed
    [ -n "$STATE" ] || STATE=malformed
    [ "$STATE" != published ] || break
  elif [ "$(jq -r '.status // empty' "$TMP/release.json" 2>/dev/null)" = "404" ]; then
    STATE=unpublished
  else
    STATE=unreadable
  fi
  REMAINING=$(( DEADLINE - $(date +%s) ))
  if [ "$REMAINING" -le 0 ]; then
    case "$STATE" in
      draft)
        fail "${DRAFT}release v$V is still a draft$ONCE_PUBLISHED"
        ;;
      unpublished)
        fail "${UNPUBLISHED}release v$V is not published, so the trust root this checkout advertises has no public bytes$ONCE_PUBLISHED"
        ;;
      malformed)
        fail "${UNREADABLE}could not determine whether release v$V is published: the API answered without a readable draft field — refusing to guess${WAITED}; next: look at the answer of the GitHub API for release v$V, then re-run this job"
        ;;
      *)
        cat "$TMP/release.err" >&2
        fail "${UNREADABLE}could not determine whether release v$V is published — refusing to guess$CHECK_API"
        ;;
    esac
  fi
  if [ "$ANNOUNCED" = false ]; then
    ANNOUNCED=true
    echo "release v$V is not readable as published yet ($STATE) — asking again for up to ${WAIT_SECONDS}s while release.yml publishes it"
  fi
  if [ "$POLL_SECONDS" -gt "$REMAINING" ]; then
    sleep "$REMAINING"
  else
    sleep "$POLL_SECONDS"
  fi
done

# Every asset the trust root names: both runner zips, plus the qaren tarballs
# once the root lists them (runner-manifest-publication.mts requires them for a release).
LISTING=$(jq -r '[.assets.ios[0], .assets.android[0]] + [(.assets.qaren // {})[]] | .[] | "\(.name) \(.sha256) \(.bytes)"' "$MANIFEST") \
  || fail "runner-manifest.json does not list its assets as name/sha256/bytes entries"
ASSETS=()
while IFS= read -r A; do ASSETS+=("$A"); done <<< "$LISTING"
PATTERNS=()
for A in "${ASSETS[@]}"; do
  NAME=${A%% *}
  # The listing is the only thing that may say an asset is absent: a transfer
  # that never completed says nothing about the public bytes.
  jq -e --arg name "$NAME" 'any(.assets[]; .name == $name)' "$TMP/release.json" >/dev/null \
    || fail "release v$V carries no $NAME"
  PATTERNS+=(--pattern "$NAME")
done
if ! gh release download "v$V" --dir "$TMP" "${PATTERNS[@]}" 2> "$TMP/download.err"; then
  cat "$TMP/download.err" >&2
  fail "could not download the runner assets release v$V lists — a failed transfer is not divergence"
fi
for A in "${ASSETS[@]}"; do
  read -r NAME SHA BYTES <<< "$A"
  ACTUAL_SHA=$(shasum -a 256 "$TMP/$NAME" | cut -d' ' -f1)
  ACTUAL_BYTES=$(wc -c < "$TMP/$NAME" | tr -d ' ')
  [ "$ACTUAL_SHA" = "$SHA" ] || fail "$NAME: public sha256 $ACTUAL_SHA != trust root $SHA"
  [ "$ACTUAL_BYTES" = "$BYTES" ] || fail "$NAME: public length $ACTUAL_BYTES != trust root $BYTES"
done

if jq -e 'any(.assets[]; .name == "runner-manifest.json")' "$TMP/release.json" >/dev/null; then
  gh release download "v$V" --pattern runner-manifest.json --output "$TMP/published-manifest.json"
  cmp -s "$TMP/published-manifest.json" "$MANIFEST" \
    || fail "the runner-manifest.json asset on release v$V differs from the trust root — never repaired automatically"
elif [ "$REPAIR" = true ]; then
  gh release upload "v$V" "$MANIFEST"
  echo "re-attached the missing runner-manifest.json asset to release v$V from the trust root"
else
  fail "release v$V carries no runner-manifest.json asset"
fi

NAMES=$(for A in "${ASSETS[@]}"; do printf '%s, ' "${A%% *}"; done)
echo "public runner assets for v$V match the trust root (${NAMES%, })"
