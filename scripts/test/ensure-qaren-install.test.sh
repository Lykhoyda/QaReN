#!/usr/bin/env bash
# ensure-qaren.sh --install --from-file: a verified tarball installs under a lock,
# and anything that differs from the plugin's runner-manifest.json or could
# write outside the runtime directory is refused with nothing installed.
#
# Run: bash scripts/test/ensure-qaren-install.test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/packages/qaren-plugin/scripts/ensure-qaren.sh"
VERSION=9.8.7
NAME="qaren-$VERSION-darwin-arm64.tar.gz"
TOP="qaren-$VERSION-darwin-arm64"

fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected '$2', got '$3'"
    fail=1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/stubs" "$tmp/plugin/scripts" "$tmp/tools" "$tmp/minimal-tools"
REQUIRED_TOOLS="uname dirname cat tar gzip shasum wc cut tr head du mktemp mkdir mv cp rm find ls sleep perl"
for tool in $REQUIRED_TOOLS bash node readlink ln python3 chmod grep sort basename seq diff dd; do
  tool_path=$(command -v "$tool") || exit 1
  ln -s "$tool_path" "$tmp/tools/$tool"
  case "$tool" in node | python3) ;; *) ln -s "$tool_path" "$tmp/minimal-tools/$tool" ;; esac
done
if command -v bsdtar >/dev/null 2>&1; then
  ln -s "$(command -v bsdtar)" "$tmp/tools/bsdtar"
fi
export HOME="$tmp/home" PATH="$tmp/tools"
unset QAREN_HOME
cp "$SCRIPT" "$tmp/plugin/scripts/ensure-qaren.sh"
if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  out=$(HOME="$tmp/home" PATH="$tmp/minimal-tools" /bin/bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>"$tmp/stderr")
  check "minimal PATH: missing manifest exits 0" 0 "$?"
  check "minimal PATH: missing manifest leaves stdout empty" "" "$out"
  check "minimal PATH: native Apple silicon reaches manifest validation" "qaren: this plugin carries no runner-manifest.json" "$(cat "$tmp/stderr")"
fi
# Substitute only the hardware adapter in the test copy for Intel/Rosetta cases.
TEST_SYSCTL="$tmp/stubs/sysctl" perl -pi -e 's{/usr/sbin/sysctl}{$ENV{TEST_SYSCTL}}g' "$tmp/plugin/scripts/ensure-qaren.sh"
printf '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo "${FAKE_ARCH:-arm64}" ;; *) echo Darwin ;; esac\n' > "$tmp/stubs/uname"
printf '#!/bin/sh\n[ "${FAKE_ARM64:-1}" = absent ] && exit 1\necho "${FAKE_ARM64:-1}"\n' > "$tmp/stubs/sysctl"
printf '#!/bin/sh\necho touched >> "%s/network"\nexit 7\n' "$tmp" > "$tmp/stubs/curl"
chmod +x "$tmp/stubs/sysctl" "$tmp/stubs/curl"
# sleep records its pid so the parked children of killed installers can be cleaned up.
printf '#!/bin/sh\necho $$ >> "%s/sleep-pids"\nexec "%s" "$@"\n' "$tmp" "$(command -v sleep)" > "$tmp/stubs/sleep"
chmod +x "$tmp/stubs/uname" "$tmp/stubs/sleep"
# All PATH entries belong to the fixture; no install can reach a real qaren link.
export PATH="$tmp/stubs:$tmp/home/bin:$tmp/tools"
mkdir -p "$tmp/home/bin"

# make_tarball <out> <kind>: good | dotdot | absolute | symlink | stray | bomb | manyfiles | large | flood | rodir | zerodir
make_tarball() {
  python3 - "$1" "$2" "$TOP" "$tmp" <<'PY'
import io, sys, tarfile
out, kind, top, tmp = sys.argv[1:]
class Zeros:
    def read(self, n=-1):
        return b"\0" * (n if n and n > 0 else 1 << 20)
def add(tar, name, data=b"", mode=0o644, kind=tarfile.REGTYPE, link=""):
    info = tarfile.TarInfo(name)
    info.type, info.mode, info.size, info.linkname = kind, mode, len(data), link
    tar.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
with tarfile.open(out, "w:gz", format=tarfile.USTAR_FORMAT, compresslevel=1) as tar:
    add(tar, f"{top}/", kind=tarfile.DIRTYPE, mode=0o755)
    add(tar, f"{top}/bin/", kind=tarfile.DIRTYPE, mode=0o755)
    if kind == "binary-directory":
        add(tar, f"{top}/bin/qaren/", kind=tarfile.DIRTYPE, mode=0o755)
    else:
        add(tar, f"{top}/bin/qaren", b"#!/bin/sh\necho qaren\n", 0o755)
    add(tar, f"{top}/runtime/qa/walk.js", b"// walk\n" * 4096)
    if kind == "dotdot":
        add(tar, f"{top}/../escaped", b"x")
    elif kind == "absolute":
        add(tar, f"{tmp}/abs-escaped", b"x")
    elif kind == "symlink":
        add(tar, f"{top}/runtime/out", kind=tarfile.SYMTYPE, link=f"{tmp}/link-escaped")
        add(tar, f"{top}/runtime/out/file", b"x")
    elif kind == "stray":
        add(tar, "elsewhere/file", b"x")
    elif kind == "bomb":
        info = tarfile.TarInfo(f"{top}/runtime/zeros")
        info.size = 1 << 30
        tar.addfile(info, Zeros())
    elif kind == "manyfiles":
        for i in range(300):
            add(tar, f"{top}/runtime/many/{i}", b"x")
    elif kind == "large":
        info = tarfile.TarInfo(f"{top}/runtime/zeros")
        info.size = 128 << 20
        tar.addfile(info, Zeros())
    elif kind == "flood":
        for i in range(10001):
            add(tar, f"{top}/runtime/flood/{i}")
    elif kind in ("rodir", "zerodir"):
        add(tar, f"{top}/runtime/native/", kind=tarfile.DIRTYPE, mode=0o555 if kind == "rodir" else 0)
        add(tar, f"{top}/runtime/native/helper", b"x")
PY
}

# write_manifest <tarball> [<byte delta>]
write_manifest() {
  local sha bytes
  sha=$(shasum -a 256 "$1" | cut -d' ' -f1)
  bytes=$(( $(wc -c < "$1" | tr -d ' ') + ${2:-0} ))
  printf '{"version":"%s","assets":{"ios":[],"android":[],"qaren":{"darwin-arm64":{"name":"%s","sha256":"%s","bytes":%s}}}}\n' \
    "$VERSION" "$NAME" "$sha" "$bytes" > "$tmp/plugin/runner-manifest.json"
}

run_install() {
  HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$1" 2>"$tmp/stderr"
}

for hardware in 0 absent; do
  FAKE_ARCH=x86_64 FAKE_ARM64="$hardware" run_install "$tmp/missing.tgz" > "$tmp/intel-stdout"
  rc=$?
  check "Intel $hardware: install refuses" yes "$([ "$rc" != 0 ] && echo yes || echo no)"
  check "Intel $hardware: clear unsupported message" "qaren 2.0 supports Apple silicon Macs only" "$(cat "$tmp/stderr")"
  out=$(FAKE_ARCH=x86_64 FAKE_ARM64="$hardware" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>"$tmp/stderr")
  check "Intel $hardware: hook exits 0" 0 "$?"
  check "Intel $hardware: hook leaves stdout empty" "" "$out"
  check "Intel $hardware: hook prints one unsupported diagnostic" "qaren: qaren 2.0 supports Apple silicon Macs only" "$(cat "$tmp/stderr")"
  out=$(FAKE_ARCH=x86_64 FAKE_ARM64="$hardware" HOME="$tmp/home" PATH="$tmp/stubs:$tmp/minimal-tools" /bin/bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>"$tmp/stderr")
  check "Intel $hardware with minimal PATH: hook exits 0" 0 "$?"
  check "Intel $hardware with minimal PATH: stdout empty" "" "$out"
  check "Intel $hardware with minimal PATH: unsupported" "qaren: qaren 2.0 supports Apple silicon Macs only" "$(cat "$tmp/stderr")"
  FAKE_ARCH=x86_64 FAKE_ARM64="$hardware" PATH="$tmp/stubs:$tmp/minimal-tools" run_install "$tmp/missing.tgz" > "$tmp/intel-stdout"
  check "Intel $hardware with minimal PATH: install refuses" yes "$([ "$?" != 0 ] && echo yes || echo no)"
  check "Intel $hardware with minimal PATH: unsupported" "qaren 2.0 supports Apple silicon Macs only" "$(cat "$tmp/stderr")"
done
check "Intel never downloads" no "$([ -e "$tmp/network" ] && echo yes || echo no)"

leftovers() {
  find "$tmp/home/.qaren/runtime" -mindepth 1 -maxdepth 1 -name '.staging-*' 2>/dev/null | wc -l | tr -d ' '
}

LOCKFILE_PATH() { echo "$tmp/home/.qaren/runtime/.lock-$VERSION"; }

# 0 when nothing holds this version's install lock (a fresh open can take it at once).
lock_free() {
  [ -e "$(LOCKFILE_PATH)" ] || { echo yes; return; }
  perl -MFcntl=:flock -e 'open(F, ">>", $ARGV[0]) or exit 2; exit(flock(F, LOCK_EX | LOCK_NB) ? 0 : 1)' "$(LOCKFILE_PATH)" \
    && echo yes || echo no
}

runtime_snapshot() { (cd "$DEST" 2>/dev/null && find . | sort && cat bin/qaren .tarball-sha256) 2>&1; }

# start_paused <stage>: runs an install that parks at <stage>; sets PAUSED_PID.
start_paused() {
  rm -f "$tmp/paused"
  QAREN_TEST_MODE=1 QAREN_TEST_PAUSE_AT="$1" QAREN_TEST_PAUSE_FILE="$tmp/paused" \
    HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" \
    >/dev/null 2>"$tmp/paused-stderr" &
  PAUSED_PID=$!
  local waited=0
  while [ ! -e "$tmp/paused" ] && [ "$waited" -lt 200 ]; do
    sleep 0.05
    waited=$((waited + 1))
  done
  [ -e "$tmp/paused" ] || echo "FAIL: installer never reached $1: $(cat "$tmp/paused-stderr")"
}

kill_paused() {
  kill -9 "$PAUSED_PID" 2>/dev/null
  wait "$PAUSED_PID" 2>/dev/null
}

reset_home() { rm -rf "$tmp/home"; mkdir -p "$tmp/home/bin"; }

DEST="$tmp/home/.qaren/runtime/$VERSION"
# The installer resolves the runtime root to its real path (/var is /private/var on macOS).
REAL_DEST="$(cd -P "$tmp" && pwd -P)/home/.qaren/runtime/$VERSION"

# A good tarball installs and records its digest.
reset_home
make_tarball "$tmp/good.tgz" good
write_manifest "$tmp/good.tgz"
out=$(run_install "$tmp/good.tgz"); rc=$?
check "good tarball installs" 0 "$rc"
check "prints the installed binary" "$REAL_DEST/bin/qaren" "$out"
check "installed binary runs" qaren "$("$DEST/bin/qaren")"
check "digest is recorded" "$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)" "$(cat "$DEST/.tarball-sha256")"
check "no staging left behind" 0 "$(leftovers)"

out=$(FAKE_ARCH=x86_64 FAKE_ARM64=1 run_install "$tmp/does-not-exist.tgz"); rc=$?
check "Rosetta: install selects the arm64 runtime" "0 $REAL_DEST/bin/qaren" "$rc $out"
hint=$(FAKE_ARCH=x86_64 FAKE_ARM64=1 HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin)
check "Rosetta: hook selects the arm64 runtime" "$REAL_DEST/bin/qaren" "$hint"

# Re-install is idempotent and needs no tarball at all.
before=$(ls -lTR "$DEST" 2>/dev/null || ls -l --full-time -R "$DEST")
out=$(run_install "$tmp/does-not-exist.tgz"); rc=$?
check "re-install exits 0" 0 "$rc"
check "re-install prints the same binary" "$REAL_DEST/bin/qaren" "$out"
check "re-install leaves the runtime untouched" "$before" "$(ls -lTR "$DEST" 2>/dev/null || ls -l --full-time -R "$DEST")"

rm "$DEST/bin/qaren"
mkdir "$DEST/bin/qaren"
out=$(run_install "$tmp/good.tgz"); rc=$?
check "directory binary is replaced" 0 "$rc"
check "replacement binary runs" qaren "$("$DEST/bin/qaren")"

reset_home
make_tarball "$tmp/binary-directory.tgz" binary-directory
write_manifest "$tmp/binary-directory.tgz"
run_install "$tmp/binary-directory.tgz" >/dev/null; rc=$?
check "tarball with directory binary is refused" 1 "$rc"
check "directory binary: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"
check "directory binary: no staging left behind" 0 "$(leftovers)"

write_manifest "$tmp/good.tgz"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "directory replacement: prior runtime installs" 0 "$rc"
cp -R "$DEST" "$tmp/previous-runtime"
write_manifest "$tmp/binary-directory.tgz"
run_install "$tmp/binary-directory.tgz" >/dev/null; rc=$?
check "directory replacement: tarball is refused" 1 "$rc"
check "directory replacement: names the invalid binary" yes "$(grep -q 'no executable bin/qaren' "$tmp/stderr" && echo yes || echo no)"
check "directory replacement: prior runtime is byte-identical" yes "$(diff -r "$tmp/previous-runtime" "$DEST" >/dev/null && echo yes || echo no)"
check "directory replacement: prior binary still runs" qaren "$("$DEST/bin/qaren")"
check "directory replacement: no staging left behind" 0 "$(leftovers)"

# A tampered byte is refused and nothing is installed.
reset_home
cp "$tmp/good.tgz" "$tmp/tampered.tgz"
printf '\x00' | dd of="$tmp/tampered.tgz" bs=1 seek=100 conv=notrunc 2>/dev/null
write_manifest "$tmp/good.tgz"
run_install "$tmp/tampered.tgz" >/dev/null; rc=$?
check "tampered tarball is refused" 1 "$rc"
check "tampered refusal names the digest" yes "$(grep -q 'sha256' "$tmp/stderr" && echo yes || echo no)"
check "tampered: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"
check "tampered: no staging left behind" 0 "$(leftovers)"

# A wrong byte count is refused.
reset_home
write_manifest "$tmp/good.tgz" 1
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "wrong length is refused" 1 "$rc"
check "wrong length: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"

# Paths and links that could write outside the runtime are refused.
for kind in dotdot absolute symlink stray; do
  reset_home
  make_tarball "$tmp/$kind.tgz" "$kind"
  write_manifest "$tmp/$kind.tgz"
  run_install "$tmp/$kind.tgz" >/dev/null; rc=$?
  check "$kind entry is refused" 1 "$rc"
  check "$kind: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"
  escaped=no
  for path in "$tmp/home/.qaren/runtime/escaped" "$tmp/home/.qaren/escaped" "$tmp/abs-escaped" "$tmp/link-escaped"; do
    [ -e "$path" ] || [ -L "$path" ] && escaped="yes: $path"
  done
  check "$kind: nothing escaped" no "$escaped"
  check "$kind: no staging left behind" 0 "$(leftovers)"
done

# Killing the install during extraction leaves no partial runtime.
reset_home
write_manifest "$tmp/good.tgz"
real_tar=$(command -v tar)
cat > "$tmp/stubs/tar" <<SH
#!/bin/sh
case "\$1" in
  -xzf) "$real_tar" "\$@"; kill -TERM \$PPID; sleep 5 ;;
  *) exec "$real_tar" "\$@" ;;
esac
SH
chmod +x "$tmp/stubs/tar"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
rm -f "$tmp/stubs/tar"
check "killed install does not succeed" yes "$([ "$rc" -ne 0 ] && echo yes || echo no)"
check "killed install: no runtime" no "$([ -e "$DEST" ] && echo yes || echo no)"
check "killed install: no staging left behind" 0 "$(leftovers)"

# A runtime whose recorded digest differs from the manifest is replaced as a whole.
stale_runtime() {
  reset_home
  mkdir -p "$DEST/bin"
  printf '#!/bin/sh\necho stale\n' > "$DEST/bin/qaren"
  chmod +x "$DEST/bin/qaren"
  printf 'stale\n' > "$DEST/stale-file"
  printf '%s\n' "$(printf 0%.0s $(seq 64))" > "$DEST/.tarball-sha256"
}
stale_runtime
out=$(run_install "$tmp/good.tgz"); rc=$?
check "mismatched runtime is replaced" 0 "$rc"
check "replaced runtime runs the new binary" qaren "$("$DEST/bin/qaren")"
check "replaced runtime records the new digest" "$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)" "$(cat "$DEST/.tarball-sha256")"
check "replaced runtime drops stale files" no "$([ -e "$DEST/stale-file" ] && echo yes || echo no)"
check "replaced runtime: no staging left behind" 0 "$(leftovers)"

# Interrupting between moving the previous runtime aside and publishing the new one restores it.
stale_runtime
real_mv=$(command -v mv)
cat > "$tmp/stubs/mv" <<SH
#!/bin/sh
case "\$1" in
  */x/$TOP) kill -TERM \$PPID; exit 143 ;;
esac
exec "$real_mv" "\$@"
SH
chmod +x "$tmp/stubs/mv"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
rm -f "$tmp/stubs/mv"
check "interrupted replacement does not succeed" yes "$([ "$rc" -ne 0 ] && echo yes || echo no)"
check "interrupted replacement keeps the previous runtime" stale "$("$DEST/bin/qaren")"
check "interrupted replacement keeps the previous files" yes "$([ -e "$DEST/stale-file" ] && echo yes || echo no)"
check "interrupted replacement: no staging left behind" 0 "$(leftovers)"

# A live installer holds the lock: a concurrent install of the same version is refused.
reset_home
start_paused download
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "a live install lock refuses" 1 "$rc"
check "live lock: names the running install" yes "$(grep -q 'install is running' "$tmp/stderr" && echo yes || echo no)"
check "live lock: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"
kill_paused
check "SIGKILL releases the lock although the installer's child still runs" yes "$(lock_free)"
out=$(run_install "$tmp/good.tgz"); rc=$?
check "after SIGKILL of the holder the install succeeds" 0 "$rc"
check "after SIGKILL: the runtime is complete" "$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)" "$(cat "$DEST/.tarball-sha256")"
check "the lock file is never removed" yes "$([ -f "$(LOCKFILE_PATH)" ] && echo yes || echo no)"
check "the lock is released after an install" yes "$(lock_free)"

# A child still changing staging keeps the lock after its installer is killed, until it finishes.
reset_home
real_cp=$(PATH="${PATH#"$tmp/stubs:"}" command -v cp)
cat > "$tmp/stubs/cp" <<SH
#!/bin/sh
: > "$tmp/cp-started"
"$real_cp" "\$@"
"$(PATH="${PATH#"$tmp/stubs:"}" command -v sleep)" 2
: > "$tmp/cp-done"
SH
chmod +x "$tmp/stubs/cp"
rm -f "$tmp/cp-started" "$tmp/cp-done"
HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" >/dev/null 2>&1 &
installer=$!
waited=0
while [ ! -e "$tmp/cp-started" ] && [ "$waited" -lt 200 ]; do sleep 0.05; waited=$((waited + 1)); done
kill -9 "$installer" 2>/dev/null
wait "$installer" 2>/dev/null
check "a writing child of a killed installer keeps the lock" no "$(lock_free)"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "while it writes, a new install is refused" 1 "$rc"
waited=0
while [ ! -e "$tmp/cp-done" ] && [ "$waited" -lt 200 ]; do sleep 0.05; waited=$((waited + 1)); done
sleep 0.2
check "the lock frees once the writing child finishes" yes "$(lock_free)"
rm -f "$tmp/stubs/cp"
out=$(run_install "$tmp/good.tgz"); rc=$?
check "then the next install heals and succeeds" 0 "$rc"
check "then the runtime is complete" "$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)" "$(cat "$DEST/.tarball-sha256")"
check "then no staging is left behind" 0 "$(leftovers)"

# SIGKILL at every stage, upgrading (no runtime yet) and replacing (a stale runtime): the next
# install heals what the killed one left and finishes, with no staging and the lock free.
GOOD_SHA=$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)
for mode in upgrade replace; do
  for stage in download verify extract move1 move2-before move2-after; do
    if [ "$mode" = replace ]; then stale_runtime; else reset_home; fi
    write_manifest "$tmp/good.tgz"
    start_paused "$stage"
    kill_paused
    label="SIGKILL $mode at $stage"
    check "$label: lock free while the parked child lives" yes "$(lock_free)"
    # A loaded host can blow the hook's Node budget; that answer says nothing about recovery.
    for attempt in 1 2 3; do
      hint=$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>&1)
      grep -q 'did not finish in time' <<< "$hint" || break
    done
    if [ "$mode" = replace ] && [ "$stage" = move2-before ]; then
      check "$label: print-bin reports the interrupted install" yes \
        "$(grep -q 'interrupted qaren v'"$VERSION"' install was found' <<< "$hint" && echo yes || echo "no: $hint")"
    else
      check "$label: print-bin claims no interrupted install" no \
        "$(grep -q 'interrupted' <<< "$hint" && echo "yes: $hint" || echo no)"
    fi
    out=$(run_install "$tmp/good.tgz"); rc=$?
    check "$label: the next install succeeds" 0 "$rc"
    check "$label: the runtime is complete" "$GOOD_SHA" "$(cat "$DEST/.tarball-sha256" 2>&1)"
    check "$label: the runtime runs" qaren "$("$DEST/bin/qaren" 2>&1)"
    check "$label: no staging left behind" 0 "$(leftovers)"
    check "$label: the lock is free" yes "$(lock_free)"
  done
done

# State this script does not create is refused and left exactly as found.
reset_home
mkdir -p "$tmp/home/.qaren/runtime" "$tmp/elsewhere"
printf 'keep\n' > "$tmp/elsewhere/file"
ln -s "$tmp/elsewhere" "$tmp/home/.qaren/runtime/.staging-$VERSION.evil01"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "symlinked staging is refused" 1 "$rc"
check "symlinked staging: named" yes "$(grep -q "unexpected install state at .*staging-$VERSION.evil01" "$tmp/stderr" && echo yes || echo no)"
check "symlinked staging: left in place" yes "$([ -L "$tmp/home/.qaren/runtime/.staging-$VERSION.evil01" ] && echo yes || echo no)"
check "symlinked staging: its target untouched" keep "$(cat "$tmp/elsewhere/file")"
check "symlinked staging: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"

reset_home
mkdir -p "$tmp/home/.qaren/runtime/.staging-$VERSION.odd001"
ln -s "$tmp/elsewhere" "$tmp/home/.qaren/runtime/.staging-$VERSION.odd001/previous"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "a symlinked previous runtime is refused" 1 "$rc"
check "symlinked previous: left in place" yes "$([ -L "$tmp/home/.qaren/runtime/.staging-$VERSION.odd001/previous" ] && echo yes || echo no)"
check "symlinked previous: never moved into place" no "$([ -e "$DEST" ] || [ -L "$DEST" ] && echo yes || echo no)"

reset_home
mkdir -p "$tmp/home/.qaren/runtime"
ln -s "$tmp/elsewhere/lock-target" "$(LOCKFILE_PATH)"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "a symlinked lock is refused" 1 "$rc"
check "symlinked lock: its target is never created" no "$([ -e "$tmp/elsewhere/lock-target" ] && echo yes || echo no)"

reset_home
mkdir -p "$tmp/home/.qaren/runtime"
ln -s "$tmp/elsewhere" "$DEST"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "a symlinked runtime directory is refused" 1 "$rc"
check "symlinked runtime: its target untouched" keep "$(cat "$tmp/elsewhere/file")"

# A saved runtime is never discarded because the destination turned out to be a symlink.
reset_home
mkdir -p "$tmp/home/.qaren/runtime/.staging-$VERSION.keep01/previous/bin"
printf 'saved\n' > "$tmp/home/.qaren/runtime/.staging-$VERSION.keep01/previous/bin/qaren"
ln -s "$tmp/elsewhere" "$DEST"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "symlinked runtime with a saved runtime is refused" 1 "$rc"
check "symlinked runtime: the saved runtime is kept" saved "$(cat "$tmp/home/.qaren/runtime/.staging-$VERSION.keep01/previous/bin/qaren" 2>&1)"

# Staging of another version whose name extends this one is not this version's to heal.
reset_home
OTHER="$tmp/home/.qaren/runtime/.staging-$VERSION.1.ABC123"
mkdir -p "$OTHER/previous/bin"
printf 'other\n' > "$OTHER/previous/bin/qaren"
out=$(run_install "$tmp/good.tgz"); rc=$?
check "an install beside a longer version's staging succeeds" 0 "$rc"
check "the longer version's staging is untouched" other "$(cat "$OTHER/previous/bin/qaren" 2>&1)"
check "nothing of it is restored into this version" "$GOOD_SHA" "$(cat "$DEST/.tarball-sha256" 2>&1)"
rm -rf "$OTHER"
hint=$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin)
check "after it, print-bin sees this version installed" "$REAL_DEST/bin/qaren" "$hint"

# The unpacked size is bounded before extraction and checked again on disk after it.
stale_runtime
before=$(runtime_snapshot)
make_tarball "$tmp/bomb.tgz" bomb
write_manifest "$tmp/bomb.tgz"
run_install "$tmp/bomb.tgz" >/dev/null; rc=$?
check "a 1 GiB entry is refused" 1 "$rc"
check "1 GiB entry: names the ceiling" yes "$(grep -q 'above the unpacked-size ceiling' "$tmp/stderr" && echo yes || echo no)"
check "1 GiB entry: refused before tar reads it" yes "$(grep -q 'would unpack to more than' "$tmp/stderr" && echo yes || echo no)"
check "1 GiB entry: the prior runtime is byte-identical" "$before" "$(runtime_snapshot)"
check "1 GiB entry: no staging left behind" 0 "$(leftovers)"
rm -f "$tmp/bomb.tgz"

make_tarball "$tmp/flood.tgz" flood
write_manifest "$tmp/flood.tgz"
run_install "$tmp/flood.tgz" >/dev/null; rc=$?
check "an entry flood is refused" 1 "$rc"
check "entry flood: named" yes "$(grep -q 'more than 10000 entries' "$tmp/stderr" && echo yes || echo no)"
check "entry flood: the prior runtime is byte-identical" "$before" "$(runtime_snapshot)"

# Small enough as a stream, but each file occupies a disk block: only the on-disk check sees it.
make_tarball "$tmp/many.tgz" manyfiles
write_manifest "$tmp/many.tgz"
QAREN_TEST_MODE=1 QAREN_MAX_UNPACKED_BYTES=700000 HOME="$tmp/home" \
  bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/many.tgz" >/dev/null 2>"$tmp/stderr"; rc=$?
check "on-disk size above the ceiling is refused after extraction" 1 "$rc"
check "on-disk size: named" yes "$(grep -q 'bytes on disk, above the unpacked-size ceiling' "$tmp/stderr" && echo yes || echo no)"
check "on-disk size: the prior runtime is byte-identical" "$before" "$(runtime_snapshot)"
check "on-disk size: no staging left behind" 0 "$(leftovers)"

# Every required tool is checked before anything is read, locked or written.
write_manifest "$tmp/good.tgz"
mkdir -p "$tmp/toolbox"
ln -sf "$tmp/stubs/uname" "$tmp/toolbox/uname"
ln -sf "$tmp/stubs/sysctl" "$tmp/toolbox/sysctl"
for t in $REQUIRED_TOOLS node; do
  [ "$t" = uname ] || ln -sf "$(PATH="${PATH#"$tmp/stubs:"}" command -v "$t")" "$tmp/toolbox/$t"
done
for t in $REQUIRED_TOOLS; do
  stale_runtime
  before=$(runtime_snapshot)
  mv "$tmp/toolbox/$t" "$tmp/toolbox/.$t"
  out=$(HOME="$tmp/home" PATH="$tmp/toolbox" "$BASH" "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" 2>&1); rc=$?
  hook_out=$(HOME="$tmp/home" PATH="$tmp/toolbox" "$BASH" "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>&1); hook_rc=$?
  mv "$tmp/toolbox/.$t" "$tmp/toolbox/$t"
  check "no $t: install refused" "1 ensure-qaren: required tool not found: $t" "$rc $out"
  check "no $t: print-bin says so and exits 0" "0 qaren: required tool not found: $t" "$hook_rc $hook_out"
  check "no $t: the prior runtime is byte-identical" "$before" "$(runtime_snapshot)"
  check "no $t: no staging and no lock taken" "0 no" "$(leftovers) $([ -e "$(LOCKFILE_PATH)" ] && echo yes || echo no)"
done

# Without an absolute HOME there is nowhere safe to install.
out=$(HOME= bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" 2>&1); rc=$?
check "empty HOME refuses the install" 1 "$rc"
check "empty HOME names the reason" yes "$(grep -q 'HOME is not an absolute path' <<< "$out" && echo yes || echo no)"

# No qaren asset for this host refuses the install.
reset_home
printf '{"version":"%s","assets":{"ios":[],"android":[]}}\n' "$VERSION" > "$tmp/plugin/runner-manifest.json"
run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "no asset for this host refuses" 1 "$rc"
check "no asset: nothing installed" no "$([ -e "$DEST" ] && echo yes || echo no)"

# Archive shapes the qaren build never writes are refused before tar unpacks anything.
GOOD_SHA=$(shasum -a 256 "$tmp/good.tgz" | cut -d' ' -f1)
refused_before_extract() {  # <label> <tarball> <message>
  stale_runtime
  local before
  before=$(runtime_snapshot)
  write_manifest "$2"
  run_install "$2" >/dev/null; rc=$?
  check "$1 is refused" 1 "$rc"
  check "$1: says why" yes "$(grep -q "$3" "$tmp/stderr" && echo yes || echo "no: $(cat "$tmp/stderr")")"
  check "$1: refused before extraction" no "$(grep -q 'bytes on disk' "$tmp/stderr" && echo yes || echo no)"
  check "$1: the prior runtime is byte-identical" "$before" "$(runtime_snapshot)"
  check "$1: no staging left behind" 0 "$(leftovers)"
  check "$1: the lock is free" yes "$(lock_free)"
}
gzip -c "$tmp/good.tgz" > "$tmp/nested.tgz"
refused_before_extract "a gzip nested in a gzip" "$tmp/nested.tgz" "is not one gzip layer over a tar archive"
make_tarball "$tmp/bomb.tgz" bomb
gzip -c "$tmp/bomb.tgz" > "$tmp/nestedbomb.tgz"
rm -f "$tmp/bomb.tgz"
refused_before_extract "a nested 1 GiB bomb" "$tmp/nestedbomb.tgz" "is not one gzip layer over a tar archive"
rm -f "$tmp/nestedbomb.tgz"

# A directory the installer could not later remove would wedge every following install.
for kind in rodir zerodir; do
  make_tarball "$tmp/$kind.tgz" "$kind"
  refused_before_extract "a $kind archive" "$tmp/$kind.tgz" "carries an entry with permissions the qaren build never writes"
  write_manifest "$tmp/good.tgz"
  for attempt in 1 2; do
    run_install "$tmp/good.tgz" >/dev/null; rc=$?
    check "after a $kind archive: normal install $attempt exits 0" 0 "$rc"
    check "after a $kind archive: normal install $attempt leaves no staging" 0 "$(leftovers)"
  done
  rm -f "$tmp/$kind.tgz"
done

# A link swapped into an installed runtime is never handed out, and --install replaces the runtime.
owned_snapshot() { (cd "$tmp/owned" && ls -l qaren record | cut -c1-10 && cat qaren record) 2>&1; }
for swap in binary bin-dir record; do
  reset_home
  write_manifest "$tmp/good.tgz"
  run_install "$tmp/good.tgz" >/dev/null
  rm -rf "$tmp/owned" "$tmp/substitute-ran"
  mkdir -p "$tmp/owned"
  printf '#!/bin/sh\ntouch "%s/substitute-ran"\n' "$tmp" > "$tmp/owned/qaren"
  chmod +x "$tmp/owned/qaren"
  cp "$DEST/.tarball-sha256" "$tmp/owned/record"
  case "$swap" in
    binary) rm "$DEST/bin/qaren"; ln -s "$tmp/owned/qaren" "$DEST/bin/qaren" ;;
    bin-dir) rm -rf "${DEST:?}/bin"; ln -s "$tmp/owned" "$DEST/bin" ;;
    record) rm "$DEST/.tarball-sha256"; ln -s "$tmp/owned/record" "$DEST/.tarball-sha256" ;;
  esac
  owned_before=$(owned_snapshot)
  hint=$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin)
  check "$swap link: print-bin prints the install command" yes \
    "$(grep -q 'is not installed. Install it with:' <<< "$hint" && echo yes || echo "no: $hint")"
  out=$(run_install "$tmp/good.tgz"); rc=$?
  check "$swap link: install repairs the runtime" 0 "$rc"
  check "$swap link: prints the real binary" "$REAL_DEST/bin/qaren" "$out"
  check "$swap link: no link is left" yes \
    "$([ ! -L "$DEST/bin" ] && [ ! -L "$DEST/bin/qaren" ] && [ ! -L "$DEST/.tarball-sha256" ] && [ -f "$DEST/bin/qaren" ] && [ -f "$DEST/.tarball-sha256" ] && echo yes || echo no)"
  check "$swap link: the real binary runs" qaren "$("$DEST/bin/qaren")"
  check "$swap link: no staging left behind" 0 "$(leftovers)"
  check "$swap link: the lock is free" yes "$(lock_free)"
  check "$swap link: print-bin now prints the real binary" "$REAL_DEST/bin/qaren" \
    "$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin)"
  check "$swap link: the link target is byte-identical" "$owned_before" "$(owned_snapshot)"
  check "$swap link: the substitute never ran" no "$([ -e "$tmp/substitute-ran" ] && echo yes || echo no)"
done
rm -rf "$tmp/owned"

# sparse_tarball <out> <hole bytes>: the good tree plus a PAX-sparse file of that logical size.
sparse_tarball() {
  local tree="$tmp/sparse-tree"
  rm -rf "$tree"
  mkdir -p "$tree"
  tar -xzf "$tmp/good.tgz" -C "$tree"
  python3 -c 'import sys; f = open(sys.argv[1], "wb"); f.seek(int(sys.argv[2])); f.write(b"x"); f.close()' \
    "$tree/$TOP/runtime/hole" "$2"
  if command -v bsdtar >/dev/null 2>&1; then
    COPYFILE_DISABLE=1 bsdtar --format pax --read-sparse --no-mac-metadata --no-xattrs -czf "$1" -C "$tree" "$TOP"
  else
    tar --sparse --format=pax -czf "$1" -C "$tree" "$TOP"
  fi
  rm -rf "$tree"
  check "fixture $(basename "$1") really is sparse" yes \
    "$(gzip -dc "$1" | LC_ALL=C grep -a -q 'GNU.sparse' && echo yes || echo no)"
}
sparse_tarball "$tmp/sparse-big.tgz" $((8 << 30))
refused_before_extract "an 8 GiB sparse entry" "$tmp/sparse-big.tgz" "would unpack to at least 85899"
sparse_tarball "$tmp/sparse-small.tgz" $((16 << 20))
refused_before_extract "a small sparse entry" "$tmp/sparse-small.tgz" "unsupported tar framing size"
rm -f "$tmp/sparse-big.tgz" "$tmp/sparse-small.tgz"

# A listing line this installer cannot read reliably stops the install instead of being guessed.
real_tar=$(PATH="${PATH#"$tmp/stubs:"}" command -v tar)
cat > "$tmp/stubs/tar" <<SH
#!/bin/sh
if [ "\$1" = --numeric-owner ]; then
  echo "-rw-r--r--  0 some owner 0 1 Jan  1  1970 $TOP/bin/qaren"
  exit 0
fi
exec "$real_tar" "\$@"
SH
chmod +x "$tmp/stubs/tar"
refused_before_extract "an unreadable listing line" "$tmp/good.tgz" "cannot read reliably"
rm -f "$tmp/stubs/tar"

# An inner gzip can carry "ustar" at offset 257 in its FEXTRA field; it is still refused before
# tar peels the second layer.
python3 - "$tmp/good.tgz" "$tmp/fextra.tgz" <<'PY'
import gzip, struct, sys, zlib
payload = gzip.decompress(open(sys.argv[1], "rb").read())
extra = bytearray(300)
extra[257 - 12:257 - 12 + 5] = b"ustar"
deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
inner = (b"\x1f\x8b\x08\x04" + b"\0" * 4 + b"\0\x03" + struct.pack("<H", len(extra)) + bytes(extra)
         + deflate.compress(payload) + deflate.flush()
         + struct.pack("<II", zlib.crc32(payload), len(payload) & 0xFFFFFFFF))
assert inner[257:262] == b"ustar"
open(sys.argv[2], "wb").write(gzip.compress(inner))
PY
refused_before_extract "a nested gzip carrying ustar in its extra field" "$tmp/fextra.tgz" "is not one gzip layer over a tar archive"
rm -f "$tmp/fextra.tgz"

# A download retried after a partial transfer starts over instead of appending to it.
reset_home
write_manifest "$tmp/good.tgz"
cat > "$tmp/stubs/curl" <<SH
#!/bin/sh
if [ ! -e "$tmp/curl-attempted" ]; then
  : > "$tmp/curl-attempted"
  head -c 1000 "$tmp/good.tgz"
  exit 28
fi
cat "$tmp/good.tgz"
SH
chmod +x "$tmp/stubs/curl"
rm -f "$tmp/curl-attempted"
out=$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install 2>"$tmp/stderr"); rc=$?
rm -f "$tmp/stubs/curl" "$tmp/curl-attempted"
check "a download retried after a partial transfer installs" 0 "$rc"
check "retried download: the runtime is complete" "$GOOD_SHA" "$(cat "$DEST/.tarball-sha256" 2>&1)"

# A legitimate large entry under the ceiling still installs.
stale_runtime
make_tarball "$tmp/large.tgz" large
write_manifest "$tmp/large.tgz"
out=$(run_install "$tmp/large.tgz"); rc=$?
check "a 128 MiB entry under the ceiling installs" 0 "$rc"
check "128 MiB entry: the runtime records its digest" "$(shasum -a 256 "$tmp/large.tgz" | cut -d' ' -f1)" "$(cat "$DEST/.tarball-sha256" 2>&1)"
rm -f "$tmp/large.tgz"

# A download that stalls after its installer is killed never holds the lock or lands anywhere.
reset_home
write_manifest "$tmp/good.tgz"
cat > "$tmp/stubs/curl" <<SH
#!/bin/sh
echo \$\$ >> "$tmp/sleep-pids"
head -c 102400 /dev/zero
: > "$tmp/curl-started"
exec "$(PATH="${PATH#"$tmp/stubs:"}" command -v sleep)" 30
SH
chmod +x "$tmp/stubs/curl"
rm -f "$tmp/curl-started"
HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install >/dev/null 2>&1 &
installer=$!
waited=0
while [ ! -e "$tmp/curl-started" ] && [ "$waited" -lt 200 ]; do sleep 0.05; waited=$((waited + 1)); done
kill -9 "$installer" 2>/dev/null
wait "$installer" 2>/dev/null
check "a stalled download leaves the lock free at once" yes "$(lock_free)"
rm -f "$tmp/stubs/curl"
out=$(run_install "$tmp/good.tgz"); rc=$?
check "after a stalled download the next install heals and succeeds" 0 "$rc"
check "after a stalled download: the runtime is complete" "$GOOD_SHA" "$(cat "$DEST/.tarball-sha256" 2>&1)"
check "after a stalled download: no staging left behind" 0 "$(leftovers)"
check "the stalled download's bytes land nowhere" 0 \
  "$(find "$tmp/home/.qaren" -type f -size 102400c 2>/dev/null | wc -l | tr -d ' ')"

# ~/.qaren or its runtime directory may point at storage the user owns; anything else is refused.
root_case() {  # <label> sets up $tmp/home, then installs
  out=$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" 2>"$tmp/stderr"); rc=$?
}
reset_home
mkdir -p "$tmp/home/.qaren" "$tmp/store1"
ln -s "$tmp/store1" "$tmp/home/.qaren/runtime"
root_case
STORE1=$(cd -P "$tmp/store1" && pwd -P)
check "runtime linked to owned storage installs" 0 "$rc"
check "owned storage: the runtime lands in the real directory" "$GOOD_SHA" "$(cat "$STORE1/$VERSION/.tarball-sha256" 2>&1)"
check "owned storage: the lock lives in the real directory" yes "$([ -f "$STORE1/.lock-$VERSION" ] && echo yes || echo no)"
hint=$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin)
check "owned storage: print-bin hands out the installed binary" "$STORE1/$VERSION/bin/qaren" "$hint"

reset_home
rm -rf "$tmp/store2"
mkdir -p "$tmp/store2"
ln -s "$tmp/store2" "$tmp/home/.qaren"
root_case
check "~/.qaren linked to owned storage installs" 0 "$rc"
check "linked ~/.qaren: the runtime lands under it" "$GOOD_SHA" \
  "$(cat "$(cd -P "$tmp/store2" && pwd -P)/runtime/$VERSION/.tarball-sha256" 2>&1)"

ROOT_OWNED_DIR=/usr
reset_home
mkdir -p "$tmp/home/.qaren"
ln -s "$ROOT_OWNED_DIR" "$tmp/home/.qaren/runtime"
root_case
check "a runtime linked to a directory owned by someone else is refused" 1 "$rc"
check "foreign root: says so" yes "$(grep -q 'resolves to a directory you do not own' "$tmp/stderr" && echo yes || echo no)"

FOREIGN_PARENT="/tmp/qaren-root-test-$$"
rm -rf "$FOREIGN_PARENT"
mkdir -p "$FOREIGN_PARENT"
reset_home
mkdir -p "$tmp/home/.qaren"
ln -s "$FOREIGN_PARENT" "$tmp/home/.qaren/runtime"
root_case
check "a runtime inside a directory owned by someone else is refused" 1 "$rc"
check "foreign parent: says so" yes "$(grep -q 'resolves to a directory you do not own' "$tmp/stderr" && echo yes || echo no)"
check "foreign parent: nothing is written" "" "$(ls -A "$FOREIGN_PARENT")"
# A planted, complete runtime there is never handed out by the hook.
mkdir -p "$FOREIGN_PARENT/$VERSION/bin"
printf '#!/bin/sh\n' > "$FOREIGN_PARENT/$VERSION/bin/qaren"
chmod +x "$FOREIGN_PARENT/$VERSION/bin/qaren"
printf '%s\n' "$GOOD_SHA" > "$FOREIGN_PARENT/$VERSION/.tarball-sha256"
hint=$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>&1); rc=$?
check "foreign parent: print-bin exits 0" 0 "$rc"
check "foreign parent: print-bin refuses to hand out the planted binary" yes \
  "$(grep -q 'is not a directory you own' <<< "$hint" && ! grep -q "bin/qaren\$" <<< "$hint" && echo yes || echo "no: $hint")"
rm -rf "$FOREIGN_PARENT"

reset_home
mkdir -p "$tmp/home/.qaren"
ln -s "$tmp/nowhere" "$tmp/home/.qaren/runtime"
root_case
check "a dangling runtime link is refused" 1 "$rc"
check "dangling root: an ensure-qaren message, not a raw tool error" yes \
  "$(grep -q '^ensure-qaren: cannot use' "$tmp/stderr" && ! grep -q '^mkdir' "$tmp/stderr" && echo yes || echo "no: $(cat "$tmp/stderr")")"
check "dangling root: the link target is never created" no "$([ -e "$tmp/nowhere" ] && echo yes || echo no)"

# A standard user bin directory on PATH wins over an earlier writable app-private directory.
reset_home
write_manifest "$tmp/good.tgz"
mkdir -p "$tmp/app-bin" "$tmp/home/bin" "$tmp/home/.local/bin" "$tmp/read-only-tools"
for tool in $REQUIRED_TOOLS bash node readlink ln; do
  ln -s "$(command -v "$tool")" "$tmp/read-only-tools/$tool"
done
chmod 555 "$tmp/read-only-tools"
STANDARD_PATH="$tmp/read-only-tools:$tmp/app-bin:$tmp/home/bin:$tmp/home/.local/bin"
out=$(PATH="$STANDARD_PATH" run_install "$tmp/good.tgz"); rc=$?
check "PATH link: install exits 0" 0 "$rc"
check "PATH link: the first standard bin directory on PATH gets the link" "$REAL_DEST/bin/qaren" "$(readlink "$tmp/home/bin/qaren")"
check "PATH link: qaren runs without changing PATH" qaren "$(PATH="$STANDARD_PATH" /bin/bash -c qaren)"
check "PATH link: stdout is exactly the binary path" "$REAL_DEST/bin/qaren" "$out"
check "PATH link: no export notice" no "$(grep -q 'export PATH=' "$tmp/stderr" && echo yes || echo no)"
check "PATH link: an app-private writable directory is skipped" no "$([ -e "$tmp/app-bin/qaren" ] && echo yes || echo no)"
check "PATH link: only one link is made" no "$([ -e "$tmp/home/.local/bin/qaren" ] && echo yes || echo no)"

# With no standard bin directory on PATH, the first writable absolute directory still makes qaren invocable.
reset_home
rm -f "$tmp/app-bin/qaren"
out=$(PATH="$tmp/read-only-tools:$tmp/app-bin" run_install "$tmp/good.tgz"); rc=$?
check "no standard dir: install exits 0" "0 $REAL_DEST/bin/qaren" "$rc $out"
check "no standard dir: the first writable PATH directory gets the link" "$REAL_DEST/bin/qaren" "$(readlink "$tmp/app-bin/qaren")"
check "no standard dir: qaren runs without changing PATH" qaren "$(PATH="$tmp/read-only-tools:$tmp/app-bin" /bin/bash -c qaren)"
check "no standard dir: no export notice" no "$(grep -q 'export PATH=' "$tmp/stderr" && echo yes || echo no)"
check "no standard dir: no ~/.local/bin link" no "$([ -e "$tmp/home/.local/bin/qaren" ] && echo yes || echo no)"
rm -f "$tmp/app-bin/qaren"

# Empty and relative PATH entries name the caller's directory, never a place to link qaren.
reset_home
mkdir -p "$tmp/cwd/rel-bin"
out=$(cd "$tmp/cwd" && PATH=":rel-bin:$tmp/read-only-tools" run_install "$tmp/good.tgz"); rc=$?
check "relative PATH: install exits 0" "0 $REAL_DEST/bin/qaren" "$rc $out"
check "relative PATH: nothing is linked in the working directory" "no no" \
  "$([ -e "$tmp/cwd/qaren" ] && echo yes || echo no) $([ -e "$tmp/cwd/rel-bin/qaren" ] && echo yes || echo no)"
check "relative PATH: falls back to ~/.local/bin" "$REAL_DEST/bin/qaren" "$(readlink "$tmp/home/.local/bin/qaren")"

# With no writable PATH directory, preserve the fallback and command ownership.
run_link_install() { PATH="$tmp/read-only-tools" run_install "$1"; }
LINK="$tmp/home/.local/bin/qaren"
reset_home
write_manifest "$tmp/good.tgz"
out=$(run_link_install "$tmp/good.tgz"); rc=$?
check "link: install exits 0" 0 "$rc"
check "link: missing ~/.local/bin is created and links the binary" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"
check "link: the linked binary runs" qaren "$("$LINK")"
check "link: stdout is still exactly the binary path" "$REAL_DEST/bin/qaren" "$out"
check "link: names the PATH line when ~/.local/bin is not on PATH" yes \
  "$(grep -Fxq 'qaren: no writable directory is on PATH; add ~/.local/bin to PATH: export PATH="$HOME/.local/bin:$PATH"' "$tmp/stderr" && echo yes || echo "no: $(cat "$tmp/stderr")")"
out=$(run_link_install "$tmp/does-not-exist.tgz"); rc=$?
check "link: re-install is idempotent" "0 $REAL_DEST/bin/qaren $REAL_DEST/bin/qaren" "$rc $out $(readlink "$LINK")"
out=$(PATH="$tmp/home/.local/bin:$PATH" run_install "$tmp/does-not-exist.tgz")
check "link: no PATH line when ~/.local/bin is on PATH" no "$(grep -q 'to PATH' "$tmp/stderr" && echo yes || echo no)"

OLDER="$(cd -P "$tmp" && pwd -P)/home/.qaren/runtime/0.0.1/bin/qaren"
rm "$LINK" && ln -s "$OLDER" "$LINK"
check "link: an older-runtime link is planted" "$OLDER" "$(readlink "$LINK")"
run_link_install "$tmp/does-not-exist.tgz" >/dev/null
check "link: a link to an older runtime is replaced" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"

rm "$LINK"
printf 'mine\n' > "$LINK"
out=$(run_link_install "$tmp/does-not-exist.tgz"); rc=$?
check "link: a foreign file leaves the install green" "0 $REAL_DEST/bin/qaren" "$rc $out"
check "link: a foreign file is byte-identical" "mine" "$(cat "$LINK")"
check "link: a foreign file is named on stderr" yes \
  "$(grep -q 'already exists and is not a qaren install link' "$tmp/stderr" && echo yes || echo "no: $(cat "$tmp/stderr")")"

rm "$LINK"
ln -s "$tmp/elsewhere/qaren" "$LINK"
run_link_install "$tmp/does-not-exist.tgz" >/dev/null; rc=$?
check "link: a link outside the runtime root is left untouched" "0 $tmp/elsewhere/qaren" "$rc $(readlink "$LINK")"

reset_home
write_manifest "$tmp/good.tgz" 1
run_link_install "$tmp/good.tgz" >/dev/null; rc=$?
check "link: a refused install creates no link" "1 no" "$rc $([ -e "$LINK" ] || [ -L "$LINK" ] && echo yes || echo no)"

# QAREN_HOME holds its own runtime; ~/.qaren is never written. Every PATH below names only test directories.
REAL_TMP="$(cd -P "$tmp" && pwd -P)"
SIDE_DEST="$REAL_TMP/side/qaren-home/runtime/$VERSION"
reset_home
write_manifest "$tmp/good.tgz"
mkdir -p "$tmp/side"
out=$(QAREN_HOME="$tmp/side/qaren-home" run_link_install "$tmp/good.tgz"); rc=$?
check "QAREN_HOME: install prints the binary under it" "0 $SIDE_DEST/bin/qaren" "$rc $out"
check "QAREN_HOME: ~/.qaren is never created" no "$([ -e "$tmp/home/.qaren" ] && echo yes || echo no)"
check "QAREN_HOME: print-bin finds it" "$SIDE_DEST/bin/qaren" \
  "$(QAREN_HOME="$tmp/side/qaren-home" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>/dev/null)"
out=$(QAREN_HOME=relative HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin 2>"$tmp/stderr"); rc=$?
check "relative QAREN_HOME: hook exits 0 with empty stdout" "0 " "$rc $out"
check "relative QAREN_HOME: hook names it" "qaren: QAREN_HOME is not an absolute path" "$(cat "$tmp/stderr")"
QAREN_HOME=relative run_link_install "$tmp/good.tgz" >/dev/null; rc=$?
check "relative QAREN_HOME: install refuses" "1 yes" \
  "$rc $(grep -q 'QAREN_HOME is not an absolute path' "$tmp/stderr" && echo yes || echo no)"
check "--link is refused outside --install" 2 \
  "$(HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --print-bin --link 2>/dev/null; echo $?)"

# A release and a -dev source build never relink each other's working link unless --link is passed.
with_version() { VERSION="$1"; NAME="qaren-$VERSION-darwin-arm64.tar.gz"; TOP="qaren-$VERSION-darwin-arm64"; }
RELEASE=$VERSION
DEV="$RELEASE-dev.abcdef123456"
DEV_DEST="$REAL_TMP/home/.qaren/runtime/$DEV"
with_version "$DEV"
make_tarball "$tmp/dev.tgz" good
with_version "$RELEASE"
LINE_PATH="$tmp/read-only-tools:$tmp/home/.local/bin"
install_as() {
  with_version "$1"
  write_manifest "$2"
  PATH="$LINE_PATH" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$2" ${3:+"$3"} 2>"$tmp/stderr"
  local rc=$?
  with_version "$RELEASE"
  return "$rc"
}
reset_home
mkdir -p "$tmp/home/.local/bin"
install_as "$RELEASE" "$tmp/good.tgz" >/dev/null
check "lines: the release is linked" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"
out=$(install_as "$DEV" "$tmp/dev.tgz"); rc=$?
check "lines: a dev install beside the release succeeds" "0 $DEV_DEST/bin/qaren" "$rc $out"
check "lines: the release link is kept" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"
check "lines: the release runtime is kept" "$GOOD_SHA" "$(cat "$DEST/.tarball-sha256")"
check "lines: the refusal names --link" yes "$(grep -q -- '--link' "$tmp/stderr" && echo yes || echo "no: $(cat "$tmp/stderr")")"
check "lines: the HOME link refusal offers replacement" yes "$(grep -q 'replace it' "$tmp/stderr" && echo yes || echo no)"
install_as "$DEV" "$tmp/dev.tgz" --link >/dev/null
check "lines: --link moves the link to the dev build" "$DEV_DEST/bin/qaren" "$(readlink "$LINK")"
install_as "$RELEASE" "$tmp/good.tgz" >/dev/null
check "lines: a release install keeps a dev link" "$DEV_DEST/bin/qaren" "$(readlink "$LINK")"
rm -rf "$tmp/home/.qaren/runtime/$DEV"
install_as "$RELEASE" "$tmp/good.tgz" >/dev/null
check "lines: a dangling link of the other line here is replaced" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"
mkdir -p "$tmp/home/.qaren/runtime/9.8.6/bin"
cp "$DEST/bin/qaren" "$tmp/home/.qaren/runtime/9.8.6/bin/qaren"
rm "$LINK" && ln -s "$REAL_TMP/home/.qaren/runtime/9.8.6/bin/qaren" "$LINK"
install_as "$RELEASE" "$tmp/good.tgz" >/dev/null
check "lines: a release upgrade still relinks the working older release" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"

# A qaren already first on PATH is the only link touched, so no install ever shadows it.
mkdir -p "$tmp/app-bin" "$tmp/other/.qaren/runtime/2.0.0/bin"
cp "$DEST/bin/qaren" "$tmp/other/.qaren/runtime/2.0.0/bin/qaren"
rm -f "$tmp/app-bin/qaren" "$LINK" "$tmp/home/bin/qaren"
ln -s "$tmp/other/.qaren/runtime/2.0.0/bin/qaren" "$tmp/app-bin/qaren"
SHADOW_PATH="$tmp/read-only-tools:$tmp/app-bin:$tmp/home/bin:$tmp/home/.local/bin"
PATH="$SHADOW_PATH" run_install "$tmp/good.tgz" >/dev/null; rc=$?
check "no shadow: the install succeeds" 0 "$rc"
check "no shadow: the other home's link is kept" "$tmp/other/.qaren/runtime/2.0.0/bin/qaren" "$(readlink "$tmp/app-bin/qaren")"
check "no shadow: no second link is made" "no no" \
  "$([ -e "$tmp/home/bin/qaren" ] && echo yes || echo no) $([ -e "$LINK" ] && echo yes || echo no)"
check "no shadow: names the other QAREN_HOME" yes "$(grep -q 'another QAREN_HOME' "$tmp/stderr" && echo yes || echo "no: $(cat "$tmp/stderr")")"
check "no shadow: foreign link hint never promises replacement" no "$(grep -q 'replace it' "$tmp/stderr" && echo yes || echo no)"
check "no shadow: foreign link hint names the HOME link" yes "$(grep -Fq -- "--link to link $LINK and put that directory first on PATH" "$tmp/stderr" && echo yes || echo no)"
# An empty HOME bin before another home's qaren must receive its own link.
OWN_PATH="$tmp/home/.local/bin:$tmp/read-only-tools:$tmp/app-bin"
out=$(QAREN_HOME="$tmp/home/.qaren" PATH="$OWN_PATH" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" --link 2>"$tmp/stderr"); rc=$?
check "own HOME: --link succeeds with binary-only stdout" "0 $REAL_DEST/bin/qaren" "$rc $out"
check "own HOME: the other home's link is unchanged" "$tmp/other/.qaren/runtime/2.0.0/bin/qaren" "$(readlink "$tmp/app-bin/qaren")"
check "own HOME: --link creates the HOME link" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"
check "own HOME: no shadow warning when the new HOME link is first" no \
  "$(grep -q 'may shadow' "$tmp/stderr" && echo yes || echo no)"
check "own HOME: reports the link written" yes "$(grep -Fxq "qaren: linked $LINK -> $REAL_DEST/bin/qaren" "$tmp/stderr" && echo yes || echo no)"

PATH="$SHADOW_PATH" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" --link >/dev/null 2>"$tmp/stderr"
check "shadow: an earlier qaren is unchanged" "$tmp/other/.qaren/runtime/2.0.0/bin/qaren" "$(readlink "$tmp/app-bin/qaren")"
check "shadow: warns when the HOME link is later on PATH" yes "$(grep -Fq "$tmp/app-bin/qaren may shadow $LINK" "$tmp/stderr" && echo yes || echo no)"

rm "$LINK"
ln -s "$tmp/other/.qaren/runtime/2.0.0/bin/qaren" "$LINK"
QAREN_HOME="$tmp/home/.qaren" PATH="$OWN_PATH" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" --link >/dev/null 2>"$tmp/stderr"
check "own HOME: --link replaces a link into another QAREN_HOME" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"
check "own HOME: no shadow warning for its own link" no "$(grep -q 'may shadow' "$tmp/stderr" && echo yes || echo no)"

PATH="$tmp/home/.local/bin/:$tmp/read-only-tools" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" --link >/dev/null 2>"$tmp/stderr"; rc=$?
check "own HOME: trailing slash PATH entry succeeds without notices" "0 no" "$rc $(grep -Eq 'may shadow|not on PATH' "$tmp/stderr" && echo yes || echo no)"
ln -s "$REAL_DEST/bin/qaren" "$tmp/home/bin/qaren"
PATH="$tmp/home/bin:$OWN_PATH" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" --link >/dev/null 2>"$tmp/stderr"; rc=$?
check "own HOME: another link to the same runtime does not shadow" "0 no" "$rc $(grep -q 'may shadow' "$tmp/stderr" && echo yes || echo no)"
rm "$tmp/home/bin/qaren"

install_as "$DEV" "$tmp/dev.tgz" --link >/dev/null
install_as "$RELEASE" "$tmp/good.tgz" --link >/dev/null
check "lines: --link moves the dev link back to the release" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"

rm -rf "$tmp/home/.local"
PATH="$tmp/read-only-tools" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" --link >/dev/null 2>"$tmp/stderr"
check "own HOME: --link creates a missing bin outside PATH" "$REAL_DEST/bin/qaren" "$(readlink "$LINK")"
check "own HOME: --link prints the PATH fix" yes "$(grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$tmp/stderr" && echo yes || echo no)"

rm "$LINK"
printf 'mine\n' > "$LINK"
PATH="$OWN_PATH" HOME="$tmp/home" bash "$tmp/plugin/scripts/ensure-qaren.sh" --install --from-file "$tmp/good.tgz" --link >/dev/null 2>"$tmp/stderr"; rc=$?
check "own HOME: --link preserves a regular file" "0 mine" "$rc $(cat "$LINK")"
check "own HOME: no link reported when the file is kept" no "$(grep -q '^qaren: linked ' "$tmp/stderr" && echo yes || echo no)"

out=$(HOME="$tmp/home" PATH="$tmp/tools" bash "$ROOT/scripts/install-qaren-from-source.sh" --help); rc=$?
check "source help: exits before building or installing" 0 "$rc"
check "source help: describes HOME-only linking" yes "$(grep -Fq '$HOME/.local/bin/qaren' <<< "$out" && echo yes || echo no)"

rm -f "$tmp/app-bin/qaren"

chmod 755 "$tmp/read-only-tools"
[ -f "$tmp/sleep-pids" ] && kill $(cat "$tmp/sleep-pids") 2>/dev/null
exit "$fail"
