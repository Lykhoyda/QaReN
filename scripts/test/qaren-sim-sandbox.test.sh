#!/usr/bin/env bash
# The default sandbox run must see only the fake simulator and no Android
# device, under an isolated HOME; the opt-in must leave the command untouched.
#
# Run: bash scripts/test/qaren-sim-sandbox.test.sh

set -uo pipefail

SANDBOX="$(cd "$(dirname "$0")/.." && pwd)/qaren-sim-sandbox.sh"
FAKE_UDID="5A4DB0C5-0000-4000-8000-00000000F4CE"

fail=0
check() { # description expected actual
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected [$2], got [$3]"
    fail=1
  fi
}

tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
# Stand-in for the host xcrun: records what the sandbox forwards, never touches a simulator.
mkdir -p "$tmp/host"
for tool in xcrun xcodebuild; do
  printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/host/calls"\n' "$tool" "$tmp" >"$tmp/host/$tool"
  chmod +x "$tmp/host/$tool"
done
run() { env -u QAREN_PIPELINE_REAL_DEVICES PATH="$tmp/host:$PATH" QAREN_SANDBOX_DIR="$tmp/sb" bash "$SANDBOX" "$@" 2>/dev/null; }
forwarded() { cat "$tmp/host/calls" 2>/dev/null; }

check "xcrun resolves to the sandbox shim" "$tmp/sb/bin/xcrun" "$(run sh -c 'command -v xcrun')"
check "adb resolves to the sandbox shim" "$tmp/sb/bin/adb" "$(run sh -c 'command -v adb')"
check "HOME is isolated" "$tmp/sb/home" "$(run sh -c 'echo "$HOME"')"
check "ANDROID_HOME is the fake SDK" "$tmp/sb/android-sdk" "$(run sh -c 'echo "$ANDROID_HOME"')"
check "CARGO_HOME stays on the real home" "${CARGO_HOME:-$HOME/.cargo}" "$(run sh -c 'echo "$CARGO_HOME"')"

json="$(run xcrun simctl list devices --json)"
check "simctl json lists exactly one device" 1 "$(printf '%s' "$json" | grep -o '"udid"' | wc -l | tr -d ' ')"
check "that device is the fake UDID" 1 "$(printf '%s' "$json" | grep -c "$FAKE_UDID")"
check "booted list names only the fake UDID" 1 "$(run xcrun simctl list devices booted | grep -c "$FAKE_UDID")"

run xcrun simctl boot "$FAKE_UDID"
check "simctl boot is refused" 1 $?
run xcrun simctl install booted /nonexistent.app
check "simctl install is refused" 1 $?
run xcrun simctl launch booted com.example.app -f
check "a trailing -f is refused" 1 $?
check "no device command reached the host xcrun" "" "$(forwarded)"
run xcodebuild test -scheme App -destination "platform=iOS Simulator,name=iPhone 16"
check "xcodebuild test is refused" 1 $?
run xcodebuild build -scheme App -destination "id=$FAKE_UDID"
check "xcodebuild on a device destination is refused" 1 $?
RN_IOS_TEST_RESULTS="$tmp/native.xcresult" run bash "$(dirname "$SANDBOX")/test-native-ios.sh"
check "the native iOS suite is refused" 1 $?
check "no device command reached the host tools" "" "$(forwarded)"
run xcrun --sdk macosx --show-sdk-path
run xcodebuild build -scheme App -destination "generic/platform=iOS Simulator"
check "SDK queries and generic builds reach the host tools" \
  "xcrun --sdk macosx --show-sdk-path xcodebuild build -scheme App -destination generic/platform=iOS Simulator" \
  "$(forwarded | tr '\n' ' ' | sed 's/ $//')"
check "adb devices lists no device" "List of devices attached" "$(run adb devices | tr -d '\n')"
check "ANDROID_HOME adb lists no device" "List of devices attached" "$(run sh -c '"$ANDROID_HOME/platform-tools/adb" devices' | tr -d '\n')"
check "a relative sandbox dir links adb absolutely" "List of devices attached" \
  "$(cd "$tmp" && env -u QAREN_PIPELINE_REAL_DEVICES QAREN_SANDBOX_DIR=rel bash "$SANDBOX" sh -c 'cd / && "$ANDROID_HOME/platform-tools/adb" devices' 2>/dev/null | tr -d '\n')"
run adb -s emulator-5554 shell true
check "adb shell is refused" 1 $?

check "opt-in leaves HOME untouched" "$HOME" "$(QAREN_PIPELINE_REAL_DEVICES=1 bash "$SANDBOX" sh -c 'echo "$HOME"')"
check "opt-in leaves PATH untouched" "$PATH" "$(QAREN_PIPELINE_REAL_DEVICES=1 bash "$SANDBOX" sh -c 'echo "$PATH"')"

bash "$SANDBOX" >/dev/null 2>&1
check "no command is a usage error" 2 $?

exit "$fail"
