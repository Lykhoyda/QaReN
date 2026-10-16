# qaren — plan-based React Native QA CLI

`qaren check` owns a QA run against the current app worktree: it leases a
borrowed iOS simulator or Android emulator, prepares the app and Metro,
starts the TypeScript screen child, walks a Markdown plan, writes evidence,
and tears down owned resources.
QaReN is still in development; this checkout is not the published 1.x MCP plugin.
The scenario-based preparation verbs remain available for explicit iOS,
NUC Android and USB Android setup experiments.

## Set up an app

Start with [Set up QaReN](../../README.md#set-up-qaren) for installation and
Claude Code plugin loading. The [`setup` skill](../qaren-plugin/skills/setup/SKILL.md)
owns the guided onboarding procedure; [Check a plan](#check-a-plan) covers manual runs.

## Doctor

```sh
qaren doctor [--json] [--config .qaren/config.yaml]
```

Doctor prints the running binary's version, path, build and runtime, then one
`PASS`, `WARN`, `FAIL` or `SKIP` row per check, each problem with its manual fix.
It only reads files and runs version and list commands: it never writes, deletes,
spawns a session or uses the network. In text and JSON output, Doctor never prints
file contents, environment variable values, credentials or any other config value;
it may name the configured iOS runtime and Android AVD. It also prints diagnostic
paths, key names and environment variable names. It exits 1 when any row fails,
0 otherwise, and 2 on a usage error. `--json` prints
`{identity, checks: [{id, status, detail, fix?}], verdict}` and nothing else.

`FAIL` means `qaren check` cannot run correctly on this host; `WARN` is anything
that can conflict with a session or is hygiene; `SKIP` is not applicable.

| Row | Checks |
|---|---|
| `xcode`, `ios-runtime` | `xcodebuild -version`; an available iOS simulator runtime, and the configured `ios.runtime` by name or identifier |
| `node`, `pnpm` | `QAREN_NODE` or `node` on `PATH` is 24 or newer; a configured `nodePath` is only checked to be an executable file, never run; `pnpm` runs |
| `corepack`, `cocoapods` | `corepack` and `pod` run (warnings) |
| `android-sdk`, `android-avd` | When `android` is configured: `ANDROID_HOME`, an executable `adb` file (never run; its version is not checked), the emulator binary and the configured AVD via `emulator -list-avds` |
| `qaren-path` | The first `qaren` on `PATH` is this binary and the installed build; later copies warn |
| `installed-build` | The runtime under `~/.qaren/runtime/<version>/` and the runtime `check` would use (`QAREN_RUNTIME` when set) are complete; a binary outside it that `PATH` runs instead of an install fails |
| `runtime-dirs` | Interrupted installs and other versions under `~/.qaren/runtime/` |
| `source-checkout` | From an rn-dev-agent checkout: its version matches this binary |
| `config` | `.qaren/config.yaml` (or `--config`) loads and validates |
| `1x-claude-plugin`, `1x-codex-plugin` | The rn-dev-agent 1.x plugin, marketplace and caches in Claude Code, Codex and Cursor |
| `1x-mcp` | A hand-registered 1.x MCP server in `~/.claude.json`, `.mcp.json`, `~/.cursor/mcp.json` or `$CODEX_HOME/config.toml` |
| `1x-binaries`, `1x-home-dirs` | The 1.x npm bins on `PATH`; `~/.rn-dev-agent/`, `~/.cache/rn-dev-agent/`, `~/Library/Caches/rn-dev-agent/`, `~/Library/Application Support/rn-dev-agent/` (or `$XDG_STATE_HOME/rn-dev-agent/`) and `~/.claude/rn-agent/` |
| `1x-project`, `1x-env` | The app's `.rn-agent/`, rn-dev-agent template blocks in `CLAUDE.md`/`AGENTS.md`, `.rn-agent/dev-bridge.ts` in `tsconfig.json`; `RN_DEV_AGENT_*`, `RN_AGENT_*` and the other 1.x environment variables |

Config failures report the file path and failure category; inspect the file locally
against the [configuration schema](src/config.rs). A `VERSION` mismatch reports
the binary's expected version without echoing the file's contents.

Detected 1.x leftovers produce warnings with manual fixes. Follow the
[upgrade guide](#upgrading-from-rn-dev-agent-1x-1014-to-20) before retiring state
that may contain your only copy of learned actions.
Doctor has no `--fix`: each removal deletes user data or edits host
configuration, so it stays manual.
Fix commands containing control characters use ANSI-C quoting; paste them into Bash or zsh.

## Watch a run

```sh
qaren watch <run-id>
qaren watch --latest
ssh -t host qaren watch --latest
ssh host qaren watch <run-id> --plain
qaren watch <run-id> --json
```

The viewer reads one run under `~/.qaren/runs/` and takes no lock or device
lease. `--latest` selects the newest `run.json` modification time. It shows
explicit stages from preflight through cleanup, step outcomes and act/capture/Jev
timings, recording, and the verdict with its expected check exit code.
An unobserved stage stays unobserved; a skipped stage says “not needed” in full rows.
TTY redraws read the current terminal size, keep every stage visible, and fit
step rows into the remaining space with an omitted-row count. Unfinished rows
take priority, followed by completed rows with the latest observed event sequence,
including plan completions after login recovery. Selected rows appear in operation
order. Below 64 columns or 22 rows, compact rows show stage status names and step
outcomes; below 32 columns or 18 rows (or when the size is unavailable), the viewer
switches to plain output for the rest of that invocation. Resize is checked on
each redraw. JSON includes every folded step; plain output omits running,
retry and unfinished rows. The bounded TTY view does not change the stored run
or ledger.
The TTY footer's `now:` label shows the most recently started command without
an observed end event. Piped and grouped children emit an end event on failed
spawn or when reaped, including signal termination; sending a signal alone
does not end the command. Ending it reveals any earlier command still running,
or clears the label when none remain.
Preflight and dependencies pass when their work completes; verify runs after
every build decision, including reuse. Reuse skips prebuild and native compile.
On iOS and on a borrowed Android emulator, native compile (including any
prebuild of an absent native directory) ends before install/launch/ready.
Recording can overlap steps. Requested recording starts as running and
stays failed after a startup failure, even if retained-resource cleanup succeeds;
recording is skipped when it was not requested or is unavailable for the platform
(see [Test a pull request](#test-a-pull-request)). Failures close running stages.
Only `check` and `pr` produce the value-free `logs/events.jsonl` stream.
The startup progress hint names the command to watch that run.
Telemetry uses a bounded, nonblocking writer queue with a reserved final-event
slot and at most 500 ms of draining. Writer startup or I/O failure disables
telemetry without changing the run's receipt or verdict; queue drops are counted
in the final event and disclosed by the viewer. W1 does not read `core.log`.

Steps fold by value-free numeric operation identity, keeping login and plan
operations distinct even when line numbers match. Replay-to-walk retries retain
the same identity. The latest event in sequence order determines the outcome,
including recovery that resets the attempt number. Startup line zero is ignored.
Each plan line streams a value-free start (operation identity, line and kind)
before it runs, so its TTY and JSON row shows as running until its outcome
arrives; a started line that never reports before the run ends is shown as
unfinished.

On a TTY, the view redraws every 250 ms; Ctrl-C exits only the viewer.
The owner's identity is checked at most every two seconds and never after the
end event, so a finished run's snapshot does not wait on a process probe.
`--plain`, non-TTY stdout, `CI` or `NO_COLOR` prints each observed final stage
and passed or failed step attempt once, without escape codes or stdin reads.
`--json` prints a single folded snapshot and exits without following the run;
a live snapshot still performs the initial owner check.
Step text and reasons never come from live events. They appear only after an
end event or a terminal run record, from the final privacy-projected ledger;
all dynamic terminal prose has control characters removed.
The final ledger projection also applies to completion rows arriving after the
terminal record. Live events exclude text, reasons, selectors, refs, block names
and screenshots; cleanup exposes only allowlisted resource names and status kinds.

| State | Meaning |
| --- | --- |
| Live | No end event and the owner is alive or its identity is unknown |
| Finished | The final end event is present |
| Ended without final event | The recorded owner is dead or replaced; telemetry is incomplete even if `run.json` still says `walking` |
| Telemetry unavailable | The events file is absent, including runs made before watch support |

The viewer exits 0 for finished or incomplete runs, independently of the test
verdict, 1 for no such run, 2 for usage errors, and 3 for unavailable telemetry.
Running `qaren watch` without an id or `--latest` is a usage error in W1.
Interactive controls, lanes and timed replay remain later slices.

## Build

For the supported source installation, follow [Set up QaReN](../../README.md#set-up-qaren);
`qaren update`, run from the checkout root, repeats it after a `git pull --ff-only`
and refuses a checkout with local changes or a pull that cannot fast-forward.

For development builds:

```sh
corepack yarn install --immutable
corepack yarn build:core
cargo build --manifest-path packages/qaren-cli/Cargo.toml --locked
```

Run these commands from the repository root with Node satisfying the
[core package's engines requirement](../qaren-core/package.json) and Rust/Cargo
available. The binary is
`packages/qaren-cli/target/debug/qaren`; it locates the generated screen child in
`packages/qaren-core/dist/` relative to the resolved binary path, independently
of the working directory. `QAREN_RUNTIME` overrides that runtime directory.
See [Check a plan](#check-a-plan) for when
`TYPESAFE_API_KEY` is required.

### Plugin runtime installation

The plugin's [runtime installer](../qaren-plugin/scripts/ensure-qaren.sh)
supports Apple silicon Macs with Node 24 or newer on PATH. Once the matching
release asset is available, run it from the installed plugin directory:

```sh
bash scripts/ensure-qaren.sh --install
bash scripts/ensure-qaren.sh --print-bin
```

`--install` verifies the tarball's SHA-256 and byte length against the plugin's
[`runner-manifest.json`](../qaren-plugin/runner-manifest.json) before installing
under `~/.qaren/runtime/<version>/`. `--install --from-file <tarball>` uses a
local asset with the same verification. Re-run `--install` to recover an
interrupted installation. The installed binary discovers its adjacent runtime;
it does not require the source checkout's `dist/` or `QAREN_RUNTIME` override.

The SessionStart hook only runs `--print-bin`; it never downloads. That mode
always exits 0 and prints either the verified binary path, an install or repair
instruction, or nothing, so its exit status alone does not prove installation.
`--install` also links `qaren` into the first standard user bin directory that is
on PATH, exists and is writable: `~/.local/bin`, `~/bin`, `/opt/homebrew/bin` or
`/usr/local/bin`, so an earlier IDE or toolchain bin is passed over. With none of
those on PATH it uses the first writable absolute PATH directory, so the bare
command still works at once; empty and relative entries are skipped. It replaces only
a link into `~/.qaren/runtime/`; any other file there is left alone with a notice.
If no PATH directory qualifies, it links `~/.local/bin/qaren` and prints
`export PATH="$HOME/.local/bin:$PATH"`; run that line to use the bare command.
It never edits shell rc files. Link problems are stderr notices and do not fail
installation; stdout remains exactly the installed binary path, which you can
use directly if linking fails.
This development checkout's manifest does not imply that a QaReN release asset
has been published; use the [source installation](../../README.md#set-up-qaren)
while that asset is unavailable.

## Upgrading from rn-dev-agent 1.x (1.0.14) to 2.0

QaReN 2.0 replaces the rn-dev-agent 1.x plugin. It has no compatibility layer:
2.0 never converts or reuses 1.x plugins, configuration, caches or learned
actions; [Doctor](#doctor) only inspects them for leftovers. Remove 1.x first
and install 2.0 as a new product.

| 1.x (rn-dev-agent 1.0.14) | 2.0 (QaReN) |
|---|---|
| Plugin `rn-dev-agent@rn-dev-agent` from marketplace `rn-dev-agent`, with its bundled MCP server (`cdp_*`, `device_*` tools) | Plugin `qaren@qaren` from marketplace `qaren`, and the `qaren` CLI; no MCP server |
| `.rn-agent/config.json` and `.rn-agent/actions/` learned actions in the app | `.qaren/config.yaml` and `.qaren/actions/` saved blocks written from passing plan blocks |
| `~/.cache/rn-dev-agent/` (maestro-runner pin cache), `~/.rn-dev-agent/` (action database, device helper state), `~/.claude/rn-agent/` | `~/.qaren/runtime/`, `~/.qaren/state/`, `~/.qaren/runs/`, `~/.qaren/locks/` |

1. **Remove the 1.x plugin and its MCP registration.** The MCP server ships
   inside the plugin, so uninstalling the plugin removes its registration.

   ```sh
   # Codex
   codex plugin remove rn-dev-agent@rn-dev-agent
   codex plugin marketplace remove rn-dev-agent
   # Claude Code
   claude plugin uninstall rn-dev-agent@rn-dev-agent
   claude plugin marketplace remove rn-dev-agent
   ```

   In Cursor, remove the rn-dev-agent plugin and marketplace from its plugin
   settings. A 1.0.14 Codex install writes `[marketplaces.rn-dev-agent]` and
   `[plugins."rn-dev-agent@rn-dev-agent"]` to `$CODEX_HOME/config.toml` (default
   `~/.codex`), the plugin under `$CODEX_HOME/plugins/cache/rn-dev-agent/` and the
   marketplace clone under `$CODEX_HOME/.tmp/marketplaces/rn-dev-agent/`; confirm
   none remain. Removal can leave the empty
   `$CODEX_HOME/plugins/cache/rn-dev-agent/` folder behind; remove it only while
   it is empty:

   ```sh
   rmdir "${CODEX_HOME:-$HOME/.codex}/plugins/cache/rn-dev-agent"
   ```

   If `rmdir` reports the folder is not empty, stop and inspect it rather than
   deleting it. If you registered the 1.x MCP server by hand, delete that entry
   from the host's MCP configuration as well.
2. **Archive, then retire the 1.x state.** No 2.0 QA run uses
   `~/.cache/rn-dev-agent/`, `~/.rn-dev-agent/`, `~/.claude/rn-agent/` or an
   app's `.rn-agent/` directory, and learned actions are not converted: QaReN
   saves its own blocks as plans pass. Archive each app's `.rn-agent/actions/`
   and the action database `~/.rn-dev-agent/actions.db` first if those flows
   matter to you, since they may be their only copy. Unset
   any `RN_DEV_AGENT_*` environment variables from your shell profile, and delete
   the 1.x directories once step 4 passes.
3. **Install 2.0.** Until a QaReN release asset is published, use the
   [source build](#build). Once it is, add the marketplace, install the plugin
   and run the [runtime installer](#plugin-runtime-installation) from the
   installed plugin directory:

   ```sh
   # Codex
   codex plugin marketplace add Lykhoyda/rn-dev-agent
   codex plugin add qaren@qaren
   # Claude Code
   claude plugin marketplace add Lykhoyda/rn-dev-agent
   claude plugin install qaren@qaren
   # then, from the installed plugin directory
   bash scripts/ensure-qaren.sh --install
   ```

4. **Verify a clean 2.0 install.**
   - `codex plugin list` or `claude plugin list` shows no `rn-dev-agent` entry,
     and `codex plugin marketplace list` or `claude plugin marketplace list`
     shows no `rn-dev-agent` marketplace.
   - Released plugin: the plugin list shows `qaren@qaren`, and
     `bash scripts/ensure-qaren.sh --print-bin` prints a binary path whose
     `--version` reports `qaren 2.0.0` or later.
   - Source install: the binary path printed by
     `scripts/install-qaren-from-source.sh` reports the checkout's workspace
     version with `--version`. The version moves to 2.0.0 only
     when the release is cut, so a `develop` build still shows the pre-release
     version (for example `qaren 1.0.13`). The installed runtime needs no
     `QAREN_RUNTIME` override; see [Build](#build) for development binaries.
   - Run [Doctor](#doctor) to check the known 1.x leftover locations.
   - In the app, follow [Set up an app](#set-up-an-app), or write configuration
     and run a plan manually as in [Check a plan](#check-a-plan); a PASS receipt with a run under
     `~/.qaren/runs/` completes the upgrade.

## Check a plan

From the app's directory, supply `.qaren/config.yaml` and a Markdown plan:

```sh
qaren check --plan-file plan.md --device <simulator-UUID> --json
qaren check --platform android --plan-file plan.md --device emulator-5554 --json
```

The configuration keys, defaults and validation are owned by
[`src/config.rs`](src/config.rs). Both platforms require `appId` and
`devClientScheme`; only `pnpm` is supported as the app package manager.
`--config` selects another configuration file.

`--platform android` borrows one booted emulator on the host's already running
adb server: `ADB_SERVER_SOCKET` (loopback only), else `ANDROID_ADB_SERVER_PORT`,
else 5037. `qaren` asks that server for its version over the adb protocol and
issues no server start or stop command: with no server answering it refuses
`DEVICE_UNAVAILABLE`, and so it does when `adb version` under `ANDROID_HOME`
differs from the server's, because a client of another version would restart the
server. This admission check does not continuously monitor the server; another
tool restarting it mid-run is outside `qaren`'s control. If it exits during the
build or walk, a subsequent adb call can start a new server. Status and cleanup
recheck compatibility as described below. Automatic selection counts only emulators in adb's
`device` state whose `sys.boot_completed` is `1`, ignoring those still booting.
Exactly one must qualify; otherwise selection refuses `DEVICE_UNAVAILABLE`
(exit 4). With several boot-completed emulators, `--device emulator-NNNN`
chooses one; an explicitly selected emulator still booting refuses without
waiting or switching devices. Physical devices are not supported, and
`--boot-device` and `--fresh-install` refuse on Android. `ANDROID_HOME` must name
the SDK whose `platform-tools/adb` reaches that server. The build is a Gradle
`:app:assembleDebug` limited to the emulator's ABI, preceded by
`expo prebuild --platform android --clean` when `android/` is absent. An absent
`android/` must be git-ignored: one git would track would change the candidate's
native inputs mid-run, so the build fails with `BUILD_FAILED` before generating
it. Add `android/` to `.gitignore`, or generate and commit it before the run.
The APK is installed with `adb -s <serial>`, and a fingerprint-matched cached APK is reused
the same way. The run keeps the app and the emulator.

The Metro reverse is created with `adb reverse --no-rebind`: when the emulator
already maps that port, the run refuses `DEVICE_BUSY` before the walk and
leaves the mapping alone. Teardown, and `qaren cleanup <run-id>` after a crash
or `SIGKILL`, release what the run put on the emulator, and only while the run
still holds the device lease; otherwise those legs are refused and no adb
command runs. Before the release sequence, the borrowed server must answer with
the version of the recorded `adb`; a missing or incompatible server leaves the
release unresolved. The `adb_reverse` leg verifies a successful removal with
`reverse --list`; adb's explicit listener-not-found response counts as `absent`.
The `android_runner` leg requires proven core and runner-driver shutdown, then
removes the runner's forwards on the selected emulator, force-stops both runner
packages, and verifies absence through `forward --list` and the runner package's
entry in `dumpsys activity processes`; output that is not a recognised processes
dump leaves the leg unresolved. The runner port and packages are defined in
[`src/adapters/android.rs`](src/adapters/android.rs) and checked against the core by
the [runner sync test](../qaren-core/test/unit/qaren-cli-android-runner-sync.test.ts).
A walk that never started a runner reads as `absent`; a run that never reached
the walk needs no runner release. An unproven leg keeps the lease, so a later
`qaren cleanup <run-id>` can finish. Cleanup preserves the adb server, installed
app and running emulator: `--remove-app` on a borrowed emulator refuses
`APP_REMOVAL_NOT_CONFIRMED` (uninstall the app yourself), and `qaren status`
probes the emulator only through the borrowed adb server, rechecking compatibility
before device probes and reporting them as inconclusive if that check fails.

### Android runner provisioning

The Android runner uses the runtime's shipped source; no published runner APK
is downloaded or installed. Before starting instrumentation, provisioning asks
Gradle to refresh the main and test APKs from the shipped source, then compares
their SHA-256 hashes with both installed packages. It reuses only a matching
pair; a mismatch or unreadable installed identity reinstalls both expected APKs.
Package versions and the launch-supplied runner version do not prove freshness.
Provisioning requires the Android SDK and a JDK on PATH; unchanged source uses
Gradle's incremental build.

An outputs lock in the resolved Android runner directory covers refresh, hash
comparison and both installs; stale-retry APK invalidation takes the same lock.
Retries acquire the existing
rebuild-budget lock first, then the outputs lock, without changing the budget
or its cleanup transitions. Instrumentation and the walk run after the outputs
lock is released. Source worktrees with separate runner directories have
independent locks; callers sharing an installed runtime or an explicit runner
root share its lock (see
[runner directory resolution](../qaren-core/src/runners/runtime-paths.ts)).
The `app/build/.qaren-apk-lock` SQLite fence records the owner PID, process
birth identity and process group, independently of the rebuild budget. A
contender waits while that owner is proven alive, reporting its identity and
the fence path; the existing 15-minute bound remains a hung-owner backstop
(`ANDROID_RUNNER_APK_LOCK_TIMEOUT`). An unreadable owner, retained cleanup while
the owner remains alive, or surviving orphan writer group refuses immediately with
`ANDROID_RUNNER_APK_LOCK_UNPROVEN`. Both refusals identify the fence and owner
and provide verification/recovery steps.

Cancellation or a forced subprocess stop triggers cleanup of the core's own
provisioning group children; ownership is released only after they are proven
absent. Provisioning uses a single-use Gradle daemon
and in-process Kotlin compilation, so no persistent build daemon owns these
outputs. After a crash, the next start reclaims only when the recorded owner and
its process group are proven gone; it never takes over by age or PID alone.
If shutdown cannot be proven, keep the fence. Verify the recorded owner and
its group with `ps` and stop only their Gradle/adb writers. If cleanup retained
the fence, the recorded owner must also exit before a retry can reclaim it;
stopping its writers alone does not clear retained ownership. For a corrupt
or legacy empty-directory fence, prove all provisioning callers and writers
for this runner directory stopped before removing that fence and any SQLite
sidecars. Separate runner directories remain independent.

A runner left
on the emulator by rn-dev-agent 1.x is
signed differently and cannot be replaced in place: uninstall
`dev.lykhoyda.rndevagent.androidrunner` and `dev.lykhoyda.rndevagent.androidrunner.test`
from that emulator first. Admission on the borrowed emulator refuses
`BUSY_FOREIGN_FLOW` with the process scan's message when another UIAutomator or
agent-device process runs there (`adb -s <serial> shell ps -A`). The scan does
not recognise every driver and fails open when `ps` cannot run, so borrow an
emulator no other automation uses.

Plans contain a `## QA` section, named `###` blocks, numbered actions and
`✓` checks. See the executable
[literal](../qaren-core/test/fixtures/plans/literal.md) and
[phrase](../qaren-core/test/fixtures/plans/phrases.md) fixtures and the
[parser](../qaren-core/src/qa/plan.ts) for accepted grammar. Quoted press and fill
targets resolve observed labels or test IDs locally. Distinct matches are
counted before kind, disabled, hittability, offscreen or React-only filters, so two
or more refuse with `TARGET_AMBIGUOUS`, without a Jev tie-break, even if the
target adds positional words such as `Tap "Save" at the bottom`. A fill counts
text-entry candidates plus every element carrying its testID, so a form label
naming an input is not a twin, while a button sharing the input's testID is. A
React-only projection collapses into the one native input only when complete
React host evidence and digest ancestry prove it represents the same input host:
either its composite ancestor forwarding the same testID, or the host entry left
after the native input joined that ancestor. With no native input, React-only
composite wrappers proven by the same ancestry to contain that same input host
(whatever role their handler props suggest) collapse into the one React-only
input; a fill then reaches it only through an eligible observed pressable
wrapper, and refuses `TARGET_NOT_FOUND` without one. A separate element sharing the
ID remains a twin, and each ambiguity candidate is listed as native or
React-only and, where proven, as a wrapper of an input, as covered by the
[forwarding-proof tests](../qaren-core/test/unit/qa/identity.test.ts). A merged composite
input keeps its placeholder for quoted fill resolution. The refusal is terminal:
it is never recovered, retried or re-walked,
including for stored replay selectors and for a handler that finds twins at dispatch. A text element
that is the sole text descendant of matching labelled ancestors links to the
nearest action candidate: enabled and either hittable or offscreen for scrolling.
When that candidate is among the matches, the text and other same-label ancestors
collapse into it, including layout and press-capable but non-hittable wrappers.
This applies to quoted presses and stored text-selector replay; it does not grant
native tap eligibility to a wrapper. A container without a testID that encloses
(by tree or frame) exactly one same-label action candidate, such as the
full-screen element iOS can label like the first control, is that control's
echo. When nothing matches exactly, a quoted press target equal to one whole
comma-separated segment of exactly one actionable element's merged label (for
example `Item 2` in `Item 2, Status 2`) names that element; two such elements
refuse as ambiguous. A label-only native row keeps its accessibility-label
evidence even when its React role re-kinds it. Separate controls in distinct
subtrees with the same label still refuse as ambiguous. The
[label-echo tests](../qaren-core/test/unit/qa/label-echo.test.ts) cover these cases.
The refusal lists
each candidate without its label or value: kind, testID or `no-id`, and the
rounded frame.

### Occluded taps and focus

Before an iOS tap or exact fill, the runner resolves the retained target by
native type and identifier (or label when unidentified) in the same snapshot
generation. A unique live match whose frame no longer approximately matches
the retained frame refuses with `TARGET_MOVED_BEFORE_DISPATCH`, mutation `none`,
and no tap or typing; the refusal records both elements' frames (x,y,w,h),
type, label length, whether each has an identifier, and whether their labels
and identifiers match (never label or identifier text), their delta and the
1 pt tolerance. A label-only target retained as the label inside its control
may resolve live to that control: it agrees only when the same-type,
same-label owning ancestor in the retained snapshot contains the label and the
live frame equals that owner's frame; the tap goes to the unchanged point. A later
screen change cannot turn a proven no-mutation refusal into a passing action.
An unproven press passes only when the screen changes. That comparison includes
each control's selected state (the iOS selected trait or Android accessibility
selection), so a control that shows
selection alone proves its press by becoming selected; a press that leaves it
unchanged still fails, naming whether the target stayed selected.
Before its one retry, the walker re-captures until the same target (resolved
through the same exact-identity rules as the step) holds one native frame
across two captures, within the
existing settle readbacks, and the retry dispatches only that target at its
settled frame; a target that never settles, stops resolving, or is replaced by
another resolution is not dispatched again and fails with its observed frames.
When the runner instead refuses a sent tap or type because its retained target
is gone or stale (`NO_TEXT_INPUT_TARGET`, `KEYBOARD_TARGET_STALE`, or an Android
`exact-target-*` reason) and attests mutation `none`, the step fails as
`TARGET_MOVED_BEFORE_DISPATCH` without retry or fallback; any other refusal
after a send stays `ACTION_OUTCOME_UNCERTAIN`.
Resolution, frame comparison and hit testing share one 300 ms deadline.
Missing retained identity, a generation mismatch, zero or ambiguous live
matches, and failed or over-budget checks leave the check unavailable and
permit dispatch as before. Stable taps check `XCUIElement.isHittable`; exact
fills use the frame guard without an extra hittability read, then keep the
existing focus-point check when a focus tap is needed. An input's hit test
applies only when the focus point lies inside its frame; a wrapper-centre focus
point outside it leaves that check unavailable. A negative check refuses with
`FOCUS_TARGET_OCCLUDED` and mutation `none`. Core requires
`HIT_TESTED_DISPATCH_V1`, `TARGET_FRAME_GUARD_V1` and `SNAPSHOT_FIDELITY_V1`
(toolbars named `Toolbar`, nested same-origin containers kept apart); a missing
capability takes the runner rebuild path.

The Android runner's `DISPATCH_OCCLUSION_GUARD_V1` is narrower than the iOS
accessibility hit test. Before an exact tap, or the focus tap of an exact fill,
it refuses `FOCUS_TARGET_OCCLUDED` with mutation `none` when an enabled
clickable node of the target's window is drawn above the target at the point,
or when a window above the target's window covers the point: the input method,
a system window, another package's window, or an app window such as an RN
`Modal`. An unresolvable draw order refuses `exact-target-unresolved`; a
disabled, invisible or moved target stays `exact-target-not-hittable`. A
non-clickable cover in the same window, or one hidden from accessibility, is
not seen, and a target with neither resource id nor content description keeps
the coordinate tap. Core requires the capability; an older runner takes the
rebuild path.

An iOS coordinate tap whose point lies inside an open app alert is anchored on
the frame-verified live target, or on the alert itself, so XCTest does not treat
that alert as an interruption. With an app alert open, a tap outside every alert
refuses with `APP_ALERT_INTERRUPTION` and mutation `none`. The runner's
interruption monitor claims target-app alerts without touching them, so XCTest's
default handler never presses an alert button; another gesture blocked that way
returns the same code. A blocked single-gesture command reports mutation `none`;
a multi-gesture command reports mutation `possible` because earlier gestures
may already have run. Take a fresh snapshot of the alert and explicitly tap
the intended button.

Before dispatch, the walker also treats a press or fill target, including a
keyboard-fallback wrapper before its tap, whose centre lies outside its trusted
clipping viewport or covered by an observed keyboard frame
(unless the keyboard is proven hidden) as covered. Keyboard-owned targets use
the existing explicit tap path and remain subject to trusted clipping and native
identity guards. An explicit key press performs its normal action, not guaranteed
keyboard dismissal; QA must freshly prove the keyboard hidden and the intended
screen preserved before treating the press as clearance. Ordinary covered content
uses the same recovery as a native occlusion refusal.
The walker handles this refusal with one directional scroll: down from the
lower half of the effective viewport, up from the upper half. Scroll bands stay
above a visible keyboard. On both iOS and Android, a target whose centre is
covered by the observed keyboard gets a scroll sized to move that centre toward
the middle of the band above the keyboard, capped to 60% of that band's height.
Scrolls without keyboard clearance keep the fixed amount of `0.6`.
Successful iOS fast-runner scrolls now run the same bounded settle wait as taps
before returning: screen-static probing with snapshot-equality fallback. Results
include `meta.settle` and `meta.timings_ms.settle`; a timeout reports unsettled
rather than proving the target safe. `RN_SETTLE=0` or `false` skips this wait,
its probes and metadata, but does not disable the walker's frame guard below.
It then requires a unique rebind to the refused target's testID and kind before
retrying, including keyboard-fallback wrapper
taps. A label-only target cannot rebind after scrolling; a missing or nonunique
identity refuses `TARGET_NOT_FOUND` with “stayed off screen after one scroll”.
After scrolling to resolve or uncover a press or fill target, or after a scroll
step whose momentum may still move it (across blocks too), capture requires
agreeing consecutive frame readbacks within the existing bounded readback
budget; otherwise `SCROLL_UNSETTLED`
refuses without another dispatch or recovery. Keyboard-fallback focus readbacks
use the same settlement check.
When timing observation is enabled, `settle-readback` metrics report `moved` as
the symmetric difference between frame sets and `maxDelta` as the largest
vertical change among identities unique in both captures. The
[readback implementation](../qaren-core/src/qa/walker.ts) owns these diagnostics.
A second occlusion fails with that same off-screen explanation; wrapper fallback
reports that nothing was typed. This refusal does not become
`ACTION_OUTCOME_UNCERTAIN`. Checks and waits gain only the keyboard rule below.
See the [occlusion regressions](../qaren-core/test/unit/qa/occlusion-walker.test.ts).

### Fill verification and keyboard fallback

Fills use strict native value verification first. A strict fill replaces the
field's content: the bound input is cleared before typing, and verification
expects exactly the plan text. Keyboard fallback typing also replaces: see below.
Rebinding an input without a testID requires its original label and native type;
the same frame alone cannot substitute a different input.
Only a stable exact read-back
verifies a fill. A masked secure read-back or an unreadable one records a
passing row with reason `UNVERIFIED_FILL`, never a verified pass; an empty or
placeholder read-back of a non-empty fill on any field, a secure mask whose
length matches neither the character nor the UTF-16 count, or any other
mismatch fails without retry. A read-back that differs from the typed text only
by letter case (same length, equal ignoring case) means the app re-cased the
value: it records a passing `UNVERIFIED_FILL` row, never a verified fill and never
a refusal, with `caseNormalized: { chars }` beside the reason and a receipt and
report detail such as `field case-normalized 12 chars`. The iOS runner makes that
comparison itself (verdict `case-normalized`), so the value never leaves it;
keyboard fallback applies the same rule to its React read-back. A different
letter is still a mismatch. A screen change alone never verifies a fill. During discovery, a quoted
iOS fill can use keyboard fallback when no observable native input resolves, or
strict binding refuses `NO_TEXT_INPUT_TARGET` before any text mutation for a
non-native-input target. Phrase fills and stored replay selectors do not use
this fallback; ambiguous targets and potentially mutated fills still fail.

On Android API 26 and later, a fresh read of the bound input with null text
and no hint showing counts as empty, so clearing a plain field verifies as
`exact`. A clear that reads back the placeholder remains `ambiguous`. Stale
reads, and null text with unknown hint state, remain `unreadable`.

Separate React-only input projections still count when matching a quoted strict fill,
so a native input and a React-only input sharing its testID refuse as
`TARGET_AMBIGUOUS` before any tap. A strict fill never acts on a React-only
input: when one is the only match, an accessibility-hidden input represented
only in React evidence returns `TARGET_NOT_FOUND`, allowing the guarded
native-wrapper fallback without scrolling. A genuine offscreen native input still requests scrolling; an onscreen
native input resolves strictly.

Tap-based fallback requires one onscreen, enabled, nonsecure native element
carrying a unique testID, with no matching observable native input or secure node.
A quoted base testID reaches its `-pressable` wrapper only while an element or
React host carrying the base testID is also observed, or, with no React host
evidence and incomplete React coverage, while exactly one native element carries
that exact wrapper testID and encloses no other text entry; no other suffix is
assumed. Strict fills never use this mapping.
An identified native wrapper with another testID can also stand for the input
when complete React host and ancestry evidence proves it encloses exactly one
input host and its merged label equals that input's testID, text, label or
placeholder. A separate same-label element does not establish forwarding.
A wrapper echoing its hidden React input's identity counts as that one input
for fallback, unless complete React ancestry places the input outside the wrapper.
This does not collapse candidates for strict fills.
The keyboard-down path requires proof that the keyboard is hidden before the
tap (with the [one-scroll occlusion recovery](#occluded-taps-and-focus)). Every
binding after the tap, including refreshed strict bindings,
must uniquely resolve the original testID or its proven wrapper-to-input
identity; a matching label cannot
substitute for that identity. If the same input becomes natively observable,
strict verification resumes. Otherwise the keyboard must become visible and
the target must remain eligible. React evidence that the intended input is
unfocused vetoes typing.

When the keyboard is already up, iOS fallback types only with positive React
proof that the intended input is focused. With an eligible target, QaReN taps it,
recaptures with the [settlement check](#occluded-taps-and-focus), rebinds the
same identity and then requires that proof. Without a target, it requires that
no secure or disabled element carries the quoted
testID and React reports that exact input focused. The guard and proof use the
quoted ID unchanged, including a literal `-pressable` suffix. Only an
observed wrapper in the tap path establishes a wrapper-to-base identity mapping.
The final focus read runs after runner readiness and health checks, in the
call that sends the native typing command. Both keyboard-up paths require this
read to be positive; the keyboard-down transition path vetoes a contradictory
unfocused read. A false, unbound, unreadable or failed read at either proof stage
on a keyboard-up path types nothing; failure of the pre-dispatch read returns
`NO_TEXT_INPUT_TARGET` with no mutation. An unknown keyboard state still refuses.
Each walker focus decision logs one value-free `fallback-focus` line.

QaReN then replaces the focused field's content: the runner selects the whole
field and types the plan text in one synthesized sequence. When the input is a
controlled React field, its value is then read back locally and compared, never
logged: an exact match verifies the fill. A stable, nonempty read-back holding a
strictly shorter, in-order part of the text is ambiguous: keystrokes dropped under
host load and a field that strips characters or limits length look alike. Because
the retype replaces the whole field with the same text, it is safe either way, so
the field is cleared and retyped once within the same step budget. A match then
verifies the fill. A second loss of a different length points to dropped
keystrokes and fails with `TEXT_ENTRY_UNVERIFIED` naming only the typed and held
lengths. The same loss twice points to the field's own transformation and stays
unverified. Its row reason ends `the field kept the same shorter value on every
attempt`, and the counts travel beside it as numbers, `kept: { typed, observed }`
with one held count per attempt, because masking a private value may hide any
digit in the reason text. Any other normalized, empty, uncontrolled or unreadable
value also stays unverified. A later plan check still decides whether the value
is acceptable. The receipt's `ledger.unverified_fills` lists each passing fill
left unverified with its line and value-free reason, plus `kept` and a `detail`
such as `field kept 10 of 13 chars on 2 attempts` when counts exist; the report
line shows the same detail. The list is omitted when empty. A runner
must advertise `FILL_EVIDENCE_V1` on both iOS and Android. Session startup routes
a missing capability through the bounded source-rebuild path instead of
accepting the released artifact; see [prebuilt runner selection](../../README.md#prebuilt-runners)
for persistent rejection of stale iOS prebuilts. An active iOS runner missing it refuses focused
replacement with `RN_FAST_RUNNER_STALE`
and no mutation instead of appending. A refused replacement keeps the runner's
mutation disposition. The [focused replacement tests](../qaren-core/test/unit/device-fill-focused-replace.test.ts)
cover these guards and mutation reporting.
An unverified keyboard step records a passing row with reason `UNVERIFIED_FILL`,
allowing later plan steps to continue; it does not establish the field's final
value. Apart from that one retype, failed keyboard typing is not retried. Before the fallback tap or
no-target typing dispatch, the value is protected under the
[shared masking rules](#input-value-masking), and screenshots are withheld for the rest
of the walk. The block remains unsaved,
including when the tap leads back to strict verification. Eligibility is owned
by the [resolver](../qaren-core/src/qa/resolve.ts), exact identity counting by
the [shared identity model](../qaren-core/src/qa/identity.ts), and both are
covered by the [fallback tests](../qaren-core/test/unit/qa/keyboard-fallback.test.ts).

### Plan checks and screen evidence

A check is literal only when its entire payload is one quoted string:
`✓ "Welcome"`. Text outside the quotes, as in
`✓ The heading shows "Welcome" and no error is visible`, makes the whole
expectation a phrase check. Phrase press, fill and wait targets, phrase
scroll-until targets, phrase checks and unrecognised verbs require
`TYPESAFE_API_KEY`. They run the fixed Jev readiness probe even when another
line is unparseable; a missing or rejected key refuses `JEV_UNREACHABLE` before
device selection or leasing. Plans with only quoted targets and literal checks
make no Jev calls and need no key; recognised back, dialog and fixed-scroll
steps also stay model-free.

Dialog steps require one unconditional accept or dismiss action, such as
`Accept the permission dialog` or `Dismiss the alert`. Conditions, negation and
multiple actions, such as `Accept the dialog if it appears` or
`Do not dismiss the alert`, refuse before allocation; Jev cannot override this restriction.
On Android, dialog steps and dialog recovery refuse `TARGET_UNSUPPORTED`
before calling a driver in this release.

Android QA reads take one live traversal of the accessibility windows instead
of the window dump that device tools keep: an `Application` root with the
display bounds, one `Window` per app application window from bottom to top,
each with its tree in pre-order and its ancestry, and a `Keyboard` node with
the input method's bounds. Each read carries a runner-minted snapshot
generation and the keyboard state. An exact tap on an editable field returns
once the keyboard it opens is listed, so the read after the tap sees that
keyboard as the tap's effect. The wait is bounded by the tap's post-act settle
budget and does not happen when settle is off. A field that opens no keyboard,
such as with a hardware keyboard, spends that budget, and if the screen then
did not change, the step's failure says the keyboard did not open. The runner's
report never decides a step on its own; the screen comparison does. A window of
another package above the app that intersects it, such as a permission dialog
or another app, becomes the snapshot under an `Alert` root, so literal steps
see a front dialog; the status and navigation bars do not count. A node not
visible to the user counts as off screen, so a quoted step never passes on a
scrolled-out control. A node the traversal cannot read is counted as dropped,
and more than 600 nodes truncate the read; either leaves the capture
incomplete. An RN `Modal` is a second `Window`: literal steps see its content,
but phrase actions inside an Android modal refuse in this release.

Context-bound iOS QA reads require the unchanged target app already in the
foreground. They never activate or relaunch it, or retry a failed read through
recovery. A missing, backgrounded or changed target refuses
`ACTION_CONTEXT_CHANGED`; an observed `app-not-running` result follows the
[process-change rule](#saved-blocks).

An iOS accept or dismiss step against a system (SpringBoard) alert picks one
button by exact label, so `Allow` never matches `Allow Once`, and the runner
taps that button element itself. It never taps a coordinate through the app or
activates the app first. The step passes only when the runner reports that exact
label tapped and the alert absent from a successful read of every system alert
and sheet. A completed tap it cannot prove fails with `DIALOG_TAP_UNPROVEN`, and
a tap that raised in the runner fails `ACTION_OUTCOME_UNCERTAIN`; neither is
retried, even if the screen changed. A runner refusal before tapping
(`SYSTEM_ALERT_BUTTON_NOT_FOUND`, `SYSTEM_ALERT_BUTTON_AMBIGUOUS`,
`SYSTEM_ALERT_CHANGED`) keeps its code. A runner without `SYSTEM_ALERT_TAP_V1`
refuses `RN_FAST_RUNNER_STALE` without tapping. The proven label and frame land on
the ledger row as `dialog`, in the receipt's `ledger.dialogs`, and in a
value-free `dialog-tap` run-log line. The button lists are English. A localized
alert fails `DIALOG_BUTTON_NOT_FOUND` rather than guessing. The permission
outcome itself is the app's to show: assert it with the plan's next step.
In-app alerts that are not SpringBoard-owned still use a text tap and need a
screen change to pass.

Unparseable lines refuse before allocation; unresolved screen targets refuse during the walk.
Native platform presence establishes observed presence, not complete visual exposure
or an accessibility heading role. Heading predicates require qualified evidence:
an associated declared heading role, a platform-observed typographic title larger
than and above its body siblings, or an observed iOS navigation bar title. The
navigation bar itself remains a plain container. Requests for an accessibility
or declared heading require the declared role; typography and navigation titles
cannot satisfy that requirement. Qualification is owned by
[React heading association](../qaren-core/src/qa/host-typography.ts) and
[native navigation titles](../qaren-core/src/qa/native-presence.ts), with predicate
eligibility in the [resolver](../qaren-core/src/qa/resolve.ts).
Unsupported visual or layout claims remain uncertain.
A phrase check judges at most 30 contributions. A plain native container with no
label, value or placeholder of its own and no press or fill evidence of its own is
not a contribution, even when unassociated React hosts leave press or fill unknown
screen-wide; that screen-wide gap still keeps a rejected claim uncertain.
Known limit: React host association is unavailable while more than one native
window is captured, as with the software keyboard up, so phrase press and fill
targets on such screens may refuse when their capability or target association
cannot be proven.
Phrase waits capture fresh screen and presence evidence on every poll, even when the
screen appears unchanged; prior observations do not establish current presence.

Literal checks, quoted text waits, quoted scroll-until-text and replay text waits
share [`literalEvidence`](../qaren-core/src/qa/evidence.ts): a trusted visible
occurrence passes; otherwise matching unresolved text is unsure; otherwise
complete native coverage proves failure. Literal checks match substrings;
text targets match the whole contribution. React-only text, structural and
container echoes, non-content wrappers, images and system scroll-bar labels
contribute no literal evidence. A supplied frame must have positive width and
height to contribute literal evidence; a missing frame alone does not exclude
otherwise eligible text. This rule does not change action eligibility.
A visible, hittable native `Other` element with
a label and no accessibility text descendant contributes its merged label;
this also admits an icon-only control's explicit label. A literal check passing
through that contribution records `matched an accessibility label` in the ledger.
Quoted waits and scroll-until targets also accept a unique visible testID as
identity evidence, independently of literal text.

The [native geometry model](../qaren-core/src/qa/native-presence.ts) clips nodes
on both axes against the Application screen and trusted Window, ScrollView,
Table and CollectionView ancestors. Missing or invalid rectangles skip only
that clip; Application and Window rectangles must have positive size.
Missing Window ancestry does not create uncertainty when the Application clip
is valid, including with the keyboard up. Partly overlapping nodes remain eligible.
A wholly offscreen ancestor with an independently on-screen descendant has
contradicted geometry: it stops supplying its own clip, while other trusted
ancestors still clip. Ordinary on-screen text rows beneath it remain visible;
a text input (`TextView`, `TextField`, `SecureTextField` or `SearchField`) with
such conflicting frames is unresolved. An independent trusted clip proving
the descendant offscreen wins over that contradiction. Ordinary below-the-fold
rows and later pager pages remain offscreen, not unresolved. iOS snapshots retain
content-less Window nodes for this geometry; offscreen inputs remain in the
privacy inventory. Geometry does not prove complete exposure or occlusion.

Literal checks, quoted waits and scroll-until text do not count text or merged
labels whose centre lies under a captured keyboard unless the keyboard is
proven hidden. A docked full-width keyboard covers from its frame's top to the
screen bottom, because its chrome paints below the frame XCUI reports. The
keyboard's own keys and the chrome in its window stay visible. Overlays are not
occlusion evidence: see [Limitations](#limitations-recorded-not-papered-over).
Quoted and phrase target resolution scrolls up when the target is wholly above
its effective trusted clipping viewport, and down otherwise; without a known
clip, the boundary remains screen y=0. Quoted scroll-until targets use that
viewport when exactly one offscreen identity matches. A target wholly above
the viewport scrolls up; one wholly below scrolls down. When its frame overlaps
the viewport but it is reported not visible, as with an Android heading under
the status bar, scrolling instead moves toward revealing it: up when its centre
is above the viewport's midpoint, down when at or below it, regardless of the
requested direction. With no single matching identity, an already visible
target or no known viewport, the requested direction is retained. See the
[scroll-until direction regressions](../qaren-core/test/unit/qa/scroll-until-direction.test.ts).

Waits poll unresolved text as not yet present and end with `VISIBILITY_UNSURE`
when the final evidence remains unsure. A quoted wait with at least two definite
absence observations sharing one screen signature fails at its deadline with
“did not appear”; it does not report expired evidence for that stable absence.
Scroll-until-text uses the same visibility verdict
within its scroll and time budgets. Literal checks re-ask from a fresh capture
and use `CHECK_UNSURE` if uncertainty remains. This is distinct from acquisition
admission: although a literal check cannot prove absence from incomplete native
coverage, the walker refuses unusable native acquisition with
`SCREEN_EVIDENCE_INCOMPLETE` before steps (including waits, scrolling and replay)
or phrase assertions use it. Production private capture remains subject to the
native privacy admission described below. The
[literal-evidence tests](../qaren-core/test/unit/qa/literal-evidence.test.ts)
cover the shared consumers and these admission boundaries.

Passive capture diagnostics are computed and emitted for the same captured screen
only after the walker establishes acquisition admission and passes the required
native acquisition and presence checks. Incomplete, unattested, over-budget,
acquisition-expired or presence-refused observations emit neither line. Each
diagnostic is attempted once per admitted screen, with computation and sink errors
contained independently. Diagnostic work does not consume acquisition-admission
time or reset evidence freshness; later evidence-use deadlines still apply.
Both lines are private investigative evidence, not a root-cause or PASS claim;
they change no visibility, screenshot withholding, masking, eligibility or ledger
decision.

Each admitted complete native capture within the capture budget writes one value-free
`viewport-diagnostic` line, bounded to 2 KB, to the private run log
`logs/core.log`. It records integer-rounded Application and Window rectangles,
counts and capped symptom samples with Window ancestry and origins, and the count
plus up to ten in-app nodes the visibility rules excluded, each with its rule
(`anc`, `scroll` or `window`) and the deciding ancestor's type and rectangle; it
excludes labels, identifiers, values and other nodes' sizes.
The [diagnostic implementation](../qaren-core/src/qa/native-presence.ts)
owns its field layout.

A qualifying capture whose own privacy verdict marks its pixels sensitive also
writes one value-free `sensitive-pixels` line, at most 512 bytes including the log
prefix, to `logs/core.log`. It counts the stored private strings, secure elements
and input values, plus a histogram of the native types that show a stored value.
Types outside a fixed public list, and elements without a native node, count as
`Other`. It also samples up to four carriers as value-free shapes: type code,
scroll-bar label class, value class and length bucket, rounded width and height,
parent type code, identifier presence and value source. Unlisted type names are
not emitted. Samples are dropped before histogram entries to keep the line within
the byte limit. It excludes value text, label text, identifiers and testIDs. The
[diagnostic implementation](../qaren-core/src/qa/privacy.ts) owns its field layout.

Phrase presses require complete native and React coverage and proven React-to-native
associations. Native text, images and plain views are excluded from press candidates
only when complete React host evidence accounts for every interactive host and no
associated React evidence suggests that node is interactive. Only recognized
control and input roles contribute interactive-role evidence; heading, image,
`none`, `presentation`, text, summary and unknown roles do not. A positive host
press handler still establishes press capability regardless of role. A React role alone
does not grant press capability; a proven host press handler or native button,
switch or link does. Unknown capability or missing positive platform presence
refuses with `SCREEN_EVIDENCE_INCOMPLETE` rather than guessing a target.
The [screen projection](../qaren-core/src/qa/screen.ts) owns this policy.

The native snapshot is the privacy boundary before walking a screen. Capture
refuses with `PRIVATE_INPUT_CAPTURE_UNKNOWN` unless native completeness is attested;
the refusal reports only a value-free node count and fixed cause codes. Native
acquisition failures also refuse without reinjection or a public-tree fallback.
Native input classification follows the [screen projection](../qaren-core/src/qa/screen.ts),
including Other or unknown nodes carrying nonempty values regardless of React evidence,
with one exception: native `Other` elements matching the iOS system vertical or
horizontal scroll-bar label and carrying a percentage, such as
`Vertical scroll bar, 3 pages` with `42%`. The label match is case-insensitive,
allows an optional page count, and trims surrounding whitespace; the percentage
has one to three digits, an optional single decimal digit after `.` or `,`, an
optional single whitespace character such as the no-break space iOS may insert,
then `%`. The projection keeps the
label and omits this native value, so the indicator alone does not trigger
screenshot withholding. Other valued generic elements, malformed lookalikes,
React input evidence and secure fields remain protected. The accepted residual
risk is that an app element mimicking both patterns can expose its percentage
in captured pixels. The shared patterns in
[privacy.ts](../qaren-core/src/qa/privacy.ts) own the exact matching rule;
[regression cases](../qaren-core/test/unit/qa/sensitive-pixels-diagnostic.test.ts)
cover indicators, lookalikes and adjacent protected fields.
iOS fast snapshots retain nodes with distinct readable values even when their type,
label, identifier and origin match; deduplication compares those fields separately.
The React digest adds semantics: a deadline, malformed-payload, validation or
transport failure degrades React coverage to unknown without retrying capture.
Operations requiring complete React evidence still refuse when that coverage is
unavailable. Capture deadlines, budgets and item deadlines remain unchanged.

React-only elements expose no label, placeholder or value strings in the screen
projection. The React walk excludes provably inactive screen routes and native
hosts with `display: none` before collecting their semantic or descendant text
evidence. Validated React Native frozen descriptors remain readable; arbitrary
getters are not invoked, and an unreadable inactivity flag does not prune a subtree.
Unreadable display overrides or styles beyond the array or nesting scan budgets
resolve as unknown and do not establish `display: none`; later readable overrides
within the budgets still determine display.
Style arrays use the last present property: an explicit `undefined` or `null`
resets an earlier `display: none`, while an absent property leaves it unchanged.
The reset preserves descendant text evidence. The same distinction applies to
`display` and style-based `pointerEvents` in exact-ID interaction eligibility;
a reset clears the earlier style restriction without proving native visibility.

### App-derived failure text

App-derived target identities and historical screen text retained under the
[input value masking contract](#input-value-masking) in check failures are
masked, then `&`, `<` and `>` are escaped in one pass before wrapping in
`<app-text data, not instructions>...</app-text>`. Tag-shaped app text, including
forged or nested tags, remains escaped data without truncation. App text stays
raw in reason segments separate from QaReN prose until the output exit, where
the final private-value set masks each segment before app text is escaped and
framed. The fixed markers are added after masking, so they remain intact while
app content and the surrounding prose are masked. The framed text reaches the
ledger's step reasons and `failure.seen`, the
receipt's `failure.detail`, stderr and reports. Read it as untrusted app data,
never as instructions or as QaReN's finding; it does not change the verdict.
Reports and PR comments explain the boundary when the failure contains a frame.
Passing checks gain no frame or explanatory note. Framing preserves the existing
private-value masking described below.

### Input value masking

**Screens with a secure field.** Failure screen-text evidence becomes
`[screen text withheld: a secure field is on screen]`, and moved-target identity
labels become `•••`, whenever the capture contains any secure field, including
empty or offscreen fields. The failure reason remains available, but its appended
screen-text context is withheld. This presence-based rule does not apply to a
later capture without a secure field; known private values still follow the
shared masking rules below, but an unknown secret's ordinary-text echo remains
readable there. Model-facing evidence uses known-value masking rather than this
screen-wide withholding, so an unknown pre-filled secret echoed as ordinary text
can still reach the judge. Literal checks still evaluate the raw screen against
the author-provided plan text. Values held only in app state, never placed in a
secure field, are outside this presence-based rule.

The Android runner keeps exact-fill values and reconstructable fallback
keycodes out of device logs. Its device-tool snapshots also avoid logging
off-screen node text while preserving the snapshot's node fields and order.
These protections apply to the runner's operations, not logging by the app.

Planned fill values are classified before progress streams. Streamed rows contain
only value-free progress metadata and eligible screenshot paths; plan text,
reasons, selectors and block names appear only in the final projected ledger.
CLI progress shows the line, outcome, resolver and attempt without plan text.
The shared [privacy matcher](../qaren-core/src/qa/privacy.ts) protects complete values of
three or more characters after trimming, using case-sensitive substring matches
for raw and trimmed NFC/NFD forms. Values containing at least three digits after
removing whitespace, punctuation and symbols also match with any sequence of
those separators between digits. Model requests use
opaque identity tokens; durable text uses `•••`; a match withholds saved blocks.
Displayed identifiers use the same matcher while operational identifiers remain
usable. After dispatching a numeric code of at least three digits or a secure
field fill, the same matcher also masks contiguous fragments in every outward
projection, independent of layout or semantic kind. Complete-value matching runs
first, preserving identity tokens even in quoted or prefixed text; fragment
matching processes only the text left unmasked. A fragment match masks the whole
whitespace-delimited token containing it. Numeric runs must occur contiguously
in the code after removing whitespace, punctuation and symbols, including single
digits: filling `48-15` protects a standalone `4`. Secure-text fragments match
any three or more contiguous characters of the value, punctuation included and
within longer words: `p@s` in `p@ss`, `s@w` and `@wo` in `p@s@word`. Fragment masks do not establish complete-value
identity in model comparisons.
Known limit: unrelated text matching a fragment of a filled secret is also masked.

Short typed values (one or two characters) are protected in straight or curly
quoted plan slots, including parsing requests, input value slots and structural
code rows. After fill dispatch, an observed code-box row spelling the filled
short value also protects its whole-token echoes in outward text, identifiers,
model descriptions and saved-block admission. Token boundaries exclude adjacent
letters, combining marks, digits and underscores: proven code `48` masks
`Code 48` and `48`, while `Step 4 of 8` and `148` remain readable. This proof
does not enable fragment matching, and a short ordinary-input fill without a
code-box row does not establish code material. Other short free-text echoes,
including before fill dispatch, remain readable. An input label equal to its
own value or a known private value is masked at any length, after trimming and
NFC normalization. Before fill dispatch, secure-field values have a separate
exception: two or more characters match as substrings; a single character
matches only as a whole token. This includes native labels classified as possible
values on secure inputs, even when no readable value is supplied.
Structural step numbers remain readable.

From the first fill dispatch, geometric rows of at least three visible text boxes,
each empty or containing one character and at least one filled, render as one
`[code]` token; model descriptions
show each box as `box (hidden)`. Rows share a horizontal band within four points
and have gaps no greater than 1.5 times the median text-box width. An additional
cell-based pass uses the outermost containing framed ancestor before an ancestor
shared with another box, allowing gaps up to twice the median cell width.
Nested same-character text echoes count once; repeated characters do not affect
grouping. Native non-input, nonsecure cells labelled by one character, including
pressable cells, also qualify when their row spells at least two characters in
order within a stored private value after whitespace removal. React-only cells
do not qualify, and text-only rows retain the three-box rule independently.
Enclosing labels composed of the row's characters, including separated forms,
are concealed too. Inputs are not code boxes. The shared
screen-text projection also protects failure history (`failure.seen`, including
"previously on screen"). Structural masking remains unioned with value-based
fragment masking.

Opaque tokens preserve complete-value identity for model comparisons. An
unobserved protected value or hidden input content cannot prove an assertion.
Once sensitive input pixels, code rows or a protected value's visible echo are
observed, screenshots are withheld for the rest of the walk. See the
[structural privacy regression cases](../qaren-core/test/unit/qa/split-digit-privacy.test.ts)
and [Saved blocks](#saved-blocks).

iOS interactions check app existence immediately and wait only when the app is
missing; availability and foreground checks remain in place. When the privacy
gate permits a row screenshot, the walk requests a full-screen image from the
running iOS runner and copies it into the run evidence directory. Lost or unknown
app-process identity withholds screenshots. Runner refusal, an invalid screenshot
path or a failed copy leaves the row without a screenshot and logs a value-free
unavailable reason; iOS QA never falls back to unrestricted simulator capture.

```text
plan preflight -> device selection -> lease + durable run record
               -> app preparation -> screen proof -> walk -> teardown
```

On iOS, `check` borrows the only booted simulator, or the booted target
selected by `--device`. `--boot-device --device <simulator-UUID>` opts into
booting that exact iOS simulator under the lease. `--fresh-install` opts into
removing the selected app and its data, proving absence, then installing it
under the same lease. Both opt-ins require strict admission before mutation.
Cleanup leaves the borrowed simulator running and keeps the installed app.
iOS preparation follows the
[CLI-owned iOS build routes](#cli-owned-ios-build-routes) and their startup
ordering. If finite-build cleanup is unknown, the build lock and
device lease remain claimed for `qaren cleanup`. The developer
[check gate](../../scripts/gate-qaren-check.sh) forwards the boot opt-in with
`QAREN_BOOT_DEVICE=1` alongside `QAREN_DEVICE_UDID`.

iOS preparation, borrowed-emulator builds and cached Android preparation
request the dev-client manifest from Metro once with the `expo-platform`
header before launch, so the client's own first request is not the slow cold
one. Fresh Android scenario-based
`prepare` keeps launch and Metro under `expo run:android` and does not perform
this warmup.
A manifest timeout refuses with `CORE_REFUSED`. Dev-client launch and iOS
dev-menu defaults timeouts retry regardless of host load until the remaining
`build_seconds` preparation budget is spent, then refuse with `CORE_REFUSED`,
unless the timed-out iOS launch is proven by the app-job receipt below.
That budget is shared with launch readiness; retries do not reset it. Each call
keeps its existing timeout, capped by the remaining budget, and cancellation
preempts retries. The receipt records every attempt's outcome and duration;
readiness still requires the existing Metro and app-process probes.
After a timed-out iOS launch the app-process probe is taken before any retry; a
live app job is accepted as the launch (`launch_proof: launchctl-job`) and
readiness follows without another launch. Liveness requires a numeric PID in a
`simctl spawn <udid> launchctl list` row on the exact simulator whose label
starts with `UIKitApplication:<bundle>[`; PID-less jobs and sibling bundle IDs
do not qualify. An absent job or failed probe leaves the existing retry policy
in effect.
The cached iOS dev-client install shares that budget, which starts before the
install. The owned `simctl install` gets the remaining preparation time instead
of a fixed 120-second limit. After a timeout, the installed app container is
accepted when its content hash equals the cached artifact's (`install_proof`);
otherwise the install is re-issued only if preparation time remains. A definite
install error fails immediately; an unproven install with a spent budget fails
with `ARTIFACT_INSTALL_FAILED`. For a timeout, keep the cached artifact, clean up
the run and retry as directed by `next_action`.
Host load is diagnostic only. Other
manifest and launch errors remain `BUILD_FAILED`. Cleanup retained resources
before retrying.

iOS artifact verification requires an Expo Dev Launcher image supporting
`--initialUrl` and refuses bundles containing `main.jsbundle`. Symbol and string
probes filter output before capture, allowing large debug images without raising
the 16 MiB capture limit; failed probes or missing required evidence still refuse.
The verification contract is owned by [`src/adapters/ios.rs`](src/adapters/ios.rs).

Signals or a vanished caller stop the run with `RUN_CANCELLED`. The CLI checks
cancellation before forward operations, including Git probes, recorder start,
installation, fresh-install data removal, simulator boot, Metro/core launch,
video finalization and publication. The core's cancellation helpers inherit the
walk-scoped AbortSignal when callers omit an explicit signal and combine it
with supplied signals for interruptible I/O and waits; aborts stop setup,
walking, readiness persistence and saved-action writes. Ownership-gated teardown
still runs.
See the [CLI cancellation boundary](src/cancel.rs) and
[core cancellation mechanism](../qaren-core/src/domain/cancellation.ts).
A second signal exits immediately; the next run must recover retained resources
through their recorded ownership proofs.

Before each iOS launch, `prepare` writes the app's Expo dev-menu preferences with
`simctl spawn <udid> defaults write <app-id>`: no floating action button, no menu
at launch, onboarding finished. A failed write is recorded as
`dev_menu_defaults: unconfirmed` and the launch continues. At walk start the core
also hides the floating button through Expo's `DevMenuPreferences` module and
reads the setting back, disables the shake gesture, attempts to disable Fast
Refresh through `DevSettings.setHotLoadingEnabled(false)`, and closes an open
menu. Disabling Fast Refresh prevents saved-block YAML writes in the app folder
from triggering the dev client's `Refreshing...` banner during recording. This
attempt is best-effort: an unavailable or throwing API does not itself refuse
the walk, and native overlay clearance does not prove Fast Refresh is disabled.
On Android that setting reloads the JS bundle, so the walk must mark the running
runtime before attempting it; failure to mark refuses before step 1. When the
setting reports that it executed, step 1 waits until the marked runtime is gone,
React is ready again within the remaining walk budget, the walk helpers are
injected into the new runtime and the reloaded bundle passes the origin proof;
otherwise the walk refuses before step 1.
Transient helper-injection and origin-read timeouts retry within that same
deadline; cancellation preempts the wait, and an invalid helper or origin proof
still refuses immediately. An unavailable or failed setting skips
the reload wait and continues best-effort overlay clearance. The same clearance
sequence runs again after a successful dev-menu recovery, except that Android does not set Fast
Refresh again, because that would reload the app mid-walk.
Apps without the preferences module skip the floating-button setting change but still require
native clearance evidence. The shared clearance mechanism accepts only a complete
native snapshot with neither a floating button nor an open dev menu in front,
briefly re-reading while overlays settle. An unconfirmed floating-button hide
or failure to obtain complete clearance evidence within those reads refuses
the walk with `DEV_MENU_HIDE_UNVERIFIED` before the first step.

### iOS admission and cleanup

Strict admission observes known automation patterns for the selected simulator.
The host process table is streamed without a total-output byte cap, so its size
alone does not refuse admission.
A driver targeting it is busy; a driver can coexist only when kernel executable
identity and exact arguments prove that it targets other simulators exclusively.
An unscoped Maestro MCP controller can coexist when its Java executable and
exact MCP arguments are attested; its command-line spelling alone is insufficient.
Unknown identity or scope for an automation candidate, or an incomplete process table, refuses.
The scan cannot exclude uncooperative automation inside an otherwise admitted
process and is not an external coordination lease.

Drivers and unresolved automation paths share one candidate budget and one
scan deadline. Command length alone does not make a process an automation
candidate; complete command lines are checked for known patterns even beyond
the identity observer's argument limit. Budget exhaustion refuses
instead of admitting a partial scan. The limits and classification rules are
owned by the [strict scanner](../qaren-core/src/runners/external-runner-detect.ts)
and [kernel observer](src/process_observation.rs).

When the strict admission probe refuses with `FRESH_INSTALL_ADMISSION_UNKNOWN`
or `DEVICE_BUSY`, it includes `probe_status`, `probe_evidence`, `exit_code` and `timed_out` in
`failure.detail`, retained in the receipt and `run.json`. Valid probe evidence
contains an allowlisted reason and, when available, a PID or candidate count;
raw process arguments, paths and subprocess output are not included. Missing,
invalid or mismatched evidence is reported as `unavailable`, `invalid_evidence`,
`envelope_mismatch` or `invalid_response`. These diagnostics do not relax
admission: resolve the refusal and start a new run.

Runs and evidence live under `~/.qaren/runs/<run-id>/`; device leases use
`QAREN_LOCK_ROOT` or `~/.qaren/locks`. Checks, including `qaren pr`, claim a
timestamped run directory atomically and retry with a numeric suffix when the
name already exists, so same-second starts have separate run identities. Use the
complete run ID printed by the receipt or watch hint for subsequent commands.
The walk writes `ledger.json` and
`report.md` when it reaches reporting; the receipt names available artifacts.
Cleanup proves owned process-group and exact-simulator runner-host absence
before releasing the lease. When the leased simulator had no runner host as the
core started, the run records the host as its own; normal teardown, cancellation
and dead-owner cleanup then terminate that host by bundle id on that exact
simulator only after core cleanup proves removal or absence, and re-prove the
host's absence. The core starts the runner's `xcodebuild` driver in its own
process group and announces it; the CLI records that group with the driver's
identity and signals it, before the host, only while that identity still
matches. Refused or unresolved core or driver cleanup leaves the host untouched
and retains the lease. A host that was already running, or any
present or unknown host after that, retains the lease. A dead lease
holder is reclaimed only through that run's cleanup; a live or unprovable holder
refuses `DEVICE_BUSY`. Recover a retained run with `qaren cleanup <run-id>`;
do not delete locks to bypass unresolved ownership.

### Saved blocks

Block IDs come from their `###` titles; a headingless block uses the plan's `#`
title, or `plan` when absent. The [parser's `slugify`](../qaren-core/src/qa/plan.ts)
lowercases the title, replaces runs outside `a-z` and `0-9` with hyphens, trims
edge hyphens and uses `plan` if empty. Slugs within the
[action-store length limit](../qaren-core/src/domain/path-safety.ts) stay unchanged.
Longer slugs use a prefix followed by a hyphen and the first 16 hexadecimal
characters of the full normalized slug's SHA-256, fitting that same limit.
The title stays unchanged; the filename, M7 `id`, `plan` header and replay lookup
use the same bounded ID. Existing valid actions are not renamed. Duplicate full
normalized slugs or distinct titles producing the same bounded ID refuse the
whole plan during preflight, before device allocation or action writes.

New files for passing `###` blocks use `<app>/.qaren/actions/<slug>.yaml`, where
`<app>` is the directory holding `.qaren/config.yaml` (with an external `--config`,
the checked working tree). The file is a Maestro-shaped action: each plan line as a
comment, then the commands with the exact `testID` (or, without one, the label) the
step used. On the next run a block whose plan lines, platform and app are unchanged
is replayed by those stored identities through the same walk, without Jev for quoted
targets or literal checks; phrase checks still ask Jev. An ambiguous stored
identity refuses `TARGET_AMBIGUOUS` without re-walking. A stored identity that no
longer resolves before that step authorizes any mutation re-walks
the block from that line; earlier completed steps are kept. Once that step authorizes
a mutation, its selector failure is terminal; recovered selector misses follow
[Step recovery](#step-recovery). On PASS only the commands under that
line and later ones are rewritten, and every `✓` comment stays byte-identical. A failing check is a FAIL and
is never re-walked or rewritten. Timeout recovery remains deferred (see
[Step recovery](#step-recovery)); app-process changes stay terminal. A failing block is never saved;
blocks that passed earlier in the run remain saved. A step without a `testID`
or label, a phrase wait, a fill into a secure or private input, or an attempt at
[keyboard fallback](#fill-verification-and-keyboard-fallback) leaves the block
unsaved and the ledger says why without naming any value. Planned fill literals
also undergo the [shared masking rules](#input-value-masking), so a protected
literal withholds a newly discovered or patched block even for an ordinary input.
A previously saved block replayed against a now-private
input also reports withholding without rewriting or deleting the existing action.
Discovered or patched block writes are deferred until the walk finishes. Values
preclassified from the plan or protected by private observations or keyboard
fallback anywhere in the same run are checked under those rules.
A matching block title, header field, raw comment, fill
literal, literal assertion or stored selector withholds the block rather than
rewriting its bytes, including matches to filled-secret fragments under the
[shared masking rules](#input-value-masking). Structural plan numbering is
excluded from matching. The final serialized YAML check matches complete
protected values; generated command syntax does not enable fragment withholding.
The value-free reason is
`contains a protected plan-typed value` in `blocks_not_saved`, including when the
value was observed rather than typed. Existing saved actions are not removed.

For quoted waits and scroll-until steps, a testID is stored only when exactly one
captured element carries it, including offscreen elements in that count. A shared
testID falls back to unique literal text evidence; without either unique identity
the block remains unsaved. A stored text selector must pass the
[literal-evidence rule](#plan-checks-and-screen-evidence) and match exactly one
visible witnessed identity. A control and its sole same-label text descendant
count as one identity, even with different rectangles; distinct controls remain
separate. Same-label siblings remain distinct even when their frames are
identical. Only proven ancestor/descendant text echoes collapse; matching labels
and frames alone do not establish one identity. An unidentified nested native
`StaticText` collapses into its parent text when label, value, frame, enabled,
hittable and secure facts agree; without presence evidence it also requires a
nonempty label and a positive frame. An identified child collapses only with
presence evidence and the same identifier as its parent. With presence evidence,
presence status and label source must agree too. Excluded labels cannot supply a
fallback witness. Discovery keeps preferring a unique testID for an eligible
text match. An ambiguous text target without a unique testID
can satisfy discovery but leaves the block unsaved; replay follows the
ambiguity refusal above.

Replay requires the canonical block format emitted by
[`serializeBlock`](../qaren-core/src/qa/blocks.ts); edited or incompatible files
take the discovery path. Before overwriting an existing action, saving requires its
`plan` header to match the block ID and its full normalized title to match the incoming
title, using the normalization described above before length bounding. A colliding
short and long title therefore leaves the existing file byte-identical; same-title
patches remain allowed. A collision or unsafe corpus leaves the passing block unsaved
with a reason in `blocks_not_saved`.
Saving holds the existing action-write lock across extension selection, title ownership
checking and publication, so concurrent saves of colliding titles preserve the winner's
file. Both `.yaml` and `.yml` identities share this lock.

The ledger's `path` is `walk`, `replay` or `replay→walk@<line>` (the first re-walked
plan line), and each block reports `source` `discovered`, `replayed` or `patched`. The
receipt lists `blocks_written`, `blocks_not_saved` (block and reason) and, as a
diagnostic that never changes the verdict,
`worktree_drift`: app-root paths whose `git status` changed during the walk, outside
`.qaren/actions`. This status-only diagnostic is separate from the
[candidate provenance check](#candidate-provenance), which can fail the run.

Block names in final ledger rows, block results, reports and `blocks_not_saved`
withhold the whole displayed name as `•••` when either the original title or
its slug matches a protected value. Machine fields `blocksWritten` in the core
result and `blocks_written` in the receipt retain canonical slugs for file lookup and PR
block preservation; replay identifiers also remain unchanged.

`qaren actions list [--json]` and `qaren actions show <slug>` read the
action corpus of the current directory. Both `.yaml` and `.yml` are supported;
existing files retain their extension when patched. A slug with both extensions
refuses inspection and is not overwritten by `check`. These inspection commands
refuse symlinked corpora and action files. Inspection header validity and defaults follow the
[core header parser](../qaren-core/src/domain/reusable-action.ts); `list` skips
invalid headers and `show` refuses them.

The TypeScript action store used by saved-block reads, replay and writes normally
uses a real `.qaren/actions` directory. A linked Git
worktree may instead link that directory directly to an existing real
`.qaren/actions` directory in this repository's main copy, at the same
app-relative path. Git must prove that both copies share the same repository;
another clone, another app path, a chained or dangling link, or an ancestor link
that escapes the expected main-copy path is refused. A directory alias is accepted
when its canonical target matches that path. `.qaren` itself and individual action files must not be
symlinks. Reads, replay and writes use the accepted main-copy corpus, so saved
blocks and patches are shared with the main copy. Main-copy link refusals identify
a missing main-copy directory when verified; otherwise they report that the direct-link
proof could not be verified. They recommend a real directory or the supported
direct link. The [action store](../qaren-core/src/domain/action-store.ts)
owns these checks and detects replacement of the link or corpus during an operation.

PR runs copy saved blocks to the run's `blocks/` directory with their original
extension and bytes. See [Test a pull request](#test-a-pull-request) for branch
writeback validation and fallback comments.

On iOS the walk also fails `APP_PROCESS_CHANGED` when the app's process changes between
captures (a crash or restart), or a snapshot or platform-presence capture reports
`app-not-running`. Generic platform-presence runner failures retain the
`NATIVE_CAPTURE_UNAVAILABLE` refusal. An initial capture that does not report the process
refuses `APP_PROCESS_UNKNOWN`; a runner built from an older checkout needs a rebuild
(`RN_RUNNER_BUILD=local`).

### Step recovery

An observed React Native red box fails the current step immediately, including
during login replay, with error-screen evidence in `failure.seen` projected through
the [input value masking contract](#input-value-masking).
It is checked before accepting a step or refusing incomplete semantic evidence,
and never triggers recovery.

An action without success evidence after its one retry, a step target that
does not resolve, or a phrase check still unsure after its re-ask
gets at most one deterministic recovery, then the step runs once more from a fresh
capture. The order is owned by [`recover.ts`](../qaren-core/src/qa/recover.ts): a
recognized system dialog in front is accepted; a dev menu or floating button in
front is cleared through the shared [overlay clearance mechanism](#check-a-plan);
and when `loginMarker`
(`{ id: <testID> }` or `{ text: <label> }`) is on screen, the
saved block `loginBlock` (`.qaren/actions/<loginBlock>.yaml`, saved for this app and
platform) replays by its stored identities. The two keys are set together, with
exactly one nonempty marker `id` or `text`. A missing, unreadable or incompatible
login block fails when login recovery is needed. A second
failure of the same step fails it, recovery never runs inside the login replay, and
capture, Jev, process, replay-miss and cancellation refusals are never recovered. The
ledger's `recoveries` counts recoveries that let the step retry; `escapes` and `llmTurns`
stay `0`. Login fills are masked like plan fills; see [Video publication](#video-publication)
for recording eligibility.

Recovery counts as a device mutation for replay eligibility: a selector miss
after recovery is terminal and never initiates another re-walk. The second ordinary
action attempt captures fresh evidence but gets no additional expiry refresh;
phrase actions retain presence capture through readback and retries.
See the [recovery regressions](../qaren-core/test/unit/qa/walker-recover.test.ts)
and [freshness regressions](../qaren-core/test/unit/qa/temporal-walker.test.ts).

Recovery requires admitted screen evidence. iOS phrase steps behind a system or
permission alert can refuse `SCREEN_EVIDENCE_INCOMPLETE` before recovery because
platform presence excludes that system surface; phrase-step dialog recovery is
best-effort. For Android dialog limits, see [Check a plan](#check-a-plan).
An action reporting `tapped: false`
or `executed: false` establishes no action proof and cannot count as a recovery.

Dev-overlay recovery must re-prove clearance before retrying the step. A failed
clearance or a non-executing hide with no overlay to clear fails the step.

### Walk timing

`ledger.json` adds a `timing` object to each walked attempt row, in milliseconds.
`captureMs`, `resolveMs` (decision), `actMs`, `postCaptureMs` and `otherMs`
partition `total`, the elapsed window between consecutive row timestamps
(starting at the walk for the first row). `nativeMs`, `reactMs` and optional
`presenceMs` detail reads within capture; `jevMs` details judgment time within
decision, including HTTP retries and their backoff. These breakdowns overlap
the partition and must not be added to `total`. Post-action captures start
after an authorized dispatch; captures after a dispatch refused before
authorization remain in `captureMs`.

The ledger's `speed` summary groups timed action/check rows by operation, keeping
login-replay steps separate from plan steps that share a line and kind. Every retry,
passing and failing attempt of one operation sums into one logical-step duration,
even when a capture refusal changes the block name. `stepMedianMs`
and nearest-rank `stepP95Ms` cover all those logical steps; `steps`, `passed`
and `failed` count them, with the last attempt determining whether a step
passed. `walkMs` sums all timed row windows, not app preparation or teardown.
`report.md` prints these summary values under Run details; inspect the ledger
for individual timing breakdowns.

Without timed rows, `speed` is omitted. With timed rows but no timed actions
or checks, counts are zero and percentiles are omitted (shown as `n/a` in the
report). An interrupted child without a final result retains row evidence
but omits `speed`. Timing is passive: it does not alter verdicts, actions or
budgets, and the CLI drops malformed timing rather than rejecting the ledger.
The [row timing implementation](../qaren-core/src/qa/row-timing.ts) owns
aggregation; [CLI decoding](src/core.rs) and [report rendering](src/report.rs)
own consumption.

Launch admission shares the remaining walk deadline across target readiness,
WebSocket handshakes, probes and retry sleeps. The connect-time dev-build check
and helper injection wait for the runtime's answer until that deadline rather
than a fixed request timeout; no answer by the deadline is a readiness timeout.
On iOS, readiness and attachment accept only a runtime Metro reports under the
run's simulator name, so another booted simulator running the same app on the
same port is not attached. Metro identifies a simulator only by name: give each
booted simulator a distinct name, because a same-named one is refused as
ambiguous only once both have registered.
Transient target-list, WebSocket-handshake and runtime-probe timeouts, along with
inspector page closure or replacement, retry within that same deadline regardless
of host load, with bounded polling and exact-port rediscovery between attachment
attempts. Exhausted readiness refuses `CDP_NOT_CONNECTED`; invalid
metadata and deterministic attachment rejections refuse immediately. Host load
is diagnostic and does not decide whether the app is ready.
After an exhausted target-readiness wait, or persistent runtime-probe or
WebSocket-handshake timeouts lasting a full readiness window from the first such
timeout (never before the original readiness window ends), an iOS dev
client can be relaunched once if the remaining deadline still covers a full
readiness wait. Individual target-list timeouts and inspector page closures do
not trigger relaunch. Before a relaunch for a missing target, admission uses the
[iOS app-job liveness rule](#check-a-plan). A live app skips that no-target
relaunch, logs `relaunch skipped: app-alive`, and keeps waiting within the same
deadline; an absent job or failed probe permits recovery as before. Skipping
does not consume the one relaunch for persistent runtime-probe or
WebSocket-handshake timeouts, and a target that registers late gets the same
readiness window before a stalled handshake triggers the one relaunch. The refusal record includes value-free `liveness`
and the number of relaunches actually attempted. Before the liveness check or
relaunch, admission checks for a foreign driver;
a conflict refuses `BUSY_FOREIGN_FLOW`
without relaunching. It relaunches on the exact simulator with the CLI's original
`initialUrl` using `simctl launch --terminate-running-process`, then waits again
within the original deadline. A failed relaunch refuses without another wait.
If the CLI's walk deadline expires before the core reports admission, the CLI
also returns `CDP_NOT_CONNECTED` with measured host load (or an explicit
unavailable measurement), regardless of load. After admission, deadline
expiry remains `WALK_DEADLINE_EXCEEDED`.
The refusal carries the measured load; the
[admission implementation](../qaren-core/src/qa/admission.ts) owns attachment
retry policy; the [CLI core boundary](src/core.rs) owns deadline classification.

### Candidate provenance

The shared [candidate comparison](src/candidate.rs) rechecks the commit,
lockfile hash and worktree fingerprint. The fingerprint hashes normalized
NUL-delimited Git status records plus affected file contents, symlink targets,
absence and executable permission bits, so editing an already-dirty file is
still detected. Repository-root `.qaren/` state is excluded, as are direct
`.yaml` and `.yml` action files under the selected app root's `.qaren/actions/`.
Changes outside these exclusions, including a nested app's `.qaren/config.yaml`
or source files, and renames crossing the excluded boundary remain candidate
changes.

Preparation rechecks provenance before emitting `ready`; `check` and `pr`
recheck it before and after the walk. Detected drift fails with
`CANDIDATE_DRIFTED` and cannot return PASS; an already-cancelled walk retains
`RUN_CANCELLED`. Passing blocks already saved remain available. See the
[publication refusal contract](#test-a-pull-request) before publishing; re-run
against an unchanged candidate to obtain attributable evidence.

## Test a pull request

```sh
qaren pr <number|url> --plan-file plan.md --device <simulator-UUID> --json
qaren publish <run-id> --json
```

Company plans, reports and recordings must remain private and must never be
published to public product surfaces. Publication's value and machine-identity
redaction does not establish that company material is safe to publish.

`qaren publish` admits only a persisted `run.json` terminal result: no
cancellation, matching final candidate verification, and proven teardown
ownership, including the recorder and runner host as well as build, core and
Metro producers. The final verification is captured before teardown removes
the candidate worktree; the terminal result is persisted after teardown
and video finalization. Immediately before writing the `pr.json` publication
handoff, the CLI rechecks cancellation; a late cancel marks that terminal result
cancelled, persists it and withholds the handoff. A missing terminal result
refuses `RUN_RECORD_INVALID`.
Cancellation refuses `RUN_CANCELLED` (exit 4), candidate mismatch fails
`CANDIDATE_DRIFTED` (exit 1), and unproven ownership refuses
`OWNERSHIP_UNPROVEN` (exit 4), before uploads, comments, label changes or block
write-back. A plain QA FAIL can still be published as a report when these
conditions hold. Later recovery does not upgrade the original terminal result;
re-run `qaren pr` to obtain publishable evidence. Saved actions already on disk
remain untouched.

`qaren pr` runs the same pipeline as `check`, from the app's directory with the
same `.qaren/config.yaml` and plan, but walks a detached worktree at the pull
request head under `~/.qaren/runs/<run-id>/wt`. It refuses unless origin's
`pull/<n>/head` is the head GitHub reports and the worktree is clean at that
commit, both before the lease and again before the walk. Fetch verification uses
a per-run local ref rather than shared `FETCH_HEAD`, so concurrent PR runs
verify their own fetched commits. On iOS the simulator
screen is recorded from just before the walk to just after it and encoded to
`media/video.mp4` (H.264, 30 fps); without `ffmpeg`, or when a capture cannot
start, the run continues and the receipt's `video` outcome says why. The local
recording stays complete; `qaren publish` uploads only
`media/video-published.mp4`, trimmed under the [video publication contract](#video-publication).
Blocks the walk saved are copied to `blocks/` before the
worktree is removed. If the pull
request moved during the run, the receipt names the tested commit in
`tested_older_commit`. On Android, `pr` borrows an emulator like `check`; its
video is unavailable in this release.

Normal teardown and dead-owner recovery remove the PR worktree only after
cleanup proves the recorded build, core, Metro, recorder and runner-host
outcomes removed or absent.
Any retained, refused or unresolved producer outcome keeps the worktree recorded
for `qaren cleanup <run-id>`. Metro cleanup requires proven process-group absence
after reaping owned children; a free port or dead launcher alone is insufficient.
Present or unknown group evidence retains Metro ownership and any applicable lease.
Successful PR worktree removal reports measured reclaimed bytes, or explicitly
reports that the byte count is unknown, including dead-owner recovery. Once a
playable local video replaces `media/raw.mov`, the raw capture is retired and
its reclaimed size is reported; failed finalization retains it.

An unproven recorder shutdown retains recorder ownership and the device lease,
including when recording startup fails. Teardown retries an unresolved stop;
the receipt's `cleanup.recorder` reports that final outcome. If shutdown remains
unresolved, recover with `qaren cleanup <run-id>` as described under
[iOS admission and cleanup](#ios-admission-and-cleanup).

`qaren publish` posts one comment: the structured PASS/FAIL/REFUSED verdict and refusal code, the
tested commit, an eligible available video, the plan with ✓/✗ per walked line,
an available failing screenshot and collapsed run details. Plan lines come only
from the walk's own rows, never from the raw plan file, so typed values stay out.
The hostname, home directory, user name, absolute paths, device UUIDs, the run's
device ids, serials and ports (recorded privately in `pr.json` as
`identityValues`) and private network addresses are removed from the comment.
Known identity values shorter than three UTF-8 bytes are not masked. Matching
ignores ASCII case and rejects matches next to ASCII letters, digits or hyphens;
a recorded port number also masks the same number elsewhere in the text. It then
removes the `needs-qa` label only if the current head is the tested head; otherwise
`publication.json` and the receipt record `retained-head-changed`.

A saved block is published only verbatim, and only when the walk was eligible
under the [video publication contract](#video-publication) and the
machine redaction would leave the block unchanged. Any other block stays in the
run's `blocks/` directory and is never rewritten; `publication.json` and the
receipt record `withheld <slug>: <reason>`. Published blocks are committed to the
pull request branch with a `Qaren-Run: <run-id>` trailer, using your own git
identity and a push lease on the tested commit. Every effective origin push URL
reported by Git must match the pull request's repository. Mixed, unknown or
unproved destinations prevent a push. When the branch moved, the pull request
comes from a fork, or destination verification fails, a second comment carries
the admitted blocks' YAML instead. Writeback refuses an ambiguous slug or a
destination with the other extension rather than creating a second sibling.

Before retrying an unpushed block commit, publication verifies that its sole
parent is the tested commit, its changes affect only currently admitted block
paths, and those files contain the admitted verbatim bytes without ambiguous
`.yaml`/`.yml` siblings. A matching cached commit is reused; otherwise a new
commit is built from the tested head using only currently admitted blocks.
The replacement does not descend from the rejected cached commit. Every newly
created commit, including a replacement, passes the same parent, path and exact
Git-blob byte checks before it can be pushed. Git filters or line-ending conversion
that change the saved bytes cause fallback to the verbatim blocks comment; QaReN
does not normalize the bytes or change `.gitattributes`. The same push lease
still applies; a failed commit or push falls back to the blocks comment.
When all blocks are withheld or privacy admission fails, no block commit is
pushed. A cached commit already at the remote branch head is reconciled as
published only when Git's effective origin fetch URL also matches the pull
request's repository and readback succeeds. A mirror, unknown destination or
failed lookup cannot prove publication; the verified push or fallback path
remains available. Reconciliation neither rewrites history nor claims earlier
content passed the current privacy gate.

Each step is recorded in `publication.json`. Before retrying an attempted post,
publication regenerates the QA report from the current verdict file and walk rows,
or the saved-block report from blocks admitted by the current publication gate,
applying current identity redaction. It adopts an existing comment only when its
author is the authenticated GitHub user and its first-line marker matches the
run ID and SHA-256 fingerprint of that rendered body, excluding the marker line
and before attachment rewriting. QA reports and saved-block comments each use
their own fingerprint, so a lost attachment-post result can be reconciled without
duplicating the report. Without a matching comment it writes `comment.md` or
`blocks-comment.md` and posts the regenerated body.
Cached bodies are not reused. Already-posted comments are neither edited nor deleted.

Publication holds an exclusive file-descriptor lock on `publish.lock`; a
concurrent publisher fails until the holder exits. The file remains after release;
its existence does not mean publication is active. Do not delete it to bypass
contention.

### Video publication

Video publication eligibility and a value-free withholding reason are persisted
in `pr.json`. A plan containing any fill/type step keeps the recording local,
even if that step never executes. Otherwise, the uploaded copy starts when the
walk proved the app's bundle and passed [overlay clearance](#check-a-plan).
Sensitive observations from admission onwards withhold it. The uploaded copy
ends at the last step row, so the device session closing after the walk never
reaches it; the local recording stays complete.

A successful saved login replay before any plan step passes moves the uploaded
copy's start to the end of that replay. Its fills alone do not withhold the video.
The last observed login screen must be clean: a typed or private value still
visible there, or observed at any later capture, withholds the video for the rest
of that window. Complete values of three or more characters also withhold capture
when echoed with changed capitalization. A fill without readable input content
keeps a privacy guard active until a matching field has been observed on screen
and then disappears. If the field is unknown, an input must be observed and then
all inputs must disappear; a field never observed keeps the window private.
Login fills after any plan step passes withhold
the video, including a second login after an earlier publication window opened.
The comment's fill-related withholding reason covers both a plan fill or type
step, executed or not, and saved login replay input.
The login exception never resets run-wide screenshot withholding or masking
history.

Launcher, server-picker, relaunch and dev chrome frames before admission never
reach the pull request. Without a start time or a successful trim, or when an app
process change, launcher/server-picker fallback, floating button or open dev menu
is observed after admission, no video is uploaded, even if recovery clears the
overlay and the retry passes. A pre-plan login does not reset these interruptions.
Missing, unknown or unreadable eligibility also withholds the video; the comment
explains why, without changing the run verdict.

Local recordings contain raw pixels. Transient prefilled
values between captures remain a limitation for 2.1; there is no continuous privacy
monitoring or pixel redaction.

## Preparation verbs

These scenario-based verbs retain the preparation receipt contract below;
`check` adds `pass` / `fail` results (exit 0 / 1), with typed refusals exiting 4.

### Usage

```sh
qaren prepare <scenario.yaml> [--json] [--dry-run]
qaren prewarm <scenario.yaml> [--json]
qaren status  <run-id> [--json]
qaren complete <run-id> <build-log> [--json]   # cooperative handoff only
qaren cleanup <run-id> [--json]
qaren cleanup <run-id> [--json] --remove-app --confirm-remove-app <run-id>/<remote-serial>/<app-id>
```

Every syntactically valid preparation invocation writes exactly one `qaren/1` JSON
receipt to stdout; argument/usage errors are the sole exception — they exit
`2` with help on stderr and an empty stdout. All human-readable narration
goes to stderr. Exit codes: `0` ready / cleaned / planned / working /
prewarmed, `1` failed, `2` usage, `3` unknown, `4` refused (contended
device or build lock, an unavailable device, missing prewarm authorization,
unprovable ownership, unconfirmed app removal, or rejected cooperative-handoff
evidence).

`--remove-app` and `--confirm-remove-app` must be supplied together and only
on `cleanup`; a missing flag or confirmation value, or use on another verb,
is a usage error (exit `2`, no receipt).

`status`, `cleanup` and `complete` load the host-level run record described
under [iOS admission and cleanup](#ios-admission-and-cleanup). `--dry-run` on `prepare`
validates the scenario + candidate and emits the planned command sequence
(listener/readiness poll probes elided) without allocating anything.

```
prepare ──► validate (scenario schema, candidate git sha, lockfile sha256)
        ──► prereqs  (tools present, metro port free)
        ──► plan     native fingerprint + machine store + cache state ──► reuse | incremental | clean
                     (decision + evidence recorded; non-reuse takes the
                      host-level build serialization lock)
        ──► allocate  iOS:  simctl create qaren-<run-id> + bootstatus -b
                      NUC:  ssh <host> ~/bin/android-farm start <slot> qaren-<run-id>
                            ssh -N -L 127.0.0.1:<p>:127.0.0.1:<p>  (owned pid)
                            run-scoped adb server on adb_server_port with the
                            farm host's vendor key (fetched over ssh, 0600,
                            deleted at cleanup); adb connect 127.0.0.1:<p>
                            through it — never the Mac's global adb server
                      USB:  exclusive claim lock usb-<serial> (refuse if held)
                            run-scoped --one-device <serial> adb server on
                            adb_server_port; device must probe `device`
        ──► build+launch   iOS: CLI-owned iOS preparation (see build routes below)
                          Android: pnpm exec expo run:android --port <port>
                             (serial pinned via ANDROID_SERIAL + the
                             one-device server; CI=1)
        ──► verify   port owner pgid == spawned pgid, /status responds,
                     app installed + running on the owned device
        ──► ready    receipt + durable host-level run.json

(With `build.owner: qaren` the chain branches after `allocate`: no
build+launch — prepare re-verifies the candidate, issues `handoff.json`, and
finishes at phase `handed_off`; see the cooperative handoff section below.)
```

## Scenarios

Scenarios are versioned (`schema: qaren/1`), narrow, and strictly validated
(unknown fields rejected). Five checked-in examples:

- [`scenarios/ios-simulator.yaml`](scenarios/ios-simulator.yaml) — Mac iOS
  simulator (device type + runtime pinned, Metro on 8791).
- [`scenarios/nuc-android.yaml`](scenarios/nuc-android.yaml) — NUC Android
  emulator slot 1 via the `~/bin/android-farm` lease contract (Metro on 8792).
- [`scenarios/usb-android.yaml`](scenarios/usb-android.yaml) — a physical
  USB Android phone by explicit serial (Metro on 8794).
- [`scenarios/cooperative-ios.yaml`](scenarios/cooperative-ios.yaml) /
  [`scenarios/cooperative-usb-android.yaml`](scenarios/cooperative-usb-android.yaml)
  — `build.owner: qaren` handoff mode (see below).

### CLI-owned iOS build routes

The default route requires the app-local Expo CLI to advertise generic build-only mode, `--no-bundler` and `--output`. For older Expo CLIs, explicitly select an existing native workspace and its Xcode scheme in the app's `.qaren/config.yaml` (or an external `check --config` file):

```yaml
appId: com.example.app
devClientScheme: exp+example
ios:
  build:
    workspace: ios/Example.xcworkspace
    scheme: Example
```

For `prepare`, the same pair belongs under `build.ios_workspace` in the scenario, alongside `build.owner: cli`. Workspace paths are relative to the app root, remain under `ios/`, and must resolve through plain directories to an existing `.xcworkspace` with a plain `contents.xcworkspacedata` file. No scheme discovery, Expo upgrade or automatic fallback after a failed build occurs. An iOS section in shared `check` config does not select this route for Android.

Both CLI-owned iOS routes start a separate owned Metro process group after native-directory preparation and before finite compilation, letting Metro start while the build runs. Verified cached-app reuse starts Metro before installation instead, without spawning it again. Installation still requires a verified simulator bundle; launch waits for proven Metro ownership, `/status` readiness and dev-client manifest warmup. Dry-run command lists reflect this ordering. Failed iOS `prepare` attempts clean up early Metro and report the outcome in `cleanup.metro`; unresolved ownership remains recorded for [cleanup](#ios-admission-and-cleanup).

The workspace route runs `xcrun xcodebuild` in Debug against the generic iOS Simulator destination, with certificate-free ad-hoc simulator signing (`CODE_SIGN_IDENTITY=-`, no team or provisioning profile) so entitlements such as keychain access survive, and the React Native packager launch disabled. Products and DerivedData are isolated under the run directory. The existing finite-build process group and lock remain authoritative; only a clean exit with proven group shutdown can proceed to single-bundle verification, exact-device installation and launch. A missing or ambiguous app, wrong bundle/platform/scheme or unsupported dev-client launcher still fails before installation. Workspace and scheme selection, and the build-settings revision, participate in the native cache fingerprint, so an earlier unsigned workspace build is not reused; see [Native-fingerprint build selection](#native-fingerprint-build-selection) for the shared store and toolchain binding used by both routes.

**Native preparation remains explicit.** Supply a workspace whose native dependencies and generated inputs are ready for Xcode. QaReN retains its existing clean/incremental policy: an unproven generated native directory is regenerated through owned `expo prebuild --clean`, then the workspace is revalidated before compilation; a git-visible native tree is not regenerated. The workspace route adds no CocoaPods synchronization or codegen command of its own, and workspace existence is not proof that those inputs are current after a dependency update. A build failure is reported, not retried through another backend.

After verified cache publication and proven build-group shutdown, successful workspace builds retire their run-local products and DerivedData. Failed builds, failed publication or unresolved cleanup retain outputs; symlinked retirement roots are not followed. Unknown build-group cleanup continues to retain the build lock and device lease for `qaren cleanup`.

### Cooperative handoff mode (`build.owner: qaren`)

With `build.owner: qaren` (workspace issue #34), `prepare` stops after
allocation: validate → deps → native fingerprint → allocate (run-scoped
simulator, or exclusive USB claim lock with **no adb server and no device
contact**) → re-verify the candidate → issue a typed
`handoff.json` (`qaren-handoff/1`) and finish at phase `handed_off` with
result `ready` — **meaning allocated and handed off; nothing is built,
installed, or launched by qaren**. The qaren session then performs the
one authoritative managed build/install against the exact allocated device,
and `qaren complete <run-id> <build-log>` binds the session's signed build
receipt to the run identity, refusing missing, stale, ambiguous, mismatched,
foreign, replayed, or late evidence (exit 4). In handoff mode,
`deadlines.build_seconds` is one wall-clock validity window starting at the
typed handoff's `issued_at`; retries never reset it. Handoff scenarios carry no `metro:`,
no `android_usb.adb_server_port`, and no `dev_client_scheme` — the session
owns those lifecycles — and the farm adapter is refused (the leased emulator
is unreachable from the session's global adb server). Cleanup is unchanged:
qaren removes exactly the allocation it recorded and never touches the
session's Metro or build. The full chain, ownership table, trust boundary,
and temporary policy live in
[`docs/qa/cooperative-qa.md`](https://github.com/Lykhoyda/rn-dev-agent-workspace/blob/main/docs/qa/cooperative-qa.md).

### Project-scoped real apps

`candidate.worktree` (optional, absolute path) points qaren at an external
project instead of the workspace containing the scenario. The path must BE a
git toplevel — a subdirectory of some larger repo is refused
(`CANDIDATE_PATH_INVALID`) so a run can never bind to files outside the
project it named. Project cache state lives under `<worktree>/.qaren/`, verified
iOS dev-client builds are shared per machine under `~/.qaren/native-cache/` (see
[Native-fingerprint build selection](#native-fingerprint-build-selection)), and the
fingerprint enumerates only that worktree. Run records remain host-level;
`status`/`cleanup` load them by run id without requiring the app directory.
qaren never discovers, enumerates, or couples other projects.
`candidate.project_root: .` selects a project living at the worktree root.
Because `.qaren/` is qaren's own state, it is excluded from the candidate
cleanliness and drift comparison — an external project does not need to
gitignore it, and a clean worktree stays provably clean while qaren writes
its project caches there.

`candidate.dev_client_scheme` names the app's registered dev-client URL scheme (e.g. `exp+example`), not its Xcode scheme; it is required for CLI-owned iOS builds and cached dev-client reuse. `check` calls this field `devClientScheme`. Bundle verification checks both the registered scheme and the built dev-client launcher before installation.

### Physical USB Android

`android_usb: { serial, adb_server_port }` is a separate, exclusive
allocation path (exactly one of `android:` / `android_usb:` per scenario).
The serial must be a plain physical-device serial — `emulator-*` and
loopback forms are rejected at validation, so the farm path's
structural guarantees never weaken. At allocate time the device is claimed
by an atomic host-level lock (`$QAREN_LOCK_ROOT` or `~/.qaren/locks`,
`usb-<serial>`); any existing claim — even one whose holder is provably
dead — is a structured refusal (`DEVICE_CLAIM_CONTENDED`, exit 4), never an
adoption. All qaren processes competing for a device must share the same
lock root (the per-user default covers the single-operator dev-machine
model). A run-scoped `--one-device <serial>` adb server (host adb key
pinned explicitly) is the only path to the phone; `expo run:android` routes
through it via `ADB_SERVER_SOCKET` + `ANDROID_SERIAL`. An `unauthorized` or
`offline` device is a structured `DEVICE_UNAVAILABLE` refusal (exit 4). Cleanup
releases the claim only after every resource that can still address the
device (reverse mapping, adb server, and the build/Metro process group that
drives adb through that socket and serial) is proven removed or absent.

Every device, Metro port, bundle id, candidate revision, project root, and
artifact directory is explicit — in the scenario, the run record, or the
receipt. The scenario-based preparation verbs never select `booted`, a default device,
or "first available". `candidate.revision: HEAD` records the exact sha; a pinned
40-char sha refuses to run against any other checkout state.

## Native-fingerprint build selection

`prepare` chooses the fastest semantically valid build path and records the
decision — `reuse`, `incremental`, or `clean` — with its reason and evidence
in the run record, the prepare/status receipts (`build` field), and dry-run
plans. Speed never overrides provability: anything unprovable falls back to
a clean build, and a stale or unverifiable binary is never claimed.

**Fingerprint (`rnfp1:<sha256>`).** A sorted manifest of `(path, sha256)`
over the native inputs git considers part of the candidate (tracked plus
untracked-not-ignored — generated CNG `ios/`/`android/` dirs are build
outputs, not inputs): `package.json`, `pnpm-lock.yaml`, `app.json`,
`app.config.*`, `eas.json`, `react-native.config.*`, `plugins/**`,
`assets/**`, `patches/**`, tracked platform dirs (minus build outputs),
files referenced by relative path from a static `app.json` (icons, splash,
service files, local config plugins), the traced transitive relative-import
closure of those local plugins and supported `react-native.config.js`/`.ts`
entry points, and the native
surfaces (`package.json`, `*.podspec`, `expo-module.config.json`, `ios/`,
`android/`) of `file:`/`link:` local dependencies inside the worktree, enumerated
from `dependencies`, `devDependencies` and `optionalDependencies`.
Registry package plugins named in `app.json` and bare imports in traced modules are
bound by the lockfile plus the `version` of the package Node resolution finds
in `node_modules` from the project root up to the worktree root (pnpm symlinks
included); pure Node built-ins are ignored, and a package that does not resolve to a
versioned `package.json` makes the fingerprint incomplete.
Local package plugins and bare imports declared through `link:`, `file:` or
`workspace:`, or resolved into worktree source outside `node_modules`, are not
traced and always make the fingerprint incomplete; relative plugin files in
the app retain their existing scan.
When a traced module contains a bare import, any nested `node_modules` directory
on the path from its directory up to, but excluding, the app root also makes the
fingerprint incomplete. Root-based package binding cannot prove that import's
resolution in this case.
Static plain-string `import` and `require` forms, including whitespace around
`require` arguments, are traced. Each module dependency must name an existing
regular file directly, with no symlink in its path, and be recursively scanned
as `.js`, `.ts`, `.mjs`, `.cjs` or parsed as `.json`. Extension inference,
directory indexes, package `main`/`exports` resolution, extensionless modules,
dynamic or template-literal arguments, escaped literals and other unsupported
syntax make the fingerprint **incomplete**, forbidding cached reuse (visible
in decision evidence). Unresolvable local refs and `workspace:` dependencies
in any of those sections also make it incomplete.
On iOS the value also binds the selected Xcode (`xcodebuild -version`), so a
build is never reused across Xcode versions, and an unavailable Xcode makes the
fingerprint incomplete. Android binds the manifest hash alone.

**Expo native identity (iOS).** When the app's `package.json` declares `expo` in
`dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies`,
qaren runs the app's own `@expo/fingerprint` (resolved through the app's `expo`
install, never downloaded) as `pnpm exec node <cli> fingerprint:generate
--platform ios` from the project root, with the iOS build's environment
transforms (`CI` removed, `EXPO_NO_TELEMETRY=1`). Expo evaluates the config,
loads `.env` files, and hashes the evaluated config, the modules it loaded,
autolinked native modules and config-plugin inputs. QaReN accepts the output only
when it contains a nonempty hexadecimal `hash` and a `sources` entry with
`type: contents`, `id: expoConfig` and string `contents`. Resolution failure,
a failed command, a 120 s command timeout or missing required output makes the
evaluation unavailable, even if Expo exits successfully with a hash. The command
output can contain evaluated config values and is never logged or stored.
A successful evaluation binds the native-input manifest hash, Expo hash and Xcode identity in the
`qaren-expo-native/2` composite. Receipt notes record `fingerprint_parts` (hashes
only), `fingerprint_complete` and `expo_fingerprint_ms`. An unavailable evaluation
records `expo_fingerprint_unavailable`; on a static config it falls back to the
native-input manifest plus Xcode identity without adding incompleteness.

**Dynamic `app.config.*` (iOS).** qaren cannot trace a dynamic config itself,
so it still attempts Expo evaluation even without a declared `expo` dependency.
A successful evaluation clears only the dynamic-config incompleteness; every
other reason still forbids reuse. If evaluation is unavailable under the rules
above, the dynamic config stays incomplete and the decision is a rebuild as
before, with the unavailability named in the evidence. A config whose evaluated
value changes between runs (an environment read, a time or random value) changes
the hash and rebuilds.
Limits: environment read only by native build scripts (a Podfile reading `ENV`,
for example) and the CocoaPods version are not bound; Android keeps a dynamic
config incomplete.

An incomplete fingerprint over an existing generated native directory requires a
clean prebuild, which deletes that directory with its installed native
dependencies and build outputs; a git-visible native directory can still build
incrementally under the decision rules below. When the fingerprint matches but
is incomplete, the decision reason names the first incompleteness cause, such as
the dynamic config.
Other native-input symlinks hash link text plus in-worktree target content;
out-of-worktree targets make the fingerprint incomplete. The scanner is
conservative, not a full JS parser.
qaren is pnpm-only; other package managers' lockfiles are out of contract.

**Decision.** Verified iOS dev-client builds live in a machine store,
`~/.qaren/native-cache/ios/<app_id>/<fingerprint>/`, with `:` replaced by `-`
in the fingerprint directory name, shared by every clone and `qaren pr`
worktree on this machine. Per-worktree cache state lives at
`<worktree>/.qaren/native-cache/<platform>-<app_id>.json`
(`qaren-native-cache/2`; a state with an older schema is invalid), bound to the
exact worktree, platform, app id, fingerprint, and building candidate sha; it
records whether qaren generated the native directory, which decides incremental
versus clean. Android never reads or writes the machine store: its state also
holds the cached APK, kept under this worktree's `.qaren/native-cache/artifacts/`.

1. **Reuse** — on iOS, the machine store holds a build of this complete
   fingerprint whose content hash verifies against its record, its kind matches
   the platform, and `dev_client_scheme` is configured. Missing, invalid or
   other-worktree state does not block reuse and appears in the evidence, as
   does `artifact from machine store <path>`. On Android, the state matches this
   worktree/platform/app, fingerprints are equal and complete, and the state's
   APK verifies, with `dev_client_scheme` configured. The
   verified dev client is installed and deep-linked onto candidate-bound Metro;
   iOS startup ordering follows [CLI-owned iOS build routes](#cli-owned-ios-build-routes).
   Android installs with `adb install -r -d`, then starts Metro with
   `expo start --port` and launches with package-constrained `am start`,
   with Expo's `EXDevMenuDisableAutoLaunch` extra so the dev menu
   does not open at launch. Fresh candidate JS always comes from Metro; the evidence
   records which candidate built the binary and which serves JS — native
   compatibility is proven by the fingerprint, never inferred from the sha.
2. **Incremental** — reuse is invalid (committed native inputs changed, stored
   artifact stale/missing/unverified, no scheme, incomplete fingerprint) but the
   worktree-keyed caches are provably this project's: the state binds this
   exact worktree/app and any generated native dir was created by a
   recorded qaren build with unchanged, completely fingerprinted inputs.
   Committed native directories keep incremental builds for changed or
   incomplete fingerprints. iOS follows the
   [CLI-owned build routes](#cli-owned-ios-build-routes); borrowed Android
   emulators follow [Check a plan](#check-a-plan), while scenario-based Android
   `prepare` recompiles with `expo run:android` over the existing Gradle caches.
3. **Clean** — `build.strategy: clean` always bypasses reuse. Otherwise, mandatory
   whenever compatibility is unprovable and no verified
   stored build exists: no/corrupt state, cross-worktree state, unproven generated-dir provenance, changed or
   incomplete fingerprints for an existing generated native directory.
   A generated (git-ignored) native dir is regenerated
   using only `expo prebuild --platform <platform> --clean`, which deletes the
   directory with its installed native dependencies and build outputs; build
   caches outside it are kept. A git-visible native dir
   is candidate input and is never deleted — clean
   there means dropping the derived build outputs (`ios/build`,
   `android/build`, `android/app/build`, `android/.gradle`).

For a clean decision requiring generated-directory regeneration, `--dry-run`
includes the same `expo prebuild --platform <platform> --clean` command before
compilation on both platforms.

After a successful build the dev client (single `.app` bundle / debug apk)
is copied and content-hashed in a staging directory inside its fingerprint's
store entry (iOS) or under `.qaren/native-cache/artifacts/android/<app_id>-<fingerprint-key>/`
(Android). Copying checks cancellation between entries and file chunks. A final
cancellation check precedes renaming staging to a run-specific generation and
atomically saving cache state with the readiness-rechecked fingerprint
(native-input drift during the build fails the run as `CANDIDATE_DRIFTED`).
Cancellation before that publication removes staging and preserves the previous
state without rebinding installation ownership. A failed state save removes the
new generation and retains the previous state. On iOS a complete fingerprint then
publishes `artifact.json` (`path` relative to the entry, `sha256`, `kind`, `built_at`, `candidate_sha`)
create-new: the first build of a fingerprint wins, a concurrent or later build of
the same fingerprint keeps its own generation and never rewrites the record, and
an incomplete fingerprint is never published. A stored build that fails
verification is refused and left in place, so that fingerprint rebuilds until
its store entry directory is deleted. Nothing in the store is pruned; every
fingerprint keeps one generation per build until the store is cleaned by hand.
Android prunes the same app's directories for older fingerprints after a saved
state. An ambiguous artifact (zero or several bundles) skips caching with a recorded
reason, never a guess. Only a saved state permits ownership rebinding.

**Build serialization.** Native builds (incremental and clean) take a
host-level `native-build-<platform>` lock before allocation. A live holder
is a structured refusal (`BUILD_CONTENDED`, exit 4). Android can adopt a
provably dead holder's lock. iOS refuses an existing lock until its run's
cleanup proves the finite build group retired; a dead CLI alone is insufficient.
The lock is released after preparation or by cleanup only when owned build
authority is retired.

**Credential-authorized dependency prewarming.** Under `deps.policy:
require-prewarm`, `qaren prewarm <scenario>` is the one deliberate network
moment (the default `install` policy keeps today's behavior: prepare's own
`pnpm install` may reach the network): run it while registry credentials
are available; it runs `pnpm fetch` + `pnpm install
--frozen-lockfile` (CI, stdin-null) and persists only
`{worktree, project, lockfile sha256, timestamp}`; failure summaries follow the
[diagnostic redaction contract](#preparation-ownership-and-safety-rules).
A scenario with `deps.policy: require-prewarm` then refuses to prepare without a matching record
(`DEPS_NOT_PREWARMED`) and installs with `--offline`, so no mid-run
credential prompt can ever occur.

**Prepared simulator lanes (evaluated, deferred).** Keeping a booted,
pre-warmed simulator between runs would save the ~36s create+boot phase.
The evaluation: a maintained lane needs an owner (who deletes it when its
runtime/device-type pins change), a freshness rule (recreate on runtime
update or after N days), and an ownership marker distinguishing it from
user simulators — all solvable with the existing run-scoped-name machinery.
It is deferred because native compile dominates whenever it is not already
cached (the 2026-08-17 clean run spent 5m 42s building vs 5m 25s
allocating) and a persistent simulator weakens the "no resource outlives
its run" cleanup story. Once compile is short the balance flips — the
incremental run spent 1m 31s in allocate against 1m 03s in
build_and_ready — so revisit this once live reuse is measurable.

## Preparation ownership and safety rules

- **On the farm path, physical USB phones are structurally unreachable.**
  Every device-addressing adb call carries `-s 127.0.0.1:<port>` (plus
  `ANDROID_SERIAL` on the expo build), and every adb call — including the
  expo build's own — routes through the run-scoped adb server via
  `ADB_SERVER_SOCKET`; the Mac's global adb server is never used. Serials are
  validated against the loopback-tunnel form before any adb call; farm output
  naming a non `emulator-*` serial is rejected at parse time. A physical
  phone is reachable only through the separate `android_usb` adapter, which
  requires its exact serial in the scenario, an exclusive uncontended claim
  lock, and its own run-scoped `--one-device` server — the two adapters
  never blend (a scenario naming both is invalid).
  `adb connect`/`disconnect` name their endpoint positionally — `-s` is not
  applicable to them. The emulator guest only trusts the farm host's adb key,
  so the private server authenticates with that key (`ADB_VENDOR_KEYS`),
  fetched once over ssh into the run directory and deleted at cleanup.
- **Private key fetch output is withheld from diagnostics.** The farm key
  fetch uses private capture: failure details in `run.json` and the receipt
  report only exit status and timeout state with `[private output withheld]`,
  and neither captured stream is written to durable logs. Only a successful,
  nonempty fetch writes the cleanup-tracked, mode-0600 vendor key file.
  Parser input stays raw in memory. Persisted operational identities
  (paths, ids, pids, ports and lock directories) are written exactly;
  output-derived record fields use `OutputText`, masked on construction and
  load. Command summaries inspect both streams, and ledger and receipt
  evidence strings keep whole-string withholding when they contain
  `private key` (case-insensitive), using
  `[output withheld: contained private key material]`. Command logs keep
  per-byte whole-command withholding: a mention truncates that command's
  output and drops subsequent bytes. API-key redaction still applies to
  retained diagnostics and logs. Key bodies with no private-key mention,
  or copied before the mention arrives, cannot be withheld by this rule.
- **Local listeners are never adopted.** The farm-advertised adb port is
  preflighted free on this host *before* the lease is claimed (a local
  emulator commonly owns 5555), and a listener on the tunnel or private adb
  server port only counts once its pgid equals the group qaren just spawned —
  a foreign listener is a structured failure before any `adb connect`, so a
  `ready` receipt can never name a NUC lease while a local emulator answers.
- **Cleanup is ownership-gated.** A simulator is deleted only when UDID *and*
  run-scoped name (`qaren-<run-id>`) both match (a pending allocation whose
  create crashed before the UDID was learned is recovered by its unique
  run-scoped name, refusing on ambiguity). A process group is signalled only
  when the recorded leader's birth time (`ps lstart`) still matches immediately
  before each signal, including escalation after the grace wait. A matching
  port and group alone never authorize signalling after the leader's birth
  identity is lost or its PID is reused. An unreaped zombie with the recorded
  birth still pins the leader PID and can authorize group escalation. A present
  group without proven leader identity remains `unresolved`; proven group
  absence can retire it without a signal. After a
  kill the port must be positively free or foreign before `removed` is
  claimed. The farm slot is stopped only when the live lease holder equals
  this run's holder *and* the forward is proven gone — either the tunnel
  resource cleaned, or its recorded local port probing positively free.
  A foreign, shared, or indeterminate port retains the lease so the
  forwarded port cannot expose the next lease. A `cleaned`
  verdict that cannot be persisted downgrades to `failed` with a retry.
  Anything unprovable is a structured refusal (`OWNERSHIP_UNPROVEN`, exit 4)
  — never a guess. When a core is recorded and the recorded qaren owner's
  process identity is proven still alive, `cleanup` refuses the whole run
  before any resource teardown and leaves `run.json` unchanged; finish or
  stop that run first. If the owner identity is unknown or missing, only
  core cleanup is refused; other cleanup legs and record persistence proceed
  under their existing ownership checks. A dead owner or reused owner PID
  permits core cleanup under its existing process-group proofs. Runs without
  a recorded core retain their existing cleanup behavior, including build
  cleanup.
- **Storage accounting preserves ownership.** Successful owned simulator
  deletion reports its measured data-directory bytes, or an unknown byte count
  if measurement was unavailable, including pending-allocation recovery.
  Borrowed simulators are kept. `check`/`pr` refuse `DISK_BUDGET_EXCEEDED` before
  installation when the run storage has less than 1 GiB free. Worktree and
  recording retirement follow the [PR teardown contract](#test-a-pull-request).
- **App removal is opt-in, confirmed, and bound to the run record.** Plain
  Android `cleanup` never touches the installed app: stopping the farm AVD
  keeps its userdata, so the dev client this run installed survives the lease (and a
  `cleaned` receipt says nothing about it). `--remove-app` adds one
  `app_install` leg, executed before Android resource teardown while the
  lease, tunnel and private adb server are still alive, and only on the
  leased Android emulator route
  (USB, iOS, borrowed emulators and records without a farm lease are refused before any cleanup
  command runs; CLI git-root discovery precedes record loading). It requires
  `--confirm-remove-app <run-id>/<remote-serial>/<app-id>`
  naming exactly the loaded record's run id, recorded `emulator-*` serial
  and candidate app id — a mismatch is `APP_REMOVAL_NOT_CONFIRMED` (exit 4)
  with nothing touched, so a typo costs a re-run, not the lease. The
  removal deletes the app *and its data* (`adb uninstall`, no `-k`) through
  the run's own `-s <loopback serial>` + `ADB_SERVER_SOCKET` path; the
  target is never a supplied serial, app id or ambient `adb devices`.
  Immediately before the uninstall the leg re-proves, in order: durable
  install provenance in `run.json` (`resources.app_install`, written by
  `prepare` after a `Success` cached `adb install` or a ready build through
  the run's server when the built APK was hashed, bound to the run's app id,
  serial, server port and APK artifact sha256 — legacy records without it
  are refused), the recorded serial matching the farm port's tunnel endpoint,
  the live farm tuple (holder, AVD, serial, adb port, `state=device`), tunnel
  and adb server birth identities, `get-state` = `device`, a successful `pm path`
  read with empty stderr and exactly one user `/data/app/**/base.apk` result
  (split/multiple APKs, system paths, traversal and shell metacharacters are
  refused), and `sha256sum` of that base.apk equal to the recorded artifact
  hash — a matching hash alone is not ownership,
  the successful-install binding is required too. Any miss refuses or leaves
  the leg `unresolved` with **no uninstall issued**. After the uninstall,
  absence is proven on the same live connection by two reads: `pm path`
  completing with an exit code, no `package:` line and empty stderr
  (silent exit `1` is accepted for an unknown package), and `pm list
  packages <app-id>` exiting `0` with empty stderr and without the exact
  `package:<app-id>` line; substring siblings such as `<app-id>.dev` do not
  count. A timeout, failed read or any stderr from either probe leaves
  absence unknown. `removed` requires both uninstall `Success` and proven
  absence; a still-present package or unproven absence is `unresolved`.
  If both probes prove absence before uninstall, the leg is `absent` and
  records uninstall as `not issued`.
  The attempt (timestamp, observed installed sha256, and command evidence
  for uninstall / `pm path` / package list) is persisted to `run.json` at
  `resources.app_install.removal` before any lease release; command evidence
  follows the diagnostic redaction contract above. A save failure makes the
  leg `unresolved` and retains the farm lease while independent owned local
  cleanup continues.
  The receipt echoes it in `outcomes.app_removal_*`, with the observed hash
  in `outcomes.app_installed_sha256`. The leg folds into the existing verdict:
  a refused or unresolved removal keeps the receipt off `cleaned` and the
  phase off `cleaned` while the other
  resources still clean up in their normal order (reverse mapping,
  connection, server, key, tunnel-before-lease). A repeat after a proven
  removal reports `absent` from the record without re-addressing a device
  that may belong to another lease. A persisted unresolved attempt refuses
  another removal even if the lease is still owned; its evidence is retained
  without new package probes or upgrading historical unknown. Refusals before
  the removal boundary never overwrite a persisted attempt. Installing with
  `adb install -r` over an existing package does not prove fresh app data.
- **Claims are durable before they exist.** The run directory is claimed with
  an exclusive `mkdir`, so two same-second `prepare`s can never share a run id
  (`RUN_ALREADY_EXISTS`), and every external allocation is persisted to
  `run.json` *before* the command that creates it runs — the farm lease before
  `android-farm start`, the simulator (run-scoped name, empty udid) before
  `simctl create`. A crash mid-allocation leaves the claim discoverable by
  `cleanup` instead of orphaned.
- **`status` never repairs and never lies.** It derives ready / working /
  failed / cleaned / unknown from the durable `run.json` plus bounded live
  probes, and gates dependent probes on proven ownership (a foreign-named
  simulator or dead tunnel makes dependent probes `inconclusive`, not a
  false `fail`). The farm lease probe requires the full recorded slot
  identity — holder, AVD, serial, adb port, and a ready state — before any
  device probe runs, and a `failed` run's receipt carries the originally
  recorded `next_action` instead of a blanket cleanup hint.
- **All waits are bounded** (scenario `deadlines`, validated to 30..=7200s).
  In-process waits use a monotonic clock and timed-out commands are killed by
  process group. The cross-process cooperative handoff uses its persisted
  UTC `issued_at` plus `build_seconds` as one wall-clock validity window;
  retries never reset it, and an unprovable backwards clock refuses.
- **Provenance is rechecked at readiness.** See the shared
  [candidate provenance contract](#candidate-provenance) for fingerprint
  inputs, output exclusions and drift failures.
- `cleanup` is idempotent: a second run re-probes, finds everything absent,
  and returns `cleaned` again without signalling anything after successful
  cleanup; app-removal retries follow the persisted-evidence rules above.

## What a worker does

```sh
packages/qaren-cli/target/debug/qaren prepare packages/qaren-cli/scenarios/ios-simulator.yaml --json
# → parse .result == "ready", read .metro.endpoint + .device, attach agents
packages/qaren-cli/target/debug/qaren status  <run-id> --json   # truthful current state
packages/qaren-cli/target/debug/qaren cleanup <run-id> --json   # ownership-safe teardown
# opt-in: also remove the app this run installed (and its data) from the leased emulator
packages/qaren-cli/target/debug/qaren cleanup <run-id> --json --remove-app \
  --confirm-remove-app <run-id>/<remote-serial>/<app-id>   # e.g. <run-id>/emulator-5554/com.rndevagent.testapp
```

On failure the receipt carries a bounded `failure.code`, log-tail evidence,
and exactly one safe `next_action` — no invented setup steps.

## Measured results (2026-08-12, M-series Mac + NUC11TNKi5 over Tailscale)

Both real happy paths first ran end-to-end on an earlier revision (see the
re-proof below for the pinned proof head), from a cold worktree (no
`node_modules`, no `ios/`/`android/` dirs, no prior simulator or lease). The
worker typed exactly one command per phase.

| journey | verb | wall clock | subprocesses | outcome |
| --- | --- | --- | --- | --- |
| iOS sim (Mac) | prepare | 5m 13s | 129 | `ready` (validate 0.8s, deps 8s, sim create+boot 36s, build+launch+verify 268s) |
| | status | 1.4s | 7 | `ready`, 5/5 probes pass |
| | cleanup | 6.0s | 11 | `cleaned` (metro + simulator removed) |
| | cleanup again | 0.4s | 4 | `cleaned` (all absent; nothing signalled) |
| Android (NUC slot 1) | prepare | 2m 34s | 111 | `ready` (allocate incl. emulator boot 35s, build+launch+verify 118s) |
| | status | 1.0s | 12 | `ready`, 8/8 probes pass |
| | cleanup | 9.6s | 27 | `cleaned` (connection, server, vendor key, metro, tunnel, lease removed) |
| | cleanup again | 0.7s | 5 | `cleaned` (all absent) |

Independent post-cleanup verification: Metro/adb-server/tunnel ports free,
zero `qaren-*` simulators, a foreign booted simulator untouched, both farm
slots `lease=free state=down`.

After the tunnel-port ownership corrections (adb-port preflight, listener
pgid gating, port-proven tunnel cleanup, vendor key tracked as its own
resource), both journeys were re-proven end-to-end on the same hosts with
warm caches: iOS (local Mac) prepare 1m 57s / 72 subprocesses → `ready`,
status 5/5, cleanup `cleaned`, idempotent re-cleanup `cleaned`; NUC Android
prepare 37s / 48 subprocesses → `ready`, status 8/8, cleanup removed all six
resources, idempotent re-cleanup `cleaned`. The same independent
post-cleanup verification passed again. Receipts, device screenshots, and
the rendered proof card live in
[`docs/proof/2026-08-12-qaren-exact-head/`](https://github.com/Lykhoyda/rn-dev-agent-workspace/blob/main/docs/proof/2026-08-12-qaren-exact-head/PROOF.md);
every receipt there is pinned to the head that produced it (`f3e1e43`), which
predates the later corrections documented above — lease release keyed on the
tunnel port, worktree-fingerprint drift, monotonic deadlines, the atomic
run-id claim, and persist-before-allocate.

### Build-selection timing evidence (2026-08-17, local Mac)

Clean and incremental iOS simulator journeys were measured at candidate
`75a8e76` (`git_dirty: false`) once the internal Data volume recovered to
~26 GiB free. Receipts, screenshots, and short videos:
[`docs/proof/2026-08-17-qaren-issue-24/`](https://github.com/Lykhoyda/rn-dev-agent-workspace/blob/main/docs/proof/2026-08-17-qaren-issue-24/PROOF.md).

| journey | prepare total | deps | allocate | build_and_ready | decision |
| --- | --- | --- | --- | --- | --- |
| clean (`build.strategy: clean`) | 11m 27s | 19s | 5m 25s | 5m 42s | `clean` |
| incremental (warm ios/ + DerivedData, no verified cached `.app`) | 2m 35s | 0.3s | 1m 31s | 1m 03s | `incremental` |

Both prepares reached `ready` with 5/5 status probes; cleanup removed
Metro + the run-scoped simulator and was idempotent. The USB phone was
not used. An unedited placeholder serial is a validate-time
`SCENARIO_INVALID` (0 commands, no device contact). Scenario bytes used
for the iOS timings are archived next to the receipts so the pinned
`packages/qaren-cli/scenarios/ios-simulator.yaml` file was not mutated.

Fingerprint-matched **reuse** did not run: Expo SDK 56 `expo run:ios`
does not pass `-derivedDataPath`, so the `.app` lands in
`~/Library/Developer/Xcode/DerivedData/…/Debug-iphonesimulator/` while
`locate_built_artifact` looks at `ios/build/Build/Products/Debug-iphonesimulator`.
Each ready receipt records `artifact_cache` skipped for that missing
path; a post-cleanup auto `--dry-run` at the same SHA still planned
`incremental`. Hermetic tests still cover reuse including
stale/missing/mismatched artifacts. Do not treat an emulator or a
planted binary as a substitute.

`/Volumes/DNA` (~1.8 TiB free) was authorized for task-scoped
DerivedData but was not writable from the worker (`Operation not
permitted`); the timings above used the default Xcode location on the
internal volume after space recovered. Simulator device data still
cannot be redirected without mutating the shared CoreSimulator store.

### Build-selection timing evidence (2026-08-13) — recorded proof gap

Representative before/after timings for the reuse / incremental / clean
paths could not be produced on the exact candidate that day: the host ran
out of disk during the attempts (an iOS clean journey needs ~8-10 GiB for
pods, DerivedData, and a booted simulator; ~5-8 GiB were available). Two
real attempts on the dedicated simulator lane produced the intended
*failure* evidence instead, each a bounded structured receipt with the
decision recorded and ownership-safe recovery:

| attempt | decision recorded | outcome |
| --- | --- | --- |
| clean #1 | `clean` (no cache state; `ios/` regenerated via prebuild) | `BUILD_FAILED` at `pod install` with ENOSPC log-tail evidence after validate 0.8s / deps 0.6s / plan 0.08s / allocate 119s |
| clean #2 | `clean` | `SIMULATOR_BOOT_FAILED` (bootstatus timed out under disk pressure) after validate 0.8s / deps 0.3s / plan 0.09s |

Both runs were then cleaned with `qaren cleanup`: simulator and build
serialization lock removed, Metro port verified free, zero `qaren-*`
simulators left, and a second cleanup returned `cleaned` idempotently —
partial-failure recovery held on real hardware (abrupt-interruption
recovery is covered by the hermetic cleanup tests, not by these runs). The `plan`
timing (fingerprint + decision) is ~85ms and the decision/evidence
appeared in every receipt. Clean and incremental timings at a later head
are in the 2026-08-17 section above; live reuse remains blocked on the
Expo 56 DerivedData path mismatch recorded there.

Real failure categories observed while iterating (each a bounded structured
receipt, never a hang or a half-configured host):

- `ADB_CONNECT_FAILED` — emulator adbd refused the Mac's adb key (led to the
  vendor-key private-server design).
- `FARM_UNREACHABLE` — transient Tailscale MagicDNS resolution blip (22s,
  retry succeeded).
- `TUNNEL_FAILED` — adb server `-L` rejects explicit hostnames (fixed).
- `FARM_SLOT_LEASED` — the lease gate refused a slot held by a concurrent
  run's holder in 1.6s (exactly the protection it exists for).
- `BUILD_FAILED` — expo matches `--device` by name, not serial (led to the
  `--one-device` server design); a separate zombie-liveness bug (dead build
  child of a live prepare read as alive) was found by this failure and fixed
  with a `ps stat=` probe.

The verdict on the experiment question — *does one reproducible contract
reduce setup rediscovery?* — is yes on both journeys: after `ready`, an agent
receives the exact device identity, Metro endpoint, and candidate provenance
without ever choosing a device, picking a port, or knowing that pnpm, expo,
adb vendor keys, ssh tunnels, or farm leases exist. All platform knowledge
that previously had to be rediscovered per session (this session alone spent
five Android iterations discovering adb auth/scan/expo-matching behavior) is
now encoded once and replayed deterministically.

## Limitations (recorded, not papered over)

- **Farm stop is check-then-stop, not compare-and-stop.** The
  `~/bin/android-farm` contract takes only a slot for `stop`. qaren verifies
  the lease holder immediately before stopping; the race window is closed in
  practice because `android-farm start` refuses while any lease file exists,
  so no legitimate actor can re-lease between the check and the stop. A
  compare-and-stop verb would need a farm-side change, out of scope here.
- **Process-birth precision:** the [cleanup contract](#preparation-ownership-and-safety-rules)
  uses `ps lstart` for CLI process groups, allowing owned launcher exec
  transitions; same-second PID reuse on macOS remains a residual risk.
- **ANDROID_HOME is an environment prerequisite.** The resolved adb path is
  validated at prepare time and recorded in the run record; status/cleanup
  reuse the recorded path, never the ambient env.
- **`status` trusts a `cleaned` phase** without re-probing; cleanup only sets
  it after every resource verified removed/absent, and re-running cleanup
  re-verifies.
- **Extreme host load can hold the iOS lease.** Runner-host absence is read
  through `simctl spawn … launchctl list` within a fixed budget; when the host is
  too loaded for it to finish, cleanup keeps the lease and the next `check`
  refuses `DEVICE_BUSY` until `qaren cleanup <run-id>` proves absence once load
  allows.
- **App removal limitations:** see the opt-in contract under
  [Ownership and safety rules](#preparation-ownership-and-safety-rules).
- **Crash-durability**: `run.json` writes are atomic (temp + rename) but not
  fsync'd; power loss during a write can lose the newest phase transition.
  Acceptable for a dev-machine tool.
- Android preparation uses `expo run:android`: its spawned process owns
  Metro and stays alive after `ready`. iOS uses the finite-build contract under
  [Check a plan](#check-a-plan).
- app_id validation is one shared grammar (dot-separated `[A-Za-z0-9_-]`
  segments), not per-platform store rules; invalid-but-well-formed ids fail
  later as visible `BUILD_FAILED`.
- **Literal checks judge accessibility presence, not paint.** Text inside the
  screen, window and scroll clip counts as visible even when an overlay paints
  over it, such as an absolutely positioned sticky footer or another later
  sibling that XCUI still reports hittable. Only the keyboard is treated as an
  occluder.
- The historical Expo SDK 56 artifact-discovery gap in the timing evidence
  predates the current finite iOS build path. Those measurements do not validate
  this implementation; exact-head device acceptance remains separate.

## Comparing against the manual approach

The baseline is what agents do today before any live test: discover a
simulator/emulator, pick a Metro port, remember `pnpm install`, build with the
right flags, wait an unknown time, and verify readiness ad hoc — typically
8-15 exploratory tool calls with high variance, rediscovered every session
(see `docs/proof/pr680-android-lane/` for how much setup archaeology a single
Android lane took). To reproduce the comparison:

1. Time a fresh manual setup of the same scenario (count every command).
2. Run `qaren prepare … --json` on a clean host and read `timings_ms` +
   `commands_executed` from the receipt.
3. Compare failure handling: force a failure (occupy the Metro port, lease the
   farm slot) and compare "structured receipt with one next_action" against
   manual diagnosis time.
