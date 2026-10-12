#!/usr/bin/env bash
# Verifies and installs the qaren runtime this plugin version vouches for.
#
#   ensure-qaren.sh --print-bin                   offline verification; stdout is empty or one line:
#                                                 the binary path or an install/repair/timeout instruction;
#                                                 other diagnostics go to stderr; always exits 0
#   ensure-qaren.sh --install [--from-file <tgz>] downloads (or takes) the tarball, verifies its
#                                                 sha256 and length against runner-manifest.json,
#                                                 installs it into ~/.qaren/runtime/<v>/ and links qaren onto PATH;
#                                                 stdout is exactly the binary path; rerun --install after interruption
set -euo pipefail

MODE=""
FROM_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --print-bin | --install) MODE="$1" ;;
    --from-file)
      [ $# -ge 2 ] || { echo "ensure-qaren: --from-file needs a path" >&2; exit 2; }
      FROM_FILE="$2"
      shift
      ;;
    *) echo "ensure-qaren: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { echo "usage: ensure-qaren.sh --print-bin | --install [--from-file <tarball>]" >&2; exit 2; }

# node and curl keep their own messages where they are needed.
REQUIRED_TOOLS="uname dirname cat tar gzip shasum wc cut tr head du mktemp mkdir mv cp rm find ls sleep perl"
for tool in $REQUIRED_TOOLS; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    [ "$MODE" = --print-bin ] && { echo "qaren: required tool not found: $tool" >&2; exit 0; }
    echo "ensure-qaren: required tool not found: $tool" >&2
    exit 1
  fi
done

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$PLUGIN_ROOT/runner-manifest.json"
RELEASES="https://github.com/Lykhoyda/rn-dev-agent/releases/download"
RUNTIME_ROOT="${HOME:-}/.qaren/runtime"
RECORD=".tarball-sha256"
INSTALL_COMMAND="bash $(printf %q "$PLUGIN_ROOT/scripts/ensure-qaren.sh") --install"
# Decompression-bomb ceiling for the unpacked runtime; the manifest digest stays the trust root.
MAX_UNPACKED_BYTES=536870912
MAX_ENTRIES=10000
if [ "${QAREN_TEST_MODE:-}" = 1 ] && [ -n "${QAREN_MAX_UNPACKED_BYTES:-}" ]; then
  MAX_UNPACKED_BYTES="$QAREN_MAX_UNPACKED_BYTES"
fi

# Prints the expected asset as four lines: version, name, sha256, bytes.
# Fails (with a reason on stderr) when this plugin carries no tarball for the host.
read_asset() {
  local platform=darwin-arm64
  [ "$(uname -s)" = Darwin ] || { echo "qaren ships a macOS runtime only; this host is $(uname -s)" >&2; return 1; }
  [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] || { echo "qaren 2.0 supports Apple silicon Macs only" >&2; return 3; }
  [ -f "$MANIFEST" ] || { echo "this plugin carries no runner-manifest.json" >&2; return 1; }
  command -v node >/dev/null 2>&1 || { echo "qaren needs Node 24 or newer on PATH" >&2; return 1; }
  exec node -e '
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 24) {
      console.error(`qaren needs Node 24 or newer; found ${process.version}`);
      process.exit(3);
    }
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const a = (m.assets && m.assets.qaren && m.assets.qaren[process.argv[2]]) || {};
    console.log([m.version, a.name, a.sha256, a.bytes].map((v) => (v === undefined ? "" : v)).join("\n"));
  ' "$MANIFEST" "$platform"
}

validate_asset() {
  local out="$1" version name sha bytes platform
  platform=darwin-arm64
  { read -r version; read -r name; read -r sha; read -r bytes; } <<< "$out"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "runner-manifest.json has no release version" >&2; return 1; }
  [ -n "$name" ] || { echo "qaren v$version has no $platform tarball in runner-manifest.json" >&2; return 1; }
  [ "$name" = "qaren-$version-$platform.tar.gz" ] || { echo "unexpected qaren asset name: $name" >&2; return 1; }
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "qaren asset $name has no sha256" >&2; return 1; }
  [[ "$bytes" =~ ^[1-9][0-9]*$ ]] || { echo "qaren asset $name has no byte length" >&2; return 1; }
  printf '%s\n%s\n%s\n%s\n' "$version" "$name" "$sha" "$bytes"
}

expected_asset() {
  local out
  out=$(read_asset) || return 1
  validate_asset "$out"
}

installed_bin() {
  local dest="$RUNTIME_ROOT/$1" sha="$2"
  # A runtime someone else put there is never handed out, whatever its record says.
  [ ! -L "$dest" ] && [ -O "$dest" ] && [ ! -L "$dest/bin" ] && [ ! -L "$dest/bin/qaren" ] \
    && [ -f "$dest/bin/qaren" ] && [ -x "$dest/bin/qaren" ] && [ -O "$dest/bin/qaren" ] \
    && [ ! -L "$dest/$RECORD" ] && [ -f "$dest/$RECORD" ] && [ -O "$dest/$RECORD" ] \
    && (exec 9>&-; perl -e 'open(my $f, "<", $ARGV[0]) or exit 1; read($f, my $record, 66); exit($record eq $ARGV[1] || $record eq "$ARGV[1]\n" ? 0 : 1)' "$dest/$RECORD" "$sha") && echo "$dest/bin/qaren"
}

# Staging names are .staging-<version>.<six mktemp characters>; matching exactly six keeps
# 2.0.0-alpha from claiming .staging-2.0.0-alpha.1.XXXXXX.
has_staging() {
  local staging
  for staging in "$RUNTIME_ROOT/.staging-$1".??????; do
    { [ -e "$staging" ] || [ -L "$staging" ]; } && return 0
  done
  return 1
}

# An install killed between moving the old runtime aside and publishing the new one leaves it here.
interrupted_install() {
  local staging
  [ -e "$RUNTIME_ROOT/$1" ] && return 1
  for staging in "$RUNTIME_ROOT/.staging-$1".??????; do
    [ -d "$staging/previous" ] && return 0
  done
  return 1
}

# ~/.qaren or its runtime directory may link to other storage you own. Resolve the root once and
# work only on the real directory; returns 1 when it is not a directory, 2 when you do not own it
# or the directory holding it.
real_root() {
  local real
  real=$(cd -P "$RUNTIME_ROOT" 2>/dev/null && pwd -P) || return 1
  [ -O "$real" ] && [ -O "${real%/*}" ] || return 2
  RUNTIME_ROOT="$real"
}

# Creates the missing parts of ~/.qaren/runtime only inside a directory already proven to be yours.
make_root() {
  local parent="${RUNTIME_ROOT%/*}" real_parent
  if [ ! -e "$RUNTIME_ROOT" ] && [ ! -L "$RUNTIME_ROOT" ]; then
    if [ -e "$parent" ] || [ -L "$parent" ]; then
      real_parent=$(cd -P "$parent" 2>/dev/null && pwd -P) || return 1
    else
      real_parent=$(cd -P "$HOME" 2>/dev/null && pwd -P) || return 1
      [ -O "$real_parent" ] || return 2
      mkdir "$real_parent/${parent##*/}" 2>/dev/null || [ -d "$real_parent/${parent##*/}" ] || return 1
      real_parent="$real_parent/${parent##*/}"
    fi
    [ -O "$real_parent" ] || return 2
    mkdir "$real_parent/${RUNTIME_ROOT##*/}" 2>/dev/null || [ -d "$real_parent/${RUNTIME_ROOT##*/}" ] || return 1
  fi
  real_root
}

check_bin() {
  set +m
  local asset version name sha bytes
  if [ -e "$RUNTIME_ROOT" ] && ! real_root; then
    echo "qaren: the qaren runtime directory $RUNTIME_ROOT is not a directory you own; inspect it" >&2
    return 0
  fi
  if ! asset=$(expected_asset 2>&1); then
    echo "qaren: ${asset%%$'\n'*}" >&2
    return 0
  fi
  { read -r version; read -r name; read -r sha; read -r bytes; } <<< "$asset"
  installed_bin "$version" "$sha" 2>/dev/null && return 0
  if interrupted_install "$version"; then
    echo "qaren: an interrupted qaren v$version install was found; repair it with: $INSTALL_COMMAND"
    return 0
  fi
  echo "qaren v$version is not installed. Install it with: $INSTALL_COMMAND"
}

print_bin() {
  local result pid watchdog rc=0
  result=$(mktemp 2>/dev/null) || { echo "qaren: cannot create a temporary file" >&2; return 0; }
  # Its own process group lets a timeout kill everything the check started; bash's launch noise is not hook output.
  set -m
  { check_bin > "$result" 2>&3 3>&- & } 3>&2 2>/dev/null
  pid=$!
  {
    (
      set +m
      sleep 1
      kill -KILL -- "-$pid" 2>/dev/null || true
    ) &
  } 2>/dev/null
  watchdog=$!
  set +m
  wait "$pid" 2>/dev/null || rc=$?
  kill -KILL -- "-$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if [ "$rc" = 137 ]; then
    echo "qaren: the runtime check did not finish in time; run: $INSTALL_COMMAND"
  else
    cat "$result"
  fi
  rm -f "$result"
}

refuse() { echo "ensure-qaren: $*" >&2; exit 1; }

# Read-only children run with fd 9 closed, so a reader outliving a killed installer never keeps
# the lock. Children that change staging or the runtime keep it until they finish: nobody heals
# while a killed installer's last write is still landing.
nolock() { "$@" 9>&-; }

# QAREN_TEST_MODE=1 with QAREN_TEST_PAUSE_AT=<stage> parks the installer at that stage.
pause_at() {
  [ "${QAREN_TEST_MODE:-}" = 1 ] && [ "${QAREN_TEST_PAUSE_AT:-}" = "$1" ] || return 0
  [ -n "${QAREN_TEST_PAUSE_FILE:-}" ] && : > "$QAREN_TEST_PAUSE_FILE"
  nolock sleep 30
}

# The kernel holds this lock while fd 9 is open and releases it when the installer exits,
# SIGKILL included. The lock file itself is never moved or deleted.
take_lock() {
  local lockfile="$RUNTIME_ROOT/.lock-$1" rc=0
  { [ -L "$lockfile" ] || { [ -e "$lockfile" ] && [ ! -f "$lockfile" ]; }; } \
    && refuse "unexpected install lock at $lockfile; inspect it and remove it if no install is running"
  exec 9>>"$lockfile"
  perl -MFcntl=:flock -e 'open(my $f, "<&=", 9) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' || rc=$?
  case "$rc" in
    0) ;;
    1) refuse "another qaren v$1 install is running; retry when it finishes" ;;
    *) refuse "could not take the install lock at $lockfile" ;;
  esac
}

# With this version's lock held every .staging-<version>.XXXXXX directory belongs to an install
# that has exited. Put back a runtime it had moved aside, then remove it; refuse and touch
# nothing whenever the state is not exactly what this script creates.
heal() {
  local version="$1" dest="$RUNTIME_ROOT/$1" staging
  for staging in "$RUNTIME_ROOT/.staging-$version".??????; do
    [ -e "$staging" ] || [ -L "$staging" ] || continue
    { [ -d "$staging" ] && [ ! -L "$staging" ] && [ -O "$staging" ]; } \
      || refuse "unexpected install state at $staging; inspect it and remove it if it is not needed"
    if [ -e "$staging/previous" ] || [ -L "$staging/previous" ]; then
      { [ -d "$staging/previous" ] && [ ! -L "$staging/previous" ] && [ -O "$staging/previous" ]; } \
        || refuse "unexpected install state at $staging/previous; inspect it and remove it if it is not needed"
      if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
        mv "$staging/previous" "$dest"
        echo "ensure-qaren: restored the qaren v$version runtime an interrupted install had moved aside" >&2
      fi
    fi
    rm -rf "$staging"
  done
}

install() {
  local asset version name sha bytes dest
  asset=$(expected_asset) || exit 1
  { read -r version; read -r name; read -r sha; read -r bytes; } <<< "$asset"
  [[ "${HOME:-}" == /?* ]] || refuse "HOME is not an absolute path"
  local root_rc=0
  make_root || root_rc=$?
  case "$root_rc" in
    0) ;;
    1) refuse "cannot use $RUNTIME_ROOT: it or a parent is a dangling link or not a directory" ;;
    *) refuse "the qaren runtime directory $RUNTIME_ROOT resolves to a directory you do not own, or inside one; point it at storage you own" ;;
  esac
  dest="$RUNTIME_ROOT/$version"
  INSTALLED_BIN="$dest/bin/qaren"
  # Leftover staging means a killed install to heal, even when the runtime itself is complete.
  has_staging "$version" || ! installed_bin "$version" "$sha" || return 0

  take_lock "$version"
  [ -L "$dest" ] && refuse "$dest is a symbolic link; inspect it and remove it before installing"
  heal "$version"
  installed_bin "$version" "$sha" && return 0

  STAGING=""
  DEST="$dest"
  # An interrupted replacement puts the previous runtime back before staging goes.
  trap '[ -n "$STAGING" ] && [ -e "$STAGING/previous" ] && [ ! -e "$DEST" ] && mv "$STAGING/previous" "$DEST"; [ -n "$STAGING" ] && rm -rf "$STAGING"' EXIT
  trap 'exit 130' INT TERM HUP
  STAGING=$(mktemp -d "$RUNTIME_ROOT/.staging-$version.XXXXXX")
  local tarball="$STAGING/$name" top="${name%.tar.gz}"

  pause_at download
  if [ -n "$FROM_FILE" ]; then
    cp "$FROM_FILE" "$tarball" || refuse "cannot read $FROM_FILE"
  else
    command -v curl >/dev/null 2>&1 || refuse "curl is required to download $name"
    # The shell opens the file, so a download stalled after its installer died can never create
    # anything later; only curl drops the lock, because only a network read can stall unbounded.
    # Each attempt reopens and truncates the file, so a retry never appends to a partial transfer.
    local attempt=1
    until nolock curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 "$RELEASES/v$version/$name" > "$tarball"; do
      [ "$attempt" -lt 3 ] || refuse "could not download $RELEASES/v$version/$name"
      attempt=$((attempt + 1))
    done
  fi

  pause_at verify
  local got
  got=$(exec 9>&-; wc -c < "$tarball" | tr -d ' ')
  [ "$got" = "$bytes" ] || refuse "$name is $got bytes, the manifest vouches for $bytes; nothing installed"
  got=$(exec 9>&-; shasum -a 256 "$tarball" | cut -d' ' -f1)
  [ "$got" = "$sha" ] || refuse "$name sha256 $got does not match the manifest $sha; nothing installed"
  # Bound the whole decompressed stream (headers and contents) before tar reads any of it,
  # stopping one byte past the ceiling.
  got=$(exec 9>&-; { gzip -dc "$tarball" 2>/dev/null || true; } | head -c $((MAX_UNPACKED_BYTES + 1)) | wc -c | tr -d ' ')
  [ "$got" -le "$MAX_UNPACKED_BYTES" ] \
    || refuse "$name would unpack to more than $MAX_UNPACKED_BYTES bytes, above the unpacked-size ceiling; nothing installed"
  # Exactly one gzip layer over a tar archive, checked before tar peels any layer itself: the first
  # header must be a checksummed ustar header named for this archive's top directory or a PAX
  # header, which no compressed stream can also be (each begins with its own magic).
  (exec 9>&-; { gzip -dc "$tarball" 2>/dev/null || true; } | head -c 512 | perl -e '
    read STDIN, my $b, 512;
    exit 1 unless length($b) == 512;
    my $start = substr($b, 0, 100);
    exit 1 unless index($start, "$ARGV[0]/") == 0 || index($start, "PaxHeader/") == 0
      || index($start, "./PaxHeaders") == 0;
    exit 1 unless substr($b, 257, 5) eq "ustar";
    (my $sum = substr($b, 148, 8)) =~ s/^ +|[\0 ]+$//g;
    exit 1 unless $sum =~ /^[0-7]+$/;
    my $total = 0;
    $total += ($_ >= 148 && $_ < 156) ? 32 : ord(substr($b, $_, 1)) for 0 .. 511;
    exit($total == oct($sum) ? 0 : 1);
  ' "$top") || refuse "$name is not one gzip layer over a tar archive; nothing installed"

  local entry entries=0
  while IFS= read -r entry; do
    entries=$((entries + 1))
    [ "$entries" -le "$MAX_ENTRIES" ] || refuse "$name carries more than $MAX_ENTRIES entries; nothing installed"
    case "$entry" in
      /* | .. | ../* | */.. | */../*) refuse "$name carries an unsafe path: $entry" ;;
      "$top" | "$top/" | "$top"/*) ;;
      *) refuse "$name carries an entry outside $top/: $entry" ;;
    esac
  done < <(exec 9>&-; tar -tzf "$tarball")
  # Each listed size is the logical size tar will write, sparse holes included. Owners are listed
  # numerically so no name can shift a column; any line outside these two shapes stops the install.
  local size logical=0 frame=0
  local bsd_line='^[-d][rwxsStT-]{9}[@+]?[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+([0-9]+)[[:space:]]'
  local gnu_line='^[-d][rwxsStT-]{9}[[:space:]]+[0-9]+/[0-9]+[[:space:]]+([0-9]+)[[:space:]]'
  while IFS= read -r entry; do
    case "$entry" in
      drwxr-xr-x* | -rwxr-xr-x* | -rw-r--r--*) ;;
      [-d]*) refuse "$name carries an entry with permissions the qaren build never writes: $entry" ;;
      *) refuse "$name carries a link or special file: $entry" ;;
    esac
    if [[ "$entry" =~ $bsd_line ]] || [[ "$entry" =~ $gnu_line ]]; then
      size="${BASH_REMATCH[1]}"
    else
      refuse "$name lists an entry this installer cannot read reliably: $entry"
    fi
    # Twelve digits keep every sum below bash's 64-bit limit; the ceiling check runs per entry.
    [ "${#size}" -le 12 ] || refuse "$name lists an entry size too large to be real: $entry"
    logical=$((logical + 10#$size))
    [ "$logical" -le "$MAX_UNPACKED_BYTES" ] \
      || refuse "$name would unpack to at least $logical bytes, above the unpacked-size ceiling; nothing installed"
    frame=$((frame + 512 + (10#$size + 511) / 512 * 512))
  done < <(exec 9>&-; tar --numeric-owner -tvzf "$tarball")
  frame=$((frame + 1024))
  [ "$got" = "$frame" ] || [ "$got" = $(((frame + 10239) / 10240 * 10240)) ] \
    || refuse "$name has an unsupported tar framing size; nothing installed"

  pause_at extract
  mkdir "$STAGING/x"
  tar -xzf "$tarball" -C "$STAGING/x" --no-same-owner
  got=$(exec 9>&-; du -sk "$STAGING/x" | cut -f1)
  [ $((got * 1024)) -le "$MAX_UNPACKED_BYTES" ] \
    || refuse "$name unpacked to $((got * 1024)) bytes on disk, above the unpacked-size ceiling; nothing installed"
  [ -z "$(exec 9>&-; find "$STAGING/x" ! -type f ! -type d -print -quit)" ] \
    || refuse "$name carries a link or special file; the runtime ships only files and directories"
  [ "$(exec 9>&-; ls -A "$STAGING/x")" = "$top" ] || refuse "$name does not unpack to exactly $top/"
  [ -f "$STAGING/x/$top/bin/qaren" ] && [ -x "$STAGING/x/$top/bin/qaren" ] || refuse "$name carries no executable bin/qaren"
  printf '%s\n' "$sha" > "$STAGING/x/$top/$RECORD"

  pause_at move1
  if [ -e "$dest" ]; then
    mv "$dest" "$STAGING/previous"
  fi
  pause_at move2-before
  mv "$STAGING/x/$top" "$dest"
  pause_at move2-after
  echo "$dest/bin/qaren"
}

# A link problem is a stderr notice, never a failed install.
link_on_path() {
  local bin="$1" dir="$HOME/.local/bin" target tmp candidate pass on_path=false
  local -a path_dirs
  IFS=: read -r -a path_dirs <<< "$PATH"
  # Prefer a standard user bin; otherwise any writable PATH entry keeps qaren invocable at once.
  for pass in standard any; do
    for candidate in "${path_dirs[@]}"; do
      # Empty and relative entries resolve against the caller's directory, not a stable bin.
      [[ "$candidate" == /* ]] && [ -d "$candidate" ] && [ -w "$candidate" ] || continue
      if [ "$pass" = standard ]; then
        case "$candidate" in
          "$HOME/.local/bin" | "$HOME/bin" | /opt/homebrew/bin | /usr/local/bin) ;;
          *) continue ;;
        esac
      fi
      dir="$candidate"
      on_path=true
      break 2
    done
  done
  target="$dir/qaren"
  mkdir -p "$dir" 2>/dev/null || { echo "qaren: cannot create $dir; run qaren as $bin" >&2; return 0; }
  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ ! -L "$target" ] || [[ "$(readlink "$target")" != "$RUNTIME_ROOT"/* ]]; then
      echo "qaren: $target already exists and is not a qaren install link; run qaren as $bin or replace that file yourself" >&2
      return 0
    fi
  fi
  tmp="$dir/.qaren-link.$$"
  # rename(2) swaps the link itself, even when the old one points at a directory.
  if ! { ln -s "$bin" "$tmp" && perl -e "rename(\$ARGV[0], \$ARGV[1]) or exit 1" "$tmp" "$target"; }; then
    rm -f "$tmp"
    echo "qaren: cannot link $target; run qaren as $bin" >&2
    return 0
  fi
  if [ "$on_path" = false ]; then
    echo "qaren: no writable directory is on PATH; add ~/.local/bin to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
  fi
}

case "$MODE" in
  --print-bin) print_bin || true ;;
  --install) install; link_on_path "$INSTALLED_BIN" ;;
esac
