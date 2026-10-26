#!/usr/bin/env bash
# Story 06 Phase A (#387): run the rn-fast-runner unit-test classes on a simulator.
# CI (.github/workflows/native-tests.yml ios-unit) and `npm run test:native:ios`
# both call this script so local == CI by construction.
#
# Skip-list, not whitelist — new test classes in RnFastRunnerUITests/ run
# automatically (Xcode 16 FileSystemSynchronizedRootGroup). The two skips:
#   RnFastRunnerTests            — the production runner entry (never returns)
#   SnapshotForegroundRegressionTest — needs com.rndevagent.testapp installed
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/packages/rn-fast-runner/RnFastRunner"
RESULTS="${RN_IOS_TEST_RESULTS:-../build/native-tests.xcresult}"

if [ -n "${RN_IOS_TEST_DESTINATION:-}" ]; then
  DEST="$RN_IOS_TEST_DESTINATION"
else
  # Multi-runtime hosts (e.g. Xcode 26 with iOS 18.x AND 26.x runtimes) fail
  # bare-name matching when the named device exists only under the older
  # runtime, so resolve a concrete UDID instead: prefer "iPhone 16", else the
  # first available iPhone. python3 ships with the Xcode CLT — no jq needed.
  UDID="$(xcrun simctl list devices available --json | python3 -c '
import json, sys
data = json.load(sys.stdin)
preferred = fallback = ""
for devices in data.get("devices", {}).values():
    for d in devices:
        name = d.get("name", "")
        udid = d.get("udid", "")
        if not name.startswith("iPhone") or not udid:
            continue
        if name == "iPhone 16" and not preferred:
            preferred = udid
        if not fallback:
            fallback = udid
print(preferred or fallback)
' || true)"
  if [ -n "$UDID" ]; then
    DEST="id=$UDID"
  else
    DEST="platform=iOS Simulator,name=iPhone 16"
  fi
fi

rm -rf "$RESULTS"
xcodebuild test \
  -project RnFastRunner.xcodeproj \
  -scheme RnFastRunner \
  -destination "$DEST" \
  -parallel-testing-enabled NO \
  -derivedDataPath ../build/DerivedData-native-tests \
  -resultBundlePath "$RESULTS" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO \
  ONLY_ACTIVE_ARCH=YES \
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG RN_FAST_RUNNER_TEST_FAULTS" \
  -skip-testing:RnFastRunnerUITests/RnFastRunnerTests \
  -skip-testing:RnFastRunnerUITests/SnapshotForegroundRegressionTest
