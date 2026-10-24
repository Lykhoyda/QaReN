#!/usr/bin/env bash
# gate:qaren-check — device-bound, not run in hosted CI.
#   QAREN_TEST_APP   app root to check (required; the workspace test-app)
#   QAREN_PLAN_FILE  plan to walk (default: packages/qaren-core/test/fixtures/plans/literal.md)
#   QAREN_REQUIRE_JEV_WALK=1 requires walk judgments, not merely the preflight probe
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${QAREN_TEST_APP:?set QAREN_TEST_APP to the app root to check (e.g. the workspace test-app)}"
PLAN="${QAREN_PLAN_FILE:-$ROOT/packages/qaren-core/test/fixtures/plans/literal.md}"
if [ "$#" -gt 0 ]; then
  [ "$#" = 2 ] && [ "$1" = "--plan-file" ] || { echo "usage: gate:qaren-check [--plan-file <path>]" >&2; exit 2; }
  PLAN="$2"
fi
case "$PLAN" in /*) ;; *) PLAN="$ROOT/$PLAN" ;; esac
if [ "$(basename "$PLAN")" = "phrases.md" ]; then export QAREN_REQUIRE_JEV_WALK=1; fi
CONFIG="$APP/.qaren/config.yaml"

[ -f "$CONFIG" ] || { echo "gate:qaren-check: $CONFIG is missing (needs at least appId)"; exit 1; }
[ -f "$PLAN" ] || { echo "gate:qaren-check: plan $PLAN is missing"; exit 1; }

(cd "$ROOT" && corepack yarn build:core)
build_commit="$(git -C "$ROOT" rev-parse HEAD)"
QAREN_BUILD_COMMIT="$build_commit" cargo build --manifest-path "$ROOT/packages/qaren-cli/Cargo.toml" --locked
QAREN="$ROOT/packages/qaren-cli/target/debug/qaren"
export QAREN_RUNTIME="$ROOT/packages/qaren-core/dist"

check_args=(check --plan-file "$PLAN" --fresh-install --json)
if [ -n "${QAREN_DEVICE_UDID:-}" ]; then
  check_args+=(--device "$QAREN_DEVICE_UDID")
fi
if [ "${QAREN_BOOT_DEVICE:-}" = "1" ]; then
  check_args+=(--boot-device)
fi

# `corepack yarn run` exports COREPACK_* to this script; a pnpm launched with them
# fails the app's packageManager check, so qaren gets the caller's plain environment.
set +e
receipt="$(cd "$APP" && env -u COREPACK_ROOT -u COREPACK_ENABLE_DOWNLOAD_PROMPT -u COREPACK_ENABLE_AUTO_PIN "$QAREN" "${check_args[@]}")"
status=$?
set -e
printf '%s\n' "$receipt"
if [ "$status" != "0" ]; then
  echo "gate:qaren-check: qaren check exited $status"
  exit 1
fi
printf '%s' "$receipt" | node "$ROOT/scripts/assert-qaren-check.ts"
