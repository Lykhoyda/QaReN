#!/usr/bin/env bash
# Run a command where no real simulator or emulator is reachable: an isolated
# HOME plus xcrun, simctl, devicectl, xcodebuild and adb shims that report one
# fake booted iPhone and no Android device and refuse every other device
# command, and a maestro that reports itself unavailable. The no-mistakes
# Test step routes device commands through this (see .no-mistakes.yaml).
#
# Usage: scripts/qaren-sim-sandbox.sh <command> [args...]
#   QAREN_SANDBOX_DIR=<dir>   reuse one sandbox across calls (default: new mktemp dir)
set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }

FAKE_UDID="5A4DB0C5-0000-4000-8000-00000000F4CE"
real_home="$HOME"
real_xcrun="$(command -v xcrun || true)"
real_xcodebuild="$(command -v xcodebuild || true)"
dir="${QAREN_SANDBOX_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/qaren-sim-sandbox.XXXXXX")}"
mkdir -p "$dir/home" "$dir/bin" "$dir/android-sdk/platform-tools"
dir="$(cd "$dir" && pwd -P)"

# Concurrent calls may share one sandbox: publish each shim complete and executable.
shim() {
  [ -e "$dir/bin/$1" ] && { cat >/dev/null; return; }
  local tmp
  tmp="$(mktemp "$dir/bin/.$1.XXXXXX")"
  cat >"$tmp"
  chmod +x "$tmp"
  mv -f "$tmp" "$dir/bin/$1"
}

shim xcrun <<EOF
#!/usr/bin/env bash
all=("\$@")
case "\${1:-}" in --sdk|-sdk) shift 2 ;; esac
case "\${1:-}" in
  simctl|devicectl|xcodebuild) exec "$dir/bin/\$1" "\${@:2}" ;;
  --find|-f)
    case "\${@: -1}" in simctl|devicectl|xcodebuild) echo "$dir/bin/\${@: -1}"; exit 0 ;; esac
    [ -n "$real_xcrun" ] && exec "$real_xcrun" "\${all[@]}" ;;
  --show-sdk-*|vtool|otool|nm) [ -n "$real_xcrun" ] && exec "$real_xcrun" "\${all[@]}" ;;
esac
echo "qaren-sim-sandbox: refused xcrun \${all[*]}" >&2
exit 1
EOF

shim simctl <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = list ]; then
  json=
  case " \$* " in *" --json "*|*" -j "*) json=1 ;; esac
  case " \$* " in
    *" runtimes "*)
      [ -n "\$json" ] && { echo '{"runtimes":[{"name":"iOS 18.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-0","platform":"iOS","version":"18.0","isAvailable":true}]}'; exit 0; } ;;
    *" devices "*)
      if [ -n "\$json" ]; then
        echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"$FAKE_UDID","name":"Sandbox iPhone","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16"}]}}'
      else
        printf '== Devices ==\n-- iOS 18.0 --\n    Sandbox iPhone (%s) (Booted)\n' "$FAKE_UDID"
      fi
      exit 0 ;;
  esac
fi
echo "qaren-sim-sandbox: refused simctl \$*" >&2
exit 1
EOF

shim adb <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  devices) echo "List of devices attached"; echo; exit 0 ;;
  version) echo "Android Debug Bridge version 0.0.0 (qaren-sim-sandbox)"; exit 0 ;;
esac
echo "qaren-sim-sandbox: refused adb $*" >&2
exit 1
EOF
if [ ! -e "$dir/android-sdk/platform-tools/adb" ]; then
  link="$(mktemp "$dir/android-sdk/platform-tools/.adb.XXXXXX")"
  ln -sf "$dir/bin/adb" "$link"
  mv -f "$link" "$dir/android-sdk/platform-tools/adb"
fi

shim xcodebuild <<EOF
#!/usr/bin/env bash
refuse() { echo "qaren-sim-sandbox: refused xcodebuild \$*" >&2; exit 1; }
ok=
prev=
for a in "\$@"; do
  case "\$a" in
    -version|-list|-showBuildSettings|build|build-for-testing) ok=1 ;;
    test|test-without-building|-xctestrun|-showdestinations) refuse "\$@" ;;
  esac
  [ "\$prev" = -destination ] && case "\$a" in generic/*) ;; *) refuse "\$@" ;; esac
  prev="\$a"
done
[ -n "\$ok" ] || refuse "\$@"
[ -n "$real_xcodebuild" ] && exec "$real_xcodebuild" "\$@"
echo "qaren-sim-sandbox: no host xcodebuild" >&2
exit 1
EOF

shim devicectl <<'EOF'
#!/usr/bin/env bash
echo "qaren-sim-sandbox: refused devicectl $*" >&2
exit 1
EOF

shim maestro <<'EOF'
#!/usr/bin/env bash
echo "qaren-sim-sandbox: maestro is not available" >&2
exit 127
EOF

# Toolchains default under HOME; keep them on the real one so builds still work.
export CARGO_HOME="${CARGO_HOME:-$real_home/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$real_home/.rustup}"
export NVM_DIR="${NVM_DIR:-$real_home/.nvm}"
export COREPACK_HOME="${COREPACK_HOME:-$real_home/.cache/node/corepack}"
export HOME="$dir/home"
export ANDROID_HOME="$dir/android-sdk"
export ANDROID_SDK_ROOT="$dir/android-sdk"
# qaren dials the adb server over TCP, past the adb shim; point it at a port nothing serves.
unset ADB_SERVER_SOCKET
export ANDROID_ADB_SERVER_PORT=1
export PATH="$dir/bin:$PATH"
export QAREN_SANDBOX_DIR="$dir"
unset QAREN_LOCK_ROOT
echo "qaren-sim-sandbox: $dir (fake iOS UDID $FAKE_UDID, no Android device)" >&2
exec "$@"
