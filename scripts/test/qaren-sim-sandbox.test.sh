#!/usr/bin/env bash
# A sandbox run must see only the fake simulator and no Android device, under
# an isolated HOME.
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
for tool in xcrun xcodebuild simctl maestro; do
  printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/host/calls"\n' "$tool" "$tmp" >"$tmp/host/$tool"
  chmod +x "$tmp/host/$tool"
done
run() { env PATH="$tmp/host:$PATH" QAREN_SANDBOX_DIR="$tmp/sb" bash "$SANDBOX" "$@" 2>/dev/null; }
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
check "an --sdk simctl list names the fake UDID" 1 "$(run xcrun --sdk iphonesimulator simctl list devices -j | grep -c "$FAKE_UDID")"
check "a direct simctl list names the fake UDID" 1 "$(run simctl list devices booted | grep -c "$FAKE_UDID")"
runtimes="$(run xcrun simctl list runtimes --json)"
check "simctl json runtimes are exactly the fake device's available iOS runtime" \
  "com.apple.CoreSimulator.SimRuntime.iOS-18-0" \
  "$(printf '%s' "$runtimes" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).runtimes.filter(x=>x.platform==="iOS"&&x.isAvailable===true);console.log(r.map(x=>x.identifier).join(","))')"
check "the fake device sits on that runtime" 1 "$(printf '%s' "$json" | grep -c '"com.apple.CoreSimulator.SimRuntime.iOS-18-0":\[{"udid":"'"$FAKE_UDID"'"')"

run xcrun simctl boot "$FAKE_UDID"
check "simctl boot is refused" 1 $?
run xcrun simctl install booted /nonexistent.app
check "simctl install is refused" 1 $?
run xcrun simctl launch booted com.example.app -f
check "a trailing -f is refused" 1 $?
run xcrun simctl list devicetypes -j
check "simctl list devicetypes is refused" 1 $?
run xcrun simctl list pairs --json
check "simctl list pairs is refused" 1 $?
run xcrun simctl list -j
check "an unscoped simctl list is refused" 1 $?
check "no device command reached the host xcrun" "" "$(forwarded)"
run xcodebuild test -scheme App -destination "platform=iOS Simulator,name=iPhone 16"
check "xcodebuild test is refused" 1 $?
run xcodebuild build -scheme App -destination "id=$FAKE_UDID"
check "xcodebuild on a device destination is refused" 1 $?
run xcodebuild -scheme App
check "xcodebuild without an allowed action is refused" 1 $?
run xcrun xcodebuild test -scheme App -destination "generic/platform=iOS Simulator"
check "xcrun xcodebuild test is refused" 1 $?
run xcodebuild -showBuildSettings -scheme App -destination "id=$FAKE_UDID"
check "build settings for a device destination are refused" 1 $?
run xcrun devicectl list devices
check "xcrun devicectl is refused" 1 $?
RN_IOS_TEST_RESULTS="$tmp/native.xcresult" run bash "$(dirname "$SANDBOX")/test-native-ios.sh"
check "the native iOS suite is refused" 1 $?
run simctl boot "$FAKE_UDID"
check "a direct simctl is refused" 1 $?
run maestro test flow.yaml
check "maestro is absent" 127 $?
run maestro test --help
check "maestro help is absent" 127 $?
run maestro --version
check "maestro version is absent" 127 $?
run xcrun xctrace list devices
check "an unlisted xcrun tool is refused" 1 $?
run xcrun lipo -info App
check "xcrun lipo is refused" 1 $?
for action in archive clean -help -showsdks; do
  run xcodebuild "$action" -scheme App
  check "xcodebuild $action is refused" 1 $?
done
check "xcrun --find simctl names the sandbox shim" "$tmp/sb/bin/simctl" "$(run xcrun --find simctl)"
check "xcrun -f xcodebuild names the sandbox shim" "$tmp/sb/bin/xcodebuild" "$(run xcrun -f xcodebuild)"
check "no device command reached the host tools" "" "$(forwarded)"
run xcrun --sdk macosx --show-sdk-path
run xcodebuild -version
run xcodebuild build -scheme App -destination "generic/platform=iOS Simulator"
run xcrun xcodebuild build -sdk iphonesimulator -destination "generic/platform=iOS Simulator"
run xcodebuild -project App.xcodeproj -list
run xcodebuild -scheme App -showBuildSettings
run xcrun vtool -show-build App
run xcrun otool -L App
run xcrun nm -j -U App
check "SDK queries, binary inspectors, metadata and generic builds reach the host tools" \
  "xcrun --sdk macosx --show-sdk-path|xcodebuild -version|xcodebuild build -scheme App -destination generic/platform=iOS Simulator|xcodebuild build -sdk iphonesimulator -destination generic/platform=iOS Simulator|xcodebuild -project App.xcodeproj -list|xcodebuild -scheme App -showBuildSettings|xcrun vtool -show-build App|xcrun otool -L App|xcrun nm -j -U App" \
  "$(forwarded | tr '\n' '|' | sed 's/|$//')"
check "adb devices lists no device" "List of devices attached" "$(run adb devices | tr -d '\n')"
check "ANDROID_HOME adb lists no device" "List of devices attached" "$(run sh -c '"$ANDROID_HOME/platform-tools/adb" devices' | tr -d '\n')"
check "a relative sandbox dir links adb absolutely" "List of devices attached" \
  "$(cd "$tmp" && env QAREN_SANDBOX_DIR=rel bash "$SANDBOX" sh -c 'cd / && "$ANDROID_HOME/platform-tools/adb" devices' 2>/dev/null | tr -d '\n')"
run adb -s emulator-5554 shell true
check "adb shell is refused" 1 $?
check "a caller's adb server socket is dropped" "unset" \
  "$(ADB_SERVER_SOCKET=tcp:127.0.0.1:5037 run sh -c 'echo "${ADB_SERVER_SOCKET-unset}"')"
port="$(ANDROID_ADB_SERVER_PORT=5037 run sh -c 'echo "$ANDROID_ADB_SERVER_PORT"')"
check "the adb server port is not the host default" 1 "$([ "$port" = 5037 ]; echo $?)"
(exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
check "no adb server listens on the sandbox port" 1 $?

: >"$tmp/host/calls"
for i in $(seq 1 24); do
  env PATH="$tmp/host:$PATH" QAREN_SANDBOX_DIR="$tmp/race" bash "$SANDBOX" sh -c 'simctl boot X; devicectl list; maestro test f.yaml; echo $? >"$1"' sh "$tmp/race-$i" >/dev/null 2>&1 &
done
wait
check "concurrent first calls never fall through to the host tools" "" "$(forwarded)"
check "every concurrent call hit the absent maestro shim" 24 "$(cat "$tmp"/race-* | grep -cx 127)"

bash "$SANDBOX" >/dev/null 2>&1
check "no command is a usage error" 2 $?

exit "$fail"
