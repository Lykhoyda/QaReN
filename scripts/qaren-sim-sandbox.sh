#!/usr/bin/env bash
# Run a command where no real simulator or emulator is reachable: an isolated
# HOME plus xcrun and adb shims that report one fake booted iPhone and no
# Android device, and refuse every other device command. The no-mistakes Test
# step routes qaren, xcrun and adb through this (see .no-mistakes.yaml).
#
# Usage: scripts/qaren-sim-sandbox.sh <command> [args...]
#   QAREN_SANDBOX_DIR=<dir>         reuse one sandbox across calls (default: new mktemp dir)
#   QAREN_PIPELINE_REAL_DEVICES=1   opt in to real devices: run the command untouched
set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }
[ "${QAREN_PIPELINE_REAL_DEVICES:-}" = "1" ] && exec "$@"

FAKE_UDID="5A4DB0C5-0000-4000-8000-00000000F4CE"
real_home="$HOME"
real_xcrun="$(command -v xcrun || true)"
dir="${QAREN_SANDBOX_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/qaren-sim-sandbox.XXXXXX")}"
mkdir -p "$dir/home" "$dir/bin" "$dir/android-sdk/platform-tools"
dir="$(cd "$dir" && pwd -P)"

if [ ! -e "$dir/bin/xcrun" ]; then
  cat >"$dir/bin/xcrun" <<EOF
#!/usr/bin/env bash
q="\${1:-}"
case "\$q" in --sdk|-sdk) q="\${3:-}" ;; esac
case "\$q" in
  --show-sdk-*|--find|-f) [ -n "$real_xcrun" ] && exec "$real_xcrun" "\$@" ;;
esac
if [ "\${1:-}" = simctl ] && [ "\${2:-}" = list ]; then
  case " \$* " in
    *" --json "*|*" -j "*)
      echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"$FAKE_UDID","name":"Sandbox iPhone","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16"}]}}' ;;
    *) printf '== Devices ==\n-- iOS 18.0 --\n    Sandbox iPhone (%s) (Booted)\n' "$FAKE_UDID" ;;
  esac
  exit 0
fi
echo "qaren-sim-sandbox: refused xcrun \$*" >&2
exit 1
EOF
  chmod +x "$dir/bin/xcrun"
fi

if [ ! -e "$dir/bin/adb" ]; then
  cat >"$dir/bin/adb" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  devices) echo "List of devices attached"; echo; exit 0 ;;
  version) echo "Android Debug Bridge version 0.0.0 (qaren-sim-sandbox)"; exit 0 ;;
esac
echo "qaren-sim-sandbox: refused adb $*" >&2
exit 1
EOF
  chmod +x "$dir/bin/adb"
fi
ln -sf "$dir/bin/adb" "$dir/android-sdk/platform-tools/adb"

# Toolchains default under HOME; keep them on the real one so builds still work.
export CARGO_HOME="${CARGO_HOME:-$real_home/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$real_home/.rustup}"
export NVM_DIR="${NVM_DIR:-$real_home/.nvm}"
export COREPACK_HOME="${COREPACK_HOME:-$real_home/.cache/node/corepack}"
export HOME="$dir/home"
export ANDROID_HOME="$dir/android-sdk"
export ANDROID_SDK_ROOT="$dir/android-sdk"
export PATH="$dir/bin:$PATH"
export QAREN_SANDBOX_DIR="$dir"
unset QAREN_LOCK_ROOT
echo "qaren-sim-sandbox: $dir (fake iOS UDID $FAKE_UDID, no Android device)" >&2
exec "$@"
